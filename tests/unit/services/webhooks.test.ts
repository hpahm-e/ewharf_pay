import { describe, expect, it, vi } from "vitest";
import { verifyEwharfSignature } from "#/features/api-keys/server/ewharf-signature";
import {
	deliverWebhook,
	parseRetryAfter,
	retryDelayMs,
} from "#/features/webhooks/server/delivery";

describe("webhooks", () => {
	it("caps exponential retry backoff", () => {
		expect(retryDelayMs(1)).toBe(15_000);
		expect(retryDelayMs(20)).toBe(3_600_000);
	});

	it("parses Retry-After seconds and HTTP dates within the retry cap", () => {
		const now = Date.UTC(2026, 6, 14, 0, 0, 0);
		expect(parseRetryAfter("12", now)).toBe(12_000);
		expect(parseRetryAfter("Tue, 14 Jul 2026 00:10:00 GMT", now)).toBe(600_000);
		expect(parseRetryAfter("999999", now)).toBe(3_600_000);
		expect(parseRetryAfter("invalid", now)).toBeUndefined();
		expect(parseRetryAfter("-1", now)).toBeUndefined();
	});

	it("delivers EWharf callbacks with the source-compatible HMAC-SHA256 body and ok acknowledgement", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-ewharf",
				eventId: "event-ewharf",
				attempt: 1,
				url: "https://merchant.example/notify",
				secret: "merchant-secret",
				protocol: "ewharf",
				payload: { ignored: true },
				ewharf: {
					pid: "gmp_merchant",
					trade_id: "trade-1",
					order_id: "ORDER-1001",
					amount: "12.5",
					actual_amount: "1.75",
					receive_address: "TMerchantAddress",
					token: "USDT",
					block_transaction_id: "transaction-1",
					status: 2,
				},
			},
			fetcher,
		);
		expect(result.success).toBe(true);
		const [, init] = fetcher.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as Record<
			string,
			string | number
		>;
		const signature = String(body.signature);
		expect(signature).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyEwharfSignature(body, "merchant-secret", signature)).toBe(
			true,
		);
		expect(body).toMatchObject({
			pid: "gmp_merchant",
			trade_id: "trade-1",
			order_id: "ORDER-1001",
			status: 2,
		});
		expect(Object.keys(body).sort()).toEqual(
			[
				"pid",
				"trade_id",
				"order_id",
				"amount",
				"actual_amount",
				"receive_address",
				"token",
				"block_transaction_id",
				"status",
				"signature",
			].sort(),
		);
		expect(JSON.stringify(body)).not.toMatch(
			/externalOrderId|external_order_id/,
		);
		expect(result.requestSnapshot).toMatchObject({
			method: "POST",
			body: { signature: "[REDACTED]", token: "USDT" },
		});
		expect(JSON.stringify(result.requestSnapshot)).not.toContain(signature);
	});

	it("retries a EWharf callback unless the merchant returns plain text ok", async () => {
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-ewharf",
				eventId: "event-ewharf",
				attempt: 1,
				url: "https://merchant.example/notify",
				secret: "merchant-secret",
				protocol: "ewharf",
				payload: {},
				ewharf: {
					pid: "gmp_merchant",
					trade_id: "trade-1",
					order_id: "ORDER-1001",
					amount: "12.5",
					actual_amount: "1.75",
					receive_address: "TMerchantAddress",
					token: "USDT",
					block_transaction_id: "transaction-1",
					status: 2,
				},
			},
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response('{"accepted":true}', { status: 200 })),
		);
		expect(result).toMatchObject({
			success: false,
			errorCode: "invalid_acknowledgement",
		});
	});

	it("retains the redacted request snapshot for timeout and network failures", async () => {
		for (const error of [
			new DOMException("timed out", "TimeoutError"),
			new TypeError("network unavailable"),
		]) {
			const result = await deliverWebhook(
				{
					deliveryId: "delivery-failure",
					eventId: "event-failure",
					url: "https://merchant.example/notify",
					secret: "merchant-secret",
					payload: { status: "paid" },
					attempt: 1,
					protocol: "ewharf",
					ewharf: ewharfCallback,
				},
				vi.fn<typeof fetch>().mockRejectedValue(error),
			);
			expect(result.errorCode).toBe(
				error.name === "TimeoutError" ? "timeout" : "network_error",
			);
			expect(result.requestSnapshot).toMatchObject({
				method: "POST",
				body: { signature: "[REDACTED]" },
			});
		}
	});

	it("bounds response capture without buffering the full body", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("x".repeat(4_096)));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 500 },
		);
		const result = await deliverWebhook(
			{
				deliveryId: "d",
				eventId: "e",
				url: "https://example.com/hook",
				secret: "s",
				payload: {},
				attempt: 1,
				protocol: "ewharf",
				ewharf: ewharfCallback,
			},
			vi.fn<typeof fetch>().mockResolvedValue(response),
		);
		expect(result.responseExcerpt).toHaveLength(512);
		expect(cancelled).toBe(true);
	});
});

const ewharfCallback = {
	pid: "100000000001",
	trade_id: "trade-1",
	order_id: "ORDER-1",
	amount: "1.00",
	actual_amount: "1.00",
	receive_address: "TMerchantAddress",
	token: "USDT",
	block_transaction_id: "transaction-1",
	status: 2 as const,
};
