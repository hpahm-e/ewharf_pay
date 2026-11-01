import { z } from "zod";
import type { EwharfStatus } from "#/features/orders/ewharf-status";
import type { OrderStatus } from "#/features/orders/schema";

export type WebhookJsonValue =
	| string
	| number
	| boolean
	| null
	| WebhookJsonValue[]
	| { [key: string]: WebhookJsonValue };

export type WebhookJsonObject = Record<string, WebhookJsonValue>;

export const webhookJsonValueSchema: z.ZodType<WebhookJsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(webhookJsonValueSchema),
		z.record(z.string(), webhookJsonValueSchema),
	]),
);

export const webhookJsonObjectSchema: z.ZodType<WebhookJsonObject> = z.record(
	z.string(),
	webhookJsonValueSchema,
);

const webhookRequestHeadersSchema = z.record(z.string(), z.string());
const webhookRequestQuerySchema = z.record(z.string(), z.string());

export const webhookRequestSnapshotSchema = z.discriminatedUnion("method", [
	z.object({
		method: z.literal("POST"),
		url: z.url(),
		headers: webhookRequestHeadersSchema,
		body: webhookJsonObjectSchema,
		query: z.null(),
	}),
	z.object({
		method: z.literal("GET"),
		url: z.url(),
		headers: webhookRequestHeadersSchema,
		body: z.null(),
		query: webhookRequestQuerySchema,
	}),
]);

export type WebhookRequestSnapshot = z.infer<
	typeof webhookRequestSnapshotSchema
>;

export interface WebhookQueueMessage {
	kind: "webhook.delivery";
	version: 1;
	deliveryId: string;
	eventId: string;
	attempt: number;
}

export type WebhookDeliveryRequest = {
	deliveryId: string;
	eventId: string;
	attempt: number;
	url: string;
	secret: string;
	payload: WebhookJsonObject;
	protocol: "ewharf";
	ewharf: EwharfCallbackData;
};

interface EwharfCallbackData extends Record<string, string | EwharfStatus> {
	pid: string;
	trade_id: string;
	order_id: string;
	amount: string;
	actual_amount: string;
	receive_address: string;
	token: string;
	block_transaction_id: string;
	status: Exclude<EwharfStatus, 4>;
}

export const webhookEventTypes = [
	"*",
	"order.pending",
	"order.confirming",
	"order.paid",
	"order.partially_paid",
	"order.overpaid",
	"order.expired",
	"order.cancelled",
	"order.failed",
	"order.refunded",
	"payment.late_detected",
	"payment.late_rejected",
] as const;

type OrderWebhookEventType = `order.${OrderStatus}`;

export interface OrderWebhookPayload extends Record<string, unknown> {
	event: OrderWebhookEventType;
	eventId: string;
	createdAt: string;
	instance: {
		name: "EWharf";
		url: string;
	};
	orderId: string;
	externalOrderId: string;
	status: OrderStatus;
	amount: string;
	currency: string;
	payment: {
		amount: string | null;
		asset: string | null;
		network: string | null;
		receivedAmountUnits: string;
	};
	transaction: null | {
		id: string;
		hash: string;
		amountUnits: string;
		confirmations: number;
	};
}
