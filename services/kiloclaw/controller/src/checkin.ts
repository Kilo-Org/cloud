import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { z } from 'zod';
import type { OpenclawVersionInfo } from './openclaw-version';
import type { ProductTelemetry } from './product-telemetry';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from './version';
import type { SupervisorStats } from './supervisor';

const CHECKIN_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

/** How often to include product telemetry in a checkin (~24h). */
export const PRODUCT_TELEMETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Random jitter range added to the interval (±2h). */
export const PRODUCT_TELEMETRY_JITTER_MS = 2 * 60 * 60 * 1000;

export type NetStats = { bytesIn: number; bytesOut: number };

export type DiskStats = { usedBytes: number; totalBytes: number } | null;

const NetStatsSchema = z.object({
  bytesIn: z.number().int().min(0),
  bytesOut: z.number().int().min(0),
});

function normalizeNetStats(value: unknown): NetStats {
  const parsed = NetStatsSchema.safeParse(value);
  if (!parsed.success) {
    return { bytesIn: 0, bytesOut: 0 };
  }
  return parsed.data;
}

export type CheckinDeps = {
  getApiKey: () => string;
  getGatewayToken: () => string;
  getSandboxId: () => string;
  getCheckinUrl: () => string;
  getSupervisorStats: () => SupervisorStats;
  getOpenclawVersion: () => Promise<OpenclawVersionInfo>;
  getProductTelemetry: (openclawVersion: string | null) => ProductTelemetry;
  getMachineId?: () => string;
  /** Exposed for testing — defaults to `Math.random()`. */
  randomFn?: () => number;
};

export function parseNetLine(line: string): NetStats {
  const parts = line.trim().split(/\s+/);
  return normalizeNetStats({
    bytesIn: Number.parseInt(parts[1] ?? '', 10) || 0,
    bytesOut: Number.parseInt(parts[9] ?? '', 10) || 0,
  });
}

export function parseNetDevText(raw: string): NetStats {
  const lines = raw.split('\n');

  const eth0Line = lines.find(line => line.trim().startsWith('eth0:'));
  if (eth0Line) {
    return parseNetLine(eth0Line);
  }

  let bytesIn = 0;
  let bytesOut = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('|') || !trimmed.includes(':') || trimmed.startsWith('lo:')) {
      continue;
    }
    const stats = parseNetLine(trimmed);
    bytesIn += stats.bytesIn;
    bytesOut += stats.bytesOut;
  }

  return normalizeNetStats({ bytesIn, bytesOut });
}

export async function readNetStats(): Promise<NetStats> {
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    return parseNetDevText(raw);
  } catch {
    return { bytesIn: 0, bytesOut: 0 };
  }
}

/**
 * Parse the output of `df -B1 --output=avail,size /`. Returns null if unparseable.
 * Columns: avail (available bytes), size (total bytes). Matches the column order used
 * by cloud-agent/src/workspace.ts and cloud-agent-next/src/workspace.ts.
 * usedBytes is derived as totalBytes - availableBytes (df does not report used directly).
 */
export function parseDfOutput(raw: string): DiskStats {
  const lines = raw.trim().split('\n');
  const dataLine = lines[lines.length - 1]?.trim();
  const match = dataLine?.match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  const availableBytes = parseInt(match[1], 10);
  const totalBytes = parseInt(match[2], 10);
  return { usedBytes: Math.max(0, totalBytes - availableBytes), totalBytes };
}

/**
 * Read disk usage for the root filesystem via `df`.
 * Returns null on any error — non-fatal for checkin.
 * Keep in sync with: cloud-agent/src/workspace.ts, cloud-agent-next/src/workspace.ts
 */
