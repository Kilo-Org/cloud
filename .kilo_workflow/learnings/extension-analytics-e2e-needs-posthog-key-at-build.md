# extension: analytics e2e specs need VITE_POSTHOG_API_KEY at build time

Symptom: every analytics e2e spec fails waiting on posthog identify/capture events after `pnpm --filter kilo-extension build`, even with `VITE_POSTHOG_API_KEY=e2e-test-key` on the playwright invocation.

Cause: the key is inlined at build time; without it the build logs "VITE_POSTHOG_API_KEY is not set; extension analytics will be disabled in this build" and analytics is compiled out.

Fix: set the key on the build — `VITE_POSTHOG_API_KEY=e2e-test-key pnpm --filter kilo-extension build` — before running targeted playwright specs. The `e2e:chrome` script already does this; only manual targeted runs forget it. Verified 2026-07-27.
