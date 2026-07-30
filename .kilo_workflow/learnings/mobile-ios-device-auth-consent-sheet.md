# mobile: iOS device-auth start() opens an ASWebAuthenticationSession consent over the pending branch

Symptom: after tapping `More sign-in options` on the iOS login screen, a system alert
`"Kilo" Wants to Use "<ip>" to Sign In` (Cancel/Continue) covers the app, and the
pending-with-code branch is not visible for pixel probes.

Cause: `use-device-auth.ts` `start()` calls `WebBrowser.openAuthSessionAsync(verificationUrl)` on
iOS (ASWebAuthenticationSession); the consent alert precedes the auth sheet. e1/e2 never hit it
because their starts all 500'd (error branch renders before the browser call).

Fix: tap `Cancel` index 0 on the consent — `openAuthSessionAsync` resolves as cancelled, NO app
state changes (the hook's own `cancel()` is not called), and the pending-with-code branch
("Your sign-in code:", `Sign in code: X X X X - X X X X`, "Open sign-in page in browser",
"Cancel sign in") stays rendered for probing. Then tap `Cancel sign in` to return to idle.
Probe discriminators: dark-glyph fraction on the big code text (full alpha ~0.19-0.21 with the
all-channels<100 threshold; parked ~50% alpha washes glyphs above 100 -> ~0.0) and on the
Open-in-browser button text (~0.036 full alpha). The muted "Your sign-in code:" heading scores
0.000 even when healthy (gray > 100/channel) — not a discriminator.
