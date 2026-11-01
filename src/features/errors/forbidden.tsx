import { m } from "#/paraglide/messages";
import { ErrorScene } from "./error-scene";

export function ForbiddenError() {
	return (
		<ErrorScene
			code="403"
			title={m.errors_forbiddenTitle()}
			description={m.errors_forbiddenDescription()}
		/>
	);
}
