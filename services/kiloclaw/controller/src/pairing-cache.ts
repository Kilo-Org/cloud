import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export type ChannelPairingRequest = {
  code: string;
  id: string;
  channel: string;
  meta?: unknown;
  createdAt?: string;
};

export type DevicePairingRequest = {
  requestId: string;
  deviceId: string;
  role?: string;
  platform?: string;
  clientId?: string;
  ts?: number;
};

export type CacheEntry<T> = {
  readonly requests: readonly T[];
  readonly lastUpdated: string;
};

export type ApproveResult =
  | { success: true; message: string; statusHint: 200 }
  | { success: false; message: string; statusHint: 400 | 500 };

export type PairingCache = {
  getChannelPairing: () => CacheEntry<ChannelPairingRequest>;
  getDevicePairing: () => CacheEntry<DevicePairingRequest>;
  refreshChannelPairing: () => Promise<void>;
  refreshDevicePairing: () => Promise<void>;
  approveChannel: (channel: string, code: string) => Promise<ApproveResult>;
  approveDevice: (requestId: string) => Promise<ApproveResult>;
  onPairingLogLine: (line: string) => void;
  start: () => void;
  cleanup: () => void;
};

type ExecImpl = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type ReadChannelPairingImpl = (channel: string) => Promise<unknown>;
export type ReadDevicePairingImpl = () => Promise<unknown>;

type PairingCacheOptions = {
  execImpl?: ExecImpl;
  readConfigImpl?: () => unknown;
  nowImpl?: () => string;
  readChannelPairingImpl?: ReadChannelPairingImpl;
  readDevicePairingImpl?: ReadDevicePairingImpl;
  nowMsImpl?: () => number;
  /** Auto-approve pending device pairings from the gateway's own exec client. */
  autoApproveGatewayClient?: boolean;
};

export const PERIODIC_INTERVAL_MS = 120_000;
export const DEBOUNCE_DELAY_MS = 2_000;

export const FAILURE_RETRY_BASE_MS = 30_000;
export const FAILURE_RETRY_MAX_MS = 300_000;
// TEMPORARY: bumped from 45_000 to 180_000 because openclaw 2026.4.15 CLI
// startup takes ~65s (CPU profile shows ~55% in jiti normalizeAliases/createJiti
// from per-plugin loader churn). Revert to 45_000 once openclaw upstream
// reduces startup time. Tracking: <openclaw issue link TBD>.
export const APPROVE_TIMEOUT_MS = 180_000;
export const CONFIG_PATH = '/root/.openclaw/openclaw.json';

// TTL constants — exact matches to openclaw source
// https://github.com/openclaw/openclaw/blob/d073ec42cd7fabd1004f6959628743817a4cb0e8/src/pairing/pairing-store.ts#L15 PAIRING_PENDING_TTL_MS
export const CHANNEL_PAIRING_TTL_MS = 60 * 60 * 1000;
// https://github.com/openclaw/openclaw/blob/d073ec42cd7fabd1004f6959628743817a4cb0e8/src/infra/device-pairing.ts#L98 PENDING_TTL_MS
export const DEVICE_PAIRING_TTL_MS = 5 * 60 * 1000;

const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAIRING_KEYWORDS = ['pairing', 'pair request', 'device request', 'approve', 'paired'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function approveOk(message: string): ApproveResult {
  return { success: true, message, statusHint: 200 };
}

function approveFail(message: string, statusHint: 400 | 500): ApproveResult {
  return { success: false, message, statusHint };
}

export const OPENCLAW_BIN = '/usr/local/bin/openclaw';

// Mirrors resolveStateDir() / resolveOAuthDir() in openclaw/src/config/paths.ts
// Note: openclaw's full resolveStateDir() also does filesystem-existence checks for
// legacy dirs — those are omitted here because the container Dockerfile always
// creates /root/.openclaw, making the existence check unreachable in practice.
export function resolveOpenClawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || '/root/.openclaw';
}

export function resolveCredentialsDir(): string {
  return (
    process.env.OPENCLAW_OAUTH_DIR?.trim() || path.join(resolveOpenClawStateDir(), 'credentials')
  );
}

export function resolveDevicePendingPath(): string {
  return path.join(resolveOpenClawStateDir(), 'devices', 'pending.json');
}

function defaultExecImpl(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: APPROVE_TIMEOUT_MS,
    env: { ...process.env, HOME: '/root' },
  });
}

