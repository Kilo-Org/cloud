# Cost statement: `@kilocode/verify` (design section 2.4, rule 2)

This statement covers the library as it stands after review round 1. Every number is arithmetic
from the code and from the design's own figures; nothing here is a production measurement.
Assumptions are marked **[A]**; estimates not measured are marked **[E]**.

Scale inputs (design 2.4): 10,000, 50,000 and 200,000 active clients; about 2,200 concurrent Vercel
instances at peak; 5,000 Worker isolates (the figure design 5.7 uses for the feed proof run); 43
production releases per day.

## 1. Rows and limits this PR touches

- Section 3 hot-path rows: "Verify an access token" and "Verify a PAT".
- Section 3 limits: "PAT lookups", "Revocation feed" and "Cold start".
- No budget or limit changes value. The values the code now states that the design did not (the
  1-second key-set stale wait, the 1-second feed timeout, the retry backoffs, the 5-second future
  head allowance, the 400 for a PAT without a client address) are logged as design changes p2-8
  onward.

## 2. Network calls per request

Per verifier, that is per isolate or process. "Merged" means concurrent requests in the isolate
share one call (owner and pollers).

| Path | Warm cache | Cache miss | Cold instance |
|---|---|---|---|
| STS token | 0 | Set older than 5 min: 1 key-set fetch, merged; the request waits for it, up to the 5 s timeout (an STS set never serves past its 5-minute lifetime). Unknown `kid`: at most 1 fetch per 5 min per set, cancelled requests included | 1 STS key-set fetch, in parallel with the UTS bootstrap when the service calls `warm` |
| UTS token | 0 | UTS set older than 5 min: 1 key-set fetch, merged; the request waits at most 1 s when it holds a last good set with the `kid`, else up to the 5 s timeout. Unknown `kid` as for STS. Feed: when the signed head is over 30 s old, the request waits for one merged refresh (head, plus the list only when its hash changed), at most 1 s | 1 bootstrap call (UTS key set, head and list in one answer), merged, in parallel with the STS key set. Without a bootstrap port: key set, then head, then list, in series |
| PAT | 0 on an in-instance hit | Instance miss: 1 shared-cache read, started in parallel with the key-set and feed reads; on a shared miss, 1 UTS lookup (merged per hash), then 1 shared-cache write after the response | Bootstrap (as above) in parallel with the hash and the shared-cache read, then the lookup path |

## 3. Background fetches per isolate, and totals

While an isolate serves traffic, under the request's `waitUntil`; an idle isolate makes none.

| Fetch | Per isolate | 2,200 Vercel instances | 5,000 Worker isolates |
|---|---|---|---|
| Feed head (UTS-token or PAT traffic) | at most 1 per 10 s = 6/min | 13,200/min = 220/s | 30,000/min = 500/s |
| Feed list | only when the head names a new hash; at most 6/min | at most 220/s | at most 500/s |
| UTS key set | 1 per 4 min ±20 % minus the response's `Age` (at most 17 s while every signer read succeeds) ≈ 0.25/min; at most 1 per 2.9 min | 550/min = 9.2/s | 1,250/min = 21/s |
| STS key set (STS-token traffic) | 1 per 4 min ±20 % ≈ 0.25/min; at most 1 per 3.2 min | 550/min = 9.2/s | 1,250/min = 21/s |

- The feed Worker keeps the head in each data center's cache for 5 s, so the feed objects see at
  most one head read per data center per 5 s, whatever the isolate count; design 5.7 sets the proof
  bound at 300 requests per second per feed object.
- These totals depend on the number of warm instances, not on the client count: 10,000, 50,000 or
  200,000 clients only change how many instances are warm. The table is the upper bound for all
  three, at the peak instance counts above.
- The ±20 % jitter keeps the mean interval at 4 minutes (minus `Age`), so the totals stand; it
  spreads the background refreshes and the retry waits, but not the 24-hour limit below. When every
  UTS signer read fails, `Age` grows past the refresh point and each fetch counts as failed: the
  isolate moves to the first row of the table in section 4 (5 s doubling to 60 s), and stays on
  it past the 24-hour limit.
- **The 24-hour burst.** A held UTS set stops serving 24 hours after its oldest keys were read,
  and the library refreshes at once at that point (design 5.7). Every warm isolate holds the same
  oldest-read time (to the second), so each one makes one fetch within about 1 s: about 7,200 at
  5,000 Worker isolates plus 2,200 Vercel instances. The feed Worker must answer that burst from
  its per-data-centre cache, not with one signer read per request. A failed refresh then backs off
  as in section 4, each wait jittered.

