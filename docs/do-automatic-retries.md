# Durable Object automatic retry audit

## Decision

Use native identity-preserving retries for namespace stub calls. Mark only audited observational methods with `retryable()`. Keep mutations, claim results, streams, and lifecycle handlers unmarked.

The shared `withDORetry` helper now defaults to one application attempt. This prevents fresh-identity replay after an ambiguous successful mutation. Explicit application retry configuration remains available for proven idempotent protocols. Overloaded errors are never replayed. Existing deadlines remain caller-owned and do not cancel remote work.

Source: [Cloudflare automatic retries](https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/). Native defaults allow five total attempts within a ten-second retry window. The first attempt is not cancelled. Eligibility excludes stream arguments, RPC capabilities, pipelining, and received stubs. Application exceptions and HTTP errors are not retried.

## Reading the inventory

Marked methods permit repeated execution after ambiguous delivery. Unmarked methods retain native transport retries without duplicate execution. Later query attempts can observe newer state; no snapshot guarantee is added.

M, R, and MARKED identify implemented annotations. U, D, N, and UNMARKED identify exclusions or conservative candidates. L identifies lifecycle callbacks with separate runtime policies. Method symbols are the stable anchors; numeric source references describe the inspected baseline. Paths in each service section are relative to that service unless fully qualified.

Caller descriptions record the inspected baseline. References to the old shared application default describe the hazard removed by the new single-attempt default, not a remaining default replay policy. Domain alarms, queue redelivery, provider retries, and HTTP-client retries remain separate contracts.

The [Cloud Agent method inventory](do-automatic-retries-cloud-agent.md) covers all control, session, build, facade, nonce, container, tombstone, and fixture classes.

The [OAuth method inventory](do-automatic-retries-oauth.md) covers the base store, deployed subclass, authorization transitions, OTP claims, and refresh history.

Inventory coverage was cross-checked against all Wrangler JSON/JSONC bindings under services, apps, and packages, including nested environments and test configurations. No TOML configuration required a separate parser. Source review also covered indirect subclasses and retired exports without active bindings.


# Routing, attribution, polling, and containers

## AttributionTrackerDO — services/ai-attribution/src/dos/AttributionTracker.do.ts

- Marked `getLinesAddedByHash`, `getAttributionEvents`, and `getDebugData`: synchronous SQL observations with cloneable results. Retries can observe newer rows without consuming a cursor or claim.
- Unmarked `insertAttributionMetadata`, `insertLinesAdded`, `insertLinesRemoved`, and `trackAttribution`: inserts allocate new database identities and duplicate attribution rows.
- Unmarked `deleteAttribution`: returns true once, then false; a lost first result changes the caller's response.
- Unmarked `clearAllData`: an old duplicate can erase rows inserted after the original operation. No generation fence.
- Constructor migrations are lifecycle initialization, not separately retryable RPCs. Namespace helper `getAttributionTrackerDO` creates eligible stubs. Worker handlers call methods directly; no application retry loop.

## AutoRoutingDecisionCacheDO — services/auto-routing/src/decision-cache.ts

- Marked `readConversationState`: reads stored values and filters expired entries only in the local result map. No durable read repair or alarm change.
- Unmarked `putEntry`: rewrites storedAt from Date.now and extends the cache lifetime; stale retry can replace newer data.
- Unmarked `putStickyDecision`: generation rejects older writes, but an equal-generation replay refreshes storedAt and can replace another equal-generation value. No full replay guarantee.
- Unmarked `recordClassifierUsage`: usage ID deduplication protects downstream billing, but successful entries are deleted. A later replay recreates scheduling/attempt state and performs external usage I/O again. Do not mistake downstream dedupe for whole-method idempotency.
- `alarm` uses its own lifecycle retry semantics; it expires cache rows and retries usage records. No annotation.
- `cacheStub` creates namespace stubs. Cache read/write callers catch failures and use existing cache-miss/best-effort paths. Classifier-usage currently uses the shared wrapper; the new single-application-attempt default prevents ambiguous replay. Durable alarm recovery remains unchanged.

## AutoRoutingModeConfigDO — services/auto-routing/src/routing-mode.ts

- Marked `getMode`: storage observation and runtime schema parse, including null/invalid stored mode.
- Unmarked `setMode`: same-input put/delete looks sequentially idempotent, but an old retry can overwrite an intervening newer mode. No revision token.
- `modeStub` creates namespace stubs; callers invoke directly. Read error handling still selects the existing default mode.

## GmailPushIdempotency — services/gmail-push/src/idempotency.ts

- Unmarked `checkAndMark`: first call persists a timestamp and returns false; replay returns true. The queue consumer acknowledges duplicates, so a lost first result followed by replay can suppress processing.
- `alarm` expires deduplication keys using its separate callback policy. No annotation.
- Consumer creates the namespace stub and calls directly. Queue redelivery is a separate business recovery contract, not a reason to mark this claim.

## ScimSyncDO — services/scim-sync/src/dos/ScimSyncDO.ts

- Marked `getStatus`: reads configuration, alarm, and persisted last-poll result. Current-state observation, no durable mutation.
- Unmarked `ensureScheduled`: first returns armed:true, replay armed:false. It also chooses a new alarm timestamp when unarmed. State convergence is not returned-result idempotency.
- Unmarked `poll`: fetches WorkOS and logs directory events on every call. Repeated external work/log publication is not a pure status read.
- `alarm` persists poll results and schedules the next poll. Cron watchdog and poll interval already provide business recovery. Neither is replaced by stub retries.
- Namespace helper creates eligible stubs; cron calls ensureScheduled directly.

## AlertConfigDO — services/o11y/src/alerting/AlertConfigDO.ts

- Marked `list`, `get`, `listTtfb`, and `getTtfb`: synchronous SQL reads and projections, including empty results.
- Unmarked `upsert`, `upsertTtfb`: caller supplies updatedAt, but SQL does not reject older revisions. Delayed replay can overwrite a newer configuration.
- Unmarked `remove`, `removeTtfb`: delayed replay can erase an intervening new configuration.
- Constructor migrates SQLite. Config stores create namespace stubs through getAlertConfigDO and call directly.

## BenchRunnerContainer — services/auto-routing-benchmark/src/bench-runner-container.ts

- Unmarked `fetch`: mixes destructive admin POST and arbitrary container proxy requests, including benchmark run submission and streaming bodies. Never mark the entire handler because some GET routes are read-only.
- Inherited Container lifecycle/start/destroy/proxy methods belong to the SDK and manage resources. No blanket prototype marking, bound-method wrapper, or SDK patch.
- Benchmark caller cancellation remains unchanged. Native retry limits are not a cancellation deadline.

## GrafanaContainer — services/kilo-ops/src/worker.ts

- Unmarked `fetch`: can start a container, load secrets into startup environment, and proxy arbitrary Grafana mutations/uploads or WebSocket upgrades. Requests preserve streaming bodies. Do not buffer them for retries.
- SDK `ContainerProxy` is re-exported and may appear as an SDK binding; no owned implementation or application method annotations. Inherited SDK lifecycle and proxy methods remain unmarked by this change.
- getGrafanaContainerStub creates namespace stubs; forwarded requests invoke fetch directly. Empty-body replay eligibility does not make mutation routes idempotent.

## Caller-cancellation Relay fixture — services/auto-routing-benchmark/test/fixtures/caller-cancellation/worker.ts

- Unmarked `fetch`: forwards arbitrary methods and bodies to a fixture upstream and propagates cancellation. Replay could duplicate a POST; this fixture tests transport behavior rather than an idempotent domain read.
- Namespace-created fixture stub receives native identity-preserving retries where the request body permits. No production binding.

## Coverage notes

- Constructors, alarm callbacks, WebSocket callbacks, internal helpers, inherited SDK methods, and configured aliases were included in the review; they are not all ordinary callable RPC surfaces.
- No retry budgets were raised. Default runtime policy is sufficient for marked read observations; application deadlines remain caller-owned.
- A later successful read may see later state. Marking a read does not promise snapshot isolation across network attempts.
- Strong write candidates remain unmarked where lifecycle recreation, return flags, external effects, or concurrent updates lack an explicit replay contract.


## 1. Session-ingest: SessionAccessCacheDO

Source `src/dos/SessionAccessCacheDO.ts`; namespace helper `getSessionAccessCacheDO`, keyed by user ID. Constructor Drizzle migration runs under blockConcurrencyWhile, no externally returned resource.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `getAccess(sessionId)` | M | Reads permanent deletion fence and authorization row with `authorization_expires_at > Date.now()`. New attempt reevaluates expiry, so cannot extend a grant. Returns cloneable access-or-null, no mutation. Wrapped in `services/session-access.ts`. |
| `has(sessionId)` | M | Legacy public RPC delegates to getAccess and returns boolean. Same time-sensitive observation semantics; not a claim. Legacy mixed-version method intentionally left otherwise unchanged. |
| `add(sessionId)` | D | Legacy no-op, trivially replayable but intentionally not expanding deprecated API support. No annotation, no removal of rollout compatibility. |
| `putValidated(access)` | U | Uses Date.now()+60 seconds on every call and deletes expired rows. Replay extends authorization and can recreate authorization after `remove`/organization invalidation; scope guard only protects some identity changes. Wrapped by API, cloud-agent-session-scope, session-access. |
| `deleteSession(sessionId)` | D | Permanent synchronous tombstone, scope-key deletion, row deletion; strong write candidate, unlike remove. Existing worktree cleanup wrapper. Deferred to read-only implementation scope, no annotation needed for native transport retries. |
| `remove(sessionId)` | D | Plain delete; a delayed replay can remove a newly revalidated grant. Wrapped in session-local-state, worktree/metadata/RPC failure cleanup. Sequential idempotency is not sufficient to prove ordering with revalidation. |
| `invalidateOrganization(organizationId)` | D | Deletes current matching rows, including grants written between attempts. Wrapped by internal invalidation route; policy intent may tolerate it but not marked as unconditional whole-method idempotency. |

No application fetch/alarm/WebSocket implementation. The base-class default fetch is not a hidden domain route.

## 2. Session-ingest: SessionIngestDO

Source `src/dos/SessionIngestDO.ts` plus `kilo-sdk-materialization.ts`; helper `getSessionIngestDO`, name user/session. Constructor migrates SQLite. Reads materialize bounded SQL/R2 data; R2 bodies are consumed inside the method for cloneable results.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `ingest(payload,userId,sessionId,version,ingestedAt?,r2References?)` | U | Item upserts/timestamp guard and running cost transaction are not whole-method dedupe. Result `changes` is derived from transitions newly seen in this execution; replay can return empty changes, losing caller Postgres projection/fanout. Lifecycle replay deletes metrics-emission marker on session_open and moves close/inactivity alarms from fresh Date.now(). Attention signal changes and waitUntil live-column/glanceable work matter. R2 awaits permit concurrent ingests/deletion. Wrapped by queue-consumer and direct-ingest. No annotation. |
| `markAgentNotificationDispatched(notificationId)` | D | Synchronous identity update to dispatched, void result; plausible monotonic write candidate while identity is permanent. Deletion/clone reset removes dispatch state, so no broad replay guarantee was added. Dispatch callers invoke directly after terminal local decision. |
| `claimSessionReadyPush(userId,sessionId,title?)` | D | Writes durable once-ever marker synchronously before a waitUntil send; replay normally no-op with void return, unlike boolean claim APIs. Does not repair a lost push after marker commit; external dispatch not atomic with marker and reset semantics deserve explicit review. Called directly from UserConnectionDO. No annotation. |
| `resetAttentionStatusOnCliDisconnect(userId,sessionId)` | U | External conditional Postgres transition + notification work. A later reconnect/new attention episode may occur between attempts; request has no episode/generation token. UserConnection alarm already retains pending reset on failure. |
| `readKiloSdkSessionSnapshot()` | M | SQL/R2 bounded materialization into cloneable snapshot/failure variant; no writes. Resolver rechecks a replaced reference. RPC and route callers use withDORetry. |
| `readKiloSdkMessages(params)` | M | Read-only bounded history hydration and cursor computation. Each attempt may observe new transcript rows; no ownership claim or persistent offset is consumed. RPC/API wrappers. |
| `readSessionDiff()` | M | Reads inline/R2 current diff, bounded body and local re-read of changed R2 reference; no domain mutation. API wrapper. |
| `getAllStream(upToMessageId?)` | D | Starts fresh ReadableStream with asynchronous SQL/R2 export. Read-only but each invocation allocates another stream and starts producer work. Existing service-export wrapper only covers initial RPC; cannot resume mid-stream or freeze source across attempts. Not marked. |
| `getLiveSharedSessionStream()` | D | Snapshot/R2 read followed by new export stream; source may change at yields, independently active producers per attempt. Public share wrapper selects live/frozen branch. Not marked. |
| `captureShareInfo(publicId,duration)` | U | Recaptures current session info; upserts same ID with new capturedAt, TTL and returned cut boundary from Date.now(). Retry may silently change which messages are shared and extend expiry. API creation wraps this call. |
| `deleteShareInfo(publicId)` | D | Void fixed-key deletion, but a delayed retry can erase a newly recaptured same public ID. Existing API cleanup wrappers. New public IDs are generated by caller; no new unconditional guarantee. |
| `getSharedSessionStream({publicId,ingestedBeforeMs})` | D | Frozen message boundary but share validity is checked using current wall-clock; returns a fresh streaming producer using stored snapshot, no midstream retry. Not marked. |
| `alarm()` | L | Emits metrics/updates external systems, checks deletion and retains newer interleaved metrics deadlines. Native alarm retry is separate; lifecycle replay can rearm emissions. Not marked. |
| `isEmpty()` | M | Synchronous existence observation. No claim that emptiness remains true after response. |
| `clearIfEmpty()` | U | Check then await clear; returned boolean is consumption/claim-like and input can change between executions. Later replay might see a different emptiness state. Called by RPC cleanup wrapper. |
| `isDeleted()` | M | Synchronous permanent tombstone read. |
| `stageR2Object(params,body)` | U | Stream argument disables native retransmission; bytes input alone does not prove whole contract. Creates random reservation, CAS etag R2 writes, pending markers, tracks active promises; returns deletion-sensitive boolean. External R2 operations yield; cancellation/consumption and overlapping reservations differ per attempt. |
| `stageBoundedR2Object(params,body,maxBytes)` | U | Same plus consuming bounded multipart upload, too_large outcome, abort/delete operations. No unconditional annotation for a method whose signature permits streams. |
| `clearForWorktree(userId,sessionId)` | D | Validates fixed identity; permanent tombstone precedes cleanup, blocks new writes, waits active R2 writes, re-lists fixed prefixes. Strong idempotent void cleanup candidate; conservative read-only change leaves unmarked. Existing worktree-deletion wrapper. |
| `clear()` | D | Same tombstone cleanup but derives identity from metadata that cleanup deletes. Later attempt can lose prefix-list identity; not identical complete cleanup path. session-local-state wrapper. |
| `exportCloneBatch(cursor,limit)` | M | SQL select materializes rows, computes digest after await, returns bounded cloneable batch/cursor/digest. No consumed cursor or mutation; caller verifies digest. Clone orchestration wrapper. |
| `hasMessageItem(messageId)` | M | Read-only exact identity existence check. Export/clone wrapper. |
| `stageCloneBatch(params)` | U | Same-input sequential upserts return same cursor, but no expected-predecessor CAS: replay of older batch after newer batch rolls cloneNextCursor/digest/count back and can overwrite row contents. Completed/mismatch guards do not cover in-progress same-identity interleaving. Clone wrapper. |
| `inspectCloneStage(params)` | M | Synchronous read-only stage/identity comparison; does not acquire a claim. Clone/RPC wrapper. |
| `finalizeCloneStage(params)` | D | Same completed result is returned on replay and fixed identity/digest validated. But reset/new stage can interleave and there is no generation token; no write annotation. Clone wrapper. |
| `resetCloneStage()` | U | Wipes current SQLite clone state/rows, cancels alarm, then deletes captured R2 keys. After first completion a newer stage can arrive; delayed duplicate reset deletes it. Clone orchestration wrapper. |

