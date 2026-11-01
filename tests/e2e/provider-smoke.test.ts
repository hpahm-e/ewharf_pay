import { describe, expect, it } from "vitest";
import { BinancePayAdapter } from "#/integrations/exchanges/binance";
import { OkxPayAdapter } from "#/integrations/exchanges/okx";
import { SepayAdapter } from "#/integrations/wallets/sepay";

const binanceEnabled = hasEnvironment(
	"BINANCE_SMOKE_API_KEY",
	"BINANCE_SMOKE_SECRET_KEY",
	"BINANCE_SMOKE_UID",
);
const okxEnabled = hasEnvironment(
	"OKX_SMOKE_API_KEY",
	"OKX_SMOKE_SECRET_KEY",
	"OKX_SMOKE_PASSPHRASE",
	"OKX_SMOKE_UID",
);
const sepayEnabled = hasEnvironment(
	"SEPAY_SMOKE_ACCOUNT_NUMBER",
	"SEPAY_SMOKE_API_TOKEN",
);
const alchemyEnabled = hasEnvironment(
	"ALCHEMY_SMOKE_AUTH_TOKEN",
	"ALCHEMY_SMOKE_WEBHOOK_ID",
);

describe.skip("read-only payment provider smoke", () => {
	it.skipIf(!binanceEnabled)(
		"authenticates and reads Binance Pay history",
		async () => {
			const adapter = new BinancePayAdapter({
				apiKey: environment("BINANCE_SMOKE_API_KEY"),
				secretKey: environment("BINANCE_SMOKE_SECRET_KEY"),
				apiUrl: process.env.BINANCE_SMOKE_API_URL,
			});
			await expect(adapter.healthCheck()).resolves.toMatchObject({
				healthy: true,
			});
			await expect(
				adapter.findTransactions({
					address: environment("BINANCE_SMOKE_UID"),
					assetCode: process.env.BINANCE_SMOKE_ASSET ?? "USDT",
				}),
			).resolves.toBeInstanceOf(Array);
		},
	);

	it.skipIf(!okxEnabled)(
		"authenticates and reads OKX funding bills",
		async () => {
			const accountId = environment("OKX_SMOKE_UID");
			const adapter = new OkxPayAdapter({
				apiKey: environment("OKX_SMOKE_API_KEY"),
				secretKey: environment("OKX_SMOKE_SECRET_KEY"),
				passphrase: environment("OKX_SMOKE_PASSPHRASE"),
				accountId,
				apiUrl: process.env.OKX_SMOKE_API_URL,
				simulatedTrading: process.env.OKX_SMOKE_SIMULATED === "1",
			});
			await expect(adapter.healthCheck()).resolves.toMatchObject({
				healthy: true,
			});
			await expect(
				adapter.findTransactions({
					address: accountId,
					assetCode: process.env.OKX_SMOKE_ASSET ?? "USDT",
				}),
			).resolves.toBeInstanceOf(Array);
		},
	);

	it.skipIf(!sepayEnabled)(
		"authenticates with the SePay transactions API",
		async () => {
			const adapter = new SepayAdapter({
				accountNumber: environment("SEPAY_SMOKE_ACCOUNT_NUMBER"),
				apiToken: environment("SEPAY_SMOKE_API_TOKEN"),
				webhookApiKey: "smoke-not-used",
				apiUrl: process.env.SEPAY_SMOKE_API_URL,
			});
			await expect(adapter.healthCheck()).resolves.toMatchObject({
				healthy: true,
			});
			const transactionId = process.env.SEPAY_SMOKE_TRANSACTION_ID;
			if (transactionId)
				await expect(
					adapter.getTransaction(transactionId),
				).resolves.toBeDefined();
		},
	);

	it.skipIf(!alchemyEnabled)(
		"authenticates and reads Alchemy webhook addresses without mutation",
		async () => {
			const url = new URL(
				"https://dashboard.alchemy.com/api/webhook-addresses",
			);
			url.searchParams.set(
				"webhook_id",
				environment("ALCHEMY_SMOKE_WEBHOOK_ID"),
			);
			url.searchParams.set("limit", "1");
			const response = await fetch(url, {
				headers: {
					"x-alchemy-token": environment("ALCHEMY_SMOKE_AUTH_TOKEN"),
				},
			});
			expect(response.ok).toBe(true);
			const payload: unknown = await response.json();
			expect(payload).toEqual(
				expect.objectContaining({ data: expect.any(Array) }),
			);
		},
	);
});

function hasEnvironment(...names: string[]) {
	return names.every((name) => Boolean(process.env[name]));
}

function environment(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