**Releases.** A release cold-starts the instances of the released service. With `warm` and the
bootstrap port, a cold instance makes 2 fetches in parallel (UTS bootstrap, STS key set), down from
up to 4 in series.

| | Per release | 43 releases per day |
|---|---|---|
| 2,200 Vercel instances, all cold (upper bound) | 4,400 fetches | 189,200 fetches |
| 5,000 Worker isolates, all cold (upper bound) | 10,000 fetches | 430,000 fetches |

A bootstrap answer is about 5 KB of key set (about 34 keys) plus about 300 bytes of head plus the
list (section 7 below).

## 4. Retry rates during an outage

A cancelled request's key-set, feed or bootstrap call counts as a failed call with its retry wait,
so cancelling requests cannot raise any rate below.

| Dependency down | Retry waits per isolate | Steady rate per isolate | 5,000 isolates | 2,200 instances |
|---|---|---|---|---|
| UTS key set, last good set serving (up to 24 h), every answer past the refresh point, or a held set past its 24-hour limit | 5, 10, 20, 40, 60, 60 … s, each ±20 %; the count restarts only after a success | 1/min, after about 2 min | 83/s | 37/s |
| STS key set, set expired (it never serves past 5 min, so STS routes get 503) | 5 s ±20 % | 12/min | 1,000/s | 440/s |
| Either key set, cold isolate (no set) | 5 s ±20 % | 12/min | only cold isolates | only cold instances |
| Revocation feed, copy serving short tokens (head up to 10 min) | 5, 10, 20, 30, 30 … s | 2/min, after about 1 min | 167/s | 73/s |
| Bootstrap, cold isolate | 5 s fixed | 12/min | only cold isolates | only cold instances |

A UTS outage longer than 24 hours keeps the 60 s cadence: once the held set passes its limit,
requests get 503, and the first fetch after UTS recovers comes at most about 60 s later (72 s with
the jitter). That is the cost of not raising the feed load to the 5 s rate of a cold isolate
(1,000/s at 5,000 isolates) for the rest of the outage.

First minute of a UTS key-set outage: fetches at 0, 5, 15 and 35 s, so 4 per isolate (333/s at
5,000 isolates, falling to 83/s). An STS outage keeps the 5 s wait, because no STS copy serves and
a longer wait would only delay recovery; STS's key-set endpoint must carry that 1,000/s at 5,000
isolates while it recovers.

**Added latency in an outage.** Each refresh attempt is bounded: a hanging UTS issuer delays
requests that hold a last good set by at most 1 s per attempt (`JWKS_STALE_WAIT_MS`), once per
retry wait, then the last good set serves; a hanging feed delays requests (only once the head is
over 30 s old) by at most 1 s per attempt (`FEED_FETCH_TIMEOUT_MS`), once per retry wait; a PAT
request reads the feed on each side of its lookup, so it can wait for two such attempts (at most
2 s). A request with no usable set (cold, or an STS set past 5 minutes) waits up to the 5 s
key-set or bootstrap timeout, then gets 503.

## 5. Vercel function time

