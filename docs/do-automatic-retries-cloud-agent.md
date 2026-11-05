# Cloud Agent Durable Object retry inventory

This is the Cloud Agent section of [the repository retry audit](do-automatic-retries.md). Method names identify the reviewed contracts. Paths are relative to `services/cloud-agent-next`.

## Caller policy legend

- **W**: `withDORetry` service logger adapter, or shared adapter used by diagnostics. Before this change: 3 application attempts, jittered base100ms/max5000ms. After this change: 1 application attempt by default; runtime owns transport retries. Wrapper still provides scopes, error conversion and logging. Each explicit application retry obtains a new stub/request identity.
- **D**: direct namespace stub call; native default retries only.
- **S2**: W with one caller-owned 2-second absolute deadline, not 2 seconds per attempt; `sandboxRpcConfig` for a complete Session transport pass / best-effort abort.
- **N2**: W with a notification deadline starting at enqueue, 2 seconds total including lane wait; AbortSignal cancels local waiting. `notification.events` has one stable delivery id created outside the W closure.
- **T**: runtime callback (alarm/WebSocket hook), not a namespace RPC retry annotation target. Alarm redelivery is its own platform contract.
- **L**: local method/dependency callback, not separately retried through namespace.

Before change, W could multiply a native 5-attempt call into up to 15 transport attempts and, more importantly, create a fresh request after an ambiguous successful mutation. After shared default1 this amplification/re-execution is removed. No caller-specific retry limit is invented.


## SandboxSessionV2 (`src/control-plane/session/session-do.ts`)

Caller source groups:
- Registration/admission: `src/session/session-registration.ts` W; `src/router/handlers/session-worktree.ts` W plus destination state reconciliation; local `createSessionWithInitialAdmission -> send` L. `registerSession` is used by fixture setups; no production external call found.
- Worker read handlers: `src/session/metadata.ts`, `src/session-access.ts`, `src/cloud-agent-child-management.ts`, router handlers session-management/session-prepare/session-questions/session-worktree/hosted-workspace-status, session registration/queue/prepared admission. W unless explicitly stated below.
- Sandbox peers: `SandboxControlV2.resolveSessionPeer` creates namespace stubs by `ownerId:sessionId`, not RPC-returned stubs. Grant/token calls D with caller timeout; notification calls N2.
- Stream routes: `server.ts`, `terminal/*`, `websocket/stream.ts` D, plus `kilo-facade/session-stream-socket.ts` W+5-second outer timeout and late socket close.

Every declared public method / hook:

