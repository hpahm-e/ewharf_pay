import { assertTransition } from "#/features/orders/state-machine";
import { generateTransferCode } from "#/integrations/wallets/sepay";

/**
 * Assigns the transfer code the payer writes in the bank transfer content. The
 * code is the order's SePay reference and resolves the webhook to this order.
 */
export async function initializeSepayOrder(db: D1Database, orderId: string) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await db
				.prepare(
					"UPDATE orders SET provider_order_id = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND provider_order_id IS NULL",
				)
				.bind(generateTransferCode(), Date.now(), orderId)
				.run();
			return;
		} catch (error) {
			// The unique provider-order index rejects a colliding code; retry once
			// more with a fresh random code before failing the order.
			if (attempt < 2) continue;
			await failOrder(db, orderId);
			throw error;
		}
	}
}

async function failOrder(db: D1Database, orderId: string) {
	const now = Date.now();
	assertTransition("pending", "failed", "processing_failed");
	await db.batch([
		db
			.prepare(
				"UPDATE orders SET status = 'failed', version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
			)
			.bind(now, orderId),
		db
			.prepare(
				"UPDATE receiving_method_locks SET released_at = ? WHERE order_id = ? AND released_at IS NULL",
			)
			.bind(now, orderId),
	]);
}
