# mobile: device-auth per-IP pending limit is machine-wide — and the holder may be STUCK rows, not live traffic

Symptom: `POST /api/device-auth/codes?app=1 500` with
`Error: Too many pending authorization requests from this IP` (`src/lib/device-auth/device-auth.ts`),
app shows the error branch "Failed to start sign in. Please try again." — while the app, backend,
and network are all healthy.

Cause: the limiter counts PENDING device-auth codes per IP, machine-wide (MAX 5), regardless of
`expires_at`. Two distinct holders can saturate it: live traffic from a concurrent section, or
STUCK rows abandoned by client-side-only `cancel()` (see
`mobile-device-auth-stuck-pending-rows.md`). Observed 2026-07-29 on login-ui-d051: 500s
08:37–10:44+ across two verifier rounds were first attributed to the live pr-review-d957
section — WRONG; a read-only DB probe showed 5 rows stuck since 04:39–04:46, no live traffic
involved. Waiting NEVER clears stuck rows (no dev cleanup cron).

Fix: probe the DB first (recipe in `mobile-device-auth-stuck-pending-rows.md`) — 5 pending rows
long past `expires_at` = stuck, reconcile via the real poll endpoint; recent rows = a live
holder, then treat `start()` calls as a scarce budget (<=3 per round) and classify the pending
branch as environment-blocked if 500s persist past one spaced recovery attempt. The error
branch rendering is itself a free branch-swap evidence point (probe it for full alpha).