| Method | Decision | Complete contract / caller policy |
|---|---|---|
| registerSession | Unmarked | Replaces registration and history marker under queue; a late retry could overwrite newer registration. Fixture D callers. |
| createSessionWithInitialAdmission | Unmarked, stable-ID replay candidate only | Intended message/registration dedup checks exist, but unseal/storage writes and queue/title/prepare/deliver effects occur across awaits. Return includes current admission state; no blanket duplicate-execution guarantee added. Session registration W. |
| registerSessionFromMetadata | Unmarked, conditional candidate | Existing same-intent replay bypasses seal unsealing; first initialization still crosses separate metadata/auth writes and queue boundaries. Session registration and worktree creation W. |
| getMetadata | **Marked** | Initialized in-memory grouped metadata snapshot, no renewal/write. All metadata callers W, and internal D/L callbacks. |
| assertCloudAgentManagementAuthority | **Marked** | Parses live stored authorization and checks current authority, no grant issuance. child-management W. |
| recordCloudAgentChildSession | Unmarked candidate | Insert-on-conflict-do-nothing and constant success are replay-friendly, but no write marking selected; unrelated child deletion/recreation could interleave. session-registration W. |
| forgetCloudAgentChildSession | Unmarked candidate | Delete keyed child + constant success, but could remove a subsequently re-registered same child. Parent registry prune W; no new duplicate permission. |
| listCloudAgentChildSessions | **Marked** | Bounded ordered DB page, no mutation. child-management W. |
| getCloudAgentSpawnRuntimeToken | Unmarked | Delegates getCloudAgentSpawnContext; renews runtime authorization through external DB. middleware/balance W. |
| getCloudAgentSpawnContext | Unmarked | Validates authority, externally renews token, rechecks authority. session-creation-preflight withControlDORetry (same shared defaults). |
| authorizeCloudAgentChild | Unmarked | External authorization/token/seal issuance; not a read. session-registration W. |
| authorizeCloudAgentWorkspaceSibling | Unmarked | External sibling authorization/token/seal issuance. callbacks/parent-workspace W. |
| issueCloudAgentMcpGrant | Unmarked | Token issuance / external authorization. Sandbox D with grantIssueTimeoutMs (30s). |
| issueRuntimeCredentialProxyGrant | Unmarked | Renews backing token and persists minted handle. Sandbox D bounded by grant issue timeout. |
| resolveRuntimeCredentialProxyGrant | Unmarked | Named resolve, but renews tokens and may call scope resolution/failure transitions. server.ts W. |
| getRuntimeToken | Unmarked | renewStoredRuntimeAuthorization can update stored authorization and metadata; external DB renewal. model-preflight W, other issuance L. |
| issueRuntimeProxyBackingToken | Unmarked | Scope validation plus runtime token renewal; external token effect. Sandbox D, 3-second member bound. |
| getRuntimeProxyDelegationExpiresAt | **Marked** | Live scope+authorization read, no renewal. Sandbox D, 3-second member bound. |
| send | Unmarked, existing ID replay contract retained | Message intent/messageId dedup and terminal-final rules are strong, but entire call also arms alarms, prepares/delivers and may generate title. queue-message/prepared-session-admission/user-facade W; create L. |
| stop | Unmarked | Settles currently open work, marks worktree interrupted, forwards abort. First true then false; duplicate after new work could stop it. router/control-plane-session W. Sandbox abort S2. |
| cancelQueuedMessage | Unmarked | First `dropped:true`, replay false; identity alone does not preserve returned claim result. session-management W. |
| answer | Unmarked | Consumes pending interaction, may admit fresh generated message ID, forwards live answer. Repeated call can return not_connected after first sent. session-questions and user-kilo-facade W; inner sandbox.answer D. |
| kiloRequest | Unmarked conservative read-forwarder candidate | Allowlisted native reads but returns generation-bound wrapper/control result, creates underlying fresh request IDs; not local read. native-live W; inner Sandbox D. |
| nativeSnapshot | Unmarked candidate | Reads bounded event pages but first flushes PartTextBuffer to storage; leave nontrivial materialization unmarked. native-event-tail W, currently captures one stub reused by getter. |
| getPendingInteractions | **Marked** | Read-only pending questions/permissions. session-questions W. |
| onRoute | Unmarked | Fenced attempt update can recover queued messages, settle, prepare/deliver and emit events. Sandbox N2; unknown route update not blanket dedup. |
| onEvents | Unmarked | Optional delivery receipt; receipted batches track committed event index, but unreceipted deltas/setup/broadcast effects mean the whole public method is not idempotent. Sandbox N2 with stable delivery identity; tests D can omit receipt. |
| onOutcome | Unmarked | Settles accepted messages idempotently but calls worktreeChanges.onOutcome even on replay; may schedule capture. Sandbox N2. |
| onWorktreeChangesReady | Unmarked candidate | Updates readiness projection and returns current subscription bool; later metadata change may alter result. Sandbox N2. |
| getWorktreeChanges | Unmarked | Delegated manager may trigger collection/seed shared snapshot/subscription; not passive. session-worktree-changes W, inner shared helper W. |
| getWorktreeFile | Unmarked | Delegated state/capture work, external/shared read path; no pure-read assertion. same handlers W. |
| refreshWorktreeChanges | Unmarked | Explicit capture refresh / generation side effects. same handlers W. |
| alarm | T | Durable outbox/report/callback repair, backstop settlement, queued transport recovery; not markable as read. |
| getSession | Unmarked candidate | Part-text flush before durable state/cost projection; no need to mark materializing reads in this conservative change. session-management W. |
| getSessionMessagesPage | Unmarked | Can fetch owned lineage (5s) and hydrate history (external I/O + persistence), then flushes buffer; read name hides effects. session-management W. |
| getSandboxStatus | **Marked** | Passive Sandbox status read; catches unavailable as snapshot. session-management W; Sandbox D. |
| getWorkspaceRuntimeStatus | **Marked** | Composes passive status + stored billing projection, no prepare/admission. hosted-workspace-status W; two parallel Sandbox D reads. |
| getPreparationAttempts | **Marked** | Read-only persisted preparation rows. session-management W. |
| getMessageResult | **Marked** | Current message state projection, no consume/claim. session-management/session-registration/prepared admission/worktree W. |
| getRuntimeAuthorizationStatus | **Marked** | Reads authorization and computes expiry, diagnostics only; does not renew. queue-message/worktree W. |
| recoverExpiredRuntimeAuthorization | Unmarked | Releases route and replaces auth/metadata; first recovered then not-needed, external unseal and current-ID fence. queue-message W. |
| closeOrgStreams | Unmarked | Closes stream/terminal sockets and returns count; repeat count differs and could close new connections. server org-removal endpoint D. |
| tryUpdate | Unmarked candidate | Callback target setter under queue, validation + metadata write; replay can overwrite a later callback target. session-prepare update adapter D. |
| deleteSession | Unmarked, explicit business replay retained | Route release, terminal settlement/outbox delivery, socket closure, storage wipe. Registered guard makes later manual delete no-op; no automatic blanket permission. session-management/worktree rollback W; inner release W currently reuses peer. |
| beginWorktreeDeletion | Unmarked | Closes sockets and returns deletion manifest/location; replay can see different children. worktree-deletion W. |
| finishWorktreeDeletion | Unmarked | Full teardown/settlement/report/callback side effects, not just delete. worktree-deletion W. |
| terminalCreate | Unmarked | Stable operationId/in-flight+persisted completion dedup exists, but wrapper generation can change and completed records are removed when terminal ends. session-terminal W, same operationId captured before call. |
| terminalResize | Unmarked | State setter plus wrapper side effects/result snapshot, repeated resize after intervening resize would overwrite it. session-terminal W. |
| terminalClose | Unmarked | Physical terminal close, mark ended, clear creation completions and close bridge; wrapper result/generation can differ. session-terminal W. |
| resolvePreviewTarget | **Marked** | Eligibility + passive Sandbox previewTarget coordinates; no compute wake. preview/route W; Session internal preview helper W to Sandbox. |
| fetch | Unmarked | Mixed `/stream`, `/terminal/browser`, `/terminal/wrapper`, status-stream WebSocket upgrade; can hydrate history/open sockets. server/terminal/websocket D; facade opener W; nested Sandbox status-stream W. |
| webSocketMessage | T | Terminal bridge message/byte forwarding; no retry mark. |
| webSocketClose | T | Terminal bridge closure handling; no retry mark. |
| webSocketError | T | Terminal bridge error handling; no retry mark. |

