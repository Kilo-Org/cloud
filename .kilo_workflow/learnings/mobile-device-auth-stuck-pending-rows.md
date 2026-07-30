# mobile: device-auth "Too many pending" 500s — usually STUCK rows, not live traffic; probe the DB, reconcile via the real poll endpoint

Symptom: `POST /api/device-auth/codes?app=1` 500s with `Too many pending authorization requests
from this IP` and the app shows "Failed to start sign in. Please try again." — while the app,
backend, and network are all healthy. Waiting any amount of time (hours) never clears it, even
after all concurrent sections end.

Cause: the limiter counts `status='pending'` rows per IP **machine-wide** (MAX 5) regardless of
`expires_at` (`apps/web/src/lib/device-auth/device-auth.ts`). Two holders can saturate it: live
traffic from a concurrent section, or — far more often — stuck rows: the app's `cancel()` is
CLIENT-SIDE ONLY (`use-device-auth.ts`: setState idle, no DELETE), a killed/closed app never
polls again, and local dev runs no `cleanupExpiredDeviceAuthRequests` cron, so every abandoned
code sits `pending` forever. (2026-07-29: two verifier rounds of 500s were blamed on a live
sibling section — wrong; a DB probe showed 5 rows stuck for 6 hours.)

Cheap probe (no stack, no device, read-only):

```bash
docker exec dev-postgres-1 psql -U postgres -d postgres -c \
  "SELECT ip_address,status,count(*),max(expires_at) FROM device_auth_requests GROUP BY 1,2;"
```

Pending rows long past `expires_at` = stuck; recent rows = a live holder. The consent dialog's
domain ("Kilo Wants to Use <ip> to Sign In") names the limiter IP.

Fix for stuck rows (the product's own path, NOT a mock — the limiter still evaluates real DB
state on every later start): once a stuck code is past expiry, poll it through the real
endpoint on your own stack: `curl http://localhost:<nextjs-port>/api/device-auth/codes/<code>`
→ 410 and `pollDeviceAuthRequest` flips the row to `expired`. Never UPDATE the table directly.
Fresh codes (<10 min old) return 202 and stay pending — reconcile your own codes after expiry so
the next section does not inherit your wedge.

For a live holder: treat `start()` calls as a scarce budget (≤3 per round) and classify the
pending branch as environment-blocked if 500s persist past one spaced recovery attempt. The
error branch rendering is itself usable evidence.