### Staging caller detail

`src/ingest/stage-and-enqueue.ts` already passes `{maxAttempts:1,baseBackoffMs:0,maxBackoffMs:0}` for both stage methods. This correctly prevents application replay of the transferred stream. Native runtime cannot resend stream input. Queue-consumer item staging recreates item bytes inside its wrapper operation; `toRpcBody` may choose a stream for large data, so byte recreation and returned deletion result still deserve distinct policy. No blanket “all staging wrappers unsafe stream replay” claim applies to the already-single-attempt main staging path.

## 3. Session-ingest: UserConnectionDO

Source `src/dos/UserConnectionDO.ts`; helper `getUserConnectionDO`, keyed by user. No new annotations.

`ensureState()` is not a pure getter: first rehydration rebuilds maps and for legacy CLI attachments without heartbeatAt synthesizes `Date.now()` and persists it with serializeAttachment. It is called by all apparent read RPCs. On subsequent ordinary executions the initialization is stable; across eviction/legacy attachment conditions it is a wall-clock migration. Avoid annotating getters without separating this effect or proving it is intentionally replay-safe.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `fetch(request)` | U | WebSocketPair/accept, viewer identity replacement, connection tags/subscriptions and initial sends. A second successful upgrade is a second live resource and can replace first. Worker forwards directly. |
| `webSocketMessage(ws,message)` | L | Heartbeats, viewer subscriptions and command forwarding; many commands are non-idempotent. WebSocket argument is not replayable structured input; callback delivery policy separate. |
| `webSocketClose(ws,code,reason,wasClean)` | L | Ownership cleanup, held attention reset and fanout; callback, not ordinary RPC. |
| `webSocketError(ws)` | L | Disconnect cleanup/error path; callback, not ordinary RPC. |
| `alarm()` | L | Stale socket closure, command expiry, pending reset/ready push work, durable scheduling. Captures current clocks and external RPC work; no annotation. |
| `getActiveSessions()` | D | Aggregate read after ensureState legacy attachment migration. Direct callers; no persistent read cursor/claim. Could be a future read annotation after migration effect proof. |
| `getConnectedInstances()` | D | Socket scan/heartbeat TTL filter at Date.now after ensureState. Time-sensitive observation itself is fine; initialization effect above prevents pure-read classification here. |
| `closeViewerSockets()` | U | Closes current viewer set and returns count. Replay returns another count and can close newly authorized connections created between attempts. Internal invalidation calls directly. |
| `clearSession(sessionId)` | U | Permanent tombstone and owner/subscription removal, but also sends unsubscribe to all CLI sockets and command errors, rewrites attachments/schedules alarms. Replay repeats frames; no full idempotent externally observable guarantee. Existing deletion/local-state wrappers. |
| `notifySessionEvent(event)` | U | Updates owner status snapshot and sends event/root-status fanout; returns delivered count. Old replay can overwrite newer arrival-ordered heartbeat status and duplicate frames. session-events direct best-effort call. |
| `notifySessionRenamed(sessionId,title)` | U | Fresh rename at=Date.now, persistent offline catch-up, sends CLI event; delayed replay can restore older title over newer rename, delivered boolean changes. Direct caller policy. |
| `hasActiveCliSession(sessionId)` | D | Read after ensureState, no claim consumption; initialization caveat applies. Direct presence-gating call in dispatch. |

## 4–5. Both ConnectionTicketDO classes

Sources `services/session-ingest/src/dos/connection-ticket-do.ts`, `services/event-service/src/do/connection-ticket-do.ts`. Distinct configured classes, same public surface; both individually inspected. Both are intentionally unmarked.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `mint({userId,secret,expiresAt})` | U | Writes fixed ticket state/absolute alarm, but a duplicate arriving after consume resurrects a burned one-use credential. Per-ticket unique namespace ID reduces accidental cross-call identity reuse, not ambiguous mint/consume interleaving. No annotation despite same-input storage put. |
| `consume(secret)` | U | Storage transaction deletes ticket for every attempt, including wrong secret, validates expiry at Date.now and returns userId-or-null once. Lost successful response followed by duplicate returns null; reissuing credentials would also violate one-use intent. No annotation, no app wrapper added. |
| `alarm()` | L | Reads ticket, removes invalid/expired state using current Date.now; alarm callback retries are separate. |

Event Worker `mintConnectionTicket` creates unique ID and secret once then direct `.mint`, consume resolves ID then direct `.consume`; catches return null. Session-ingest connection-ticket factory also uses unique ID and middleware consumes directly. User-facing reconnect/reauth can create a NEW ticket; not replaying consume. Both need native identity-preserving defaults rather than app-level retries that run methods again.

## 6. Session-sync: SessionSyncDO

Source `src/dos/SessionSyncDO.ts` and `session-sync/{session,batch,blob,erase}.ts`; helper keyed tenant/session. Constructor migrations and durable recovery metadata load; no annotation. `app.ts` generic `call` uses withDORetry for nearly every data endpoint; wraps rpcError/isOverloaded mapping, timing and R2 timing aggregation. Internal tenantCall does a single RPC and returns structured unavailable/overload results, not a hidden retry loop.

`DataRateLimit.admit` is a real mutation: token bucket decremented, prepaid user credits decremented, upstream RateLimit.limit can charge blocks; clocks refill/reset windows. Therefore methods that only SELECT after admission are not pure whole-method reads. Admission failures are structured Result, not retryable thrown exceptions. serial/quotaGate orders local mutations but does not preserve an original application-call identity across separate calls; it deliberately permits read interleaving while tenant RPCs await.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `register(input)` | U | Session source binding, creator index, tenant reservation, durable reconcile intents; first result `created:true`, replay false/state may advance. HTTP status changes 201→200. Fresh created/last_write clocks only on first creation. Generic app wrapper. |
| `authorizeLive(input)` | D | Owner/deletion validation in serial gate plus first durable relayUsed=true activation. Replay revalidates deletion; stable owner result, no credential minted in DO itself. Strong candidate if activation fence contract accepted, not read-only. Live route calls directly before minting JWT. |
| `getState(input)` | U | Read after quota admission; repeats charge and can become rate-limited after first success. Generic wrapper. |
| `applyBatch(input)` | D | Explicit exact-body digest/batchID receipt dedupe and transactional position guard. Replay returns stored receipt until bounded receipt eviction; later superseded error rather than duplicate mutation. But whole method still increments admission/queue counters and can return rate limit/overload, does tenant capacity RPCs and schedules sweeps. No unconditional annotation. Generic wrapper; producer can deliberately recover via protocol. |
| `readEntities(input)` | U | Admission mutation then fresh ReadableStream page. Stream consumer errors not recovered by initial-call retry. Generic wrapper. |
| `beginBlob(input)` | U | Mints random attempt ID, generation-specific R2 key/deadline. Lost successful upload grant is replaced on next invocation by upload_in_progress (or expiry extension for unreferenced ready data); not an idempotent ticket issuer. Generic wrapper is concrete unsafe replay site. |
| `abortBlob(input)` | D | Fixed hash+attempt CAS only pending→cleaning; never aborts replacement attempt; stable null result. Repeated scheduling after current time and ACL/tombstone checks considered. Strong write candidate, left unmarked. Generic app wrapper on PUT failures. |
| `commitBlob(input)` | U | R2 HEAD/deletion yields; generation rechecked. First returns created:true, next created:false; r2Ms differs. Expiry/sweep/deletion can alter success and cleanup; generic wrapper. |
| `locateBlob(input)` | U | Quota admission + authorized key SELECT; cannot annotate as a pure getter. Generic wrapper. |
| `deleteSession(input)` | D | Permanent first deletedAt tombstone, portable content removed once, relay purge + tenant lease reconciliation, R2 cleanup. Result public state does not expose internal created flag, unlike register. Strong convergent cleanup candidate, but dependent remote watch cleanup/metrics and full result error behavior are not annotated here. Generic wrapper. |
| `eraseForUser(input)` | D | Checks creator ownership, permanent deletion and same cleanup/reconcile; void/null success, retries possible from durable erasure job. Missing session release branch can interact with tenant admission. Not a read, no annotation. |
| `alarm()` | L | TTL tombstoning, staged R2 cleanup and retry clocks, quota/relay reconciliation, external I/O; native alarm retry distinct. |

Batch internal dedupe is good and preserved; it does not make the wrapper's quota side effects disappear. Blob generation-specific CAS guards are good and preserved; they do not make begin's random grant replayable or recover a lost created flag.

## 7. Session-sync: SessionSyncTenantDO

Source `src/dos/SessionSyncTenantDO.ts`, `session-sync/user-erasure.ts`; namespace helper keyed tenant. Constructor migration seeds usage and schedules pending erasure.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `reserve(input)` | U | Transaction sets absolute per-session bytes and adjusts usage by prior delta. Sequential duplicate safe, but delayed older requested bytes can shrink/expand a later lease; no expected generation/CAS. Direct SessionSyncDO calls via tenantCall. |
| `release(input)` | D | Deletes lease if present, subtracts once, null result. Delayed replay after new reserve can release a newly established lease. Session permanent tombstones often prevent that in intended cleanup path, but generic method has no tombstone/generation guard. Direct tenantCall. |
| `trackCreatedSession(input)` | D | Insert-if-absent creator index with Date.now only on first insertion; durable user-erasure fence rejects tracking after erasure. After forget/re-track, old replay could resurrect older intent; no broad write annotation. Direct register tenantCall. |
| `forgetCreatedSession(input)` | D | Fixed target deletion; can remove interleaved re-track, so not unconditionally annotated. Direct reconciliation caller. |
| `listCreatedSessions(input)` | M | Pure synchronous SELECT/cursor or empty result when erasure fence exists. Async declaration has no awaited I/O. No claimed snapshot across writes. live route direct. |
| `eraseUser(input)` | D | Durable insert-if-absent user erasure fence, schedule Date.now()+1s if index nonempty. Repeated calls can change alarm time; separate at-least-once job checkpoints support deliberate caller recovery. internal.ts wrapper. |
| `alarm()` | L | Paged eraseForUser calls checkpoint each successful target, retry on failure via explicit alarm scheduling; separate callback policy. |

## 8. Session-sync: SessionPresenceDO

Source `src/dos/SessionPresenceDO.ts`; helper keyed user, no annotations. Constructor migration/rehydration and alarm scheduling support hibernation. Live route directly invokes all public RPCs; relay calls watch directly, serialized by relay watchSerial. No withDORetry wrapper in these live routes.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `fetch(request)` | U | Auth ticket expiry + namespace identity verification, sweep, new WebSocket/attachments, ads/connection identity, hello/control frames. Duplicate resource/connection effects, never mark. |
| `webSocketMessage(ws,message)` | L | Heartbeats/ads/commands/watch frames + current clocks and sequence counters; callback/stream resource input, not namespace replayable method. |
| `command({ticket,command})` | U | Charges rate before dedupe, sends command to runner, persists command route then registers an in-memory HTTP waiter/timer, waits up to timeout. Duplicate pending command conflicts, completed route can disappear so replay may resend; caller turns ambiguous failure into 202 unknown, correctly not application replay. |
| `webSocketClose(ws,code,reason)` | L | Connection close/broadcast/schedule. |
| `webSocketError(ws)` | L | Close/broadcast/schedule. |
| `watch({tenant,sessionID,watching})` | U | sweep, resets watch lease Date.now()+5 minutes, persists array, emits runner watch frame per invocation and schedules alarm. Same logical boolean is not a stable side-effect contract. |
| `list()` | U | Hidden sweep expires pending commands, closes ticket/heartbeat-stale sockets, emits unwatch frames and broadcasts changed instances before reading. Not a pure getter despite name. |
| `alarm()` | L | sweep + scheduling with clocks/frames, no annotation. |

## 9. Session-sync: SessionRelayDO