## SandboxControlV2 (`src/control-plane/sandbox/sandbox-do.ts`)

Namespace construction: `src/sandbox-control/stub.ts` and peer-bindings helpers create fresh namespace stubs. Worker wrapper upgrade entry points call fetch D. Session peer surfaces are explicit typed picks; data arguments are structured cloneable, no returned-stub/promise-pipeline API found.

| Method | Decision | Complete contract / callers |
|---|---|---|
| ensureAllocation | Unmarked | May pin provider, generate allocation UUID and launch physical allocation. Fixture setup D; no production external call found. |
| initializeSnapshotValidator | Unmarked candidate | Stored ref/pin/credential checks dedup same validator; can rotate credential hash when disconnected and arms alarm. VercelSnapshotBuild W, ownership wrapper. |
| getSnapshotValidatorStatus | **Marked** | Stored registration/allocation status only. VercelSnapshotBuild W. |
| confirmSnapshotValidatorStopped | Unmarked | Reference fence then provider-gone state transition/route/socket effects; not pure setter. VercelSnapshotBuild W. |
| reportProviderGone | Unmarked | No allocation argument; delayed replay could stop replacement allocation. Fixture/control diagnostics D. |
| getAllocationState | **Marked** | Allocation row + provider/config read. e2e-surface/allocation W, tests D, local projection L. |
| getStatusSnapshot | **Marked** | Reads owner+allocation and projects status/time/idle estimate; no provider probe. Session D, fixture D. |
| getWorkspaceBillingProjection | **Marked** | Reads provider pin and passive billing runtime status; no admission/start/interval creation. Session D. |
| getProviderRuntime | **Marked** | Persisted provider/allocation-name projection. Runtime reconstruction tests D; no production external call found. |
| prepare | Unmarked | Existing/failed routes start a fresh preparation attempt, token grants/network policy/physical effects; replay after failure may create new attempt. Session S2. |
| deliver | Unmarked | Generates wrapper `session.messages` sends and touchActivity; same IDs supported downstream, but not whole-method stable effects/results across allocation changes. Session S2. |
| abort | Unmarked | Current-session wrapper frame + snapshot invalidation; delayed duplicate can hit later turn. Session S2. |
| answer | Unmarked | Emits wrapper answer without whole-operation dedup. Session D. |
| release | Unmarked | Retires pending notifications, invalidates snapshots, deletes grant/route, may rebuild policy or stop sandbox, sends release. Session delete W / recovery D. |
| status | **Marked** | Reads route/allocation and stored launch metadata, pure projection; no provider action. Session S2. |
| getWrapperId | **Marked** | Queued passive current binding read. Session terminal readiness D. |
| deleteWorktreeResources | Unmarked, business replay candidate | Three-phase journaled delete with wrapper discovery/deletion or provider stop, route revocation and durable replay result. Ownership/allocation fencing protects domain retries; do not permit blind concurrent duplicate execution. Worker worktree-deletion W. |
| getWorktreeChanges | Unmarked | Adds subscription and delegates shared snapshot manager, may seed/capture. Session shared helper W. |
| getWorktreeFile | Unmarked | Adds subscription and delegate file/capture effects. Session W. |
| refreshWorktreeChanges | Unmarked | Adds subscription and explicitly refreshes capture. Session W. |
| getWorktreeRecovery | Unmarked | Adds subscription and delegates recovery logic; not a passive getter. Session W. |
| worktreeCapture | Unmarked | Generates new UUID and forwards snapshot/summary frame; physical filesystem capture effects. Session D through capture helper; wrapper reply bound 30s. |
| terminal | Unmarked | Mixed create/resize/close/connect, invalidates snapshot, new control request UUID. Session D; wrapper reply bound 30s. |
| kiloRequest | Unmarked conservative read-forwarder | Allowlisted native reads but new wrapper request IDs/pending resource lifetime; no blanket mark. Session D, wrapper reply bound 30s. |
| previewTarget | **Marked** | Off-queue route/allocation/provider coordinate read. Session preview helper W. |
| resolveCredential | Unmarked | Admission/credential resolution can renew and persist scope grants, external token service effects; not an inert read. sandbox-outbound W. |
| admitScmForward | Unmarked | Vercel identity and SCM admission resolves/persists credentials, external authority. scm-broker/vercel-admission W. |
| getRuntimeCredentialProxyFence | **Marked** | Ownership/route/member and accepted handle read + scope-view projection; lookupAcceptedHandle/readStore do not prune or write. Session resolveRuntimeCredentialProxyGrant D. |
| bindRuntimeCredentialProxyHandle | Unmarked | Rebuilds network policy then writes updated scope grant; async side effects and interleaving. Current caller is internal sendSessionPrepareWithPerSessionHandle L, not external production RPC. |
| resolveScopeHandle | Unmarked | Renewing surviving member backing token; on denial schedules failReadyRoutesForScope. Session W inside6s timeout, per-member D3s. |
| getAcceptedHandleIssuerLocator | **Marked** | acceptedHandleIssuerLocator reads/decodes store and filters expiry; no pruning/writes. Session teardown W. |
| updateNetworkPolicy | Unmarked | Rebuild/apply provider policy from live grants after ownership/containment check; external policy side effect. No production stub call found (same-named Vercel REST client is a different API); tests/internal capability remains unmarked. |
| reportStartupFailure | Unmarked | Credential/allocation fence + state transition; first true, subsequent false. startup-failure.ts route D. |
| fetch | Unmarked | WebSocket wrapper/status upgrades, authentication, accepting and attaching sockets. server/socket-admission and fixture worker D; Session status-stream W. |
| webSocketMessage | T | Wrapper frame effects, event/outcome routing, pending replies. |
| webSocketClose | T | Connection state transitions/reconnect timers, pending request settlement. |
| webSocketError | T | Delegates close. |
| alarm | T | Provider lifecycle/lease/grant/route/snapshot work; separate alarm retry behavior. |

