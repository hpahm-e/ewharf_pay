import { z } from "zod";
import { applyBasisPoints } from "#/features/payment-settings/server/rates";
import type { AdapterErrorKind } from "#/integrations/chains/types";
import { observeProviderOperation } from "#/integrations/provider-observability";
import {
	assertSafeResolvedWebhookUrl,
	isSafeWebhookUrl,
	resolveWebhookHostname,
} from "#/lib/webhook-url";

const binanceTickerSchema = z.object({
	symbol: z.string(),
	price: z.string().regex(/^\d+(?:\.\d+)?$/),
});
const binanceTickersSchema = z.array(binanceTickerSchema);
const binanceMarketDataUrls = [
	"https://data-api.binance.vision",
	"https://api-gcp.binance.com",
	"https://api.binance.com",
] as const;
const okxTickerSchema = z.object({
	code: z.literal("0"),
	data: z.array(
		z.object({
			instId: z.string(),
			last: z.string().regex(/^\d+(?:\.\d+)?$/),
		}),
	),
});
const okxTickersSchema = z.object({
	code: z.literal("0"),
	data: z.array(z.object({ instId: z.string(), last: z.string() })),
});
const fiatRatesSchema = z.looseObject({
	success: z.boolean().optional(),
	rates: z.record(z.string(), z.number().positive()).optional(),
	quotes: z.record(z.string(), z.number().positive()).optional(),
	error: z
		.object({
			code: z.union([z.string(), z.number()]).optional(),
			type: z.string().optional(),
		})
		.optional(),
});

class ExchangeRateProviderError extends Error {
	readonly failureCode: `http_${number}` | "provider_error";

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ExchangeRateProviderError";
		this.failureCode = status ? `http_${status}` : "provider_error";
	}
}

export type RateSyncCategory = "crypto" | "fiat";
export type CryptoRateSyncConfiguration = {
	enabled: boolean;
	provider: "binance" | "okx";
	intervalMs: number;
	adjustmentBps: number;
	lastSyncedAt: number | null;
};
export type FiatRateSource =
	| "custom"
	| "exchangerate_host"
	| "fawazahmed0"
	| "open_er_api";
/**
 * Fiat sources are tried in this order until one succeeds: the operator's
 * custom URL, their own exchangerate.host key, then the keyless built-in sources.
 */
export type FiatRateSyncConfiguration = {
	enabled: boolean;
	customSourceEnabled: boolean;
	customUrl: string;
	ownSourceEnabled: boolean;
	builtInSources: boolean;
	intervalMs: number;
	adjustmentBps: number;
	credentials: { apiKey: string; customApiKey: string };
	lastSyncedAt: number | null;
};
export type RateSyncConfiguration =
	| CryptoRateSyncConfiguration
	| FiatRateSyncConfiguration;
type ExchangeRateRow = {
	id: string;
	category: RateSyncCategory;
	base: string;
	quote: string;
	raw_rate: string | null;
	rate: string | null;
	source: string;
	observed_at: number;
	expires_at: number;
	adjustment_bps: number;
};

export const defaultCryptoRateSync: CryptoRateSyncConfiguration = {
	enabled: true,
	provider: "binance",
	intervalMs: 3_600_000,
	adjustmentBps: 0,
	lastSyncedAt: null,
};
export const defaultFiatRateSync: FiatRateSyncConfiguration = {
	enabled: true,
	customSourceEnabled: false,
	customUrl: "",
	ownSourceEnabled: false,
	builtInSources: true,
	intervalMs: 86_400_000,
	adjustmentBps: 0,
	credentials: { apiKey: "", customApiKey: "" },
	lastSyncedAt: null,
};

export async function loadRateSyncConfiguration(
	db: D1Database,
	category: "crypto",
): Promise<CryptoRateSyncConfiguration>;
export async function loadRateSyncConfiguration(
	db: D1Database,
	category: "fiat",
): Promise<FiatRateSyncConfiguration>;
export async function loadRateSyncConfiguration(
	db: D1Database,
	category: RateSyncCategory,
) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(`rates.${category}_sync`)
		.first<{ value: string }>();
	return parseRateSyncConfiguration(category, row?.value);
}