export async function readDiskStats(): Promise<DiskStats> {
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=avail,size', '/root']);
    return parseDfOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * Compute the next product-telemetry deadline: base interval + uniform jitter
 * in the range [-JITTER, +JITTER].
 */
export function nextProductTelemetryDeadline(
  now: number,
  randomFn: () => number = Math.random
): number {
  const jitter = (randomFn() * 2 - 1) * PRODUCT_TELEMETRY_JITTER_MS;
  return now + PRODUCT_TELEMETRY_INTERVAL_MS + jitter;
}

export function startCheckin(deps: CheckinDeps): () => void {
  const checkinUrl = deps.getCheckinUrl();
  if (!checkinUrl) {
    return () => {};
  }

  const randomFn = deps.randomFn ?? Math.random;
  let previousRestarts = deps.getSupervisorStats().restarts;
  let previousNetStats: NetStats = { bytesIn: 0, bytesOut: 0 };
  let checkinInFlight = false;

  // Start with 0 so the first checkin always includes product telemetry.
  let nextProductTelemetryAt = 0;

  void readNetStats().then(stats => {
    previousNetStats = stats;
  });

  const doCheckin = async (): Promise<void> => {
    if (checkinInFlight) {
      return;
    }
    checkinInFlight = true;

    try {
      const apiKey = deps.getApiKey();
      const gatewayToken = deps.getGatewayToken();
      const sandboxId = deps.getSandboxId();
      if (!apiKey || !gatewayToken || !sandboxId) {
        return;
      }

      const stats = deps.getSupervisorStats();
      const openclawVersion = await deps.getOpenclawVersion();
      const [currentNetStats, diskStats] = await Promise.all([readNetStats(), readDiskStats()]);

      const restartsSinceLastCheckin = Math.max(0, stats.restarts - previousRestarts);
      const bandwidthBytesIn = Math.max(0, currentNetStats.bytesIn - previousNetStats.bytesIn);
      const bandwidthBytesOut = Math.max(0, currentNetStats.bytesOut - previousNetStats.bytesOut);

      const lastExitReason = stats.lastExit
        ? stats.lastExit.signal
          ? `signal:${stats.lastExit.signal}`
          : stats.lastExit.code !== null
            ? `code:${stats.lastExit.code}`
            : ''
        : '';

      // Include product telemetry when the deadline has passed.
      const now = Date.now();
      const includeProductTelemetry = now >= nextProductTelemetryAt;
      const productTelemetry = includeProductTelemetry
        ? deps.getProductTelemetry(openclawVersion.version)
        : undefined;

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(checkinUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-kiloclaw-gateway-token': gatewayToken,
          },
          signal: controller.signal,
          body: JSON.stringify({
            sandboxId,
            machineId: deps.getMachineId?.() ?? process.env.FLY_MACHINE_ID ?? '',
            controllerVersion: CONTROLLER_VERSION,
            controllerCommit: CONTROLLER_COMMIT,
            openclawVersion: openclawVersion.version,
            openclawCommit: openclawVersion.commit,
            supervisorState: stats.state,
            totalRestarts: stats.restarts,
            restartsSinceLastCheckin,
            uptimeSeconds: stats.uptime,
            loadAvg5m: loadavg()[1] ?? 0,
            bandwidthBytesIn,
            bandwidthBytesOut,
            lastExitReason,
            diskUsedBytes: diskStats?.usedBytes ?? null,
            diskTotalBytes: diskStats?.totalBytes ?? null,
            productTelemetry,
          }),
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[checkin] HTTP ${response.status}: ${errorText}`);
        return;
      }

      // Only advance baselines after a successful checkin.
      previousRestarts = stats.restarts;
      previousNetStats = currentNetStats;

      if (includeProductTelemetry) {
        nextProductTelemetryAt = nextProductTelemetryDeadline(Date.now(), randomFn);
      }
    } catch (err) {
      console.error('[checkin] failed:', err);
    } finally {
      checkinInFlight = false;
    }
  };

  let interval: ReturnType<typeof setInterval> | undefined;

  const initialTimeout = setTimeout(() => {
    void doCheckin();
    interval = setInterval(() => {
      void doCheckin();
    }, CHECKIN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  return () => {
    clearTimeout(initialTimeout);
    if (interval) {
      clearInterval(interval);
    }
  };
}
