import {
  assertValidEnvironmentKey,
  validateEnvironmentCommands,
  validateEnvironmentName,
  validateEnvironmentPlainVars,
  validateEnvironmentSecretValue,
  validateEnvironmentVarCount,
  type EnvironmentSecretChange,
} from '@kilocode/cloud-agent-profile';

export type EnvironmentPlainVarDraft = {
  key: string;
  value: string;
};

export type EnvironmentSecretDraft = {
  key: string;
  value: string;
  /** Loaded from the server; an untouched row is retained, not resent. */
  existing: boolean;
  /** An existing row marked for deletion. */
  deleted: boolean;
};

function activePlainVarDrafts(
  drafts: readonly EnvironmentPlainVarDraft[]
): EnvironmentPlainVarDraft[] {
  const rows: EnvironmentPlainVarDraft[] = [];
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (key === '' && draft.value === '') continue;
    rows.push({ key, value: draft.value });
  }
  return rows;
}

function activeSecretDrafts(drafts: readonly EnvironmentSecretDraft[]): EnvironmentSecretDraft[] {
  const rows: EnvironmentSecretDraft[] = [];
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (key === '' && draft.value === '' && !draft.existing) continue;
    rows.push({ ...draft, key });
  }
  return rows;
}

export function toEnvironmentCommands(commands: readonly string[]): string[] {
  const trimmed: string[] = [];
  for (const command of commands) {
    const value = command.trim();
    if (value !== '') trimmed.push(value);
  }
  return trimmed;
}

export function toEnvironmentPlainVars(
  drafts: readonly EnvironmentPlainVarDraft[]
): Record<string, string> {
  return Object.fromEntries(activePlainVarDrafts(drafts).map(row => [row.key, row.value]));
}

export function toEnvironmentSecretsRecord(
  drafts: readonly EnvironmentSecretDraft[]
): Record<string, string> {
  return Object.fromEntries(activeSecretDrafts(drafts).map(row => [row.key, row.value]));
}

export function toEnvironmentSecretChanges(
  drafts: readonly EnvironmentSecretDraft[]
): EnvironmentSecretChange[] {
  const changes: EnvironmentSecretChange[] = [];
  for (const draft of activeSecretDrafts(drafts)) {
    if (draft.deleted) {
      if (draft.existing) changes.push({ key: draft.key, delete: true });
      continue;
    }
    // An existing secret with no replacement keeps its stored value.
    if (draft.existing && draft.value === '') continue;
    changes.push({ key: draft.key, value: draft.value });
  }
  return changes;
}

function assertUniqueKeys(keys: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`Duplicate ${label} key "${key}"`);
    seen.add(key);
  }
}

/** Returns the first problem the contract would reject, or null when valid. */
export function validateEnvironmentForm(input: {
  name: string;
  plainVars: readonly EnvironmentPlainVarDraft[];
  secrets: readonly EnvironmentSecretDraft[];
  commands: readonly string[];
}): string | null {
  try {
    validateEnvironmentName(input.name);

    const plainVars = activePlainVarDrafts(input.plainVars);
    const secrets = activeSecretDrafts(input.secrets);
    const plainKeys = plainVars.map(row => row.key);
    const secretKeys = secrets.map(row => row.key);

    assertUniqueKeys(plainKeys, 'variable');
    assertUniqueKeys(secretKeys, 'secret');
    for (const key of plainKeys) {
      if (secretKeys.includes(key)) {
        return `"${key}" cannot be both a variable and a secret`;
      }
    }

    validateEnvironmentPlainVars(Object.fromEntries(plainVars.map(row => [row.key, row.value])));
    for (const secret of secrets) {
      assertValidEnvironmentKey(secret.key);
      if (!secret.existing && secret.value === '') {
        return `Enter a value for secret ${secret.key}`;
      }
      if (secret.value !== '') validateEnvironmentSecretValue(secret.value);
    }

    validateEnvironmentCommands(toEnvironmentCommands(input.commands));
    validateEnvironmentVarCount(plainVars.length + secrets.filter(row => !row.deleted).length);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid environment';
  }
}
