import { m } from "#/paraglide/messages";
import { ErrorScene } from "./error-scene";

export function UnauthorisedError() {
	return (
		<ErrorScene
			code="401"
			title={m.errors_unauthorizedTitle()}
			description={m.errors_unauthorizedDescription()}
			action="sign-in"
		/>
	);
}
