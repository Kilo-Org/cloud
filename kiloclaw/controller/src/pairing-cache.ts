import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

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

type ExecImpl = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

type PairingCacheOptions = {
  execImpl?: ExecImpl;
  readConfigImpl?: () => unknown;
  nowImpl?: () => string;
};

export const PERIODIC_INTERVAL_MS = 60_000;
export const DEBOUNCE_DELAY_MS = 2_000;
export const INITIAL_FETCH_DELAY_MS = 5_000;
export const CLI_TIMEOUT_MS = 45_000;
export const CONFIG_PATH = '/root/.openclaw/openclaw.json';

const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAIRING_KEYWORDS = ['pairing', 'pair request', 'device request', 'approve', 'paired'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function approveOk(message: string): ApproveResult {
  return { success: true as const, message, statusHint: 200 as const };
}

function approveFail(message: string, statusHint: 400 | 500): ApproveResult {
  return { success: false as const, message, statusHint };
}

export const OPENCLAW_BIN = '/usr/local/bin/openclaw';

function defaultExecImpl(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, HOME: '/root' },
  });
}

function defaultReadConfigImpl(): unknown {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] {
  const val = obj[key];
  return Array.isArray(val) ? val : [];
}

function detectChannels(config: unknown): string[] {
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
  } = options ?? {};

  let channelCache: CacheEntry<ChannelPairingRequest> = { requests: [], lastUpdated: '' };
  let deviceCache: CacheEntry<DevicePairingRequest> = { requests: [], lastUpdated: '' };

  let started = false;
  let stopped = false;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshChannelPairing = async (): Promise<void> => {
    if (stopped) return;
    let channels: string[];
    try {
      const config = readConfigImpl();
      channels = detectChannels(config);
    } catch (err) {
      console.warn(`[pairing-cache] could not read config: ${errorMessage(err)}`);
      return;
    }

    if (channels.length === 0) return;

    const results = await Promise.allSettled(
      channels.map(async (channel) => {
        const { stdout } = await execImpl(OPENCLAW_BIN, ['pairing', 'list', channel, '--json']);
        const parsed: unknown = JSON.parse(stdout.trim());
        const data = isRecord(parsed) ? parsed : {};
        const requests = getArray(data, 'requests');
        return requests
          .map((req): ChannelPairingRequest => {
            const r = isRecord(req) ? req : {};
            return {
              code: String(r.code ?? ''),
              id: String(r.id ?? ''),
              channel,
              ...('meta' in r ? { meta: r.meta } : {}),
              ...('createdAt' in r ? { createdAt: String(r.createdAt) } : {}),
            };
          })
          .filter((req) => req.code !== '' && req.id !== '');
      })
    );

    const allRequests: ChannelPairingRequest[] = [];
    let anySuccess = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allRequests.push(...result.value);
        anySuccess = true;
      } else {
        const err = result.reason;
        const msg = err && typeof err === 'object' && 'stderr' in err
          ? String(err.stderr).trim()
          : String(err);
        console.error(`[pairing-cache] ${channels[i]}: ${msg}`);
      }
    }

    if (anySuccess) {
      channelCache = { requests: allRequests, lastUpdated: nowImpl() };
    }
  };

  const refreshDevicePairing = async (): Promise<void> => {
    if (stopped) return;
    try {
      const { stdout } = await execImpl(OPENCLAW_BIN, ['devices', 'list', '--json']);
      const parsed: unknown = JSON.parse(stdout.trim());
      const data = isRecord(parsed) ? parsed : {};
      const pending = getArray(data, 'pending');

      const requests: DevicePairingRequest[] = pending
        .map((req: unknown) => {
          const r = isRecord(req) ? req : {};
          return {
            requestId: String(r.requestId ?? ''),
            deviceId: String(r.deviceId ?? ''),
            ...(r.role !== undefined ? { role: String(r.role) } : {}),
            ...(r.platform !== undefined ? { platform: String(r.platform) } : {}),
            ...(r.clientId !== undefined ? { clientId: String(r.clientId) } : {}),
            ...(typeof r.ts === 'number' ? { ts: r.ts } : {}),
          };
        })
        .filter((req) => req.requestId !== '' && req.deviceId !== '');

      deviceCache = { requests, lastUpdated: nowImpl() };
    } catch (err) {
      console.error(`[pairing-cache] device refresh failed: ${errorMessage(err)}`);
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.allSettled([refreshChannelPairing(), refreshDevicePairing()]);
  };

  const approveChannel = async (channel: string, code: string): Promise<ApproveResult> => {
    if (!CHANNEL_RE.test(channel)) return approveFail('Invalid channel name', 400);
    if (!CODE_RE.test(code)) return approveFail('Invalid pairing code', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['pairing', 'approve', channel, code, '--notify']);
    } catch (err) {
      console.error('[pairing-cache] channel approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    try {
      await refreshChannelPairing();
    } catch (err) {
      console.warn('[pairing-cache] post-approve channel refresh failed:', errorMessage(err));
    }
    return approveOk('Pairing approved');
  };

  const approveDevice = async (requestId: string): Promise<ApproveResult> => {
    if (!UUID_RE.test(requestId)) return approveFail('Invalid request ID', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['devices', 'approve', requestId]);
    } catch (err) {
      console.error('[pairing-cache] device approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    try {
      await refreshDevicePairing();
    } catch (err) {
      console.warn('[pairing-cache] post-approve device refresh failed:', errorMessage(err));
    }
    return approveOk('Device approved');
  };

  const onPairingLogLine = (line: string): void => {
    if (stopped) return;
    const lower = line.toLowerCase();
    const isPairingLine = PAIRING_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isPairingLine) return;

    // Non-sliding debounce: the first trigger in a quiet window starts a 2s timer;
    // further triggers during that window are ignored.
    if (debounceTimer !== null) return;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refreshAll().catch(err => {
        console.error('[pairing-cache] debounced refreshAll failed:', err);
      });
    }, DEBOUNCE_DELAY_MS);
  };

  const start = (): void => {
    if (started) return;
    started = true;

    initialTimer = setTimeout(() => {
      initialTimer = null;
      void refreshAll().catch(err => {
        console.error('[pairing-cache] initial refreshAll failed:', err);
      });
    }, INITIAL_FETCH_DELAY_MS);

    periodicTimer = setInterval(() => {
      void refreshAll().catch(err => {
        console.error('[pairing-cache] periodic refreshAll failed:', err);
      });
    }, PERIODIC_INTERVAL_MS);
  };

  const cleanup = (): void => {
    stopped = true;
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (periodicTimer !== null) {
      clearInterval(periodicTimer);
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
