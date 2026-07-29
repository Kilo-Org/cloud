# mobile: device-auth per-IP pending limit is shared with concurrent sections — budget status-flip starts

Symptom: `POST /api/device-auth/codes?app=1 500` with
`Error: Too many pending authorization requests from this IP` (`src/lib/device-auth/device-auth.ts`),
app shows the error branch "Failed to start sign in. Please try again." — while the app, backend,
and network are all healthy.

Cause: the limiter counts PENDING device-auth codes per IP, machine-wide. A concurrent
pr-review section's E2E creates device-auth requests continuously and saturates the limit for
every other worktree on the box (observed 2026-07-29 08:37–10:44+ across two verifier rounds on
login-ui-d051 while pr-review-d957 held slot-1; it never cleared while that section ran).

Fix: treat `start()` calls as a scarce budget (<=3 per round, per the login UI handoffs), and
classify the pending branch as environment-blocked when 500s persist — one spaced recovery
attempt is enough; waiting does not clear it while the other section is active. The error
branch rendering is itself a free branch-swap evidence point (probe it for full alpha).
