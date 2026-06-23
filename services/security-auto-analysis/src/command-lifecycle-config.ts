const DEFAULT_ACCEPTED_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUNNING_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_RETENTION_DAYS = 30;

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvString(env: unknown, key: string): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function getSecurityAgentCommandLifecycleConfig(env: unknown): {
  acceptedCommandTimeoutMs: number;
  runningCommandTimeoutMs: number;
  commandRetentionMs: number;
} {
  const retentionDays = readPositiveInteger(
    readEnvString(env, 'SECURITY_AGENT_COMMAND_RETENTION_DAYS'),
    DEFAULT_COMMAND_RETENTION_DAYS
  );

  return {
    acceptedCommandTimeoutMs: readPositiveInteger(
      readEnvString(env, 'SECURITY_AGENT_COMMAND_ACCEPTED_TIMEOUT_MS'),
      DEFAULT_ACCEPTED_COMMAND_TIMEOUT_MS
    ),
    runningCommandTimeoutMs: readPositiveInteger(
      readEnvString(env, 'SECURITY_AGENT_COMMAND_RUNNING_TIMEOUT_MS'),
      DEFAULT_RUNNING_COMMAND_TIMEOUT_MS
    ),
    commandRetentionMs: retentionDays * 24 * 60 * 60 * 1000,
  };
}
