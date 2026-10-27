// The pages' Content-Security-Policy: nothing from the network, scripts from tira only, and forms
// that post to tira itself.
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// The landing's (welcome.ts): its sign-in form posts to tira, which sends the browser straight on
// to GitHub's sign-in page (the one-click way, integrations.ts: signinStart). A browser holds that
// whole trip to the page's form-action, so with 'self' alone it stops at tira and the page just sits
// there (found signing in with the real GitHub app, 2026-10-23). This page alone lets a form go on
// to that one GitHub address; every other page keeps its forms to tira.
export const SIGNIN_CSP = CSP.replace("form-action 'self'", "form-action 'self' https://github.com/login/oauth/authorize");

// The page where a person approves Claude's connection (/oauth/authorize): its form posts to tira,
// which sends the browser back to the app that asked (Claude, or Claude Code on this computer).
// The same trip as the landing's, so this page alone lets a form go on to that app's origin.
export const consentCsp = (redirect: string): string => CSP.replace("form-action 'self'", `form-action 'self' ${new URL(redirect).origin}`);
