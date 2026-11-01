import { describe, expect, it } from "vitest";
import { toEwharfStatus } from "#/features/orders/ewharf-status";

describe("EWharf status compatibility", () => {
	it("maps detailed order states to the documented integer status", () => {
		expect(toEwharfStatus("pending", false)).toBe(4);
		expect(toEwharfStatus("pending", true)).toBe(1);
		expect(toEwharfStatus("confirming")).toBe(1);
		expect(toEwharfStatus("partially_paid")).toBe(1);
		expect(toEwharfStatus("paid")).toBe(2);
		expect(toEwharfStatus("overpaid")).toBe(2);
		expect(toEwharfStatus("expired")).toBe(3);
		expect(toEwharfStatus("cancelled")).toBe(3);
		expect(toEwharfStatus("failed")).toBe(3);
		expect(toEwharfStatus("refunded")).toBe(3);
	});
});
