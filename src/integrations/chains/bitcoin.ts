import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import { operationDeadline, operationSignal } from "./operation-deadline";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
} from "./types";

const configSchema = z.object({
	// Esplora-compatible REST API (mempool.space, Blockstream, self-hosted).
	apiUrl: z.url().default("https://mempool.space/api"),
	nativeAsset: z.string().default("BTC"),
	apiKey: z.string().optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(200).default(20),
});
export type BitcoinConfig = z.infer<typeof configSchema>;

// Esplora serves confirmed history in pages of 25 transactions.
const confirmedPageSize = 25;
const txidPattern = /^[0-9a-fA-F]{64}$/;

const outputSchema = z.object({
	scriptpubkey_address: z.string().optional(),
	// Satoshi values stay below 2^53 (21e14 total supply), so a JSON number is
	// exact; zod's int() rejects anything outside the safe-integer range.
	value: z.number().int().nonnegative(),
});
const transactionSchema = z.object({
	txid: z.string().regex(txidPattern),
	vin: z.array(
		z.object({
			prevout: z
				.object({ scriptpubkey_address: z.string().optional() })
				.nullish(),
		}),
	),
	vout: z.array(outputSchema),
	status: z.object({
		confirmed: z.boolean(),
		block_height: z.number().int().nonnegative().optional(),
		block_hash: z.string().optional(),
		block_time: z.number().int().nonnegative().optional(),
	}),
});
type EsploraTransaction = z.infer<typeof transactionSchema>;

