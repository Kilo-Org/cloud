# mobile: device-auth pending rows get STUCK after client cancel — probe the DB, reconcile via the real poll endpoint

Symptom: every `POST /api/device-auth/codes?app=1` 500s with `Too many pending authorization
requests from this IP` and the app shows "Failed to start sign in" — and waiting any amount of
time (hours) never clears it, even after all concurrent sections end.

Cause: the limiter counts `status='pending'` rows per IP regardless of `expires_at`
(`apps/web/src/lib/device-auth/device-auth.ts`, MAX 5). The app's `cancel()` is CLIENT-SIDE ONLY
(`use-device-auth.ts`: setState idle, no DELETE) and a killed/closed app never polls again, so
every abandoned code sits `pending` forever. Local dev runs no `cleanupExpiredDeviceAuthRequests`
cron. On 2026-07-29 the login-ui-d051 e2 rounds' 500s (attributed in
`mobile-device-auth-ip-limit-shared-sections.md` to the live pr-review-d957 section) were actually
held by 5 rows created 04:39-04:46 and expired by 04:56 — 6h stale; no live traffic involved.

Cheap probe (no stack, no device, read-only):
  docker exec dev-postgres-1 psql -U postgres -d postgres -c \
    "SELECT ip_address,status,count(*),max(expires_at) FROM device_auth_requests GROUP BY 1,2;"
5 pending whose `expires_at` is long past = stuck rows, not a live holder; the consent dialog's
domain ("Kilo Wants to Use <ip> to Sign In") names the limiter IP.

Fix (product's own path, NOT a mock — the limiter still evaluates real DB state for every later
start): once the stuck codes are past expiry, poll each through the real endpoint on your own
stack: `curl http://localhost:<nextjs-port>/api/device-auth/codes/<code>` → 410 expired;
`pollDeviceAuthRequest` flips the row to `expired`. Never UPDATE the table directly. Fresh codes
(<10min old) return 202 and stay pending — reconcile your own flip codes after expiry so the next
section does not inherit your wedge.