## SandboxContainers (`src/sandbox-containers/SandboxContainers.ts`)

Caller groups: `sandbox-control/cloudflare-containers-provider.ts` (physical launch/admission/observe/stop/lease/log/read billing/snapshot); `environment-build/builder-provider.ts` (namespace by builder environment); `ContainersOutbound` (audit write); `router/handlers/session-egress-audit.ts` (read); preview route (fetch). Namespace class extends platform DurableObject; **not SDK Container**.

| Method | Decision | Complete contract / callers |
|---|---|---|
| launchWrapper | Unmarked | Queued physical startup and billing, superseded allocation destruction. Same-ref launch fences uncertain start but `started` differs on replay; delayed old ref can supersede newer allocation. Provider D. |
| launchBuilder | Unmarked | Same allocation can redeliver builder runner via exec; replay flags and physical effects differ; old ref supersession. Builder provider D, payload absolute build deadline. |
| observe | **Marked** | Reads record + physical running bool, never launches/stops. Native provider W. |
| recordEgressRequest | Unmarked globally; explicit bounded W safe | Stable requestId dedup, constant stored record within60s retained window, but public method accepts arbitrary older identities beyond pruning. ContainersOutbound explicit3 application attempts/5s scope, identity allocated once outside closure; >=60s minimum retention. This narrow existing exception is retained. |
| getEgressAudit | **Marked** | Serialized bounded page from read-only cache/load, no pruning in getter. session-egress-audit W. |
| schedule | Unmarked | Relative delay recomputes dueAt, overwrites callback task and returns new time; retry extends/replaces task. Internal billing controller L. |
| deleteSchedules | Unmarked | Async waitUntil cancellation of named callback; replay could cancel newly installed schedule. Internal billing L. |
| getState | **Marked** | Status and observed time / last measured stop boundary, no interval mutation. Billing heartbeat L; fixture D. |
| alarm | T | Dispatches due scheduled callbacks and completes claimed entries only on success; separate durable alarm redelivery. |
| configureBilling | Unmarked | Prepares size/identity and lifecycle attribution, schedules/settles billing. Provider W. |
| ensureBillingAdmission | Unmarked | Capacity/budget admission and active generation/attribution writes; may settle/start meter interval. Provider D (fail closed). |
| isBillingBlocked | **Marked** | Adapter lifecycle getBillingBlock read only. Provider D. |
| isContainerRunning | **Marked** | Synchronous physical running read wrapped in Promise. Billing host L / tests D. |
| fetch | Unmarked | Arbitrary preview HTTP methods, streams and WS; upstream side effects not idempotent despite outer allocation fence. preview route D, no application replay of physical fetch. |
| forceDestroyForControlPlane | Unmarked | No allocation ref; destroys whichever current container then settles billing. Replay could destroy replacement; tests/internal billing host L. |
| getBillingRuntimeStatus | **Marked** | Adapter/lifecycle reads persisted block/context+running; constructing cached lifecycle installs callbacks only, does not admit/start/settle. Native provider D. |
| billingForceStop | Unmarked | Generation-fenced billing lifecycle can physically destroy/settle and schedule retries. Internal scheduler L. |
| stop | Unmarked candidate | Allocation-fenced queued destroy and settlement; returns terminal/retryable and terminal record. Domain provider stop ladder handles retryable status, not transport annotation. Native/builder provider D. |
| ensureLeaseAtLeast | Unmarked | `setInactivityTimeout(ms)` measured from call time, replay renews lease; despite setter-like name not fixed absolute expiry. Native provider W (initial post-launch D), builder D. |
| readLog | Unmarked conservative candidate | Restricted read-only tail, but starts a fresh physical exec/output pair with resource lifetime; no need to mark physical command API. Native provider D. |
| captureSnapshot | Unmarked | Persisted captureId/inflight/issued journal avoids intentional resnapshot; partial capture state can return uncertain after restart, and physical operation has5m budget. No whole-contract duplicate permission. Native/builder provider D. |
| currentImage | **Marked** | Synchronous deployed image selection only. Snapshot provider and environment compatibility D. |
| readCapture | **Marked** | Reads capture record + local in-flight presence, projects pending/uncertain/result without new capture. Fixture/diagnostic callers D; production provider uses captureSnapshot's stored replay. |

