/**
 * Transport interface — abstracts the connection between event sources and processors.
 *
 * Each transport is the single source of truth for what it can do.
 * Command methods are optional — present only on interactive transports.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { Images } from '@/lib/images-schema';
import type { CloudAgentSessionId } from './types';

/** Sink callbacks that a transport pushes typed events into. */
type TransportSink = {
  onChatEvent: (event: ChatEvent) => void;
  onServiceEvent: (event: ServiceEvent) => void;
};

/** Lifecycle interface for a transport. */
type Transport = {
  connect(): void;
  disconnect(): void;
  destroy(): void;

  // Commands — present only on interactive transports
  send?: (payload: {
    prompt: string;
    mode?: string;
    model?: string;
    variant?: string;
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
    prompt: string;
    mode?: string;
    model?: string;
    variant?: string;
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

export type { TransportSink, Transport, TransportFactory, CloudAgentApi };
