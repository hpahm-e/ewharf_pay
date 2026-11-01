import { describe, expect, it } from "vitest";
import { OrderServiceError } from "#/features/orders/server/create";
import {
	ewharfCreateResponse,
	ewharfOrderMessage,
	parseEwharfCreateInput,
	parseEwharfRequestBody,
	toCreateOrderInput,
} from "#/features/orders/server/ewharf-api";

describe("EWharf create transaction input", () => {
	const valid = {
		pid: "gmp_merchant",
		order_id: "ORDER-1001",
		currency: "cny",
		token: "usdt",
		network: "tron",
		amount: "12.50",
		notify_url: "https://merchant.example/notify",
		redirect_url: "https://merchant.example/return",
		name: "Invoice 1001",
		signature: "a".repeat(64),
	};

	it("accepts equivalent JSON and form payloads", () => {
		const json = parseEwharfCreateInput(
			parseEwharfRequestBody("application/json", JSON.stringify(valid)),
		);
		const form = parseEwharfCreateInput(
			parseEwharfRequestBody(
				"application/x-www-form-urlencoded; charset=UTF-8",
				new URLSearchParams(valid).toString(),
			),
		);
		expect(json.success).toBe(true);
		expect(form.success).toBe(true);
		if (!(json.success && form.success)) return;
		expect(toCreateOrderInput(json.data)).toEqual(
			toCreateOrderInput(form.data),
		);
		expect(toCreateOrderInput(json.data)).toMatchObject({
			externalOrderId: "ORDER-1001",
			amount: "12.50",
			currency: "CNY",
			paymentAsset: "USDT",
			paymentNetwork: "tron",
			metadata: { integration: "ewharf" },
		});
	});

	it("falls back to the default currency only when the request omits one", () => {
		const omitted = parseEwharfCreateInput({ ...valid, currency: undefined });
		expect(omitted.success).toBe(true);
		if (!omitted.success) return;
		expect(toCreateOrderInput(omitted.data)).toMatchObject({ currency: "USD" });
		expect(toCreateOrderInput(omitted.data, "VND")).toMatchObject({
			currency: "VND",
		});
		const explicit = parseEwharfCreateInput(valid);
		if (explicit.success)
			expect(toCreateOrderInput(explicit.data, "VND")).toMatchObject({
				currency: "CNY",
			});
		expect(parseEwharfCreateInput({ ...valid, currency: "US" }).success).toBe(
			false,
		);
	});

	it("supports a selectable order only when token and network are both omitted", () => {
		const selectable = parseEwharfCreateInput({
			...valid,
			token: undefined,
			network: undefined,
		});
		expect(selectable.success).toBe(true);
		if (selectable.success)
			expect(toCreateOrderInput(selectable.data)).toMatchObject({
				paymentAsset: undefined,
				paymentNetwork: undefined,
			});
		expect(() => toCreateOrderInput({ ...valid, network: undefined })).toThrow(
			"Payment asset and network must be provided together",
		);
	});

	it("normalizes numeric JSON amounts before minor-unit conversion", () => {
		const parsed = parseEwharfCreateInput({ ...valid, amount: 1.25 });
		expect(parsed).toMatchObject({ success: true });
		if (parsed.success) expect(parsed.data.amount).toBe("1.25");
	});

	it("returns a legacy integer status with the detailed internal status", () => {
		const response = ewharfCreateResponse(
			{
				orderId: "11111111-1111-4111-8111-111111111111",
				externalOrderId: "ORDER-1003",
				status: "pending",
				amount: "12.50",
				currency: "CNY",
				checkoutUrl: "https://pay.example/checkout/order",
				expiresAt: "2026-07-13T00:00:00.000Z",
			},
			"request-1",
		);
		expect(response.data).toMatchObject({
			trade_id: "11111111-1111-4111-8111-111111111111",
			order_id: "ORDER-1003",
			status: 4,
			status_detail: "pending",
			token: "",
			actual_amount: "0",
		});
		expect(Object.keys(response.data).sort()).toEqual(
			[
				"trade_id",
				"order_id",
				"amount",
				"currency",
				"actual_amount",
				"receive_address",
				"token",
				"network",
				"status",
				"status_detail",
				"expiration_time",
				"payment_url",
			].sort(),
		);
		expect(JSON.stringify(response)).not.toMatch(
			/externalOrderId|external_order_id/,
		);
	});

	it("maps domain failures to stable public messages", () => {
		expect(
			ewharfOrderMessage(
				new OrderServiceError(
					"receiving_method_not_ready",
					"RPC secret abc123 is invalid at internal.example",
					422,
				),
			),
		).toBe("No receiving method is currently available");
		expect(
			ewharfOrderMessage(
				new OrderServiceError("future_internal_code", "D1_ERROR: secret", 500),
			),
		).toBe("Order request failed");
	});
});
