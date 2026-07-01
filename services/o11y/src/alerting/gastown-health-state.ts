import { z } from 'zod';
import type { GastownHealthMetrics } from './gastown-health-query';

const CONSECUTIVE_HEALTHY_TO_RESOLVE = 3;
const STATE_KEY = 'o11y:gastown_container_health';

const GastownHealthStateSchema = z.discriminatedUnion('active', [
  z.object({
    active: z.literal(false),
    consecutiveHealthyCount: z.literal(0),
  }),
  z.object({
    active: z.literal(true),
    consecutiveHealthyCount: z
      .number()
      .int()
      .min(0)
      .max(CONSECUTIVE_HEALTHY_TO_RESOLVE - 1),
    lastNotifiedWeightedFailedChecks: z.number().finite().nonnegative().optional(),
  }),
]);

export type GastownHealthState = z.infer<typeof GastownHealthStateSchema>;

export type GastownHealthTransition = {
  state: GastownHealthState;
  shouldNotify: boolean;
  stateChanged: boolean;
};

function inactiveState(): GastownHealthState {
  return { active: false, consecutiveHealthyCount: 0 };
}

export function transitionGastownHealthState(
  state: GastownHealthState,
  metrics: GastownHealthMetrics,
  thresholdCrossed: boolean,
  renotifyFailedChecksStep: number
): GastownHealthTransition {
  if (thresholdCrossed) {
    if (!state.active) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          lastNotifiedWeightedFailedChecks: metrics.weightedFailedChecks,
        },
        shouldNotify: true,
        stateChanged: true,
      };
    }

    if (state.lastNotifiedWeightedFailedChecks === undefined) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          lastNotifiedWeightedFailedChecks:
            Math.floor(metrics.weightedFailedChecks / renotifyFailedChecksStep) *
            renotifyFailedChecksStep,
        },
        shouldNotify: false,
        stateChanged: true,
      };
    }

    if (
      metrics.weightedFailedChecks >=
      state.lastNotifiedWeightedFailedChecks + renotifyFailedChecksStep
    ) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          lastNotifiedWeightedFailedChecks: metrics.weightedFailedChecks,
        },
        shouldNotify: true,
        stateChanged: true,
      };
    }

    if (state.consecutiveHealthyCount > 0) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          lastNotifiedWeightedFailedChecks: state.lastNotifiedWeightedFailedChecks,
        },
        shouldNotify: false,
        stateChanged: true,
      };
    }

    return { state, shouldNotify: false, stateChanged: false };
  }

  if (!state.active || metrics.weightedSuccessfulChecks <= 0) {
    return { state, shouldNotify: false, stateChanged: false };
  }

  const consecutiveHealthyCount = state.consecutiveHealthyCount + 1;
  if (consecutiveHealthyCount >= CONSECUTIVE_HEALTHY_TO_RESOLVE) {
    return { state: inactiveState(), shouldNotify: false, stateChanged: true };
  }

  return {
    state: {
      active: true,
      consecutiveHealthyCount,
      lastNotifiedWeightedFailedChecks: state.lastNotifiedWeightedFailedChecks,
    },
    shouldNotify: false,
    stateChanged: true,
  };
}

export async function readGastownHealthState(kv: KVNamespace): Promise<GastownHealthState> {
  const raw = await kv.get(STATE_KEY);
  if (raw === null) return inactiveState();

  try {
    const parsed = GastownHealthStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : inactiveState();
  } catch {
    return inactiveState();
  }
}

export async function writeGastownHealthState(
  kv: KVNamespace,
  state: GastownHealthState
): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}
