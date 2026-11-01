import { describe, expect, it } from "vitest";
import { safeCheckoutReturnUrl } from "#/features/checkout/checkout-model";

describe("checkout return URLs", () => {
	it("accepts only credential-free HTTPS URLs", () => {
		expect(safeCheckoutReturnUrl("https://merchant.example/paid?order=1")).toBe(
			"https://merchant.example/paid?order=1",
		);
		expect(safeCheckoutReturnUrl("http://merchant.example/paid")).toBeNull();
		expect(safeCheckoutReturnUrl("javascript:alert(1)")).toBeNull();
		expect(
			safeCheckoutReturnUrl("https://user:secret@merchant.example/paid"),
		).toBeNull();
		expect(safeCheckoutReturnUrl("not a URL")).toBeNull();
	});
});