export class BitcoinAdapter implements PaymentAdapter<BitcoinConfig> {
	readonly id = "bitcoin";
	readonly network = "bitcoin" as const;
	readonly configSchema = configSchema;
	readonly config: BitcoinConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Bitcoin address");
		return {
			address: normalizeAddress(input.address),
			expiresAt: input.expiresAt,
		};
	}
	validateAddress(address: string) {
		return isBitcoinAddress(address);
	}
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.canonical !== false &&
			transaction.to === normalizeAddress(target.address) &&
			transaction.assetCode.toUpperCase() === assetCode.toUpperCase()
		);
	}
	async getTransaction(hash: string, lookup?: TransactionLookup) {
		return observeProviderOperation(
			{
				adapter: "bitcoin",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.getTransactionObserved(hash, lookup, counters),
		);
	}
	private async getTransactionObserved(
		hash: string,
		lookup: TransactionLookup | undefined,
		counters: ProviderOperationCounters,
	) {
		if (!txidPattern.test(hash))
			throw new Error("Bitcoin transaction hash must be a 64-character txid");
		if (
			lookup?.assetCode != null &&
			lookup.assetCode.toUpperCase() !== this.config.nativeAsset.toUpperCase()
		)
			return null;
		if (lookup?.address != null && !this.validateAddress(lookup.address))
			throw new Error("Invalid Bitcoin address");
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		// A dropped or replaced (RBF) transaction is a normal "not found".
		const body = await this.get(
			`/tx/${hash.toLowerCase()}`,
			deadlineAt,
			counters,
		).catch((error: unknown) => {
			if (error instanceof BitcoinHttpError && error.status === 404)
				return null;
			throw error;
		});
		if (body === null) return null;
		const transaction = transactionSchema.parse(JSON.parse(body));
		const tip = await this.tipHeight(deadlineAt, counters);
		const events = this.events(transaction, tip, lookup?.address);
		return (
			events.find(
				(event) =>
					lookup?.eventIndex == null || event.eventIndex === lookup.eventIndex,
			) ?? null
		);
	}
	async findTransactions(input: {
		address: string;
		assetCode: string;
		sinceBlock?: bigint;
	}) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Bitcoin address");
		if (input.assetCode.toUpperCase() !== this.config.nativeAsset.toUpperCase())
			return [];
		return observeProviderOperation(
			{
				adapter: "bitcoin",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.findTransactionsObserved(input, counters),
		);
	}
	private async findTransactionsObserved(
		input: { address: string; sinceBlock?: bigint },
		counters: ProviderOperationCounters,
	) {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const address = normalizeAddress(input.address);
		const tip = await this.tipHeight(deadlineAt, counters);
		const events: NormalizedTransaction[] = [];
		let lastSeen: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters.page();
			const path = lastSeen
				? `/address/${address}/txs/chain/${lastSeen}`
				: `/address/${address}/txs`;
			const body = await this.get(path, deadlineAt, counters);
			const rows = z.array(transactionSchema).parse(JSON.parse(body));
			const confirmed = rows.filter((row) => row.status.confirmed);
			// Esplora returns mempool transactions first, then confirmed history by
			// descending height. Everything below the cursor has been scanned.
			let reachedCursor = false;
			for (const row of rows) {
				const height = BigInt(row.status.block_height ?? 0);
				if (
					row.status.confirmed &&
					input.sinceBlock !== undefined &&
					height < input.sinceBlock
				) {
					reachedCursor = true;
					continue;
				}
				events.push(...this.events(row, tip, address));
			}
			const last = confirmed.at(-1);
			if (
				reachedCursor ||
				confirmed.length < confirmedPageSize ||
				last === undefined
			)
				return events;
			if (last.txid === lastSeen)
				throw new Error("Bitcoin address pagination repeated a cursor");
			lastSeen = last.txid;
		}
		throw new Error("Bitcoin address pagination exceeded the configured limit");
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return observeProviderOperation(
			{
				adapter: "bitcoin",
				operation: "get_confirmations",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				if (transaction.blockNumber === 0n) return 0;
				const tip = await this.tipHeight(
					operationDeadline(this.config.timeoutMs),
					counters,
				);
				return confirmationsAt(tip, Number(transaction.blockNumber));
			},
		);
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "bitcoin",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) =>
					this.tipHeight(operationDeadline(this.config.timeoutMs), counters),
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
				detail: `Bitcoin health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof BitcoinHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status === 404) return "not_found";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return "invalid_response";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}
	isRetryable(kind: AdapterErrorKind) {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	/** One normalized event per output paying `address` (every output if omitted). */
	private events(
		transaction: EsploraTransaction,
		tip: number,
		address?: string,
	): NormalizedTransaction[] {
		const target =
			address === undefined ? undefined : normalizeAddress(address);
		const { status } = transaction;
		const height = status.confirmed ? (status.block_height ?? 0) : 0;
		const sender =
			transaction.vin.find((input) => input.prevout?.scriptpubkey_address)
				?.prevout?.scriptpubkey_address ?? "";
		const events: NormalizedTransaction[] = [];
		transaction.vout.forEach((output, index) => {
			const to = output.scriptpubkey_address;
			if (to === undefined || (target !== undefined && to !== target)) return;
			events.push({
				network: "bitcoin",
				hash: transaction.txid.toLowerCase(),
				eventIndex: index,
				from: sender,
				to,
				assetCode: this.config.nativeAsset.toUpperCase(),
				amountUnits: BigInt(output.value),
				blockNumber: BigInt(height),
				// A stable mempool marker lets the payment pipeline observe the
				// block-hash change when the transaction confirms or is re-mined.
				blockHash: status.confirmed
					? (status.block_hash ?? `btc:height:${height}`)
					: `btc:mempool:${transaction.txid.toLowerCase()}`,
				confirmations: status.confirmed ? confirmationsAt(tip, height) : 0,
				timestamp: new Date((status.block_time ?? 0) * 1000 || Date.now()),
				success: true,
				canonical: true,
			});
		});
		return events;
	}
	private async tipHeight(
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const body = await this.get("/blocks/tip/height", deadlineAt, counters);
		return z.coerce.number().int().nonnegative().parse(body.trim());
	}
	private async get(
		path: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	): Promise<string> {
		counters.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/+$/, "")}${path}`,
			{
				headers: this.config.apiKey
					? { authorization: `Bearer ${this.config.apiKey}` }
					: {},
				signal: operationSignal(deadlineAt, "Bitcoin operation"),
			},
		);
		if (!response.ok) throw new BitcoinHttpError(response.status);
		return response.text();
	}
}

