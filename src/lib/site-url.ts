const unconfiguredApplicationUrl = "http://localhost:3000";

/**
 * Resolve the public origin of this deployment. The configured Application URL
 * wins; an unconfigured install falls back to the origin of the current request.
 */
export function resolveSiteUrl(
	configured: string | null | undefined,
	requestUrl?: string,
) {
	const candidates = [
		configured && configured !== unconfiguredApplicationUrl ? configured : null,
		requestUrl,
		configured,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return new URL(candidate).origin;
		} catch {}
	}
	return "";
}

export function absoluteSiteUrl(pathOrUrl: string, siteUrl?: string) {
	if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
	const base =
		siteUrl || (typeof window === "undefined" ? "" : window.location.origin);
	return base ? new URL(pathOrUrl, base).toString() : pathOrUrl;
}
