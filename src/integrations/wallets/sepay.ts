import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
} from "#/integrations/chains/types";
import type { ProviderOperationCounters } from "#/integrations/provider-observability";
import { observeProviderOperation } from "#/integrations/provider-observability";
import { constantTimeEqual } from "#/lib/crypto";

export const sepayAssetCode = "VND";
export const sepayTransferCodePrefix = "EW";
const transferCodePattern = /EW[A-Z0-9]{12}/;
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumListPages = 5;
const webhookToleranceSeconds = 300;
const vietnamOffsetMs = 7 * 60 * 60 * 1000;

const configSchema = z
	.object({
		accountNumber: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9]{4,32}$/),
		apiToken: z.string().trim().min(1),
		webhookApiKey: z.string().trim().min(1).optional(),
		webhookSecret: z.string().trim().min(1).optional(),
		apiUrl: z.url().default("https://userapi.sepay.vn/v2"),
		timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	})
	.refine((config) => config.webhookApiKey || config.webhookSecret, {
		message: "A webhook API key or HMAC secret is required",
	});
export type SepayConfig = z.infer<typeof configSchema>;

const transferSchema = z.looseObject({
	id: z.string().min(1),
	transaction_date: z.string().min(1),
	account_number: z.string().min(1),
	transfer_type: z.string(),
	// SePay documents currency fields as integers. Strings are accepted only
	// when they are plain digits so no precision is ever guessed.
	amount_in: z.union([z.number(), z.string()]),
	transaction_content: z.string().nullish(),
	reference_number: z.string().nullish(),
	code: z.string().nullish(),
	bank_brand_name: z.string().nullish(),
});
const listSchema = z.looseObject({
	status: z.literal("success"),
	data: z.array(transferSchema),
	meta: z
		.looseObject({
			pagination: z.looseObject({ has_more: z.boolean().optional() }),
		})
		.optional(),
});
const detailSchema = z.looseObject({
	status: z.literal("success"),
	data: transferSchema,
});

export type SepayTransfer = {
	transaction: NormalizedTransaction;
	referenceNumber: string;
	content: string;
	code: string | null;
};

export type SepayTransferQuery = {
	accountNumber: string;
	sinceMs: number;
	query?: string;
	amountVnd?: bigint;
};

