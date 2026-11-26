import { SIGNER_LOCATION_HINT } from '../dos/stubs';
import type { ConsumeResult } from '../dos/UtsReplayDO';
import type { Env, UtsConfig } from '../env';
import { DPOP_IAT_WINDOW_SECONDS, type DpopProof } from './dpop';

/** `unavailable`: the replay object did not answer; the proof was neither accepted nor refused. */
export type ReplayOutcome = 'fresh' | 'replayed' | 'unavailable' | 'misconfigured';

/** Records a verified proof in the replay object of `grantId` (design 5.7). */
export type ReplayAccess = (grantId: string, proof: DpopProof) => Promise<ReplayOutcome>;

/**
 * The proof stays recorded until no clock within the 60-second window could accept it, plus one
 * second for the clock difference between the Worker and the object.
 */
export function replayNotAfter(proof: DpopProof): number {
  return (proof.iat + DPOP_IAT_WINDOW_SECONDS + 1) * 1000;
}

/**
 * One call, never retried: a retry after a call whose write landed would report the proof as
 * replayed. A failed call answers `unavailable`, and the client retries with a new proof.
 */
export function replayAccess(env: Env, config: UtsConfig): ReplayAccess {
  const namespace =
    config.jurisdiction === 'eu' ? env.UTS_REPLAY_DO.jurisdiction('eu') : env.UTS_REPLAY_DO;
  return async (grantId, proof) => {
    const stub = namespace.get(namespace.idFromName(`${config.environment}:replay:${grantId}`), {
      locationHint: SIGNER_LOCATION_HINT,
    });
    let result: ConsumeResult;
    try {
      result = await stub.consume(proof.jti, replayNotAfter(proof));
    } catch (error) {
      console.error(JSON.stringify({ event: 'uts.replay.failed', error: String(error) }));
      return 'unavailable';
    }
    if (result.status === 'misconfigured') {
      console.error(JSON.stringify({ event: 'uts.replay.misconfigured', reason: result.reason }));
    }
    return result.status;
  };
}
