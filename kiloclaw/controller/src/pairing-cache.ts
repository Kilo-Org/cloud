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

function detectChannels(config: unknown): string[] {
  if (typeof config !== 'object' || config === null) return [];
  const cfg = config as Record<string, unknown>;
  const ch = (cfg.channels ?? {}) as Record<string, Record<string, unknown> | undefined>;
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
        const { stdout } = await execImpl('openclaw', ['pairing', 'list', channel, '--json']);
        const data = JSON.parse(stdout.trim()) as { requests?: unknown[] };
        return ((data.requests ?? []) as Array<Record<string, unknown>>).map(
          (req) => ({ ...req, channel }) as unknown as ChannelPairingRequest
        );
      })
    );

    const allRequests: ChannelPairingRequest[] = [];
    let anySuccess = false;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allRequests.push(...result.value);
        anySuccess = true;
      }
    }

    if (anySuccess) {
      channelCache = { requests: allRequests, lastUpdated: nowImpl() };
    }
  };

  const refreshDevicePairing = async (): Promise<void> => {
    try {
      const { stdout } = await execImpl('openclaw', ['devices', 'list', '--json']);
      const data = JSON.parse(stdout.trim()) as { pending?: unknown[] };
      const pending = Array.isArray(data.pending) ? data.pending : [];

      const requests: DevicePairingRequest[] = pending.map(
        (req: unknown) => {
          const r = req as Record<string, unknown>;
          return {
            requestId: r.requestId as string,
            deviceId: r.deviceId as string,
            role: r.role as string | undefined,
            platform: r.platform as string | undefined,
            clientId: r.clientId as string | undefined,
            ts: r.ts as number | undefined,
          };
        }
      );

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
      await execImpl('openclaw', ['pairing', 'approve', channel, code, '--notify']);
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
      await execImpl('openclaw', ['devices', 'approve', requestId]);
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