Billing helper dynamically installs heartbeat callbacks on the host for local alarm dispatch; they are not additional declared prototype RPC methods and are not annotated. The explicit billingForceStop prototype entry is audited above. No SDK inherited method is implicitly assumed safe.

## EnvironmentBuild (`src/environment-build/environment-build-do.ts`, coordinator.ts)

| Method | Decision | Complete contract / callers |
|---|---|---|
| requestBuild | Unmarked | Stable requestId dedup, but first `created:true` vs replay false; capacity/external input lookup, random build identity, alarm. router/handlers/environment-build W. |
| status | **Marked** | Compatibility currentImage read, stored build/published/backoff projection; coordinatorFor only lazy initialization/migrations. environment-build handler W. |
| logs | **Marked** | Stored bounded log page, cursor/complete flags only. same handler W. |
| cancel | Unmarked | queued->canceled or active->stopping; returns canceled/canceling then not_active. same handler W. |
| environmentDeleted | Unmarked | Live PostgreSQL existence gate, deletion mark, active transition and alarm; repeated notices mutate timestamps. notifyEnvironmentDeleted W, web router sends HTTP notification via shared client (not direct DO capability). |
| resolveSnapshot | Unmarked | May admit a replacement background build with fresh ID, automatic backoff, and a result that changes from admitted to active. Snapshot lookup now performs one bounded namespace call and uses the image fallback after exhaustion. |
| runnerInput | Unmarked | Decrypts secrets, resolves SCM credentials; failures transition build to stopping/failure. authenticated environment-build/routes D. |
| runnerEvents | Unmarked | Sequence avoids duplicate logs but always updates heartbeat time and may renew lease; extends liveness on replay. same routes D. |
| runnerResult | Unmarked | Partial state-based replay acknowledgment, but capture UUID, state transition/failure and alarm; eventual terminal state can refuse gone. same routes D. |
| alarm | T | Advances physical build/snapshot/publish/cleanup, durable domain retry; no transport mark. |

