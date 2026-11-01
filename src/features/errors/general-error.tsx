import { m } from "#/paraglide/messages";
import { ErrorScene } from "./error-scene";

export function GeneralError() {
	return (
		<ErrorScene
			code="500"
			title={m.errors_generalTitle()}
			description={m.errors_generalDescription()}
			action="retry"
		/>
	);
}
