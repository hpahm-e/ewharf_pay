import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	AmbiguousSignatureParametersError,
	ewharfSignaturePayload,
	signEwharfParameters,
	verifyEwharfSignature,
} from "#/features/api-keys/server/ewharf-signature";

describe("EWharf HMAC-SHA256 parameter signatures", () => {
	it("matches the EWharf sorted non-empty parameter algorithm", () => {
		const parameters = {
			pid: "gmp_merchant",
			order_id: "ORDER-1001",
			currency: "cny",
			token: "usdt",
			network: "tron",
			amount: 100,
			notify_url: "https://merchant.example/notify",
			redirect_url: "",
			name: null,
			signature: "must-not-participate",
		};
		expect(ewharfSignaturePayload(parameters)).toBe(
			"amount=100&currency=cny&network=tron&notify_url=https://merchant.example/notify&order_id=ORDER-1001&pid=gmp_merchant&token=usdt",
		);
		expect(signEwharfParameters(parameters, "merchant-secret")).toBe(
			"c6e53cbcc50ed62160c4e9689bb5d266376baa2b15a2c054db88350f2f20f4b3",
		);
	});

	it("verifies exact lowercase signatures and includes optional fields", () => {
		const parameters = {
			pid: "gmp_merchant",
			order_id: "ORDER-1002",
			amount: "12.50",
			payment_type: "Ewharf",
		};
		const signature = signEwharfParameters(parameters, "merchant-secret");
		expect(
			verifyEwharfSignature(
				{ ...parameters, signature },
				"merchant-secret",
				signature,
			),
		).toBe(true);
		expect(
			verifyEwharfSignature(
				{ ...parameters, payment_type: "other", signature },
				"merchant-secret",
				signature,
			),
		).toBe(false);
	});

	it("rejects both interpretations of the callback-destination collision", () => {
		const original = {
			pid: "1000",
			amount: "12.50",
			order_id: "SECURITY-1",
			name: "item&notify_url=https://receiver.example/hook",
			notify_url: "https://merchant.example/hook",
		};
		const altered = {
			...original,
			name: "item",
			notify_url:
				"https://receiver.example/hook&notify_url=https://merchant.example/hook",
		};
		const canonical = (parameters: object) =>
			Object.entries(parameters)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => `${key}=${value}`)
				.join("&");
		expect(canonical(original)).toBe(canonical(altered));
		const ewharf = createHmac("sha256", "secret")
			.update(canonical(original))
			.digest("hex");
		for (const parameters of [original, altered]) {
			expect(verifyEwharfSignature(parameters, "secret", ewharf)).toBe(false);
			expect(() => signEwharfParameters(parameters, "secret")).toThrow(
				AmbiguousSignatureParametersError,
			);
		}
	});

	it("allows literal ampersands and equals without field boundaries, but rejects injected keys", () => {
		const parameters = {
			name: "Tea & Coffee = good",
			notify_url: "https://merchant.example/hook?source=shop",
		};
		const signature = signEwharfParameters(parameters, "secret");
		expect(verifyEwharfSignature(parameters, "secret", signature)).toBe(true);
		expect(
			verifyEwharfSignature({ "a=b&c": "value" }, "secret", signature),
		).toBe(false);
	});
});