Background refreshes run under `waitUntil`. Vercel bills Provisioned Memory until the last
in-flight work finishes and Active CPU only while code runs
(https://vercel.com/docs/functions/usage-and-pricing).

- Active CPU: the refreshes wait on I/O; CPU is the key import (about 34 Ed25519 keys per key-set
  refresh) and, on a changed list, one SHA-256 and one JSON parse (section 8).
- Provisioned Memory: a refresh adds billed time only when it outlives the instance's last
  response. Upper bound **[A: every refresh extends an otherwise-ending invocation by 50 ms]**:
  6.5 refreshes/min × 50 ms = 0.33 s per minute per instance, so 715 instance-seconds per minute
  (about 12 instance-hours per hour) at 2,200 instances, times the configured memory. At peak an
  instance serves concurrent requests, so most refreshes overlap billed time already and add none.
  A refresh's wall time is capped at 1 s (feed) or 5 s (key set).

## 6. PAT load on UTS

- **Normal traffic.** At most one UTS lookup per active PAT per 60 s per shared-cache domain (a
  Vercel region or a Cloudflare data center), and one per 30 s for an unknown PAT. **[A: 5 % of
  active clients use a PAT, each seen from 2 domains.]**

  | Active clients | Active PATs | UTS lookups (2 domains / 60 s) |
  |---|---|---|
  | 10,000 | 500 | 17/s |
  | 50,000 | 2,500 | 83/s |
  | 200,000 | 10,000 | 333/s |

- **Worst case.** 20 uncached lookups per second per client address per instance, before UTS,
  and at most 1,000 lookups pending per instance whatever the addresses (above that, 503 with no
  lookup). One address that reaches all 2,200 instances offers up to 44,000 lookups per second;
  UTS's 100-in-flight cap answers the excess with 429, which reaches clients as 503 and never
  evicts a valid cached entry. A PAT that passes the checksum is cheap to make, so random PATs
  always miss both caches; the per-address limit, the per-instance pending bound and the UTS cap
  are the bounds. The 1,000 pending bound is a shared availability budget: while UTS is slow,
  random well-formed PATs from many addresses can fill it, and new uncached PATs then get 503,
  while cached and stale entries keep working.
- **Feed after the lookup.** The PAT decision reads the feed again after the lookup; that read is
  in memory unless the head is over 30 s old at that point; a PAT request can therefore wait for
  two feed refreshes (at most 2 s), one on each side of the lookup.
- **Shared cache.** Each instance miss costs 1 shared-cache read; each UTS answer (found or not
  found) costs 1 shared-cache write. Writes therefore equal the UTS lookup rate above. A read, its
  key provider included, that has not answered within 1 s counts as a miss, so a slow cache adds
  at most 1 s before the lookup starts. While shared-cache reads time out, every instance miss
  becomes a UTS lookup plus a cache write, so UTS load is then the worst-case miss rate above,
  not the normal-traffic table.
- A PAT without a client address is refused (400) before any cache, feed or lookup call.

## 7. Feed list size and bandwidth

The list holds a PAT entry for 15 minutes and every other entry until 10 minutes after the last
affected token expires (design 5.6), so about 20 minutes. **[A: 1 revocation event per active client
per day; about 50 bytes per entry as JSON.]**

| Active clients | Entries held (20 min) | List size | Hash changes |
|---|---|---|---|
| 10,000 | about 140 | about 7 KB | about every 4 s (0.12 new entries and 0.12 expiries per second) |
| 50,000 | about 700 | about 35 KB | on nearly every 5 s head |
| 200,000 | about 2,800 | about 140 KB | on every head |

Each isolate fetches the list only when the hash changes, at most once per 10 s. Upper bound on
list bytes delivered to isolates, assuming a change at every fetch:

| Active clients | Per isolate | 2,200 Vercel instances | 5,000 Worker isolates |
|---|---|---|---|
| 10,000 | 0.7 KB/s | 1.5 MB/s | 3.5 MB/s |
| 50,000 | 3.5 KB/s | 7.7 MB/s | 17.5 MB/s |
| 200,000 | 14 KB/s | 31 MB/s | 70 MB/s |

The list is cacheable by its hash, so the feed Worker serves it from each data center's cache and
the feed objects send each list once per data center. The 200,000-client figure is the largest cost
in this statement; phase 3 sizes the real list and can add a delta format without changing the head
signature.

## 8. Memory and CPU

**Memory per isolate** (all bounds hard unless noted):

| Structure | Bound | Size |
|---|---|---|
| PAT instance entries | 10,000, oldest first; a "no such PAT" entry can push out a positive one (a flood of random PATs at over 333 per second per instance, from 17 or more addresses, churns it; an evicted positive PAT then costs one shared-cache read, not a UTS lookup) | about 4 MB |
| PAT failures | 10,000, oldest first (an evicted hash may be looked up again before its retry time, within its address's limit and the pending bound); each lives at most 62 s | about 1 MB |
| Pending PAT lookups | 1,000 per instance; the ones past their 5 s timeout are failed and dropped before a new one starts | 100 B each |
| Per-address windows | 10,000, oldest first (an evicted address starts a new window) | about 1 MB |
| Shared-cache HMAC keys | the 2 versions the bundle lists | negligible |
| Key sets | one per issuer: about 34 `CryptoKey`s for UTS (16 signers × current and next, plus feed keys), a few for STS | negligible |
| Feed list | one parsed copy; at 200,000 clients about 2,800 entries | about 0.3 MB |

Total under 8 MB, against the 128 MB Worker isolate limit.

**CPU per verify [E]:**

- Access token: the token is decoded once (header and payload: one base64url decode and one JSON
  parse each), then one Ed25519 verify in WebCrypto (about 50 to 150 µs) and one zod parse.
- PAT: one CRC-32 over 52 characters, one base64url round trip, one SHA-256 and map lookups; a
  shared-cache read adds one HMAC verify, two JSON parses and one zod parse.
- Per key-set refresh: about 34 Ed25519 key imports. Per changed list: one SHA-256 and one JSON
  parse of the list (about 1 ms at 140 KB), at most once per 10 s.

## 9. What this PR does not add

No SQL statement, Durable Object hop, database connection, audit row, queue message or deploy.
The library has no caller yet: the network calls above start when a service adopts it, through the
ports phase 3 implements.
