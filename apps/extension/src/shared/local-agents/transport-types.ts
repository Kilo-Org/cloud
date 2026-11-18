/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import type { LocalAgentHostMissingReason } from './connection-state';
import type {
  LocalAgentExtensionHello,
  LocalAgentIncomingEnvelope,
  LocalAgentOutgoingEnvelope,
} from './envelope';

export type LocalAgentFailure =
  | { kind: 'host_missing'; reason: LocalAgentHostMissingReason }
  | { kind: 'transport' }
  | { kind: 'protocol' }
  | { kind: 'auth' };

export type LocalAgentTransportHandle = {
  send(envelope: LocalAgentOutgoingEnvelope): void;
  close(): void;
};

export type LocalAgentTransportCallbacks = {
  onEnvelope(envelope: LocalAgentIncomingEnvelope): void;
  onReady(): void;
  onClosed(failure: LocalAgentFailure): void;
};

export type LocalAgentDial = (callbacks: LocalAgentTransportCallbacks) => LocalAgentTransportHandle;

/** Numeric handles: the browser timer value never leaves this module family. */
export type LocalAgentTimers = {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
};

export type LocalAgentHello = LocalAgentExtensionHello;

/** A dial that cannot start reports a failure the connection maps to a state. */
export class LocalAgentDialError extends Error {
  readonly failure: LocalAgentFailure;

  constructor(failure: LocalAgentFailure, message: string) {
    super(message);
    this.name = 'LocalAgentDialError';
    this.failure = failure;
  }
}
