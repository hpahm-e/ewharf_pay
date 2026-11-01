import { createFileRoute } from "@tanstack/react-router";
import { handleSepayNotification } from "#/features/payments/server/sepay-notification";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/providers/sepay/notify")({
	server: {
		handlers: {
			POST: ({ request }) => handleSepayNotification(request, getEnv()),
		},
	},
});
