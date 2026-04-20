// ── Client → Server ─────────────────────────────────────────────────

export type ContextSubscribeMessage = {
  type: 'context.subscribe';
  contexts: string[];
};

export type ContextUnsubscribeMessage = {
  type: 'context.unsubscribe';
  contexts: string[];
};

export type ClientMessage = ContextSubscribeMessage | ContextUnsubscribeMessage;

// ── Server → Client ─────────────────────────────────────────────────

export type EventMessage = {
  type: 'event';
  context: string;
  event: string;
  payload: unknown;
};

export type ServerMessage = EventMessage;
