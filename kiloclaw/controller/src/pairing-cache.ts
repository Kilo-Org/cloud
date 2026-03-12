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
  requests: T[];
  lastUpdated: string;
};

export type ApproveResult = {
  success: boolean;
  message: string;
  statusHint: 200 | 400 | 500;
};

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
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
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

type ChannelConfig = {
  enabled?: boolean;
  botToken?: string;
  token?: string;
  appToken?: string;
};

type OpenClawConfig = {
  channels?: Record<string, ChannelConfig | undefined>;
};

function isOpenClawConfig(value: unknown): value is OpenClawConfig {
  return typeof value === 'object' && value !== null;
}

function detectChannels(config: unknown): string[] {
  if (!isOpenClawConfig(config)) return [];
  const ch = config.channels ?? {};
  const channels: string[] = [];
  if (ch.telegram?.enabled && ch.telegram?.botToken) channels.push('telegram');
  if (ch.discord?.enabled && ch.discord?.token) channels.push('discord');
  if (ch.slack?.enabled && (ch.slack?.botToken || ch.slack?.appToken)) channels.push('slack');
  return channels;
}

export function createPairingCache(options?: PairingCacheOptions): PairingCache {
  const {
    execImpl = defaultExecImpl,
    readConfigImpl = defaultReadConfigImpl,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    nowImpl = () => new Date().toISOString(),
  } = options ?? {};

  let channelCache: CacheEntry<ChannelPairingRequest> = { requests: [], lastUpdated: '' };
  let deviceCache: CacheEntry<DevicePairingRequest> = { requests: [], lastUpdated: '' };

  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshChannelPairing = async (): Promise<void> => {
    let channels: string[];
    try {
      const config = readConfigImpl();
      channels = detectChannels(config);
    } catch {
      // No config available — nothing to refresh
      return;
    }

    if (channels.length === 0) return;

    const results = await Promise.allSettled(
      channels.map(async (channel) => {
        const { stdout } = await execImpl(OPENCLAW_BIN, ['pairing', 'list', channel, '--json']);
        const parsed: unknown = JSON.parse(stdout.trim());
        const data = parsed && typeof parsed === 'object' && 'requests' in parsed
          ? parsed
          : { requests: [] };
        const requests = Array.isArray((data as { requests: unknown }).requests)
          ? (data as { requests: unknown[] }).requests
          : [];
        return requests.map((req): ChannelPairingRequest => {
          const r = req && typeof req === 'object' ? req : {};
          return {
            code: String((r as Record<string, unknown>).code ?? ''),
            id: String((r as Record<string, unknown>).id ?? ''),
            channel,
            ...('meta' in r ? { meta: (r as Record<string, unknown>).meta } : {}),
            ...('createdAt' in r ? { createdAt: String((r as Record<string, unknown>).createdAt) } : {}),
          };
        });
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
    try {
      const { stdout } = await execImpl(OPENCLAW_BIN, ['devices', 'list', '--json']);
      const parsed: unknown = JSON.parse(stdout.trim());
      const data = parsed && typeof parsed === 'object' ? parsed : {};
      const pending = 'pending' in data && Array.isArray((data as { pending: unknown }).pending)
        ? (data as { pending: unknown[] }).pending
        : [];

      const requests: DevicePairingRequest[] = pending.map((req: unknown) => {
        const r = req && typeof req === 'object' ? (req as Record<string, unknown>) : {};
        return {
          requestId: String(r.requestId ?? ''),
          deviceId: String(r.deviceId ?? ''),
          ...(r.role !== undefined ? { role: String(r.role) } : {}),
          ...(r.platform !== undefined ? { platform: String(r.platform) } : {}),
          ...(r.clientId !== undefined ? { clientId: String(r.clientId) } : {}),
          ...(typeof r.ts === 'number' ? { ts: r.ts } : {}),
        };
      });

      deviceCache = { requests, lastUpdated: nowImpl() };
    } catch {
      // Keep last-known-good
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.allSettled([refreshChannelPairing(), refreshDevicePairing()]);
  };

  const approveChannel = async (channel: string, code: string): Promise<ApproveResult> => {
    if (!CHANNEL_RE.test(channel)) {
      return { success: false, message: 'Invalid channel name', statusHint: 400 };
    }
    if (!CODE_RE.test(code)) {
      return { success: false, message: 'Invalid pairing code', statusHint: 400 };
    }

    try {
      await execImpl(OPENCLAW_BIN, ['pairing', 'approve', channel, code, '--notify']);
      await refreshChannelPairing();
      return { success: true, message: 'Pairing approved', statusHint: 200 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message, statusHint: 500 };
    }
  };

  const approveDevice = async (requestId: string): Promise<ApproveResult> => {
    if (!UUID_RE.test(requestId)) {
      return { success: false, message: 'Invalid request ID', statusHint: 400 };
    }

    try {
      await execImpl(OPENCLAW_BIN, ['devices', 'approve', requestId]);
      await refreshDevicePairing();
      return { success: true, message: 'Device approved', statusHint: 200 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message, statusHint: 500 };
    }
  };

  const onPairingLogLine = (line: string): void => {
    const lower = line.toLowerCase();
    const isPairingLine = PAIRING_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isPairingLine) return;

    // Fixed 2s delay from first trigger (non-sliding window)
    if (debounceTimer !== null) return;

    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      void refreshAll();
    }, DEBOUNCE_DELAY_MS);
  };

  const start = (): void => {
    initialTimer = setTimeoutImpl(() => {
      initialTimer = null;
      void refreshAll();
    }, INITIAL_FETCH_DELAY_MS);

    periodicTimer = setIntervalImpl(() => {
      void refreshAll();
    }, PERIODIC_INTERVAL_MS);
  };

  const cleanup = (): void => {
    if (initialTimer !== null) {
      clearTimeoutImpl(initialTimer);
      initialTimer = null;
    }
    if (periodicTimer !== null) {
      clearIntervalImpl(periodicTimer);
      periodicTimer = null;
    }
    if (debounceTimer !== null) {
      clearTimeoutImpl(debounceTimer);
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
