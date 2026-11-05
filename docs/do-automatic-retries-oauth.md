# OAuth Durable Object retry inventory

This is the OAuth section of [the repository retry audit](do-automatic-retries.md).

The base `services/kilo-mcp/src/store/oauth-store.ts::KiloMcpOAuthStore` has a multiline declaration. The deployed `src/index.ts::KiloMcpOAuthStore` extends that base and adds token-exchange fetch. The `KILO_MCP_OAUTH_STORE` namespace creates the named store through `getByName`. The deployed subclass inherits the marked read functions without overriding them. It does not inherit a mark for its distinct fetch handler.

## Complete public-method matrix

**M** marked safe local observation. **U** unsafe duplicate execution. **D** deliberately unmarked write, even where a narrow fixed-input sequential interpretation could be idempotent. **L** lifecycle callback with separate runtime retry semantics.

| Base public method | Decision | Full contract including result, security, clocks, interleaving |
|---|---|---|
| `recordPairingApproval(deviceAuthCode, {kiloUserId,kiloToken}, nowIso)` | U | SQL CAS requires pending, unexpired-at-caller-time and user ID null. First-writer-wins credential binding returns true once, subsequent attempt false. Upstream device-auth poll is single-use; this transition bridges the approved pairing. Not a generic replayable setter and receives credential material. Consent re-reads current row afterward; no marking of the mutation. |
| `createPendingAuthorization(input)` | U | Plain INSERT of supplied ID/auth request/device/user codes/flow token/absolute timestamps. Exact duplicate conflicts rather than preserving void result. Repeating a whole authorize flow also creates new random IDs and upstream pairing, outside native scope. |
| `getPendingAuthorization(id)` | M | Pure SQL SELECT then JSON decoding into a plain record/null; no cleanup, lock, renewal, poll, claim or mutation. Contains private pairing credential/flow-token material, but no new external surface is created and callers retain their existing cookie/session authorization checks. No logging added. A retry may see completed/denied/purged/newer state, which is safer/current observation, not a promise of snapshot identity. Invalid stored JSON throws application error; native retries do not mask/retry that error. |
| `denyPendingAuthorization(deviceAuthCode,nowIso)` | U | pending→denied only while expiry > supplied now; returns transition-won true once, false later. Consent emits denied/client_not_confirmed analytics only for winning true. Duplicate execution loses that result and could hide winning side effect. |
| `expirePendingAuthorization(deviceAuthCode,nowIso)` | U | pending→expired with same transition flag and caller timestamp semantics. Consent emits expiry analytics only for true. Not marked. |
| `approvePendingAuthorization(deviceAuthCode,identity,nowIso)` | U | Claims pending authorization as approved and chooses identity/org. Returns true once; repeated execution false. Consent performs library completion only if true; retrying a committed claim can strand sign-in or discard redirect. Concurrent picker choices must not both claim. |
| `completePendingAuthorization(id,nowIso)` | U | approved→completed true once. Caller's successful redirect/analytics are gated on true; repeat returns false after library may have minted authorization code. Must not expand replay execution. |
| `releasePendingAuthorization(id,nowIso)` | U | approved→pending and organization null after provider completion/renewal failure. Returns true once. A delayed replay can release a later reapproved attempt (same row, no attempt generation), so even void-only treatment would be unsafe. |
| `purgeExpired(nowIso)` | U | Deletes expired refresh history and protected requests, drains pending auth rows; returns number deleted, which becomes zero on replay. Same absolute cutoff does not make count/complete contract idempotent, and deleted rows are security state. Native default identity-preserving retry remains available. |
| `ensureAuthenticator(kiloUserId,nowIso)` | D | Generates fresh random authenticator secret each invocation before insert-on-conflict-do-nothing, then returns stored secret and current verified flag. Existing immutable stored secret makes normal repeat enrollment stable, but this is a security-material-creating write, not a read; explicit assignment excludes token/OTP/claim mutations. No mark. Concurrent enrollment remains existing insert-first-wins behavior. |
| `confirmAuthenticator(kiloUserId,code,nowIso)` | D | Reads secret, awaits TOTP HMAC verification at caller-supplied time, then writes verified_at/updated_at. Does not consume execution step by design; enrollment must not use up first protected call's OTP. Still a security state mutation/OTP verifier with async gap, not annotated. |
| `createProtectedRequest({sessionId,kiloUserId,clientId,path,kind,inputJson,nowIso})` | U | Mints random UUID, expiry at caller-now+300s, persists exact protected payload pending, returns new ID/expiry. Repeat creates multiple actionable requests. Protected call issuance is not an idempotent ticket issuer. |
| `peekProtectedRequest(id,sessionId,nowIso)` | M | Only SELECTs protected row and account lock state. No failure counter increment, OTP computation, TTL update, invalidation, claim, secret/payload return or external role check. Returns pending/expired/invalidated/gone/locked (+retryAfterSeconds). Already-used, unknown and wrong-session IDs share gone. Hidden helper `authenticatorLockState` also only SELECTs; expired lock reads zero failures without persisting reset. Current-state observation is repeat-safe; replay after claim can only report gone. Subsequent claim independently rechecks row, owner, lock and used OTP step, so peek never authorizes execution by itself. |
| `verifyOtpAndClaim(input)` | U | Reads verified immutable authenticator secret and awaits TOTP WebCrypto, then one transaction rechecks owner/session/status/TTL, account lock, single-use last_used_step; wrong codes increment row attempts + account failures, may invalidate/lock, correct code clears failures and consumes step and marks request used. Successful first result uniquely returns path/inputJson for single upstream execution; repeat returns not_pending/reused_code or spends another wrong-attempt budget. Never mark. |
| `getRefreshToken(hash,nowIso)` | M | Only SELECT unexpired full-hash record; returns userId/grantId/current metadata or null, NOT actual refresh token/secret. No revoke, history mutation or renewal, no app wrapper. Note deployed refresh handler passes `store:this`, so its invocation of this method is an ordinary local call, not a namespace RPC: annotation does not create internal retry/revocation behavior. Other namespace consumers can safely reread current metadata. |
| `rememberRefreshToken(hash,parts,expiresAt)` | U | Transaction demotes all grant hashes, inserts/upserts chosen hash as current and prunes to bounded newest eight. Old replay after a later rotation could promote old token and demote true latest, breaking reuse security. History ordering uses expires_at/rowid; preserving input expiry alone does not preserve ordering. Current/previous provider behavior must not be inferred as permission to replay this mutation. |
| `forgetRefreshTokens(parts)` | D | Deletes all recorded hashes for grant. Intended only after provider revocation succeeds, then history cannot authenticate more replays. Broad replay after interleaved history write can remove needed detection state. No annotation, no app replay added. |
| `alarm()` | L | Uses current real Date for housekeeping cutoff, catches incomplete purge and schedules early five-minute retry or ordinary six-hour interval; no RPC annotation. Alarm callback retry differs from namespace-stub automatic retries. |

