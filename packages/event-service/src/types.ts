// Client → Server
export type RpcMessage = {
  id: string;
  type: 'rpc';
  service: string;
  method: string;
  payload: unknown;
};

export type ContextSubscribeMessage = {
  type: 'context.subscribe';
  contexts: string[];
};

export type ContextUnsubscribeMessage = {
  type: 'context.unsubscribe';
  contexts: string[];
};

export type ClientMessage = RpcMessage | ContextSubscribeMessage | ContextUnsubscribeMessage;

// Server → Client
export type RpcResponseMessage = {
  id: string;
  type: 'rpc.response';
  payload: unknown;
};

export type RpcErrorMessage = {
  id: string;
  type: 'rpc.error';
  error: { code: number; body: unknown };
};

export type EventMessage = {
  type: 'event';
  context: string;
  event: string;
  payload: unknown;
};

export type ServerMessage = RpcResponseMessage | RpcErrorMessage | EventMessage;

// Config
export type EventServiceConfig = {
  url: string;
  getToken: () => Promise<string>;
};
