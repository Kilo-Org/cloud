# Kilo-Chat Presence

## Context

The event service has a WebSocket connection per user. Clients subscribe/unsubscribe to conversation contexts for event delivery. Presence is a separate concern — it tracks user liveness and lets users opt into being visible to others in a conversation.

## Model

Two layers:

### User liveness (global)

A map of `{ userId → lastPingAt }`. Updated by a periodic heartbeat from every connected client.

- **`presence.ping`** (client → server) — updates `lastPingAt` for the user. No context, no broadcast. Sent on a 5s interval by the client, started on connect, stopped on disconnect.

### Context visibility (per-context)

A map of `{ userId, context → visible }`. Controlled by explicit user opt-in.

- **`presence.show`** `{ context }` (client → server) — sets `visible = true` for this user+context. Broadcasts `presence.joined { context, userId }` to other visible users in the same context. Returns nothing.
- **`presence.hide`** `{ context }` (client → server) — sets `visible = false`. Broadcasts `presence.left { context, userId }` to remaining visible users. Returns nothing.
- **`presence.sync`** `{ context }` (client → server) — server responds with `presence.sync { context, userIds }` listing currently visible users. Client sends this when it needs the current state (e.g., entering a conversation).

## WS message types

### Client → server

```
{ type: 'presence.ping' }
{ type: 'presence.show', context: string }
{ type: 'presence.hide', context: string }
{ type: 'presence.sync', context: string }
```

### Server → client

```
{ type: 'presence.joined', context: string, userId: string }
{ type: 'presence.left', context: string, userId: string }
{ type: 'presence.sync', context: string, userIds: string[] }
```

## RPC methods

- **`isUserInContext(userId, context)`** — returns true if user has an entry for that context (regardless of `visible`). Rename of existing `userPresent`. Used by kilo-chat's auto-mark-read logic in `createMessageFor`.

No new RPC methods needed.

## Client integration (EventServiceClient)

- On connect, start a 5s interval sending `presence.ping`. On disconnect, stop it.
- `showPresence(context)` — sends `presence.show`.
- `hidePresence(context)` — sends `presence.hide`.
- `requestPresenceSync(context)` — sends `presence.sync` request.
- Event handlers: `onPresenceJoined`, `onPresenceLeft`, `onPresenceSync`.
- No automatic replay on reconnect. Clients request `presence.sync` when they need the state.

## kilo-chat frontend integration (future)

A `usePresence` hook will:
- Call `showPresence(context)` on mount, `hidePresence(context)` on unmount.
- Call `requestPresenceSync(context)` on mount to get initial state.
- Listen for `presenceJoined` / `presenceLeft` to maintain a live `Set<string>` of present userIds.
- Expose `presentMembers` for UI consumption.

No UI in this iteration — just the plumbing.

## Persistence

The presence store is persisted (not in-memory). Entries survive server restarts. Stale cleanup is not implemented in this iteration — entries remain until explicitly changed.

## Not in scope

- Stale entry cleanup / TTL
- Automatic replay of `presence.show` on reconnect
- Presence UI
- `getVisibleMembers` RPC method
