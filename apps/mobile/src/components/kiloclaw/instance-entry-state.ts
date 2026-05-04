type InstanceLike = {
  sandboxId: string;
};

export type KiloClawEntryDecision =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'redirect'; sandboxId: string }
  | { kind: 'list' };

export function getKiloClawEntryDecision(
  instances: readonly InstanceLike[] | undefined
): KiloClawEntryDecision {
  if (instances === undefined) {
    return { kind: 'loading' };
  }
  if (instances.length === 0) {
    return { kind: 'empty' };
  }
  const first = instances[0];
  if (instances.length === 1 && first !== undefined) {
    return { kind: 'redirect', sandboxId: first.sandboxId };
  }
  return { kind: 'list' };
}
