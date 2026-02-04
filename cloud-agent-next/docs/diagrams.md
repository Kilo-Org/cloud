# Cloud-Agent WebSockets: Core Diagrams

These diagrams capture the core loops/patterns for the direct execution model,
DO ingestion + replay, and client reconnect.

---

## 1) System overview (data flow)

```mermaid
flowchart LR
  clientA[Client A] -->|HTTP tRPC V2| worker[Worker]
  clientB[Client B] -->|HTTP tRPC V2| worker
  clientA -->|WS stream upgrade| worker
  clientB -->|WS stream upgrade| worker
  worker -->|RPC startExecutionV2| do[CloudAgentSession DO]
  worker -->|proxy stream WS| do
  do -->|metadata + SQLite| storage[(DO storage)]
  do -->|ExecutionOrchestrator| sandbox[Sandbox]
  sandbox -->|wrapper connects /ingest WS| do
  do -->|broadcast stream| clientA
  do -->|broadcast stream| clientB
```

---

## 2) Direct execution handoff

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker (tRPC V2)
  participant DO as CloudAgentSession DO
  participant SB as Sandbox

  C->>W: initiate/sendMessage V2
  W->>DO: startExecutionV2(...)

  DO->>DO: check for active execution

  alt no active execution
    DO->>DO: set activeExecutionId
    DO->>DO: ExecutionOrchestrator.execute()
    DO->>SB: prepare workspace + start wrapper
    SB->>DO: wrapper /ingest WS events
    DO-->>W: status=started
  else active exists
    DO-->>W: 409 Conflict (EXECUTION_IN_PROGRESS)
  end

  W-->>C: ack {cloudAgentSessionId, executionId, status, streamUrl}
```

---

## 3) Execution lifecycle (start/resume)

```mermaid
sequenceDiagram
  participant DO as CloudAgentSession DO
  participant Orch as ExecutionOrchestrator
  participant SB as Sandbox
  participant Wrap as Wrapper

  DO->>Orch: execute(plan)

  alt first run (shouldPrepare=true)
    Orch->>SB: SessionService.initiate(...)
    Orch->>SB: ensureKiloServer()
  else resume (shouldPrepare=false)
    Orch->>SB: SessionService.resume(...)
  end

  Orch->>Wrap: WrapperClient.ensureRunning()
  Orch->>Wrap: WrapperClient.startJob()
  Orch->>Wrap: WrapperClient.prompt()

  Wrap->>DO: /ingest WS connect
  loop stream events
    Wrap->>DO: kilocode/output/error events
  end
  Wrap->>DO: message.updated (completed)
  DO->>DO: clear activeExecutionId
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

  DO->>Wrap: POST /job/start
  Wrap->>Kilo: create/resume session
  Wrap-->>DO: {kiloSessionId}

  DO->>Wrap: POST /job/prompt
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

## 8) Prepared session lifecycle (prepare → initiate → follow-up)

```mermaid
sequenceDiagram
  participant B as Backend
  participant W as Worker (tRPC)
  participant DO as CloudAgentSession DO
  participant SB as Sandbox

  B->>W: prepareSession (internal)
  W->>DO: prepare(metadata)
  DO-->>W: success + stored preparedAt

  B->>W: initiateFromKilocodeSessionV2
  W->>DO: startExecutionV2(kind=initiatePrepared)
  DO->>DO: tryInitiate() sets initiatedAt
  DO->>SB: ExecutionOrchestrator.execute()
  DO-->>W: status=started

  SB->>DO: /ingest WS (streaming)

  B->>W: sendMessageV2 (follow-up)
  W->>DO: startExecutionV2(kind=followup)
  DO-->>W: status=started (or 409 if busy)
```

---

## 9) Error handling and retries

```mermaid
flowchart TD
  A[Client Request] --> B{DO startExecutionV2}
  B -->|Active execution| C[409 Conflict]
  B -->|No active| D[ExecutionOrchestrator]
  D -->|Sandbox connect fail| E[503 SANDBOX_CONNECT_FAILED]
  D -->|Workspace setup fail| F[503 WORKSPACE_SETUP_FAILED]
  D -->|Kilo server fail| G[503 KILO_SERVER_FAILED]
  D -->|Wrapper start fail| H[503 WRAPPER_START_FAILED]
  D -->|Success| I[200 Started]

  E & F & G & H -->|Client retries| A
  C -->|Client waits/polls| A
```
