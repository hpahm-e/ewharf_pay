import { z } from "zod";
import { type TelegramLocale, telegramLocales } from "#/lib/locales";

const telegramTemplateTranslationsSchema = z.partialRecord(
	z.enum(telegramLocales),
	z.string(),
);

export function parseTelegramTemplateTranslations(value: unknown) {
	let candidate = value;
	if (typeof value === "string") {
		try {
			candidate = JSON.parse(value);
		} catch {
			candidate = null;
		}
	}
	const parsed = telegramTemplateTranslationsSchema.safeParse(candidate);
	const source = parsed.success ? parsed.data : {};
	return telegramLocales.reduce<Record<TelegramLocale, string>>(
		(translations, locale) => {
			translations[locale] = source[locale] ?? "";
			return translations;
		},
		{} as Record<TelegramLocale, string>,
	);
}
