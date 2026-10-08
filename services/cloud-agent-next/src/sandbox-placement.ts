import { z } from 'zod';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  getSandboxAllocationProvider,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  classifySandboxId,
  getSandboxNamespace,
  hashToSandboxId,
  isPlacedSandboxKey,
  selectDefaultSandboxProvider,
  sharedSandboxOwnerKey,
  type SandboxIdClass,
  type SandboxSelectionEnv,
} from './sandbox-id.js';
import type { AgentSandboxProvider, Env, SandboxId } from './types.js';

/**
 * What a control-plane sandbox with a neutral `sbx-` key is. The key carries no
 * routing meaning, so session metadata stores the kind and every routing rule
 * reads it from there. Legacy prefixed keys store no kind and keep routing by
 * prefix.
 */
export const sandboxKindSchema = z.enum(['isolated', 'code-review', 'shared']);

export type SandboxKind = z.infer<typeof sandboxKindSchema>;

type SandboxNamespaceEnv = Pick<
  Env,
  | 'Sandbox'
  | 'SandboxContainment'
  | 'SandboxSmallContainment'
  | 'SandboxCodeReviewContainment'
  | 'SandboxDIND'
>;

/**
 * The legacy key class each kind stands in for, so class-based rules (billing
 * pools, workspace layout) keep one table for both key formats.
 */
const KIND_SANDBOX_ID_CLASS: Record<SandboxKind, SandboxIdClass> = {
  isolated: 'isolated-small',
  'code-review': 'code-review',
  shared: 'shared',
};

/** The contained pool per kind; the same mapping the legacy prefixes encode. */
const CONTAINED_NAMESPACE = {
  isolated: 'SandboxSmallContainment',
  'code-review': 'SandboxCodeReviewContainment',
  shared: 'SandboxContainment',
} as const satisfies Record<SandboxKind, keyof SandboxNamespaceEnv>;

export type ControlPlaneSandboxDecision = {
  sandboxId: SandboxId;
  provider: AgentSandboxProvider;
  sandboxKind: SandboxKind;
};

/** The one sandbox decision for a new control-plane session: kind, provider and neutral key. */
export async function selectControlPlaneSandbox(input: {
  env: SandboxSelectionEnv;
  sessionId: string;
  userId: string;
  orgId?: string;
  botId?: string;
  codeReview: boolean;
  sandboxAllocation?: SandboxAllocation;
}): Promise<ControlPlaneSandboxDecision> {
  const sandboxKind = controlPlaneSandboxKind(input);
  const provider =
    input.sandboxAllocation === undefined
      ? selectDefaultSandboxProvider({
          env: input.env,
          orgId: input.orgId,
          userId: input.userId,
          plane: 'control',
          isolated: sandboxKind === 'isolated',
        })
      : getSandboxAllocationProvider(input.sandboxAllocation);
  return { sandboxId: await placedSandboxKey(sandboxKind, input), provider, sandboxKind };
}

/** Sessions are isolated by default; only an explicit shared allocation shares a sandbox. */
function controlPlaneSandboxKind(input: {
  codeReview: boolean;
  sandboxAllocation?: SandboxAllocation;
}): SandboxKind {
  const allocation = input.sandboxAllocation;
  if (allocation !== undefined) {
    if (input.codeReview) {
      throw new Error('Sandbox allocations cannot be combined with specialized sandbox routing');
    }
    if (allocation === 'isolated-standard') {
      throw new Error('Isolated Standard allocation is not supported for control-plane sessions');
    }
    return allocation === 'cloudflare-shared' ? 'shared' : 'isolated';
  }
  return input.codeReview ? 'code-review' : 'isolated';
}

function placedSandboxKey(
  sandboxKind: SandboxKind,
  input: { sessionId: string; userId: string; orgId?: string; botId?: string }
): Promise<SandboxId> {
  return sandboxKind === 'shared'
    ? hashToSandboxId(
        `control-shared-v2:${sharedSandboxOwnerKey(input.orgId, input.userId, input.botId)}`,
        'sbx'
      )
    : hashToSandboxId(`control-isolated-v1:${input.sessionId}`, 'sbx');
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

/**
 * The Cloudflare Sandbox namespace from the stored kind, or from a legacy key's
 * prefix. A placed key without its kind is rejected by the prefix table.
 */
export function resolveSandboxNamespace(
  env: SandboxNamespaceEnv,
  input: { sandboxId: string; sandboxKind?: SandboxKind; contained: boolean }
): DurableObjectNamespace<Sandbox> {
  if (input.sandboxKind === undefined) {
    return getSandboxNamespace(env, input.sandboxId, { managedScmContainment: input.contained });
  }
  // Every non-contained sandbox runs in the standard pool, as for legacy keys.
  return input.contained ? env[CONTAINED_NAMESPACE[input.sandboxKind]] : env.Sandbox;
}
