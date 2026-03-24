/**
 * Transport interface — abstracts the connection between event sources and processors.
 *
 * For the current WebSocket case: one transport normalizes and routes to both sinks.
 * For future separate-source case: each processor gets its own transport.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';

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
  /** Optional — only CliLiveTransport implements this. */
  sendCommand?: (command: string, data: unknown) => Promise<unknown>;
};

/** Factory signature — creates a transport wired to the given sink. */
type TransportFactory = (sink: TransportSink) => Transport;

export type { TransportSink, Transport, TransportFactory };