Source `src/dos/SessionRelayDO.ts`; helper keyed tenant/session. Constructor restores durable sequence block and purged state/attachments; no annotation. Live routes invoke directly. SessionSyncDO purge path direct plus durable retry scheduling; watch notifications use serialized direct Presence calls.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `fetch(request)` | U | Ticket auth, sweep/rate charge, replaces runner connection, accepts socket, hello/mailbox/status sends, watch refresh. New output WebSocket each attempt; never mark. |
| `purge()` | D | Permanent purged=true before transactional state/mailbox/rate reset, blocks future relay connections. Repeated socket close/unwatch calls affect Presence; waits prior watchSerial then removes successfully cleaned watch rows. Strong convergent deletion candidate, but not plain side-effect-free/idempotent read. No annotation. |
| `command({ticket,command})` | U | Rate charge + sweep + mailbox command acceptance and runner fanout; command ID retention/dedupe does not make rate/expiry/results unconditional replay-safe. Direct HTTP command route. |
| `commandStatus({ticket,commandID})` | U | Auth then sweep and takeRate(ticket,'status') before SELECT. Not pure getter; can charge repeated quota and expire state between attempts. Direct route. |
| `webSocketMessage(ws,message)` | L | Stream/event ring sequence/commands/mailbox/ACKs/reauth; callback input/resource, not namespace replayable method. |
| `webSocketClose(ws,code,reason,wasClean)` | L | Close/disconnect/status/watch effects; callback. |
| `webSocketError(ws,error)` | L | Close and alarm scheduling; callback. |
| `alarm()` | L | Sweep + reauth frame flags + watch refresh intervals, external watch calls; separate callback policy. |

## 10. Kilo-chat: ConversationDO

Source `src/do/conversation-do.ts`; namespace name conversation ID, callers often construct namespace stubs inline. Constructor migration and key prefix/monotonic ULID factory; no inherited Container lifecycle here.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `enqueueMessageWebhook(msg,context)` | U | Appends deliverToBot to in-memory ordered promise chain and waitUntil on every call. No durable operation ledger. withDORetry in services/messages.ts can cause duplicate bot execution on ambiguous delivery. |
| `enqueueActionExecutedWebhook(msg)` | U | Same no-dedupe outbound chain for action delivery; services/messages.ts wrapper also generates new executedAt in its callback on each app retry. |
| `notifyDeliveryFailed(messageId)` | U | First mutation returns changed:true, replay false. webhook/deliver.ts publishes message.delivery_failed only for true, so replay loses follow-on event. |
| `redeliverMessage(params)` | U | Clears failed flag synchronously, reserves ordered event+webhook chain slot, returns redelivered:true once. Replay returns false, or a later failure can rearm and replay redeliver again. Fresh sentAt; direct caller, not blanket wrapper. |
| `revertActionResolution(params)` | U | Removes resolution, increments version/updatedAt once, returns reverted:true once. Replay false and downstream action.delivery_failed fanout skipped by webhook/deliver.ts wrapper. Later re-resolution can be undone by old replay. |
| `initialize(params)` | D | Transaction insert-on-conflict for conversation/members with caller timestamp; mostly stable but replays after destroy/new membership operations are not generation-fenced. No annotation. |
| `getInfo()` | M | Read conversation + active member rows, cloneable result/null. Common wrapper in routes/event-push/conversations. |
| `isMember(memberId)` | M | Read active membership boolean; later attempts reevaluate revocation. |
| `createMessage(params)` | U | Generates new monotonic ULID, links attachments, bot notification claim/scheduling; R2 HEAD yields and CAS guards attachment linkage. Duplicate without attachments creates extra message, with attachments may conflict. Direct caller rather than withDORetry. |
| `getMessage(messageId)` | M | Read row/deleted visibility/content decode only; reply lookup wrapper. |
| `getLatestNonDeletedMessageId()` | M | Read latest ID; no consumed cursor. |
| `resolveMarkRead(memberId,lastSeenMessageId)` | M | Despite mutating-sounding name, checks active membership, validates marker belongs here and returns latest ID/context; no mutation. services/conversations.ts wrapper currently returns captured convStub instead of fresh factory; avoid assuming wrapper recovery refreshes that stub. |
| `listMessages(params)` | M | Materializes bounded message/reply/reaction selects and cursor in local memory only. No SQL write. |
| `listMessagesIfMember(memberId,params)` | M | Membership revalidation + list read; route/handler wrapper. |
| `editMessage(params)` | U | Client timestamp gate prevents same edit write twice but first returns stale:false with content/context, replay stale:true, so caller fanout differs. Version/Date.now, attachment deletion/R2 cleanup/notification claim side effects. |
| `notifyLatestBotMessageOnTypingStop(botId)` | U | Claims currently latest unnotified bot message and returns notified flag. Replay can target DIFFERENT newer pending message, not just return a changed flag. typing.ts wrapper. |
| `alarm()` | L | Claim due bot notifications, schedule next, sweep orphan attachments/R2. Separate callback semantics. |
| `setTyping(memberId)` | M | Name is misleading but body only gets active member context, returns ok/context or forbidden. Does not store typing, generate time or push event; caller owns fanout. services/typing.ts wrapper. |
| `deleteMessage(params)` | D | Tombstone existing message, clear attachments/notification and schedule R2 delete, same success/context if already deleted. Full domain cleanup and member-context changes across attempts left unmarked in conservative read-only patch. |
| `executeAction(params)` | U | Claims unresolved action, generates resolvedAt/version, returns content/target/context. Replay yields already_resolved and suppresses required downstream webhook/fanout. |
| `addReaction(params)` | U | Fresh ULID/reaction activation; first added:true with memberContext, replay false without context. Re-add/remove can interleave. |
| `removeReaction(params)` | U | Fresh removal operation ULID and Date.now; first removed:true with context, replay removed:false. Delayed replay after re-add removes a new reaction. |
| `updateTitleIfNullInternal(title)` | U | Claim-like applied flag true once, false on replay; services/messages.ts wrapper uses flag to decide membership title propagation. |
| `leaveMember(memberId)` | U | Fresh left_at each execution, returns CURRENT remaining/bot members; changes interleaving leave/delete cleanup decisions. |
| `updateTitleIfMember(memberId,title)` | D | Same-title write but delayed older replay can overwrite newer rename; returned current member list/authorization changes. services/conversations.ts wrapper then propagates title. |
| `leaveMemberIfMember(memberId)` | U | Membership changes first call, second forbidden; first may auto-remove bot members if last human leaves. First returned remaining/bots list drives external cleanup. |
| `initAttachment(params)` | U | Optional idempotencyKey only, otherwise fresh attachment ULID/R2 key/createdAt and orphan alarm. Even keyed reuse limited to pending+window; linked upload or window boundary changes result. handler.ts wraps regardless of key. |
| `getAttachmentForRead(params)` | M | Reads active membership and linked attachment metadata; no R2 body/stream returned or mutation. handler wrapper. |
| `destroyAndReturnMembers()` | U | R2 list/delete yields then deletes SQL and returns members ONCE; replay returns null, losing cleanup member list. index.ts intentionally does NOT wrap and explains the contract. Preserve this correct boundary. |

## 11. Kilo-chat: MembershipDO

Source `src/do/membership-do.ts`; constructor SQLite migration. Namespace keyed member ID. Most writes are only sequentially idempotent; client ordering after failures matters.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `listConversations(params={})` | M | Pure SQL coalesced-time sort/pagination, cloneable entry/cursor result. Routes, destroy-sandbox, post-message-as-user wrappers. |
| `addConversation(params)` | D | Insert-on-conflict stable timestamp/title input, but replay after remove can recreate departed conversation. No unconditional write annotation. |
| `updateLastActivity(id,at)` | U | Absolute assignment can regress activity after a newer event when old call replays. |
| `markRead(id,at)` | U | Absolute assignment can regress newer read marker. |
| `markReadAtLeast(id,at)` | U | Monotonic marker state is good, but returns applied:true only for first update. services/conversations.ts wraps and sends conversation.read only when true; replay loses that side effect. |
| `updateLastActivityAndMarkRead(id,at)` | U | Absolute assignments can regress interleaved newer message/read. |
| `updateConversationTitle(id,title)` | D | Same-input setter but stale replay can overwrite newer rename; services/conversations.ts wrapper. |
| `applyPostCommit(params)` | D | Activity/read use max-merge (replay-safe state); optional title blindly assigned, so older retry can regress title. No annotation for whole method. services/messages.ts wrapper. |
| `removeConversation(id)` | D | Delete fixed entry; stale replay can remove newly re-added conversation. destroy cleanup wrapper assumes permanent conversation deletion, but generic method lacks generation fence. |
| `removeConversationsBySandbox(sandboxId)` | D | Deletes currently matching rows; could include new conversation rows inserted between attempts. Destruction context may intentionally tolerate, not unconditional method guarantee. |

## 12. Kilo-chat: SandboxStatusDO

Source `src/do/sandbox-status-do.ts`; constructor SQLite migration, names sandbox IDs.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `putBotStatus(input)` | D | Strict incoming at > stored at predicate means exact replay does not refresh Date.now updatedAt or overwrite newer status. Strong future write candidate; destroy clears row so delayed older retry can recreate removed state. event-push wrapper; not marked in read-only patch. |
| `getBotStatus()` | M | Reads row and parses stored capability JSON, no mutation. sandbox routes/status-request wrappers. |
| `putConversationStatus(input)` | D | Same monotonic strict at guard and updatedAt behavior; destroy/recreate boundary remains. event-push wrapper. |
| `getConversationStatus(id)` | M | Read-only row projection; route wrapper. |
| `destroy()` | D | Deletes rows transactionally rather than dropping schema. Replay can delete newer post-destroy updates; no permanent tombstone. index.ts wrapper; not marked. |

## 13. Event-service: UserSessionDO

Source `src/do/user-session-do.ts`; constructor configures ping/pong automatic response, no persistence or external dispatch. Names user IDs. Worker entrypoint gets ordinary namespace stub directly for pushEvent/hasContext. No app wrapper retries for these DO calls in this service.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `fetch(request)` | U | Creates/accepts WebSocket and initializes attachment; repeat creates another live subscriber. |
| `webSocketMessage(ws,message)` | L | Subscribe/unsubscribe/ACK attachment mutation and possible zombie close; callback with socket input, not cloneable RPC input. |
| `webSocketClose()` | L | Empty required hibernation callback, no reason to mark. |
| `webSocketError(ws)` | L | Closes socket; callback. |
| `pushEvent(context,event,payload)` | U | Increments per-socket seq, persists attachments, broadcasts and potentially closes lagging socket; delivered boolean changes. Duplicate events are not safe for all payloads even if consumer sometimes dedupes. |
| `hasContext(context)` | M | Scans attachment context sets and returns boolean. Logging/tags are diagnostic only; no delivery/claim/persistent domain side effects. Fresh attempt may observe subscription changes. |

Event-service's ConnectionTicketDO is separately covered above; two distinct classes with same name are counted separately.

## 14. Notifications: NotificationChannelDO

Source `src/dos/NotificationChannelDO.ts`; no explicit constructor. Ordinary namespace-created user-keyed stubs in service entrypoint/dependency factory; dispatch/clear/list invoked directly rather than withDORetry. External producer retries and separate Expo retry logic exist but are not namespace automatic retry marks.

| Public method | Decision | Complete contract / caller policy |
|---|---|---|
| `refreshGlanceableSnapshot(params)` | U | Uses Date.now, external snapshot queries/delivery/rate/deferred refresh state; repeated call may rebuild/send different snapshot and extend schedules. No annotation. |
| `dispatchPush(input)` | U | inFlight only covers currently executing same key; persistent stages dedupe badge/accepted delivery, but not atomically with Expo send. Crash after successful send before accepted marker can resend; first delivered/suppressed/no_tokens outcome becomes duplicate. Input rate-limit/presence/tokens/locale change at external awaits and TTL eventually permits reuse. CompleteAcceptedDelivery can queue receipt checks again after queue-success/marker-failure. Not full result or external-send idempotency; never mark just because idempotencyKey exists. |
| `markBucketRead(bucket)` | U | Clears CURRENT bucket and returns CURRENT aggregate. Replay after intervening push clears newly arrived unread badges and returns different total. No read cursor/watermark/generation input. Storage I/O input gates do not impose cross-attempt operation ordering. |
| `listNonZeroBuckets()` | M | Reads storage.list and builds cloneable array, no read-repair writes or total seeding. Safe current-state observation. |
| `alarm()` | L | Flush deferred glanceable work, accepted delivery bookkeeping repair, idempotency/rate cleanup and deadline fold; external sends/queues and wall clocks, separate alarm retry contract. |

Private incrementBucket/getTotal are not callable RPCs but reviewed because dispatch and markBucketRead call them. getTotal can persist a read-repair aggregate; listNonZeroBuckets does NOT call it. dispatch's pending marker intentionally precedes badge increment, and an in-memory claim guards same-key external-await overlap. These guards are useful but do not certify exact-once external delivery or result identity across native duplicate execution.



## Gastown caller legend

Paths below are relative to `services/gastown`.
TR means `src/trpc/router.ts`; W means `src/gastown.worker.ts`.
H names a handler under `src/handlers`; M means the town authorization middleware.
T means TownDO orchestration; O/U means owner watchdogs.
SCM means the shared wrapper in `src/dos/town/town-scm.ts`; SDK means Container implementation calls.

## AgentDO — own public methods and lifecycle

Evidence: `src/dos/Agent.do.ts:22-153`; `town/conversation.ts:69-190` inspected to establish pure transcript reduction/formatting.

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| constructor (26) | L | Runtime; initializes event table/indexes inside `blockConcurrencyWhile`. No annotation. |
| appendEvent (52) | N | TownDO.appendAgentEvent → H:rig-agent-events. Each execution inserts a new autoincrement event ID, new timestamp, prunes older events; no request key or cached result. |
| getEvents (94) | R / marked | TownDO.getAgentEvents → H:rig-agent-events. SELECT/backfill only, structured data; no consuming cursor. |
| reconstructConversation (119) | R / marked | TownDO.reconstructConversation. SELECT plus pure reconstruction/formatting, no consumption or checkpoint update. |
| destroy (140) | N | TownDO.deleteAgent/destroy. Deletes alarm and all storage across awaits; repeat can erase intervening appended events/recreated state. No tombstone/generation guard. |
| ping (146) | R / marked | No production caller found; constant `{ok:true}` result, no effects. |

No own alarm, WebSocket handlers, or fetch override. Inherited platform defaults were not marked.

## AgentIdentityDO — own public methods

Evidence: `src/dos/AgentIdentity.do.ts:1-16`.

| Method | Verdict | Callers / reason |
|---|---|---|
| ping (9) | R / marked | No production caller found; constant `pong`; no storage/effects. |