Coordinator deadlines include absolute `build.deadline_at` propagated into builder launch and runner input. Completion/result and cleanup retries are build state-machine behavior, not reasons to permit arbitrary repeated namespace delivery.

## VercelSnapshotBuild (`src/persistence/VercelSnapshotBuild.ts`)

| Method | Decision | Complete contract / callers |
|---|---|---|
| start | Unmarked | Generation/owner fences and deterministic builder names protect business reconciliation, but terminal build row can be erased and same input can then start anew; credential fetch, cleanup and alarm effects. server.ts W, stub helper getByName(ownerKey). |
| cleanup | Unmarked | External managed session/snapshot deletion, ownership checks before/after awaits, erases state/alarms; not merely a DB delete. server.ts W. |
| alarm | T | Build phases execute commands, start validator, snapshot, project PostgreSQL status and cleanup. Existing state journals/reconciliation remain. |

Outgoing SandboxControl calls: initializeSnapshotValidator W inside ownership-wrapped external op; getSnapshotValidatorStatus W; confirmSnapshotValidatorStopped W. Alarm retry delays `[1s,5s,15s,30s,60s]` are independent domain backoff. They are not changed or multiplied by the shared default. External REST calls are not Durable Object namespace retries.

## UserKiloFacade production + subclass fixture

