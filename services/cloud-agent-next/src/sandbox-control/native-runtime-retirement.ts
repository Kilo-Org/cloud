import type { NativeRuntimeRetirementReceipt } from './durable-state.js';
import {
  loadDeadlines,
  loadNativeRuntimeRetirements,
  loadPhysicalRecord,
  loadRouteTable,
  saveDeadlines,
  saveNativeRuntimeRetirements,
  saveRouteTable,
} from './durable-state.js';
import { armDeadline, cancelDeadline, DEADLINE_MS, type DeadlineTable } from './deadlines.js';
import type { PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';

export type NativeRuntimeRetirementConnection = {
  connectionId: string;
  providerInstanceId: string;
  wrapperInstanceId: string;
};

export type NativeRuntimeRetirementStorage = Pick<
  DurableObjectStorage,
  'get' | 'put' | 'delete' | 'transaction'
>;

export type NativeRuntimeRetirementWorkflow = {
  begin(input: {
    connection: NativeRuntimeRetirementConnection;
    physical: PhysicalRecord;
    route: SessionRoute;
    nativeRuntimeId: string;
    reason: string;
    operationId?: string;
    cleanupDeadlineAt: number;
  }): Promise<NativeRuntimeRetirementReceipt | undefined>;
  complete(receipt: NativeRuntimeRetirementReceipt): Promise<boolean>;
  release(receipt: NativeRuntimeRetirementReceipt): Promise<void>;
  defer(receipt: NativeRuntimeRetirementReceipt): Promise<void>;
  claimTargetedAttempt(
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<NativeRuntimeRetirementReceipt | undefined>;
  retire(input: {
    connection: NativeRuntimeRetirementConnection;
    physical: PhysicalRecord;
    route: SessionRoute;
    reason: string;
    operationId?: string;
    cleanupDeadlineAt: number;
  }): Promise<'retired' | 'pending' | 'unavailable'>;
  receiveRetired(input: {
    connection: NativeRuntimeRetirementConnection;
    retirementId: string;
    directory: string;
    nativeRuntimeId: string;
    reason: string;
    cleanupDeadlineAt: number;
  }): Promise<{ retired: true } | undefined>;
  resume(): Promise<void>;
};

export type NativeRuntimeRetirementWorkflowPorts = {
  storage: NativeRuntimeRetirementStorage;
  currentIncarnation: {
    isCurrent(connection: NativeRuntimeRetirementConnection): boolean;
    getConnection(): NativeRuntimeRetirementConnection | null;
    sameLifetime(
      left: NativeRuntimeRetirementConnection,
      right: NativeRuntimeRetirementConnection
    ): boolean;
  };
  transport: {
    supportsTargetedRetirement(): boolean;
    abortNativeRuntime(input: {
      receipt: NativeRuntimeRetirementReceipt;
      route: SessionRoute;
    }): Promise<boolean>;
    invalidateRecipients(receipt: NativeRuntimeRetirementReceipt): Promise<boolean>;
    notifyRecipients(receipt: NativeRuntimeRetirementReceipt): Promise<boolean>;
  };
  physicalEscalation: {
    beginIfCurrent(receipt: NativeRuntimeRetirementReceipt): Promise<boolean>;
  };
  scheduleAlarm(deadlines: DeadlineTable): Promise<void>;
  now?: () => number;
};

export function sameNativeRuntimeRetirement(
  receipt: NativeRuntimeRetirementReceipt,
  input: {
    directory: string;
    nativeRuntimeId: string;
    connection: NativeRuntimeRetirementConnection;
  }
): boolean {
  return (
    receipt.directory === input.directory &&
    receipt.nativeRuntimeId === input.nativeRuntimeId &&
    receipt.connection.connectionId === input.connection.connectionId &&
    receipt.connection.providerInstanceId === input.connection.providerInstanceId &&
    receipt.connection.wrapperInstanceId === input.connection.wrapperInstanceId
  );
}

export function sameNativeRuntimeRetirementLifetime(
  receipt: NativeRuntimeRetirementReceipt,
  input: {
    directory: string;
    nativeRuntimeId: string;
    connection: NativeRuntimeRetirementConnection;
  }
): boolean {
  return (
    receipt.directory === input.directory &&
    receipt.nativeRuntimeId === input.nativeRuntimeId &&
    receipt.connection.providerInstanceId === input.connection.providerInstanceId &&
    receipt.connection.wrapperInstanceId === input.connection.wrapperInstanceId
  );
}

export function createNativeRuntimeRetirement(
  physical: PhysicalRecord,
  connection: NativeRuntimeRetirementConnection,
  routes: readonly SessionRoute[],
  reason: string,
  cleanupDeadlineAt: number,
  replayUntil: number,
  operationId?: string
): NativeRuntimeRetirementReceipt | undefined {
  if (!physical.providerRef || routes.length === 0) return undefined;
  const [route] = routes;
  if (!route?.nativeRuntimeId) return undefined;
  if (
    routes.some(
      current =>
        current.directory !== route.directory || current.nativeRuntimeId !== route.nativeRuntimeId
    )
  )
    return undefined;
  return {
    directory: route.directory,
    nativeRuntimeId: route.nativeRuntimeId,
    allocation: {
      providerRef: physical.providerRef,
      ...(physical.createIntent ? { createIntentId: physical.createIntent.intentId } : {}),
    },
    connection,
    recipients: routes.map(current => ({
      sessionId: current.sessionId,
      kiloSessionId: current.kiloSessionId,
      directory: current.directory,
      ...(current.worktreeId ? { worktreeId: current.worktreeId } : {}),
      ownerId: current.ownerId,
      nativeRuntimeId: current.nativeRuntimeId,
    })),
    reason,
    ...(operationId ? { operationId } : {}),
    cleanupDeadlineAt,
    replayUntil,
    attempts: 0,
    notificationAttempts: 0,
    notificationState: 'pending',
    state: 'pending',
    disposition: 'pending',
  };
}

export function matchesNativeRuntimeRetirementAllocation(
  receipt: NativeRuntimeRetirementReceipt,
  physical: PhysicalRecord
): boolean {
  return (
    physical.providerRef === receipt.allocation.providerRef &&
    (receipt.allocation.createIntentId === undefined ||
      physical.createIntent?.intentId === receipt.allocation.createIntentId)
  );
}

export function routesMatchNativeRuntimeRetirement(
  routes: Map<string, SessionRoute>,
  receipt: NativeRuntimeRetirementReceipt
): boolean {
  return receipt.recipients.every(recipient => {
    const route = routes.get(recipient.sessionId);
    return (
      route?.ownerId === recipient.ownerId &&
      route.kiloSessionId === recipient.kiloSessionId &&
      route.directory === recipient.directory &&
      route.worktreeId === recipient.worktreeId &&
      route.nativeRuntimeId === receipt.nativeRuntimeId &&
      route.retiringNativeRuntimeId === receipt.nativeRuntimeId
    );
  });
}

export function fenceNativeRuntimeRetirement(
  routes: Map<string, SessionRoute>,
  receipt: NativeRuntimeRetirementReceipt
): void {
  for (const recipient of receipt.recipients) {
    const route = routes.get(recipient.sessionId);
    if (!route || route.nativeRuntimeId !== receipt.nativeRuntimeId) continue;
    routes.set(route.sessionId, { ...route, retiringNativeRuntimeId: receipt.nativeRuntimeId });
  }
}

export function releaseNativeRuntimeRetirement(
  routes: Map<string, SessionRoute>,
  receipt: NativeRuntimeRetirementReceipt,
  clearNativeRuntime: boolean
): void {
  for (const recipient of receipt.recipients) {
    const route = routes.get(recipient.sessionId);
    if (
      !route ||
      route.nativeRuntimeId !== receipt.nativeRuntimeId ||
      route.retiringNativeRuntimeId !== receipt.nativeRuntimeId
    )
      continue;
    const next = { ...route };
    delete next.retiringNativeRuntimeId;
    if (clearNativeRuntime) delete next.nativeRuntimeId;
    routes.set(route.sessionId, next);
  }
}

function samePhysicalAllocation(left: PhysicalRecord, right: PhysicalRecord): boolean {
  return (
    left.providerRef === right.providerRef &&
    left.createIntent?.intentId === right.createIntent?.intentId
  );
}

function matchesReceipt(
  current: NativeRuntimeRetirementReceipt,
  receipt: NativeRuntimeRetirementReceipt
): boolean {
  return (
    sameNativeRuntimeRetirement(current, receipt) && current.operationId === receipt.operationId
  );
}

function matchesRetirementLifetime(
  current: NativeRuntimeRetirementReceipt,
  input: {
    directory: string;
    nativeRuntimeId: string;
    connection: NativeRuntimeRetirementConnection;
    operationId?: string;
  }
): boolean {
  return (
    sameNativeRuntimeRetirementLifetime(current, input) && current.operationId === input.operationId
  );
}

function holdsNativeRuntimeRetirementFence(receipt: NativeRuntimeRetirementReceipt): boolean {
  return (
    receipt.state === 'pending' ||
    receipt.state === 'unconfirmed' ||
    (receipt.state === 'completed' && receipt.notificationState !== 'delivered')
  );
}

function hasOtherNativeRuntimeRetirementFence(
  receipts: readonly NativeRuntimeRetirementReceipt[],
  receipt: NativeRuntimeRetirementReceipt
): boolean {
  return receipts.some(
    current =>
      !matchesReceipt(current, receipt) &&
      sameNativeRuntimeRetirement(current, receipt) &&
      holdsNativeRuntimeRetirementFence(current)
  );
}

function retainReceipt(receipt: NativeRuntimeRetirementReceipt, now: number): boolean {
  if (receipt.state === 'pending' || receipt.state === 'unconfirmed') return true;
  if (receipt.state === 'completed' && receipt.notificationState !== 'delivered') return true;
  return receipt.replayUntil >= now;
}

export function createNativeRuntimeRetirementWorkflow(
  ports: NativeRuntimeRetirementWorkflowPorts
): NativeRuntimeRetirementWorkflow {
  const now = ports.now ?? Date.now;

  const reconcileSchedule = async (): Promise<void> => {
    await ports.storage.transaction(async () => {
      const currentTime = now();
      const [routes, stored, deadlines] = await Promise.all([
        loadRouteTable(ports.storage),
        loadNativeRuntimeRetirements(ports.storage),
        loadDeadlines(ports.storage),
      ]);
      const normalized = stored.map(receipt =>
        receipt.state === 'completed' &&
        receipt.notificationState === 'pending' &&
        (currentTime >= receipt.replayUntil ||
          receipt.notificationAttempts >= DEADLINE_MS.nativeRetirementMaxAttempts)
          ? { ...receipt, notificationState: 'exhausted' as const }
          : receipt
      );
      const expired = normalized.filter(receipt =>
        (receipt.state === 'completed' && receipt.notificationState === 'delivered') ||
        receipt.state === 'released'
          ? receipt.replayUntil < currentTime
          : false
      );
      for (const receipt of expired) {
        if (!hasOtherNativeRuntimeRetirementFence(normalized, receipt))
          releaseNativeRuntimeRetirement(routes, receipt, true);
      }
      const retained = normalized.filter(receipt => retainReceipt(receipt, currentTime));
      if (expired.length > 0) await saveRouteTable(ports.storage, routes);
      if (
        retained.length !== stored.length ||
        normalized.some((receipt, index) => receipt !== stored[index])
      ) {
        await saveNativeRuntimeRetirements(ports.storage, retained);
      }

      let nextAt: number | undefined;
      const scheduleAt = (at: number) => {
        nextAt = nextAt === undefined ? at : Math.min(nextAt, at);
      };
      for (const receipt of retained) {
        if (receipt.state === 'pending') {
          scheduleAt(Math.max(currentTime, receipt.nextAttemptAt ?? currentTime));
          continue;
        }
        if (receipt.state === 'completed' && receipt.notificationState === 'pending') {
          scheduleAt(Math.max(currentTime, receipt.nextNotificationAttemptAt ?? currentTime));
          continue;
        }
        if (
          (receipt.state === 'completed' && receipt.notificationState === 'delivered') ||
          receipt.state === 'released'
        ) {
          scheduleAt(receipt.replayUntil);
        }
      }
      const next =
        nextAt === undefined
          ? cancelDeadline(deadlines, 'nativeRetirement')
          : armDeadline(deadlines, 'nativeRetirement', nextAt);
      await saveDeadlines(ports.storage, next);
      await ports.scheduleAlarm(next);
    });
  };

  const begin = async (
    input: Parameters<NativeRuntimeRetirementWorkflow['begin']>[0]
  ): Promise<NativeRuntimeRetirementReceipt | undefined> => {
    const receipt = await ports.storage.transaction(async () => {
      const [currentPhysical, routes, stored] = await Promise.all([
        loadPhysicalRecord(ports.storage),
        loadRouteTable(ports.storage),
        loadNativeRuntimeRetirements(ports.storage),
      ]);
      const route = routes.get(input.route.sessionId);
      if (
        !route ||
        !ports.currentIncarnation.isCurrent(input.connection) ||
        currentPhysical.state !== 'running' ||
        currentPhysical.stopTombstone ||
        currentPhysical.providerRef !== input.connection.providerInstanceId ||
        !samePhysicalAllocation(input.physical, currentPhysical) ||
        route.ownerId !== input.route.ownerId ||
        route.kiloSessionId !== input.route.kiloSessionId ||
        route.directory !== input.route.directory ||
        route.worktreeId !== input.route.worktreeId ||
        route.nativeRuntimeId !== input.nativeRuntimeId ||
        (route.retiringNativeRuntimeId !== undefined &&
          route.retiringNativeRuntimeId !== input.nativeRuntimeId)
      )
        return undefined;
      const related = [...routes.values()].filter(current => current.directory === route.directory);
      if (
        related.length === 0 ||
        related.some(
          current =>
            current.nativeRuntimeId !== input.nativeRuntimeId ||
            (current.retiringNativeRuntimeId !== undefined &&
              current.retiringNativeRuntimeId !== input.nativeRuntimeId)
        )
      )
        return undefined;
      const existing = stored.find(
        current =>
          matchesRetirementLifetime(current, {
            directory: route.directory,
            nativeRuntimeId: input.nativeRuntimeId,
            connection: input.connection,
            operationId: input.operationId,
          }) && matchesNativeRuntimeRetirementAllocation(current, currentPhysical)
      );
      if (existing) return existing;
      const active = stored.find(
        current =>
          sameNativeRuntimeRetirementLifetime(current, {
            directory: route.directory,
            nativeRuntimeId: input.nativeRuntimeId,
            connection: input.connection,
          }) &&
          matchesNativeRuntimeRetirementAllocation(current, currentPhysical) &&
          holdsNativeRuntimeRetirementFence(current)
      );
      if (active) return active;
      const created = createNativeRuntimeRetirement(
        currentPhysical,
        input.connection,
        related,
        input.reason,
        input.cleanupDeadlineAt,
        input.cleanupDeadlineAt + DEADLINE_MS.stopAttempt,
        input.operationId
      );
      if (!created) return undefined;
      fenceNativeRuntimeRetirement(routes, created);
      await saveRouteTable(ports.storage, routes);
      await saveNativeRuntimeRetirements(ports.storage, [
        ...stored.filter(current => retainReceipt(current, now())),
        created,
      ]);
      return created;
    });
    if (receipt) await reconcileSchedule();
    return receipt;
  };

  const release = async (receipt: NativeRuntimeRetirementReceipt): Promise<void> => {
    await ports.storage.transaction(async () => {
      const [routes, stored] = await Promise.all([
        loadRouteTable(ports.storage),
        loadNativeRuntimeRetirements(ports.storage),
      ]);
      const current = stored.find(current => matchesReceipt(current, receipt));
      if (!current || current.state !== 'pending') return;
      if (!hasOtherNativeRuntimeRetirementFence(stored, current))
        releaseNativeRuntimeRetirement(routes, current, false);
      await saveRouteTable(ports.storage, routes);
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(current =>
          matchesReceipt(current, receipt)
            ? { ...current, state: 'released' as const, disposition: 'operation_only' as const }
            : current
        )
      );
    });
    await reconcileSchedule();
  };

  const deliverNotifications = async (
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<boolean> => {
    const claimed = await ports.storage.transaction(async () => {
      const stored = await loadNativeRuntimeRetirements(ports.storage);
      const current = stored.find(current => matchesReceipt(current, receipt));
      if (!current || current.state !== 'completed') return { state: 'unavailable' as const };
      if (current.notificationState === 'delivered') return { state: 'delivered' as const };
      if (
        current.notificationState === 'exhausted' ||
        now() >= current.replayUntil ||
        current.notificationAttempts >= DEADLINE_MS.nativeRetirementMaxAttempts
      ) {
        if (current.notificationState === 'pending') {
          await saveNativeRuntimeRetirements(
            ports.storage,
            stored.map(item =>
              matchesReceipt(item, receipt)
                ? { ...item, notificationState: 'exhausted' as const }
                : item
            )
          );
        }
        return { state: 'exhausted' as const };
      }
      if (
        current.nextNotificationAttemptAt !== undefined &&
        now() < current.nextNotificationAttemptAt
      )
        return { state: 'pending' as const };
      const attempt = {
        ...current,
        notificationAttempts: current.notificationAttempts + 1,
        nextNotificationAttemptAt: now() + DEADLINE_MS.stopAttempt,
      };
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(item => (matchesReceipt(item, receipt) ? attempt : item))
      );
      return { state: 'send' as const, receipt: attempt };
    });
    if (claimed.state !== 'send') {
      await reconcileSchedule();
      return claimed.state === 'delivered';
    }
    const [invalidated, notified] = await Promise.all([
      ports.transport.invalidateRecipients(claimed.receipt),
      ports.transport.notifyRecipients(claimed.receipt),
    ]);
    const delivered = invalidated && notified;
    await ports.storage.transaction(async () => {
      const [routes, stored] = await Promise.all([
        loadRouteTable(ports.storage),
        loadNativeRuntimeRetirements(ports.storage),
      ]);
      const current = stored.find(current => matchesReceipt(current, claimed.receipt));
      if (!current || current.state !== 'completed' || current.notificationState !== 'pending')
        return;
      if (delivered) {
        releaseNativeRuntimeRetirement(routes, current, true);
        await saveRouteTable(ports.storage, routes);
      }
      const exhausted =
        !delivered && current.notificationAttempts >= DEADLINE_MS.nativeRetirementMaxAttempts;
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(item =>
          matchesReceipt(item, claimed.receipt)
            ? {
                ...item,
                ...(delivered
                  ? {
                      notificationState: 'delivered' as const,
                      nextNotificationAttemptAt: undefined,
                    }
                  : exhausted
                    ? {
                        notificationState: 'exhausted' as const,
                        nextNotificationAttemptAt: undefined,
                      }
                    : { nextNotificationAttemptAt: now() + DEADLINE_MS.nativeRetirementRetry }),
              }
            : item
        )
      );
    });
    await reconcileSchedule();
    return delivered;
  };

  const complete = async (receipt: NativeRuntimeRetirementReceipt): Promise<boolean> => {
    const committed = await ports.storage.transaction(async () => {
      const [physical, routes, stored] = await Promise.all([
        loadPhysicalRecord(ports.storage),
        loadRouteTable(ports.storage),
        loadNativeRuntimeRetirements(ports.storage),
      ]);
      const current = stored.find(current => matchesReceipt(current, receipt));
      if (!current) return undefined;
      if (current.state === 'completed') return current;
      const connection = ports.currentIncarnation.getConnection();
      if (
        current.state !== 'pending' ||
        !connection ||
        !ports.currentIncarnation.isCurrent(connection) ||
        !ports.currentIncarnation.sameLifetime(connection, receipt.connection) ||
        physical.state !== 'running' ||
        physical.stopTombstone ||
        !matchesNativeRuntimeRetirementAllocation(current, physical) ||
        !routesMatchNativeRuntimeRetirement(routes, current)
      )
        return undefined;
      const completed = {
        ...current,
        state: 'completed' as const,
        disposition: 'retired' as const,
      };
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(item => (matchesReceipt(item, receipt) ? completed : item))
      );
      return completed;
    });
    if (!committed) return false;
    return deliverNotifications(committed);
  };

  const escalate = async (receipt: NativeRuntimeRetirementReceipt): Promise<boolean> => {
    const token = await ports.storage.transaction(async () => {
      const stored = await loadNativeRuntimeRetirements(ports.storage);
      const current = stored.find(current => matchesReceipt(current, receipt));
      if (!current || current.state !== 'pending') return undefined;
      const fallback = {
        ...current,
        state: 'unconfirmed' as const,
        disposition: 'pending' as const,
      };
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(item => (matchesReceipt(item, receipt) ? fallback : item))
      );
      return fallback;
    });
    const started = token && (await ports.physicalEscalation.beginIfCurrent(token));
    if (token) {
      await ports.storage.transaction(async () => {
        const stored = await loadNativeRuntimeRetirements(ports.storage);
        await saveNativeRuntimeRetirements(
          ports.storage,
          stored.map(current =>
            matchesReceipt(current, token) && current.state === 'unconfirmed'
              ? started
                ? { ...current, disposition: 'physical_fallback' as const }
                : {
                    ...current,
                    state: 'pending' as const,
                    nextAttemptAt: now() + DEADLINE_MS.reconciliation,
                  }
              : current
          )
        );
      });
    }
    await reconcileSchedule();
    return started === true;
  };

  const claimRetirementAttempt = async (receipt: NativeRuntimeRetirementReceipt) => {
    return ports.storage.transaction(async () => {
      const stored = await loadNativeRuntimeRetirements(ports.storage);
      const current = stored.find(current => matchesReceipt(current, receipt));
      if (!current || current.state !== 'pending') return { state: 'unavailable' as const };
      if (current.nextAttemptAt !== undefined && now() < current.nextAttemptAt)
        return { state: 'pending' as const };
      if (
        now() >= current.cleanupDeadlineAt ||
        current.attempts >= DEADLINE_MS.nativeRetirementMaxAttempts
      )
        return { state: 'escalate' as const, receipt: current };
      const attempt = {
        ...current,
        attempts: current.attempts + 1,
        nextAttemptAt: now() + DEADLINE_MS.stopAttempt,
      };
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(item => (matchesReceipt(item, receipt) ? attempt : item))
      );
      return { state: 'send' as const, receipt: attempt };
    });
  };

  const settleRetirementAttempt = async (
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<void> => {
    await ports.storage.transaction(async () => {
      const stored = await loadNativeRuntimeRetirements(ports.storage);
      await saveNativeRuntimeRetirements(
        ports.storage,
        stored.map(current =>
          matchesReceipt(current, receipt) &&
          current.state === 'pending' &&
          current.attempts === receipt.attempts
            ? { ...current, nextAttemptAt: now() + DEADLINE_MS.nativeRetirementRetry }
            : current
        )
      );
    });
  };

  const defer = async (receipt: NativeRuntimeRetirementReceipt): Promise<void> => {
    await settleRetirementAttempt(receipt);
    await reconcileSchedule();
  };

  const claimTargetedAttempt = async (
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<NativeRuntimeRetirementReceipt | undefined> => {
    const claimed = await claimRetirementAttempt(receipt);
    if (claimed.state === 'send') return claimed.receipt;
    if (claimed.state === 'escalate') await escalate(claimed.receipt);
    else await reconcileSchedule();
    return undefined;
  };

  const retire = async (
    input: Parameters<NativeRuntimeRetirementWorkflow['retire']>[0]
  ): Promise<'retired' | 'pending' | 'unavailable'> => {
    const nativeRuntimeId = input.route.nativeRuntimeId;
    if (!nativeRuntimeId || !ports.transport.supportsTargetedRetirement()) return 'unavailable';
    const receipt = await begin({
      ...input,
      nativeRuntimeId,
      cleanupDeadlineAt: input.cleanupDeadlineAt,
    });
    if (!receipt) return 'unavailable';
    if (receipt.operationId !== input.operationId) return 'pending';
    if (receipt.state === 'completed') return (await complete(receipt)) ? 'retired' : 'pending';
    if (receipt.state !== 'pending') return 'unavailable';
    const claimed = await claimRetirementAttempt(receipt);
    if (claimed.state === 'escalate') {
      return (await escalate(claimed.receipt)) ? 'unavailable' : 'pending';
    }
    if (claimed.state !== 'send') {
      await reconcileSchedule();
      return claimed.state === 'pending' ? 'pending' : 'unavailable';
    }
    try {
      if (
        !(await ports.transport.abortNativeRuntime({
          receipt: claimed.receipt,
          route: input.route,
        }))
      ) {
        await settleRetirementAttempt(claimed.receipt);
        if (now() >= claimed.receipt.cleanupDeadlineAt) {
          return (await escalate(claimed.receipt)) ? 'unavailable' : 'pending';
        }
        await reconcileSchedule();
        return 'pending';
      }
    } catch {
      await settleRetirementAttempt(claimed.receipt);
      if (now() >= claimed.receipt.cleanupDeadlineAt) {
        return (await escalate(claimed.receipt)) ? 'unavailable' : 'pending';
      }
      await reconcileSchedule();
      return 'pending';
    }
    return (await complete(claimed.receipt)) ? 'retired' : 'pending';
  };

  const receiveRetired = async (
    input: Parameters<NativeRuntimeRetirementWorkflow['receiveRetired']>[0]
  ): Promise<{ retired: true } | undefined> => {
    if (!ports.currentIncarnation.isCurrent(input.connection)) return undefined;
    const [physical, routes, receipts] = await Promise.all([
      loadPhysicalRecord(ports.storage),
      loadRouteTable(ports.storage),
      loadNativeRuntimeRetirements(ports.storage),
    ]);
    const matchesExisting = (receipt: NativeRuntimeRetirementReceipt) =>
      sameNativeRuntimeRetirementLifetime(receipt, {
        directory: input.directory,
        nativeRuntimeId: input.nativeRuntimeId,
        connection: input.connection,
      }) && matchesNativeRuntimeRetirementAllocation(receipt, physical);
    const existing =
      receipts.find(receipt => matchesExisting(receipt) && receipt.state === 'completed') ??
      receipts.find(receipt => matchesExisting(receipt) && receipt.state === 'pending');
    if (existing?.state === 'completed')
      return (await complete(existing)) ? { retired: true } : undefined;
    if (existing?.state === 'pending')
      return (await complete(existing)) ? { retired: true } : undefined;
    const matches = [...routes.values()].filter(route => route.directory === input.directory);
    const route = matches[0];
    if (
      !route ||
      matches.some(route => route.nativeRuntimeId !== input.nativeRuntimeId) ||
      physical.state !== 'running' ||
      physical.stopTombstone ||
      physical.providerRef !== input.connection.providerInstanceId
    )
      return undefined;
    const receipt = await begin({
      connection: input.connection,
      physical,
      route,
      nativeRuntimeId: input.nativeRuntimeId,
      reason: input.reason,
      operationId: input.retirementId,
      cleanupDeadlineAt: input.cleanupDeadlineAt,
    });
    return receipt && (await complete(receipt)) ? { retired: true } : undefined;
  };

  const resume = async (): Promise<void> => {
    const receipts = await loadNativeRuntimeRetirements(ports.storage);
    if (receipts.length === 0) return;
    for (const receipt of receipts) {
      if (receipt.state === 'completed') {
        await complete(receipt);
        continue;
      }
      if (receipt.state !== 'pending') continue;
      if (now() >= receipt.cleanupDeadlineAt) {
        await escalate(receipt);
        continue;
      }
      const [physical, routes] = await Promise.all([
        loadPhysicalRecord(ports.storage),
        loadRouteTable(ports.storage),
      ]);
      const route = routes.get(receipt.recipients[0]?.sessionId ?? '');
      const connection = ports.currentIncarnation.getConnection();
      if (
        !connection ||
        !ports.currentIncarnation.sameLifetime(connection, receipt.connection) ||
        !ports.currentIncarnation.isCurrent(connection)
      ) {
        await defer(receipt);
        continue;
      }
      if (
        !route ||
        !matchesNativeRuntimeRetirementAllocation(receipt, physical) ||
        !routesMatchNativeRuntimeRetirement(routes, receipt) ||
        !ports.transport.supportsTargetedRetirement()
      ) {
        await escalate(receipt);
        continue;
      }
      await retire({
        connection,
        physical,
        route,
        reason: receipt.reason,
        operationId: receipt.operationId,
        cleanupDeadlineAt: receipt.cleanupDeadlineAt,
      });
    }
    await reconcileSchedule();
  };

  return {
    begin,
    complete,
    release,
    defer,
    claimTargetedAttempt,
    retire,
    receiveRetired,
    resume,
  };
}