No own constructor, alarm, fetch, or WebSocket callbacks; ordinary DurableObject base behavior only. The namespace helper exists for migration/future use and was left unchanged.

## GastownOrgDO — every own public method

Evidence: `src/dos/GastownOrg.do.ts:23-284`. Private getTown/getRig SELECT helpers, ensureInitialized, initializeDatabase, armWatchdogIfNeeded inspected.

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| constructor (27) | L | Runtime; guarded schema creation + watchdog initialization. |
| createTown (53) | N | TR createOrgTown; H:org-towns. Fresh generated ID/timestamps plus watchdog scheduling; duplicate creates a second town and different result. |
| getTownAsync (90) | R / marked | TR ownership/name/org deletion/create-rig checks; H:org-towns; SCM retry wrapper. After constructor initialization, private helper only SELECTs. |
| listTowns (105) | R / marked | TR listOrgTowns; H:org-towns. Non-consuming SELECT. |
| createRig (119) | N | TR createOrgRig / createRig owner branch; H:org-towns; H:mayor-tools owner resolution can create rigs. Fresh ID/timestamps and INSERT; no idempotency key. |
| getRigAsync (173) | R / marked | TR personal/org/admin rig resolver; H:org-towns / H:mayor-tools owner lookup. SELECT only after initialization. |
| listRigs (188) | R / marked | TR listOrgRigs/listRigs/ensureMayor owner context; H:org-towns / H:mayor-tools. SELECT by town only. |
| deleteRig (204) | N | TR deletion/creation rollback; H:org-towns. First result true, replay false; can delete a recreated same-ID row. |
| deleteTown (213) | N | TR org/personal owner deletion; H:org-towns. Cascades rig rows; true→false response, no generation fence. |
| ping (226) | R / marked | No production caller found; constant `pong`. |
| alarm (255) | L | Runtime watchdog; nested TownDO.healthCheck mutates alarms, and next watchdog timestamp changes. No RPC replay mark. |

## GastownUserDO — every own public method

Evidence: `src/dos/GastownUser.do.ts:26-284`. Same initialized/schema/watchdog pattern as org, not assumed from names alone; full implementation inspected.

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| constructor (30) | L | Runtime guarded schema/watchdog setup. |
| createTown (56) | N | TR createTown; H:towns. New UUID/time and watchdog; duplicate creates another town. |
| getTownAsync (88) | R / marked | TR personal owner resolver/name/deletion; H:towns / H:mayor-tools; SCM retry wrapper. SELECT only after initialized promise. |
| listTowns (105) | R / marked | TR listTowns; H:towns. Non-consuming SELECT. |
| createRig (119) | N | TR createRig; H:towns / H:mayor-tools owner branch. Fresh UUID/time; duplicate row/resource and different result. |
| getRigAsync (173) | R / marked | TR rig resolver; H:towns / H:mayor-tools. SELECT only. |
| listRigs (188) | R / marked | TR listRigs/ensureMayor; H:towns / H:mayor-tools. SELECT only. |
| deleteRig (204) | N | TR deleteRig/create rollback; H:towns. true→false response, same-ID recreation race. |
| deleteTown (213) | N | TR deleteTown; H:towns. Cascading metadata deletion; result changes, intervening state unprotected. |
| ping (226) | R / marked | No production caller found; constant `pong`. |
| alarm (255) | L | Runtime watchdog calls healthCheck then reschedules; not a pure query or fixed effect/result. |

## TownDO — every own public method

Evidence: `src/dos/Town.do.ts:239-5918`. All **118** own non-constructor public methods inventoried by targeted method-declaration grep and implementation reads. Constructors and private helpers are not public RPC candidates. All methods not explicitly marked below remain unmarked.

### Transport, initialization, draining, configuration, billing

| Method (old line) | Verdict | Callers / result/effect/concurrency reason |
|---|---|---|
| constructor (244) | L | Runtime guarded initialization: schema/indexes, config default seeding, legacy-key cleanup, persisted-state hydration and alarm arming. Not annotation target. |
| stampWastelandReported (422) | N | H:wasteland-tools after upstream done. Picks canonical bead and writes `reported_done_at`, evidence, updated_at afresh; repeat can overwrite a newer report/canonical selection. |
| fetch (587) | N | W status WebSocket forwarding. Allocates/accepts socket pair, sends initial status; GET/404 and WebSocket upgrade share one method. No whole-handler mark. |
| webSocketMessage (613) | L | Runtime; ignores client input. No RPC mark even though body is a no-op; WebSocket arguments are not replayable structured-clone-only values. |
| webSocketClose (618) | L | Runtime socket close, best effort. Not RPC/idempotency-result contract. |
| webSocketError (632) | L | Runtime closes errored socket. No RPC mark. |
| broadcastUiAction (732) | N | H:mayor and H:mayor-tools → plugin. Sends a timestamped action frame to every status socket; replay can repeat navigation/action delivery. |
| setTownId (830) | N | TR town creation, H:org-towns; internal configuration ownership. Writes memory+storage routing identity. Same value converges only without interleaved identity replacement; no reason to annotate write. |
| setDashboardContext (835) | N | H:mayor. Memory assignment + outgoing container POST; stale replay can overwrite current dashboard context and repeat push. |
| getDashboardContext (842) | R / marked | No direct production RPC caller found; returns memory context, no writes/push. |
| recordContainerEviction (856) | N | H:town-eviction ← container SIGTERM. New event, UUID drain nonce, timestamps and separate persisted writes. Replay invalidates first returned nonce. |
| acknowledgeContainerReady (877) | N | H:town-eviction ← ready/heartbeat handshake. Nonce guard helps stale calls, but clears memory+three storage keys across awaits; new drain episode can interleave and is not transactionally fenced. |
| isDraining (899) | R / marked | TR drain status; W debug; H:town-eviction. Returns flag only. |
| getDrainNonce (904) | R / marked | W debug; H:town-eviction. Returns nonce only; does not consume it. |
| getDrainStartedAt (909) | R / marked | TR drain status. Returns stored-in-memory observation only. |
| getTownConfig (913) | N | TR many queries/mutations/ownership; M; W; H:town-config/mayor-tools; T. `town/config.ts:44-56` seeds defaults to TWO storage keys when absent, so not pure read; concurrent update/destroy/reseed contract not established. |
| updateTownConfig (917) | N | TR/H:town-config/town creation/W/T. Mask-preserving read/merge/write plus billing context/estimate pushes; stale replay can clobber later edits and mutate another DO. |
| getBillingStatus (924) | N | TR billing query and T.getAlarmStatus. Hidden prepareContainerBilling writes billing owner/context, hourly estimate cache and container policy mirror; fallback degraded result can differ. Not a read-only query despite name. |
| setContainerRunPolicy (946) | N | TR pause/resume. Nested container policy mutation/possible stop+settlement then local sync; replay can stop newly resumed runtime or overwrite later policy. |
| forceRefreshContainerToken (1101) | N | TR refreshContainerToken. Mints/pushes token, persists refresh timestamp, throws on live failure; duplicate creates another token/push. |
| syncConfigToContainer (1119) | N | TR/H:town-config after edits. Resolves dynamic GitHub credentials, many set/delete env RPCs, custom-key set mutation and container POST; partial effects across awaits, no request fence. |

### Rig, wasteland, bead, convoy-edit operations

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| addRig (1230) | N | TR createRig/createOrgRig. SQL upsert has same-ID convergence but name-conflict path may delete an orphan row; returned created_at/current config/state and concurrent replacement contract not universal. `town/rigs.ts:48-117` inspected. |
| removeRig (1239) | N | TR deleteRig; H:towns/org-towns. Deletes registry/config then queries/deletes current rig beads across await; replay can erase newly created work. |
| listRigs (1257) | R / marked | W debug; H:wasteland-tools; T mayor/dispatch; TR-related context uses owner lists separately. Registry SELECT only. |
| getRigAsync (1261) | R / marked | TR getRig/updateRigConfig and H:mayor rig validation. Registry SELECT only. |
| updateRigConfig (1265) | N | TR updateRigConfig. Read/merge/update; old partial update can replace newer field values, response not cached. |
| connectWasteland (1270) | N | TR connectTownToWasteland. Upsert by supplied connection ID but returns freshly generated connected_at even when existing row retains old connected_at; complete result contract fails. `town/wasteland.ts:59-95`. |
| disconnectWasteland (1280) | N | TR disconnectTownFromWasteland. Delete-by-wasteland can remove a connection recreated between attempts; no generation fence. |
| getWastelandConnection (1284) | R / marked | TR connection query; W debug; H:wasteland-tools. Active connection SELECT only. |
| configureRig (1288) | N | TR createRig/createOrgRig; H:towns/org-towns. Persists config, updates town token, env writes, alarm scheduling, container health/start, fire-and-forget repo setup/clone. No global deduplication. |
| getRigConfig (1408) | R / marked | H:refresh-git-token; T config/mayor/scm paths. Storage get only. |
| createBead (1412) | N | H:rig-beads; TR-related flows use held/sling variants. New UUID/time, audit data, analytics and WebSocket broadcast; no idempotency key. |
| getBeadAsync (1431) | R / marked | TR get/update/admin flows; H:rig-beads/mayor-tools; T. Non-consuming SELECT. |
| listBeads (1435) | R / marked | TR listBeads/adminListBeads/getRig; H:rig-beads/mayor-tools; T. Filtered/paginated SELECT; no cursor consumption. |
| updateBeadStatus (1439) | N | TR admin fail/close; H:rig-beads; closeBead. Inserts terminal cancellation event BEFORE underlying status no-op guard; emits telemetry/WebSocket frames and can dispatch unblocked work even for repeated status. |
| closeBead (1513) | N | H:rig-beads; TR adminForceCloseBead; plugin. Delegates to full updateBeadStatus, not a harmless assignment. |
| deleteBead (1517) | N | TR deleteBead; H:rig-beads/mayor-tools. Recursive satellite/event/dependency cleanup, unhooks agents; scoped repeat returns false after row missing, can erase same-ID recreated state. `town/beads.ts:822-897`. |
| deleteBeads (1521) | N | TR delete/adminBulkDelete; H:mayor-tools. Count depends on current descendants/ownership; batch repeat changes count and can sweep newly added descendants. `town/beads.ts:905-1005`. |
| deleteBeadsByStatus (1525) | N | TR regular/admin status deletion; H:mayor-tools. Re-evaluates changing predicate and can delete additional matching rows on replay; count changes. |
| listBeadEvents (1548) | R / marked | TR getBeadEvents/getTownEvents/adminGetTownEvents; H:rig-bead-events/town-events. SELECT list only, no delivery/ack state. |
| updateBead (1561) | N | TR updateBead; H:mayor-tools. Field/dependency update logs event, terminal event insertion and unblocked dispatch. Same visible fields do not deduplicate full effects. |
| convoyAddBead (1598) | N | TR and H:mayor-tools. Submodule checks existing tracking edge before counter increment, a useful local duplicate guard; still optional dependency replacement and current total result, no concurrency/recreation fence. Conservative write exclusion. |
| convoyRemoveBead (1632) | N | TR and H:mayor-tools. Guarded edge removal/counter decrement plus removal of dependency edges; repeat after re-add targets new membership. Conservative write exclusion. |
| resetAgent (1663) | N | H:mayor-tools/plugin reset. Reads current hook, reopens work, resets attempts, adds unhook event, changes status. Replay after re-hook resets unrelated new work. |
| resetAgentDispatchAttempts (1724) | N | TR resetAgentDispatchAttempts. Resolves CURRENT hook and resets its attempts; retry can reset different newly assigned bead. |
| updateConvoy (1764) | N | H:mayor-tools. Partial SET plus fresh `updated_at`; stale replay can overwrite later changes. |

