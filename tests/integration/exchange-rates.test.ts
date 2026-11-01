import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	defaultFiatRateSync,
	fetchCryptoRateQuotes,
	fetchCustomRates,
	fetchExchangeRateQuote,
	fetchFawazRates,
	fetchFiatRates,
	fetchOpenErApiRates,
	fiatSourceChain,
	refreshExchangeRates,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { applyMigrations } from "./migrations";

describe("exchange-rate refresh", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "ewharf-rate-test" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('btc-usdt', 'crypto', 'BTC', 'USDT', '1', '1', 'binance', 0, 0, 0, 0, 0)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('eth-usdt', 'crypto', 'ETH', 'USDT', '1', '1', 'okx', 0, 0, 0, 0, 0)",
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());
	afterEach(() => vi.restoreAllMocks());

	it("refreshes configured Binance pairs with a bounded validity window", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const request = vi.fn((_input: string, _init?: RequestInit) =>
			Promise.resolve(
				Response.json([
					{ symbol: "BTCUSDT", price: "62345.67000000" },
					{ symbol: "ETHUSDT", price: "3456.78000000" },
				]),
			),
		);
		const now = 1_800_000_000_000;
		await expect(refreshExchangeRates(db, request, now)).resolves.toEqual({
			configured: 2,
			updated: 2,
			failed: 0,
			failures: [],
			rejected: [],
		});
		expect(request).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.origin).toBe("https://data-api.binance.vision");
		expect(requestedUrl.pathname).toBe("/api/v3/ticker/price");
		expect(
			JSON.parse(requestedUrl.searchParams.get("symbols") ?? "[]"),
		).toEqual(["BTCUSDT", "ETHUSDT"]);
		const row = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'btc-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		expect(row).toEqual({
			rate: "62345.67",
			observed_at: now,
			expires_at: now + 3_660_000,
		});
		const okx = await db
			.prepare("SELECT rate FROM exchange_rates WHERE id = 'eth-usdt'")
			.first<{ rate: string }>();
		expect(okx?.rate).toBe("3456.78");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "binance",
				operation: "sync_crypto_rates",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("isolates provider failures, preserves prior observations and audits a safe summary", async () => {
		const before = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'eth-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		const now = 1_800_000_600_000;
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json([{ symbol: "BTCUSDT", price: "63000.00" }]),
			),
		);
		await expect(refreshExchangeRates(db, request, now)).resolves.toEqual({
			configured: 2,
			updated: 1,
			failed: 1,
			failures: [
				{
					id: "eth-usdt",
					pair: "ETH/USDT",
					source: "binance",
					code: "missing_pair",
				},
			],
			rejected: [],
		});
		const after = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'eth-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		expect(after).toEqual(before);
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(now)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "null")).toMatchObject({
			configured: 2,
			updated: 1,
			failed: 1,
			failures: [{ code: "missing_pair", pair: "ETH/USDT", source: "binance" }],
		});
		expect(audit?.after).not.toContain("down");
	});

	it("classifies HTTP status structurally without parsing arbitrary error text", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const rateLimitedAt = 1_800_000_700_000;
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(new Response("provider detail", { status: 429 })),
				rateLimitedAt,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 2,
			failures: [{ code: "http_429" }, { code: "http_429" }],
		});
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(rateLimitedAt)
			.first<{ after: string }>();
		expect(audit?.after).not.toContain("provider detail");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "binance",
				operation: "sync_crypto_rates",
				outcome: "failure",
				status: "error",
				errorCode: "rate_limit",
				requestCount: 1,
			}),
		);
		expect(JSON.stringify(info.mock.calls)).not.toContain("provider detail");

		await expect(
			refreshExchangeRates(
				db,
				() => Promise.reject(new Error("transport mentioned HTTP 429")),
				rateLimitedAt + 1,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 2,
			failures: [{ code: "provider_error" }, { code: "provider_error" }],
		});
	});

	it("fetches a normalized current quote when an automatic source is created", async () => {
		const binance = vi.fn(() =>
			Promise.resolve(
				Response.json({ symbol: "SOLUSDT", price: "153.42000000" }),
			),
		);
		await expect(
			fetchExchangeRateQuote("binance", "SOL", "USDT", binance),
		).resolves.toBe("153.42000000");
		expect(binance).toHaveBeenCalledWith(
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT",
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
	});

	it("maps product asset codes to provider market symbols", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ symbol: "POLUSDT", price: "0.42" }),
			)
			.mockResolvedValueOnce(
				Response.json({ symbol: "TONUSDT", price: "3.15" }),
			);
		await expect(
			fetchExchangeRateQuote("binance", "MATIC", "USDT", request),
		).resolves.toBe("0.42");
		await expect(
			fetchExchangeRateQuote("binance", "GRAM", "USDT", request),
		).resolves.toBe("3.15");
		expect(request.mock.calls.map(([url]) => url)).toEqual([
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=POLUSDT",
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=TONUSDT",
		]);
	});

	it("loads all seven built-in crypto pairs with one provider request", async () => {
		const pairs = ["TRX", "ETH", "BNB", "MATIC", "GRAM", "APT", "SOL"].map(
			(base) => ({ id: base.toLowerCase(), base, quote: "USDT" }),
		);
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json(
					["TRX", "ETH", "BNB", "POL", "TON", "APT", "SOL"].map(
						(symbol, index) => ({
							symbol: `${symbol}USDT`,
							price: String(index + 1),
						}),
					),
				),
			),
		);
		const prices = await fetchCryptoRateQuotes("binance", pairs, request);
		expect(request).toHaveBeenCalledTimes(1);
		expect([...prices]).toEqual(
			pairs.map((pair, index) => [pair.id, String(index + 1)]),
		);
	});

	it("falls back to another official Binance endpoint when the Worker endpoint is blocked", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(new Response("restricted", { status: 451 }))
			.mockResolvedValueOnce(
				Response.json([{ symbol: "BTCUSDT", price: "62000.00" }]),
			);

		await expect(
			fetchCryptoRateQuotes(
				"binance",
				[{ id: "btc-usdt", base: "BTC", quote: "USDT" }],
				request,
			),
		).resolves.toEqual(new Map([["btc-usdt", "62000.00"]]));
		expect(request.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
			"https://data-api.binance.vision",
			"https://api-gcp.binance.com",
		]);
	});

	it("rejects mismatched or unavailable automatic ticker responses", async () => {
		await expect(
			fetchExchangeRateQuote("okx", "BTC", "USDT", () =>
				Promise.resolve(
					Response.json({
						code: "0",
						data: [{ instId: "ETH-USDT", last: "1" }],
					}),
				),
			),
		).rejects.toThrow("did not return BTC-USDT");
		await expect(
			fetchExchangeRateQuote("binance", "BTC", "USDT", () =>
				Promise.resolve(new Response("unavailable", { status: 503 })),
			),
		).rejects.toThrow("HTTP 503");
	});

	it("uses the exchangerate.host USD default without requesting paid source switching", async () => {
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDEUR: 0.92 },
				}),
			),
		);
		await expect(
			fetchFiatRates("USD", ["CNY", "EUR"], request, undefined, "secret"),
		).resolves.toEqual({ CNY: "7.12", EUR: "0.92" });
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.searchParams.get("source")).toBeNull();
		expect(requestedUrl.searchParams.get("currencies")).toBe("CNY,EUR");
	});

	it("requests the complete fiat table when no symbols are specified", async () => {
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDJPY: 155.2 },
				}),
			),
		);
		await expect(
			fetchFiatRates("USD", [], request, undefined, "secret"),
		).resolves.toEqual({ CNY: "7.12", JPY: "155.2" });
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.searchParams.get("currencies")).toBeNull();
		expect(requestedUrl.searchParams.get("source")).toBeNull();
	});

	it("persists every valid fiat quote returned by the provider", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = 1_800_001_000_000;
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDJPY: 155.2, USDEUR: 0.92, USDXAU: 0.0004 },
				}),
			),
		);
		await expect(
			refreshExchangeRates(db, request, now, {
				category: "fiat",
				apiKey: "secret",
				configuration: {
					...defaultFiatRateSync,
					ownSourceEnabled: true,
					builtInSources: false,
					credentials: { apiKey: "secret", customApiKey: "" },
				},
			}),
		).resolves.toMatchObject({ configured: 4, updated: 4, failed: 0 });
		const rows = await db
			.prepare(
				"SELECT base, quote, raw_rate, rate, adjustment_bps, source FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all<{
				base: string;
				quote: string;
				raw_rate: string;
				rate: string;
				adjustment_bps: number;
				source: string;
			}>();
		expect(rows.results).toEqual([
			{
				base: "USD",
				quote: "CNY",
				raw_rate: "7.12",
				rate: "7.12",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "EUR",
				raw_rate: "0.92",
				rate: "0.92",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "JPY",
				raw_rate: "155.2",
				rate: "155.2",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "XAU",
				raw_rate: "0.0004",
				rate: "0.0004",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
		]);
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{
				enabled: true,
				customSourceEnabled: false,
				customUrl: "",
				ownSourceEnabled: true,
				builtInSources: false,
				intervalMs: 86_400_000,
				adjustmentBps: 125,
				credentials: { apiKey: "secret", customApiKey: "" },
				lastSyncedAt: now,
			},
			null,
			now,
		);
		await refreshExchangeRates(db, request, now + 1, {
			category: "fiat",
			apiKey: "secret",
		});
		const adjusted = await db
			.prepare(
				"SELECT raw_rate, rate, adjustment_bps FROM exchange_rates WHERE base = 'USD' AND quote = 'CNY'",
			)
			.first<{ raw_rate: string; rate: string; adjustment_bps: number }>();
		expect(adjusted).toEqual({
			raw_rate: "7.12",
			rate: "7.209",
			adjustment_bps: 125,
		});
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "exchangerate_host",
				operation: "sync_fiat_rates",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("falls back from a failing built-in source to the next one and records which was used", async () => {
		const now = 1_800_002_000_000;
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				_url.includes("open.er-api.com")
					? Response.json({
							result: "success",
							rates: { USD: 1, VND: 26261.5, EUR: 0.92 },
						})
					: new Response("{}", { status: 503 }),
			),
		);
		await expect(
			refreshExchangeRates(db, request, now, {
				category: "fiat",
				configuration: { ...defaultFiatRateSync, adjustmentBps: 100 },
			}),
		).resolves.toMatchObject({ updated: 2, failed: 0 });
		expect(request.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
			"cdn.jsdelivr.net",
			"latest.currency-api.pages.dev",
			"open.er-api.com",
		]);
		const vnd = await db
			.prepare(
				"SELECT raw_rate, rate, source FROM exchange_rates WHERE base = 'USD' AND quote = 'VND' AND category = 'fiat'",
			)
			.first<{ raw_rate: string; rate: string; source: string }>();
		expect(vnd).toEqual({
			raw_rate: "26261.5",
			rate: "26524.115",
			source: "open_er_api",
		});
	});

	it("tries the operator's own API first and only falls back when it fails", async () => {
		const own = {
			...defaultFiatRateSync,
			ownSourceEnabled: true,
			credentials: { apiKey: "own-key", customApiKey: "" },
		};
		expect(fiatSourceChain(own)).toEqual([
			"exchangerate_host",
			"fawazahmed0",
			"open_er_api",
		]);
		const healthy = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json({ success: true, quotes: { USDVND: 26000 } }),
			),
		);
		await refreshExchangeRates(db, healthy, 1_800_003_000_000, {
			category: "fiat",
			configuration: own,
		});
		expect(healthy).toHaveBeenCalledTimes(1);
		expect(healthy.mock.calls[0]?.[0]).toContain("api.exchangerate.host");
		const failing = vi.fn((url: string) =>
			Promise.resolve(
				url.includes("exchangerate.host")
					? new Response("{}", { status: 500 })
					: Response.json({ usd: { vnd: 26100, btc: 0.00001, eur: 0.9 } }),
			),
		);
		await expect(
			refreshExchangeRates(db, failing, 1_800_003_100_000, {
				category: "fiat",
				configuration: own,
			}),
		).resolves.toMatchObject({ failed: 0 });
		const source = await db
			.prepare(
				"SELECT source FROM exchange_rates WHERE quote = 'VND' AND category = 'fiat'",
			)
			.first<{ source: string }>();
		expect(source?.source).toBe("fawazahmed0");
	});

	it("calls only the operator's API when built-in sources are turned off", async () => {
		const request = vi.fn(() =>
			Promise.resolve(new Response("{}", { status: 500 })),
		);
		const configuration = {
			...defaultFiatRateSync,
			ownSourceEnabled: true,
			builtInSources: false,
			credentials: { apiKey: "own-key", customApiKey: "" },
		};
		const result = await refreshExchangeRates(db, request, 1_800_004_000_000, {
			category: "fiat",
			configuration,
		});
		expect(result.failed).toBe(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(
			fiatSourceChain({
				...defaultFiatRateSync,
				builtInSources: false,
			}),
		).toEqual([]);
		const none = await refreshExchangeRates(db, request, 1_800_004_100_000, {
			category: "fiat",
			configuration: { ...defaultFiatRateSync, builtInSources: false },
		});
		expect(none.failures[0]?.code).toBe("provider_error");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("skips quotes that move more than 30% in one synchronization", async () => {
		const first = vi.fn(() =>
			Promise.resolve(Response.json({ usd: { vnd: 26000, eur: 0.9 } })),
		);
		await refreshExchangeRates(db, first, 1_800_005_000_000, {
			category: "fiat",
			configuration: defaultFiatRateSync,
		});
		const second = vi.fn(() =>
			Promise.resolve(Response.json({ usd: { vnd: 52000, eur: 0.92 } })),
		);
		const result = await refreshExchangeRates(db, second, 1_800_005_100_000, {
			category: "fiat",
			configuration: defaultFiatRateSync,
		});
		expect(result).toMatchObject({ updated: 1, failed: 0 });
		expect(result.rejected).toEqual([
			{ pair: "USD/VND", previous: "26000", received: "52000" },
		]);
		const rows = await db
			.prepare(
				"SELECT quote, raw_rate FROM exchange_rates WHERE category = 'fiat' AND quote IN ('VND', 'EUR') ORDER BY quote",
			)
			.all<{ quote: string; raw_rate: string }>();
		expect(rows.results).toEqual([
			{ quote: "EUR", raw_rate: "0.92" },
			{ quote: "VND", raw_rate: "26000" },
		]);
	});

	it("tries a custom URL before every other source and records it", async () => {
		const configuration = {
			...defaultFiatRateSync,
			customSourceEnabled: true,
			customUrl: "https://rates.example.com/usd.json",
			credentials: { apiKey: "", customApiKey: "custom-token" },
		};
		expect(fiatSourceChain(configuration)).toEqual([
			"custom",
			"fawazahmed0",
			"open_er_api",
		]);
		const request = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(
				Response.json({ base: "USD", rates: { VND: "26500.5" } }),
			),
		);
		await expect(
			refreshExchangeRates(db, request, 1_800_006_000_000, {
				category: "fiat",
				configuration,
			}),
		).resolves.toMatchObject({ updated: 1, failed: 0 });
		expect(request).toHaveBeenCalledTimes(1);
		const [url, init] = request.mock.calls[0] ?? [];
		expect(url).toBe("https://rates.example.com/usd.json");
		expect(init?.redirect).toBe("manual");
		expect(init?.headers).toMatchObject({
			authorization: "Bearer custom-token",
		});
		const row = await db
			.prepare(
				"SELECT source FROM exchange_rates WHERE quote = 'VND' AND category = 'fiat'",
			)
			.first<{ source: string }>();
		expect(row?.source).toBe("custom");
		// An unsafe stored URL is never contacted and never enters the chain.
		expect(
			fiatSourceChain({ ...configuration, customUrl: "http://10.0.0.5/x" }),
		).toEqual(["fawazahmed0", "open_er_api"]);
	});

	it("accepts the documented custom response formats and rejects unsafe ones", async () => {
		const respond = (body: unknown, init?: ResponseInit) => () =>
			Promise.resolve(Response.json(body, init));
		const url = "https://rates.example.com/usd.json";
		await expect(
			fetchCustomRates(
				respond({ rates: { vnd: 26000, eur: 0.9, bad: -1 } }),
				url,
			),
		).resolves.toEqual({ VND: "26000", EUR: "0.9" });
		await expect(
			fetchCustomRates(respond({ usd: { vnd: "26000.5" } }), url),
		).resolves.toEqual({ VND: "26000.5" });
		await expect(
			fetchCustomRates(respond({ quotes: { USDVND: 26000, EURVND: 5 } }), url),
		).resolves.toEqual({ VND: "26000" });
		await expect(
			fetchCustomRates(respond({ base: "EUR", rates: { VND: 1 } }), url),
		).rejects.toThrow("base must be USD");
		await expect(fetchCustomRates(respond({ rates: {} }), url)).rejects.toThrow(
			"no rates",
		);
		await expect(
			fetchCustomRates(
				() =>
					Promise.resolve(
						new Response(null, {
							status: 302,
							headers: { location: "http://169.254.169.254/" },
						}),
					),
				url,
			),
		).rejects.toThrow("redirected");
		await expect(
			fetchCustomRates(
				() =>
					Promise.resolve(
						new Response("{}", { headers: { "content-length": "9999999" } }),
					),
				url,
			),
		).rejects.toThrow("too large");
		const oversized = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(512 * 1024));
				},
			}),
		);
		await expect(
			fetchCustomRates(() => Promise.resolve(oversized), url),
		).rejects.toThrow("too large");
	});

	it("refuses private, non-HTTPS, and privately resolving custom URLs without any request", async () => {
		const request = vi.fn(() =>
			Promise.resolve(Response.json({ rates: { VND: 1 } })),
		);
		for (const unsafe of [
			"http://rates.example.com/usd.json",
			"https://127.0.0.1/usd.json",
			"https://10.1.2.3/usd.json",
			"https://localhost/usd.json",
			"https://user:pass@rates.example.com/usd.json",
			"https://internal.local/usd.json",
		])
			await expect(fetchCustomRates(request, unsafe)).rejects.toThrow(
				"public HTTPS",
			);
		await expect(
			fetchCustomRates(request, "https://rates.example.com/usd.json", {
				resolveHostname: async () => ["10.0.0.9"],
			}),
		).rejects.toThrow("did not resolve publicly");
		expect(request).not.toHaveBeenCalled();
	});

	it("reads fawazahmed0 rates as fiat only and as plain decimals", async () => {
		const rates = await fetchFawazRates(() =>
			Promise.resolve(
				Response.json({
					date: "2026-10-29",
					usd: { vnd: 26261.5, btc: 0.0000094, jpy: 1.5e-7, eur: 0, xxx: 2 },
				}),
			),
		);
		expect(rates).toEqual({ VND: "26261.5", JPY: "0.00000015" });
		const mirror = vi
			.fn<(url: string) => Promise<Response>>()
			.mockResolvedValueOnce(new Response("{}", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ usd: { vnd: 26000 } }));
		await expect(fetchFawazRates(mirror)).resolves.toEqual({ VND: "26000" });
		await expect(
			fetchFawazRates(() => Promise.resolve(Response.json({ date: "x" }))),
		).rejects.toBeDefined();
	});

	it("rejects open endpoint errors and malformed bodies", async () => {
		await expect(
			fetchOpenErApiRates(() =>
				Promise.resolve(Response.json({ result: "error" })),
			),
		).rejects.toThrow("open_er_api API error");
		await expect(
			fetchOpenErApiRates(() =>
				Promise.resolve(new Response("{}", { status: 429 })),
			),
		).rejects.toThrow("HTTP 429");
		await expect(
			fetchOpenErApiRates(() => Promise.resolve(new Response("not json"))),
		).rejects.toBeDefined();
	});

	it("surfaces exchangerate.host API errors without exposing credentials", async () => {
		await expect(
			fetchFiatRates(
				"USD",
				["CNY"],
				() =>
					Promise.resolve(
						Response.json({
							success: false,
							error: { code: 101, type: "invalid_access_key" },
						}),
					),
				undefined,
				"top-secret",
			),
		).rejects.toThrow("API error 101");
	});
});