class BitcoinHttpError extends Error {
	constructor(readonly status: number) {
		super(`Bitcoin API returned HTTP ${status}`);
	}
}

function confirmationsAt(tip: number, height: number) {
	// A provider that lags behind the block it reported still implies depth 1.
	return Math.max(1, tip - height + 1);
}

/** Bech32 addresses are case-insensitive and canonicalized to lowercase. */
function normalizeAddress(address: string) {
	return address.toLowerCase().startsWith("bc1")
		? address.toLowerCase()
		: address;
}

const base58Alphabet =
	"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bech32Alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function isBitcoinAddress(address: string) {
	return isBase58CheckAddress(address) || isSegwitAddress(address);
}

/** Mainnet P2PKH (version 0x00) and P2SH (version 0x05). */
function isBase58CheckAddress(address: string) {
	if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return false;
	let value = 0n;
	for (const char of address)
		value = value * 58n + BigInt(base58Alphabet.indexOf(char));
	const bytes = new Uint8Array(25);
	for (let index = 24; index >= 0; index -= 1) {
		bytes[index] = Number(value & 0xffn);
		value >>= 8n;
	}
	if (value !== 0n) return false;
	const leadingOnes = address.length - address.replace(/^1+/, "").length;
	if (bytes.findIndex((byte) => byte !== 0) !== leadingOnes) return false;
	if (bytes[0] !== (address.startsWith("1") ? 0x00 : 0x05)) return false;
	const checksum = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
	return checksum.every((byte, index) => byte === bytes[21 + index]);
}

/** Mainnet SegWit: v0 uses bech32 (BIP-173), v1+ uses bech32m (BIP-350). */
function isSegwitAddress(address: string) {
	if (address !== address.toLowerCase() && address !== address.toUpperCase())
		return false;
	const lower = address.toLowerCase();
	if (!lower.startsWith("bc1") || lower.length < 14 || lower.length > 90)
		return false;
	const data: number[] = [];
	for (const char of lower.slice(3)) {
		const index = bech32Alphabet.indexOf(char);
		if (index < 0) return false;
		data.push(index);
	}
	const [version, ...rest] = data.slice(0, -6);
	if (version === undefined || version > 16) return false;
	const constant = version === 0 ? 1 : 0x2bc830a3;
	if (bech32Polymod([...hrpExpand("bc"), ...data]) !== constant) return false;
	const program = convertBits(rest, 5, 8);
	if (!program || program.length < 2 || program.length > 40) return false;
	if (version === 0) return program.length === 20 || program.length === 32;
	return true;
}

function hrpExpand(hrp: string) {
	return [
		...[...hrp].map((char) => char.charCodeAt(0) >> 5),
		0,
		...[...hrp].map((char) => char.charCodeAt(0) & 31),
	];
}

function bech32Polymod(values: number[]) {
	const generators = [
		0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
	];
	let checksum = 1;
	for (const value of values) {
		const top = checksum >>> 25;
		checksum = ((checksum & 0x1ffffff) << 5) ^ value;
		for (let bit = 0; bit < 5; bit += 1)
			if ((top >>> bit) & 1) checksum ^= generators[bit] as number;
	}
	return checksum >>> 0;
}

/** Strict 5-to-8-bit regrouping: non-zero or oversized padding is invalid. */
function convertBits(data: number[], from: number, to: number) {
	let accumulator = 0;
	let bits = 0;
	const result: number[] = [];
	for (const value of data) {
		accumulator = (accumulator << from) | value;
		bits += from;
		while (bits >= to) {
			bits -= to;
			result.push((accumulator >>> bits) & ((1 << to) - 1));
		}
		accumulator &= (1 << bits) - 1;
	}
	if (bits >= from || accumulator !== 0) return null;
	return result;
}