export function parseRateSyncConfiguration(
	category: "crypto",
	value: string | null | undefined,
): CryptoRateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: "fiat",
	value: string | null | undefined,
): FiatRateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: RateSyncCategory,
	value: string | null | undefined,
): RateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: RateSyncCategory,
	value: string | null | undefined,
) {
	const fallback =
		category === "crypto" ? defaultCryptoRateSync : defaultFiatRateSync;
	if (!value) return structuredClone(fallback);
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return structuredClone(fallback);
		const record = parsed as Record<string, unknown>;
		const intervalMs =
			typeof record.intervalMs === "number" &&
			Number.isInteger(record.intervalMs) &&
			record.intervalMs >= 60_000
				? record.intervalMs
				: fallback.intervalMs;
		const lastSyncedAt =
			typeof record.lastSyncedAt === "number" ? record.lastSyncedAt : null;
		if (category === "crypto")
			return {
				enabled: record.enabled === true,
				provider: record.provider === "okx" ? "okx" : "binance",
				intervalMs,
				adjustmentBps: validAdjustmentBps(record.adjustmentBps),
				lastSyncedAt,
			} satisfies CryptoRateSyncConfiguration;
		const credentials =
			record.credentials && typeof record.credentials === "object"
				? (record.credentials as Record<string, unknown>)
				: {};
		const apiKey =
			typeof credentials.apiKey === "string" ? credentials.apiKey : "";
		const customApiKey =
			typeof credentials.customApiKey === "string"
				? credentials.customApiKey
				: "";
		return {
			enabled: record.enabled === true,
			customSourceEnabled: record.customSourceEnabled === true,
			customUrl: typeof record.customUrl === "string" ? record.customUrl : "",
			// Configurations saved before sources were ordered selected a single
			// provider; a stored exchangerate.host key keeps being used first.
			ownSourceEnabled:
				typeof record.ownSourceEnabled === "boolean"
					? record.ownSourceEnabled
					: record.provider === "exchangerate_host" && Boolean(apiKey),
			builtInSources: record.builtInSources !== false,
			intervalMs,
			adjustmentBps: validAdjustmentBps(record.adjustmentBps),
			credentials: { apiKey, customApiKey },
			lastSyncedAt,
		} satisfies FiatRateSyncConfiguration;
	} catch {
		return structuredClone(fallback);
	}
}

export async function loadRatesPageData(
	db: D1Database,
	category: RateSyncCategory,
) {
	const [rates, storedConfiguration] = await db.batch([
		db
			.prepare(
				`SELECT er.id, er.category, er.base, er.quote, er.raw_rate, er.rate,
				 er.source, er.adjustment_bps, er.observed_at, er.expires_at
				 FROM exchange_rates er WHERE er.category = ?
				 ORDER BY er.base, er.quote, er.source`,
			)
			.bind(category),
		db
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(`rates.${category}_sync`),
	]);
	const rateRows = (rates as D1Result<ExchangeRateRow>).results;
	const configurationValue = (
		storedConfiguration as D1Result<{ value: string }>
	).results[0]?.value;
	if (category === "crypto")
		return {
			rates: rateRows,
			syncSettings: {
				category,
				...parseRateSyncConfiguration(category, configurationValue),
			},
		};
	const configuration = parseRateSyncConfiguration(
		category,
		configurationValue,
	);
	return {
		rates: rateRows,
		syncSettings: {
			category,
			enabled: configuration.enabled,
			customSourceEnabled: configuration.customSourceEnabled,
			customUrl: configuration.customUrl,
			hasCustomCredentials: Boolean(configuration.credentials.customApiKey),
			ownSourceEnabled: configuration.ownSourceEnabled,
			builtInSources: configuration.builtInSources,
			intervalMs: configuration.intervalMs,
			adjustmentBps: configuration.adjustmentBps,
			lastSyncedAt: configuration.lastSyncedAt,
			hasCredentials: Boolean(configuration.credentials.apiKey),
		},
	};
}

