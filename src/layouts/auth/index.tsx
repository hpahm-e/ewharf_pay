import { Outlet } from "@tanstack/react-router";
import { AppTitle } from "#/layouts/components/app-title";
import { LocaleSwitch } from "#/layouts/components/locale-switch";
import { ThemeSwitch } from "#/layouts/components/theme-switch";

export function AuthLayout() {
	return (
		<div className="container relative grid h-svh flex-col items-center justify-center lg:max-w-none lg:grid-cols-2 lg:px-0">
			<section
				aria-hidden="true"
				className="relative hidden h-full overflow-hidden bg-[#d3e8fb] lg:block"
			>
				<img
					alt=""
					className="absolute inset-0 size-full object-cover object-center"
					decoding="async"
					draggable={false}
					height={1107}
					src="/images/login-scene.webp"
					width={1187}
				/>
			</section>
			<section className="relative flex h-full min-w-xs flex-col bg-gradient-to-br from-background via-background to-primary/10 px-6 lg:p-8">
				<header className="mx-auto flex w-full items-center justify-between py-4 sm:px-8 lg:px-0 lg:py-0">
					<AppTitle description />
					<div className="flex items-center gap-1">
						<LocaleSwitch />
						<ThemeSwitch />
					</div>
				</header>
				<main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-24">
					<Outlet />
				</main>
			</section>
		</div>
	);
}
