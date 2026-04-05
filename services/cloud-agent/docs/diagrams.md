# Cloud-Agent WebSockets: Core Diagrams

These diagrams capture the core loops/patterns for the queue-backed execution
runner, DO ingestion + replay, and client reconnect.

---

## 1) System overview (data flow)

```mermaid
flowchart LR
  clientA[Client A] -->|HTTP tRPC V2 enqueue| worker[Worker]
  clientB[Client B] -->|HTTP tRPC V2 enqueue| worker
  clientA -->|WS stream upgrade| worker
  clientB -->|WS stream upgrade| worker
  worker -->|RPC enqueueExecution| do[CloudAgentSession DO]
  worker -->|proxy stream WS| do
  do -->|metadata + SQLite| storage[(DO storage)]
  do -->|enqueue next| queue[EXECUTION_QUEUE]
  queue --> consumer[Queue consumer]
  consumer -->|SessionService + startProcess(wrapper)| sandbox[Sandbox]
  sandbox -->|wrapper connects /ingest WS| do
  do -->|broadcast stream| clientA
  do -->|broadcast stream| clientB
```

---

## 2) Command queue + execution handoff

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker (tRPC V2)
  participant DO as CloudAgentSession DO
  participant Q as EXECUTION_QUEUE
  participant QC as Queue consumer

  C->>W: initiate/sendMessage V2
  W->>DO: enqueueExecution(...)

  DO->>DO: purge expired + check depth
  DO->>DO: add execution (pending)
  DO->>DO: insert into command_queue

  alt no active execution
    DO->>DO: blockConcurrencyWhile
    DO->>DO: set active
    DO->>Q: send execution message
    DO->>DO: dequeue command
    DO-->>W: status=started
  else active exists
    DO-->>W: status=queued
  end

  W-->>C: ack {cloudAgentSessionId, executionId, status, streamUrl}

  Q->>QC: deliver message
  QC->>SB: start wrapper process
  SB->>DO: wrapper /ingest WS events
  DO->>DO: update status + broadcast

  alt terminal status
    DO->>DO: onExecutionComplete
    DO->>DO: dequeue next command
    DO->>Q: send next execution message
  end
```

---

## 2.1) Multiple sendMessageV2 calls (FIFO ordering)

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker (tRPC V2)
  participant DO as CloudAgentSession DO
  participant Q as EXECUTION_QUEUE
  participant QC as Queue consumer

  C->>W: sendMessageV2 (msg A)
  W->>DO: enqueueExecution(msg A)
  DO-->>W: status=started

  C->>W: sendMessageV2 (msg B)
  W->>DO: enqueueExecution(msg B)
  DO-->>W: status=queued

  C->>W: sendMessageV2 (msg C)
  W->>DO: enqueueExecution(msg C)
  DO-->>W: status=queued

  Q->>QC: deliver msg A
  QC->>DO: onExecutionComplete(msg A)
  DO->>Q: send msg B

  Q->>QC: deliver msg B
  QC->>DO: onExecutionComplete(msg B)
  DO->>Q: send msg C
```

---

## 3) Queue execution lifecycle (start/resume)

```mermaid
sequenceDiagram
  participant Q as Queue consumer
  participant DO as CloudAgentSession DO
  participant SB as Sandbox

  Q->>DO: claimLease(executionId)
  DO-->>Q: ok / rejected
  alt first run
    Q->>Q: SessionService.initiate(...)
    Q->>SB: session.startProcess(wrapper)
  else resume
    Q->>Q: SessionService.resume(...)
  end
  SB->>DO: wrapper /ingest WS connect
  loop stream
    SB->>DO: started/output/kilocode/error/complete
  end
  DO->>DO: onExecutionComplete(executionId, terminal)
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

## 5) Lease + heartbeat + reaper

```mermaid
sequenceDiagram
  participant Q as Queue consumer
  participant DO as DO lease table
  participant AL as DO alarm (reaper)

  Q->>DO: claimLease(executionId, leaseId)
  loop every 30s
    Q->>DO: extendLease(executionId, leaseId)
    DO-->>Q: ok / failed
  end
  Note over Q: On failed extend, stop execution and exit
  AL->>DO: alarm tick
  DO->>DO: clear stale activeExecutionId + mark failed
  DO->>DO: delete expired leases + old events
  DO->>DO: tryAdvanceQueue if idle
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

## 9) Prepared session lifecycle (prepare → initiate → follow-up)

```mermaid
sequenceDiagram
  participant B as Backend
  participant W as Worker (tRPC)
  participant DO as CloudAgentSession DO
  participant Q as EXECUTION_QUEUE
  participant R as Queue runner

  B->>W: prepareSession (internal)
  W->>DO: prepare(metadata)
  DO-->>W: success + stored preparedAt

  B->>W: initiateFromKilocodeSessionV2
  W->>DO: enqueueExecution(isInitialize=true)
  DO->>DO: tryInitiate() sets initiatedAt
  DO->>Q: send execution message
  DO-->>W: status=started

  Q->>R: deliver message
  R->>DO: /ingest WS (streaming)

  B->>W: sendMessageV2 (follow-up)
  W->>DO: enqueueExecution(isInitialize=false)
  DO-->>W: status=queued/started
```
