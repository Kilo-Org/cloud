// ── Client → Server ─────────────────────────────────────────────────

export type ContextSubscribeMessage = {
  type: 'context.subscribe';
  contexts: string[];
};

export type ContextUnsubscribeMessage = {
  type: 'context.unsubscribe';
  contexts: string[];
};

export type PresencePingMessage = {
  type: 'presence.ping';
};

export type PresenceShowMessage = {
  type: 'presence.show';
  context: string;
};

export type PresenceHideMessage = {
  type: 'presence.hide';
  context: string;
};

export type ClientMessage =
  | ContextSubscribeMessage
  | ContextUnsubscribeMessage
  | PresencePingMessage
  | PresenceShowMessage
  | PresenceHideMessage;

// ── Server → Client ─────────────────────────────────────────────────

export type EventMessage = {
  type: 'event';
  context: string;
  event: string;
  payload: unknown;
};

export type PresenceJoinedMessage = {
  type: 'presence.joined';
  context: string;
  userId: string;
};

export type PresenceLeftMessage = {
  type: 'presence.left';
  context: string;
  userId: string;
};

export type ServerMessage = EventMessage | PresenceJoinedMessage | PresenceLeftMessage;
