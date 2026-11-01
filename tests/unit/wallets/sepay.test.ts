import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractTransferCode,
	generateTransferCode,
	SepayAdapter,
} from "#/integrations/wallets/sepay";
import listFixture from "../../fixtures/providers/sepay-transactions.json";

const accountNumber = "0123456789";

describe("SePay adapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("requires a webhook credential", () => {
		expect(
			() => new SepayAdapter({ accountNumber, apiToken: "token" }),
		).toThrow();
		expect(() => adapter()).not.toThrow();
	});

	it("verifies the Apikey webhook header in constant time", () => {
		const instance = adapter({ webhookApiKey: "hook-key" });
		const body = utf8ToBytes("{}");
		expect(
			instance.verifyWebhook(
				new Headers({ authorization: "Apikey hook-key" }),
				body,
			),
		).toBe(true);
		for (const authorization of ["Apikey wrong", "Bearer hook-key", ""])
			expect(instance.verifyWebhook(new Headers({ authorization }), body)).toBe(
				false,
			);
		expect(instance.verifyWebhook(new Headers(), body)).toBe(false);
	});

	it("verifies HMAC-SHA256 signatures over timestamp.body and rejects stale or altered requests", () => {
		const instance = adapter({ webhookSecret: "hook-secret" });
		const body = utf8ToBytes('{"id":1}');
		const now = 1_800_000_000;
		const sign = (timestamp: number, payload: Uint8Array) =>
			`sha256=${bytesToHex(
				hmac(
					sha256,
					utf8ToBytes("hook-secret"),
					new Uint8Array([...utf8ToBytes(`${timestamp}.`), ...payload]),
				),
			)}`;
		const headers = (timestamp: number, signature: string) =>
			new Headers({
				"x-sepay-timestamp": String(timestamp),
				"x-sepay-signature": signature,
			});
		expect(
			instance.verifyWebhook(headers(now, sign(now, body)), body, now),
		).toBe(true);
		expect(
			instance.verifyWebhook(
				headers(now, sign(now, body)),
				utf8ToBytes('{"id":2}'),
				now,
			),
		).toBe(false);
		expect(
			instance.verifyWebhook(
				headers(now - 301, sign(now - 301, body)),
				body,
				now,
			),
		).toBe(false);
		expect(
			instance.verifyWebhook(
				new Headers({ "x-sepay-signature": sign(now, body) }),
				body,
				now,
			),
		).toBe(false);
		// An API key header never satisfies a configured HMAC secret.
		expect(
			instance.verifyWebhook(
				new Headers({ authorization: "Apikey hook-secret" }),
				body,
				now,
			),
		).toBe(false);
	});

	it("generates bank-safe transfer codes and extracts them from transfer content", () => {
		const code = generateTransferCode();
		expect(code).toMatch(/^EW[A-Z0-9]{12}$/);
		expect(generateTransferCode()).not.toBe(code);
		expect(
			extractTransferCode(null, `chuyen khoan ${code.toLowerCase()} ok`),
		).toBe(code);
		expect(extractTransferCode("EWABC123DEF456", "ignored")).toBe(
			"EWABC123DEF456",
		);
		expect(extractTransferCode(null, "no code here", undefined)).toBeNull();
	});

	it("reads incoming transfers with a bearer token, filters and VND units", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json(listFixture));
		vi.stubGlobal("fetch", fetchMock);
		const transfers = await adapter().searchIncoming({
			accountNumber,
			sinceMs: Date.parse("2026-10-28T13:00:00Z"),
			query: "EWABC123DEF456",
			amountVnd: 350_000n,
		});
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.origin + url.pathname).toBe(
			"https://userapi.sepay.vn/v2/transactions",
		);
		expect(url.searchParams.get("transfer_type")).toBe("in");
		expect(url.searchParams.get("q")).toBe("EWABC123DEF456");
		expect(url.searchParams.get("amount_in_min")).toBe("350000");
		expect(url.searchParams.get("amount_in_max")).toBe("350000");
		expect(url.searchParams.get("transaction_date_from")).toBe("2026-10-28");
		expect(url.searchParams.get("per_page")).toBe("100");
		expect(init.headers).toMatchObject({ authorization: "Bearer api-token" });
		expect(transfers).toHaveLength(1);
		expect(transfers[0]).toMatchObject({
			referenceNumber: "FT26301000001",
			code: "EWABC123DEF456",
			transaction: {
				network: "sepay",
				hash: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
				assetCode: "VND",
				amountUnits: 350_000n,
				to: accountNumber,
				success: true,
			},
		});
	});

	it("ignores transfers for other accounts and older than the lookback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => Response.json(listFixture)),
		);
		await expect(
			adapter().searchIncoming({ accountNumber: "9999999999", sinceMs: 0 }),
		).resolves.toEqual([]);
		await expect(
			adapter().searchIncoming({
				accountNumber,
				sinceMs: Date.parse("2026-10-29T00:00:00Z"),
			}),
		).resolves.toEqual([]);
	});

	it("follows pagination until has_more is false", async () => {
		const page = (hasMore: boolean) => ({
			...listFixture,
			meta: { pagination: { has_more: hasMore } },
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(page(true)))
			.mockResolvedValueOnce(Response.json(page(false)));
		vi.stubGlobal("fetch", fetchMock);
		const transfers = await adapter().searchIncoming({
			accountNumber,
			sinceMs: 0,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(transfers).toHaveLength(2);
	});

	it("looks a transaction up by UUID and treats 404 as absent", async () => {
		const detail = {
			status: "success",
			data: listFixture.data[0],
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(detail))
			.mockResolvedValueOnce(new Response("{}", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		const id = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
		await expect(adapter().getTransaction(id)).resolves.toMatchObject({
			hash: id,
			amountUnits: 350_000n,
		});
		await expect(adapter().getTransaction(id)).resolves.toBeNull();
		const [url] = fetchMock.mock.calls[0] as [URL];
		expect(url.pathname).toBe(`/v2/transactions/${id}`);
	});

	it("finds a transaction by order transfer code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => Response.json(listFixture)),
		);
		await expect(
			adapter().getTransaction("EWABC123DEF456"),
		).resolves.toMatchObject({ amountUnits: 350_000n });
		await expect(
			adapter().getTransaction("EWZZZZZZZZZZZZ"),
		).resolves.toBeNull();
	});

	it("rejects non-integer or negative amounts as an invalid response", async () => {
		for (const amount of [1.5, -1, "12.5"]) {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					Response.json({
						...listFixture,
						data: [{ ...listFixture.data[0], amount_in: amount }],
					}),
				),
			);
			await expect(
				adapter().searchIncoming({ accountNumber, sinceMs: 0 }),
			).rejects.toBeDefined();
		}
	});

	it("classifies provider failures and reports health without leaking details", async () => {
		const instance = adapter();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
		);
		await expect(instance.healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "SePay health check failed: authentication",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 429 })),
		);
		await expect(instance.healthCheck()).resolves.toMatchObject({
			detail: "SePay health check failed: rate_limit",
		});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
		await expect(instance.healthCheck()).resolves.toMatchObject({
			detail: "SePay health check failed: network",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json(listFixture)),
		);
		await expect(instance.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
	});

	it("only accepts its configured account as a payment target", async () => {
		const instance = adapter();
		await expect(instance.validateTarget(accountNumber)).resolves.toBe(true);
		await expect(instance.validateTarget("0000000000")).resolves.toBe(false);
	});
});

function adapter(overrides: Record<string, unknown> = {}) {
	return new SepayAdapter({
		accountNumber,
		apiToken: "api-token",
		webhookApiKey: "hook-key",
		...overrides,
	});
}
