import { z } from 'zod';
import {
  getSandboxAllocationProvider,
  normalizeSandboxAllocation,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  classifySandboxId,
  hashToSandboxId,
  isPlacedSandboxKey,
  RETIRED_SHARED_SANDBOX_MESSAGE,
  selectDefaultSandboxProvider,
  type SandboxIdClass,
  type SandboxSelectionEnv,
} from './sandbox-id.js';
import type { AgentSandboxProvider, SandboxId } from './types.js';

/**
 * What a control-plane sandbox with a neutral `sbx-` key is. The key carries no
 * routing meaning, so session metadata stores the kind and every routing rule
 * reads it from there. Legacy prefixed keys store no kind and keep routing by
 * prefix.
 *
 * A sandbox belongs to one standalone session without a workspace, or to one
 * workspace containing multiple sessions. Independent owners never share it.
 * `shared` is legacy decode only, not a topology new features must support
 * ({@link PlacedSandboxKind}).
 */
export const sandboxKindSchema = z.enum(['isolated', 'isolated-standard', 'code-review', 'shared']);

export type SandboxKind = z.infer<typeof sandboxKindSchema>;

/** The kinds a new session can be placed on. */
export type PlacedSandboxKind = Exclude<SandboxKind, 'shared'>;

/**
 * The legacy key class each kind stands in for, so class-based rules (billing
 * pools, workspace layout) keep one table for both key formats.
 */
const KIND_SANDBOX_ID_CLASS: Record<SandboxKind, SandboxIdClass> = {
  isolated: 'isolated-small',
  'isolated-standard': 'isolated-standard',
  'code-review': 'code-review',
  shared: 'shared',
};

export type ControlPlaneSandboxDecision = {
  sandboxId: SandboxId;
  provider: AgentSandboxProvider;
  sandboxKind: PlacedSandboxKind;
};

/** Fresh standalone sessions and workspace anchors get exclusive placement; workspace siblings reuse it. */
export async function selectControlPlaneSandbox(input: {
  env: SandboxSelectionEnv;
  sessionId: string;
  userId: string;
  orgId?: string;
  codeReview: boolean;
  sandboxAllocation?: SandboxAllocation;
  /** The caller's normalized choice; the resolved default never changes the kind. */
  requestedAllocation?: SandboxAllocation;
}): Promise<ControlPlaneSandboxDecision> {
  const requestedAllocation =
    input.requestedAllocation !== undefined
      ? normalizeSandboxAllocation(input.requestedAllocation)
      : input.codeReview
        ? undefined
        : input.sandboxAllocation;
  const sandboxKind = controlPlaneSandboxKind({
    codeReview: input.codeReview,
    ...(requestedAllocation !== undefined ? { sandboxAllocation: requestedAllocation } : {}),
  });
  const provider =
    input.sandboxAllocation !== undefined
      ? getSandboxAllocationProvider(input.sandboxAllocation)
      : input.codeReview
        ? 'cloudflare-containers'
        : selectDefaultSandboxProvider({
            env: input.env,
            orgId: input.orgId,
            userId: input.userId,
            isolated: sandboxKind === 'isolated',
          });
  return {
    sandboxId: await hashToSandboxId(`control-isolated-v1:${input.sessionId}`, 'sbx'),
    provider,
    sandboxKind,
  };
}

function controlPlaneSandboxKind(input: {
  codeReview: boolean;
  sandboxAllocation?: SandboxAllocation;
}): PlacedSandboxKind {
  const allocation = input.sandboxAllocation;
  if (allocation !== undefined) {
    if (input.codeReview) {
      throw new Error('Sandbox allocations cannot be combined with specialized sandbox routing');
    }
    if (allocation === 'cloudflare-shared') {
      throw new Error(RETIRED_SHARED_SANDBOX_MESSAGE);
    }
    return allocation === 'isolated-standard' ? 'isolated-standard' : 'isolated';
  }
  return input.codeReview ? 'code-review' : 'isolated';
}

/** A placed key requires a stored kind; a legacy key has none. */
export function sandboxKindMatchesKey(
  sandboxId: string,
  sandboxKind: SandboxKind | undefined
): boolean {
  return isPlacedSandboxKey(sandboxId) === (sandboxKind !== undefined);
}

/** The sandbox class from the stored kind, or from a legacy key's prefix. */
export function resolveSandboxIdClass(input: {
  sandboxId: string;
  sandboxKind?: SandboxKind;
}): SandboxIdClass {
  if (!sandboxKindMatchesKey(input.sandboxId, input.sandboxKind)) {
    throw new Error('Sandbox key and kind do not match');
  }
  return input.sandboxKind === undefined
    ? classifySandboxId(input.sandboxId)
    : KIND_SANDBOX_ID_CLASS[input.sandboxKind];
}
