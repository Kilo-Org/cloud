export type ManagedSessionInteractionPolicy = {
  question?: 'allow' | 'deny';
  permission?: 'allow' | 'auto-approve' | 'auto-reject';
  terminal?: 'allow' | 'deny';
};

export type ManagedSessionExecutionPolicy = {
  name: string;
  permissionOverrides?: Record<string, unknown>;
  tools?: Record<string, boolean>;
  interaction?: ManagedSessionInteractionPolicy;
  runtime?: {
    nonInteractive?: boolean;
  };
};

export const LEGACY_CODE_REVIEW_INTERACTION_POLICY = {
  question: 'deny',
  permission: 'auto-reject',
  terminal: 'deny',
} satisfies ManagedSessionInteractionPolicy;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteractionPolicy(value: unknown): value is ManagedSessionInteractionPolicy {
  if (!isRecord(value)) return false;
  const question = value.question;
  const permission = value.permission;
  const terminal = value.terminal;
  return (
    (question === undefined || question === 'allow' || question === 'deny') &&
    (permission === undefined ||
      permission === 'allow' ||
      permission === 'auto-approve' ||
      permission === 'auto-reject') &&
    (terminal === undefined || terminal === 'allow' || terminal === 'deny')
  );
}

export function isManagedSessionExecutionPolicy(
  value: unknown
): value is ManagedSessionExecutionPolicy {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (value.permissionOverrides !== undefined && !isRecord(value.permissionOverrides)) return false;
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) return false;
    if (!Object.values(value.tools).every(item => typeof item === 'boolean')) return false;
  }
  if (value.interaction !== undefined && !isInteractionPolicy(value.interaction)) return false;
  if (value.runtime !== undefined) {
    if (!isRecord(value.runtime)) return false;
    const nonInteractive = value.runtime.nonInteractive;
    if (nonInteractive !== undefined && typeof nonInteractive !== 'boolean') return false;
  }
  return true;
}

export function effectiveInteractionPolicy(input: {
  executionPolicy?: ManagedSessionExecutionPolicy;
  platform?: string;
}): ManagedSessionInteractionPolicy | undefined {
  if (input.executionPolicy?.interaction) return input.executionPolicy.interaction;
  return input.platform === 'code-review' ? LEGACY_CODE_REVIEW_INTERACTION_POLICY : undefined;
}

export function shouldDenyQuestionInteraction(input: {
  executionPolicy?: ManagedSessionExecutionPolicy;
  platform?: string;
}): boolean {
  return effectiveInteractionPolicy(input)?.question === 'deny';
}

export function shouldAutoRejectPermissionInteraction(input: {
  executionPolicy?: ManagedSessionExecutionPolicy;
  platform?: string;
}): boolean {
  return effectiveInteractionPolicy(input)?.permission === 'auto-reject';
}

export function shouldDenyTerminalInteraction(input: {
  executionPolicy?: ManagedSessionExecutionPolicy;
  platform?: string;
}): boolean {
  return effectiveInteractionPolicy(input)?.terminal === 'deny';
}