| Method | Decision | Complete contract / callers |
|---|---|---|
| fetch | Unmarked | Authenticated mixed native read/write handlers, prompt/command/answer routes and SSE streams; one mark would apply to all. server routeToUserKiloFacade D uses sanitized forwarded request (stream request body can itself disable native replay). |
| openPublicGlobalEventStream | Unmarked | Allocates subscriber UUID, heartbeat/tail resources and response stream; optional function argument also makes that call ineligible for native resend. Production internal L via handleGlobalEventRequest; test worker D. |
| openPublicSessionEventStream | Unmarked | New subscriber/stream and optional live native tail resources. Production L; test worker D. |
| publishCloudAgentExtensionEvent | Unmarked | Live broadcast has no durable delivery dedup, duplicate events observable. No production namespace caller found in repository (public capability still unsafe). |

Fixture `test/test-worker.ts::UserKiloFacade` overrides constructor only; inherits all four methods unchanged and has the same decision. No inherited mark unexpectedly flows into a different override.

Facade's outgoing Session calls: send W with stable immutable messageId; answer W unsafe to application replay (fixed by shared default1); kiloRequest W via native-live; nativeSnapshot W via native-event-tail; socket fetch W+5s via session-stream-socket. Identity resolve loop in native-event-tail is a session-ingest *service binding* read (not a new local DO class), bounded by IDENTITY_RESOLVE_DEADLINE_MS, and is not changed by local DO marks.

## StreamTicketNonceDO

| Method | Decision | Complete contract / callers |
|---|---|---|
| consume | **Unsafe, unmarked** | Transactional one-time claim: true first, false thereafter. Retrying after committed ambiguous delivery could incorrectly deny ticket. consumeStreamTicketNonce creates direct namespace stub and calls once; invoked by stream/terminal/preview admission. Native same-identity protection is appropriate. |
| alarm | T | Deletes used nonce after expiry; separate platform alarm callback. |

## E2eCallbackSink (e2e binding only)

| Method | Decision | Complete contract / callers |
|---|---|---|
| register | Unmarked | Resets createdAt/expiry/count and alarm; late retry could erase counted progress/extendTTL. e2e-surface/callbacks D. |
| append | Unsafe, unmarked | Increments count and stores another arrival even for identical body, bounded50 records; callback duplicates are observations, must not fabricate by transport replay. same surface D. |
| read | **Marked** | Owner/expiry check and bounded record list; no consumption/deletion. same surface D. |
| remove | Unmarked | Deletes storage/alarm but first ok:true then not_found; retries do not preserve result. same surface D. |
| alarm | T | TTL deleteAll, separate alarm semantics. |

## FakeLlmState (deployed deterministic fake)

Only declared public method `fetch`: **unmarked**. Delegates mixed model SSE/JSON responses and admin state mutation/reset/release/gate/count routes, persists core after handler completion. Repeated request changes scenario counters and can create a second stream; response may outlive handler. Worker default fetch creates `FAKE_LLM.get(idFromName('fake-llm'))` and forwards directly; request-body streams can rule out native replay. `persist` is private. Constructor hydrates under blockConcurrencyWhile. No mark on universal fetch.

