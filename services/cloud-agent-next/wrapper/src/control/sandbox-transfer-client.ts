import { CONTROL_LOG_ARCHIVE_NAME } from '../../../src/shared/control-diagnostics.js';

export const SANDBOX_TRANSFER_DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4_000;
const RETRYABLE_STATUS_CODES = new Set([429]);
const REQUEST_GRANT_RETRY_DELAY_MS = 30_000;

export type SandboxTransferGrant = {
  grant: string;
  expiresAt: number;
};

export type SandboxTransferBody = BodyInit | (() => BodyInit | Promise<BodyInit>);

export type SandboxTransferPutInput = {
  body: SandboxTransferBody;
  contentLength?: number;
  contentType?: string;
  sha256?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type SandboxTransferDeleteInput = {
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type SandboxTransferUnavailableReason = 'timeout' | 'network' | 'aborted';

export type SandboxTransferResult =
  | { status: 'ok'; statusCode: number; body?: unknown }
  | { status: 'rejected'; statusCode: number; body?: unknown }
  | { status: 'unavailable'; statusCode?: number; reason: SandboxTransferUnavailableReason };

export type SandboxTransferClientOptions = {
  /** Base URL the route paths are appended to. */
  baseUrl: string;
  /**
   * Launch-time grant. Omit it when the launch identity may not match this
   * process; the first request then waits for `renewGrant`.
   */
  grant?: string;
  /** Expiry of the launch-time grant, parsed from its JWT when omitted. */
  expiresAt?: number;
  /** Renewal callback; only called while `setConnected(true)`. */
  renewGrant?: () => Promise<SandboxTransferGrant>;
  /**
   * Launch-time route and grant used when the current grant is absent and
   * renewal is unavailable, for example while connecting or against a Worker
   * that predates `transferGrants`.
   */
  fallback?: { baseUrl: string; grant: string };
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  log?: (message: string) => void;
};

export type SandboxTransferClient = {
  put(path: string, input: SandboxTransferPutInput): Promise<SandboxTransferResult>;
  delete(path: string, input?: SandboxTransferDeleteInput): Promise<SandboxTransferResult>;
  setConnected(connected: boolean): void;
  currentGrant(): SandboxTransferGrant | undefined;
  stop(): void;
};

export function sandboxTransferPath(prefix: string | undefined, name: string): string {
  const cleanPrefix = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  return cleanPrefix === '' ? name : `${cleanPrefix}/${name}`;
}

export function sandboxTransferArchivePath(prefix: string | undefined): string {
  return sandboxTransferPath(prefix, CONTROL_LOG_ARCHIVE_NAME);
}

function grantExpiryFromToken(grant: string): number | undefined {
  const parts = grant.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function reusableBody(body: SandboxTransferBody): boolean {
  return typeof body === 'function' || !(body instanceof ReadableStream);
}

function requestHeaders(
  grant: string,
  input: {
    contentType?: string;
    contentLength?: number;
    sha256?: string;
    headers?: Record<string, string>;
  }
): Record<string, string> {
  const headers: Record<string, string> = { ...input.headers, Authorization: `Bearer ${grant}` };
  if (input.contentType !== undefined) headers['Content-Type'] = input.contentType;
  if (input.contentLength !== undefined) headers['Content-Length'] = String(input.contentLength);
  if (input.sha256 !== undefined) headers['X-Content-SHA256'] = input.sha256;
  return headers;
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createSandboxTransferClient(
  options: SandboxTransferClientOptions
): SandboxTransferClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? SANDBOX_TRANSFER_DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const log = options.log ?? ((): void => undefined);
  const base = options.baseUrl.replace(/\/+$/, '');
  const fallback =
    options.fallback === undefined
      ? undefined
      : {
          baseUrl: options.fallback.baseUrl.replace(/\/+$/, ''),
          grant: options.fallback.grant,
        };

  let current: SandboxTransferGrant | undefined =
    options.grant === undefined
      ? undefined
      : {
          grant: options.grant,
          expiresAt: options.expiresAt ?? grantExpiryFromToken(options.grant) ?? now(),
        };
  let connected = false;
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let renewing: Promise<boolean> | undefined;

  function clearRenewalTimer(): void {
    if (renewalTimer !== undefined) {
      clearTimer(renewalTimer);
      renewalTimer = undefined;
    }
  }

  function scheduleRenewal(): void {
    clearRenewalTimer();
    if (stopped || !connected || options.renewGrant === undefined || renewing !== undefined) return;
    const activeGrant = current;
    if (activeGrant === undefined) {
      void renew().then(renewed => {
        if (!renewed && connected) scheduleRenewalRetry();
      });
      return;
    }
    const remaining = activeGrant.expiresAt - now();
    if (remaining <= 0) {
      void renew().then(renewed => {
        if (!renewed && connected) scheduleRenewalRetry();
      });
      return;
    }
    renewalTimer = setTimer(
      () => {
        renewalTimer = undefined;
        void renew().then(renewed => {
          if (!renewed && connected) scheduleRenewalRetry();
        });
      },
      Math.max(0, Math.floor(remaining / 2))
    );
    renewalTimer.unref?.();
  }

  function scheduleRenewalRetry(): void {
    clearRenewalTimer();
    if (stopped || !connected || options.renewGrant === undefined) return;
    renewalTimer = setTimer(() => {
      renewalTimer = undefined;
      void renew().then(renewed => {
        if (!renewed && connected) scheduleRenewalRetry();
      });
    }, REQUEST_GRANT_RETRY_DELAY_MS);
    renewalTimer.unref?.();
  }

  function renew(): Promise<boolean> {
    if (stopped || !connected || options.renewGrant === undefined) return Promise.resolve(false);
    if (renewing !== undefined) return renewing;
    let pending: Promise<SandboxTransferGrant>;
    try {
      pending = options.renewGrant();
    } catch (error) {
      log(
        `sandbox transfer grant renewal failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return Promise.resolve(false);
    }
    let renewed = false;
    renewing = pending
      .then(
        next => {
          current = next;
          renewed = true;
          return true;
        },
        error => {
          log(
            `sandbox transfer grant renewal failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return false;
        }
      )
      .finally(() => {
        renewing = undefined;
        if (renewed) scheduleRenewal();
      });
    return renewing;
  }

  async function sendAttempt(
    method: 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined
  ): Promise<{ result: SandboxTransferResult; hadResponse: boolean }> {
    if (signal?.aborted) {
      return { result: { status: 'unavailable', reason: 'aborted' }, hadResponse: false };
    }
    const controller = new AbortController();
    let timedOut = false;
    let rejectInterrupted: ((error: Error) => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const onAbort = (): void => {
      controller.abort();
      rejectInterrupted?.(new Error('Control transfer request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
      rejectInterrupted?.(new Error('Control transfer request timed out'));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'error',
          signal: controller.signal,
        }),
        interruption,
      ]);
      const parsed = await responseBody(response);
      const result: SandboxTransferResult = response.ok
        ? {
            status: 'ok',
            statusCode: response.status,
            ...(parsed === undefined ? {} : { body: parsed }),
          }
        : {
            status: 'rejected',
            statusCode: response.status,
            ...(parsed === undefined ? {} : { body: parsed }),
          };
      return { result, hadResponse: true };
    } catch {
      return {
        result: {
          status: 'unavailable',
          reason: signal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network',
        },
        hadResponse: false,
      };
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function request(
    method: 'PUT' | 'DELETE',
    path: string,
    input: {
      body?: SandboxTransferBody;
      contentLength?: number;
      contentType?: string;
      sha256?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<SandboxTransferResult> {
    const requestPath = path.replace(/^\/+/, '');
    let attemptsUsed = 0;
    let renewed = false;
    while (true) {
      if (stopped) return { status: 'unavailable', reason: 'aborted' };
      let activeGrant: { grant: string } | undefined = current;
      let requestBase = base;
      if (activeGrant === undefined) {
        if (connected && options.renewGrant !== undefined && (await renew())) {
          activeGrant = current;
        } else if (fallback !== undefined) {
          activeGrant = fallback;
          requestBase = fallback.baseUrl;
        }
        if (activeGrant === undefined) {
          return { status: 'unavailable', reason: 'network' };
        }
      }
      if (attemptsUsed > 0) await sleep(backoff(attemptsUsed));
      attemptsUsed += 1;
      let body: BodyInit | undefined;
      try {
        body =
          input.body === undefined
            ? undefined
            : typeof input.body === 'function'
              ? await input.body()
              : input.body;
      } catch {
        return { status: 'unavailable', reason: 'network' };
      }
      const attempt = await sendAttempt(
        method,
        `${requestBase}/${requestPath}`,
        requestHeaders(activeGrant.grant, input),
        body,
        input.signal
      );
      const result = attempt.result;
      if (
        result.status === 'rejected' &&
        result.statusCode === 401 &&
        !renewed &&
        connected &&
        options.renewGrant !== undefined &&
        reusableBody(input.body ?? '')
      ) {
        renewed = true;
        if (await renew()) continue;
      }
      if (result.status === 'rejected') {
        const retryable = RETRYABLE_STATUS_CODES.has(result.statusCode) || result.statusCode >= 500;
        if (retryable && attemptsUsed < attempts && reusableBody(input.body ?? '')) continue;
      }
      if (result.status === 'unavailable' && result.reason === 'network') {
        if (attemptsUsed < attempts && reusableBody(input.body ?? '')) continue;
      }
      return result;
    }

    function backoff(used: number): number {
      const baseDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, used - 1));
      return baseDelay + Math.floor(random() * Math.max(1, baseDelayMs));
    }
  }

  return {
    put(path, input) {
      return request('PUT', path, input);
    },
    delete(path, input = {}) {
      return request('DELETE', path, input);
    },
    setConnected(next) {
      connected = next;
      if (connected) scheduleRenewal();
      else clearRenewalTimer();
    },
    currentGrant() {
      return current;
    },
    stop() {
      stopped = true;
      clearRenewalTimer();
    },
  };
}
