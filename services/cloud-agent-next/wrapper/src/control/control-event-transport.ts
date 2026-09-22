import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';
import {
  createControlEventOutbox,
  type BatchControlEventPublication,
  type ControlEventOutboxFailure,
  type ControlEventPublication,
} from './control-event-outbox.js';
import { ownerDirectoryForSession } from './session-directories.js';

type EventKind = 'session.event' | 'session.preparing';

export type LegacySendFailureReason = Extract<
  ControlEventOutboxFailure['reason'],
  'socket_overflow' | 'disconnected' | 'send_failed'
>;

export type LegacySendResult = { sent: true } | { sent: false; reason: LegacySendFailureReason };

export function createControlEventFailureHandler<Runtime extends { runtimeId: string }>(options: {
  getRuntime: (directory: string, nativeRuntimeId: string) => Runtime | undefined;
  onFailure: (failure: ControlEventOutboxFailure, runtime: Runtime) => unknown;
}) {
  return (failure?: ControlEventOutboxFailure): void => {
    if (!failure) return;
    const { nativeRuntimeId } = failure.publication.session;
    const root =
      failure.publication.session.rootKiloSessionId ?? failure.publication.session.kiloSessionId;
    if (!nativeRuntimeId || !root) return;
    const ownerDirectory = ownerDirectoryForSession(failure.publication.session);
    if (!ownerDirectory) return;
    const runtime = options.getRuntime(ownerDirectory, nativeRuntimeId);
    if (runtime?.runtimeId !== nativeRuntimeId) return;
    try {
      void Promise.resolve(options.onFailure(failure, runtime)).catch(() => undefined);
    } catch {
      return;
    }
  };
}

export function createControlEventTransport(options: {
  supportsReceipts: () => boolean;
  supportsBatches?: () => boolean;
  publish: (
    publication: ControlEventPublication,
    deadlineAt: number,
    preparedAt?: number
  ) => Promise<void>;
  publishBatch?: (
    publications: BatchControlEventPublication[],
    deadlineAt: number
  ) => Promise<void>;
  prepare: (input: {
    event: EventKind;
    session: SessionEventIdentity;
    payload: unknown;
  }) => Omit<ControlEventPublication, 'receiptId' | 'sequence'>;
  sendLegacy: (
    event: EventKind,
    payload: unknown,
    session: SessionEventIdentity
  ) => LegacySendResult;
  onFailure: (failure: ControlEventOutboxFailure) => void;
  onAdmissionFailure?: (input: {
    event: EventKind;
    session: SessionEventIdentity;
    reason: string;
  }) => void;
}) {
  const outbox = createControlEventOutbox({
    publish: options.publish,
    publishBatch: options.publishBatch,
    supportsBatches: () => options.supportsReceipts() && (options.supportsBatches?.() ?? false),
    onFailure: options.onFailure,
  });

  function reportAdmissionFailure(
    event: EventKind,
    session: SessionEventIdentity,
    reason: string
  ): void {
    try {
      options.onAdmissionFailure?.({ event, session, reason });
    } catch {
      // Admission reporting must never break the publication path.
    }
  }

  function sendLegacyPublication(
    event: EventKind,
    payload: unknown,
    session: SessionEventIdentity
  ): boolean {
    let result: LegacySendResult;
    try {
      result = options.sendLegacy(event, payload, session);
    } catch {
      result = { sent: false, reason: 'send_failed' };
    }
    if (!result.sent) reportAdmissionFailure(event, session, result.reason);
    return result.sent;
  }

  function enqueue(event: EventKind, payload: unknown, session: SessionEventIdentity): boolean {
    if (!options.supportsReceipts()) return sendLegacyPublication(event, payload, session);
    try {
      return outbox.enqueue(outbox.prepare(options.prepare({ event, session, payload })));
    } catch {
      reportAdmissionFailure(event, session, 'prepare_failed');
      return false;
    }
  }

  return {
    async publishSessionEvent(payload: unknown, session: SessionEventIdentity): Promise<boolean> {
      return enqueue('session.event', payload, session);
    },
    enqueue,
    pause: () => outbox.pause(),
    resume: () => outbox.resume(),
    close: () => outbox.close(),
  };
}
