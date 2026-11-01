import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { m } from "#/paraglide/messages";

// Self-hosted fonts and styles keep error pages working offline and under a
// strict content security policy. Everything is scoped under `.nf-root`.
const styles = `
@font-face{font-family:"Pirata One";font-style:normal;font-weight:400;font-display:block;src:url(/fonts/pirata-one-404.woff2) format("woff2")}
@font-face{font-family:"Alegreya";font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/alegreya-vietnamese-800-normal.woff2) format("woff2");unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:"Alegreya";font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/alegreya-latin-ext-800-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Alegreya";font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/alegreya-latin-800-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
.nf-root{--nf-bg:#b2d8f0;--nf-ink:#fff;--nf-accent:#39b6ff;--nf-fs:clamp(5rem,26vw,9.5rem);min-height:100svh;width:100%;overflow-x:hidden;background:var(--nf-bg);color:var(--nf-ink);font-family:"Alegreya",Georgia,serif;font-weight:800;font-size:1.2rem;line-height:1.55;text-align:center;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
.nf-sink{position:relative;width:100%;height:calc(var(--nf-fs)*.66);overflow:hidden;background:var(--nf-bg);margin-top:clamp(1rem,5vw,2rem)}
.nf-num{margin:0;font-family:"Pirata One","Alegreya",Georgia,serif;font-weight:400;font-size:var(--nf-fs);line-height:1;color:var(--nf-ink);transform:translateY(-.04em);letter-spacing:.04em}
.nf-wave{position:absolute;left:0;bottom:-1px;width:200%;height:calc(var(--nf-fs)*.16)}
.nf-main{margin:0 auto;width:100%;max-width:640px;padding:0 clamp(1rem,5vw,1.5rem) clamp(1.5rem,6vw,3rem)}
.nf-stage{border-radius:0 0 28px 28px;overflow:hidden;background:#b2d8f0}
.nf-stage img{display:block;width:100%;height:auto}
.nf-title{font-weight:800;font-size:clamp(1.5rem,6.2vw,2.8rem);line-height:1.15;margin:clamp(1.1rem,4vw,1.75rem) 0;text-wrap:balance}
.nf-actions{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap}
.nf-cta{font:inherit;font-weight:800;font-size:clamp(1rem,4vw,1.2rem);border-radius:999px;padding:.7em 1.6em;cursor:pointer;text-decoration:none;min-width:min(13em,100%);text-align:center;background:var(--nf-accent);color:var(--nf-ink);border:2px solid var(--nf-accent)}
.nf-cta:focus-visible{outline:3px solid #fff;outline-offset:3px}
@media (prefers-reduced-motion:no-preference){.nf-num{animation:nf-sink 5s ease-in-out infinite alternate}.nf-wave{animation:nf-flow 6s linear infinite}}
@keyframes nf-sink{from{transform:translateY(-.04em)}to{transform:translateY(.03em)}}
@keyframes nf-flow{to{transform:translateX(-50%)}}
.nf-desc{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:500;font-size:1rem;line-height:1.6;max-width:30em;margin:-.5rem auto 1.75rem;color:var(--nf-ink);text-shadow:0 1px 3px rgba(15,34,51,.35)}
`;

export type ErrorSceneAction = "back-or-home" | "sign-in" | "retry";

type ErrorSceneProps = {
	code: string;
	title: string;
	description?: string;
	action?: ErrorSceneAction;
};

/**
 * Shared layout for every error page: the sinking status code, the pirate in
 * his rowboat, a short title and one clear way out. Only the code, texts and
 * the action change between 401, 403, 404, 500 and 503.
 */
export function ErrorScene({
	code,
	title,
	description,
	action = "back-or-home",
}: ErrorSceneProps) {
	const { history } = useRouter();
	const [cameFromThisSite, setCameFromThisSite] = useState(false);

	// Only offer "Go back" when the visitor really arrived from another page of
	// this site; otherwise "Back to home" is the safer exit.
	useEffect(() => {
		try {
			setCameFromThisSite(
				Boolean(document.referrer) &&
					new URL(document.referrer).origin === window.location.origin &&
					window.history.length > 1,
			);
		} catch {
			setCameFromThisSite(false);
		}
	}, []);

	return (
		<div className="nf-root">
			<style>{styles}</style>
			<div aria-label={code} className="nf-sink" role="img">
				<p aria-hidden="true" className="nf-num">
					{code}
				</p>
				<svg
					aria-hidden="true"
					className="nf-wave"
					preserveAspectRatio="none"
					viewBox="0 0 1200 40"
				>
					<path
						d="M0 20Q150 0 300 20T600 20T900 20T1200 20V40H0Z"
						style={{ fill: "var(--nf-bg)" }}
					/>
					<path
						d="M0 20Q150 0 300 20T600 20T900 20T1200 20"
						fill="none"
						stroke="#fff"
						strokeOpacity=".7"
						strokeWidth="3"
					/>
				</svg>
			</div>
			<main className="nf-main">
				<div className="nf-stage">
					<img
						alt={m.errors_sceneImageAlt()}
						decoding="async"
						height={399}
						src="/images/404-pirate.webp"
						width={600}
					/>
				</div>
				<h1 className="nf-title">{title}</h1>
				{description ? <p className="nf-desc">{description}</p> : null}
				<div className="nf-actions">
					{action === "sign-in" ? (
						<Link
							className="nf-cta"
							search={{ redirect: undefined }}
							to="/sign-in"
						>
							{m.auth_signIn_title()}
						</Link>
					) : action === "retry" ? (
						<button
							className="nf-cta"
							onClick={() => window.location.reload()}
							type="button"
						>
							{m.errors_tryAgain()}
						</button>
					) : cameFromThisSite ? (
						<button
							className="nf-cta"
							onClick={() => history.go(-1)}
							type="button"
						>
							{m.common_goBack()}
						</button>
					) : (
						<Link className="nf-cta" to="/">
							{m.common_backToHome()}
						</Link>
					)}
				</div>
			</main>
		</div>
	);
}
