# Cloud Agent control-plane diagrams

These diagrams cover the current `workspace_*` control plane: queue-first message
acceptance, the Session and Sandbox DOs, wrapper delivery, streaming and
reconnect.

Implementation: `src/control-plane/session/`, `src/control-plane/sandbox/`, and
`wrapper/src/control-plane/`. The Worker exports `SandboxSessionV2` as
`SandboxSession` and `SandboxControlV2` as `SandboxControl`.

---

## 1) System overview

```mermaid
flowchart LR
  client[Client] -->|tRPC start / send| worker[Worker]
  client -->|/stream WebSocket| worker
  worker -->|RPC createSessionWithInitialAdmission / send| session[Session DO<br/>SandboxSession]
  worker -->|proxy /stream| session
  session -->|prepare / deliver / release| sandbox[Sandbox DO<br/>SandboxControl]
  sandbox -->|create / stop| provider[Provider allocation]
  provider --> container[Sandbox container]
  container --> wrapper[Control wrapper]
  wrapper <-->|WebSocket control + events| sandbox
  wrapper <-->|native API + SSE| kilo[Kilo]
  sandbox -->|route view, events, outcome| session
  session -->|event log + live broadcast| client
```

---

## 2) Message admission and delivery

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker (tRPC)
  participant S as Session DO
  participant B as Sandbox DO
  participant R as Control wrapper

  alt unified start
    C->>W: start(initial turn)
    W->>W: authorize, preflight profile and model
    W->>S: createSessionWithInitialAdmission(canonical turn)
    S->>S: register metadata, append queued message, schedule drain
    S-->>W: queued acknowledgement
  else split adapter
    C->>W: prepareSession
    W->>S: register metadata only
    C->>W: initiateFromKilocodeSessionV2
    W->>S: admit stored initial turn
    S-->>W: queued acknowledgement
  else follow-up
    C->>W: send / sendMessageV2
    W->>S: append queued message
  end

  W-->>C: compatibility ack {cloudAgentSessionId, messageId, delivery}
  S->>B: prepare(route)
  B->>B: ensure connected allocation and wrapper
  B->>R: session.prepare
  R->>R: clone, checkout, setup, start Kilo
  R-->>B: session.ready
  B-->>S: route ready
  S->>B: deliver(queued messages)
  B->>R: session.prompt
  R-->>B: accepted
  B-->>S: sent
  S->>S: messages become accepted
```

---

## 3) Event and outcome flow

```mermaid
sequenceDiagram
  participant R as Control wrapper
  participant B as Sandbox DO
  participant S as Session DO
  participant C as Client

  R->>B: Kilo events over the control socket
  B->>S: route events
  S->>S: persist to DO SQLite, assign event id
  S-->>C: /stream live event
  Note over C,S: reconnect replays from fromId
  R->>B: session.outcome(status, reason, lastMessageId)
  B->>S: route outcome
  S->>S: settle accepted messages once
  S-->>C: terminal events and callbacks
```

---

## 4) Sandbox and wrapper lifecycle

```mermaid
sequenceDiagram
  participant S as Session DO
  participant B as Sandbox DO
  participant P as Provider
  participant R as Control wrapper
  participant K as Kilo

  S->>B: prepare
  B->>P: create or reuse allocation
  P->>R: start supervisor and wrapper
  R->>B: hello
  B-->>R: welcome
  B->>R: session.prepare
  R->>K: start or restore Kilo
  R-->>B: session.progress / session.ready
  B-->>S: route view update
  loop heartbeat
    R->>B: heartbeat
    B-->>R: heartbeat_ack
  end
  Note over B,R: close or 45 s without heartbeat -> disconnected
  B->>P: stop at reconnect window or idle deadline
```

---

## 5) Client reconnect and replay

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Worker
  participant S as Session DO

  C->>W: GET /stream?...&ticket=...&fromId=lastSeen
  W->>S: stub.fetch upgrade
  S->>S: SELECT events WHERE id > fromId
  S-->>C: replay events
  S-->>C: live events
```

---

## 6) Message state machine

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> accepted: deliver sent
  queued --> failed: preparation or route failure
  queued --> cancelled: stop or cancel
  accepted --> completed: outcome
  accepted --> failed: outcome or route lost
  accepted --> cancelled: stop
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```