### Agent, mailbox, event producer, triage, molecule operations

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| registerAgent (1807) | N | H:rig-agents; T mayor. Fresh UUID/time, bead+metadata insertion; no request identity cache. `town/agents.ts:91-143`. |
| getAgentAsync (1811) | R / marked | H:rig-agents/mayor-tools and T. SELECT joined agent only. |
| getAgentByIdentity (1815) | R / marked | No direct production RPC caller found; SELECT identity only. |
| listAgents (1819) | R / marked | TR listAgents/getRig/adminListAgents; H:rig-agents/mayor-tools; T. SELECT only. |
| updateAgentStatus (1823) | N | TR adminForceResetAgent; T direct equivalent submodule calls. Updates status/stall timestamp based on live state; stale replay can revert a newer lifecycle transition. |
| deleteAgent (1827) | N | TR deleteAgent; H:rig-agents/mayor; T. Reopens nonterminal assignments, removes satellites, destroys AgentDO event storage. Cross-DO/await boundary and newly assigned-work hazard. |
| hookBead (1837) | N | H:rig-agents. Same-hook no-op guard exists, but replays after unhook/reassignment can reclaim a bead, unhook another agent, append audit event and arm alarm. `town/agents.ts:240-332`. |
| unhookBead (1842) | N | H:rig-agents/mayor-tools; TR admin reset. Resolves CURRENT hook, clears checkpoint and logs; replay can unhook next assignment. |
| getHookedBead (1846) | R / marked | H:rig-triage validation. Reads current agent hook and bead only. |
| getOrCreateAgent (1850) | N | H:rig-agents; T sling/scheduler uses submodule. Returns live idle pool/singletons, may create fresh agent when role/current hook/status changes. Not allocation-idempotent across concurrent use. |
| appendAgentEvent (1854) | N | H:rig-agent-events ← streaming producer. Nested AgentDO.appendEvent allocates event ID; duplicate rows and different ID. |
| getAgentEvents (1859) | R / marked | H:rig-agent-events. Nested AgentDO.getEvents is read-only and marked; no transferred capability/stream return. |
| reconstructConversation (1869) | R / marked | No direct production RPC caller found; nested AgentDO pure read, logs failure and returns empty string on error; no domain write. |
| prime (1882) | N | H:rig-agents/plugin prime. `town/agents.ts:462-548` calls `readAndDeliverMail`: closes mailbox beads before returning; replay loses originally returned mail. Important GET-shaped consuming operation. |
| writeCheckpoint (1886) | N | H:rig-agents/plugin. Replaces checkpoint on CURRENT agent without version; replay can overwrite newer progress or checkpoint for a subsequent hook. |
| readCheckpoint (1890) | R / marked | No direct production RPC caller found (internal paths call agents.readCheckpoint directly). Pure joined-agent read. |
| writeBeadEvictionContext (1899) | N | H:rig-agents ← container force-save. Appends note to CURRENT hooked bead body, logs field update; replay appends twice or affects new hook. |
| touchAgentHeartbeat (1922) | N | H:rig-agents ← periodic heartbeat. Fresh liveness watermark/time, alarm arming, instance-ID hydration/update and potential clearing of drain state; result nonce depends on live episode. |
| updateAgentStatusMessage (1972) | N | H:rig-agents/plugin. Fresh timestamp, hooked-bead audit event and socket broadcast; replay repeats event/delivery and can target new hook. |
| setAgentDispatchAttempts (1995) | N | Test-only declared helper; fixed SET but no lifecycle/version fence; not marked merely because fixture use is benign. |
| sendMail (2012) | N | H:rig-mail/mayor-tools; plugin/T. Fresh message-bead UUID, audit insertion. Duplicate mail delivery. |
| checkMail (2016) | N | H:rig-agents/plugin GET mail. `town/mail.ts:79-128` reads open messages then closes them; repeated result empty/new messages, original result not recoverable. |
| queueNudge (2025) | N | H:rig-agents; T reconciler/triage; plugin. New UUID/expiry row and optional immediate prompt delivery; first success-before-mark window can duplicate message. |
| getPendingNudges (2097) | R / marked | H:rig-agents/mayor-tools/plugin. SELECT undelivered nonexpired rows; does NOT acknowledge/mark them. |
| markNudgeDelivered (2140) | N | H:rig-agents/plugin. Fresh `delivered_at` on every call, no `IS NULL` predicate/result cache; not strict full-effect idempotency. |
| expireStaleNudges (2156) | N | T alarm. Time-dependent UPDATE/RETURNING count; replay expires later rows and returns different count. |
| submitToReviewQueue (2175) | N | H:rig-review-queue. Creates/updates review work plus analytics and alarm escalation; no complete duplicate result/effect fence. |
| completeReviewWithResult (2186) | N | H:rig-review-queue; reconciler uses submodule. Current MR/source mutations, event/log emission, unblocked dispatch on merged; partial/ambiguous duplicate not qualified. |
| agentDone (2225) | N | H:rig-agents/plugin done. Appends new `agent_done` town event each call, no unique producer id; later drain can apply twice. |
| mayorWaiting (2254) | N | H:rig-agents ← completion reporter. Guards working status and optional firedAt watermark, but absent firedAt is allowed; after a new prompt replay can flip new work to waiting. No mark on guarded lifecycle write. |
| agentCompleted (2278) | N | H:rig-agents/mayor ← completion reporter. Appends fresh event and agent.exited telemetry, resolves current mayor fallback; no producer-id dedup. |
| requestChanges (2321) | N | H:rig-agents/plugin. Fresh rework bead, dependency, town event and audit row; rereads current refinery hook. |
| resolveTriage (2390) | N | H:rig-triage/plugin. First call closes request, second throws already-closed rather than returning original success; branches also stop/reassign/nudge/send mayor messages. State guard is not complete replay result/effect support. |
| createMolecule (2680) | N | H:rig-molecules. New parent+step UUIDs/dependencies, source metadata replacement. `town/review-queue.ts:1307-1408`. |
| getMoleculeCurrentStep (2684) | R / marked | H:rig-molecules/plugin. Derives current step from existing beads, no advancement/delivery. `town/review-queue.ts:1413-1480`. |
| advanceMoleculeStep (2690) | N | H:rig-molecules/plugin. Resolves CURRENT step and closes it; replay advances another step. `town/review-queue.ts:1482-1529`. |
| getMergeQueueData (2694) | R / marked | TR getMergeQueueData. `town/review-queue.ts:1002-1175` SELECTs and transforms MR/event rows only; no provider polling, mark-read or queue dequeue. |

### Sling, mayor, convoy, escalation, health and debug

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| slingBead (2702) | N | TR sling; H:rig-beads/mayor-tools/plugin. New bead/event, agent allocation+hook, fire-and-forget dispatch and active alarm; duplicate work. |
| createHeldBead (2752) | N | TR createBead (held path); new UUID/event even while held. Holding prevents immediate dispatch, not duplicate creation. |
| notifyMayorOfNewBead (2782) | N | TR createBead background notification. Sends an LLM prompt through sendMayorMessage; replay repeats notification/work. |
| startHeldBead (2811) | N | TR startBead/create-and-start. Writes labels+audit event+timestamp and reschedules; no request result cache, subsequent label edits can be overwritten. |
| sendMayorMessage (2847) | N | TR sendMayorMessage; H:mayor; W debug; T triage/escalation/notifications. Billing setup, mayor creation, token refresh and POST prompt/start; duplicate LLM work and variable sessionStatus. |
| getMayorAgentId (3006) | R / marked | No direct production RPC caller found; reads mayor list only, despite nearby historical comment saying ensure. |
| getMayorPrewarmContext (3022) | N | W prewarm endpoint ← process-manager. Calls resolveKilocodeToken, which can persist/update town config/billing; resolves dynamic GitHub installation token via SCM/service. Not pure despite name. |
| ensureMayor (3068) | N | TR ensureMayor; H:mayor. Billing setup/warmUp, may create mayor, telemetry, status query, token/env writes and process start. Existing alive check does not prove no concurrent partial-start duplication. |
| updateMayorModel (3216) | N | TR/H:town-config. Live status query and container model PATCH; may reconfigure/restart SDK process. Repeated same model is not proof of full external effect idempotency. |
| updateMayorSystemPrompt (3265) | N | TR/H:town-config. Reads current config and writes running mayor file through container PUT; stale/config interleavings not fenced. |
| getMayorStatus (3303) | R / marked | TR/H:mayor and mayor-deletion lookup. Local agent SELECT+pure projection only; no ensure/start path. |
| createConvoy (3362) | N | H:town-convoys. Fresh convoy UUID, multiple writes with await config between, tracking edges, analytics; no transaction/request cache over full flow. |
| onBeadClosed (3447) | N | H:town-convoys. Recomputes count but broadcasts each call and may write landed timestamps/emit telemetry; current convoy result not original result. |
| closeConvoy (3511) | N | TR closeConvoy; H:mayor-tools/plugin. Closes CURRENT tracked beads, unhooks agents, updates timestamps/counters; repeat can close newly added beads/work. |
| slingConvoy (3590) | N | W debug; H:mayor-tools/plugin batch. Fresh convoy/task UUIDs, branch creation via SCM, multiple awaits/writes, event rows/alarm; new work on replay. |
| startConvoy (3841) | N | TR startConvoy; H:mayor-tools/plugin. Sets staged=0 and emits event/analytics/alarm; second execution throws `not staged` instead of same result. |
| listConvoys (3907) | R / marked | H:mayor-tools; W; detailed query/T. SELECT only. |
| listConvoysDetailed (3924) | R / marked | TR listConvoys. Calls only local list/get status reads; awaits allow fresh observations but no writes/consumption. |
| getConvoyStatus (3953) | R / marked | TR getConvoy/close/start result lookup; H:mayor-tools. SELECTs convoy/beads/dependency edges; no transition. |
| acknowledgeEscalation (4020) | N | H:town-escalations/mayor-tools/plugin. Guarded acknowledge/close state exists, BUT unconditional `escalation.acknowledged` analytics repeats; no full effect idempotency. |
| listEscalations (4046) | R / marked | H:town-escalations. SELECT/filter only. |
| routeEscalation (4066) | N | H:rig-escalations/plugin. Fresh escalation+metadata+triage request, telemetry and possible async mayor message. |
| alarm (4210) | L | Runtime tick; billing heartbeat, access gate, health/restarts, token refresh/mint, event drain+mark, reconcile/apply state, async dispatch/merge/nudge/upstream done, mail delivery, housekeeping, telemetry and WebSocket snapshot; reschedules. Not replay-safe as one RPC. |
| healthCheck (5326) | N | O/U watchdog. Re-arms missing/past alarm; returns pre-rearm `alarmSet`, so first false then repeat true even in sequential execution. Hidden write disqualifies pure-read treatment. |
| getAlarmStatus (5377) | N | TR ordinary/admin; W debug; fetch initial socket and T alarm snapshot. Without cached billing status calls getBillingStatus with setup writes; entire optional-argument method cannot be treated as pure read. |
| debugReplayEvents (5583) | N | W debug. SAVEPOINT→mutating applyEvent→await getTownConfig→reconcile→ROLLBACK. Not a pure query, crosses await with savepoint and default config seeding; concurrency/full rollback scope not proven. |
| debugDryRun (5681) | N | W debug. Same savepoint+mutation+await pattern; do not trust side-effect-free comment as replay proof. |
| debugListWastelandBeads (5729) | R / marked | W debug. SELECT and validation only. |
| debugBeadSummary (5744) | R / marked | W debug. SELECT only. |
| debugPendingNudges (5769) | R / marked | W debug. SELECT undelivered rows only; no mark. |
| debugGetBead (5793) | R / marked | W debug. SELECT bead/review metadata/dependencies or fixed error object. |
| debugAgentMetadata (5816) | R / marked | W debug; TR adminGetAgentMetadata. SELECT only. |
| debugTownEvents (5834) | R / marked | Tests/no production caller found. SELECT only, does not drain/mark event queue. |
| debugInsertTownEvent (5857) | N | Test-only public helper. Generates fresh event ID and arms alarm; duplicate producer effect. |
| debugRecordContainerStatus (5877) | N | Test-only public helper. Upsert event may update current pending observation/time; no epoch/CAS, no need to replay mutation. |
| destroy (5884) | N | TR deleteTown/deleteOrgTown; H:towns/org-towns. AgentDO destruction fanout, billing settlement then container destroy fallback, alarm deletion + deleteAll. Can destroy a replacement runtime/state after interleaving; no tombstone or cached result. |

## TownContainerDO — every own public method

Evidence: `src/dos/TownContainer.do.ts:49-801`, including ALL private billing/state helpers. The SDK source was retrieved at the pinned version, whose inherited APIs below are part of the actual callable surface.

| Method (old line) | Verdict | Callers / reason |
|---|---|---|
| constructor (65) | L | Runtime; SDK initialization/alarms then persisted env hydration in blockConcurrencyWhile. |
| setEnvVar (82) | N | T config/token/start; dispatch.ensure/forceRefresh token. Read-modify-write env map then in-memory mutation; stale replay can overwrite later secret/config value; current runtime env and next-boot env are separate. |
| deleteEnvVar (90) | N | T syncConfigToContainer. Replayed removal can delete a value installed after first attempt; no key/version fence. |
| updateRegistry (98) | N | W registry POST ← container. Whole-value overwrite; old replay can replace newer registry. |
| getRegistry (105) | R / marked | W registry GET. Storage read/default `[]` only. |
| onStart (110) | L | SDK start hooks. Can stop on access/pause, ensure/record billing start, promote running state; catches failure and stops container. Duplicate hook not an RPC query. |
| warmUp (144) | N | T scheduling/ensureMayor/sendMayorMessage/health readiness. Billing start + container start/wait; first `{coldStart:true,durationMs}` then `{coldStart:false,0}` and possible new interval after stop. |
| onStop (166) | L | SDK monitor/stop synchronization. Closes billing interval with current reason/state and remote usage effect. |
| onActivityExpired (184) | L | SDK alarm. Sets billing stopping reason then super stop; can signal runtime/settle, no mark. |
| onError (198) | L | SDK startup/port/monitor error callbacks; logs every invocation. No RPC replay mark. |
| fetch (202) | N | W WebSocket/PTY forwarding, H:town-container, TR tickets/PTY, T all container dispatch/config/health. Access/pause/billing gate, ensureBillingInterval, inherited proxy starts container and forwards mixed GET/POST/PATCH/PUT/WebSocket requests. One global mark would permit duplicate starts/messages/PTY creation/merges/tickets. |
| setBillingContext (211) | N | T.prepareContainerBilling. Writes owner/context then conditionally updates idle state; awaits and changing runtime phase mean no full atomic replay contract. |
| setBillingHourlyEstimate (219) | N | T.prepareContainerBilling. Writes estimate then current non-idle usage state; stale replay can overwrite newer estimates/state. |
| getBillingStatus (227) | N | T.getBillingStatus; own policy/heartbeat paths. getUsageState migrates/resets missing/old version and writes storage; also time-dependent projection; conservative hidden-write exclusion. |
| recordUsageHeartbeat (237) | N | T.updateContainerBilling alarm. Can create/promote interval, remote recordStart/Heartbeat/Stop, stop for credit, restore remote interval, mutate sequence/budgets. Durable pending payload helps selected retries but whole public invocation can advance next interval/sequence and result. |
| stopForBilling (314) | N | T billing enforcement; own heartbeat/destroyWithBilling. Marks current interval stopping and signals runtime; replay after restart targets new run. |
| stopForInactivity (329) | N | T.stopContainerIfIdle wrapper. Marks current interval reason and signals stop; repeat can stop replacement/newly active runtime. |
| setRunPolicy (343) | N | T.setContainerRunPolicy. Writes policy, may stop/settle current runtime, returns variable billing status; stale replay can undo resume. |
| setAccessRevoked (353) | N | T.refreshOwnerAccess. Writes access gate and possibly stops current runtime; delayed revoke replay can override newly restored access. |
| destroyWithBilling (372) | N | T.destroy. Stops, waits up to 30s, bounded settlement loop, final inherited destroy; replay can destroy replacement runtime or reattempt external settlement against changed state. |

### Billing retry boundaries examined

`ensureBillingInterval:403-455` transactionally selects/persists an epoch before remote start. `completeBillingStart:457-490` uses stable instanceId/startEpochMs and compares current epoch before marking startRecorded. `captureHeartbeat:493-562` persists/reuses pending heartbeat seq/time/usage before remote call; retries the SAME heartbeat only after a specific interval-not-found response and remote restore. `closeBillingInterval:564-660` persists stopping/pendingStop then reuses stable stop payload; interval-not-found similarly restores before retry. `destroyWithBilling:380-386` performs at most three close attempts with small delays, not generic stub-call retries. `handleSettlementFailure:669-720` increments durable failure count and eventually force-closes locally with `unsettled:true`. These are domain settlement recovery policies, intentionally unchanged. They are not proof that the ENTIRE fetch/warmUp/heartbeat/destruction method is safe to execute after arbitrary interleaving. Cross-service meter deduplication is not certified by this scope.

