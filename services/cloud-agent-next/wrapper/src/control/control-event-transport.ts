import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';
import {
  createControlEventOutbox,
  type ControlEventOutboxFailure,
  type ControlEventPublication,
} from './control-event-outbox.js';
import { ownerDirectoryForSession } from './session-directories.js';

type EventKind = 'session.event' | 'session.preparing';

export function createControlEventFailureHandler<Runtime extends { runtimeId: string }>(options: {
  getRuntime: (directory: string, nativeRuntimeId: string) => Runtime | undefined;
  onFailure: (failure: ControlEventOutboxFailure, runtime: Runtime) => unknown;
}) {
  const inFlight = new WeakMap<Runtime, Set<string>>();
  return (failure?: ControlEventOutboxFailure): void => {
    if (!failure) return;
    if (failure.publication.event === 'session.preparing') return;
    const { nativeRuntimeId } = failure.publication.session;
    const root =
      failure.publication.session.rootKiloSessionId ?? failure.publication.session.kiloSessionId;
    if (!nativeRuntimeId || !root) return;
    const ownerDirectory = ownerDirectoryForSession(failure.publication.session);
    if (!ownerDirectory) return;
    const runtime = options.getRuntime(ownerDirectory, nativeRuntimeId);
    if (runtime?.runtimeId !== nativeRuntimeId) return;
    const key = JSON.stringify([nativeRuntimeId, root]);
    const keys = inFlight.get(runtime) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    inFlight.set(runtime, keys);
    let result: unknown;
    try {
      result = options.onFailure(failure, runtime);
    } catch {
      keys.delete(key);
      if (keys.size === 0) inFlight.delete(runtime);
      return;
    }
    void Promise.resolve(result).then(
      () => {
        keys.delete(key);
        if (keys.size === 0) inFlight.delete(runtime);
      },
      () => {
        keys.delete(key);
        if (keys.size === 0) inFlight.delete(runtime);
      }
    );
  };
}

export function createControlEventTransport(options: {
  supportsReceipts: () => boolean;
  publish: (publication: ControlEventPublication, deadlineAt: number) => Promise<void>;
  prepare: (input: {
    event: EventKind;
    session: SessionEventIdentity;
    payload: unknown;
  }) => Omit<ControlEventPublication, 'receiptId' | 'sequence'>;
  sendLegacy: (payload: unknown, session: SessionEventIdentity) => boolean;
  onFailure: (failure: ControlEventOutboxFailure) => void;
}) {
  const outbox = createControlEventOutbox({
    publish: options.publish,
    onFailure: options.onFailure,
  });

  function enqueue(event: EventKind, payload: unknown, session: SessionEventIdentity): boolean {
    if (!options.supportsReceipts()) return options.sendLegacy(payload, session);
    try {
      return outbox.enqueue(outbox.prepare(options.prepare({ event, session, payload })));
    } catch {
      return false;
    }
  }

  return {
    async publishSessionEvent(payload: unknown, session: SessionEventIdentity): Promise<boolean> {
      if (!options.supportsReceipts()) return options.sendLegacy(payload, session);
      try {
        const publication = outbox.prepare(
          options.prepare({ event: 'session.event', session, payload })
        );
        while (!outbox.enqueue(publication)) {
          if (!(await outbox.waitForSpace(publication))) return false;
        }
        void outbox.resume();
        return true;
      } catch {
        return false;
      }
    },
    enqueue,
    pause: () => outbox.pause(),
    resume: () => outbox.resume(),
    close: () => outbox.close(),
  };
}
