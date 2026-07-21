/**
 * Transport interface — abstracts the connection between event sources and processors.
 *
 * Each transport is the single source of truth for what it can do.
 * Command methods are optional — present only on interactive transports.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type { Images } from '@/lib/images-schema';
import type { CloudAgentSessionId, KiloSessionId } from './types';
import type { ModelRef, RemoteModelOverride } from './remote-model-catalog';

/**
 * Ready-to-render file part for a remote-CLI `send_message` call. Distinct
 * from the cloud-only `attachments` field on {@link TransportSendInput}:
 * the remote CLI fetches these from the `url` and classifies them by
 * their `filename` (which MUST be the server-issued `<uuid>.<ext>`) and
 * `mime` (which the caller derives from the validated extension).
 *
 * Deliberately the minimum the CLI needs: `id` / `sessionID` / `messageID`
 * are not part of the send payload because the CLI assigns them when it
 * materializes the user message.
 */
type RemoteAttachmentPart = {
  type: 'file';
  mime: string;
  filename: string;
  url: string;
};

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
  /**
   * Fired once a connect/reconnect cycle has finished replaying history and
   * has switched to delivering live events. Lets consumers distinguish a
   * historical `message.updated` (replayed from a snapshot, may be stale)
   * from a live one (happened just now, authoritative).
   */
  onReplayComplete?: () => void;
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
  model?: ModelRef;
  variant?: string;
};
type SendCommandPayload = {
  type: 'command';
  command: string;
  /** Verbatim args after the command name; kilo expands $1/$2/$ARGUMENTS. */
  arguments: string;
};
type TransportSendPayload = SendPromptPayload | SendCommandPayload;

type CloudAgentPromptPayload = {
  type: 'prompt';
  prompt: string;
  mode: string;
  model: string;
  variant?: string;
};
type CloudAgentSendPayload = CloudAgentPromptPayload | SendCommandPayload;

type TransportSendInput = {
  payload: TransportSendPayload;
  messageId?: string;
  attachments?: CloudAgentAttachments;
  images?: Images;
  remoteModelOverride?: RemoteModelOverride;
  /**
   * Ready file parts to append to the remote CLI's `send_message` `parts`
   * array (after the text part). Distinct from the cloud-only `attachments`
   * field: this path is for CAPABLE remote CLI sessions (the session
   * advertised `capabilities.attachments: true` in its most recent
   * heartbeat). Transports that don't support the path (cloud-agent, read-
   * only, non-capable remote) ignore it.
   */
  attachmentParts?: RemoteAttachmentPart[];
};

/** Lifecycle interface for a transport. */
type Transport = {
  connect(): void;
  disconnect(): void;
  destroy(): void;

  // Commands — present only on interactive transports
  send?: (payload: TransportSendInput) => Promise<unknown>;
  canSend?: () => boolean;
  retryRemoteModels?: () => void;
  /** Re-discover the remote slash command catalog for the current owner. No-op when no owner is known or a request is already in flight. */
  retryRemoteCommands?: () => void;
  /**
   * Ask the currently connected CLI owner to create a new remote session and
   * return its branded `KiloSessionId`. Session-scoped: the current Kilo
   * sessionId is sent so the CLI can select the workspace, and an expected owner
   * connectionId fences the request to the active CLI. Implementations must not
   * auto-retry: a network failure is a hard reject so the caller can surface a
   * retryable error. The caller does NOT switch the active session as a side
   * effect.
   */
  createSession?: () => Promise<KiloSessionId>;
  exitCli?: () => Promise<void>;
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
    payload: CloudAgentSendPayload;
    messageId?: string;
    attachments?: CloudAgentAttachments;
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
  CloudAgentPromptPayload,
  CloudAgentSendPayload,
  CloudAgentStreamTicket,
  CloudAgentStreamTicketResult,
  RemoteAttachmentPart,
  TransportFactory,
  TransportSink,
  Transport,
  TransportSendInput,
  TransportSendPayload,
  SendPromptPayload,
  SendCommandPayload,
};
