/**
 * Transport interface — abstracts the connection between event sources and processors.
 *
 * Each transport is the single source of truth for what it can do.
 * Command methods are optional — present only on interactive transports.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { Images } from '@/lib/images-schema';
import type { CloudAgentSessionId } from './types';

type CloudAgentStreamTicket = {
  ticket: string;
  /** Unix timestamp in seconds when the ticket expires. */
  expiresAt?: number;
};

type CloudAgentStreamTicketResult = string | CloudAgentStreamTicket;

/** Sink callbacks that a transport pushes typed events into. */
type TransportSink = {
  onChatEvent: (event: ChatEvent) => void;
  onServiceEvent: (event: ServiceEvent) => void;
};

/**
 * Discriminated send payload — free-text prompt or structured slash command.
 *
 * Both variants ride the same `sendMessageV2` tRPC method on the worker;
 * the orchestrator branches at the final wrapper call (prompt vs command).
 */
type SendPromptPayload = {
  type: 'prompt';
  prompt: string;
  mode?: string;
  model?: string;
  variant?: string;
};
type SendCommandPayload = {
  type: 'command';
  command: string;
  /** Verbatim args after the command name; kilo expands $1/$2/$ARGUMENTS. */
  arguments: string;
};
type TransportSendPayload = SendPromptPayload | SendCommandPayload;

/** Lifecycle interface for a transport. */
type Transport = {
  connect(): void;
  disconnect(): void;
  destroy(): void;

  // Commands — present only on interactive transports
  send?: (payload: {
    payload: TransportSendPayload;
    messageId?: string;
    images?: Images;
  }) => Promise<unknown>;
  interrupt?: () => Promise<unknown>;
  answer?: (payload: { requestId: string; answers: string[][] }) => Promise<unknown>;
  reject?: (payload: { requestId: string }) => Promise<unknown>;
  respondToPermission?: (payload: {
    requestId: string;
    response: 'once' | 'always' | 'reject';
  }) => Promise<unknown>;
  /** Accept a `suggest` tool action. Requires Kilo CLI >= v7.2.7 on the remote side. */
  acceptSuggestion?: (payload: { requestId: string; index: number }) => Promise<unknown>;
  /** Dismiss a `suggest` tool request. Requires Kilo CLI >= v7.2.7 on the remote side. */
  dismissSuggestion?: (payload: { requestId: string }) => Promise<unknown>;
};

/** Factory signature — creates a transport wired to the given sink. */
type TransportFactory = (sink: TransportSink) => Transport;

/**
 * Bundle of tRPC-backed cloud agent operations.
 * Session-independent — the transport binds it to a specific session
 * by closing over the cloudAgentSessionId.
 */
type CloudAgentApi = {
  send: (payload: {
    sessionId: CloudAgentSessionId;
    payload: TransportSendPayload;
    messageId?: string;
    images?: Images;
  }) => Promise<unknown>;
  interrupt: (payload: { sessionId: CloudAgentSessionId }) => Promise<unknown>;
  answer: (payload: {
    sessionId: CloudAgentSessionId;
    requestId: string;
    answers: string[][];
  }) => Promise<unknown>;
  reject: (payload: { sessionId: CloudAgentSessionId; requestId: string }) => Promise<unknown>;
  respondToPermission: (payload: {
    sessionId: CloudAgentSessionId;
    requestId: string;
    response: 'once' | 'always' | 'reject';
  }) => Promise<unknown>;
};

export type {
  CloudAgentApi,
  CloudAgentStreamTicket,
  CloudAgentStreamTicketResult,
  TransportFactory,
  TransportSink,
  Transport,
  TransportSendPayload,
  SendPromptPayload,
  SendCommandPayload,
};
