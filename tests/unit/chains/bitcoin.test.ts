import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitcoinAdapter } from "#/integrations/chains/bitcoin";
import type { NormalizedTransaction } from "#/integrations/chains/types";

const p2wpkh = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const taproot =
	"bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const legacy = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const p2sh = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const sender = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const txid = (seed: number) => seed.toString(16).padStart(64, "0");

describe("Bitcoin adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		p2wpkh,
		p2wpkh.toUpperCase(),
		taproot,
		legacy,
		p2sh,
	])("accepts the valid mainnet address %s", (address) => {
		expect(adapter().validateAddress(address)).toBe(true);
	});

	it.each([
		["bech32 checksum typo", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdp"],
		["base58 checksum typo", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"],
		["mixed-case bech32", `Bc1${p2wpkh.slice(3)}`],
		["testnet bech32", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"],
		["testnet base58", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"],
		["ethereum address", "0x1111111111111111111111111111111111111111"],
		["empty", ""],
	])("rejects %s", (_name, address) => {
		expect(adapter().validateAddress(address)).toBe(false);
	});

	it("lowercases bech32 payment targets but preserves base58 case", async () => {
		await expect(
			adapter().createPaymentTarget({
				address: p2wpkh.toUpperCase(),
				expiresAt: new Date(0),
			}),
		).resolves.toMatchObject({ address: p2wpkh });
		await expect(
			adapter().createPaymentTarget({
				address: legacy,
				expiresAt: new Date(0),
			}),
		).resolves.toMatchObject({ address: legacy });
		await expect(
			adapter().createPaymentTarget({
				address: "bc1invalid",
				expiresAt: new Date(0),
			}),
		).rejects.toThrow("Invalid Bitcoin address");
	});

	it("normalizes one event per matching output with confirmation depth", async () => {
		route({
			"/blocks/tip/height": "840005",
			[`/address/${p2wpkh}/txs`]: [
				tx(1, {
					height: 840_000,
					outputs: [
						[p2wpkh, 150_000],
						[sender, 9],
					],
				}),
			],
		});
		const found = await adapter().findTransactions({
			address: p2wpkh,
			assetCode: "BTC",
		});
		expect(found).toEqual([
			expect.objectContaining({
				network: "bitcoin",
				hash: txid(1),
				eventIndex: 0,
				from: sender,
				to: p2wpkh,
				assetCode: "BTC",
				amountUnits: 150_000n,
				blockNumber: 840_000n,
				blockHash: "blockhash-840000",
				confirmations: 6,
				success: true,
				canonical: true,
			}),
		]);
		const [payment] = found;
		if (!payment) throw new Error("Missing payment");
		expect(adapter().validatePayment(payment, target(p2wpkh), "BTC")).toBe(
			true,
		);
		expect(adapter().validatePayment(payment, target(legacy), "BTC")).toBe(
			false,
		);
	});

	it("reports mempool transactions as unconfirmed with a stable marker", async () => {
		route({
			"/blocks/tip/height": "840005",
			[`/address/${p2wpkh}/txs`]: [tx(2, { outputs: [[p2wpkh, 1000]] })],
		});
		const [event] = await adapter().findTransactions({
			address: p2wpkh,
			assetCode: "BTC",
		});
		expect(event).toMatchObject({
			blockNumber: 0n,
			blockHash: `btc:mempool:${txid(2)}`,
			confirmations: 0,
		});
		await expect(
			adapter().getConfirmations(event as NormalizedTransaction),
		).resolves.toBe(0);
	});

	it("ignores other assets and exposes no events for foreign outputs", async () => {
		const fetchMock = stubFetch({});
		await expect(
			adapter().findTransactions({ address: p2wpkh, assetCode: "USDT" }),
		).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("pages confirmed history and stops at the scan cursor", async () => {
		const page = (start: number, count: number) =>
			Array.from({ length: count }, (_, index) =>
				tx(start + index, {
					height: 840_100 - (start + index),
					outputs: [[p2wpkh, 1]],
				}),
			);
		const first = page(1, 25);
		route({
			"/blocks/tip/height": "840100",
			[`/address/${p2wpkh}/txs`]: first,
			[`/address/${p2wpkh}/txs/chain/${txid(25)}`]: page(26, 25),
		});
		const found = await adapter().findTransactions({
			address: p2wpkh,
			assetCode: "BTC",
			sinceBlock: 840_060n,
		});
		// Heights 840099..840060 are kept (40 txs); older rows are skipped.
		expect(found).toHaveLength(40);
		expect(found.every((event) => event.blockNumber >= 840_060n)).toBe(true);
	});

	it("fails visibly on a repeated pagination cursor", async () => {
		const full = Array.from({ length: 25 }, (_, index) =>
			tx(index + 1, { height: 840_000 - index, outputs: [[p2wpkh, 1]] }),
		);
		stubFetch({
			"/blocks/tip/height": "840100",
			[`/address/${p2wpkh}/txs`]: full,
			[`/address/${p2wpkh}/txs/chain/${txid(25)}`]: full,
		});
		await expect(
			adapter().findTransactions({ address: p2wpkh, assetCode: "BTC" }),
		).rejects.toThrow("repeated a cursor");
	});

	it("fails visibly when pagination exceeds the configured limit", async () => {
		const page = (start: number) =>
			Array.from({ length: 25 }, (_, index) =>
				tx(start + index, {
					height: 840_000 - start - index,
					outputs: [[p2wpkh, 1]],
				}),
			);
		stubFetch({
			"/blocks/tip/height": "840100",
			[`/address/${p2wpkh}/txs`]: page(1),
			[`/address/${p2wpkh}/txs/chain/${txid(25)}`]: page(26),
		});
		await expect(
			adapter({ maxPages: 2 }).findTransactions({
				address: p2wpkh,
				assetCode: "BTC",
			}),
		).rejects.toThrow("exceeded the configured limit");
	});

	it("looks up a single output by txid and event index", async () => {
		route({
			"/blocks/tip/height": "100",
			[`/tx/${txid(7)}`]: tx(7, {
				height: 99,
				outputs: [
					[sender, 5],
					[p2wpkh, 42],
					[p2wpkh, 43],
				],
			}),
		});
		const event = await adapter().getTransaction(txid(7).toUpperCase(), {
			address: p2wpkh,
			assetCode: "BTC",
			eventIndex: 2,
		});
		expect(event).toMatchObject({
			hash: txid(7),
			eventIndex: 2,
			amountUnits: 43n,
			confirmations: 2,
		});
	});

	it("treats a dropped or replaced transaction as not found", async () => {
		stubFetch({}, 404);
		await expect(
			adapter().getTransaction(txid(8), { address: p2wpkh }),
		).resolves.toBeNull();
		await expect(adapter().getTransaction("not-a-txid")).rejects.toThrow(
			"64-character txid",
		);
	});

	it("rejects satoshi amounts that are not exact integers", async () => {
		route({
			"/blocks/tip/height": "1",
			[`/address/${p2wpkh}/txs`]: [
				tx(9, { height: 1, outputs: [[p2wpkh, 0.5]] }),
			],
		});
		const error = await adapter()
			.findTransactions({ address: p2wpkh, assetCode: "BTC" })
			.catch((reason: unknown) => reason);
		expect(adapter().classifyError(error)).toBe("invalid_response");
	});

	it("classifies HTTP failures and reports health", async () => {
		const bitcoin = adapter();
		stubFetch({}, 429);
		await expect(bitcoin.healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "Bitcoin health check failed: rate_limit",
		});
		stubFetch({ "/blocks/tip/height": "840000" });
		await expect(bitcoin.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		stubFetch({}, 404);
		const missing = await bitcoin
			.findTransactions({ address: p2wpkh, assetCode: "BTC" })
			.catch((reason: unknown) => reason);
		expect(bitcoin.classifyError(missing)).toBe("not_found");
		expect(bitcoin.isRetryable("rate_limit")).toBe(true);
		expect(bitcoin.isRetryable("permanent")).toBe(false);
	});
});

function adapter(overrides: Record<string, unknown> = {}) {
	return new BitcoinAdapter({
		apiUrl: "https://btc.example.test/api",
		...overrides,
	});
}

function target(address: string) {
	return { address, expiresAt: new Date(0) };
}

function tx(
	seed: number,
	input: { height?: number; outputs: Array<[string, number]> },
) {
	return {
		txid: txid(seed),
		vin: [{ prevout: { scriptpubkey_address: sender } }],
		vout: input.outputs.map(([scriptpubkey_address, value]) => ({
			scriptpubkey_address,
			value,
		})),
		status:
			input.height === undefined
				? { confirmed: false }
				: {
						confirmed: true,
						block_height: input.height,
						block_hash: `blockhash-${input.height}`,
						block_time: 1_700_000_000,
					},
	};
}

function stubFetch(routes: Record<string, unknown>, missingStatus = 404) {
	const mock = vi.fn(async (input: string | URL | Request) => {
		const path = new URL(String(input)).pathname.replace(/^\/api/, "");
		const body = routes[path];
		if (body === undefined) return new Response("", { status: missingStatus });
		return new Response(
			typeof body === "string" ? body : JSON.stringify(body),
			{ status: 200 },
		);
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

const route = stubFetch;
