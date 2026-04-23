/**
 * Thin wrapper around `openclaw secrets reload`.
 *
 * `secrets reload` is a WebSocket RPC against the local gateway that
 * atomically re-resolves SecretRefs from live env/file/exec providers and
 * swaps the in-memory snapshot. Unlike SIGUSR1 (which does a full gateway
 * restart and aborts in-flight agent work, channels, and watchers), this
 * leaves active sessions untouched.
 *
 * Used on API key rotation: after updating `process.env.KILOCODE_API_KEY`,
 * we call this to propagate the new value to the running gateway without
 * a restart.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process';

const DEFAULT_GATEWAY_PORT = 3001;
const DEFAULT_TIMEOUT_MS = 10_000;

export type GatewayRpcDeps = {
  execFileSync: (
    cmd: string,
    args: string[],
    opts: { encoding: 'utf8'; stdio: 'pipe'; timeout: number; env?: NodeJS.ProcessEnv }
  ) => string;
};

const defaultDeps: GatewayRpcDeps = {
  execFileSync: (cmd, args, opts) => nodeExecFileSync(cmd, args, opts).toString(),
};

export type ReloadGatewaySecretsOptions = {
  token: string;
  port?: number;
  timeoutMs?: number;
};

export type ReloadGatewaySecretsResult = { ok: true } | { ok: false; error: string };

const REDACTED = '<redacted-token>';
const MIN_REDACT_LEN = 8;

/**
 * Strip `token` out of `text` so the return value is safe to log. `execFileSync`
 * builds its error message from the full argv, which means a raw throw will
 * embed the `--token <token>` segment verbatim — and tokens must not end up
 * in controller logs or Sentry (see AGENTS.md).
 *
 * Tokens shorter than `MIN_REDACT_LEN` are not redacted to avoid mangling
 * unrelated text with coincidental substrings. Real gateway tokens are
 * HMAC-derived 64-character hex strings, so the floor is purely a safety
 * net against test fixtures or misconfiguration.
 */
function redactToken(text: string, token: string): string {
  if (token.length < MIN_REDACT_LEN) return text;
  return text.split(token).join(REDACTED);
}

/**
 * Invoke `openclaw secrets reload` against the local gateway. Never throws —
 * callers can branch on `result.ok` and fall back (e.g., to SIGUSR1) if the
 * reload fails because the gateway is not currently running.
 *
 * The returned `error` has the token scrubbed so callers can log it safely.
 */
export function reloadGatewaySecrets(
  options: ReloadGatewaySecretsOptions,
  deps: GatewayRpcDeps = defaultDeps
): ReloadGatewaySecretsResult {
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `ws://127.0.0.1:${port}`;

  try {
    deps.execFileSync(
      'openclaw',
      ['secrets', 'reload', '--url', url, '--token', options.token, '--json'],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: timeoutMs,
      }
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: redactToken(message, options.token) };
  }
}
