import { describe, expect, it } from "vitest";
import { OrderServiceError } from "#/features/orders/server/create";
import { ewharfOrderError } from "#/features/orders/server/ewharf-api";

describe("EWharf order error mapping", () => {
	it.each([
		["external_order_exists", 10002],
		["receiving_method_not_found", 10003],
		["receiving_method_not_ready", 10003],
		["receiving_method_required", 10003],
		["payment_target_unavailable", 10003],
		["provider_configuration_missing", 10003],
		["provider_unavailable", 10003],
		["invalid_amount", 10004],
		["expiry_exceeds_limit", 10009],
		["payment_asset_required", 10016],
		["payment_asset_unavailable", 10016],
		["exchange_rate_unavailable", 10016],
		["order_not_found", 10001],
	] as const)("maps %s to the stable merchant code %i", (code, expected) => {
		expect(ewharfOrderError(new OrderServiceError(code, "internal", 422))).toBe(
			expected,
		);
	});

	it("fails closed to a generic business code for an unknown domain error", () => {
		expect(
			ewharfOrderError(new OrderServiceError("future_error", "internal", 422)),
		).toBe(400);
	});
});
