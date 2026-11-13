import {
  backgroundActivityInventorySchema,
  type BackgroundActivityInventory,
  type BackgroundJob,
} from '@kilocode/session-ingest-contracts';
import type { CloudAgentApi } from './transport';

export function serializeBackgroundActivityReads(
  read: NonNullable<CloudAgentApi['getBackgroundActivity']>
): NonNullable<CloudAgentApi['getBackgroundActivity']> {
  const pending = new Map<string, Promise<unknown>>();
  return async ({ sessionId, signal }) => {
    while (pending.has(sessionId)) {
      signal?.throwIfAborted();
      await pending.get(sessionId)?.catch(() => undefined);
    }
    signal?.throwIfAborted();
    const request = read({ sessionId });
    pending.set(sessionId, request);
    try {
      const result = await request;
      signal?.throwIfAborted();
      return result;
    } finally {
      if (pending.get(sessionId) === request) pending.delete(sessionId);
    }
  };
}

export type BackgroundActivityState =
  | { status: 'inactive' | 'loading' | 'unavailable' }
  | { status: 'current'; inventory: BackgroundActivityInventory };
export type BackgroundActivityItem = BackgroundJob & {
  waiting: boolean;
  descendant: boolean;
  parentLabel?: string;
};

export function selectBackgroundActivity(
  inventory: BackgroundActivityInventory
): BackgroundActivityItem[] {
  const sessions = new Map(inventory.sessions.map(session => [session.id, session]));
  function within(id: string, ancestor: string) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = sessions.get(current)?.parentID;
    }
    return false;
  }
  const jobs = new Map(inventory.jobs.map(job => [job.id, job]));
  return [...jobs.values()]
    .filter(job => job.status === 'running' && within(job.sessionID, inventory.sessionID))
    .map(job => ({
      ...job,
      waiting: inventory.waits.some(wait =>
        job.kind === 'subagent'
          ? within(wait.sessionID, job.childSessionID)
          : wait.sessionID === job.sessionID
      ),
      descendant: job.sessionID !== inventory.sessionID,
      ...(job.sessionID !== inventory.sessionID
        ? { parentLabel: sessions.get(job.sessionID)?.title ?? 'Descendant agent' }
        : {}),
    }));
}

function countBackgroundActivity(inventory: BackgroundActivityInventory) {
  const items = selectBackgroundActivity(inventory);
  return {
    agents: items.filter(item => item.kind === 'subagent' && !item.waiting).length,
    shells: items.filter(item => item.kind === 'shell' && !item.waiting).length,
    waiting: items.filter(item => item.waiting).length,
  };
}

function plural(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function backgroundActivityLabel(state: BackgroundActivityState): string {
  if (state.status === 'unavailable') return 'Background · Status unavailable';
  if (state.status !== 'current') return 'Background · Checking status';
  const { agents, shells, waiting } = countBackgroundActivity(state.inventory);
  const labels = ['Background'];
  if (agents) labels.push(`${plural(agents, 'agent')} running`);
  if (shells) labels.push(`${plural(shells, 'shell')} running`);
  if (waiting) labels.push(`${waiting} needs input`);
  return labels.join(' · ');
}

export function backgroundActivitySummary(state: BackgroundActivityState): string {
  if (state.status === 'unavailable') return 'Status unavailable';
  if (state.status !== 'current') return 'Checking status';
  const { agents, shells, waiting } = countBackgroundActivity(state.inventory);
  const labels: string[] = [];
  if (agents) labels.push(plural(agents, 'agent'));
  if (shells) labels.push(plural(shells, 'shell'));
  if (waiting) labels.push(`${waiting} needs input`);
  return labels.join(' · ');
}

export function createBackgroundActivityReader(options: {
  sessionID: string;
  read: (signal: AbortSignal) => Promise<unknown>;
  publish: (state: BackgroundActivityState) => void;
}) {
  let active = false;
  let version = 0;
  let inFlight = false;
  let dirty = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingRead: AbortController | undefined;
  function schedule(delay = 100) {
    if (!active || inFlight || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  }
  async function refresh() {
    if (!active || inFlight) return;
    inFlight = true;
    dirty = false;
    const expected = version;
    const request = new AbortController();
    pendingRead = request;
    try {
      const inventory = backgroundActivityInventorySchema.parse(await options.read(request.signal));
      if (inventory.sessionID !== options.sessionID)
        throw new Error('Background inventory session mismatch');
      if (active && expected === version) {
        retries = 0;
        options.publish({ status: 'current', inventory });
      }
    } catch {
      if (active && expected === version) {
        options.publish({ status: 'unavailable' });
        if (retries < 2) {
          retries++;
          dirty = true;
        }
      }
    } finally {
      inFlight = false;
      if (pendingRead === request) pendingRead = undefined;
      if (active && (dirty || expected !== version))
        schedule(retries ? 500 * 2 ** (retries - 1) : 100);
    }
  }
  function invalidate() {
    if (!active) return;
    version++;
    retries = 0;
    dirty = true;
    options.publish({ status: 'loading' });
    schedule();
  }
  return {
    start() {
      active = true;
      invalidate();
    },
    invalidate,
    retry: invalidate,
    stop() {
      pendingRead?.abort();
      active = false;
      version++;
      dirty = false;
      clearTimeout(timer);
      timer = undefined;
      options.publish({ status: 'unavailable' });
    },
  };
}
