/**
 * Local push sink (dev/E2E-only seam, §4.15). iOS simulators cannot obtain
 * valid Expo/APNs push tokens, so a real Expo send from the local stack
 * cannot succeed against a simulator. The sink replaces the Expo call with
 * a token-redacted payload recording + terminal `delivered` state, so
 * E2E can drive the full chain to a `dispatched` outcome without APNs.
 *
 * Activation is the opt-in `PUSH_SINK_MODE` var (e.g. `PUSH_SINK_MODE=log`),
 * supplied via the repository's local dev env mechanism (`.dev.vars` from
 * `pnpm dev:env`) and intentionally absent from `wrangler.jsonc` (which
 * is single-config production). Default-off: any value other than the
 * exact string `'log'` (including unset and empty) leaves the real Expo
 * send path in place.
 */

type SinkEnv = { PUSH_SINK_MODE?: string };

/**
 * Test override for the sink-mode decision. Production reads
 * `env.PUSH_SINK_MODE` exactly once per call; tests set this to force a
 * known value without mutating the miniflare env proxy. The DO test suite
 * uses this to verify the sink is off by default and on when forced.
 */
let sinkModeOverride: string | undefined;

export function setPushSinkModeForTesting(mode: string | undefined): void {
  sinkModeOverride = mode;
}

export function isPushSinkEnabled(env: SinkEnv): boolean {
  if (sinkModeOverride !== undefined) {
    return sinkModeOverride === 'log';
  }
  return env.PUSH_SINK_MODE === 'log';
}

export const PUSH_SINK_PAYLOAD_EVENT = 'agent_push_sink_payload';
