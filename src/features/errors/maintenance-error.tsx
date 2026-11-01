import { m } from "#/paraglide/messages";
import { ErrorScene } from "./error-scene";

export function MaintenanceError() {
	return (
		<ErrorScene
			code="503"
			title={m.errors_maintenanceTitle()}
			description={m.errors_maintenanceDescription()}
			action="retry"
		/>
	);
}
