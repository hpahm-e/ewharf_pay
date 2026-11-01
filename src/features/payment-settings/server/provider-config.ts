import { z } from "zod";
import { paymentSettingsError } from "#/features/payment-settings/errors";

const binanceConfiguration = z.object({
	receiverUid: z
		.string()
		.trim()
		.regex(/^[1-9]\d*$/)
		.max(100),
	apiKey: z.string().trim().min(1).max(512),
	secretKey: z.string().trim().min(1).max(512),
});

const okxConfiguration = z.object({
	accountUid: z
		.string()
		.trim()
		.regex(/^[1-9]\d*$/)
		.max(100),
	apiKey: z.string().trim().min(1).max(512),
	secretKey: z.string().trim().min(1).max(512),
	passphrase: z.string().trim().min(1).max(512),
});

const optionalSecret = z
	.string()
	.trim()
	.max(512)
	.transform((value) => value || undefined);

const sepayConfiguration = z
	.object({
		accountNumber: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9]{4,32}$/),
		bankName: z.string().trim().min(2).max(60),
		accountName: z.string().trim().max(120),
		apiToken: z.string().trim().min(1).max(512),
		webhookApiKey: optionalSecret,
		webhookSecret: optionalSecret,
	})
	.refine((value) => value.webhookApiKey || value.webhookSecret);

export function parseReceivingProviderConfiguration(
	railCode: string,
	configuration: Record<string, string>,
) {
	if (railCode === "binance") {
		const parsed = parseConfiguration(binanceConfiguration, configuration);
		return {
			targetType: "account" as const,
			targetField: "receiverUid",
			targetValue: parsed.receiverUid,
			credentials: { apiKey: parsed.apiKey, secretKey: parsed.secretKey },
		};
	}
	if (railCode === "okx") {
		const parsed = parseConfiguration(okxConfiguration, configuration);
		return {
			targetType: "account" as const,
			targetField: "accountUid",
			targetValue: parsed.accountUid,
			credentials: {
				apiKey: parsed.apiKey,
				secretKey: parsed.secretKey,
				passphrase: parsed.passphrase,
			},
		};
	}
	if (railCode === "sepay") {
		const parsed = parseConfiguration(sepayConfiguration, configuration);
		return {
			targetType: "account" as const,
			targetField: "accountNumber",
			targetValue: parsed.accountNumber,
			credentials: {
				apiToken: parsed.apiToken,
				...(parsed.webhookApiKey
					? { webhookApiKey: parsed.webhookApiKey }
					: {}),
				...(parsed.webhookSecret
					? { webhookSecret: parsed.webhookSecret }
					: {}),
			},
			// Public display details for the checkout; never credentials.
			metadata: {
				bankName: parsed.bankName,
				...(parsed.accountName ? { accountName: parsed.accountName } : {}),
			},
		};
	}
	throw paymentSettingsError("receiving_method_configuration_required");
}

function parseConfiguration<T>(
	schema: z.ZodType<T>,
	configuration: Record<string, string>,
) {
	const result = schema.safeParse(configuration);
	if (!result.success)
		throw paymentSettingsError("receiving_method_configuration_required");
	return result.data;
}
