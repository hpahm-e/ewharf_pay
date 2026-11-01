import { createFileRoute } from "@tanstack/react-router";
import { handleEwharfQueryRequest } from "#/features/orders/server/ewharf-api";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/payments/ewharf/v1/order/query")({
	server: {
		handlers: {
			GET: ({ request }) => handleEwharfQueryRequest(request, getEnv()),
		},
	},
});
