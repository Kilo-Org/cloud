import type { DeciderCase } from '../decider-cases';

const SYS_SYS =
  'You are a precise systems engineer. Answer with only what is asked, no explanations.';

export const PLANNING_DESIGN_V2_CASES: readonly DeciderCase[] = [
  {
    id: 'plan-steps-v2-ready-set-order',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan a dependency-safe implementation order. Prerequisites: A requires D; B requires nothing; C requires B; D requires nothing; E requires A and C; F requires C; G requires E and F; H requires D. Repeatedly take exactly one ready task, choosing the alphabetically smallest task in the current ready set, then immediately recompute readiness. Do not sort whole waves. Return only the JSON array of task letters.',
    check: { kind: 'json_equal', value: ['B', 'C', 'D', 'A', 'E', 'F', 'G', 'H'] },
  },
  {
    id: 'plan-steps-v2-critical-path-lag',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Find the earliest completion time of H, starting at time 0 with unlimited engineers. Tasks are non-preemptive. A takes 4 hours; B takes 6; C takes 3 after A; D takes 5 after both A and B, with an additional 2-hour waiting period after B finishes; E takes 2 after C; F takes 4 after D and E; G takes 2 after B; H takes 3 after F and G. All other dependencies have zero waiting period. Answer only the number of hours.',
    check: { kind: 'exact', value: '20' },
  },
  {
    id: 'plan-steps-v2-resource-constrained-schedule',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Schedule these tasks on two identical engineers from time 0. Each task occupies one engineer for its entire duration. Whenever engineers become free, mark all tasks finishing at that time complete, then assign ready tasks alphabetically until no assignment is possible. Never preempt or deliberately idle an engineer when a task is ready. A: 4 hours, no dependencies. B: 7 hours, none. C: 3 hours, after A. D: 2 hours, after A. E: 5 hours, after B and C. F: 1 hour, after D and E. Answer only the finishing time of F in hours.',
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'plan-steps-v2-maintenance-batch-floor',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan maintenance of all 23 identical servers. At least 17 must remain online at every instant. Each server needs exactly 7 minutes offline. A wave can maintain several servers simultaneously, but every wave must finish before the next starts; there are no other costs, and servers can be reused immediately. Choose the largest legal waves to minimize total elapsed time, including the partial final wave. Answer only the number of minutes.',
    check: { kind: 'exact', value: '28' },
  },
  {
    id: 'plan-steps-v2-pooled-canary-budget',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A staged rollout has observed 2 failed requests out of 200, then 5 failures out of another 500. The next stage will observe exactly 300 more requests. The release gate uses the pooled failure count over all three stages, not the mean of stage percentages, and passes when the failure rate is at most 1.2%, including equality. What is the greatest integer number of failures allowed in the next stage? Return only that integer.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'plan-steps-v2-expand-contract-sequence',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose the only safe sequence for renaming a required database column during rolling deployment. Old binaries read and write old_name. New binaries can support both columns. No write pause is allowed, and rollback to old binaries must work until step 4 completes. Step E adds nullable new_name; D deploys transactional writes to both names; B backfills historical new_name while dual writes continue; V validates parity; R switches reads to new_name; C removes old_name only after old binaries and the rollback window are gone. Options: A = E,B,D,V,R,C; B = E,D,B,V,R,C; C = E,D,R,B,C,V; D = D,E,B,V,C,R. Return only the option letter.',
    check: { kind: 'exact', value: 'B' },
  },
  {
    id: 'plan-steps-v2-surge-rollout-duration',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A rollout must replace all 12 old replicas while retaining at least 12 ready replicas. Up to 3 extra replicas may exist, including draining replicas. A wave starts the largest legal number of new replicas simultaneously; they take 5 minutes to become ready. It then drains the same number of old replicas for 2 minutes; draining replicas provide no capacity but still consume slots. Start the next wave only after those old replicas are removed. Nothing overlaps between waves. What is the minimum total rollout duration in minutes? Answer only the integer.',
    check: { kind: 'exact', value: '28' },
  },
  {
    id: 'plan-steps-v2-risk-reduction-priority',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Order mitigations by descending expected loss prevented per engineer-day. A prevents a probability-0.2 loss of 100 units and costs 4 days. B prevents a probability-0.6 loss of 30 and costs 3 days. C prevents a probability-0.1 loss of 200 and costs 2 days. D prevents a probability-0.4 loss of 60 and costs 8 days. Each mitigation fully prevents its listed loss, and their risks are independent. Return only the JSON array of letters, highest priority first.',
    check: { kind: 'json_equal', value: ['C', 'B', 'A', 'D'] },
  },
  {
    id: 'plan-steps-v2-prerequisite-portfolio',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Select a project portfolio with at most 9 engineer-days, maximizing total delivered value; unused days have no value. Projects are indivisible: P costs 2 and yields 4; Q costs 3 and yields 8 but requires P; R costs 4 and yields 11; S costs 3 and yields 6 but requires R; T costs 2 and yields 5. Prerequisites consume their own costs and contribute their own values. Choose among these feasible options: A = P,Q,T; B = P,Q,R; C = R,S,T; D = P,R,T. Answer only the letter.',
    check: { kind: 'exact', value: 'B' },
  },
  {
    id: 'plan-steps-v2-parallel-critical-path-investment',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose the one acceleration that minimizes release completion time. A lasts 3 days and B lasts 6; both start at time 0. C lasts 7 after A. D lasts 4 after both A and B. E lasts 4 after both C and D and is the release milestone. There is unlimited parallel capacity. You may buy exactly one option: A-option reduces task A by 2 days; B-option reduces task B by 3; C-option reduces task C by 3; D-option reduces task E by 2. Answer only the option letter A, B, C, or D.',
    check: { kind: 'exact', value: 'D' },
  },
  {
    id: 'plan-steps-v2-minimum-validation-sample',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan the smallest extra validation sample that can pass a pooled observed-error-rate gate, not a statistical confidence interval. The existing sample has 2 errors in 400 requests. Assume the extra sample will contain exactly 3 errors, regardless of its size. The gate passes at an observed error rate of at most 0.5%, with equality allowed. What is the smallest integer number of extra requests? Return only the integer.',
    check: { kind: 'exact', value: '600' },
  },
  {
    id: 'plan-steps-v2-backfill-moving-target',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan a catch-up migration with an initial backlog of 312000 records. The backfill consumes 900 records/second, but concurrent writers append 120 new records/second to the same backlog. Rates are continuous and constant. As soon as backlog reaches zero, writers atomically switch to the new path, so they create no more backlog. A subsequent validation barrier takes 8 seconds and cannot overlap the backfill. From starting the backfill to completing validation, how many seconds elapse? Answer only the integer.',
    check: { kind: 'exact', value: '408' },
  },
  {
    id: 'plan-steps-v2-schema-contract-gate',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A rollout added an optional field, deployed producers that sometimes omit it, and backfilled historical data. Some offline clients retain the old producer for 30 days. You want to enforce NOT NULL without making those clients fail. Which plan is valid? A: enforce immediately because the historical backfill passed. B: enforce after every online producer is upgraded, ignoring offline clients. C: keep a server-side compatibility path that supplies a valid value for old clients, verify it covers all writes, then enforce after backfill validation. D: enforce only on the read replica while old writes still reach the primary. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-steps-v2-approval-calendar',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan by numbered working days; there are no weekends. A finishes at the end of day 3 and B at the end of day 5. C requires both, starts no earlier than the following day after all prerequisites finish, and occupies 2 whole working days including its start day. D requires C plus approval available at the beginning of day 9, and occupies 3 whole working days. Tasks may start on the day approval becomes available, but never on the same day a task prerequisite finishes. What is the earliest numbered day on which D finishes? Answer only the integer.',
    check: { kind: 'exact', value: '11' },
  },
  {
    id: 'plan-steps-v2-completion-weighting',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A release plan measures completion only by accepted milestones: partial work contributes zero. Milestone A has weight 5 and is accepted; B has weight 3 and is implemented but not accepted; C has weight 8 and is reported as 50% implemented; D has weight 4 and is accepted. All four milestones are in the denominator. What is the release completion percentage under that rule? Answer only the integer percentage, without a percent sign.',
    check: { kind: 'exact', value: '45' },
  },
  {
    id: 'plan-steps-v2-feature-flag-retirement',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan removal of an old protocol behind a flag. Server traffic has used the new protocol for 7 days, but supported clients may remain offline for 30 days and reconnect using the old protocol. The new protocol stores data old clients cannot parse; downgrading data is not implemented. Which retirement gate preserves the stated support guarantee? A: delete the old protocol after 7 days of zero observed old traffic. B: remove old readers first, keeping old writers for rollback. C: retain compatibility until the supported old-client lifetime expires or those clients are explicitly migrated, and verify stored data remains readable for all still-supported clients before removal. D: remove both paths and tell disconnected clients to retry. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-steps-v2-reversible-data-rollout',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Give a concise rollout and rollback plan, not code, for splitting a required full_name field into given_name and family_name. Old binaries must remain usable during a rolling deployment. Existing names cannot always be split correctly; user edits continue throughout migration. A rollback must not lose edits. Address the ambiguous records explicitly rather than inventing names.',
    check: {
      kind: 'judged',
      rubric:
        'Require an additive schema phase retaining full_name; a compatibility write strategy that preserves concurrent edits and keeps old readers usable; a resumable/idempotent backfill guarded against overwriting newer edits; explicit handling of unsplittable names without fabricating information; validation and staged read cutover; rollback that keeps the original representation and edits; destructive removal only after old binaries and the rollback window are retired. Reject a plan that treats a naive space split as lossless or drops full_name before rollback is safe.',
      reference:
        'Add nullable split fields and retain full_name. Deploy compatible writes with a version/transaction guard; keep the authoritative original for old readers. Backfill only unchanged records with a stable cursor, marking ambiguous records for user confirmation while falling back to full_name. Validate counts, edit races, and compatibility; canary new reads behind a flag. Roll back reads without discarding writes or original names. Remove the old representation only after supported old binaries and rollback requirements end.',
    },
  },
  {
    id: 'plan-steps-v2-authorization-policy-rollout',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan a rollout from owner-only authorization to role-based authorization for a document service. Existing owner-only enforcement must not be weakened during migration. The new policy can be evaluated without applying its result. Permission revocation must take effect promptly; cached allows cannot survive a revocation indefinitely. Give the rollout stages, evidence needed to enable enforcement, and rollback behavior.',
    check: {
      kind: 'judged',
      rubric:
        'Require preserving current enforcement during shadow evaluation; comparing old/new outcomes with explicit review of newly allowed and newly denied requests; tests for tenant boundaries, missing roles, owner behavior, and revocation; policy/cache versioning or invalidation with a bounded revocation delay; a limited enforcement canary with measurable denial/error gates; fail-closed handling of unavailable or malformed policy data; rollback that restores the old policy without granting more access or ignoring revocations. Do not require a particular implementation technology.',
      reference:
        'Inventory owner rules and map roles; keep owner checks authoritative while logging shadow decisions without sensitive content. Test tenant isolation, owner parity, missing-role denial and revocation races, reviewing every class of changed allow. Version/invalidate permission caches with a defined revocation bound. Canary enforcement after reviewed policy backfill, monitor unexpected denies and cross-tenant allows, and stop on gates. Missing policy fails closed. Roll back to owner enforcement with current revocations, not stale cached allows.',
    },
  },
  {
    id: 'plan-steps-v2-unreliable-release-gate',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'An integration suite intermittently fails during a planned release. Failures began before this change, but the test covers a money-transfer invariant that this change also touches. The deadline is tomorrow. Propose a release decision plan that distinguishes flakiness from a regression without simply rerunning until green or deleting the gate. Include what evidence would allow release and what happens if that evidence is unavailable.',
    check: {
      kind: 'judged',
      rubric:
        'Require preserving the transfer invariant as a release gate; comparing failing signatures and behavior on an unchanged baseline and candidate; controlled reproduction with fixed inputs/seeds and captured evidence; targeted deterministic invariant checks relevant to the change; explicit criteria separating an infrastructure/test failure from product failure; release only with positive evidence and accountable decision, otherwise delay or roll back the risky change. Reject using one lucky green rerun, historical flakiness alone, or suppressing the only invariant coverage as proof of safety.',
      reference:
        'Capture failure signatures and the transfer ledger state, reproduce on baseline and candidate under controlled inputs, and isolate infrastructure variance. Add or run deterministic transfer-conservation and duplicate/retry checks for the touched path. Release only if failures are demonstrably unrelated infrastructure/test defects and independent invariant evidence passes with an owner accepting the documented residual risk. If the cause or invariant safety cannot be established, delay or remove the risky change; do not rerun to a lucky green.',
    },
  },
  {
    id: 'plan-steps-v2-wire-format-migration',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan a JSON message-format migration where version 2 changes an integer ID into a string and removes a field old consumers require. Producers and consumers deploy independently; queues can retain messages for 14 days and rollback is supported for 7 days. Give an implementation sequence and retirement gate that handles queued old messages and rollback without assuming all deployments happen together.',
    check: {
      kind: 'judged',
      rubric:
        'Require an explicit version marker and compatible consumers deployed before emitting v2; support for retained v1 messages and required old fields through a compatibility/translation path; exact ID conversion without numeric precision loss; staged producer enablement with consumer telemetry/validation; rollback that does not strand already-produced v2 messages; retirement based on both queued-message retention/drain evidence and supported rollback/consumer lifetimes, not just current live traffic. Reject producer-first incompatible deployment.',
      reference:
        'Define v1/v2 and exact string-ID semantics; deploy consumers accepting both, retaining v1 required-field handling. Validate retained examples and large IDs. Enable v2 producers gradually only after all relevant consumers can read it. Keep the compatible consumer build or a lossless translation path during producer rollback so queued v2 remains readable. Retire v1 only after old producers/consumers and rollback are unsupported and retained v1 is drained or expired with evidence covering the 14-day queue lifetime.',
    },
  },
  {
    id: 'plan-arch-v2-dependency-inversion-graph',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose the import graph satisfying all constraints: Domain knows no delivery/storage technology; UseCases depends only on Domain and a RepositoryPort declared in UseCases; SqlAdapter implements that port; HttpAdapter invokes UseCases; only CompositionRoot assembles concrete implementations. A: Domain imports SqlAdapter, UseCases imports Domain, HttpAdapter imports UseCases. B: UseCases imports SqlAdapter, SqlAdapter imports Domain, HttpAdapter imports UseCases. C: UseCases imports Domain, SqlAdapter imports UseCases and Domain, HttpAdapter imports UseCases, CompositionRoot imports all adapters and UseCases. D: SqlAdapter imports HttpAdapter, Domain imports RepositoryPort from SqlAdapter, UseCases imports Domain. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-protected-cycle-cut',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan a minimal import-edge removal to make this module graph acyclic. Edges are A->B, B->C, C->A, C->D, D->E, E->C; X->Y means X imports Y. A->B, B->C, C->D and D->E are protected and cannot be removed. You may remove only unprotected edges; no new edges are added. Return the necessary removed edges as a JSON array of strings sorted lexicographically, each formatted X->Y.',
    check: { kind: 'json_equal', value: ['C->A', 'E->C'] },
  },
  {
    id: 'plan-arch-v2-failure-isolation-boundary',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose a component boundary. Checkout must commit an order even when recommendation generation is unavailable. Every committed order must eventually be considered for recommendations, including a crash immediately after committing. Recommendations may lag; they must not hold an order transaction open. A: call recommendations synchronously before committing. B: commit then send a best-effort in-memory notification with no durable record. C: write the order and an outbox record atomically, then publish asynchronously to a separately retrying recommendation consumer. D: use one process-global transaction spanning both databases and the recommendation network call. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-cache-identity-boundary',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design a shared cache key for rendered documents. Document IDs are unique only within a tenant. Output varies by locale and by access-policy version; users with the same permission set at the same version see identical output. Revocation increments the policy version. Which key prevents cross-tenant and stale-permission collisions without needlessly keying per user? A: documentId,locale. B: tenantId,documentId,locale,permissionSetId,policyVersion. C: userId,documentId,locale, ignoring tenant and policy version. D: tenantId,documentId,locale,permissionSetId, ignoring policy version and relying only on a 1-hour TTL. Return only the letter.',
    check: { kind: 'exact', value: 'B' },
  },
  {
    id: 'plan-arch-v2-atomic-idempotency-owner',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose where to implement idempotency for a command that creates an invoice in one database. The same tenant/key may arrive concurrently at different API replicas. Reusing the key with a different payload must be rejected, and a crash cannot leave the key marked done without an invoice. A: each replica remembers keys in local memory. B: gateway inserts the key into a separate cache, then the invoice service writes later. C: invoice service atomically reserves a unique tenant/key with a payload fingerprint and writes the invoice/result in the same database transaction. D: each replica queries for an invoice, then inserts without a uniqueness constraint. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-projection-rebuild-boundary',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A source-of-truth event log feeds a search projection. Rebuilding must not hide live search results, and events can arrive while the rebuild runs. Event offsets are monotonically increasing and projections can be named. Which architecture gives a gap-free atomic cutover? A: truncate the live index and replay while serving it. B: snapshot at offset S, build a separate index, apply all events after S until a coordinated catch-up barrier, then atomically switch the search alias. C: build a separate index from a snapshot, switch aliases, and ignore events that arrived during the build. D: let the old and new indexes update independently with no shared offset or cutover barrier, then choose whichever looks larger. Return only the letter.',
    check: { kind: 'exact', value: 'B' },
  },
  {
    id: 'plan-arch-v2-partitioned-writer-ownership',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose a multi-region architecture for an invariant that a seat has at most one confirmed booking. During network partitions, the product accepts rejecting writes in a minority region but never accepts conflicting confirmations. A: independent writable regional databases, later resolve duplicate confirmations by timestamp. B: asynchronous replication with any region acknowledging local confirmation. C: a consensus-backed owner/quorum for each seat, with minority regions unable to confirm when they lack ownership/quorum. D: regional caches lock locally for one minute while databases replicate asynchronously. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-plugin-capability-interface',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design a plugin boundary. Plugins need to fetch a document by ID and emit a derived annotation, but must never enumerate other documents, issue arbitrary SQL, or send network requests. The host must audit calls by plugin identity. Which interface best matches the authority requirement? A: pass the full database client and trust plugin documentation. B: pass host environment variables and a fetch function. C: pass narrowly scoped getAuthorizedDocument(id) and emitAnnotation(documentId,value) capabilities bound to plugin identity, enforcing authorization and auditing in the host. D: pass a generic execute(methodName,args) accepting all private host methods. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-dependent-parallel-latency',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Compute deterministic latency of a proposed component graph; these are fixed durations, not percentiles. Gateway takes 3 ms, then auth takes 7 ms. After auth, profile (11 ms) and inventory (13 ms) start together. Quote (5 ms) starts only after inventory; it does not wait for profile. Serialization (4 ms) starts after both profile and quote finish. There is unlimited execution capacity and no other overhead. Answer only total milliseconds.',
    check: { kind: 'exact', value: '32' },
  },
  {
    id: 'plan-arch-v2-shared-connection-budget',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan replica counts against a database limit of 240 simultaneous connections. Reserve 30 exclusively for operations. Service A has 12 replicas, each using a pool of exactly 5 connections. Service B uses exactly 6 connections per replica. Pools are fully open; there is no multiplexing and the reserve is unavailable to both services. What is the maximum number of B replicas that can coexist with A? Answer only the integer.',
    check: { kind: 'exact', value: '25' },
  },
  {
    id: 'plan-arch-v2-transaction-boundary-components',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Partition modules A through G into the greatest possible number of independently deployable groups. A and B must share one in-process atomic transaction; B and D must share one; D and F must share one; C and E must share one. Those constraints force co-location transitively. There are no other constraints. Return only a JSON array of arrays: letters sorted inside each group, groups sorted by their first letter.',
    check: { kind: 'json_equal', value: [['A', 'B', 'D', 'F'], ['C', 'E'], ['G']] },
  },
  {
    id: 'plan-arch-v2-event-partition-contract',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose an event partition key. Updates for the same account must be applied in their published order; accounts may be processed concurrently. Account numbers collide across tenants. A single account cannot be split across partitions. The broker preserves order only within a partition. A: a new random UUID per event. B: accountNumber alone. C: a canonical tuple encoding of tenantId and accountNumber, used identically by all producers. D: tenantId plus a rotating daily suffix, with each account updating across midnight. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-producer-consumer-version-pair',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Select a pair for independently deployed producers and consumers. Old producers emit a bare integer; old consumers accept only a bare integer. New format is an object {id:string}. During rollout any old/new producer may communicate with any deployed consumer. Assume exact ID conversion exists and no adapter is added. Which transitional producer P and consumer C are safe before old consumers are retired? A: P emits objects, C accepts both. B: P emits integers, C accepts both. C: P emits objects, C accepts only objects. D: P emits either format randomly, C accepts both. Return only the letter.',
    check: { kind: 'exact', value: 'B' },
  },
  {
    id: 'plan-arch-v2-build-dependency-closure',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan the architecture boundary for extracting Report into an independently deployable component. Choose the smallest module bundle closed over all required imports; do not add unrelated dependents. Proposed dependencies: Report imports Query and Schema; Query imports Cache and Schema; Cache imports Clock; Schema imports Validation; Clock and Validation import nothing. Admin imports Report but Report does not import Admin. No imports may be rewritten in this phase, so every direct or transitive dependency must move with Report. Return only the planned bundle as a JSON array of module names sorted alphabetically, including Report itself.',
    check: {
      kind: 'json_equal',
      value: ['Cache', 'Clock', 'Query', 'Report', 'Schema', 'Validation'],
    },
  },
  {
    id: 'plan-arch-v2-transitive-change-blast-radius',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan the architecture-review scope before approving a breaking interface redesign of Core; do not change code. The review policy requires every direct or transitive importer of Core, excluding Core itself, and excludes modules that merely provide dependencies to Core. Proposed import graph: Auth imports Core; Billing imports Core; API imports Auth and Billing; Worker imports Billing; UI imports API; Logging imports nothing; Core imports Logging. Choose the smallest review scope satisfying that policy. Return only the planned review list as a JSON array of names sorted alphabetically.',
    check: { kind: 'json_equal', value: ['API', 'Auth', 'Billing', 'UI', 'Worker'] },
  },
  {
    id: 'plan-arch-v2-cache-policy-ownership',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design a cache boundary for two interfaces using the same inventory rules. HTTP and batch jobs must share stock-validity semantics. The cache is optional; an outage must not alter the domain rule or require modifying either interface. A: HTTP owns validity and batch imports HTTP handlers. B: Domain imports the concrete cache and treats missing keys as zero stock. C: a use-case-facing inventory port defines the required consistency semantics, with a cache-backed adapter that falls back to the authoritative store under those semantics; both interfaces invoke the use case. D: each interface implements a different cache TTL and its own validity rule. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-arch-v2-modular-monolith-boundaries',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design boundaries, not implementation code, for a small team running a monolith with accounts, invoicing, and analytics. Invoice creation must atomically update its ledger; analytics can lag and must not block invoices. Accounts owns identity data. The team cannot operate many separate services yet. Explain component ownership, permitted dependencies, and how analytics receives changes without coupling it to invoice transactions.',
    check: {
      kind: 'judged',
      rubric:
        'Require keeping a manageable deployment rather than forcing unnecessary distributed services; explicit accounts/invoicing/analytics ownership; ledger and invoice atomicity within the invoicing transaction boundary; interaction through defined interfaces rather than arbitrary cross-module table writes; durable asynchronous analytics delivery that survives a crash between invoice commit and publication; idempotent analytics handling or deduplication; analytics lag/failure not blocking invoice completion. Accept equivalent designs with clear durability and boundaries.',
      reference:
        'Use a modular monolith with accounts owning identity, invoicing owning invoice/ledger writes, and analytics owning projections. Interfaces expose required account identity facts; no module writes another module tables. Commit invoices, ledger entries and an outbox record atomically. A background publisher feeds an idempotent analytics projection. Analytics outages only delay projection freshness, not invoice transactions; one deployment keeps operations simple.',
    },
  },
  {
    id: 'plan-arch-v2-external-side-effect-boundary',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design the boundary between a local order database and an external shipping provider. Shipping calls can time out after creating a shipment. The provider supports an idempotency key and lookup by that key. Orders must not be marked shipped until a shipment is confirmed, and a process crash at any point must be recoverable. Explain ownership, state transitions, and retry/reconciliation responsibilities; do not claim a cross-system transaction exists.',
    check: {
      kind: 'judged',
      rubric:
        'Require durable local intent and a stable operation/idempotency key persisted before the external call; an adapter boundary for provider operations; pending/unknown versus confirmed state distinctions; retry or lookup using the same key after ambiguous timeout/crash, not a new key; atomic local confirmation update tied to the shipment identity; a durable worker/reconciliation path recovering unfinished intents; explicit recognition that local DB and provider are not one atomic transaction. Reject marking shipped before confirmation or promising exactly once without the provider protocol.',
      reference:
        'Persist a pending shipment intent and stable key with the order transaction. A durable worker calls a shipping adapter outside that transaction. Success stores provider shipment ID and confirms the order atomically; ambiguous timeouts remain unknown/pending. Reconcile by lookup or idempotent retry with the same key, recovering intents after crashes. The provider protocol prevents duplicate creation; local uniqueness and state checks prevent duplicate confirmation. No distributed atomic transaction is assumed.',
    },
  },
  {
    id: 'plan-arch-v2-untrusted-plugin-isolation',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose and explain an architecture for untrusted customer plugins that transform documents. Plugins must not access other tenants, host credentials, arbitrary network endpoints, or unbounded CPU/memory. A plugin failure must not crash the API. They need access only to the submitted document and an output channel. Describe execution isolation, capability boundaries, and failure handling; no code is required.',
    check: {
      kind: 'judged',
      rubric:
        'Require real process/container/VM or equivalent sandbox isolation rather than merely a TypeScript interface in the API process; explicit denial of ambient filesystem/credential/network access; only authorized submitted document and constrained output capabilities; CPU/time/memory/output limits enforced outside plugin control; plugin crash/timeout isolated from API with bounded failure response; tenant identity/authorization checked at host boundary; safe validation of returned output. Do not require a particular sandbox product.',
      reference:
        'Run each plugin job in a restricted sandbox outside the API process, with no host secrets, no network, and only its authorized input mounted or passed. The host binds the job to its tenant and exposes a bounded output protocol. Enforce CPU, wall-clock, memory and output limits externally; kill failed jobs and return a controlled job failure while the API remains alive. Validate output and never trust plugin-provided tenant identifiers for authorization.',
    },
  },
  {
    id: 'plan-arch-v2-shared-tenant-storage-boundary',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design a shared-database multi-tenant repository boundary for documents. Document IDs may repeat between tenants. Background jobs, API requests, and caches must all preserve isolation. A tenant identifier in request JSON is not trustworthy. Explain how tenant context enters the boundary, how keys/queries are scoped, and how to prevent a background job or cache lookup from bypassing isolation.',
    check: {
      kind: 'judged',
      rubric:
        'Require tenant context derived from authenticated/authorized identity rather than trusting body input; repository operations scoped by tenant plus document identity with no unscoped default; composite uniqueness/keying or equivalent isolation for repeating IDs; background jobs carrying validated durable tenant context and using the same scoped boundary; tenant-inclusive cache keys; defense against cross-tenant access with negative tests and optionally DB-level enforcement. Reject relying only on globally unique document IDs or UI filtering.',
      reference:
        'Authenticate and authorize tenant membership before constructing a tenant-scoped repository. Every lookup/update includes tenant ID and document ID, with composite keys and no ambient unscoped method. Jobs persist the authorized tenant context and enter the same repository boundary; they cannot infer tenancy from a bare document ID. Cache keys include tenant identity and relevant policy scope. Add cross-tenant negative tests and DB row policies where appropriate as defense in depth.',
    },
  },
  {
    id: 'plan-system-v2-zone-failure-capacity',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Size a service evenly across three zones. Demand is 8200 requests/second. Each replica has capacity 500 requests/second, but planned utilization must stay at or below 70%, including after complete loss of any one zone. There is no autoscaling during failure and traffic balances perfectly over surviving replicas. Every zone must have the same integer replica count. What is the minimum replicas per zone, not the total? Answer only the integer.',
    check: { kind: 'exact', value: '12' },
  },
  {
    id: 'plan-system-v2-quorum-intersection-constraints',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose integer read quorum R and write quorum W for N=7 replicas under this simplified quorum model: require R+W>N for read/write intersection, W>N/2 for write/write intersection, and both quorums must remain achievable when any 2 replicas are unavailable. Additionally R must be at most 3. Minimize R+W and then minimize R if tied. Ignore concurrent-version reconciliation; only these quorum constraints count. Return only the JSON array [R,W].',
    check: { kind: 'json_equal', value: [3, 5] },
  },
  {
    id: 'plan-system-v2-piecewise-queue-drain',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan the earliest achievable backlog-cleared recovery milestone for a proposed worker-capacity schedule. The service starts with 1200 queued jobs at time 0. Planned capacity and demand are: for the first 4 seconds, arrivals 200 jobs/second and service 350; for the next 8 seconds, arrivals 500 and service 350; thereafter, arrivals 100 and service 400 until recovery. Assume continuous rates, no dropped jobs, and no negative backlog. The milestone must guarantee the backlog has first reached zero; do not add capacity or change the schedule. What is the minimum recovery milestone time, in seconds after time 0, that the plan can promise? Answer only the integer.',
    check: { kind: 'exact', value: '18' },
  },
  {
    id: 'plan-system-v2-fractional-token-bucket',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose an admission plan for a proposed token-bucket API contract, not an implementation. The bucket has capacity 5 and initially 3 tokens at t=0; it refills continuously at 1 token per 2 seconds, including fractional tokens, capped at 5. The contract requires accepting every arrival whose full cost is available, subtracting cost only for accepted arrivals; rejection consumes nothing. Proposed workload: a at t=0 costs 2; b at t=1 costs 2; c at t=2 costs 2; d at t=4 costs 3; e at t=6 costs 2; f at t=8 costs 1. Candidate plans admit A=[a,b,e,f], B=[a,c,d,f], C=[a,c,e,f], D=[a,e,f]. Select the only contract-compliant plan. Return only its JSON array of admitted IDs, in arrival order, not its letter.',
    check: { kind: 'json_equal', value: ['a', 'c', 'e', 'f'] },
  },
  {
    id: 'plan-system-v2-layered-retry-amplification',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Bound retry amplification in a proposed service graph. One user operation may make up to 3 attempts at service A, including the original. Every A attempt invokes exactly two independent branches B1 and B2 once. Each branch may make up to 4 attempts at leaf C, including its original. All attempts can reach C, and an upstream timeout does not cancel downstream work. There are no other retries or deduplication. What is the maximum total number of C attempts caused by one user operation? Answer only the integer.',
    check: { kind: 'exact', value: '24' },
  },
  {
    id: 'plan-system-v2-memory-headroom-rounding',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan the maximum concurrent connections for a process limited to 256 MiB. Reserve exactly 20% of that limit as unused headroom; the remaining memory may be used. Fixed non-connection state occupies 96 MiB. Each connection consumes exactly 14 KiB, with no other memory overhead. 1 MiB=1024 KiB; do not round the headroom to whole MiB. Answer only the greatest integer connection count satisfying the budget.',
    check: { kind: 'exact', value: '7957' },
  },
  {
    id: 'plan-system-v2-series-parallel-availability',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Under an explicitly independent failure model, each of three interchangeable gateways has availability 0.99. At least one gateway must work. A single shared database has availability 0.999 and must also work; it is independent of all gateways. Ignore networking and common-cause failures for this exercise. What is overall service availability as a probability, not a percentage? Answer only a decimal with exactly nine digits after the decimal point.',
    check: { kind: 'exact', value: '0.998999001' },
  },
  {
    id: 'plan-system-v2-deadline-queue-bound',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Set an admission queue bound for a simultaneous burst at t=0. Eight identical idle workers each process one request in exactly 250 ms, non-preemptively. FIFO waiting requests start immediately when a worker is free. Every admitted request must finish by t=1750 ms, with equality allowed. No later arrivals occur. What is the maximum number of WAITING requests admitted at t=0, excluding the eight requests that start immediately? Answer only the integer.',
    check: { kind: 'exact', value: '48' },
  },
  {
    id: 'plan-system-v2-versioned-tombstone-contract',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose a client-visible convergence contract for an asynchronously replicated projection. The design requires strictly newer integer versions to supersede older versions, equal versions to be ignored, and deletion versions to remain as tombstones so stale updates cannot resurrect data. An unseen key starts at version -1. The contract must cover this proposed delivery scenario: put a v4 value x; delete a v6; put a v5 value y; put b v2 value m; delete b v3; put b v3 value n; put a v7 value z. Four candidate documented converged outcomes are A={a:y,b:n}, B={a:z,b:n}, C={a:z,b:null}, D={a:null,b:null}. Select the only outcome consistent with the design invariants. Return only its JSON object with keys a then b, using quoted string values and null for deletion, not the option letter.',
    check: { kind: 'json_equal', value: { a: 'z', b: null } },
  },
  {
    id: 'plan-system-v2-stale-lease-fencing',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A worker holds a lease but pauses long enough for it to expire. A successor acquires the lease and writes; the old worker then resumes and can still reach storage. Choose the protocol preventing the stale worker from overwriting the successor. A: the old worker checks its local clock before acquiring the lease, but storage accepts all writes. B: lease IDs are random, and storage accepts any previously issued ID. C: acquisition yields monotonically increasing fencing tokens, and storage atomically rejects writes with a token older than its highest accepted token. D: the worker logs a warning when its lease expires but retries the write. Return only the letter.',
    check: { kind: 'exact', value: 'C' },
  },
  {
    id: 'plan-system-v2-hot-shard-target-utilization',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Plan repartitioning a hot region producing 240 messages/second. Each partition has exactly one serial worker with maximum processing capacity 75 messages/second; planned utilization must be at most 80%. Keys can be distributed evenly across new partitions and no individual key is hot. Other regions have dedicated capacity and do not share these workers. Per-key ordering forbids multiple simultaneous workers on one partition. What is the minimum number of partitions for this hot region? Answer only the integer.',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'plan-system-v2-hedged-path-budget',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Compute fixed response latency for this proposed hedging plan. Network ingress takes 8 ms. Only after ingress finishes does routing begin; routing takes 12 ms. Only after routing finishes does a region-A request start; it lasts 44 ms. Exactly 10 ms after A starts, a region-B request starts; it lasts 28 ms. The first successful region response wins; both succeed, and the loser need not complete before responding. Only after the winning response arrives does response assembly start; assembly takes 5 ms. Apart from the two overlapping region requests, the stages do not overlap. Durations are deterministic, not percentiles. Return only the integer total elapsed milliseconds from ingress start through assembly completion, without units or explanation.',
    check: { kind: 'exact', value: '63' },
  },
  {
    id: 'plan-system-v2-stale-while-refresh-bound',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Derive the supremum of staleness after a primary update at t=0. A replica becomes current at t=4 seconds; before t=4 a read can return old data. A cache samples that replica immediately when each refresh STARTS and caches that sampled value. An old value may be sampled arbitrarily close to, but before, t=4 and installed immediately for this initial fill. It is served for a 30-second TTL. At expiry, a refresh starts; the cache keeps serving the old value during the 3-second refresh, then atomically replaces it with the new sampled value. No other refresh/invalidation occurs. Return only the supremum staleness duration in seconds, even if not attained exactly.',
    check: { kind: 'exact', value: '37' },
  },
  {
    id: 'plan-system-v2-replicated-retention-storage',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Size retained event storage at steady state. Ingest is exactly 250 events/second continuously. Retention is exactly 7 days of 86400 seconds each. Each event occupies 320 bytes AFTER compression, and three complete replicas are stored. There is no index, metadata, or extra headroom. Provisioning units are whole GiB, where 1 GiB=1073741824 bytes. What is the smallest total integer GiB capacity covering all replicas? Answer only the integer.',
    check: { kind: 'exact', value: '136' },
  },
  {
    id: 'plan-system-v2-total-order-tiebreakers',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose the canonical event-ordering plan for a reconciliation protocol specification. It must place lower logical timestamps first; equal timestamps must be ordered by lexicographically ascending node ID; events from the same node at the same timestamp must be ordered by numerically ascending local sequence. Arrival order must not affect the plan. Proposed events are a=(5,B,2), b=(5,A,9), c=(4,Z,7), d=(5,A,3), e=(6,A,1). Candidate plans are A=[c,b,d,a,e], B=[c,a,d,b,e], C=[c,d,b,a,e], D=[d,b,a,c,e]. Select the only plan satisfying all protocol constraints. Return only the selected JSON array of event IDs, not the option letter.',
    check: { kind: 'json_equal', value: ['c', 'd', 'b', 'a', 'e'] },
  },
  {
    id: 'plan-system-v2-acknowledgment-durability',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Choose a write-acknowledgment contract guaranteeing zero loss of acknowledged writes after sudden complete loss of any one of three zones. Replicas are durable once their fsync completes. Failover must retain acknowledged writes; zones fail independently and only one fails. A: acknowledge after local memory write, then replicate. B: acknowledge after one zone fsync, then asynchronous replication. C: acknowledge after sending data to two zones without waiting for either fsync. D: acknowledge only after fsync in at least two distinct zones, and require failover/recovery to preserve every acknowledged quorum write. Return only the letter.',
    check: { kind: 'exact', value: 'D' },
  },
  {
    id: 'plan-system-v2-partitioned-inventory-contract',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design an inventory-reservation contract across two regions that can become partitioned. There is one last item. The business forbids two successful reservations for it and accepts temporarily rejecting reservations in one region. Clients retry after timeouts. Explain write authority during partition, ambiguous outcomes, retries, and recovery. No technology-specific code is needed.',
    check: {
      kind: 'judged',
      rubric:
        'Require a single fenced authority or intersecting consensus quorum for the item, not independently successful regional decrements; explicit rejection/unavailability when authority cannot be established; stable client idempotency identity with durable result for repeated requests; timeout treated as unknown, followed by status lookup or same-key retry, not a new reservation; recovery/failover that excludes stale writers and preserves confirmed reservations; acknowledgment tied to durable invariant enforcement. Reject solving duplicate confirmations only after the partition heals.',
      reference:
        'Use a quorum-backed or fenced owner for each item. Only an authoritative quorum/owner can atomically reserve the last unit and record the client operation result; the isolated non-authoritative region rejects or reports unavailable. A timeout is unknown, so clients query/retry the same operation key. Recovery chooses authority with fencing and durable committed state before admitting writes, preserving successful reservations and deduplicating retries.',
    },
  },
  {
    id: 'plan-system-v2-bounded-queue-overload',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design overload behavior for an API feeding a bounded asynchronous job queue. Jobs cannot be silently lost after the API says accepted. During a sustained spike, worker capacity is lower than arrivals; clients retry and can duplicate submissions. Describe admission, durable acknowledgment, retry identity, queue/deadline limits, and recovery. Avoid claiming that an unbounded queue solves overload.',
    check: {
      kind: 'judged',
      rubric:
        'Require atomic durable enqueue or durable intent before acceptance; a stable tenant-scoped submission key and replayable result preventing duplicate jobs; bounded queue/admission and clear rejection/backpressure before acceptance when full; retry guidance that avoids immediate synchronized retry storms; job deadline/expiry behavior explicit to clients rather than silent loss; recoverable worker processing with durable acknowledgment after completion and idempotent handling of redelivery; monitoring of queue age/capacity. Reject acknowledging only an in-memory enqueue or promising no duplicates solely from delivery semantics.',
      reference:
        'Persist a tenant/key job intent atomically before returning acceptance and reuse its job ID on retry. Reserve bounded admission capacity; reject before acceptance when full, with retry-after/backoff and jitter. Publish queue-age/deadline status and make expired accepted jobs visible as explicit failures. Workers lease durable jobs, record completion before acknowledgment, and make side effects idempotent for redelivery. Recover pending intents after crashes and monitor queue age, depth and rejection rate.',
    },
  },
  {
    id: 'plan-system-v2-session-read-consistency',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design read-your-writes behavior for a service with a leader and asynchronous read replicas. A user writes a profile, then immediately refreshes from a different API replica. Reads should normally use followers, but must not show that user an older profile than their confirmed write. Replica lag may be unbounded during an outage; no synchronized wall clocks are available. Explain the response token, read routing/waiting, and failure behavior.',
    check: {
      kind: 'judged',
      rubric:
        'Require an acknowledged committed version/log position in a client-carried or durable shared session token, not process-local memory alone; follower reads accepted only when their applied position meets the token; bounded waiting or fallback to an authoritative reader; explicit unavailable response rather than stale success when no qualifying reader can serve; monotonically retained session requirement across API replicas; no reliance on wall-clock timestamps or a fixed delay as proof of replication. Accept equivalent causal/session consistency mechanisms.',
      reference:
        'Return the committed revision/log position with the write and propagate the maximum session position on subsequent reads. Route to a follower whose applied position is at least that token, or wait for a bounded interval then use the leader/authoritative reader. If none can meet the bound, fail explicitly rather than returning stale data. The token survives API routing changes and advances monotonically; fixed sleeps and wall clocks are not replication proof.',
    },
  },
  {
    id: 'plan-system-v2-cache-outage-load-shedding',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Design outage behavior for a cache serving 95% of reads. Normal database utilization is already 60%; the database cannot absorb all cache misses. Cached public catalog data may be up to 5 minutes stale, but authorization data must be current and may not be served stale. Explain differentiated degradation, protection against a miss storm, recovery/warmup, and correctness. No code is required.',
    check: {
      kind: 'judged',
      rubric:
        'Require recognizing that unrestricted DB fallback overloads the database; bounded DB concurrency/admission with load shedding/backpressure; public catalog stale-serving only within the allowed 5-minute bound, otherwise explicit degradation/error; authorization checked authoritatively with bounded capacity and fail-closed/unavailable behavior when freshness cannot be guaranteed; request coalescing or equivalent suppression of duplicate cache fills; gradual bounded cache warmup/recovery; monitoring and separation of correctness-sensitive and freshness-tolerant paths. Reject serving stale authorization or assuming all misses can safely hit the DB.',
      reference:
        'Separate authorization and catalog paths. Serve retained catalog data only while its age is within five minutes; otherwise use bounded fallback or explicit unavailable responses. Keep authorization authoritative, with limited concurrency and fail closed/unavailable if it cannot be checked. Cap DB admission, shed excess load and coalesce fills by key. Recover cache through throttled warmup with jitter and gradual traffic restoration, monitoring DB saturation, age and rejection rates rather than unleashing every miss at once.',
    },
  },
];
