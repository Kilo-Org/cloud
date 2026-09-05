import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';
import {
  createControlEventOutbox,
  type ControlEventOutboxFailure,
  type ControlEventPublication,
} from './control-event-outbox.js';

type EventKind = 'session.event' | 'session.preparing';

export function createControlEventFailureHandler<Runtime extends { runtimeId: string }>(options: {
  getRuntime: (directory: string) => Runtime | undefined;
  onFailure: (failure: ControlEventOutboxFailure, runtime: Runtime) => void;
}) {
  const failedRuntimes = new WeakSet<Runtime>();
  return (failure?: ControlEventOutboxFailure): void => {
    if (!failure) return;
    const { directory, nativeRuntimeId } = failure.publication.session;
    if (!nativeRuntimeId) return;
    const runtime = options.getRuntime(directory);
    if (runtime?.runtimeId !== nativeRuntimeId || failedRuntimes.has(runtime)) return;
    failedRuntimes.add(runtime);
    options.onFailure(failure, runtime);
  };
}

export function createControlEventTransport(options: {
  supportsReceipts: () => boolean;
  publish: (publication: ControlEventPublication, deadlineAt: number) => Promise<void>;
  prepare: (input: {
    event: EventKind;
    session: SessionEventIdentity;
    payload: unknown;
  }) => Omit<ControlEventPublication, 'receiptId' | 'receiptHash' | 'sequence'>;
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
