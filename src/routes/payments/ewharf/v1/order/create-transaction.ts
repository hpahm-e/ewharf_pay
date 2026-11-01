import { createFileRoute } from "@tanstack/react-router";
import { handleEwharfCreateRequest } from "#/features/orders/server/ewharf-api";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/payments/ewharf/v1/order/create-transaction",
)({
	server: {
		handlers: {
			POST: ({ request }) => handleEwharfCreateRequest(request, getEnv()),
		},
	},
});