### Constructor and private helpers

Constructor creates Drizzle wrapper, migrates under blockConcurrencyWhile, reads alarm, and if missing schedules Date.now()+six hours. Constructors are not callable public RPC methods; no registration. Initialization execution/lifecycle semantics are unchanged.

Private helpers reviewed:

- `rowToPendingAuthorization`: object projection + JSON.parse only, so getPendingAuthorization has no hidden domain mutation.
- `purgeExpiredWithProgress`/`drainExpiredPending`: refresh/protected/pending DELETEs, bounded housekeeping progress versus unlimited public purge; not mistakenly treated as getters.
- `authenticatorLockState`: pure SQL projection and time arithmetic at nowIso; returns expired-lock zero failures without mutating persisted state. This establishes peek's read-only classification.
- `lastUsedStep`: pure helper used inside transaction, not public separately marked.
- `claimProtectedRequest`: mutating transaction body; wrong-code attempts and successful OTP steps are intentionally single-use.

## Deployed subclass fetch: do not mark

`src/index.ts:1139` deployed subclass initializes `createRefreshReuseHandler({store:this,revokeGrant:...})`. `fetch(request)` handles only POST /token; non-token requests return 404, but the mixed overall method is unsafe because the actual token path issues/rotates/consumes credentials and may revoke grants.

Worker default fetch reads a bounded 16KiB token body, rebuilds a request with Uint8Array, then calls named DO `.fetch` directly. A replayable byte body permits ordinary native identity-preserving retries, but does NOT make duplicate token execution safe.