## PreviewPortTestDO (integration fixture)

| Method | Decision | Complete contract / callers |
|---|---|---|
| configure | Unmarked harmless candidate | No-op Promise used by fixture setup; no real availability benefit from adding mark solely to no-op. preview-port integration tests D. |
| fetch | Unmarked | Custom preview responses include WS echo and gated/chunked streams with module-level gate ownership. preview-port tests and test worker D. |
| fetchPreview | Unmarked | RPC forwards to fetch and allocates WS/stream resources; return transport state differs. test helper D. |
| releaseStream | Unmarked | Consumes current module-level release gate and sets null; delayed replay could release a different pending stream. test helper D. |

## Retired classes

Abstract RetiredSandboxTombstone has only no-op alarm. Exported SandboxContainment and SandboxSmallContainment inherit it unchanged. There are no current bindings/callers or other declared methods; preserved only for stored-instance deployment compatibility. No annotation. Historical migration names for classes already deleted are not additional live implementations.

## Deadlines, wrapper interactions and residuals

1. Session->Sandbox status/prepare/deliver share one2s pass deadline; best-effort abort after durable cancellation has its own2s bound. `scope` stops local waiting/backoff, not remote execution. Runtime first attempt may still finish after2s; IDs/fences and queued recovery remain essential. Default native10s is **not** a total application deadline. Do not replace absolute scope with runtime timeoutMs alone.
2. Sandbox->Session notifications begin2s deadline at enqueue, including queue wait/coalescing. Per-selected item signal/deadline is retained in W. Event delivery id remains stable for that invocation. Runtime or remote completion after2s is still possible; retirement/deadline is not proof of cancellation. onEvents remains unmarked because receipt is optional and not all effects transactional with receipt.
3. Runtime credential scope lookup: Session wraps the entire W chain in6s; each Sandbox candidate backing renewal has3s. The outer withTimeout does not stop already started RPC. With default1 no later independent application attempt starts, but native retry/remote work can finish later. Existing revalidation prevents stale binding from serving.
4. Scope grant/MCP mint calls have grantIssueTimeoutMs=providerStopAttemptMs30s; provider stop/observe/lease calls also bounded30s. Wrapper worktree/terminal/native reads await a30s control request outside serial queue. Timeout is local; no implication of remote idempotency.
5. Session history lineage lookup5s, hydration has its own existing bound and storage behavior; excluded from marks. Facade Session stream open5s uses late socket closure on eventual successful return. Same captured stub was historically returned on every W attempt; default1 removes that ineffective refresh issue without a broad refactor. nativeSnapshot similarly captures a stub once; no independent retry anymore.
6. Native Containers: probe/call5s; log read has5s exec and5s output awaits; destroy30s; capture5min. Builder/wrapper payloads include absolute launch/build deadlines, and DO checks these before physical calls. `ensureLeaseAtLeast` renews relative inactivity timeout and must not be marked a setter.
7. Only retained explicit app retry: ContainersOutbound audit write3 attempts, jittered base100ms/max500ms, absolute5s scope. Stable requestId created once; EgressAuditStore keeps records >=60s even during rollover, inserts by requestId under serial queue. Overload propagation was missing through sanitized error; now copied alongside retryable so shared `.overloaded===true` exclusion works. No outbound HTTP retry is added.
8. Environment snapshot lookup performs one application call. Native retries retain its identity; an exhausted error uses the existing image fallback without replaying build admission. The original launch deadline still bounds local waiting and does not cancel coordinator work.
9. Other loops found are not DO transport retry wrappers: route policy apply attempts, artifact download retries, model validation, JWKS fetch, title generation, provider stop ladder, and session-ingest root identity reads. They are independent domain/HTTP operations and remain outside conservative annotation scope.
10. No code uses custom namespace retry settings; default5/10s runtime policy remains. No retry values are guessed to match outer deadlines because runtime timeout only cancels retries, not initial attempt. Streaming fetches and returned sockets are intentionally not marked even where an individual GET route would be passive.