export async function saveRateSyncConfiguration(
	db: D1Database,
	category: RateSyncCategory,
	configuration: CryptoRateSyncConfiguration | FiatRateSyncConfiguration,
	updatedBy: string | null,
	now = Date.now(),
) {
	await db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, updated_by, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_by = COALESCE(excluded.updated_by, system_settings.updated_by),
			 updated_at = excluded.updated_at`,
		)
		.bind(
			`rates.${category}_sync`,
			JSON.stringify(configuration),
			updatedBy,
			now,
			now,
		)
		.run();
}

export async function refreshDueExchangeRates(
	db: D1Database,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
) {
	const [cryptoResult, fiatResult] = await Promise.all([
		refreshRateCategoryIfDue(db, "crypto", request, now),
		refreshRateCategoryIfDue(db, "fiat", request, now),
	]);
	return { crypto: cryptoResult, fiat: fiatResult };
}

export async function refreshRateCategoryIfDue(
	db: D1Database,
	category: RateSyncCategory,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
	configuration?: RateSyncConfiguration,
) {
	if (category === "crypto") {
		const cryptoConfiguration =
			(configuration as CryptoRateSyncConfiguration | undefined) ??
			(await loadRateSyncConfiguration(db, "crypto"));
		if (!cryptoConfiguration.enabled) return null;
		if (
			cryptoConfiguration.lastSyncedAt !== null &&
			now - cryptoConfiguration.lastSyncedAt < cryptoConfiguration.intervalMs
		)
			return null;
		return assertScheduledRateResult(
			await refreshExchangeRates(db, request, now, {
				category,
				provider: cryptoConfiguration.provider,
				configuration: cryptoConfiguration,
			}),
		);
	}
	const fiatConfiguration =
		(configuration as FiatRateSyncConfiguration | undefined) ??
		(await loadRateSyncConfiguration(db, "fiat"));
	if (
		!fiatConfiguration.enabled ||
		fiatSourceChain(fiatConfiguration).length === 0 ||
		(fiatConfiguration.lastSyncedAt !== null &&
			now - fiatConfiguration.lastSyncedAt < fiatConfiguration.intervalMs)
	)
		return null;
	return assertScheduledRateResult(
		await refreshExchangeRates(db, request, now, {
			category,
			apiKey: fiatConfiguration.credentials.apiKey || null,
			configuration: fiatConfiguration,
		}),
	);
}

function assertScheduledRateResult(
	result: Awaited<ReturnType<typeof refreshExchangeRates>>,
) {
	if (result.failed > 0)
		throw new Error(`Rate synchronization failed for ${result.failed} pair(s)`);
	return result;
}

export async function refreshExchangeRates(
	db: D1Database,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
	context: {
		category?: "crypto" | "fiat";
		provider?: "binance" | "okx";
		apiKey?: string | null;
		configuration?: RateSyncConfiguration;
		actorUserId?: string | null;
		requestId?: string | null;
		ipAddress?: string | null;
	} = {},
) {
	const category = context.category ?? "crypto";
	const cryptoConfiguration =
		category === "crypto"
			? ((context.configuration as CryptoRateSyncConfiguration | undefined) ??
				(await loadRateSyncConfiguration(db, "crypto")))
			: null;
	const fiatConfiguration =
		category === "fiat"
			? ((context.configuration as FiatRateSyncConfiguration | undefined) ??
				(await loadRateSyncConfiguration(db, "fiat")))
			: null;
	const provider =
		context.provider ?? cryptoConfiguration?.provider ?? "binance";
	const configured = await db
		.prepare(
			"SELECT id, base, quote FROM exchange_rates WHERE category = ? ORDER BY base, quote",
		)
		.bind(category)
		.all<{ id: string; base: string; quote: string }>();
	let configuredCount = configured.results.length;
	let updated = 0;
	const allFailures: Array<{
		id: string;
		pair: string;
		source: "binance" | "okx" | FiatRateSource;
		code: string;
	}> = [];
	const rejected: Array<{ pair: string; previous: string; received: string }> =
		[];
	if (category === "crypto") {
		try {
			const prices = await observeProviderOperation(
				{
					adapter: provider,
					operation: "sync_crypto_rates",
					classifyError: classifyExchangeRateError,
				},
				(counters) => {
					counters.request();
					return fetchCryptoRateQuotes(provider, configured.results, request);
				},
			);
			const adjustmentBps = cryptoConfiguration?.adjustmentBps ?? 0;
			const validityMs =
				(cryptoConfiguration?.intervalMs ?? defaultCryptoRateSync.intervalMs) +
				60_000;
			const available = configured.results.flatMap((rate) => {
				const price = prices.get(rate.id);
				if (!price) {
					allFailures.push({
						id: rate.id,
						pair: `${rate.base}/${rate.quote}`,
						source: provider,
						code: "missing_pair",
					});
					return [];
				}
				return [{ rate, price }];
			});
			const results = available.length
				? await db.batch(
						available.map(({ rate, price }) =>
							db
								.prepare(
									`UPDATE exchange_rates SET raw_rate = ?, rate = ?, source = ?, adjustment_bps = ?,
									 observed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
								)
								.bind(
									price,
									applyBasisPoints(price, adjustmentBps),
									provider,
									adjustmentBps,
									now,
									now + validityMs,
									now,
									rate.id,
								),
						),
					)
				: [];
			updated = results.reduce(
				(sum, result) => sum + (result.meta.changes ?? 0),
				0,
			);
		} catch (error) {
			const code = exchangeRateErrorCode(error);
			allFailures.push(
				...configured.results.map((rate) => ({
					id: rate.id,
					pair: `${rate.base}/${rate.quote}`,
					source: provider,
					code,
				})),
			);
		}
	} else {
		const chain = fiatSourceChain(
			fiatConfiguration ?? defaultFiatRateSync,
			context.apiKey,
		);
		let attempted: FiatRateSource = chain[0] ?? "open_er_api";
		try {
			if (chain.length === 0)
				throw new ExchangeRateProviderError("No fiat rate source is enabled");
			let rates: Record<string, string> | null = null;
			let usedSource: FiatRateSource | null = null;
			let lastError: unknown;
			for (const source of chain) {
				attempted = source;
				try {
					rates = await observeProviderOperation(
						{
							adapter: source === "custom" ? "custom_fiat_rates" : source,
							operation: "sync_fiat_rates",
							classifyError: classifyExchangeRateError,
						},
						(counters) => {
							counters.request();
							return fetchFiatSource(source, request, {
								apiKey: context.apiKey ?? fiatConfiguration?.credentials.apiKey,
								customUrl: fiatConfiguration?.customUrl ?? "",
								customApiKey: fiatConfiguration?.credentials.customApiKey,
								// Only the real network path resolves DNS; injected test
								// fetchers never reach a network.
								resolveHostname:
									(request as unknown) === fetch
										? resolveWebhookHostname
										: undefined,
							});
						},
					);
					usedSource = source;
					break;
				} catch (error) {
					lastError = error;
				}
			}
			if (!(rates && usedSource)) throw lastError;
			const previous = new Map(
				(
					await db
						.prepare(
							"SELECT quote, raw_rate FROM exchange_rates WHERE category = 'fiat' AND base = 'USD' AND observed_at > 0",
						)
						.all<{ quote: string; raw_rate: string | null }>()
				).results.map((row) => [row.quote, row.raw_rate]),
			);
			const snapshots = Object.entries(rates)
				.filter(([quote]) => /^[A-Z]{3}$/.test(quote) && quote !== "USD")
				.map(([quote, rawRate]) => ({ quote, rawRate }))
				.filter((snapshot) => {
					const before = previous.get(snapshot.quote);
					if (!(before && isImplausibleRateChange(before, snapshot.rawRate)))
						return true;
					rejected.push({
						pair: `USD/${snapshot.quote}`,
						previous: before,
						received: snapshot.rawRate,
					});
					return false;
				});
			const results = snapshots.length
				? await db.batch(
						snapshots.map((snapshot) =>
							db
								.prepare(
									`INSERT INTO exchange_rates
							 (id, category, base, quote, raw_rate, rate, source, adjustment_bps,
							  observed_at, expires_at, created_at, updated_at)
							 VALUES (?, 'fiat', 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?)
							 ON CONFLICT(category, base, quote) DO UPDATE SET
							 raw_rate = excluded.raw_rate, rate = excluded.rate,
							 source = excluded.source, adjustment_bps = excluded.adjustment_bps,
							 observed_at = excluded.observed_at, expires_at = excluded.expires_at,
							 updated_at = excluded.updated_at`,
								)
								.bind(
									`rate-usd-${snapshot.quote.toLowerCase()}`,
									snapshot.quote,
									snapshot.rawRate,
									applyBasisPoints(
										snapshot.rawRate,
										fiatConfiguration?.adjustmentBps ?? 0,
									),
									usedSource,
									fiatConfiguration?.adjustmentBps ?? 0,
									now,
									now + 24 * 60 * 60_000,
									now,
									now,
								),
						),
					)
				: [];
			updated = results.reduce(
				(sum, result) => sum + (result.meta.changes ?? 0),
				0,
			);
			configuredCount = snapshots.length;
		} catch (error) {
			allFailures.push({
				id: "fiat",
				pair: "USD/fiat",
				source: attempted,
				code: exchangeRateErrorCode(error),
			});
		}
	}
	const result = {
		configured: configuredCount,
		updated,
		failed: allFailures.length,
		failures: allFailures,
		rejected,
	};
	if (result.updated > 0 && result.failed === 0) {
		const nextConfiguration =
			category === "crypto"
				? {
						...(cryptoConfiguration ?? defaultCryptoRateSync),
						provider,
						lastSyncedAt: now,
					}
				: { ...(fiatConfiguration ?? defaultFiatRateSync), lastSyncedAt: now };
		await saveRateSyncConfiguration(
			db,
			category,
			nextConfiguration,
			context.actorUserId ?? null,
			now,
		);
	}
	if (
		result.configured &&
		(context.actorUserId || allFailures.length > 0 || rejected.length > 0)
	) {
		await db
			.prepare(
				`INSERT INTO audit_logs
				(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				VALUES (?, ?, 'exchange_rates.refreshed', 'exchange_rates', NULL, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.actorUserId ?? null,
				context.requestId ?? null,
				context.ipAddress ?? null,
				JSON.stringify(result),
				now,
			)
			.run();
	}
	return result;
}

export async function fetchExchangeRateQuote(
	source: "binance" | "okx",
	base: string,
	quote: string,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl?: string | null,
	apiKey?: string | null,
) {
	const symbol = providerSymbol(source, base, quote);
	const path =
		source === "okx"
			? `/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`
			: `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
	const response = await fetchRateProviderResponse(
		source,
		path,
		request,
		apiUrl,
		apiKey,
	);
	const payload: unknown = await response.json();
	const price =
		source === "okx"
			? okxPrice(payload, symbol)
			: binancePrice(payload, symbol);
	if (!price) throw new Error(`${source} ticker did not return ${symbol}`);
	return price;
}

export async function fetchCryptoRateQuotes(
	source: "binance" | "okx",
	pairs: Array<{ id: string; base: string; quote: string }>,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl?: string | null,
) {
	const symbols = new Map(
		pairs.map((pair) => [
			providerSymbol(source, pair.base, pair.quote),
			pair.id,
		]),
	);
	const path =
		source === "okx"
			? "/api/v5/market/tickers?instType=SPOT"
			: `/api/v3/ticker/price?${new URLSearchParams({
					symbols: JSON.stringify([...symbols.keys()]),
				})}`;
	const response = await fetchRateProviderResponse(
		source,
		path,
		request,
		apiUrl,
	);
	const payload: unknown = await response.json();
	const tickers =
		source === "okx"
			? okxTickersSchema.parse(payload).data.map((ticker) => ({
					symbol: ticker.instId,
					price: ticker.last,
				}))
			: binanceTickersSchema.parse(payload);
	const prices = new Map<string, string>();
	for (const ticker of tickers) {
		const id = symbols.get(ticker.symbol.toUpperCase());
		if (id && /^\d+(?:\.\d+)?$/.test(ticker.price))
			prices.set(id, ticker.price);
	}
	return prices;
}

const maximumRateChangeBps = 3_000;
const fawazRateUrls = [
	"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
	"https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
] as const;
const fawazSchema = z.looseObject({
	usd: z.record(z.string(), z.number()),
});

/** Sources to try for fiat rates, in priority order. */
export function fiatSourceChain(
	configuration: FiatRateSyncConfiguration,
	apiKeyOverride?: string | null,
): FiatRateSource[] {
	const apiKey = apiKeyOverride ?? configuration.credentials.apiKey;
	return [
		...(configuration.customSourceEnabled &&
		isSafeWebhookUrl(configuration.customUrl)
			? (["custom"] as const)
			: []),
		...(configuration.ownSourceEnabled && apiKey
			? (["exchangerate_host"] as const)
			: []),
		...(configuration.builtInSources
			? (["fawazahmed0", "open_er_api"] as const)
			: []),
	];
}

/**
 * A synchronized quote that moves more than the allowed share in one step is
 * more likely bad provider data than a real market move, so it is skipped.
 */
function isImplausibleRateChange(previous: string, received: string) {
	const before = Number(previous);
	const after = Number(received);
	if (!(before > 0 && after > 0)) return false;
	return Math.abs(after / before - 1) * 10_000 > maximumRateChangeBps;
}

function decimalString(rate: number) {
	const text = String(rate);
	return /e/i.test(text) ? rate.toFixed(12).replace(/\.?0+$/, "") : text;
}

function fetchFiatSource(
	source: FiatRateSource,
	request: (input: string, init?: RequestInit) => Promise<Response>,
	options: {
		apiKey?: string | null;
		customUrl: string;
		customApiKey?: string | null;
		resolveHostname?: (hostname: string) => Promise<string[]>;
	},
) {
	if (source === "custom")
		return fetchCustomRates(request, options.customUrl, {
			apiKey: options.customApiKey,
			resolveHostname: options.resolveHostname,
		});
	if (source === "fawazahmed0") return fetchFawazRates(request);
	if (source === "open_er_api") return fetchOpenErApiRates(request);
	return fetchFiatRates(
		"USD",
		[],
		request,
		"https://api.exchangerate.host",
		options.apiKey,
	);
}

const customRatesBodyLimitBytes = 1024 * 1024;
const customRatesEntryLimit = 500;
const customRatesSchema = z.looseObject({
	base: z.string().optional(),
	base_code: z.string().optional(),
	rates: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
	usd: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
	quotes: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

/**
 * Reads USD-based rates from an operator-supplied HTTPS endpoint. The URL must be
 * public (checked again after DNS resolution), redirects are never followed, and
 * the body is bounded. Accepted bodies: `{"rates":{"VND":26000}}`,
 * `{"usd":{"vnd":26000}}`, or `{"quotes":{"USDVND":26000}}`; numbers or decimal
 * strings, with an optional `base` / `base_code` that must be USD.
 */
export async function fetchCustomRates(
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	url: string,
	options: {
		apiKey?: string | null;
		resolveHostname?: (hostname: string) => Promise<string[]>;
	} = {},
): Promise<Record<string, string>> {
	if (!isSafeWebhookUrl(url))
		throw new ExchangeRateProviderError(
			"Custom rate URL must be a public HTTPS URL",
		);
	if (
		options.resolveHostname &&
		!(await assertSafeResolvedWebhookUrl(url, options.resolveHostname))
	)
		throw new ExchangeRateProviderError(
			"Custom rate URL did not resolve publicly",
		);
	const response = await request(url, {
		headers: {
			accept: "application/json",
			...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
		},
		redirect: "manual",
		signal: AbortSignal.timeout(8_000),
	});
	if (response.status >= 300 && response.status < 400)
		throw new ExchangeRateProviderError("Custom rate API redirected");
	if (!response.ok)
		throw new ExchangeRateProviderError(
			`Custom rate API returned HTTP ${response.status}`,
			response.status,
		);
	const payload = customRatesSchema.parse(
		JSON.parse(await readLimitedText(response, customRatesBodyLimitBytes)),
	);
	const base = (payload.base ?? payload.base_code)?.toUpperCase();
	if (base && base !== "USD")
		throw new ExchangeRateProviderError("Custom rate API base must be USD");
	const entries: Array<[string, number | string]> = payload.rates
		? Object.entries(payload.rates)
		: payload.usd
			? Object.entries(payload.usd)
			: Object.entries(payload.quotes ?? {}).flatMap(([pair, rate]) =>
					pair.toUpperCase().startsWith("USD")
						? [[pair.slice(3), rate] as [string, number | string]]
						: [],
				);
	const rates: Record<string, string> = {};
	for (const [code, rate] of entries.slice(0, customRatesEntryLimit)) {
		const quote = code.toUpperCase();
		const value =
			typeof rate === "number"
				? Number.isFinite(rate) && rate > 0
					? decimalString(rate)
					: null
				: /^\d+(?:\.\d+)?$/.test(rate) && Number(rate) > 0
					? rate
					: null;
		if (value && /^[A-Z]{3}$/.test(quote)) rates[quote] = value;
	}
	if (Object.keys(rates).length === 0)
		throw new ExchangeRateProviderError("Custom rate API returned no rates");
	return rates;
}

async function readLimitedText(response: Response, maximumBytes: number) {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximumBytes)
		throw new ExchangeRateProviderError("Custom rate API response too large");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maximumBytes) {
			await reader.cancel();
			throw new ExchangeRateProviderError("Custom rate API response too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Keyless USD rates from the community-run fawazahmed0 dataset (CC0, no rate
 * limit, updated daily). The jsDelivr URL falls back to the Cloudflare mirror.
 */
export async function fetchFawazRates(
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	urls: readonly string[] = fawazRateUrls,
): Promise<Record<string, string>> {
	const currencies = new Set(Intl.supportedValuesOf("currency"));
	let lastError: unknown;
	for (const url of urls) {
		try {
			const response = await request(url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(8_000),
			});
			if (!response.ok)
				throw new ExchangeRateProviderError(
					`fawazahmed0 returned HTTP ${response.status}`,
					response.status,
				);
			const payload = fawazSchema.parse(await response.json());
			const rates = Object.entries(payload.usd).flatMap(([code, rate]) => {
				const quote = code.toUpperCase();
				return currencies.has(quote) && Number.isFinite(rate) && rate > 0
					? [[quote, decimalString(rate)] as const]
					: [];
			});
			if (rates.length === 0)
				throw new ExchangeRateProviderError("fawazahmed0 returned no rates");
			return Object.fromEntries(rates);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

const openErApiSchema = z.looseObject({
	result: z.string(),
	rates: z.record(z.string(), z.number().positive()).optional(),
});

/**
 * Keyless USD rates from ExchangeRate-API's open endpoint. It refreshes once a
 * day and asks for attribution, so the default sync interval is 24 hours.
 */
export async function fetchOpenErApiRates(
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl = "https://open.er-api.com/v6/latest/USD",
): Promise<Record<string, string>> {
	const response = await request(apiUrl, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok)
		throw new ExchangeRateProviderError(
			`open_er_api returned HTTP ${response.status}`,
			response.status,
		);
	const payload = openErApiSchema.parse(await response.json());
	if (payload.result !== "success" || !payload.rates)
		throw new ExchangeRateProviderError("open_er_api API error");
	return Object.fromEntries(
		Object.entries(payload.rates).map(([quote, rate]) => [
			quote.toUpperCase(),
			decimalString(rate),
		]),
	);
}

export async function fetchFiatRates(
	base: string,
	symbols: string[],
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl = "https://api.exchangerate.host",
	apiKey?: string | null,
): Promise<Record<string, string>> {
	const root = apiUrl.replace(/\/$/, "");
	if (!apiKey) throw new Error("exchangerate_host API Key is required");
	const params = new URLSearchParams({ access_key: apiKey });
	if (symbols.length > 0)
		params.set(
			"currencies",
			symbols.map((symbol) => symbol.toUpperCase()).join(","),
		);
	// USD is exchangerate.host's default source. Sending source=USD needlessly
	// exercises the paid "source currency switching" feature on free plans.
	if (base.toUpperCase() !== "USD") params.set("source", base.toUpperCase());
	const response = await request(`${root}/live?${params}`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok)
		throw new ExchangeRateProviderError(
			`exchangerate_host returned HTTP ${response.status}`,
			response.status,
		);
	const payload = fiatRatesSchema.parse(await response.json());
	if (payload.success === false) {
		const providerCode = payload.error?.code ?? payload.error?.type;
		throw new ExchangeRateProviderError(
			`exchangerate_host API error${providerCode ? ` ${providerCode}` : ""}`,
		);
	}
	if (!payload.rates && !payload.quotes)
		throw new Error("exchangerate_host response did not contain rates");
	const entries: Array<[string, number]> = payload.rates
		? Object.entries(payload.rates)
		: Object.entries(payload.quotes ?? {}).map(([pair, rate]) => [
				pair.toUpperCase().startsWith(base.toUpperCase())
					? pair.slice(base.length)
					: pair,
				rate,
			]);
	return Object.fromEntries(
		entries.map(([quote, rate]) => [quote.toUpperCase(), String(rate)]),
	);
}

function defaultRateSourceUrl(source: "binance" | "okx") {
	return source === "okx"
		? "https://www.okx.com"
		: "https://data-api.binance.vision";
}

async function fetchRateProviderResponse(
	source: "binance" | "okx",
	path: string,
	request: (input: string, init?: RequestInit) => Promise<Response>,
	apiUrl?: string | null,
	apiKey?: string | null,
) {
	const roots = apiUrl
		? [apiUrl]
		: source === "binance"
			? binanceMarketDataUrls
			: [defaultRateSourceUrl(source)];
	let lastError: unknown;

	for (const [index, candidate] of roots.entries()) {
		const isLast = index === roots.length - 1;
		try {
			const response = await request(`${candidate.replace(/\/$/, "")}${path}`, {
				headers: {
					accept: "application/json",
					...(apiKey ? { "x-api-key": apiKey } : {}),
				},
				signal: AbortSignal.timeout(source === "binance" ? 5_000 : 8_000),
			});
			if (response.ok) return response;

			const error = new ExchangeRateProviderError(
				`${source} ticker returned HTTP ${response.status}`,
				response.status,
			);
			if (isLast || !isBinanceEndpointFailure(response.status)) throw error;
			lastError = error;
		} catch (error) {
			if (isLast || !isNetworkFailure(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

function isBinanceEndpointFailure(status: number) {
	return status === 403 || status === 451 || status >= 500;
}

function isNetworkFailure(error: unknown) {
	return (
		error instanceof TypeError ||
		error instanceof DOMException ||
		(error instanceof Error && error.name === "TimeoutError")
	);
}

function providerSymbol(
	source: "binance" | "okx",
	base: string,
	quote: string,
) {
	const marketBase = providerMarketAsset(base);
	const marketQuote = providerMarketAsset(quote);
	return source === "okx"
		? `${marketBase}-${marketQuote}`.toUpperCase()
		: `${marketBase}${marketQuote}`.toUpperCase();
}

function providerMarketAsset(asset: string) {
	const normalized = asset.toUpperCase();
	if (normalized === "MATIC") return "POL";
	if (normalized === "GRAM") return "TON";
	return normalized;
}

function binancePrice(payload: unknown, symbol: string) {
	const ticker = binanceTickerSchema.parse(payload);
	return ticker.symbol.toUpperCase() === symbol ? ticker.price : null;
}

function okxPrice(payload: unknown, symbol: string) {
	const ticker = okxTickerSchema.parse(payload).data[0];
	return ticker?.instId.toUpperCase() === symbol ? ticker.last : null;
}

function exchangeRateErrorCode(error: unknown) {
	if (error instanceof ExchangeRateProviderError) return error.failureCode;
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return "timeout";
		if (error instanceof z.ZodError) return "invalid_response";
	}
	return "provider_error";
}

function classifyExchangeRateError(error: unknown): AdapterErrorKind {
	if (error instanceof ExchangeRateProviderError) {
		const status = Number(error.failureCode.slice("http_".length));
		if (status === 401 || status === 403) return "authentication";
		if (status === 429) return "rate_limit";
		if (status >= 500) return "network";
		return error.failureCode === "provider_error"
			? "invalid_response"
			: "permanent";
	}
	if (error instanceof z.ZodError) return "invalid_response";
	if (error instanceof TypeError || error instanceof DOMException)
		return "network";
	return "permanent";
}

function validAdjustmentBps(value: unknown) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value > -10_000 &&
		value <= 100_000
		? value
		: 0;
}
