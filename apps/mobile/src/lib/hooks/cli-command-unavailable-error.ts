import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';

type CliCommand = 'list_models' | 'list_directories';

/**
 * The rejection a CLI-command query throws for the SDK's retryable `transport`
 * outcome, so React Query owns the retry. The app-wide `QueryCache.onError`
 * reports it once, after the query's last retry failed: at warning level,
 * because a CLI that is offline or reconnecting is expected, under one stable
 * fingerprint per command, with the SDK's caught failure as `cause`.
 */
export function cliCommandUnavailableError(
  command: CliCommand,
  message: string,
  cause: unknown
): Error {
  const telemetry: TelemetryDescription = {
    level: 'warning',
    fingerprint: ['cli-command-unavailable', command],
    tags: { 'error.subsystem': 'cli-command', 'error.operation': command },
  };
  return Object.assign(new Error(message, { cause }), { [TELEMETRY_DESCRIPTION_KEY]: telemetry });
}
