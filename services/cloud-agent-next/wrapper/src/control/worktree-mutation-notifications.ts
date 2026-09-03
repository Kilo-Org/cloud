import type { BackgroundProcessInfo, Event } from '@kilocode/sdk/v2';
import { WORKTREE_CHANGED_EVENT } from '../../../src/shared/worktree-changes-wire';
import type { HandlerSessionSnapshot } from './sandbox-control-handlers';
import { sessionEventIdentity } from './feed';
import { rootAttachmentId, rootForSession } from './session-directories';
import { assertDirectoryActive } from './worktree-operations';
import type { WorktreeKiloRuntime, WorktreeKiloRuntimes } from './worktree-runtime';

type KiloEvent = {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
};

type NotificationIdentity = {
  directory: string;
  kiloSessionId: string;
  rootKiloSessionId: string;
};

type Target = {
  snapshot: HandlerSessionSnapshot;
  kiloSessionId: string;
  attachmentId: symbol;
};

type Pending = {
  runtime: WorktreeKiloRuntime;
  kiloClient: WorktreeKiloRuntime['kiloClient'];
  targets: Map<HandlerSessionSnapshot, Target>;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

const executionEvents = new Set<string>([
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.shell.started',
  'session.next.shell.ended',
] satisfies Event['type'][]);

const resourceInfoEvents = new Set<string>([
  'background_process.updated',
  'interactive_terminal.updated',
  'pty.created',
  'pty.updated',
] satisfies Event['type'][]);

const backgroundStatuses = new Set<string>([
  'starting',
  'running',
  'ready',
  'exited',
  'failed',
  'stopping',
  'stopped',
] satisfies BackgroundProcessInfo['status'][]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMutation({ type, properties }: KiloEvent): boolean {
  if (type === 'file.edited') return typeof properties.file === 'string';
  if (type === 'file.watcher.updated') {
    return (
      typeof properties.file === 'string' &&
      (properties.event === 'add' || properties.event === 'change' || properties.event === 'unlink')
    );
  }
  if (type === 'vcs.branch.updated') {
    return properties.branch === undefined || typeof properties.branch === 'string';
  }
  if (resourceInfoEvents.has(type)) {
    const info = properties.info;
    if (!isRecord(info) || !isNonemptyString(info.id)) return false;
    if (type === 'pty.created' || type === 'pty.updated') {
      return info.status === 'running' || info.status === 'exited';
    }
    if (!isNonemptyString(info.sessionID)) return false;
    if (type === 'background_process.updated') {
      return (
        typeof info.status === 'string' &&
        backgroundStatuses.has(info.status) &&
        typeof properties.scope === 'string'
      );
    }
    return info.status === 'running' || info.status === 'closed';
  }
  if (type === 'pty.exited' || type === 'pty.deleted') {
    return (
      isNonemptyString(properties.id) &&
      (type === 'pty.deleted' || typeof properties.exitCode === 'number')
    );
  }
  if (typeof properties.sessionID !== 'string' || !properties.sessionID) return false;
  if (type === 'background_process.deleted') {
    return isNonemptyString(properties.processID) && typeof properties.scope === 'string';
  }
  if (type === 'interactive_terminal.data' || type === 'interactive_terminal.deleted') {
    return (
      isNonemptyString(properties.terminalID) &&
      (type === 'interactive_terminal.deleted' ||
        (typeof properties.data === 'string' && typeof properties.cursor === 'number'))
    );
  }
  if (executionEvents.has(type)) return typeof properties.callID === 'string';
  if (type === 'session.diff') return Array.isArray(properties.diff);
  if (type !== 'message.part.updated') return false;
  const part = properties.part;
  if (!isRecord(part) || part.sessionID !== properties.sessionID) return false;
  if (part.type === 'patch') {
    return (
      typeof part.hash === 'string' &&
      Array.isArray(part.files) &&
      part.files.every(file => typeof file === 'string')
    );
  }
  return (
    part.type === 'tool' &&
    typeof part.tool === 'string' &&
    isRecord(part.state) &&
    (part.state.status === 'running' ||
      part.state.status === 'completed' ||
      part.state.status === 'error')
  );
}

function mutationSessionId({ type, properties }: KiloEvent): string | undefined | null {
  const ids: unknown[] = [];
  for (const key of ['sessionID', 'sessionId']) {
    if (key in properties) ids.push(properties[key]);
  }
  for (const key of ['info', 'part']) {
    if (!(key in properties)) continue;
    const nested = properties[key];
    if (!isRecord(nested)) return null;
    const sessionlessPty =
      key === 'info' &&
      (type === 'pty.created' || type === 'pty.updated') &&
      (nested.sessionID === null || nested.sessionID === undefined);
    if ('sessionID' in nested && !sessionlessPty) ids.push(nested.sessionID);
    if (key === 'info' && 'id' in nested && !resourceInfoEvents.has(type)) ids.push(nested.id);
  }
  const sessionId = ids[0];
  if (ids.some(id => typeof id !== 'string' || !id || id !== sessionId)) return null;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

export function createWorktreeMutationNotifications(options: {
  sessions: readonly HandlerSessionSnapshot[];
  kiloRuntimes: Pick<WorktreeKiloRuntimes, 'get'>;
  signal: AbortSignal;
  sendEvent: (
    event: 'session.event',
    payload: { type: typeof WORKTREE_CHANGED_EVENT; properties: Record<string, never> },
    identity: NotificationIdentity
  ) => unknown;
}) {
  const pending = new Map<WorktreeKiloRuntime, Pending>();
  let disposed = false;

  function isCurrent(runtime: WorktreeKiloRuntime): boolean {
    assertDirectoryActive(runtime.directory);
    return (
      !disposed &&
      !options.signal.aborted &&
      !runtime.signal.aborted &&
      options.kiloRuntimes.get(runtime.directory) === runtime
    );
  }

  function validTarget(target: Target, directory: string): boolean {
    return (
      options.sessions.includes(target.snapshot) &&
      target.snapshot.kiloSessionId === target.kiloSessionId &&
      rootAttachmentId(target.kiloSessionId) === target.attachmentId &&
      rootForSession(target.kiloSessionId, directory) === target.kiloSessionId
    );
  }

  function remove(entry: Pending): void {
    clearTimeout(entry.quietTimer);
    clearTimeout(entry.maxTimer);
    entry.runtime.signal.removeEventListener('abort', entry.onAbort);
    if (pending.get(entry.runtime) === entry) pending.delete(entry.runtime);
  }

  function flush(entry: Pending): void {
    remove(entry);
    for (const target of entry.targets.values()) {
      try {
        if (!isCurrent(entry.runtime) || entry.runtime.kiloClient !== entry.kiloClient) return;
        if (!validTarget(target, entry.runtime.directory)) continue;
        void Promise.resolve(
          options.sendEvent(
            'session.event',
            { type: WORKTREE_CHANGED_EVENT, properties: {} },
            {
              directory: entry.runtime.directory,
              kiloSessionId: target.kiloSessionId,
              rootKiloSessionId: target.kiloSessionId,
            }
          )
        ).catch(() => {});
      } catch {
        continue;
      }
    }
  }

  function dispose(): void {
    disposed = true;
    options.signal.removeEventListener('abort', dispose);
    for (const entry of pending.values()) remove(entry);
  }

  options.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal.aborted) dispose();

  return {
    dispose,
    observe(runtime: WorktreeKiloRuntime, event: KiloEvent): void {
      try {
        if (!isRecord(event.properties) || !isMutation(event) || !isCurrent(runtime)) return;
        const sessionId = mutationSessionId(event);
        if (sessionId === null) return;
        if (sessionId !== undefined) {
          const identity = sessionEventIdentity({
            ...event,
            sessionId,
            runtimeDirectory: runtime.directory,
          });
          if (
            identity?.directory !== runtime.directory ||
            !options.sessions.some(
              snapshot => snapshot.kiloSessionId === identity.rootKiloSessionId
            )
          )
            return;
        } else if (event.directory !== runtime.directory) {
          return;
        }
        let entry = pending.get(runtime);
        if (entry && entry.kiloClient !== runtime.kiloClient) {
          remove(entry);
          entry = undefined;
        }
        const targets = entry?.targets ?? new Map<HandlerSessionSnapshot, Target>();
        for (const [snapshot, target] of targets) {
          if (!validTarget(target, runtime.directory)) targets.delete(snapshot);
        }
        for (const snapshot of options.sessions) {
          const kiloSessionId = snapshot.kiloSessionId;
          const attachmentId = rootAttachmentId(kiloSessionId);
          if (!attachmentId || rootForSession(kiloSessionId, runtime.directory) !== kiloSessionId)
            continue;
          targets.set(snapshot, { snapshot, kiloSessionId, attachmentId });
        }
        if (!targets.size) {
          if (entry) remove(entry);
          return;
        }
        if (!entry) {
          const created: Pending = {
            runtime,
            kiloClient: runtime.kiloClient,
            targets,
            onAbort: () => remove(created),
          };
          entry = created;
          pending.set(runtime, entry);
          runtime.signal.addEventListener('abort', entry.onAbort, { once: true });
          entry.maxTimer = setTimeout(() => flush(created), 10_000);
          entry.maxTimer.unref();
        }
        const queued = entry;
        clearTimeout(queued.quietTimer);
        queued.quietTimer = setTimeout(() => flush(queued), 5_000);
        queued.quietTimer.unref();
      } catch {
        return;
      }
    },
  };
}