## Inherited Container 0.1.1 public API — all accounted

Exact source: [published declarations](https://unpkg.com/@cloudflare/containers@0.1.1/dist/lib/container.d.ts), [published implementation](https://unpkg.com/@cloudflare/containers@0.1.1/dist/lib/container.js), [npm metadata](https://registry.npmjs.org/@cloudflare/containers/0.1.1). Both declaration surface and full implementation read. Base has no `retryable` import/marks. Own overrides listed above supersede fetch/onStart/onStop/onActivityExpired/onError. No inherited function was marked globally via a subclass prototype, avoiding modifying the SDK's shared function object.

| Inherited method | Verdict | Callers / effects/result/concurrency |
|---|---|---|
| getState | N, conservative | W cloudflare-debug; T idle-stop; own heartbeat/stop polling. `ContainerState.getState` persists a new default stopped status with Date.now when absent, so hidden write, not certified pure query. |
| start | N | SDK/public exported surface; no direct service caller found. Has startup polling/retries, renews activity, schedules alarms, establishes monitor, invokes onStart (billing). |
| startAndWaitForPorts (all overloads) | N | Own warmUp; SDK containerFetch. Starts runtime, synchronizes pending stopped events, polls ports, marks healthy and invokes onStart. Not a result/effect dedup fence. |
| waitForPort | N | SDK startAndWaitForPorts. Repeated health fetches, waits and may call onError; returns tries budget, not stable result. Polling itself is SDK liveness logic, not permission to replay arbitrary HTTP mutation. |
| stop | N | Own lifecycle/billing methods; W stop debug; TR forceRestartContainer; T idle stop adapter uses stopForInactivity. Signals current runtime and synchronizes onStop/billing. A later invocation may hit a replacement runtime. |
| destroy | N | TR destroyContainer/adminForceRestartContainer; T.destroy fallback; health watchdog; own destroyWithBilling. Calls underlying container.destroy (SIGKILL) without a generation key. Destructive duplicate can kill restarted runtime. |
| renewActivityTimeout | N | SDK constructor/start/proxy/alarm; no service-direct RPC caller. Sets deadline from current clock, so duplicates extend lifespan/cost. |
| schedule | N | No service-direct caller found; public SDK surface. Fresh generated schedule ID, insert/replace row, current-time delayed schedules, sets next alarm; duplicate schedules create duplicate future work. |
| containerFetch | N | SDK fetch; no service-direct invocation found. Starts runtime if unhealthy/stopped, invokes lifecycle, renews activity then proxies arbitrary HTTP/WebSocket request; cannot mark blanket mixed transport. |
| deleteSchedules | N | No service-direct caller found; public SDK surface. Deletes current callbacks by name; later replay can delete newly scheduled tasks. |
| alarm | L | Runtime SDK alarm inherited by TownContainerDO. Persists alarm, runs due named callbacks, deletes schedules after callbacks, stop/lifecycle sync, activity expiry and rescheduling. Callback runs before deletion: existing crash/retry window is not exactly-once. SDK caps its special repeated-failure handling at MAX_ALARM_RETRIES=3 before rescheduling. |
| scheduleNextAlarm | N | SDK constructor/start/schedule/alarm. Clears/resolves timeout and writes+syncs Date.now()+ms alarm. Repeated calls reschedule and can interrupt another wait. |
| listSchedules | Read-only but unmarked | SDK API, no service-direct caller found. SELECT plus JSON parsing only; no local override/mark added to globally shared inherited function. Safe potential candidate if explicit owner-controlled override becomes warranted, not necessary here. |
| getSchedule | Read-only but unmarked | SDK alarm/public API, no service-direct caller found. SELECT plus pure conversion; same inherited-function ownership exclusion. |

Public non-method SDK fields (`defaultPort`, `requiredPorts`, `sleepAfter`, `envVars`, `entrypoint`, `enableInternet`, `pingEndpoint`, `timeout`, `resolve`) were not treated as RPC-method annotation candidates. TypeScript-private implementation methods are not exported in the typed public stub surface and were inspected as transitive effects where relevant, not annotated.



## KiloClaw caller legend

Paths below are relative to `services/kiloclaw`.
P means `src/routes/platform.ts`, through its generic shared wrapper unless identified as direct.
I means `src/index.ts`; A, C, and K mean the API, controller, and KiloClaw route files.
Q means `src/queue/snapshot-restore.ts`.

## KiloClawApp — every explicit public method

Class extends `DurableObject<KiloClawEnv>`, not Container. `loadState` 66-84 only reads storage, parses and fills in-memory fields. No constructor override, fetch override, socket handlers or inherited Container APIs.

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| ensureApp (99) | N | Creates deterministic app, POST-allocates IPs, syncs secret; flags persist after provider awaits. Concurrent calls can both pass incomplete flags. IP helper treats 409/422 as already allocated but does not prove all concurrent/lost-response allocations deduplicated. `ensureEnvKey` provider version can advance. Result appName alone does not prove all effects replay-safe. | providers/fly/index.ts:57 through provision; own alarm:339; no withDORetry around App call. |
| getEnvKey (182) | R | Validates same owner then returns cached durable key/null; no generation/provider I/O. Replay reads current key; no duplicate effect. | No production caller found (tests cover app). |
| ensureEnvKey (214) | N | Persists generated key before secret fetch, preventing two keys in ordinary interleaving, but always POSTs Fly secret and returns provider secretsVersion. Repeated same key is not same provider version/result. Adopting appName and destroy/recreate interference also unfenced. | instance/config.ts:234; reconcile.ts:326; own ensureApp:162. setAppSecret has additional provider retries. |
| getAppName (281) | R | Storage hydration and field read only. | instance/postgres.ts:121 restore fallback, direct stub. |
| getDiagnostics (289) | R | Storage hydration and field projection only. | instance.getDebugState via appStub.getDiagnostics (original instance:3008), direct stub. |
| destroyApp (304) | N | Deletes provider app then alarm/all state; 404 tolerated by helper. No generation identity: delayed replay can delete a newly ensured app after first destroy; overlapping ensure can also repopulate state. Empty-object no-op is insufficient. | No production caller found; test-only today. |
| alarm (330) | N / lifecycle | Invokes incomplete ensureApp and re-arms alarm on failure. Reconciliation trigger, not an observational read; same allocation/version caveats. Platform alarm retry semantics are separate from namespace RPC replay marks. | Cloudflare alarm delivery; ensureApp also schedules it. |

## KiloClawRegistry — every explicit public method

`constructor` 95-103 runs SQLite migrations and reads owner/migrated state under blockConcurrencyWhile; initialization, not an RPC method to mark. All public methods call ensureOwnerKey 112-121: once-only deterministic owner metadata write; owner is assigned in memory before await so mismatched concurrent callers fail. Marked lookup methods do not call lazyMigrate.

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| listInstances (125) | N | Not pure: can lazyMigrate 556-612, read Postgres/subscription, publish route, set migrated and throttle timestamp. Awaited PG work can overlap fresh destroy/publication; no frozen snapshot or full migration replay proof. | I:562,1261 withDORetry; access-gateway.ts:117 direct; instance cleanup:2648 direct; P:4230 direct. |
| listAllInstances (145) | N | Same lazy migration/publication effects, then entries+reservations+migrated observation. | P:2028 admin release inspection; P:4641,4648 admin registry dump, direct. |
| beginFreshProvision (169) | N | transactionSync and unresolved assigned-user index prevent a second executor, but first result admitted becomes conflict on same instance replay (or throw after completed). Losing admitted acknowledgement must not be turned into normal conflict or another executor. Per-org scope is assigned user, not whole organization. | P:1414 fresh provision, direct. |
| completeFreshProvision (219) | N | Calls finalizeFreshProvision(required=true): updates completed_at/updated_at on every execution, publishes/upserts routable entry. Released reservation rejects late replay. A concurrent terminal destroy can make replay throw rather than original success. | P:1855 final canonical row/subscription completion, direct. |
| repairCompletedProvision (229) | N | Explicit reconciliation operation, not blanket replay contract: boolean can change after missing reservation; released throws; refreshes timestamps, can transition failed_requires_reconciliation to completed and revive nonterminal tombstone. Correctness depends on caller's canonical-success checks remaining current. | P:1362,1436,1482,1880,1910,1967, direct. |
| failFreshProvision (239) | N | CAS in_progress -> failed_requires_reconciliation preserves failure time on immediate repeat, but no operation generation; delayed failure can target a later execution if same identity reused. Not marked in conservative read-only pass; completion/release changes accepted transition. | P:1556 provider-work failure, direct. |
| releaseFreshProvision (264) | N | Releases unresolved/completed admission with current timestamp/reason. Complete lifecycle semantics require caller-confirmed cleanup; delayed release can unblock another provider executor while canonical/provider success is in progress. No replay acknowledgement/durable original result. | P:1497,1563 cleanup/reconciliation, direct. |
| adminReleaseStuckReservation (302) | N | Atomic expectedStatus compare-and-set is concurrency-safe once, but first `{outcome:released,previousStatus}` becomes `{outcome:status_changed,status:released}`. Result is observably different; operator's cleanup assertion is external, not revalidated by replay. | P:2045 break-glass operator release, direct. |
| listProvisionReservations (341) | R | Local SQL SELECT all reservations after deterministic owner binding; no lazy migration/admission/publication. Pending admissions stay on this explicit inspection surface, not route reads. | No production caller found. |
| createInstance (413) | N | onConflictDoNothing makes repeated same insert state-safe absent interference; legacy/lazy routing publication must not become fresh-admission completion. No generation fence against late creation after a destroy with no existing entry; first-created timestamp differs depending competing insert. No mutation mark selected. | P:1489 canonical legacy recovery fallback, direct. |
| publishRecoveredInstance (434) | N | transactionSync refuses existing tombstone, creates route once. Result true can become false after concurrent destroy; caller canonical-subscription assertion isn't carried as versioned durable precondition. | P:1917 explicit subscription recovery, direct. |
| destroyInstance (464) | N | Guarded destroyed_at is stable on consecutive calls, but only route tombstone, not admission release. Cannot universally mark destructive surface without lifecycle-generation/recovery policy proof. | P:4222,4234; instance cleanup:2640,2651; direct. |
| finalizeDestroyedInstance (476) | N | Atomic route tombstone + admission release prevents delayed completion repair from resurrecting released reservation. Replays nevertheless overwrite destroyed_at each time; no original result/effect time retention. Correct targeted terminal reconciliation is not universal runtime mark. | instance cleanup:2632, direct and reattempted by retained-cleanup alarm. |
| resolveDoKey (518) | R | SQL SELECT active do_key/null; no migration or publication. | P:4359 inbound-email routing fallback, direct. |
| findInstancesForUser (532) | R | SQL SELECT active assigned-user rows; no migration or publication. | No production caller found. |

No explicit Registry alarm/fetch/socket methods. No Container inheritance or provider lifecycle methods inherited from an SDK.

## KiloClawInstance — every explicit public method

Base is DurableObject, not Container. `state.ts:241-364 loadState` performs storage reads, parsing and in-memory hydration only. In-memory hydration is not a business side effect. `getRoutingTarget` delegates to fly/docker-local/northflank adapters that project cached IDs/host/config (providers/fly/index.ts:30-48, docker-local/index.ts:438-447, northflank/index.ts:528-542); none starts a runtime.

### Routing, provisioning and configuration

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| getRoutingTarget (723) | R | Returns cached provider routing/null (fences destroying/restoring/recovering); adapters pure projection. Logs on error do not allocate/repair anything. | I:513,793,923,1044,1195 via withDORetry; P:4474 direct inbound email. |
| getProviderMetadata (748) | R | Returns provider id + static capabilities after hydration. | P:793 capability check. |
| provision (847) | N | Provider resource creation occurs before instance identity/state persistence (908-919); concurrent calls can both see isNew. Creates app/volume/project; config/profile changes, image selection, initial alarm/startAsync and event. Replay can overwrite newer config; same sandboxId result does not cover allocations/bootstrap. Registry admission protects distinct fresh HTTP executors, not duplicate RPC execution within one admitted request. | P:1522 generic wrapper; fresh canonical Postgres/subscription/registry orchestration surrounds it. |
| updateKiloCodeConfig (1079) | N | Partial durable config assignment plus live gateway config patches/signals; partial patch response includes unspecified mutable fields. Interleaving can change returned state and stale replay can overwrite newer settings. | P:2106. |
| updateExecPreset (1351) | N | Marks pending; patches gateway then clears pending flag. Replay re-signals gateway and may overwrite newer setting/clear newer pending work across awaits; response includes full current preset. Alarm reconciliation is desired-state repair, not original-request replay. | P:2199; internal flushPendingConfigToGateway. |
| updateWebSearchConfig (1404) | N | Simple assignment looks state-idempotent but partial patch returns current state; replay can overwrite a newer setting (also modified by Brave secret updates). No write marks chosen. | P:2137. |
| updateBotIdentity (1425) | N | Writes desired identity + pending, writes file on machine, clears pending. Repeated file writes and pending-flag interleaving not covered by durable request identity/result. | P:2223. |
| updateChannels (1497) | N | Calls updateSecrets, may live-patch gateway/pending flag, returns configured channel booleans. Depends on other stored secrets and running status; stale replay can undo concurrent token update. | P:2161. |
| updateSecrets (1564) | N | Merges/removes catalog/custom secrets and metadata, validates cross-secret requirements, may disable Exa mode. Returns all configured secret keys, not just request fields; concurrent edits affect result/validation and replay can overwrite newer token/removal. | P:2451; updateChannels internal. |
| updateGoogleCredentials (1719) | N | Stores credentials, resets OIDC email, enables Gmail then syncs Workspace tools; sync timestamp and gateway effects vary. Replay can re-enable after disconnect. | P:2252; A:244 direct. |
| clearGoogleCredentials (1744) | N | Clears credentials/history/OIDC, disables Gmail and syncs Workspace; replay may wipe a newly connected account/history. | P:2274; A:263 direct. |
| updateGoogleOAuthConnection (1763) | N | Normalizes scopes/capabilities but updates timestamp every call and live-syncs tools. Delayed stale status update can undo newer connection state. | P:2350; C:543,572,600,833 direct. |
| clearGoogleOAuthConnection (1803) | N | Clears connection and updates Workspace tools/sync metadata, without generation. Can erase reconnect after first clear. | P:2379. |
| updateGmailHistoryId (1825) | N (candidate only) | BigInt monotone max, state assigned before persistence, void result: best mutation candidate within one account lifetime. However clearGoogleCredentials resets account/history and method has no account/generation token, so stale prior-account replay may repopulate new/cleared account cursor. Do not mark globally. | P:2404. |
| getGmailOidcEmail (1849) | R | Pure field projection. | P:2427. |
| updateGmailNotifications (1858) | N | Absolute boolean but provision/credential guards may change after prior success, can re-enable/disable after a newer preference; full connection-state contract absent. | P:2298 enabled,2320 disabled. |

### Pairing, diagnostics and runs

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| listPairingRequests (1877) | N | Controller refresh GET may refresh cache; old-controller fallback executes script and writes KV with 120s TTL (pairing.ts:57-155). Not a proven pure read across every provider/controller. | P:2475. |
| approvePairingRequest (1882) | N | Consumes pairing code/changes authorization, fallback `openclaw pairing approve ... --notify`; success becomes missing/invalid or duplicate notification. | P:2505. |
| listDevicePairingRequests (1887) | N | Same controller-refresh/exec/KV-cache fallback as channel list (pairing.ts:267-365). | P:2529. |
| approveDevicePairingRequest (1892) | N | Consumes device request and grants credentials; replay result may differ and can overlap rotation/new approval. | P:2558. |
| runDoctor (1897) | N | Legacy Fly exec diagnostic command; no retained run identity/result, command behavior not a durable read-only RPC contract. | P:3787. |
| startDoctorViaController (1902) | N | POST spawns doctor run, optionally fixes; returns generated runId/startedAt; duplicate may return already_active or start again after first finishes. | P:3825. |
| getDoctorViaControllerStatus (1907) | N | Hidden mutation: controller/routes/doctor.ts statusResponse:326 calls markInterruptedRunIfNeeded:306; appends interrupted-run log, writes failed metadata/completedAt, syncs output metadata. Do not mark based on GET/name. | P:3858. |
| cancelDoctorViaController (1912) | N | POST cancels currently active run, no runId precondition; replay may return no_active or cancel a newer run. | P:3889. |
| startKiloCliRun (1917) | N | POST executes prompt/process; result startedAt changes, already_active after ambiguous success, may run twice after completion. | P:3928. |
| getKiloCliRunStatus (1922) | N | Controller handler reads state, but Fly HTTPS forwarding can wake a stopped machine. Cached DO status does not fence physical-stop interleaving. | P:3958. |
| cancelKiloCliRun (1927) | N | POST SIGTERM/SIGKILL current process, no immutable run id; duplicate can target a subsequent prompt/run or return changed conflict. | P:3981. |

### Lifecycle, destructive operations and observation

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| forceRetryRecovery (1932) | N | Clears recovery cooldown, schedules immediate alarm; repeated call resets later attempt cooldown/alarm and can induce new recovery work. | P:4096,5808. |
| applyPinnedVersion (1970) | N | Reads mutable rollout/KV/catalog then writes selected metadata. Null selects current rollout afresh; later replay can resolve a different image or undo newer pin. | P:5549. |
| start (2027) | N | `startInProgress` prevents simultaneous calls but returns started:false while original eventually returns true. Successful replay reports previous/current/startedAt differently, can allocate storage/runtime, repair mounts, update secret version, emit events and reset alarm. Lock does not survive eviction or serialize subsequent lifecycle. | P:4042; Q:187 direct; startAsync waitUntil internal. |
| startAsync (2379) | N | Persists starting/time/reason, resets failure-notification flag, schedules alarm + background start. Fresh-start window only suppresses recent starting state; replay after running can schedule another runtime update. No stable operation id. | P:4023; provision internal. |
| stop (2501) | N | Provider stop, stopped timestamp/event/alarm. First result stopped:true/previous running becomes false/previous stopped. Concurrent start can make delayed replay stop a new runtime. | P:4161; Q:135 direct. |
| allowProvisionReservationReleaseOnFinalize (2682) | N | Deletes retained suppression marker then mutates pending cleanup and releases registry admission if present. Marker/pending state spans bootstrap destroy finalization; stale permission replay can affect a later lifecycle, no generation token. | P:1671,1813. |
| destroy (2704) | N | Persists runtime/storage deletion pointers and destroying status, resets volume-attempt counter on every invocation, emits event, destroys chat data/resources, marks PG, wipes local state and tombstones/releases registry. After committed finalization returns 404 rather than prior DestroyResult; during pending destruction resets retry cap/counters and can duplicate cleanup/events. Delayed replay after reprovision can destroy new resources. | P:1646,1788 bootstrap cleanup; P:4205 user/operator destroy; own alarm stale-provision cleanup. |
| getStatus (2820) | N | Hidden effect maybeDispatchLiveCheck:264; updates in-memory lastLiveCheckAt and waitUntil live-check. reconcile.ts:1287 backfills persisted machine tier + PG mirror, mutates status/failure count. Retry can observe changed state and run overlapping background work after eviction. | I:457,616,726,858,1176 withDORetry; P:905,3678,3736,4275,4679; A:58,206; C:374; K:42,83; access-gateway.ts:72,96,122; Q:105 direct. |
| getDebugState (2921) | N | Same live-check mutations plus App diagnostics/read alarm; not pure despite admin/read naming. | P:4597,4914,5152 (latter two directly withDORetry); Q:156 direct. |
| getConfig (3088) | R | Pure stored config projection after hydration, no live-check or credential generation. | C:305,366; K:48 direct. |
| tryMarkInstanceReady (3125) | N | Atomic in-memory/durable flag before await prevents duplicate notification decision, but result first shouldNotify:true becomes false and would suppress caller-owned ready email. Also schedules push. Idempotent flag is not idempotent returned decision. | C:450 direct; controller checkin uses boolean for email and always other work. |
| listVolumeSnapshots (3149) | R | GET Fly snapshots for existing volume or []; no allocation or mutation. | P:4720. |
| cleanupRecoveryPreviousVolume (3156) | N | Deletes old volume+attached machine then clears pointers; result deletedVolumeId goes id -> null on replay. Across lifecycle can delete a later retained recovery volume; no passed immutable target. | P:4133; recovery.ts:49-74 implementation. |
| listCandidateVolumes (3164) | R | GET list volumes, filter terminal states, project current ID; no repair/adoption. | P:4755. |
| reassociateVolume (3182) | N | Requires stopped, validates new volume, deletes existing machine, swaps volume/region and previousVolumeId. Same request after commit throws same-volume error rather than returning original previous id. | P:4794. |
| resizeMachine (3262) | N | Validates upgrade-only policy, may extend billable volume or Northflank rollout, clears override, persists hardware/tier, syncs PG. Replay can fail sidegrade guard; previousTier/volume/clearedOverride differ. | P:5235. |
| setAdminMachineSizeOverride (3471) | N | Returns previousOverride; second run previous changes, metadata setAt changes, PG sync re-fired; stale replay can reapply after resize/clear. | P:5273. |
| clearAdminMachineSizeOverride (3533) | N | PreviousOverride result changes to null after first success; no-op still mirrors PG. Replay after a later admin set clears new override. | P:5308. |
| recordVolumeExtend (3624) | N | Returns previousVolumeSizeGb (different on replay), changes instanceType to custom, syncs PG; stale record can overwrite later tier/volume metadata. | P:5897 after direct Fly API extend. |

### Snapshot restore protocol

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| enqueueSnapshotRestore (3659) | N | Sets restoring + timestamp/prior status then queue.send; reply lost -> replay usually already-restoring error, or duplicate queue send after worker completion. Queue send's ambiguous failure rolls state back, so caller retry is not exactly once. | P:5350. |
| destroyMachineForRestore (3748) | N | Target machine from current state, delete/clear then preRestoreStatus stopped; retry during same restore often no-ops but after completion throws, and delayed invocation in a later restore can delete another machine. Missing restore-job id/generation. | Q:144 direct. |
| setPendingRestoreVolumeId (3774) | N | Assignment/void looks idempotent but status-only fence allows stale job to overwrite another restoring job's pending volume. Operation has no restore generation. | Q:180 direct. |
| completeSnapshotRestore (3785) | N | Swaps volume and previous pointer, clears job state, emits event. Retry after success throws not restoring; during another restoring generation could overwrite new job. | Q:183 direct. |
| failSnapshotRestore (3825) | N | Restores preRestoreStatus, clears pending id and schedules alarm. Immediate repeat no-op, but delayed previous-job failure can abort a new restore because only status='restoring' is checked. | Q:227 last-attempt failure; own alarm timeout. |

### Controller RPC forwarding surface

All methods below hydrate first and delegate via `instance/gateway.ts`. `callGatewayController` 88-174 does one fetch, serializes JSON, parses/validates response, and throws on request timeout/HTTP failures. It does not itself replay. Controller start/stop/restart endpoints invoke supervisor; guarded config writes can return conflict after success. No universal end-to-end request-id result cache.

| Method (original line) | Verdict | Full effect/result/concurrency evidence | Production callers / policy |
|---|---|---|---|
| getGatewayProcessStatus (3850) | N | Controller reads supervisor stats, but forwarding through Fly HTTPS can wake a stopped machine. The caller's physical-state check is outside the RPC replay boundary. | P:2585. |
| startGatewayProcess (3855) | N | POST supervisor.start; second call returns 409 already-running after prior success. | P:2673. |
| stopGatewayProcess (3860) | N | POST supervisor.stop; no run identity; delayed repeat can stop a newly started process, even if consecutive stops return ok. | P:2695. |
| restartGatewayProcess (3865) | N | POST supervisor.restart, repeats process disruption/start side effects. | P:2717. |
| restoreConfig (3870) | N | POST restores config backup and signals gateway; concurrent config edit can be reverted by stale replay, signaled result is not durable original outcome. | P:2746. |
| getControllerVersion (3875) | N (conservative) | Controller health.ts:116 calls getOpenclawVersion; openclaw-version.ts:21-39 caches a single promise per controller process and invokes `openclaw --version` (also eagerly at health-route registration). This is read-oriented, but kept outside the narrowly proved storage/HTTP-file-read set because installed CLI startup behavior is external; no claim that it is proven unsafe. | P:2648; reconcile.ts:271 calls gateway helper internally, not public RPC. |
| getGatewayReady (3887) | N (conservative) | Controller GET proxies external gateway /ready and load observations. No local mutation evident, but upstream gateway implementation not established as full effect-free/replay contract. | P:2621. |
| patchConfigOnMachine (3892) | N | POST live config patch with signal; can return void after swallowed failure. Desired state assignment alone doesn't prove repeated gateway side effects or interleaving safe. | No direct production stub caller found; internal helpers invoke gateway helper through updateKiloCodeConfig. |
| patchOpenclawConfig (3897) | N | Deep-merge config POST, gateway signal; stale patch can overwrite intervening edit, no operation result retention. | P:2840. |
| getOpenclawConfig (3903) | N | Config file read uses the controller proxy, which can wake a stopped Fly machine after an ambiguous response. | P:2773. |
| replaceConfigOnMachine (3912) | N | POST full replacement with optional etag; first success then etag conflict, or reverts concurrent edit without etag. | P:2807. |
| listAgents (3924) | N (conservative) | Read route reads config then invokes OpenClaw CLI bindings listing (controller/routes/config-agents.ts:87-101; openclaw-agent-bindings.ts:122-134; openclaw-agent-cli.ts:248-254 runs `agents bindings --json`). No binding mutation requested, but installed CLI initialization behavior is external; omitted conservatively rather than assuming GET proves purity. | P:2871; existing platform-agents.test.ts:338 expects application read retry. |
| getAgent (3934) | N (conservative) | Same external `agents bindings --agent ... --json` read boundary as listAgents; no local binding mutation, but external CLI startup semantics are not a service-owned repeatability guarantee. | P:2901. |
| updateAgent (3944) | N | Etag-guarded settings mutation; second run can return config_etag_conflict after first success. | P:2971 existing NO_DO_RETRY. |
| updateAgentDefaults (3957) | N | Same guarded settings contract; shared-config queue serializes attempts but doesn't preserve original result. | P:3006 existing NO_DO_RETRY. |
| createAgent (3970) | N | CLI creates config/workspace/session dirs; success -> agent_exists or repeated creation side effects. | P:2935 existing NO_DO_RETRY. |
| deleteAgent (3983) | N | CLI deletes config/references; success -> agent_not_found; filesystem disposition explicitly unverified, not proof of replay safety. | P:3040 existing NO_DO_RETRY. |
| updateAgentBindings (3994) | N | Guarded bindings PUT; same bindings may be logical final state but old etag fails and returned config differs. | P:3076 existing NO_DO_RETRY. |
| getFileTree (4002) | N | Directory observation uses the controller proxy; repeated forwarding can wake a stopped Fly machine. | P:3516. |
| readFile (4007) | N | File read uses the controller proxy; repeated forwarding can wake a stopped Fly machine. | P:3551. |
| writeFile (4012) | N | POST write with etag: result can become conflict; no etag can overwrite concurrent data and mtime changes. | P:3614 (previously not opted out). |
| writeOpenclawConfigFile (4017) | N | Validation-aware POST file/config write, etag and validation warnings; duplicate write can conflict or rerun validation/reload effects. | P:3644 (previously not opted out). |
| importOpenclawWorkspace (4026) | N | Multi-file write/import, counters/results depend on existing files and may overwrite intervening edits. | P:3690. |
| exportOpenclawWorkspace (4031) | N (conservative) | POST archive export returns ArrayBuffer, not live stream, but independent archive bytes/encryption/metadata can differ across executions; no snapshot/result guarantee. Not classified safe simply because read-oriented. | P:3748. |
| getMorningBriefingStatus (4036) | N | Parallel plugin/PG reads plus waitUntil lazy backfill and stale-topic PG repairs (4075-4121). Concurrent settings write can race an old observed repair. | P:3189. |
| enableMorningBriefing (4135) | N | Plugin config+cron effects and asynchronous PG mirror; optional cron/timezone defaults resolved upstream; repeated side effects/result not retained. | P:3243 plus warmup wrapper. |
| disableMorningBriefing (4155) | N | Plugin disable/reconcile plus PG mirror; stale replay can disable newer enable, repeated plugin result can vary. | P:3277 plus warmup wrapper. |
| runMorningBriefing (4170) | N | Generates/delivers briefing and may invoke models/messages; no operation id on RPC. Duplicate billable work/delivery possible. | P:3389 plus warmup wrapper (timeout explicitly disabled, network-message replay still present in baseline). |
| startOnboardingBriefing (4181) | N | Creates/returns conversation and starts async generation/loading message; no proved cross-process generation dedupe/retained original response. | P:3437 plus warmup wrapper (timeout disabled baseline). |
| updateUserLocation (4219) | N | Writes USER.md before durable location, then best-effort plugin update. Immediate equality shortcut avoids repeat but replay can skip unfinished plugin propagation or overwrite a newer location; no generation. | P:3351 plus warmup wrapper. |
| updateBriefingInterests (4249) | N | Plugin settings mutation + asynchronous PG mirror; stale replay can undo newer interest edits; full effect/result contract absent. | P:3312 plus warmup wrapper. |
| readMorningBriefing (4266) | N (conservative) | Plugin index.ts:2755-2795 resolves current date/config then readBriefingByDateKey:1723-1746; both call ensureStorage:313-316 which creates directories before reading. No generation/delivery here, but not a strictly effect-free read; deliberately omitted from narrow read-only marks. Date/config can change across executions. | P:3481. |
| restartMachine (4271) | N | Writes restarting/time/image metadata, alarm, event and background provider deployment; repeat while busy returns failure, after completion triggers another deployment. Background persisted-status guards protect teardown but not result replay. | A:108,144 direct; alarm scheduled-action callback:4619 internal. |
| notifyScheduledActionPending (4439) | N | Returns constant ok but replaces single alarm at newly computed timestamp. Repeated wake can postpone due work; lifecycle/alarm coordination, not strict same effect. | P:5962. |
| alarm (4568) | N / lifecycle | Retained registry cleanup, PG mirrors, scheduled-action apply/restart, restore timeout, pending config flush, provider reconciliation/allocation/destruction, recovery and notifications. Runtime alarms are already at-least-once; no RPC duplicate opt-in. | Cloudflare alarms; lifecycle methods arm them. |



## WastelandDO — every callable method

Source: services/wasteland/src/dos/Wasteland.do.ts; domain implementations dos/wasteland/{config,members,credentials,towns}.ts.

| Method | Verdict | Complete-contract reasoning and production callers |
|---|---|---|
| initializeWasteland | UNMARKED | Sets in-memory identity, inserts supplied primary key with fresh timestamps; a duplicate INSERT conflicts rather than returning original success. trpc/router createWasteland (~281). |
| getConfig | MARKED | SELECT; caches only wastelandId on hydration. No durable writes/external effects. Router reads/ownership, worker debug/wanted routes, SDK context loaders, registry backfill. |
| updateConfig | UNMARKED | Writes updated_at=now for any update; returns pre-update current timestamp mixed with updated fields; duplicate can return a different record and overwrite intervening edits. Router create-upstream/update/delete flows. |
| listMembers | MARKED | SELECT + schema parse. Router member/list and middleware/worker debug access checks. |
| addMember | UNMARKED | New UUID and joined_at each invocation; INSERT may duplicate or constraint-fail. Router create, addMember, connectTown auto-membership. |
| removeMember | UNMARKED | DELETE exact member ID is convergent in isolation, but no operation generation/dedup contract; conservative no duplicate write permission. Router removeMember (~729). |
| getMember | MARKED | SELECT by user. Router connectTown membership check (~957). |
| updateMember | UNMARKED | Read-modify-write + returns current row; can overwrite newer role/trust on replay. Router updateMember (~754). |
| storeCredential | UNMARKED | INSERT OR REPLACE resets connected_at and derives preserved handle/proof from existing state. Duplicate result/time differs and can overwrite token rotation. Router bootstrap/storeCredential; lifecycle-ops/persist-credential.ts69. |
| getCredential | MARKED | SELECT only; encrypted token is data, no token refresh inside method. Router credential/SDK contexts, worker wanted route, lifecycle/branch/wanted-board loaders and persist-credential read. |
| setIsUpstreamAdmin | UNMARKED | Fixed assignment is convergent absent concurrency, but returns current credential row and can overwrite later trust update. Router setIsUpstreamAdmin (~903). |
| deleteCredential | UNMARKED | DELETE can erase a subsequently reconnected credential; no generation/tombstone token. Router deleteCredential (~925). |
| connectTown | UNMARKED | INSERT OR REPLACE sets fresh connected_at and returns it; can overwrite later connection metadata. Router connectTown (~962). |
| disconnectTown | UNMARKED | DELETE can remove a newly reconnected town on delayed replay. Router disconnectTown (~986). |
| listConnectedTowns | MARKED | SELECT only. Worker debug (~115). |
| listConnectedTownsForUser | MARKED | SELECT filtered by connected_by. Router listConnectedTowns (~1007). |
| constructor | lifecycle, unmarked | blockConcurrencyWhile creates/migrates schema; not a user-call retry target. |

Caller policy: all production calls direct, default runtime limits only; no withDORetry/manual retry loop in Wasteland. SDK join/fork/PR retry convergence comments concern external DoltHub domain operations, not stub replay; entire tRPC mutation is not newly declared retry-safe. Read cache hydration does not mutate shared tables.

## WastelandRegistryDO — every callable method

Source: dos/WastelandRegistry.do.ts and dos/wasteland-registry/registry-ops.ts.

| Method | Verdict | Reason / callers |
|---|---|---|
| register | UNMARKED | INSERT OR REPLACE includes nowIso created_at each execution, resetting listing order; can overwrite newer upstream. Router createWasteland (~296). |
| unregister | UNMARKED | Deletes by wasteland ID; delayed replay could erase re-registration. Router deleteWasteland (~629). |
| setDolthubUpstream | UNMARKED | Exact set converges in isolation but can overwrite a later upstream; conservative no write annotation. Router create-upstream (~466), update config (~797). |
| listByUser | MARKED | SELECT only. Router listWastelands (~540). |
| listByOrg | MARKED | SELECT only. Router listWastelands (~539). |
| listAll | MARKED | SELECT only. Router adminList (~642); debug/registry (~121). |
| countAll | MARKED | COUNT only. Worker health (~93). |
| findByOwnerRepo | MARKED | SELECT lower(upstream) only. trpc/resolve-wasteland.ts51, called through own helper from resolveWasteland. |
| backfillDolthubUpstream | UNMARKED | Reads other DOs with awaits then writes per-row upstream and reports per-attempt updated/cleared/failed counts. “Convergent” comment is not result/concurrency idempotency: config or registry entries may change between reads/writes, and per-attempt failure counts vary. Worker POST debug/registry/backfill-upstreams (~136). |
| constructor | lifecycle, unmarked | blockConcurrencyWhile idempotent schema initialization, not stub retry. |

All callers direct, no application retry wrapper. No fetch/alarm/websocket overrides. Retired WastelandContainerDO has no implementation/caller; deletion migration retained, not resurrected.

## CodeReviewOrchestrator — every callable method

Source: code-review-orchestrator.ts, Worker index.ts.

| Method | Verdict | Complete result/effect reasoning |
|---|---|---|
| start | UNMARKED | Existing-state guard prevents simple sequential creation duplicates but result is evolving status, not original acknowledgement. Saves state before scheduling fallback alarm; partially completed schedule or overlapping work not made atomic by guard. Worker POST /review index.ts94 wrapper; retryFreshAfterInfraFailure child .start direct (~1067). |
| status | MARKED | Delegates pure getStatus, throws Review not found for missing state; no write/external calls. Primarily integration/test/legacy callable; no production stub caller found. |
| getStatus | MARKED | Optional KV read hydration into instance memory, returns projection only. Worker GET /reviews/:reviewId/status index.ts154 via withDORetry. |
| retryFreshAfterInfraFailure | UNMARKED | Consumes sandboxRetryAttempted and saves before starting another DO; first result can be true, replay false; partial failure may leave child unstarted. Worker POST retry-fresh index.ts233 via wrapper. Own child namespace starts once via default runtime. Domain scheduled fresh-session retry has bounded one-attempt flag and jitter; unrelated to automatic stub replay. |
| cancel | UNMARKED | First true vs subsequent false. Sets cancelled/status, alarm, DB update, then external interrupt; replay's terminal guard can skip unfinished interrupt/critical DB work. Worker POST cancel index.ts190 via wrapper. |
| runReview | UNMARKED | queued guard is useful but not complete idempotence. Calls external status callback, prepareSession, initiate/followup; error recovery may put state back queued for deliberate future execution. A replay could prematurely consume a scheduled retry; no durable operation-key result contract. Worker POST /review waitUntil index.ts113 via wrapper; alarm queued branch calls directly. |
| alarm | lifecycle, UNMARKED | running no-op; queued starts work; terminal deletes all storage after cleanup. Cloudflare alarm delivery/retries separate from namespace stub retryable contract. Delayed duplicate could affect fresh work, not marked. |
| constructor | lifecycle, UNMARKED | Base initialization only. |

All Worker stub calls retain the shared wrapper. Its single-application-attempt default removes ambiguous fresh-identity replay of start, runReview, cancel, and retryFreshAfterInfraFailure. Native identity-preserving transport retries remain enabled. Only status observations receive duplicate-execution marks.

## TriggerDO — every callable method

Source: dos/TriggerDO.ts. All methods use plain data; no streams/RpcTargets/pipelining, so own namespace RPCs can use native retries.

| Method | Verdict | Complete-contract reasoning / caller |
|---|---|---|
| configure | UNMARKED | SQL upsert plus KV config write, auth hashing/identity validation, fresh createdAt in KV despite SQL preserving original, active=true, and cron schedule uses clock/jitter. Duplicate can overwrite updated or deactivated config/rearm alarm. routes/api handle create/configure ~399 wrapper. |
| isActive | MARKED | Pure config SELECT projection. No current production stub caller found; public RPC available. |
| exists | MARKED | Pure config SELECT presence. api list/get-request/delete prechecks ~602/639/677 wrappers. |
| getConfig | MARKED | Pure SQL SELECT + mapping/schema parses; no backfill/cache writes. api update precheck ~531; queue-consumer ~304 via wrapper. |
| getConfigForResponse | MARKED | Pure config projection omits secret hash and derives auth flag. api GET and post-update response ~453/571 wrappers. |
| updateConfig | UNMARKED | Read/merge/hash/store SQL+KV, optional deleteAlarm/alarmRetry clear or reschedule from now. Duplicate can overwrite intervening edits or move schedule; field assignment alone not sufficient. api PATCH ~555 wrapper. |
| getAuthConfig | MARKED | Pure config projection; no hashing, secret rotation or writes. inbound.ts54 wrapper auth check. |
| captureRequest | UNMARKED | Each execution allocates request UUID + timestamp, INSERT + overflow deletion, then queue send. Duplicate delivery starts additional paid external work; no caller-supplied request dedup token. inbound.ts112 baseline wrapper default3 (unsafe). |
| invokeScheduled | UNMARKED | Each invocation captureScheduledRequest allocates UUID/inserts/queue sends; returning first request ID matters. api manual invoke ~477 explicitly maxAttempts1/base0/max0, already safe at application layer; preserve. |
| listRequests | MARKED | Pure bounded ordered SELECT (clamps requested limit), schema mapping. api list ~612 wrapper. |
| getRequest | MARKED | Pure SELECT by UUID; absent returns null. api get-request ~649, callbacks ~67, queue-consumer ~299 wrappers. |
| updateRequest | UNMARKED | Literal supplied assignment and stable success in isolation, but last-writer-wins status/session fields permit stale replay regressing completed callbacks to inprogress; callers also generate Date.now timestamps inside replay closure, so whole wrapper invocation is not idempotent. queue-consumer multiple status updates; callbacks ~95. |
| alarm | lifecycle, UNMARKED | Handles DST retry flag or creates scheduled request with random ID, queue send, lastScheduledAt and next alarm update. Native alarm at-least-once delivery already separate; no occurrence-key dedup proof, do not mark. |
| deleteTrigger | UNMARKED | deleteAll then reruns migrations; repeated delete can erase new configuration/inbound requests between attempts. api delete ~686 wrapper; return success alone not enough. |
| constructor | lifecycle, UNMARKED | Drizzle migrations under blockConcurrencyWhile, no callable RPC. |

Caller replay details:
- routes/api.ts factories create fresh own namespace stubs each wrapper attempt. Read operations safe; configure/updateConfig/deleteTrigger wrappers baseline default3 unsafe. invokeScheduled explicitly one attempt and tested existing api.test.ts530; do not claim unsafe caller there.
- inbound.ts creates a fresh stubFactory shared by getAuthConfig (safe) and captureRequest (unsafe random request+queue replay). Request body is bounded/read to string before RPC, so stream exception does not protect captureRequest from replay.
- callbacks.ts obtains one stub and captures it for getRequest/updateRequest. The new single-attempt default prevents application replay; status concurrency and queue redelivery remain separate contracts.
- queue-consumer.ts296 and675 also passes () => existing stub to reads and updateRequest; completed_at/started_at rebuilt inside retries (~56,209,267,328,531,554,626,677). Reads have no effect. Status updates are vulnerable to stale overwrite of concurrent callback transitions; no monotonic CAS guard inside DO. No mutator annotation added.
- Queue redelivery is distinct: guards skip already processed requests; inprogress with cloudAgentSessionId resumes initiate; sessionCreated/canRetryInitiate control message.retry below max attempts; KiloClaw Chat moves to inprogress before message send to avoid duplicate message. These domain guards do not dedup multiple captureRequest IDs and are not evidence to mark capture/invoke/update. Existing alarm and queue delivery semantics not redesigned in this scope.


