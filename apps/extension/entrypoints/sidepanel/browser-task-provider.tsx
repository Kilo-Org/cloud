/* eslint-disable max-lines, init-declarations, unicorn/no-useless-undefined, import/max-dependencies, typescript/consistent-type-definitions -- Owner admission initializes pending handles; TypeScript requires an explicit value for empty deferred settlement. */
import { browser, storage } from '#imports';
import {
  browserFailureReasonSchema,
  browserProviderInboundMessageSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import type {
  BrowserJobSnapshot,
  BrowserProviderInboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
import { BrowserProviderError } from '@kilocode/cloud-agent-sdk/user-web-connection';
import type {
  BrowserProviderConnection,
  BrowserProviderRegistration,
  BrowserProviderState,
  BrowserProviderStatusResult,
  UserWebConnection,
} from '@kilocode/cloud-agent-sdk/user-web-connection';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { MEMORY_SETTINGS_STORAGE_KEY } from '@/src/shared/agent-memory-settings';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import { WORKFLOW_SETTINGS_STORAGE_KEY } from '@/src/shared/agent-workflows-storage';
import { AUTH_STORAGE_KEY, getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import {
  BrowserPersistenceError,
  loadBrowserProvider,
  saveBrowserProviderSettings,
} from '@/src/shared/browser-provider-settings';
import type {
  BrowserApprovalSettings,
  BrowserProfileContext,
  BrowserProviderIdentity,
  BrowserProviderSettings,
} from '@/src/shared/browser-provider-settings';
import { openBrowserTaskStore } from '@/src/shared/browser-task-store';
import type { BrowserTaskStore, StoredBrowserJob } from '@/src/shared/browser-task-store';
import { REMOTE_MCP_STORAGE_KEY } from '@/src/shared/remote-mcp-storage';
import { WEB_MCP_SETTINGS_STORAGE_KEY } from '@/src/shared/web-mcp-settings';
import { getBrowserExecutionCoordinator } from './browser-execution-lock';
import type {
  BrowserExecutionCoordinator,
  BrowserExecutionLease,
  BrowserRecoveryReadiness,
} from './browser-execution-lock';
import {
  browserTaskFailure,
  getBrowserTaskTabs,
  readBrowserTaskSettings,
  runBrowserTask,
} from './browser-task-runner';
import type { BrowserTaskStorage } from './browser-task-runner';
import { useGatewayModels } from './use-gateway-models';

type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
type FailureReason = Exclude<BrowserResult['reason'], 'completed'>;
type Consent = {
  settings: BrowserApprovalSettings;
  supportsImages: boolean;
  tab: NonNullable<BrowserJobSnapshot['approvedTab']>;
};
type Connection = BrowserProviderConnection & Pick<UserWebConnection, 'retain' | 'retryConnection'>;
type ObservableStorage = BrowserTaskStorage & {
  watch: (key: `local:${string}`, listener: () => void) => () => void;
};
type VisibleSettings = Omit<BrowserApprovalSettings, 'remoteMcpServers'> & {
  remoteMcpServers: Pick<
    BrowserApprovalSettings['remoteMcpServers'][number],
    'id' | 'displayName' | 'url' | 'enabled' | 'allowInSafeMode'
  >[];
};
export type BrowserTaskProviderSnapshot = {
  readonly active:
    | {
        goal: string;
        ownerLabel: string;
        job: BrowserJobSnapshot;
        approval: { tab: Consent['tab']; settings: VisibleSettings } | undefined;
      }
    | undefined;
  readonly jobs: readonly BrowserJobSnapshot[];
  readonly message: string;
  readonly phase:
    | 'connecting'
    | 'disabled'
    | 'idle'
    | 'owned_elsewhere'
    | 'unsupported'
    | 'unavailable'
    | 'awaiting_approval'
    | 'waiting'
    | 'running'
    | 'interrupted'
    | 'recovery';
  readonly profile: Pick<BrowserProviderIdentity, 'label' | 'providerId'> | undefined;
  readonly result: BrowserResult | undefined;
  readonly retryable: boolean;
  readonly settings: BrowserProviderSettings | undefined;
  readonly unresolvedFence: BrowserProviderStatusResult['unresolvedFence'];
};

type Invocation = {
  abort: AbortController;
  consent: ReturnType<typeof Promise.withResolvers<Consent | undefined>>;
  delivery: Delivery;
  events: AgentConversationEvent[];
  lease: BrowserExecutionLease | undefined;
  permissionChecks: number;
  record: StoredBrowserJob | undefined;
  relay: BrowserJobSnapshot;
  running: ReturnType<typeof Promise.withResolvers<BrowserJobSnapshot | undefined>>;
  selected: Consent | undefined;
  started: boolean;
  terminal: ReturnType<typeof Promise.withResolvers<BrowserJobSnapshot | undefined>>;
  timer: ReturnType<typeof setTimeout> | undefined;
  work: Promise<void> | undefined;
};

const jobBinding = (job: BrowserJobSnapshot) => ({
  browserTaskId: job.browserTaskId,
  generation: job.generation,
  invocationId: job.invocationId,
  jobId: job.jobId,
  providerId: job.providerId,
});
const sameJob = (left: BrowserJobSnapshot, right: BrowserJobSnapshot): boolean =>
  JSON.stringify(jobBinding(left)) === JSON.stringify(jobBinding(right)) &&
  left.payloadFingerprint === right.payloadFingerprint;
const sameTab = (
  left: BrowserJobSnapshot['approvedTab'],
  right: BrowserJobSnapshot['approvedTab']
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.tabId === right.tabId &&
  left.url === right.url &&
  left.title === right.title &&
  left.effectiveMode === right.effectiveMode;
const visibleSettings = (settings: BrowserApprovalSettings): VisibleSettings => ({
  ...settings,
  remoteMcpServers: settings.remoteMcpServers.map(
    ({ allowInSafeMode, displayName, enabled, id, url }) => ({
      allowInSafeMode,
      displayName,
      enabled,
      id,
      url,
    })
  ),
});
const failureReason = (error: unknown): FailureReason => {
  let reason = 'runner_failed';
  if (error instanceof ExecutionStoppedError) {
    ({ reason } = error);
  }
  if (error instanceof BrowserProviderError || error instanceof BrowserPersistenceError) {
    reason = error.code;
  }
  const parsed = browserFailureReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : 'provider_unavailable';
};

export type BrowserTaskProviderOptions = {
  readonly auth: StoredAuth;
  readonly connection: Connection;
  readonly organizationId: string | undefined;
  readonly coordinator?: BrowserExecutionCoordinator;
  readonly storageArea?: ObservableStorage;
  readonly supportsImages?: (model: string) => boolean;
};

/** Snapshots never start work. Only a newly persisted delivery and explicit consent can do so. */
export const createBrowserTaskProviderRuntime = (options: BrowserTaskProviderOptions) => {
  const { auth, connection, organizationId } = options;
  const coordinator = options.coordinator ?? getBrowserExecutionCoordinator();
  const storageArea = options.storageArea ?? storage;
  const listeners = new Set<() => void>();
  const jobs = new Map<string, BrowserJobSnapshot>();
  const cleanup: (() => void)[] = [];
  let current: Invocation | undefined = undefined;
  let owner: BrowserExecutionLease | undefined = undefined;
  let profile: BrowserProfileContext | undefined = undefined;
  let identity: BrowserProviderIdentity | undefined = undefined;
  let store: BrowserTaskStore | undefined = undefined;
  let settings: BrowserProviderSettings | undefined = undefined;
  let disposed = false;
  let needsRecovery = false;
  let generation = 0;
  let revokedGeneration = 0;
  let leaseUntil = 0;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
  let registering: Promise<'cancelled' | undefined> | undefined = undefined;
  let starting: Promise<void> | undefined = undefined;
  let statusRequest: Promise<BrowserProviderStatusResult['unresolvedFence']> | undefined =
    undefined;
  let recovering = false;
  let recoveryRevision = 0;
  let snapshot: BrowserTaskProviderSnapshot = {
    active: undefined,
    jobs: [],
    message: 'CLI tasks require an enabled, signed-in open panel.',
    phase: 'connecting',
    profile: undefined,
    result: undefined,
    retryable: false,
    settings: undefined,
    unresolvedFence: undefined,
  };
  const publish = (change: Partial<BrowserTaskProviderSnapshot> = {}): void => {
    for (const [id, job] of jobs) {
      if (Date.parse(job.expiresAt) <= Date.now()) {
        jobs.delete(id);
      }
    }
    // Consumers receive copies, never mutable references to approved execution settings.
    snapshot = structuredClone({
      ...snapshot,
      active:
        current === undefined
          ? undefined
          : {
              approval:
                current.selected === undefined
                  ? undefined
                  : {
                      settings: visibleSettings(current.selected.settings),
                      tab: current.selected.tab,
                    },
              goal: current.delivery.goal,
              job: current.relay,
              ownerLabel: current.delivery.ownerLabel,
            },
      jobs: [...jobs.values()],
      profile:
        identity === undefined
          ? undefined
          : { label: identity.label, providerId: identity.providerId },
      settings,
      ...change,
    });
    for (const listener of listeners) {
      listener();
    }
  };
  const restingPhase = (): BrowserTaskProviderSnapshot['phase'] => {
    if (settings?.enabled !== true) {
      return 'disabled';
    }
    if (needsRecovery) {
      return 'recovery';
    }
    if (current !== undefined) {
      return snapshot.phase;
    }
    return leaseUntil > Date.now() ? 'idle' : 'connecting';
  };
  const stopInvocation = (reason: FailureReason): void => {
    if (current === undefined || current.abort.signal.aborted) {
      return;
    }
    const uncertain = current.started && reason !== 'cancelled' && reason !== 'approval_denied';
    current.abort.abort(
      new ExecutionStoppedError(
        reason,
        reason === 'cancelled' ? 'cancelled' : 'interrupted',
        uncertain
      )
    );
    current.consent.resolve(undefined);
    current.running.resolve(undefined);
  };
  const unavailable = (reason: FailureReason, effectsUncertain = false): void => {
    stopInvocation(reason);
    leaseUntil = 0;
    revokedGeneration = Math.max(revokedGeneration, generation);
    clearTimeout(leaseTimer);
    const affected = current?.selected?.tab.tabId;
    const lease = current?.lease ?? owner;
    if (effectsUncertain && affected !== undefined && lease !== undefined) {
      needsRecovery = true;
      // The safety record is independent of auth cleanup and contains no account history.
      void (async () => {
        try {
          await lease.quarantine(affected);
        } catch {
          publish({
            message: 'Browser safety storage is unavailable. Restore storage before recovery.',
            phase: 'recovery',
          });
        }
      })();
    }
    if (identity !== undefined && generation > 0) {
      try {
        connection.markBrowserProviderUnavailable({
          effectsUncertain,
          generation,
          providerId: identity.providerId,
          reason,
        });
      } catch {
        /* The relay lease, not teardown delivery, settles disconnected work. */
      }
    }
  };
  const invocationErrors = new WeakMap<Invocation, string>();
  const reportError = (error: unknown): void => {
    const message =
      error instanceof BrowserPersistenceError
        ? error.message
        : `Browser provider unavailable: ${failureReason(error)}. Retrieve status before explicit recovery.`;
    if (current !== undefined) {
      invocationErrors.set(current, message);
    }
    publish({
      message,
      phase: needsRecovery ? 'recovery' : 'unavailable',
      retryable:
        error instanceof BrowserPersistenceError || error instanceof BrowserProviderError
          ? error.retryable
          : false,
    });
  };
  const assertLease = (): void => {
    owner?.guard();
    if (disposed || owner === undefined || settings?.enabled !== true) {
      throw new ExecutionStoppedError('provider_unavailable');
    }
    const state = connection.getBrowserProviderState();
    if (
      leaseUntil <= Date.now() ||
      generation <= revokedGeneration ||
      state.status !== 'registered' ||
      state.lease.generation !== generation ||
      state.lease.providerId !== identity?.providerId
    ) {
      throw new ExecutionStoppedError('lease_expired');
    }
  };
  const guardInvocation = (invocation: Invocation, running = false): void => {
    invocation.abort.signal.throwIfAborted();
    assertLease();
    if (
      current !== invocation ||
      invocation.relay.generation !== generation ||
      invocation.relay.result !== undefined
    ) {
      throw new ExecutionStoppedError('provider_lost');
    }
    if (invocation.permissionChecks > 0) {
      // Frozen consent cannot authorize actions while live permissions remain unverified.
      throw new ExecutionStoppedError('permission_denied');
    }
    const deadline = running
      ? invocation.relay.deadlines.execution
      : invocation.delivery.job.deadlines.approval;
    if (
      deadline === undefined ||
      Date.parse(deadline) <= Date.now() ||
      Date.parse(invocation.relay.expiresAt) <= Date.now()
    ) {
      throw new ExecutionStoppedError(running ? 'execution_timeout' : 'approval_timeout');
    }
    if (
      running &&
      (invocation.relay.status !== 'running' ||
        !sameTab(invocation.relay.approvedTab, invocation.selected?.tab))
    ) {
      throw new ExecutionStoppedError('tab_lost');
    }
  };
  const phaseDeadline = (invocation: Invocation, deadline: string, reason: FailureReason): void => {
    clearTimeout(invocation.timer);
    invocation.timer = setTimeout(
      () => {
        needsRecovery = true;
        unavailable(reason, invocation.started);
        publish({
          message: `Browser task stopped: ${reason}. Retrieve status before recovery.`,
          phase: 'interrupted',
        });
      },
      Math.max(
        0,
        Math.min(Date.parse(deadline), Date.parse(invocation.relay.expiresAt)) - Date.now()
      )
    );
  };
  const consumeJob = (job: BrowserJobSnapshot, acknowledgeRunning = true): void => {
    const previous = jobs.get(job.jobId);
    if (previous !== undefined && !sameJob(previous, job)) {
      return;
    }
    if (previous?.result !== undefined) {
      // Later provider pages can supply an owner without replacing the first terminal snapshot.
      if (job.ownerLabel !== undefined && job.ownerLabel !== previous.ownerLabel) {
        jobs.set(job.jobId, { ...previous, ownerLabel: job.ownerLabel });
        publish();
      }
      return;
    }
    jobs.set(job.jobId, job);
    if (current !== undefined && sameJob(current.relay, job)) {
      if (current.relay.result !== undefined) {
        return;
      }
      if (job.result !== undefined) {
        current.relay = job;
        current.terminal.resolve(job);
        stopInvocation(
          job.result.reason === 'completed' ? 'provider_unavailable' : job.result.reason
        );
        publish({ result: job.result });
      } else if (job.status === 'running' && acknowledgeRunning) {
        if (current.selected === undefined || !sameTab(job.approvedTab, current.selected.tab)) {
          needsRecovery = true;
          unavailable('tab_lost', current.started);
          return;
        }
        current.relay = job;
        current.running.resolve(job);
      }
    }
    publish();
  };
  let lastStatus: { fence: BrowserProviderStatusResult['unresolvedFence'] } | undefined;
  const refreshStatus = (): Promise<BrowserProviderStatusResult['unresolvedFence']> => {
    statusRequest ??= (async () => {
      const providerOwner = owner;
      const providerProfile = profile;
      const providerIdentity = identity;
      const providerSettings = settings;
      const providerGeneration = generation;
      const revision = recoveryRevision;
      const guard = (): void => {
        if (
          disposed ||
          owner !== providerOwner ||
          profile !== providerProfile ||
          identity !== providerIdentity ||
          settings !== providerSettings ||
          generation !== providerGeneration ||
          recoveryRevision !== revision
        ) {
          throw new ExecutionStoppedError('provider_lost');
        }
        try {
          // Read-only history needs the panel owner, not a registered execution lease.
          providerOwner?.guard();
        } catch {
          throw new ExecutionStoppedError('provider_lost');
        }
      };
      const deadline = Date.now() + 30_000;
      const cursors = new Set<string>();
      let cursor: string | undefined = undefined;
      let fence: BrowserProviderStatusResult['unresolvedFence'] = undefined;
      try {
        do {
          guard();
          if (Date.now() >= deadline) {
            throw new ExecutionStoppedError('provider_unavailable');
          }
          // eslint-disable-next-line no-await-in-loop -- Follow bounded history pages without granting execution.
          const page = await connection.requestBrowserProviderStatus(cursor, providerIdentity);
          guard();
          if (page.providerId !== providerIdentity?.providerId) {
            throw new ExecutionStoppedError('owner_mismatch');
          }
          fence = page.unresolvedFence ?? fence;
          for (const job of page.jobs) {
            guard();
            // Status pages update display state, but never acknowledge approval or grant a lease.
            consumeJob(job, false);
          }
          cursor = page.nextCursor;
          if (cursor !== undefined && cursors.has(cursor)) {
            throw new ExecutionStoppedError('invalid_request');
          }
          if (cursor !== undefined) {
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        guard();
        lastStatus = { fence: structuredClone(fence) };
        publish({ unresolvedFence: fence });
        return fence;
      } catch (error) {
        guard();
        throw error;
      } finally {
        statusRequest = undefined;
      }
    })();
    return statusRequest;
  };
  const register = (
    recovery?: BrowserProviderRegistration['recovery']
  ): Promise<'cancelled' | undefined> => {
    registering ??= (async (): Promise<'cancelled' | undefined> => {
      const providerOwner = owner;
      const providerProfile = profile;
      const providerIdentity = identity;
      const providerSettings = settings;
      const guard = (): void => {
        // Registration changes its own generation and transport state, not its owning lifetime.
        if (
          disposed ||
          owner !== providerOwner ||
          profile !== providerProfile ||
          identity !== providerIdentity ||
          settings !== providerSettings
        ) {
          throw new ExecutionStoppedError('provider_lost');
        }
        try {
          providerOwner?.guard();
        } catch {
          throw new ExecutionStoppedError('provider_lost');
        }
      };
      try {
        if (
          providerProfile === undefined ||
          providerIdentity === undefined ||
          providerSettings?.enabled !== true
        ) {
          return 'cancelled';
        }
        guard();
        publish({
          message: 'Connecting the enabled browser provider. Keep this panel open.',
          phase: 'connecting',
        });
        guard();
        try {
          await connection.registerBrowserProvider({
            generation,
            label: providerIdentity.label,
            providerId: providerIdentity.providerId,
            providerProof: providerIdentity.providerProof,
            ...(recovery === undefined ? {} : { recovery }),
          });
        } catch (error) {
          guard();
          // A rejected registration can still leave an authoritative recovery fence.
          const fence = await refreshStatus();
          guard();
          needsRecovery ||= fence !== undefined;
          throw error;
        }
        guard();
        await refreshStatus();
        guard();
        await coordinator.refresh();
        guard();
        const execution = coordinator.getSnapshot();
        if (
          execution.quarantinedTabIds.length > 0 ||
          (execution.delegated === 'idle' && execution.blockedReason !== undefined)
        ) {
          needsRecovery = true;
          unavailable('effects_uncertain', true);
        }
        guard();
        publish({
          message: needsRecovery
            ? (execution.blockedReason ??
              'Retrieve status, close affected tabs, then recover explicitly.')
            : 'CLI tasks are enabled. Keep this panel open.',
          phase: restingPhase(),
        });
      } catch (error) {
        try {
          guard();
        } catch {
          return 'cancelled';
        }
        if (error instanceof ExecutionStoppedError && error.reason === 'provider_lost') {
          // Recovery must stop too; background registration callers can ignore this outcome.
          return 'cancelled';
        }
        reportError(error);
      } finally {
        registering = undefined;
      }
      return undefined;
    })();
    return registering;
  };
  const onState = (state: BrowserProviderState): void => {
    if (disposed) {
      return;
    }
    // Matching lease renewals preserve read-only work; transport and binding changes invalidate it.
    if (
      state.status !== 'registered' ||
      state.lease.providerId !== identity?.providerId ||
      state.lease.generation !== generation
    ) {
      recoveryRevision += 1;
    }
    if (state.status === 'registered') {
      if (
        state.lease.providerId !== identity?.providerId ||
        state.lease.generation <= revokedGeneration
      ) {
        return;
      }
      if (current !== undefined && state.lease.generation !== generation) {
        stopInvocation('provider_lost');
        needsRecovery = true;
      }
      if (leaseUntil !== 0 && leaseUntil <= Date.now() && state.lease.generation === generation) {
        unavailable('lease_expired', current?.started === true);
        return;
      }
      ({ generation } = state.lease);
      leaseUntil = Math.min(Date.parse(state.lease.leaseExpiresAt), Date.now() + 15_000);
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
          needsRecovery ||= current !== undefined;
          unavailable('lease_expired', current?.started === true);
          publish({
            message: 'The provider lease expired. Retrieve status before recovery.',
            phase: 'interrupted',
          });
        },
        Math.max(0, leaseUntil - Date.now())
      );
      return;
    }
    revokedGeneration = Math.max(revokedGeneration, generation);
    leaseUntil = 0;
    clearTimeout(leaseTimer);
    if (state.status === 'ready') {
      // Clear the SDK's reconnect registration before it can advertise a quarantined profile.
      if (settings?.enabled === true && needsRecovery) {
        unavailable('provider_unavailable');
      }
      if (settings?.enabled === true && !needsRecovery) {
        void register();
      }
      return;
    }
    if (current !== undefined) {
      needsRecovery = true;
      const parsed =
        state.status === 'unavailable'
          ? browserFailureReasonSchema.safeParse(state.reason)
          : undefined;
      stopInvocation(parsed?.success === true ? parsed.data : 'provider_lost');
    }
    if (settings?.enabled !== true) {
      return;
    }
    let phase: BrowserTaskProviderSnapshot['phase'] = needsRecovery ? 'recovery' : 'connecting';
    if (state.status === 'unavailable' && !needsRecovery) {
      phase = 'unavailable';
    }
    if (state.status === 'unavailable' && state.reason === 'unsupported') {
      phase = 'unsupported';
    }
    publish({
      message:
        state.status === 'unavailable'
          ? `Browser provider unavailable: ${state.reason}. Retrieve status before explicit recovery.`
          : 'The relay connection is unavailable. Reconnect and retrieve status; no browser actions will replay.',
      phase,
      retryable: state.status === 'unavailable' ? state.retryable : true,
    });
  };
  const runInvocation = async (invocation: Invocation): Promise<void> => {
    const taskStore = store;
    const providerOwner = owner;
    if (taskStore === undefined || providerOwner === undefined) {
      return;
    }
    let result = browserTaskFailure(invocation.relay, 'provider_unavailable');
    let uncertain = false;
    let quiescence: BrowserJobSnapshot | undefined;
    try {
      const accepted = await taskStore.accept(invocation.delivery);
      invocation.record = accepted.job;
      invocation.events = await taskStore.history(
        invocation.relay.browserTaskId,
        invocation.delivery.ownerLabel
      );
      if (accepted.kind === 'existing') {
        needsRecovery = true;
        publish({ result: accepted.job.snapshot.result });
        throw new ExecutionStoppedError('provider_unavailable');
      }
      guardInvocation(invocation);
      publish({
        message: 'Approve one specific tab for this owner and goal, or reject the task.',
        phase: 'awaiting_approval',
      });
      const consent = await invocation.consent.promise;
      guardInvocation(invocation);
      if (consent === undefined) {
        throw new ExecutionStoppedError('approval_denied');
      }
      invocation.selected = consent;
      publish({
        message: 'Waiting for local browser runs to drain. The approval deadline still applies.',
        phase: 'waiting',
      });
      const admission = await coordinator.acquireDelegated(
        providerOwner,
        invocation.delivery.ownerLabel,
        invocation.abort.signal
      );
      if (!admission.admitted) {
        invocation.abort.signal.throwIfAborted();
        throw new ExecutionStoppedError('provider_unavailable');
      }
      invocation.lease = admission.lease;
      guardInvocation(invocation);
      const tabs = await getBrowserTaskTabs();
      if (!tabs.some(tab => tab.id === consent.tab.tabId)) {
        throw new ExecutionStoppedError('tab_lost');
      }
      invocation.record = await taskStore.approve(
        invocation.relay.invocationId,
        consent.tab,
        consent.settings
      );
      guardInvocation(invocation);
      connection.approveBrowserProviderJob({
        ...jobBinding(invocation.relay),
        approval: { decision: 'approved', tab: consent.tab },
      });
      const running = await invocation.running.promise;
      guardInvocation(invocation, true);
      if (running === undefined || running.deadlines.execution === undefined) {
        throw new ExecutionStoppedError('provider_lost');
      }
      phaseDeadline(invocation, running.deadlines.execution, 'execution_timeout');
      invocation.started = true;
      publish({
        message:
          'This CLI task owns browser control. Stop prevents future actions, not actions already issued.',
        phase: 'running',
      });
      const completed = await runBrowserTask({
        abort: invocation.abort,
        apiBaseUrl: getKiloApiBaseUrl(),
        events: invocation.events,
        executionGuard: () => {
          guardInvocation(invocation, true);
        },
        fetch: (input, init) => globalThis.fetch(input, init),
        job: running,
        lease: admission.lease,
        remoteFetch: globalThis.fetch,
        settings: consent.settings,
        storage: storageArea,
        supportsImages: consent.supportsImages,
        token: auth.token,
      });
      invocation.events = completed.events;
      uncertain = completed.outcome.effectsUncertain;
      ({ result } = completed);
    } catch (error) {
      const stopped = error instanceof ExecutionStoppedError ? error : undefined;
      uncertain = stopped?.effectsUncertain ?? invocation.started;
      result = browserTaskFailure(invocation.relay, failureReason(error), uncertain);
      if (stopped === undefined) {
        reportError(error);
      }
    }
    try {
      uncertain ||= invocation.relay.result?.effectsUncertain === true && invocation.started;
      if (uncertain && invocation.selected !== undefined) {
        needsRecovery = true;
        await (invocation.lease ?? providerOwner).quarantine(invocation.selected.tab.tabId);
      }
      if (invocation.record === undefined) {
        unavailable(result.reason === 'completed' ? 'provider_unavailable' : result.reason);
      } else {
        // A pre-approval relay fence does not imply an issued local action or invent a tab.
        // Record observed local execution; the relay result remains the displayed authority.
        const persistedResult =
          invocation.record.approval === null ? result : (invocation.relay.result ?? result);
        const saved = await taskStore.finish(
          invocation.relay.invocationId,
          persistedResult,
          invocation.events
        );
        result = invocation.relay.result ?? saved.snapshot.result ?? result;
      }
      if (
        invocation.relay.result === undefined &&
        invocation.selected !== undefined &&
        invocation.started
      ) {
        try {
          assertLease();
          connection.sendBrowserProviderResult({
            ...jobBinding(invocation.relay),
            result,
            tab: invocation.selected.tab,
          });
        } catch {
          needsRecovery = true;
          // Never buffer or resend terminal updates through a later generation.
        }
      } else if (
        invocation.relay.result === undefined &&
        result.reason !== 'approval_denied' &&
        result.reason !== 'cancelled'
      ) {
        unavailable(result.reason === 'completed' ? 'provider_unavailable' : result.reason);
      }
      // Rejection and cancellation already request settlement; wait without withdrawing queued work.
      if (disposed) {
        invocation.terminal.resolve(undefined);
      }
      const timeout = setTimeout(() => {
        invocation.terminal.resolve(undefined);
      }, 10_000);
      const terminal =
        invocation.relay.result === undefined
          ? await invocation.terminal.promise
          : invocation.relay;
      clearTimeout(timeout);
      if (
        !uncertain &&
        terminal?.result !== undefined &&
        invocation.record !== undefined &&
        (terminal.approvedTab === undefined
          ? !invocation.started
          : invocation.record.approval !== null &&
            sameTab(terminal.approvedTab, invocation.selected?.tab))
      ) {
        quiescence = terminal;
      } else {
        needsRecovery = true;
      }
      publish({ result: terminal?.result ?? result });
    } catch (error) {
      needsRecovery = true;
      unavailable('provider_unavailable', invocation.started);
      reportError(error);
    } finally {
      clearTimeout(invocation.timer);
      invocation.abort.abort(new ExecutionStoppedError('provider_unavailable'));
      try {
        await invocation.lease?.release();
      } catch (error) {
        quiescence = undefined;
        needsRecovery = true;
        reportError(error);
      }
      if (current === invocation) {
        current = undefined;
      }
      // Clear the finished owner before quiescence can deliver the next FIFO job.
      if (!disposed && quiescence !== undefined) {
        try {
          connection.quiesceBrowserProviderJob({
            ...jobBinding(quiescence),
            ...(quiescence.approvedTab === undefined
              ? {}
              : { tabId: quiescence.approvedTab.tabId }),
          });
        } catch {
          needsRecovery = true;
        }
      }
      if (current === undefined) {
        publish({
          message:
            invocationErrors.get(invocation) ??
            (needsRecovery
              ? (coordinator.getSnapshot().blockedReason ??
                'Retrieve status, close affected tabs, and recover explicitly. Old work will not replay.')
              : 'CLI tasks are enabled. Keep this panel open.'),
          phase: restingPhase(),
        });
      }
    }
  };
  const onMessage = (input: BrowserProviderInboundMessage): void => {
    const parsed = browserProviderInboundMessageSchema.safeParse(input);
    if (!parsed.success || disposed) {
      return;
    }
    const message = parsed.data;
    if (message.type === 'provider_status_result' || message.type === 'provider_lease_ack') {
      return;
    }
    const binding = message.type === 'provider_job' ? message.job : message;
    if (binding.providerId !== identity?.providerId || binding.generation !== generation) {
      return;
    }
    if (message.type === 'provider_job_cancel') {
      if (
        current?.relay.jobId === message.jobId &&
        current.relay.invocationId === message.invocationId
      ) {
        stopInvocation(message.reason);
      }
      return;
    }
    if (message.type === 'provider_snapshot') {
      for (const job of message.jobs) {
        consumeJob(job);
      }
      return;
    }
    try {
      assertLease();
    } catch {
      return;
    }
    if (store === undefined) {
      return;
    }
    if (
      current?.relay.invocationId === message.job.invocationId ||
      jobs.get(message.job.jobId)?.result !== undefined
    ) {
      const taskStore = store;
      void (async () => {
        try {
          await taskStore.accept(message);
          const stored = await taskStore.lookup(message.job.invocationId);
          publish({ result: jobs.get(message.job.jobId)?.result ?? stored.snapshot.result });
        } catch (error) {
          unavailable(failureReason(error));
          reportError(error);
        }
      })();
      return;
    }
    if (current !== undefined) {
      unavailable('invalid_request');
      return;
    }
    if (needsRecovery || recovering) {
      unavailable('provider_unavailable');
      return;
    }
    if (
      message.job.deadlines.approval === undefined ||
      jobs.get(message.job.jobId)?.status === 'running'
    ) {
      unavailable('invalid_request');
      return;
    }
    const invocation: Invocation = {
      abort: new AbortController(),
      consent: Promise.withResolvers<Consent | undefined>(),
      delivery: message,
      events: [],
      lease: undefined,
      permissionChecks: 0,
      record: undefined,
      relay: message.job,
      running: Promise.withResolvers<BrowserJobSnapshot | undefined>(),
      selected: undefined,
      started: false,
      terminal: Promise.withResolvers<BrowserJobSnapshot | undefined>(),
      timer: undefined,
      work: undefined,
    };
    current = invocation;
    // An invocation can finish while readiness awaits status or tab access.
    recoveryRevision += 1;
    jobs.set(message.job.jobId, message.job);
    publish({
      message: 'Recording the accepted browser task before tab consent.',
      phase: 'connecting',
    });
    const deadline = message.job.deadlines.approval;
    phaseDeadline(invocation, deadline, 'approval_timeout');
    invocation.work = runInvocation(invocation);
  };
  let heartbeatPending = false;
  const heartbeat = async (): Promise<void> => {
    if (heartbeatPending) {
      return;
    }
    heartbeatPending = true;
    try {
      const deadline = Date.now() + 30_000;
      const cursors = new Set<string>();
      let cursor: string | undefined = undefined;
      do {
        assertLease();
        if (Date.now() >= deadline) {
          throw new ExecutionStoppedError('provider_unavailable');
        }
        // eslint-disable-next-line no-await-in-loop -- Relay pages reconcile the queue; they never dispatch work.
        const page = await connection.heartbeatBrowserProvider(cursor);
        onMessage(page);
        cursor = page.nextCursor;
        if (cursor !== undefined && cursors.has(cursor)) {
          throw new ExecutionStoppedError('invalid_request');
        }
        if (cursor !== undefined) {
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
    } catch (error) {
      if (settings?.enabled === true && !disposed) {
        needsRecovery ||= current !== undefined;
        unavailable(failureReason(error), current?.started === true);
        reportError(error);
      }
    } finally {
      heartbeatPending = false;
    }
  };
  const start = (): Promise<void> => {
    starting ??= (async () => {
      try {
        const admission = await coordinator.acquireProviderOwner();
        if (!admission.admitted) {
          const unsupported = coordinator.getSnapshot().delegationUnavailableReason;
          publish({
            message:
              unsupported ??
              'Another panel owns this browser provider. Use that panel to supervise CLI tasks.',
            phase: unsupported === undefined ? 'owned_elsewhere' : 'unsupported',
          });
          return;
        }
        owner = admission.lease;
        if (disposed) {
          await owner.release();
          return;
        }
        profile = { auth, owner, storageArea };
        ({ identity, settings } = await loadBrowserProvider(profile));
        store = await openBrowserTaskStore(profile);
        if (disposed) {
          await owner.release();
          return;
        }
        cleanup.push(
          connection.onBrowserProviderMessage(onMessage),
          connection.onBrowserProviderStateChange(onState),
          connection.retain(),
          coordinator.subscribe(() => {
            const execution = coordinator.getSnapshot();
            const quarantined =
              execution.quarantinedTabIds.length > 0 ||
              (execution.delegated === 'idle' && execution.blockedReason !== undefined);
            // The active runner persists its outcome before withdrawing its own execution.
            if (
              !disposed &&
              settings?.enabled === true &&
              current?.started !== true &&
              quarantined
            ) {
              needsRecovery = true;
              if (leaseUntil > Date.now()) {
                unavailable('effects_uncertain');
              }
              publish({
                message: execution.blockedReason ?? 'Close affected tabs before explicit recovery.',
                phase: 'recovery',
              });
            }
          })
        );
        const revokePermissions = (): void => {
          if (
            current !== undefined &&
            (current.selected !== undefined || approvalRequests.has(current))
          ) {
            needsRecovery = true;
            unavailable('permission_denied', current.started);
          }
        };
        const authChanged = (): void => {
          unavailable('provider_unavailable', current?.started === true);
          needsRecovery ||= current !== undefined;
          if (settings !== undefined) {
            settings = { ...settings, enabled: false };
          }
          publish({
            message:
              'The account or organization changed. Browser work stopped; enable new work explicitly.',
            phase: restingPhase(),
          });
        };
        cleanup.push(
          storageArea.watch(AUTH_STORAGE_KEY, authChanged),
          storageArea.watch('local:kiloSelectedOrganizationId', authChanged)
        );
        const settingsChanged = (): void => {
          const invocation = current;
          const approved = invocation?.selected?.settings;
          if (
            invocation !== undefined &&
            approved === undefined &&
            approvalRequests.has(invocation)
          ) {
            // A settings change invalidates pending consent; never install its stale permissions.
            revokePermissions();
            return;
          }
          if (invocation === undefined || approved === undefined || settings === undefined) {
            return;
          }
          const selected = settings;
          invocation.permissionChecks += 1;
          void (async () => {
            try {
              const next = await readBrowserTaskSettings(selected, organizationId, storageArea);
              if (current !== invocation) {
                return;
              }
              const revoked =
                (approved.memorySettings.autoApproveMemorySaves &&
                  !next.memorySettings.autoApproveMemorySaves) ||
                (approved.workflowSettings.allowWorkflowsInSafeMode &&
                  !next.workflowSettings.allowWorkflowsInSafeMode) ||
                (approved.workflowSettings.autoApproveWorkflowChanges &&
                  !next.workflowSettings.autoApproveWorkflowChanges) ||
                (approved.workflowSettings.autoApproveWorkflowRuns &&
                  !next.workflowSettings.autoApproveWorkflowRuns) ||
                (approved.webMcpSettings.allowWebMcpInSafeMode &&
                  !next.webMcpSettings.allowWebMcpInSafeMode) ||
                approved.remoteMcpServers.some(server => {
                  if (!server.enabled) {
                    return false;
                  }
                  const live = next.remoteMcpServers.find(candidate => candidate.id === server.id);
                  return (
                    live === undefined ||
                    !live.enabled ||
                    live.url !== server.url ||
                    live.auth.type !== server.auth.type ||
                    (server.allowInSafeMode && !live.allowInSafeMode) ||
                    server.cachedTools.some(
                      tool => !live.cachedTools.some(candidate => candidate.name === tool.name)
                    )
                  );
                });
              if (revoked) {
                revokePermissions();
              }
            } catch {
              if (current === invocation) {
                revokePermissions();
              }
            } finally {
              invocation.permissionChecks -= 1;
            }
          })();
        };
        for (const key of [
          MEMORY_SETTINGS_STORAGE_KEY,
          WORKFLOW_SETTINGS_STORAGE_KEY,
          WEB_MCP_SETTINGS_STORAGE_KEY,
          REMOTE_MCP_STORAGE_KEY,
        ] as const) {
          cleanup.push(storageArea.watch(key, settingsChanged));
        }
        const tabRemoved = (tabId: number): void => {
          if (current?.selected?.tab.tabId === tabId) {
            needsRecovery = true;
            unavailable('tab_lost', current.started);
          }
        };
        const tabUpdated = (tabId: number, info: { url?: string }): void => {
          if (
            current?.selected?.tab.tabId === tabId &&
            info.url !== undefined &&
            !/^(?:https?|file):\/\//u.test(info.url)
          ) {
            tabRemoved(tabId);
          }
        };
        browser.tabs.onRemoved.addListener(tabRemoved);
        browser.tabs.onUpdated.addListener(tabUpdated);
        browser.permissions.onRemoved.addListener(revokePermissions);
        cleanup.push(() => {
          browser.tabs.onRemoved.removeListener(tabRemoved);
          browser.tabs.onUpdated.removeListener(tabUpdated);
          browser.permissions.onRemoved.removeListener(revokePermissions);
        });
        heartbeatTimer = setInterval(() => {
          if (leaseUntil > Date.now() && settings?.enabled === true) {
            void heartbeat();
          }
        }, 5000);
        publish({
          message: settings.enabled
            ? 'Connecting the enabled browser provider.'
            : 'CLI tasks are disabled. Select a model and enable them while this panel remains open.',
          phase: settings.enabled ? 'connecting' : 'disabled',
        });
        onState(connection.getBrowserProviderState());
        await registering;
      } catch (error) {
        reportError(error);
      }
    })();
    return starting;
  };
  const getRecoveryTabIds = async (
    fence: BrowserProviderStatusResult['unresolvedFence'],
    guard: () => void
  ): Promise<number[]> => {
    const tabs = await browser.tabs.query({});
    guard();
    if (fence?.tabId !== undefined && tabs.some(tab => tab.id === fence.tabId)) {
      throw new ExecutionStoppedError('tab_lost');
    }
    // Include every open ID, even if an affected tab navigated to an uninspectable address.
    return tabs.flatMap(tab => (tab.id === undefined ? [] : [tab.id]));
  };
  const approvalRequests = new WeakSet<Invocation>();
  return {
    approve: async (jobId: string, tabId: number): Promise<void> => {
      const invocation = current;
      if (
        invocation === undefined ||
        invocation.relay.jobId !== jobId ||
        invocation.selected !== undefined ||
        invocation.record === undefined ||
        settings === undefined ||
        approvalRequests.has(invocation)
      ) {
        return;
      }
      approvalRequests.add(invocation);
      try {
        guardInvocation(invocation);
        const captured = await readBrowserTaskSettings(settings, organizationId, storageArea);
        guardInvocation(invocation);
        const tabs = await getBrowserTaskTabs();
        const tab = tabs.find(candidate => candidate.id === tabId);
        guardInvocation(invocation);
        if (tab === undefined) {
          publish({
            message:
              'That tab is no longer available. Select an inspectable tab before the deadline.',
            retryable: true,
          });
          return;
        }
        const selected: Consent = {
          settings: captured,
          supportsImages: options.supportsImages?.(captured.model) === true,
          tab: { effectiveMode: captured.mode, tabId: tab.id, title: tab.title, url: tab.url },
        };
        invocation.selected = selected;
        invocation.consent.resolve(selected);
        publish();
      } catch (error) {
        // Quiescence can deliver the next job before this approval finishes.
        if (current === invocation) {
          reportError(error);
        }
      } finally {
        approvalRequests.delete(invocation);
      }
    },
    cancel: (jobId: string): void => {
      const job = jobs.get(jobId);
      if (job === undefined || job.generation !== generation || job.result !== undefined) {
        return;
      }
      if (current?.relay.jobId === jobId) {
        stopInvocation('cancelled');
      }
      try {
        connection.cancelBrowserProviderJob(jobBinding(job));
      } catch (error) {
        unavailable('provider_unavailable', current?.started === true);
        reportError(error);
      }
    },
    dispose: async (): Promise<void> => {
      disposed = true;
      unavailable('provider_unavailable', current?.started === true);
      clearInterval(heartbeatTimer);
      clearTimeout(leaseTimer);
      const draining = current;
      draining?.terminal.resolve(undefined);
      if (draining?.started === true && draining.selected !== undefined) {
        try {
          await (draining.lease ?? owner)?.quarantine(draining.selected.tab.tabId);
        } catch {
          needsRecovery = true;
        }
      }
      for (const unsubscribe of cleanup.splice(0)) {
        unsubscribe();
      }
      await draining?.work;
      await starting;
      try {
        await owner?.release();
      } catch {
        /* The coordinator retains failed quarantine releases for explicit recovery. */
      }
    },
    getSnapshot: (): BrowserTaskProviderSnapshot => snapshot,
    prepareRecovery: async (): Promise<BrowserRecoveryReadiness> => {
      const providerOwner = owner;
      const providerSettings = settings;
      const providerGeneration = generation;
      const revision = recoveryRevision;
      const guard = (): void => {
        if (coordinator.getSnapshot().delegationUnavailableReason !== undefined) {
          throw new BrowserPersistenceError(
            'unsupported',
            'Recovery requires Web Locks. Restore browser Web Locks support before recovering.'
          );
        }
        if (disposed || providerOwner === undefined || owner !== providerOwner) {
          throw new BrowserPersistenceError(
            'owner_mismatch',
            'This panel no longer owns the browser provider. Reopen the signed-in panel before checking recovery.'
          );
        }
        if (settings?.enabled !== true) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'Enable CLI tasks in the signed-in panel before checking recovery.'
          );
        }
        if (current !== undefined) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'Browser actions are still unwinding. Wait before recovery.'
          );
        }
        if (
          recovering ||
          registering !== undefined ||
          revision !== recoveryRevision ||
          settings !== providerSettings ||
          generation !== providerGeneration
        ) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The browser provider changed. Wait for it to settle, then check recovery again.'
          );
        }
        try {
          providerOwner.guard();
        } catch {
          throw new BrowserPersistenceError(
            'owner_mismatch',
            'This panel no longer owns the browser provider. Use the owning panel to check recovery.'
          );
        }
      };
      let reason =
        'Recovery status could not be retrieved. Reconnect and retrieve status before checking recovery again.';
      const notReady = (error: unknown): BrowserRecoveryReadiness => {
        if (error instanceof BrowserPersistenceError) {
          ({ message: reason } = error);
        } else if (error instanceof ExecutionStoppedError && error.reason === 'tab_lost') {
          reason =
            'Close the affected tab before recovery. Status retrieval cannot approve execution.';
        } else if (error instanceof ExecutionStoppedError && error.reason === 'owner_mismatch') {
          reason =
            'Recovery status belongs to another provider. Reopen the owning signed-in panel before checking recovery.';
        } else if (
          error instanceof BrowserProviderError &&
          error.code === 'provider_unavailable' &&
          error.retryable
        ) {
          reason =
            'Recovery status is unavailable. Reopen the signed-in panel and retrieve status before checking recovery again.';
        } else if (error instanceof BrowserProviderError && !error.retryable) {
          reason = `Recovery status is unavailable: ${error.code}. Restore provider access before checking recovery again.`;
        }
        // A stale check must not change the current invocation or publish recovery authority.
        return { ready: false, reason };
      };
      try {
        guard();
        // An earlier status request can predate this preparation's provider state.
        await statusRequest;
        guard();
        const fence = await refreshStatus();
        guard();
        reason =
          'Open tabs could not be checked. Restore browser tab access before checking recovery again.';
        // Check remote closure before retrying releases, then enumerate again under the native lock.
        await getRecoveryTabIds(fence, guard);
        let tabFailure: BrowserRecoveryReadiness | undefined;
        const readiness = await coordinator.prepareRecovery(async () => {
          try {
            return await getRecoveryTabIds(fence, guard);
          } catch (error) {
            tabFailure = notReady(error);
            throw error;
          }
        });
        if (readiness.ready) {
          guard();
        }
        return tabFailure ?? readiness;
      } catch (error) {
        try {
          guard();
        } catch (lifecycleError) {
          return notReady(lifecycleError);
        }
        return notReady(error);
      }
    },
    recover: async (): Promise<void> => {
      if (recovering || disposed || owner === undefined || settings?.enabled !== true) {
        return;
      }
      recovering = true;
      recoveryRevision += 1;
      try {
        if ((await registering) === 'cancelled') {
          return;
        }
        let fence: BrowserProviderStatusResult['unresolvedFence'];
        try {
          fence = await refreshStatus();
        } catch (error) {
          if (!(error instanceof BrowserProviderError) || error.code !== 'provider_unavailable') {
            throw error;
          }
          // A normal registration attempt installs the proof for status; it cannot clear a retained fence.
          const previousStatus = lastStatus;
          if ((await register()) === 'cancelled') {
            return;
          }
          if (lastStatus === undefined || lastStatus === previousStatus) {
            throw new ExecutionStoppedError('provider_unavailable');
          }
          // Registration already retrieved status before withdrawing a locally quarantined profile.
          ({ fence } = lastStatus);
        }
        if (current !== undefined) {
          publish({
            message: 'Browser actions are still unwinding. Wait before recovery.',
            phase: 'recovery',
          });
          return;
        }
        owner.guard();
        const recovery = await coordinator.recover(() =>
          getRecoveryTabIds(fence, () => {
            owner?.guard();
            if (disposed || settings?.enabled !== true || current !== undefined) {
              throw new ExecutionStoppedError('provider_unavailable');
            }
          })
        );
        if (!recovery.recovered) {
          publish({ message: recovery.reason, phase: 'recovery' });
          return;
        }
        unavailable('provider_unavailable');
        needsRecovery = false;
        const registration = await register(
          fence === undefined
            ? undefined
            : {
                invocationId: fence.invocationId,
                locksDrained: true,
                tabClosed: true,
                ...(fence.tabId === undefined ? {} : { tabId: fence.tabId }),
              }
        );
        if (registration === 'cancelled') {
          return;
        }
        assertLease();
        publish({
          message:
            'Browser control recovered. Submit a new invocation with fresh tab consent. Old work will not replay.',
          phase: 'idle',
        });
      } catch (error) {
        if (error instanceof ExecutionStoppedError && error.reason === 'provider_lost') {
          return;
        }
        needsRecovery = true;
        if (error instanceof ExecutionStoppedError && error.reason === 'tab_lost') {
          publish({
            message:
              'Close the affected tab before recovery. Status retrieval cannot approve execution.',
            phase: 'recovery',
            retryable: true,
          });
        } else {
          reportError(error);
        }
      } finally {
        recovering = false;
      }
    },
    refreshStatus,
    reject: (jobId: string): void => {
      if (current?.relay.jobId !== jobId || current.selected !== undefined) {
        return;
      }
      const job = current.relay;
      stopInvocation('approval_denied');
      try {
        connection.approveBrowserProviderJob({
          ...jobBinding(job),
          approval: { decision: 'denied', reason: 'approval_denied' },
        });
      } catch (error) {
        unavailable('provider_unavailable');
        reportError(error);
      }
    },
    retryConnection: (): void => {
      connection.retryConnection();
    },
    setSettings: async (next: BrowserProviderSettings): Promise<void> => {
      if (profile === undefined || disposed) {
        return;
      }
      recoveryRevision += 1;
      if (!next.enabled) {
        unavailable('provider_unavailable', current?.started === true);
      }
      try {
        settings = await saveBrowserProviderSettings(profile, structuredClone(next));
        let message =
          'CLI tasks are disabled. Active and queued tasks stop; issued actions cannot be undone.';
        if (settings.enabled) {
          message =
            current === undefined
              ? 'CLI tasks are enabled. Keep this panel open.'
              : snapshot.message;
        }
        publish({ message, phase: restingPhase() });
        if (
          settings.enabled &&
          !needsRecovery &&
          connection.getBrowserProviderState().status !== 'registered'
        ) {
          await register();
        }
      } catch (error) {
        reportError(error);
      }
    },
    start,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type BrowserTaskProviderRuntime = ReturnType<typeof createBrowserTaskProviderRuntime>;
const BrowserTaskContext = createContext<BrowserTaskProviderRuntime | undefined>(undefined);

/** A12 supplies the production mount and visible controls; this component does not create a connection. */
export const BrowserTaskProvider = ({
  auth,
  children,
  connection,
  organizationId,
}: {
  readonly auth: StoredAuth;
  readonly children: ReactNode;
  readonly connection: Connection;
  readonly organizationId: string | undefined;
}) => {
  const { modelOptions } = useGatewayModels({ auth, organizationId });
  const models = useRef(modelOptions);
  models.current = modelOptions;
  const { token, userEmail } = auth;
  const closing = useRef<Promise<void> | undefined>(undefined);
  const [runtime, setRuntime] = useState<BrowserTaskProviderRuntime>();
  useEffect(() => {
    const lifetime = createBrowserTaskProviderRuntime({
      auth: { token, userEmail },
      connection,
      organizationId,
      supportsImages: model =>
        models.current.some(option => option.id === model && option.supportsImages === true),
    });
    let cancelled = false;
    setRuntime(lifetime);
    const previous = closing.current;
    void (async () => {
      await previous;
      if (!cancelled) {
        await lifetime.start();
      }
    })();
    return () => {
      cancelled = true;
      // Retain earlier drainage even if this runtime never started.
      closing.current = (async () => {
        await Promise.all([previous, lifetime.dispose()]);
      })();
    };
  }, [connection, organizationId, token, userEmail]);
  return runtime === undefined ? null : (
    <BrowserTaskContext value={runtime}>{children}</BrowserTaskContext>
  );
};

export const useBrowserTask = () => {
  const runtime = useContext(BrowserTaskContext);
  if (runtime === undefined) {
    throw new Error('BrowserTaskProvider is required.');
  }
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return { ...runtime, state };
};
