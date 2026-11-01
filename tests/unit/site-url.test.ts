import { describe, expect, it } from "vitest";
import { absoluteSiteUrl, resolveSiteUrl } from "#/lib/site-url";

describe("site URL", () => {
	it("prefers the configured Application URL origin", () => {
		expect(
			resolveSiteUrl("https://pay.example.com/admin", "https://other.test/x"),
		).toBe("https://pay.example.com");
	});

	it("falls back to the request origin while the default URL is unchanged", () => {
		expect(
			resolveSiteUrl("http://localhost:3000", "https://my.workers.dev/p?a=1"),
		).toBe("https://my.workers.dev");
		expect(resolveSiteUrl(undefined, "https://my.workers.dev/p")).toBe(
			"https://my.workers.dev",
		);
	});

	it("never invents a domain", () => {
		expect(resolveSiteUrl(undefined, undefined)).toBe("");
		expect(absoluteSiteUrl("/sign-in", "https://pay.example.com")).toBe(
			"https://pay.example.com/sign-in",
		);
		expect(absoluteSiteUrl("https://a.test/x")).toBe("https://a.test/x");
	});
});