export class SepayAdapter implements PaymentAdapter<SepayConfig> {
	readonly id = "sepay";
	readonly network = "sepay" as const;
	readonly configSchema = configSchema;
	readonly config: SepayConfig;

	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}

	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}

	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("SePay account number does not match credentials");
		return input;
	}

	validateAddress(address: string) {
		return address.trim() === this.config.accountNumber;
	}

	async validateTarget(address: string) {
		return this.validateAddress(address);
	}

	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.to === target.address &&
			transaction.assetCode === assetCode.toUpperCase()
		);
	}

	async getConfirmations(transaction: NormalizedTransaction) {
		return transaction.success ? 1 : 0;
	}

	/**
	 * Verifies a SePay webhook with the HMAC-SHA256 secret when configured and
	 * otherwise with the API key. Unauthenticated webhooks are never accepted.
	 */
	verifyWebhook(
		headers: Headers,
		rawBody: Uint8Array,
		nowSeconds = Math.floor(Date.now() / 1000),
	) {
		const { webhookSecret, webhookApiKey } = this.config;
		if (webhookSecret) {
			const timestamp = headers.get("x-sepay-timestamp") ?? "";
			const signature = headers.get("x-sepay-signature") ?? "";
			if (!/^\d{1,12}$/.test(timestamp)) return false;
			if (Math.abs(nowSeconds - Number(timestamp)) > webhookToleranceSeconds)
				return false;
			const signed = new Uint8Array([
				...utf8ToBytes(`${timestamp}.`),
				...rawBody,
			]);
			const expected = `sha256=${bytesToHex(
				hmac(sha256, utf8ToBytes(webhookSecret), signed),
			)}`;
			return constantTimeEqual(expected, signature);
		}
		return constantTimeEqual(
			`Apikey ${webhookApiKey ?? ""}`,
			headers.get("authorization") ?? "",
		);
	}

	async getTransaction(
		reference: string,
		lookup?: { address?: string },
	): Promise<NormalizedTransaction | null> {
		return observeProviderOperation(
			{
				adapter: "sepay",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				if (uuidPattern.test(reference)) {
					const payload = await this.get(
						`transactions/${reference}`,
						{},
						counters,
						true,
					);
					if (!payload) return null;
					const transfer = this.normalize(detailSchema.parse(payload).data);
					return transfer.transaction.success ? transfer.transaction : null;
				}
				// A non-UUID reference is the order's transfer code.
				const transfers = await this.list(
					{
						accountNumber: lookup?.address ?? this.config.accountNumber,
						sinceMs: 0,
						query: reference,
					},
					counters,
				);
				return (
					transfers.find((transfer) =>
						transferMentionsCode(transfer, reference),
					)?.transaction ?? null
				);
			},
		);
	}

	async findTransactions(input: {
		address: string;
		assetCode: string;
		sinceBlock?: bigint;
	}) {
		return observeProviderOperation(
			{
				adapter: "sepay",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const transfers = await this.list(
					{
						accountNumber: input.address,
						sinceMs: input.sinceBlock
							? Number(input.sinceBlock) - 10 * 60_000
							: Date.now() - 24 * 60 * 60_000,
					},
					counters,
				);
				return transfers.map((transfer) => transfer.transaction);
			},
		);
	}

	/** Incoming transfers matching the filters, oldest first. */
	async searchIncoming(query: SepayTransferQuery) {
		return observeProviderOperation(
			{
				adapter: "sepay",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.list(query, counters),
		);
	}

	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "sepay",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.get("transactions", { per_page: "1" }, counters),
			);
			return {
				healthy: true,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				detail: `SePay health check failed: ${this.classifyError(error)}`,
			};
		}
	}

	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof SepayInvalidResponseError) return "invalid_response";
		if (error instanceof SepayHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (error instanceof z.ZodError) return "invalid_response";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}

	isRetryable(kind: AdapterErrorKind) {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	private async list(
		query: SepayTransferQuery,
		counters: ProviderOperationCounters,
	) {
		const transfers: SepayTransfer[] = [];
		for (let page = 1; page <= maximumListPages; page += 1) {
			const params: Record<string, string> = {
				transfer_type: "in",
				transaction_date_sort: "asc",
				timestamp_format: "iso8601",
				per_page: "100",
				page: String(page),
			};
			if (query.sinceMs > 0)
				params.transaction_date_from = vietnamDate(query.sinceMs);
			if (query.query) params.q = query.query;
			if (query.amountVnd !== undefined) {
				params.amount_in_min = query.amountVnd.toString();
				params.amount_in_max = query.amountVnd.toString();
			}
			const payload = listSchema.parse(
				await this.get("transactions", params, counters),
			);
			if (page > 1) counters.page();
			for (const item of payload.data) {
				const transfer = this.normalize(item);
				if (
					transfer.transaction.success &&
					transfer.transaction.to === query.accountNumber &&
					transfer.transaction.timestamp.getTime() >= query.sinceMs
				)
					transfers.push(transfer);
			}
			if (!payload.meta?.pagination.has_more) break;
		}
		return transfers;
	}

	private normalize(item: z.infer<typeof transferSchema>): SepayTransfer {
		const amountUnits = parseVnd(item.amount_in);
		const timestamp = parseTransferTime(item.transaction_date);
		return {
			referenceNumber: item.reference_number ?? "",
			content: item.transaction_content ?? "",
			code: item.code ?? null,
			transaction: {
				network: "sepay",
				hash: item.id,
				eventIndex: 0,
				from: item.bank_brand_name ?? "bank",
				to: item.account_number,
				assetCode: sepayAssetCode,
				amountUnits,
				blockNumber: BigInt(timestamp.getTime()),
				blockHash: `sepay:${item.id}`,
				confirmations: 1,
				timestamp,
				success: item.transfer_type === "in" && amountUnits > 0n,
				canonical: true,
			},
		};
	}

	private async get(
		path: string,
		params: Record<string, string>,
		counters: ProviderOperationCounters,
		allowNotFound = false,
	) {
		counters.request();
		const url = new URL(`${this.config.apiUrl.replace(/\/$/, "")}/${path}`);
		for (const [key, value] of Object.entries(params))
			url.searchParams.set(key, value);
		const response = await fetch(url, {
			headers: {
				authorization: `Bearer ${this.config.apiToken}`,
				accept: "application/json",
			},
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});
		if (allowNotFound && response.status === 404) return null;
		if (!response.ok) throw new SepayHttpError(response.status);
		try {
			return (await response.json()) as unknown;
		} catch {
			throw new SepayInvalidResponseError();
		}
	}
}

class SepayHttpError extends Error {
	constructor(readonly status: number) {
		super(`SePay returned HTTP ${status}`);
	}
}

class SepayInvalidResponseError extends Error {}

/** A random, bank-safe transfer code the payer writes in the transfer content. */
export function generateTransferCode() {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let code = "";
	while (code.length < 12) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			// 252 is the largest multiple of 36 below 256, so there is no modulo bias.
			if (byte < 252 && code.length < 12) code += alphabet[byte % 36];
		}
	}
	return `${sepayTransferCodePrefix}${code}`;
}

export function extractTransferCode(
	...texts: Array<string | null | undefined>
) {
	for (const text of texts) {
		const match = text?.toUpperCase().match(transferCodePattern);
		if (match) return match[0];
	}
	return null;
}

function transferMentionsCode(transfer: SepayTransfer, code: string) {
	return extractTransferCode(transfer.code, transfer.content) === code;
}

function parseVnd(value: number | string) {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new SepayInvalidResponseError();
		return BigInt(value);
	}
	if (!/^\d+$/.test(value)) throw new SepayInvalidResponseError();
	return BigInt(value);
}

function parseTransferTime(value: string) {
	// SePay reports Vietnam local time without an offset unless iso8601 is requested.
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(" ", "T")}+07:00`
		: value;
	const time = new Date(normalized);
	if (Number.isNaN(time.getTime())) throw new SepayInvalidResponseError();
	return time;
}

function vietnamDate(ms: number) {
	return new Date(ms + vietnamOffsetMs).toISOString().slice(0, 10);
}