Refresh handler queue is instance-local **inside the one named DO** and encloses check→provider KV rotation/revocation→history write, including external awaits. It catches rejected task only to keep queue healthy; it does not retry task itself. This serializes concurrent rotations but does not deduplicate a second invocation after a lost response.

- For remembered non-current refresh hash, detection directly awaits `revokeGrant` THEN forgets hashes, emits sign-in failure, returns HTTP400. Replaying original token call after first success could now present a non-current token and revoke an otherwise valid grant. HTTP400 is a response, not a retryable transport error.
- For current/unknown hash, provider is called, response cloned/parsed and issued refresh token hash remembered. Provider KV mutations, one-use authorization-code exchange and credential response are outside a durable per-call result ledger. A dropped token response must not be repaired by blindly running token handler twice.
- Async queue alone does not provide durable exactly-once completion or restore lost token responses; no claim of that was made.
- Base method marks do not propagate to fetch or cause local helper calls to be retried. Only inherited function objects get their original marks; subclass fetch is distinct and unmarked.
- No streams or RpcTargets are returned by the marked reads. fetch returns token Response and performs clone/parse, but never receives a duplicate-execution mark. Incoming streamed token request is bounded and rebuilt before namespace call; raw streamed input would be natively ineligible.

## Caller and security flow audit

No `withDORetry` in services/kilo-mcp production sources at inspection. All namespace calls rely on platform's safe default transport retries. User-facing JSON-RPC `{retryable:true}` hints/error messages are instructions to client UX, not a hidden DO application retry loop and not permission to automatically repeat protected actions.

### Consent/device pairing

`createDefaultHandler` receives helper-created namespace stub. Authorize creates upstream pairing, random pending ID and flow cookie token, persists new pending record. Status and org picker read current record using getPendingAuthorization. They independently reject expiry/completed/terminal states and compare presented flow cookie token. An automatically retried record read cannot bypass or move these checks; it does not repoll upstream by itself.

Status's pending row may poll upstream device auth once; approved pairing writes token via first-writer-wins recordPairingApproval, then rereads stored row. All writing methods remain unmarked. Denied/expired/client-confirmation failures emit only when CAS true; retrying those mutations would change analytic ownership.

Picker re-derives admin eligibility from live user.getMe, organization membership from current list, and enrollment state. ensureAuthenticator may run on GET for eligible user; that is a write despite the higher HTTP request being GET, so never annotate whole fetch/consent getter on that assumption. OTP enrollment confirm precedes approvePendingAuthorization, which claims completion. Provider client renewal+completeAuthorization occurs only after successful claim. On failure releasePendingAuthorization reopens for explicit user retry. On success completePendingAuthorization must win before redirect and success analytics. No retryable marks on these claims.

### Protected request / submit OTP

`call_protected` validates published catalog/schema and auth/session eligibility, then createProtectedRequest records fixed payload and returns random request ID. `submit_otp` obtains nowIso once, calls marked peek, rejects stale/locked state early, then makes live admin recheck with grant bearer and calls unmarked verifyOtpAndClaim. Only outcome `ok` invokes executeProtectedCall once using stored path/inputJson. Losing transport after claim cannot be recovered by rerunning claim: row is already used, and the claimed payload/result is not retained as a replay result. This fail-closed ambiguity is intentionally not converted into duplicate admin execution.

Peek is not a reservation. Concurrent consumption/lock/change after peek is expected and independently rejected transactionally by claim. The read annotation does not alter this race proof or permit another session to learn payload identity.

### Clocks and interleaving

Authorization methods accept explicit nowIso. Retried read arguments keep that timestamp, rather than sampling a later clock. Thus protected TTL/lock status is evaluated at the caller's selected time across native attempts, exactly as before; the annotation does not fix longstanding request-duration skew or promise fresh clock semantics. Subsequent claim already receives the same caller nowIso in current flow. No TTL/lock policy change was slipped into this retry audit.

getPendingAuthorization does not filter expiry itself; consent does using caller's captured now. getRefreshToken explicitly filters expires_at > supplied now and does not renew it. Long token queue derives Date.now when operation actually runs; constructor/alarm have real wall clocks. Those clocked effects are not marked.

All three reads do synchronous SQL operations before their async function returns, with no external await opening an interleaving window inside the body. Different attempts may observe later committed status/history. This is valid read semantics, not exact snapshot identity. No mutation or side-effect claim depends on receiving the first read result rather than a later observation.

