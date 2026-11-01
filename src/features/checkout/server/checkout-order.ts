import { z } from "zod";
import type { CheckoutOrder } from "#/features/checkout/checkout-model";
import { toEwharfStatus } from "#/features/orders/ewharf-status";
import type { OrderStatus } from "#/features/orders/schema";
import { unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";

export async function getCheckoutOrderWithDatabase(
	db: D1Database,
	orderId: string,
): Promise<CheckoutOrder | null> {
	const row = await db
		.prepare(
			`SELECT o.id, o.external_order_id, o.status, o.amount_minor, o.currency,
			 o.currency_decimals, o.provider_order_id, o.received_amount_units, o.return_url, o.expires_at,
			 ops.expected_amount_units,
			 COALESCE(ops.asset_code, a.code) AS code,
			 COALESCE(ops.decimals, a.decimals) AS decimals,
			 COALESCE(ops.rail_code, a.rail_code) AS network,
			 ops.target_value AS address, rm.target_metadata,
			 COALESCE(MAX(op.confirmations), 0) AS confirmations,
			 COALESCE(ops.required_confirmations, 1) AS required_confirmations,
			 (SELECT pr.status FROM payment_reviews pr WHERE pr.order_id = o.id
			  ORDER BY pr.created_at DESC LIMIT 1) AS review_status
			 FROM orders o
			 LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 LEFT JOIN receiving_methods rm ON rm.id = ops.receiving_method_id
			 LEFT JOIN order_payments op ON op.order_id = o.id
			 WHERE o.id = ?
			 GROUP BY o.id, a.id, ops.order_id
			 LIMIT 1`,
		)
		.bind(orderId)
		.first<{
			id: string;
			external_order_id: string;
			status: OrderStatus;
			amount_minor: string;
			currency: string;
			currency_decimals: number;
			expected_amount_units: string | null;
			provider_order_id: string | null;
			target_metadata: string | null;
			received_amount_units: string;
			return_url: string | null;
			expires_at: number;
			code: string | null;
			decimals: number | null;
			network: string | null;
			address: string | null;
			confirmations: number;
			required_confirmations: number;
			review_status: "pending" | "approved" | "rejected" | null;
		}>();

	if (!row) return null;
	const actualAmount =
		row.expected_amount_units !== null && row.decimals !== null
			? unitsToDecimal(BigInt(row.expected_amount_units), row.decimals)
			: undefined;
	return {
		trade_id: row.id,
		external_order_id: row.external_order_id,
		amount: minorToDecimal(row.amount_minor, row.currency_decimals),
		...(actualAmount ? { actual_amount: actualAmount } : {}),
		currency: row.currency,
		...(row.code ? { token: row.code } : {}),
		...(row.network ? { network: row.network } : {}),
		...(row.address ? { receive_address: row.address } : {}),
		...(row.network === "sepay" && row.provider_order_id
			? bankDetails(row.target_metadata, row.provider_order_id)
			: {}),
		expiration_time: new Date(row.expires_at).toISOString(),
		...(row.return_url ? { redirect_url: row.return_url } : {}),
		status: toEwharfStatus(row.status, Boolean(row.code && row.network)),
		status_detail: row.status,
		received_amount_units: row.received_amount_units,
		received_amount: unitsToDecimal(
			BigInt(row.received_amount_units),
			row.decimals ?? 0,
		),
		confirmations: row.confirmations,
		required_confirmations: row.required_confirmations,
		...(row.review_status ? { review_status: row.review_status } : {}),
	};
}

const bankMetadataSchema = z.object({
	bankName: z.string().min(1),
	accountName: z.string().optional(),
});

function bankDetails(metadata: string | null, transferContent: string) {
	try {
		const parsed = bankMetadataSchema.safeParse(JSON.parse(metadata ?? "null"));
		if (!parsed.success) return {};
		return {
			bank: {
				name: parsed.data.bankName,
				...(parsed.data.accountName
					? { account_name: parsed.data.accountName }
					: {}),
				transfer_content: transferContent,
			},
		};
	} catch {
		return {};
	}
}
