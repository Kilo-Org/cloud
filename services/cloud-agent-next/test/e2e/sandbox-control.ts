/**
 * Docker helpers for the lifecycle scenarios.
 *
 * Cloudflare's `wrangler dev` + @cloudflare/containers runtime launches sandbox
 * containers with synthesized names. The exact naming convention isn't pinned
 * by this repo, so we match on a stable substring (`Sandbox`) plus the worker
 * name (`cloud-agent-next-dev`) when present. Lifecycle tests snapshot the
 * current set before starting a session when they need to identify that session's
 * newly created sandbox.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SandboxContainer = {
  id: string;
  name: string;
  image: string;
  isProxy: boolean;
};

/**
 * List running sandbox containers. Returns proxy containers separately so
 * callers can kill them together with their primary.
 */
export async function listSandboxContainers(): Promise<SandboxContainer[]> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--format',
    '{{.ID}}\t{{.Names}}\t{{.Image}}',
  ]);
  const result: SandboxContainer[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [id, name, image] = line.split('\t');
    if (!id || !name || !image) continue;
    // Match sandbox DO container names. cloudflare/containers uses a naming
    // scheme that includes the DO class name; we match on `Sandbox` (covers
    // both `Sandbox` and `SandboxSmall`) plus the dev worker prefix when
    // present. Relaxed match keeps the harness robust to wrangler version
    // changes.
    const isSandbox =
      (name.includes('cloud-agent-next-dev') || name.includes('cloud-agent-next')) &&
      (name.includes('Sandbox') || image.includes('cloudflare/sandbox'));
    if (!isSandbox) continue;
    result.push({ id, name, image, isProxy: name.endsWith('-proxy') });
  }
  return result;
}

/**
 * Kill a container by ID. Swallows "no such container" errors so callers can
 * be defensive without try/catch.
 */
export async function killContainer(idOrName: string): Promise<void> {
  try {
    await execFileAsync('docker', ['kill', idOrName]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return;
    throw err;
  }
}

/** Block until a primary sandbox appears that was not present in `knownIds`. */
export async function waitForNewSandboxPresent(
  knownIds: Set<string>,
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listSandboxContainers();
    const primary = containers.find(c => !c.isProxy && !knownIds.has(c.id));
    if (primary) return primary;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function sandboxFamilyNames(sandbox: SandboxContainer): Set<string> {
  const primaryName = sandbox.isProxy ? sandbox.name.replace(/-proxy$/, '') : sandbox.name;
  return new Set([primaryName, `${primaryName}-proxy`]);
}

/** Kill one sandbox container plus its proxy sibling when present. */
export async function killSandboxFamily(sandbox: SandboxContainer): Promise<string[]> {
  const familyNames = sandboxFamilyNames(sandbox);
  const containers = await listSandboxContainers();
  const killed: string[] = [];
  for (const container of containers) {
    if (!familyNames.has(container.name)) continue;
    await killContainer(container.id);
    killed.push(container.name);
  }
  return killed;
}

/** Block until a sandbox container and its proxy sibling are gone. */
export async function waitForSandboxFamilyGone(
  sandbox: SandboxContainer,
  timeoutMs: number
): Promise<boolean> {
  const familyNames = sandboxFamilyNames(sandbox);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listSandboxContainers();
    if (!containers.some(container => familyNames.has(container.name))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Read the wrapper log file inside a running sandbox container. Used for
 * smoke tests to assert "using fake kilo client" is present after boot.
 *
 * Returns null if the wrapper log isn't findable — the wrapper writes to
 * `/tmp/kilocode-wrapper-*.log`, so we glob for the newest file.
 */
export async function readWrapperLog(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      containerId,
      'sh',
      '-c',
      'ls -t /tmp/kilocode-wrapper-*.log 2>/dev/null | head -n 1 | xargs -r cat',
    ]);
    return stdout || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return null;
    throw err;
  }
}

/**
 * Read the newest kilo CLI log file inside a running sandbox container.
 *
 * The wrapper writes CLI logs under `/home/${agentSessionId}/.local/share/kilo/log/*.log`
 * (see `services/cloud-agent-next/wrapper/src/server.ts:249`). This helper
 * avoids waiting on the 30s log-uploader cycle.
 */
export async function readKiloCliLog(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      containerId,
      'sh',
      '-c',
      'ls -t /home/agent_*/.local/share/kilo/log/*.log 2>/dev/null | head -n 1 | xargs -r cat',
    ]);
    return stdout || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return null;
    throw err;
  }
}

/**
 * Tail the last `maxLines` lines of a (potentially large) log blob. Keeps
 * failure output readable in the harness.
 */
export function tailLines(log: string | null, maxLines = 200): string {
  if (!log) return '<empty>';
  const lines = log.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}
