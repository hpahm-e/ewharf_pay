import { m } from "#/paraglide/messages";
import { ErrorScene } from "./error-scene";

export function NotFoundError() {
	return <ErrorScene code="404" title={m.errors_notFoundSunkTitle()} />;
}
