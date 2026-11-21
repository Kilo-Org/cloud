import { z } from 'zod';

/*
 * Per-endpoint connection state (SPEC transport work): one discriminated union
 * with named transitions, so a late result from an older attempt can be
 * rejected by comparing attempts instead of mutating shared booleans.
 */

export type LocalAgentHostMissingReason = 'not_installed' | 'permission_denied';

export type LocalAgentConnectionState =
  | { kind: 'off' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'handshaking'; attempt: number }
  | { kind: 'connected'; attempt: number }
  | { kind: 'backoff'; attempt: number; until: number }
  | { kind: 'host_missing'; reason: LocalAgentHostMissingReason };

export const INITIAL_LOCAL_AGENT_CONNECTION_STATE: LocalAgentConnectionState = { kind: 'off' };

export const connectionStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }),
  z.object({ attempt: z.number().int().nonnegative(), kind: z.literal('connecting') }),
  z.object({ attempt: z.number().int().nonnegative(), kind: z.literal('handshaking') }),
  z.object({ attempt: z.number().int().nonnegative(), kind: z.literal('connected') }),
  z.object({
    attempt: z.number().int().nonnegative(),
    kind: z.literal('backoff'),
    until: z.number(),
  }),
  z.object({
    kind: z.literal('host_missing'),
    reason: z.enum(['not_installed', 'permission_denied']),
  }),
]);

export const isLiveConnectionState = (state: LocalAgentConnectionState): boolean =>
  state.kind === 'connecting' || state.kind === 'handshaking' || state.kind === 'connected';

/** 1s, 2s, 4s, ... capped at 60s. Deterministic so tests and the alarm agree. */
export const backoffDelayMs = (attempt: number): number =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
