/* eslint-disable max-lines -- The bounded store keeps its schema, transitions, and retention checks in one owned module. */
import {
  BROWSER_GOAL_MAX_BYTES,
  BROWSER_RESULT_MAX_BYTES,
  browserApprovedTabSchema,
  browserInvocationIdSchema,
  browserJobSnapshotSchema,
  browserProviderInboundMessageSchema,
  browserProviderIdSchema,
  browserResultSchema,
  browserTaskIdSchema,
  browserTerminalStatusSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import type {
  BrowserJobSnapshot,
  BrowserProviderInboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
import { z } from 'zod';
import { conversationEventsSchema } from '../../entrypoints/sidepanel/agent-conversation-schemas';
import { createUserMessage } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import { toPersistedConversationEvents } from './agent-conversation-persistence';
import {
  BrowserPersistenceError,
  assertBrowserRecordSize,
  browserApprovalSettingsSchema,
  loadBrowserProvider,
  withBrowserProfileStorage,
} from './browser-provider-settings';
import type { BrowserApprovalSettings, BrowserProfileContext } from './browser-provider-settings';

export const BROWSER_TASK_STORAGE_KEY = 'local:kiloBrowserTasks';
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const futureSkewMs = 5 * 60 * 1000;
const executionMs = 10 * 60 * 1000;
const maxJobs = 1000;
const maxQueued = 100;
type ProviderJob = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
const modeSchema = z.enum(['new', 'continue', 'unknown']);
const intentSchema = z.strictObject({
  // Old provider_job frames omit mode. Remove this fallback only after old peers and records retire.
  conversationMode: modeSchema.default('unknown'),
  goal: z
    .string()
    .min(1)
    .max(BROWSER_GOAL_MAX_BYTES)
    .refine(goal => new TextEncoder().encode(goal).byteLength <= BROWSER_GOAL_MAX_BYTES),
  job: browserJobSnapshotSchema,
  ownerLabel: z.string().min(1).max(128),
});
const approvalSchema = z.strictObject({
  approvedAt: z.iso.datetime({ precision: 3 }),
  settings: browserApprovalSettingsSchema,
  tab: browserApprovedTabSchema,
});
const jobSchema = z.strictObject({
  approval: approvalSchema.nullable(),
  intent: intentSchema,
  snapshot: browserJobSnapshotSchema,
  uncertaintyFence: z.boolean(),
});
const historySchema = z.strictObject({
  browserTaskId: browserTaskIdSchema,
  events: conversationEventsSchema,
  expiresAt: z.iso.datetime({ precision: 3 }),
  ownerLabel: z.string().min(1).max(128),
  providerId: browserProviderIdSchema,
});
const storeSchema = z.strictObject({
  accountKey: z.string().min(1),
  histories: z.array(historySchema).max(maxJobs),
  jobs: z.array(jobSchema).max(maxJobs),
  providerId: browserProviderIdSchema,
  version: z.literal(1),
});
export type StoredBrowserJob = z.infer<typeof jobSchema>;
type BrowserTaskState = z.infer<typeof storeSchema>;
export type BrowserTaskHistory = z.infer<typeof historySchema>;

const terminal = (job: BrowserJobSnapshot): boolean =>
  browserTerminalStatusSchema.safeParse(job.status).success;
const binding = (job: BrowserJobSnapshot): string =>
  JSON.stringify([
    job.providerId,
    job.browserTaskId,
    job.jobId,
    job.invocationId,
    job.generation,
    job.payloadFingerprint,
    job.createdAt,
    job.expiresAt,
    job.deadlines.queue,
  ]);
const expiresAt = (invocationId: string): number =>
  Number(browserInvocationIdSchema.parse(invocationId).split('.')[1]) + retentionMs;
const checkLifetime = (invocationId: string, now: number): void => {
  const expiry = expiresAt(invocationId);
  if (expiry <= now) {
    throw new BrowserPersistenceError(
      'invocation_expired',
      'This browser invocation expired. It cannot execute or retrieve a retained result.'
    );
  }
  if (expiry - retentionMs > now + futureSkewMs) {
    throw new BrowserPersistenceError(
      'invalid_request',
      'The browser invocation timestamp is invalid.'
    );
  }
};
const interruptedResult = (
  job: BrowserJobSnapshot,
  effectsUncertain: boolean,
  unknownIntent = false
): BrowserResult => ({
  browserTaskId: job.browserTaskId,
  effectsUncertain,
  evidence: [],
  invocationId: job.invocationId,
  jobId: job.jobId,
  providerId: job.providerId,
  reason: unknownIntent ? 'unsupported' : 'provider_unavailable',
  status: 'interrupted',
  summary: unknownIntent
    ? 'The legacy invocation has no proven conversation intent. Start a new task explicitly.'
    : 'The browser provider was interrupted. Retrieve status; do not replay this invocation. Close affected tabs before explicit recovery.',
});

/** Opening a new owner lifetime reconciles recorded work; it never resumes execution. */
export const openBrowserTaskStore = async (
  context: BrowserProfileContext,
  now: () => number = Date.now
) => {
  const { identity } = await loadBrowserProvider(context);
  const empty = (accountKey: string): BrowserTaskState => ({
    accountKey,
    histories: [],
    jobs: [],
    providerId: identity.providerId,
    version: 1,
  });
  const read = async (accountKey: string): Promise<BrowserTaskState> => {
    const raw = await context.storageArea.getItem(BROWSER_TASK_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return empty(accountKey);
    }
    const state = storeSchema.parse(raw);
    if (state.accountKey !== accountKey) {
      return empty(accountKey);
    }
    if (state.providerId !== identity.providerId) {
      throw new BrowserPersistenceError(
        'owner_mismatch',
        'Browser history belongs to a different provider.'
      );
    }
    const invocations = new Set<string>();
    const jobs = new Set<string>();
    const histories = new Set<string>();
    for (const history of state.histories) {
      if (histories.has(history.browserTaskId) || history.providerId !== state.providerId) {
        throw new BrowserPersistenceError(
          'storage_failure',
          'Browser conversation bindings are invalid.'
        );
      }
      histories.add(history.browserTaskId);
      assertBrowserRecordSize(history);
    }
    for (const job of state.jobs) {
      const { snapshot } = job;
      if (
        invocations.has(snapshot.invocationId) ||
        jobs.has(snapshot.jobId) ||
        snapshot.providerId !== state.providerId ||
        binding(snapshot) !== binding(job.intent.job) ||
        Date.parse(snapshot.expiresAt) !== expiresAt(snapshot.invocationId)
      ) {
        throw new BrowserPersistenceError(
          'storage_failure',
          'Browser invocation bindings are invalid.'
        );
      }
      invocations.add(snapshot.invocationId);
      jobs.add(snapshot.jobId);
      assertBrowserRecordSize(job);
    }
    if (state.jobs.filter(job => job.snapshot.status === 'queued').length > maxQueued) {
      throw new BrowserPersistenceError(
        'capacity_exceeded',
        'The browser queue exceeds its storage limit.'
      );
    }
    return state;
  };
  const persist = async (state: BrowserTaskState): Promise<void> => {
    for (const history of state.histories) {
      assertBrowserRecordSize(history);
    }
    for (const job of state.jobs) {
      // Reserve terminal capacity before execution, including JSON framing and phase metadata.
      assertBrowserRecordSize(job, terminal(job.snapshot) ? 0 : BROWSER_RESULT_MAX_BYTES + 1024);
    }
    context.owner.guard();
    await context.storageArea.setItem(BROWSER_TASK_STORAGE_KEY, storeSchema.parse(state));
  };
  const interrupt = async (job: StoredBrowserJob): Promise<void> => {
    if (terminal(job.snapshot)) {
      return;
    }
    const uncertain = job.snapshot.status === 'running';
    if (uncertain) {
      const tab = job.snapshot.approvedTab ?? job.approval?.tab;
      if (tab === undefined) {
        throw new BrowserPersistenceError(
          'storage_failure',
          'An interrupted browser job has no recorded tab. Browser storage needs recovery.'
        );
      }
      await context.owner.quarantine(tab.tabId);
    }
    const result = interruptedResult(
      job.snapshot,
      uncertain,
      job.intent.conversationMode === 'unknown'
    );
    job.snapshot = { ...job.snapshot, result, status: result.status };
    job.uncertaintyFence ||= uncertain;
  };
  const prune = async (state: BrowserTaskState): Promise<void> => {
    for (const job of state.jobs) {
      if (Date.parse(job.snapshot.expiresAt) <= now()) {
        // eslint-disable-next-line no-await-in-loop -- Persist each affected-tab fence before deleting its expired job.
        await interrupt(job);
      }
    }
    state.jobs = state.jobs.filter(job => Date.parse(job.snapshot.expiresAt) > now());
    const retained = new Set(state.jobs.map(job => job.snapshot.browserTaskId));
    state.histories = state.histories.filter(history => retained.has(history.browserTaskId));
  };
  const findJob = (state: BrowserTaskState, invocationId: string): StoredBrowserJob => {
    checkLifetime(invocationId, now());
    const job = state.jobs.find(candidate => candidate.snapshot.invocationId === invocationId);
    if (job === undefined) {
      throw new BrowserPersistenceError(
        'not_found',
        'The browser invocation is not recorded for this account.'
      );
    }
    return job;
  };
  const historyFor = (
    state: BrowserTaskState,
    browserTaskId: string,
    ownerLabel: string
  ): BrowserTaskHistory => {
    const history = state.histories.find(candidate => candidate.browserTaskId === browserTaskId);
    if (history === undefined) {
      throw new BrowserPersistenceError(
        'not_found',
        'Browser conversation history is missing or expired. Start a new task explicitly.'
      );
    }
    if (history.providerId !== identity.providerId || history.ownerLabel !== ownerLabel) {
      throw new BrowserPersistenceError(
        'owner_mismatch',
        'This browser conversation belongs to a different owner or provider.'
      );
    }
    if (Date.parse(history.expiresAt) <= now()) {
      throw new BrowserPersistenceError(
        'invocation_expired',
        'Browser conversation history expired. Start a new task explicitly.'
      );
    }
    return history;
  };
  const transaction = <Result>(
    work: (state: BrowserTaskState) => Result | Promise<Result>,
    initialize = false
  ): Promise<Result> =>
    withBrowserProfileStorage(context, async accountKey => {
      const state = await read(accountKey);
      const before = JSON.stringify(state);
      const result = await work(state);
      if (initialize || JSON.stringify(state) !== before) {
        await persist(state);
      }
      return structuredClone(result);
    });

  await transaction(async state => {
    for (const job of state.jobs) {
      // eslint-disable-next-line no-await-in-loop -- Reload settles every recorded job before accepting new work.
      await interrupt(job);
    }
    await prune(state);
  }, true);

  return {
    accept: (
      message: ProviderJob
    ): Promise<{ kind: 'accepted' | 'existing'; job: StoredBrowserJob }> => {
      const parsed = browserProviderInboundMessageSchema.safeParse(message);
      return transaction(async state => {
        if (!parsed.success || parsed.data.type !== 'provider_job') {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The browser invocation is invalid or its goal exceeds 16 KiB.'
          );
        }
        const delivery = parsed.data;
        const intent = intentSchema.parse({
          conversationMode: delivery.conversationMode ?? 'unknown',
          goal: delivery.goal,
          job: delivery.job,
          ownerLabel: delivery.ownerLabel,
        });
        checkLifetime(intent.job.invocationId, now());
        if (Date.parse(intent.job.expiresAt) !== expiresAt(intent.job.invocationId)) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The browser invocation expiry does not match its encoded lifetime.'
          );
        }
        if (intent.job.providerId !== identity.providerId) {
          throw new BrowserPersistenceError(
            'owner_mismatch',
            'The browser invocation targets a different provider.'
          );
        }
        const existing = state.jobs.find(
          job => job.snapshot.invocationId === intent.job.invocationId
        );
        if (existing !== undefined) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
            throw new BrowserPersistenceError(
              'invocation_conflict',
              'This invocation conflicts with its recorded intent. It cannot execute again.'
            );
          }
          return { job: existing, kind: 'existing' };
        }
        if (intent.conversationMode === 'unknown') {
          throw new BrowserPersistenceError(
            'unsupported',
            'The legacy invocation has no proven conversation intent. It cannot execute.'
          );
        }
        if (state.jobs.some(job => job.snapshot.jobId === intent.job.jobId)) {
          throw new BrowserPersistenceError(
            'invocation_conflict',
            'This browser job ID already belongs to another invocation.'
          );
        }
        await prune(state);
        // A provider_job is the active queue head. read() bounds retained queued rows separately.
        if (state.jobs.length >= maxJobs) {
          throw new BrowserPersistenceError(
            'capacity_exceeded',
            'Browser task storage is full. Retained jobs cannot be evicted. Retry after expiry.'
          );
        }
        if (
          state.jobs.some(
            job =>
              job.snapshot.browserTaskId === intent.job.browserTaskId && !terminal(job.snapshot)
          )
        ) {
          throw new BrowserPersistenceError(
            'conversation_busy',
            'This browser conversation already has unfinished work. Retrieve its status first.'
          );
        }
        let history = state.histories.find(
          candidate => candidate.browserTaskId === intent.job.browserTaskId
        );
        if (intent.conversationMode === 'continue') {
          history = historyFor(state, intent.job.browserTaskId, intent.ownerLabel);
        } else {
          if (history !== undefined) {
            throw new BrowserPersistenceError(
              'invocation_conflict',
              'A new browser task cannot replace an existing conversation.'
            );
          }
          history = {
            browserTaskId: intent.job.browserTaskId,
            events: [],
            expiresAt: intent.job.expiresAt,
            ownerLabel: intent.ownerLabel,
            providerId: intent.job.providerId,
          };
          state.histories.push(history);
        }
        history.events.push(createUserMessage(intent.goal));
        history.expiresAt = new Date(
          Math.max(Date.parse(history.expiresAt), Date.parse(intent.job.expiresAt))
        ).toISOString();
        const job: StoredBrowserJob = {
          approval: null,
          intent,
          snapshot: intent.job,
          uncertaintyFence: false,
        };
        state.jobs.push(job);
        return { job, kind: 'accepted' };
      });
    },
    approve: async (
      invocationId: string,
      tab: z.infer<typeof browserApprovedTabSchema>,
      settings: BrowserApprovalSettings
    ): Promise<StoredBrowserJob> => {
      // Capture consent before awaiting the write queue; later settings changes cannot increase authority.
      const modelSelected = settings.model.trim().length > 0;
      const parsed = approvalSchema.safeParse({
        approvedAt: new Date(now()).toISOString(),
        settings,
        tab,
      });
      if (parsed.success) {
        assertBrowserRecordSize(parsed.data);
      }
      const approval = parsed.success ? structuredClone(parsed.data) : undefined;
      const approvedJob = await transaction(state => {
        const job = findJob(state, invocationId);
        if (
          job.snapshot.status !== 'awaiting_approval' ||
          job.approval !== null ||
          job.intent.conversationMode === 'unknown'
        ) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'This invocation cannot accept another tab approval.'
          );
        }
        if (
          job.snapshot.deadlines.approval === undefined ||
          Date.parse(job.snapshot.deadlines.approval) <= now()
        ) {
          throw new BrowserPersistenceError(
            'invocation_expired',
            'The tab approval deadline expired. This invocation cannot start.'
          );
        }
        if (!modelSelected) {
          throw new BrowserPersistenceError(
            'model_required',
            'Select a model before approving this browser task.'
          );
        }
        if (approval === undefined) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The browser approval settings or tab are invalid.'
          );
        }
        if (approval.settings.mode !== approval.tab.effectiveMode) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The approved tab mode must match the approved settings.'
          );
        }
        job.approval = approval;
        job.snapshot = {
          ...job.snapshot,
          approvedTab: approval.tab,
          deadlines: {
            ...job.snapshot.deadlines,
            execution: new Date(
              Math.min(now() + executionMs, Date.parse(job.snapshot.expiresAt))
            ).toISOString(),
          },
          status: 'running',
        };
        return job;
      });
      return approvedJob;
    },
    finish: (
      invocationId: string,
      result: BrowserResult,
      events: AgentConversationEvent[]
    ): Promise<StoredBrowserJob> =>
      transaction(async state => {
        const job = findJob(state, invocationId);
        const parsed = browserResultSchema.safeParse(result);
        const snapshot = parsed.success
          ? browserJobSnapshotSchema.safeParse({
              ...job.snapshot,
              result: parsed.data,
              status: parsed.data.status,
            })
          : undefined;
        if (
          snapshot?.success !== true ||
          (result.status === 'succeeded' &&
            job.snapshot.status !== 'running' &&
            !terminal(job.snapshot))
        ) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'The browser result is invalid, oversized, or does not match the approved invocation.'
          );
        }
        if (terminal(job.snapshot)) {
          return job;
        }
        if (result.effectsUncertain) {
          const tab = job.approval?.tab;
          if (tab === undefined) {
            throw new BrowserPersistenceError(
              'invalid_request',
              'Uncertain browser work requires its recorded tab.'
            );
          }
          await context.owner.quarantine(tab.tabId);
        }
        const history = historyFor(state, job.snapshot.browserTaskId, job.intent.ownerLabel);
        const persisted = toPersistedConversationEvents(events);
        assertBrowserRecordSize(persisted);
        history.events = conversationEventsSchema.parse(persisted);
        job.snapshot = snapshot.data;
        job.uncertaintyFence = result.effectsUncertain;
        return job;
      }),
    history: (browserTaskId: string, ownerLabel: string): Promise<AgentConversationEvent[]> =>
      withBrowserProfileStorage(context, async accountKey => {
        const history = historyFor(await read(accountKey), browserTaskId, ownerLabel);
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- The event schema validates each event; JSON validation rejects explicitly undefined optional properties.
        return structuredClone(history.events) as AgentConversationEvent[];
      }),
    list: (): Promise<StoredBrowserJob[]> =>
      withBrowserProfileStorage(context, async accountKey => {
        const state = await read(accountKey);
        return state.jobs.filter(job => Date.parse(job.snapshot.expiresAt) > now());
      }),
    lookup: (invocationId: string): Promise<StoredBrowserJob> =>
      withBrowserProfileStorage(context, async accountKey =>
        structuredClone(findJob(await read(accountKey), invocationId))
      ),
    removeExpired: (): Promise<void> => transaction(prune),
    saveHistory: (invocationId: string, events: AgentConversationEvent[]): Promise<void> =>
      transaction(state => {
        const job = findJob(state, invocationId);
        if (terminal(job.snapshot)) {
          throw new BrowserPersistenceError(
            'invalid_request',
            'A terminal browser invocation cannot change its history.'
          );
        }
        const persisted = toPersistedConversationEvents(events);
        assertBrowserRecordSize(persisted);
        historyFor(state, job.snapshot.browserTaskId, job.intent.ownerLabel).events =
          conversationEventsSchema.parse(persisted);
      }),
  };
};

export type BrowserTaskStore = Awaited<ReturnType<typeof openBrowserTaskStore>>;
