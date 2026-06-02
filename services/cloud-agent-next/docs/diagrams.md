# Cloud-Agent WebSockets: Core Diagrams

These diagrams capture the core loops/patterns for queue-first V2 acceptance,
DO ingestion + replay, and client reconnect.

---

## 1) System overview (data flow)

```mermaid
flowchart LR
  clientA[Client A] -->|HTTP tRPC V2| worker[Worker]
  clientB[Client B] -->|HTTP tRPC V2| worker
  clientA -->|WS stream upgrade| worker
  clientB -->|WS stream upgrade| worker
  worker -->|RPC createSessionWithInitialAdmission / admitPreparedInitialMessage / admitSubmittedMessage| do[CloudAgentSession DO]
  worker -->|proxy stream WS| do
  do -->|metadata + SQLite| storage[(DO storage)]
  do -->|ExecutionOrchestrator| sandbox[Sandbox]
  sandbox -->|wrapper connects /ingest WS| do
  do -->|broadcast stream| clientA
  do -->|broadcast stream| clientB
```

---

## 2) Queue-first handoff

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker (tRPC)
  participant SI as Session Ingest
  participant DO as CloudAgentSession DO
  participant SB as Sandbox

  alt grouped start
    C->>W: start(initial turn)
    W->>SI: create ownership row (external prerequisite)
    W->>DO: createSessionWithInitialAdmission(accepted initial turn)
    DO->>DO: register metadata, persist V2 intent + lifecycle state, ensure one queued event, schedule drain
    Note over DO: One DO-owned command; staged writes, retries repair missing event/drain effects
    DO-->>W: outcome=queued (durable admission)
    W-->>C: compatibility ack {cloudAgentSessionId, kiloSessionId, messageId, delivery=queued}
    Note over W,SI: Explicit DO rejection attempts best-effort onlyIfEmpty deletion; unknown RPC outcome retains possibly orphaned state for cleanup
  else legacy prepared initiation
    C->>W: initiateFromKilocodeSessionV2
    W->>DO: admitPreparedInitialMessage() adapter reconstructs stored turn
    DO->>DO: persist V2 intent + lifecycle state and schedule drain
    DO-->>W: outcome=queued (durable admission)
    W-->>C: compatibility ack {cloudAgentSessionId, executionId=messageId, status=started, streamUrl, messageId, delivery=queued}
  else follow-up submission
    C->>W: send / sendMessageV2
    W->>DO: admitSubmittedMessage(submitted turn + overrides)
    DO->>DO: persist V2 intent + lifecycle state and schedule drain
    DO-->>W: outcome=queued (durable admission)
    W-->>C: compatibility ack {cloudAgentSessionId, executionId=messageId, status=started, messageId, delivery=queued}
  end

  Note over C,DO: queued acknowledgement is durable admission; wrapper delivery may fail asynchronously
  DO->>DO: alarm takes next eligible pending message
  DO->>DO: AgentRuntime reuses/allocates complete WrapperRunFence
  DO->>SB: dispatch FencedWrapperDispatchRequest to wrapper
  SB->>SB: submit prompt or command to Kilo
  Note over SB: Ambiguous handoff may resubmit the same messageId; wrapper delivery is at-least-once until Kilo exposes atomic idempotent submit
  SB->>DO: acknowledge acceptance / fenced wrapperRunId ingest events
  DO->>DO: persist accepted state, ensure one sent-message event, remove pending residue
  alt terminal ingest arrives over current fence
    SB->>DO: forward terminal message.updated
    DO->>DO: settle once through terminal effect/callback seams
  else accepted wrapper is gone before terminal ingest
    DO->>DO: disconnect/liveness expiry fails accepted work without redispatch
    Note over DO,SB: No authoritative post-loss Kilo recovery contract exists today
  end
```

---

## 3) Fenced wrapper delivery lifecycle

```mermaid
sequenceDiagram
  participant DO as CloudAgentSession DO
  participant Runtime as AgentRuntime
  participant Orch as ExecutionOrchestrator
  participant SB as Sandbox
  participant Wrap as Wrapper

  DO->>Runtime: send(MessageDeliveryRequest)
  Runtime->>Runtime: allocate/reuse WrapperRunFence
  Runtime->>Orch: execute(FencedWrapperDispatchRequest)
  Orch->>SB: ensure bootstrap or devcontainer wrapper
  Orch->>Wrap: POST /session/ready
  Orch->>Wrap: POST /job/prompt or /job/command
  Wrap-->>Runtime: accepted messageId
  Runtime->>DO: persist accepted state and sent effect

  Wrap->>DO: /ingest WS connect with wrapperRunId + connection fence
  loop stream events
    Wrap->>DO: kilocode/output/error events
  end
  Wrap->>DO: message.updated (terminal assistant reply)
  DO->>DO: terminalize accepted message state once