function defaultReadConfigImpl(): unknown {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Zod schemas for IO boundary parsing — .passthrough() keeps forward compatibility
// when openclaw adds fields without breaking the controller.
const channelPairingRequestSchema = z
  .object({
    code: z.string(),
    id: z.string(),
    meta: z.unknown().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const channelPairingFileSchema = z
  .object({
    requests: z.array(z.unknown()).catch([]),
  })
  .passthrough();

// No .passthrough() — Zod's default strip behavior drops unknown fields (including
// publicKey, which is sensitive and must not be forwarded to clients). This is
// intentional and structurally enforced: only the fields listed below survive parsing.
// See test: 'returns device requests with stripped publicKey'.
const devicePendingEntrySchema = z.object({
  requestId: z.string(),
  deviceId: z.string(),
  role: z.string().optional(),
  platform: z.string().optional(),
  clientId: z.string().optional(),
  ts: z.number().optional(),
});

const devicePendingFileSchema = z.record(z.string(), z.unknown());

// Collects entries from an iterable that pass the given schema, skipping malformed ones.
// Keeps tolerant per-entry parsing — one bad entry never kills the whole list.
function collectValidEntries<T extends z.ZodTypeAny>(
  items: Iterable<unknown>,
  schema: T
): Array<z.infer<T>> {
  const results: Array<z.infer<T>> = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      results.push(parsed.data);
    }
  }
  return results;
}

// Mirrors pruneExpiredPending() in openclaw/src/infra/pairing-files.ts:
// entries with missing ts are preserved (no expiry); entries with a ts are compared to TTL.
function isUnexpiredDeviceRequest(req: DevicePairingRequest, nowMs: number): boolean {
  if (req.ts === undefined) return true;
  return nowMs - req.ts <= DEVICE_PAIRING_TTL_MS;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function detectChannels(config: unknown): string[] {
  if (!isRecord(config)) return [];
  const ch = isRecord(config.channels) ? config.channels : {};
  const tg = isRecord(ch.telegram) ? ch.telegram : {};
  const dc = isRecord(ch.discord) ? ch.discord : {};
  const sl = isRecord(ch.slack) ? ch.slack : {};
  const channels: string[] = [];
  if (tg.enabled && tg.botToken) channels.push('telegram');
  if (dc.enabled && dc.token) channels.push('discord');
  if (sl.enabled && (sl.botToken || sl.appToken)) channels.push('slack');
  return channels;
}

export function createPairingCache(options?: PairingCacheOptions): PairingCache {
  const {
    execImpl = defaultExecImpl,
    readConfigImpl = defaultReadConfigImpl,
    nowImpl = () => new Date().toISOString(),
    readChannelPairingImpl = async (channel: string) => {
      // Path resolved at call time for testability
      const filePath = path.join(resolveCredentialsDir(), `${channel}-pairing.json`);
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
    },
    readDevicePairingImpl = async () => {
      // Path resolved at call time for testability
      const filePath = resolveDevicePendingPath();
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
    },
    nowMsImpl = () => Date.now(),
    autoApproveGatewayClient = false,
  } = options ?? {};

  let channelCache: CacheEntry<ChannelPairingRequest> = { requests: [], lastUpdated: '' };
  let deviceCache: CacheEntry<DevicePairingRequest> = { requests: [], lastUpdated: '' };

  let started = false;
  let stopped = false;
  let periodicTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let nextAllowedRefreshAt = 0;
  let hasCompletedInitialRefresh = false;
  let consecutiveFailureCount = 0;

  // Generation counters prevent stale concurrent refreshes from overwriting
  // newer data.  Each refresh captures the counter at start; if another
  // refresh bumps it before this one finishes, the stale result is discarded.
  let channelGeneration = 0;
  let deviceGeneration = 0;

  const refreshChannelPairingInternal = async (): Promise<boolean> => {
    if (stopped) return false;
    const gen = ++channelGeneration;
    let channels: string[];
    try {
      const config = readConfigImpl();
      channels = detectChannels(config);
    } catch (err) {
      console.warn(`[pairing-cache] could not read config: ${errorMessage(err)}`);
      return false;
    }

    if (channels.length === 0) {
      if (gen === channelGeneration) {
        channelCache = { requests: [], lastUpdated: nowImpl() };
      }
      return true;
    }

    const nowMs = nowMsImpl();
    const results = await Promise.allSettled(
      channels.map(async channel => {
        const parsed: unknown = await readChannelPairingImpl(channel);
        const parsedFile = channelPairingFileSchema.safeParse(parsed);
        const entries = parsedFile.success ? parsedFile.data.requests : [];
        const filtered = collectValidEntries(entries, channelPairingRequestSchema)
          .map((req): ChannelPairingRequest => ({ ...req, channel }))
          .filter(req => req.code !== '' && req.id !== '')
          .filter(req => {
            // Mirrors pairing-store.ts isExpired() — PAIRING_PENDING_TTL_MS = 60 * 60 * 1000
            // https://github.com/openclaw/openclaw/blob/d073ec42cd7fabd1004f6959628743817a4cb0e8/src/pairing/pairing-store.ts#L171
            if (!req.createdAt) return false; // falsy (undefined, empty string) → expired
            const createdAtMs = Date.parse(req.createdAt);
            if (!Number.isFinite(createdAtMs)) return false; // garbage timestamp → expired
            return nowMs - createdAtMs <= CHANNEL_PAIRING_TTL_MS;
          });
        console.log(
          `[pairing-cache] channel ${channel}: read ok, ${filtered.length} request(s) after filtering`
        );
        return filtered;
      })
    );

    const allRequests: ChannelPairingRequest[] = [];
    let anySuccess = false;
    let anyHadPriorData = false;
    let anyUnexpectedColdFailure = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allRequests.push(...result.value);
        anySuccess = true;
      } else {
        const err = result.reason;
        const msg = errorMessage(err);
        const priorRequests = channelCache.requests.filter(r => r.channel === channels[i]);
        if (priorRequests.length > 0) {
          anyHadPriorData = true;
          console.warn(`[pairing-cache] WARNING: keeping stale data for ${channels[i]}: ${msg}`);
          allRequests.push(...priorRequests);
        } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Cold-start: file not written yet — silently ignore
        } else {
          // Unexpected failure (permissions, corrupt JSON, etc.) with no prior data
          anyUnexpectedColdFailure = true;
          console.log(`[pairing-cache] channel ${channels[i]}: read failed: ${msg}`);
        }
      }
    }

    if (anySuccess) {
      if (gen === channelGeneration) {
        channelCache = { requests: allRequests, lastUpdated: nowImpl() };
      }
      return true;
    } else if (anyHadPriorData) {
      // All channels failed but some had prior data — already warned per-channel above
      console.warn('[pairing-cache] channel refresh: all channels failed, cache not updated');
      return false;
    } else if (anyUnexpectedColdFailure) {
      // Non-ENOENT failures with no prior data — trigger backoff
      return false;
    }
    // else: all failures were cold-start ENOENT — stay silent
    return true;
  };

  const refreshDevicePairingInternal = async (): Promise<boolean> => {
    if (stopped) return false;
    const gen = ++deviceGeneration;
    try {
      const parsed: unknown = await readDevicePairingImpl();
      const parsedFile = devicePendingFileSchema.safeParse(parsed);
      // Graceful fallback: if the file is valid JSON but not an object (e.g. [] or null),
      // treat as empty rather than triggering backoff — matches the channel path pattern.
      // This returns true (success), so the periodic timer stays at its normal 120s cadence
      // and self-heals on the next refresh once openclaw rewrites the file correctly.
      const entries = parsedFile.success ? Object.values(parsedFile.data) : [];
      const nowMs = nowMsImpl();

      const requests: DevicePairingRequest[] = collectValidEntries(
        entries,
        devicePendingEntrySchema
      )
        .filter(req => req.requestId !== '' && req.deviceId !== '')
        // Mirrors pairing-files.ts pruneExpiredPending() — PENDING_TTL_MS = 5 * 60 * 1000
        // https://github.com/openclaw/openclaw/blob/d073ec42cd7fabd1004f6959628743817a4cb0e8/src/infra/device-pairing.ts#L98
        .filter(req => isUnexpiredDeviceRequest(req, nowMs))
        // Mirrors listDevicePairing() sort — descending ts (newest first)
        // https://github.com/openclaw/openclaw/blob/d073ec42cd7fabd1004f6959628743817a4cb0e8/src/infra/device-pairing.ts#L261
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

      if (gen === deviceGeneration) {
        deviceCache = { requests, lastUpdated: nowImpl() };
      }
      console.log(`[pairing-cache] devices: read ok, ${requests.length} pending`);

      if (autoApproveGatewayClient) {
        const gatewayRequests = requests.filter(r => r.clientId === 'gateway-client');
        for (const req of gatewayRequests) {
          console.log(`[pairing-cache] auto-approving gateway-client device ${req.requestId}`);
          try {
            await execImpl(OPENCLAW_BIN, ['devices', 'approve', req.requestId]);
          } catch (err) {
            console.error(`[pairing-cache] auto-approve failed for ${req.requestId}:`, err);
          }
        }
        if (gatewayRequests.length > 0) {
          // Re-read after approvals so the cache reflects the updated state.
          await refreshDevicePairingInternal();
        }
      }

      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File absent means no pending requests (e.g. last request was approved/expired).
        if (gen === deviceGeneration) {
          deviceCache = { requests: [], lastUpdated: nowImpl() };
        }
        return true;
      }
      console.error(`[pairing-cache] device refresh failed: ${errorMessage(err)}`);
      return false;
    }
  };

  const refreshAll = async (): Promise<boolean> => {
    if (stopped) return false;
    const [channelOk, deviceOk] = await Promise.all([
      refreshChannelPairingInternal(),
      refreshDevicePairingInternal(),
    ]);
    const ok = channelOk && deviceOk;
    if (ok) {
      consecutiveFailureCount = 0;
      nextAllowedRefreshAt = 0;
    } else {
      consecutiveFailureCount += 1;
      const failureDelayMs = Math.min(
        FAILURE_RETRY_BASE_MS * 2 ** (consecutiveFailureCount - 1),
        FAILURE_RETRY_MAX_MS
      );
      nextAllowedRefreshAt = Date.now() + failureDelayMs;
    }
    return ok;
  };

  const scheduleNextPeriodicRefresh = (delayMs: number): void => {
    if (stopped) return;
    if (periodicTimer !== null) {
      clearTimeout(periodicTimer);
    }
    periodicTimer = setTimeout(() => {
      void runPeriodicRefresh();
    }, delayMs);
  };

  const runPeriodicRefresh = async (): Promise<void> => {
    if (stopped) return;
    console.log('[pairing-cache] periodic refresh');
    const ok = await refreshAll();
    hasCompletedInitialRefresh = true;
    const now = Date.now();
    const delayMs = ok ? PERIODIC_INTERVAL_MS : Math.max(0, nextAllowedRefreshAt - now);
    scheduleNextPeriodicRefresh(delayMs);
  };

  const runDebouncedRefresh = async (): Promise<void> => {
    if (stopped) return;
    const remaining = nextAllowedRefreshAt - Date.now();
    if (remaining > 0) {
      console.log(
        `[pairing-cache] debounced refresh skipped (backoff, ${Math.ceil(remaining / 1000)}s remaining)`
      );
      return;
    }
    console.log('[pairing-cache] debounced refresh');
    const ok = await refreshAll();
    const now = Date.now();
    const delayMs = ok ? PERIODIC_INTERVAL_MS : Math.max(0, nextAllowedRefreshAt - now);
    scheduleNextPeriodicRefresh(delayMs);
  };

  const approveChannel = async (channel: string, code: string): Promise<ApproveResult> => {
    if (stopped) return approveFail('Cache is shutting down', 500);
    if (!CHANNEL_RE.test(channel)) return approveFail('Invalid channel name', 400);
    if (!CODE_RE.test(code)) return approveFail('Invalid pairing code', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['pairing', 'approve', channel, code, '--notify']);
    } catch (err) {
      console.error('[pairing-cache] channel approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    await refreshChannelPairingInternal();
    return approveOk('Pairing approved');
  };

  const approveDevice = async (requestId: string): Promise<ApproveResult> => {
    if (stopped) return approveFail('Cache is shutting down', 500);
    if (!UUID_RE.test(requestId)) return approveFail('Invalid request ID', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['devices', 'approve', requestId]);
    } catch (err) {
      console.error('[pairing-cache] device approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    await refreshDevicePairingInternal();
    return approveOk('Device approved');
  };

  const onPairingLogLine = (line: string): void => {
    if (stopped) return;
    if (started && !hasCompletedInitialRefresh) return;
    const lower = line.toLowerCase();
    const isPairingLine = PAIRING_KEYWORDS.some(kw => lower.includes(kw));
    if (!isPairingLine) return;

    if (debounceTimer !== null) return;

    console.log(`[pairing-cache] debounce armed: "${line.slice(0, 80)}"`);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runDebouncedRefresh();
    }, DEBOUNCE_DELAY_MS);
  };

  const refreshChannelPairing = async (): Promise<void> => {
    await refreshChannelPairingInternal();
  };

  const refreshDevicePairing = async (): Promise<void> => {
    await refreshDevicePairingInternal();
  };

  const start = (): void => {
    if (started) return;
    started = true;

    // Fire-and-forget: do not await the initial refresh.  Awaiting here blocks
    // server.listen() and delays the health endpoint past the DO's 60s startup probe.
    // An empty cache during the brief warmup window is acceptable — the DO-side
    // fallback chain (controller → KV → fly exec) handles it, and the cache
    // self-heals quickly via the periodic timer and log-triggered debounce.
    void runPeriodicRefresh();
  };

  const cleanup = (): void => {
    stopped = true;
    if (periodicTimer !== null) {
      clearTimeout(periodicTimer);
      periodicTimer = null;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  return {
    getChannelPairing: () => channelCache,
    getDevicePairing: () => deviceCache,
    refreshChannelPairing,
    refreshDevicePairing,
    approveChannel,
    approveDevice,
    onPairingLogLine,
    start,
    cleanup,
  };
}
