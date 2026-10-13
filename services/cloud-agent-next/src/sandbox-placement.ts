import { z } from 'zod';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  classifySandboxId,
  getSandboxNamespace,
  isPlacedSandboxKey,
  type SandboxIdClass,
} from './sandbox-id.js';
import type { Env } from './types.js';

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
