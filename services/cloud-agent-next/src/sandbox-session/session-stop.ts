import type { ControlStopReceipt, ControlStopRequest } from '../shared/control-plane-session.js';
import { controlStopRequestSchema } from '../shared/control-plane-session.js';
import { SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS } from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';
import { z } from 'zod';

export const persistedSessionStopSchema = z
  .object({
    version: z.literal(1),
    request: z.lazy(() => controlStopRequestSchema),
    state: z.enum(['accepted', 'confirmed', 'unconfirmed']),
    targets: z.array(
      z
        .object({
          messageId: z.string().min(1),
          state: z.enum(['pending', 'confirmed']),
        })
        .strict()
    ),
  })
  .strict();

export const persistedSessionStopsSchema = z.record(z.string(), persistedSessionStopSchema);

export type PersistedSessionStop = z.infer<typeof persistedSessionStopSchema>;

type StopAdmission = {
  messages: SessionMessageRecord[];
  stop?: PersistedSessionStop;
  receipt: ControlStopReceipt;
};

function receipt(stop: PersistedSessionStop): ControlStopReceipt {
  return {
    version: 1,
    operationId: stop.request.operationId,
    scope: structuredClone(stop.request.scope),
    targets: structuredClone(stop.request.targets),
    cleanupDeadlineAt: stop.request.cleanupDeadlineAt,
    state: stop.state,
  };
}

function rejected(request: ControlStopRequest, message: string): StopAdmission {
  return {
    messages: [],
    receipt: {
      version: 1,
      operationId: request.operationId,
      scope: structuredClone(request.scope),
      targets: structuredClone(request.targets),
      cleanupDeadlineAt: request.cleanupDeadlineAt,
      state: 'rejected',
      message,
    },
  };
}

function sameRequest(existing: ControlStopRequest, next: ControlStopRequest): boolean {
  return (
    existing.operationId === next.operationId &&
    existing.cleanupDeadlineAt === next.cleanupDeadlineAt &&
    existing.scope.sandboxId === next.scope.sandboxId &&
    existing.scope.wrapperInstanceId === next.scope.wrapperInstanceId &&
    existing.targets.length === next.targets.length &&
    existing.targets.every(
      (target, index) =>
        target.messageId === next.targets[index]?.messageId &&
        target.wrapperInstanceId === next.targets[index]?.wrapperInstanceId &&
        target.executionDeadlineAt === next.targets[index]?.executionDeadlineAt
    )
  );
}

export function admitSessionStop(input: {
  messages: readonly SessionMessageRecord[];
  existing?: PersistedSessionStop;
  request: ControlStopRequest;
  currentSandboxId?: string;
  currentWrapperInstanceId?: string;
  now: number;
}): StopAdmission {
  const { messages, existing, request, currentSandboxId, currentWrapperInstanceId, now } = input;
  if (existing) {
    if (!sameRequest(existing.request, request))
      return rejected(request, 'Stop operation conflicts');
    return { messages: [...messages], stop: existing, receipt: receipt(existing) };
  }
  if (
    request.cleanupDeadlineAt <= now ||
    request.cleanupDeadlineAt > now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
  ) {
    return rejected(request, 'Stop cleanup deadline is invalid');
  }
  if (request.scope.sandboxId !== currentSandboxId) {
    return rejected(request, 'Stop sandbox scope is stale');
  }
  if (
    request.scope.wrapperInstanceId !== undefined &&
    request.scope.wrapperInstanceId !== currentWrapperInstanceId
  ) {
    return rejected(request, 'Stop runtime scope is stale');
  }
  const requested = new Set<string>();
  for (const target of request.targets) {
    if (requested.has(target.messageId)) return rejected(request, 'Stop targets are duplicated');
    requested.add(target.messageId);
    const message = messages.find(item => item.messageId === target.messageId);
    if (
      !message ||
      (message.state !== 'queued' && message.state !== 'accepted') ||
      message.cancellation !== undefined ||
      message.wrapperInstanceId !== target.wrapperInstanceId ||
      message.executionDeadlineAt !== target.executionDeadlineAt
    ) {
      return rejected(
        request,
        message?.cancellation
          ? 'Stop target already has a cancellation intent'
          : 'Stop target is stale'
      );
    }
  }
  const targets: PersistedSessionStop['targets'] = request.targets.map(target => {
    const message = messages.find(item => item.messageId === target.messageId);
    return {
      messageId: target.messageId,
      state: message?.wrapperInstanceId ? 'pending' : 'confirmed',
    };
  });
  const state = targets.every(target => target.state === 'confirmed') ? 'confirmed' : 'accepted';
  const stop: PersistedSessionStop = {
    version: 1,
    request: structuredClone(request),
    state,
    targets,
  };
  return {
    messages: messages.map(message => {
      if (!requested.has(message.messageId)) return message;
      const cancellation = {
        operationId: request.operationId,
        deadlineAt: request.cleanupDeadlineAt,
      };
      return message.state === 'queued'
        ? { ...message, state: 'cancelled', cancellation }
        : { ...message, cancellation };
    }),
    stop,
    receipt: receipt(stop),
  };
}

export function settleSessionStop(
  stop: PersistedSessionStop,
  messageId: string
): PersistedSessionStop {
  if (stop.state !== 'accepted') return stop;
  const targets = stop.targets.map(target =>
    target.messageId === messageId ? { ...target, state: 'confirmed' as const } : target
  );
  return {
    ...stop,
    targets,
    state: targets.every(target => target.state === 'confirmed') ? 'confirmed' : 'accepted',
  };
}

export function expireSessionStop(stop: PersistedSessionStop, now: number): PersistedSessionStop {
  if (stop.state !== 'accepted' || now < stop.request.cleanupDeadlineAt) return stop;
  return { ...stop, state: 'unconfirmed' };
}

export function sessionStopReceipt(stop: PersistedSessionStop): ControlStopReceipt {
  return receipt(stop);
}
