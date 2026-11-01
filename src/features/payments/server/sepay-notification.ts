import { z } from "zod";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import { recordInboundWebhookReceipt } from "#/features/webhooks/server/inbound-receipts";
import {
	extractTransferCode,
	SepayAdapter,
	sepayAssetCode,
} from "#/integrations/wallets/sepay";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";
import { loadRuntimeConfig } from "#/server/runtime-config";

const maximumBodyBytes = 64 * 1024;
const lookbackMs = 10 * 60_000;
const notificationSchema = z.looseObject({
	id: z.number().int().positive(),
	accountNumber: z.string().min(1),
	transferType: z.enum(["in", "out"]),
	transferAmount: z.number().int().positive(),
	transactionDate: z.string().min(1),
	code: z.string().nullish(),
	content: z.string().nullish(),
	referenceCode: z.string().nullish(),
});

/**
 * SePay posts every bank movement of the connected account. Only transfers that
 * resolve to an EWharf order are accounted for, and each is re-read from the
 * authenticated SePay API so the webhook body is never the money source.
 */
export async function handleSepayNotification(request: Request, env: Env) {
	const startedAt = Date.now();
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid" | "not_applicable" | "unknown",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "sepay.notify",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	let bytes: Uint8Array;
	try {
		bytes = await readLimitedRequestBytes(request, maximumBodyBytes);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError)
			return finish(
				errorResponse(request, "payload_too_large", 413),
				"unknown",
				"payload_too_large",
			);
		throw error;
	}
	const notification = parseNotification(bytes);
	if (!notification)
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	const method = await env.DB.prepare(
		`SELECT target_value, config_encrypted FROM receiving_methods
		 WHERE rail_code = 'sepay' AND normalized_target_value = ? LIMIT 1`,
	)
		.bind(notification.accountNumber)
		.first<{ target_value: string; config_encrypted: string | null }>();
	if (!method?.config_encrypted)
		return finish(
			errorResponse(request, "account_not_found", 404),
			"unknown",
			"account_not_found",
		);
	const runtime = await loadRuntimeConfig(env.DB);
	const adapter = new SepayAdapter({
		...(JSON.parse(
			await decryptSecret(
				method.config_encrypted,
				runtime.integrationConfigSecret,
			),
		) as Record<string, unknown>),
		accountNumber: method.target_value,
	});
	if (!adapter.verifyWebhook(request.headers, bytes))
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"invalid",
			"invalid_signature",
		);
	const acknowledge = (errorCode?: string) =>
		finish(withRequestId(request, json({ success: true })), "valid", errorCode);
	if (notification.transferType !== "in") return acknowledge();

	const code = extractTransferCode(notification.code, notification.content);
	const transferTime = Date.parse(
		`${notification.transactionDate.replace(" ", "T")}+07:00`,
	);
	const orderId = await resolveOrder(env.DB, notification, code, transferTime);
	// Bank accounts also receive unrelated transfers; acknowledge them so SePay
	// does not retry a movement that no order owns.
	if (!orderId) return acknowledge("no_matching_order");

	let transfers: Awaited<ReturnType<SepayAdapter["searchIncoming"]>>;
	try {
		transfers = await adapter.searchIncoming({
			accountNumber: method.target_value,
			sinceMs:
				(Number.isNaN(transferTime) ? Date.now() : transferTime) - lookbackMs,
			amountVnd: BigInt(notification.transferAmount),
			...(code || notification.referenceCode
				? { query: code ?? notification.referenceCode ?? "" }
				: {}),
		});
	} catch {
		return finish(
			errorResponse(request, "provider_unavailable", 503),
			"valid",
			"provider_unavailable",
		);
	}
	const candidates = transfers.filter(
		(transfer) =>
			transfer.transaction.amountUnits ===
				BigInt(notification.transferAmount) &&
			(notification.referenceCode
				? transfer.referenceNumber === notification.referenceCode
				: transfer.content.trim() === (notification.content ?? "").trim()),
	);
	if (!candidates.length)
		return finish(
			errorResponse(request, "payment_pending", 409),
			"valid",
			"payment_pending",
		);
	for (const candidate of candidates) {
		const recorded = await env.DB.prepare(
			"SELECT 1 AS found FROM order_payments WHERE transaction_id = ? LIMIT 1",
		)
			.bind(paymentTransactionId(candidate.transaction))
			.first();
		if (recorded) continue;
		await recordPaymentTransaction(
			env,
			orderId,
			candidate.transaction,
			runtime,
		);
		return acknowledge();
	}
	return acknowledge("duplicate");
}

async function resolveOrder(
	db: D1Database,
	notification: z.infer<typeof notificationSchema>,
	code: string | null,
	transferTime: number,
) {
	if (code) {
		const byCode = await db
			.prepare(
				`SELECT o.id FROM orders o
				 JOIN order_payment_snapshots ops ON ops.order_id = o.id
				 WHERE o.provider_order_id = ? AND ops.rail_code = 'sepay'
				 AND ops.target_value = ? LIMIT 1`,
			)
			.bind(code, notification.accountNumber)
			.first<{ id: string }>();
		if (byCode) return byCode.id;
	}
	// Without a usable transfer code, fall back to the unique expected amount.
	try {
		const attribution = await resolvePaymentTransactionOrder(db, {
			network: "sepay",
			hash: `webhook:${notification.id}`,
			eventIndex: 0,
			from: "bank",
			to: notification.accountNumber,
			assetCode: sepayAssetCode,
			amountUnits: BigInt(notification.transferAmount),
			blockNumber: 0n,
			blockHash: "",
			confirmations: 1,
			timestamp: new Date(
				Number.isNaN(transferTime) ? Date.now() : transferTime,
			),
			success: true,
			canonical: true,
		});
		return attribution.orderId;
	} catch (error) {
		if (
			error instanceof PaymentAttributionAmbiguousError ||
			error instanceof PaymentAttributionNotFoundError
		)
			return null;
		throw error;
	}
}

function parseNotification(bytes: Uint8Array) {
	try {
		const parsed = notificationSchema.safeParse(
			JSON.parse(new TextDecoder().decode(bytes)),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function errorResponse(request: Request, error: string, status: number) {
	return withRequestId(request, json({ error }, { status }));
}