```

---

## 4) DO ingest + stream handling

```mermaid
flowchart LR
  subgraph DO["CloudAgentSession DO"]
    ingest["/ingest WS"] --> normalize["normalize event"]
    normalize --> insert["insert into SQLite (RETURNING id)"]
    insert --> broadcast["broadcast to /stream clients"]

    stream["/stream WS"] --> replay["query SQLite with filters"]
    replay --> live["live broadcast"]
  end
```

---

## 5) Wrapper lifecycle

```mermaid
sequenceDiagram
  participant DO as DO (WrapperClient)
  participant Wrap as Wrapper HTTP Server
  participant Kilo as Kilo Server (SSE)

  DO->>Wrap: POST /session/ready
  Wrap->>Kilo: create/resume session
  Wrap-->>DO: {status, kiloSessionId}

  DO->>Wrap: POST /job/prompt {message, agent, finalization, session}
  Wrap->>Wrap: open connections (ingest WS + SSE)
  Wrap->>Kilo: POST /session/:id/prompt_async
  Wrap-->>DO: {messageId}

  loop SSE events
    Kilo->>Wrap: event stream
    Wrap->>DO: forward via ingest WS
  end

  Note over Wrap: on message.updated (completed)
  Wrap->>Wrap: run post-completion tasks
  Wrap->>Wrap: drain period (250ms)
  Wrap->>Wrap: close connections
```

---

## 6) Client reconnect + replay

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker
  participant DO as CloudAgentSession DO

  C->>W: GET /stream?sessionId=...&fromId=lastSeen
  W->>DO: stub.fetch upgrade
  DO->>DO: SELECT events WHERE id > fromId
  DO-->>C: replay events
  DO-->>C: live events
```

---

## 7) Execution state machine (high-level)

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> running
  pending --> failed
  running --> completed
  running --> failed
  running --> interrupted
  completed --> [*]
  failed --> [*]
  interrupted --> [*]
```

---

## 8) Prepared session lifecycle (split legacy and auto-initiate)

```mermaid
sequenceDiagram
  participant B as Backend
  participant W as Worker (tRPC)
  participant DO as CloudAgentSession DO
  participant SB as Sandbox

  alt retained split legacy flow
    B->>W: prepareSession(autoInitiate=false)
    W->>DO: registerSession(metadata)
    DO-->>W: success + registered metadata only
    B->>W: initiateFromKilocodeSessionV2
    W->>DO: admitPreparedInitialMessage()
  else first-party creation flow
    B->>W: prepareSession(autoInitiate=true)
    W->>DO: createSessionWithInitialAdmission(canonical initial turn)
  end
  DO->>DO: persist V2 intent + lifecycle state and schedule drain
  DO-->>W: outcome=queued
  W-->>B: compatibility output (prepare shape unchanged; V2 alias remains status=started)
  DO->>SB: dispatch during drain

  B->>W: sendMessageV2 (follow-up)
  W->>DO: admitSubmittedMessage(submitted turn)
  DO-->>W: outcome=queued
  W-->>B: compatibility ack status=started, delivery=queued
```

---

## 9) Error handling and retries

```mermaid
flowchart TD
  A[Client Request] --> B{DO admission method}
  B -->|Pending message stored; outcome=queued| Q[Public compatibility status=started delivery=queued]
  B -->|Idempotent replay after wrapper already accepted| I[Public compatibility status=started delivery=sent]
  B -->|Terminal messageId reused| C[400 BAD_REQUEST: submit new messageId]
  B -->|Sandbox connect fail| E[503 SANDBOX_CONNECT_FAILED]
  B -->|Workspace setup fail| F[503 WORKSPACE_SETUP_FAILED]
  B -->|Kilo server fail| G[503 KILO_SERVER_FAILED]
  B -->|Wrapper start fail| H[503 WRAPPER_START_FAILED]

  E & F & G & H -->|Client retries| A
  C -->|Legacy clients wait/poll| A
```
