# mobile: parallel device phases on one worktree email race the OTP outbox (latest code wins)

Symptom (login-ui-d051 e2, 2026-07-29): an Android OTP Verify tap reached the backend but got
`POST /api/auth/native/token 401` with the correct-looking 6-digit code. Cause: an iOS Maestro
loop running CONCURRENTLY on the same worktree signed in with the same default email
(`e2e-mobile-<worktree>@example.com`); its newer `POST /api/auth/native/otp` invalidated the
Android device's outstanding code before the Verify tap. The 401 is correct product behavior
for a stale code, not a tap failure.

Fix: when two device phases share one worktree email, either (a) finish every OTP verify before
the next request-code on ANY device, (b) read the outbox code immediately before typing it and
confirm the newest outbox file's timestamp postdates your device's request, or (c) pass an
explicit different email to one phase (`login.sh <device> <email>`). Evidence the tap landed:
the 401 line in `pnpm dev:capture nextjs` — a covered/no-op tap produces NO request line.
