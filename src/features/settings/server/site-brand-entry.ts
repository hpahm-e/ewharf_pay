import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { loadSiteBrandOrDefault } from "#/features/settings/server/site-brand";
import { resolveSiteUrl } from "#/lib/site-url";
import { getCloudflareEnv } from "#/server/db.server";
import { loadRuntimeConfig } from "#/server/runtime-config";

export const getSiteBrandFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const env = getCloudflareEnv(request);
		const [brand, runtime] = await Promise.all([
			loadSiteBrandOrDefault(env.DB, env.CACHE),
			(env.DB ? loadRuntimeConfig(env.DB) : Promise.resolve(null)).catch(
				() => null,
			),
		]);
		return {
			...brand,
			siteUrl: resolveSiteUrl(runtime?.betterAuthUrl, request.url),
		};
	},
);
