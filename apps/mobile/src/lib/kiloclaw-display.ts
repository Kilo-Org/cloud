type KiloClawDisplayInstance = {
  botName?: string | null;
  name?: string | null;
  organizationName?: string | null;
};

function firstDisplayValue(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function kiloclawConversationEyebrow(instance: KiloClawDisplayInstance | undefined) {
  return (
    firstDisplayValue([instance?.botName, instance?.name, instance?.organizationName]) ?? 'KiloClaw'
  );
}

export function kiloclawInstanceSwitcherTitle(instance: KiloClawDisplayInstance | undefined) {
  return (
    firstDisplayValue([instance?.botName, instance?.name, instance?.organizationName]) ??
    'KiloClaw instance'
  );
}
