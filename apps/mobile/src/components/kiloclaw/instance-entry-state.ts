type InstanceLike = {
  sandboxId: string;
};

type KiloClawEntryDecision = { kind: 'loading' } | { kind: 'empty' } | { kind: 'list' };

export function getKiloClawEntryDecision(
  instances: readonly InstanceLike[] | undefined
): KiloClawEntryDecision {
  if (instances === undefined) {
    return { kind: 'loading' };
  }
  if (instances.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'list' };
}
