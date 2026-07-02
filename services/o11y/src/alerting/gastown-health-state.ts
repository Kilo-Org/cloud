import { z } from 'zod';

const CONSECUTIVE_HEALTHY_TO_RESOLVE = 3;
const STATE_KEY = 'o11y:gastown_container_health';

// Event-driven dedup: an alert episode stays active while any town is wedged
// (exhausted or sustained). We page once when the episode opens and again only
// when the wedged town set escalates (a new town appears), then auto-resolve
// after CONSECUTIVE_HEALTHY_TO_RESOLVE clean evaluations.
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
    notifiedTownIds: z.array(z.string()),
  }),
]);

export type GastownHealthState = z.infer<typeof GastownHealthStateSchema>;

export type GastownHealthStateInput = {
  // Towns that justify paging this evaluation (exhausted or sustained).
  wedgeTownIds: string[];
  // Whether the fleet showed any successful health pings — proof the monitor is
  // seeing live telemetry, so a clean evaluation can count toward resolution.
  healthObserved: boolean;
};

export type GastownHealthTransition = {
  state: GastownHealthState;
  shouldNotify: boolean;
  stateChanged: boolean;
};

function inactiveState(): GastownHealthState {
  return { active: false, consecutiveHealthyCount: 0 };
}

function mergeSorted(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort();
}

export function transitionGastownHealthState(
  state: GastownHealthState,
  input: GastownHealthStateInput
): GastownHealthTransition {
  const wedged = input.wedgeTownIds.length > 0;

  if (wedged) {
    if (!state.active) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          notifiedTownIds: [...input.wedgeTownIds].sort(),
        },
        shouldNotify: true,
        stateChanged: true,
      };
    }

    const escalated = input.wedgeTownIds.some(id => !state.notifiedTownIds.includes(id));
    if (escalated) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          notifiedTownIds: mergeSorted(state.notifiedTownIds, input.wedgeTownIds),
        },
        shouldNotify: true,
        stateChanged: true,
      };
    }

    // Still wedged, no new towns — reset any recovery progress without paging.
    if (state.consecutiveHealthyCount > 0) {
      return {
        state: {
          active: true,
          consecutiveHealthyCount: 0,
          notifiedTownIds: state.notifiedTownIds,
        },
        shouldNotify: false,
        stateChanged: true,
      };
    }

    return { state, shouldNotify: false, stateChanged: false };
  }

  // No wedged towns this evaluation.
  if (!state.active || !input.healthObserved) {
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
      notifiedTownIds: state.notifiedTownIds,
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
    // Legacy state shapes (pre-event-driven dedup) fail the schema and safely
    // fall back to inactive — the next wedge re-opens a fresh episode.
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
