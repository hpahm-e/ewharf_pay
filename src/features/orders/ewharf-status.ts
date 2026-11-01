import type { OrderStatus } from "#/features/orders/schema";

export type EwharfStatus = 1 | 2 | 3 | 4;

export function toEwharfStatus(status: OrderStatus): Exclude<EwharfStatus, 4>;
export function toEwharfStatus(
	status: OrderStatus,
	hasPaymentTarget: boolean,
): EwharfStatus;
export function toEwharfStatus(
	status: OrderStatus,
	hasPaymentTarget = true,
): EwharfStatus {
	if (status === "pending" && !hasPaymentTarget) return 4;
	if (status === "paid" || status === "overpaid") return 2;
	if (
		status === "expired" ||
		status === "cancelled" ||
		status === "failed" ||
		status === "refunded"
	)
		return 3;
	return 1;
}
