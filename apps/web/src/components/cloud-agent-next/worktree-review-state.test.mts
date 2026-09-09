import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type {
  PersistedWorktreeReviewDraft,
  WorktreeReviewDraft,
  WorktreeReviewOutcome,
  WorktreeReviewScope,
} from './worktree-review-state';

const require = createRequire(import.meta.url);
const {
  createWorktreeReviewStore,
  currentWorktreeReviewCapture,
  getWorktreeReviewSourceSessionIds,
  hasPendingWorktreeReview,
  snapshotWorktreeReviewConfiguration,
  worktreeReviewSavedReadOptions,
  worktreeReviewScopeKey,
  WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS,
}: typeof import('./worktree-review-state') = require('./worktree-review-state');
import type { WorktreeReviewAnchor, WorktreeReviewResult } from './worktree-review';
import type { WorktreeReviewConfiguration, WorktreeReviewSubmission } from './worktree-review-send';
import type { CloudAgentSessionId, KiloSessionId, SessionConfig } from '@kilocode/cloud-agent-sdk';
import type { GetWorktreeChangesOutput } from '@kilocode/worker-utils/cloud-agent-worktree-changes';

const {
  QueryClient,
  QueryObserver,
}: typeof import('@tanstack/react-query') = require('@tanstack/react-query');
const {
  getWorktreeReviewFreshness,
  serializeWorktreeReview,
}: typeof import('./worktree-review') = require('./worktree-review');

const scope: WorktreeReviewScope = {
  userId: 'user-a',
  organizationId: undefined,
  workspaceScope: 'worktree:a',
};
const anchor: WorktreeReviewAnchor = {
  capture: {
    ...scope,
    sourceCloudAgentSessionId: 'workspace_source',
    revision: 1,
    capturedAt: '2026-09-01T10:00:00.000Z',
    comparison: {
      baseRef: 'refs/remotes/origin/main',
      mergeBase: 'a'.repeat(40),
      head: 'b'.repeat(40),
    },
  },
  path: 'src/example.ts',
  range: { side: 'additions', startLine: 1, endLine: 1 },
  quote: {
    source: 'saved-patch',
    lines: [{ lineNumber: 1, kind: 'addition', text: 'const value = 1;\n' }],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function submission(
  destination = 'ses_target',
  messageId = 'message-review'
): WorktreeReviewSubmission {
  return {
    destinationKiloSessionId: destination as KiloSessionId,
    destinationCloudAgentSessionId: 'workspace_target' as CloudAgentSessionId,
    expectedWorktreeId: 'a',
    messageId,
    payload: { type: 'prompt', prompt: 'Exact frozen review', mode: 'code', model: 'model-a' },
  };
}

function savedCapture(revision: number): GetWorktreeChangesOutput {
  return {
    snapshot: {
      schemaVersion: 2,
      revision,
      capturedAt: anchor.capture.capturedAt,
      comparison: anchor.capture.comparison,
      files: [],
      truncated: false,
    },
  };
}

function setup() {
  const store = createWorktreeReviewStore();
  store.setEditor(scope, { anchor, text: 'Please change this.' });
  store.saveEditor(scope, 'comment-a');
  store.setDestination(scope, 'ses_target');
  const frozen = submission();
  const prepared: WorktreeReviewDraft[] = [];
  const configurations: Array<WorktreeReviewConfiguration | undefined> = [];
  const foreground: {
    activeKiloSessionId: string | null;
    activeSessionConfig: SessionConfig | null;
  } = {
    activeKiloSessionId: null,
    activeSessionConfig: null,
  };
  const submitted: WorktreeReviewSubmission[] = [];
  const accepted: Array<{ destination: string; delivery: 'sent' | 'queued' }> = [];
  const callbacks = {
    prepare: async (
      _configuration?: WorktreeReviewConfiguration
    ): Promise<WorktreeReviewResult<WorktreeReviewSubmission>> => ({
      ok: true,
      value: frozen,
    }),
    submit: async (): Promise<WorktreeReviewOutcome> => ({ status: 'accepted', delivery: 'sent' }),
    scopeCurrent: true,
  };
  const send = () =>
    store.send({
      scope,
      ...foreground,
      prepare: (draft, configuration) => {
        prepared.push(draft);
        configurations.push(configuration);
        return callbacks.prepare(configuration);
      },
      submit: batch => {
        submitted.push(batch);
        return callbacks.submit();
      },
      isScopeCurrent: () => callbacks.scopeCurrent,
      onAccepted: (destination, delivery) => {
        accepted.push({ destination, delivery });
      },
    });
  return {
    store,
    frozen,
    prepared,
    configurations,
    foreground,
    submitted,
    accepted,
    callbacks,
    send,
  };
}

describe('review saved capture reads', () => {
  it('keeps late inactive sibling reads behind newer revisions', async () => {
    const context = setup();
    const sibling = 'workspace_inactive_sibling';
    context.store.setEditor(scope, {
      anchor: { ...anchor, capture: { ...anchor.capture, sourceCloudAgentSessionId: sibling } },
      text: 'Review the inactive sibling too',
    });
    context.store.saveEditor(scope, 'comment-b');
    const sources = getWorktreeReviewSourceSessionIds(context.store.getDraft(scope));
    assert.deepEqual(sources, [anchor.capture.sourceCloudAgentSessionId, sibling]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const delayed = deferred<GetWorktreeChangesOutput>();
    const observers = sources.map(
      source =>
        new QueryObserver<GetWorktreeChangesOutput>(client, {
          queryKey: ['getWorktreeChanges', { cloudAgentSessionId: source }],
          enabled: false,
          ...worktreeReviewSavedReadOptions(() =>
            source === sibling ? delayed.promise : Promise.resolve(savedCapture(1))
          ),
        })
    );
    const siblingKey = ['getWorktreeChanges', { cloudAgentSessionId: sibling }];
    client.setQueryData(siblingKey, savedCapture(1));
    const reads = observers.map(observer => observer.refetch());
    context.callbacks.prepare = async () => {
      const latest = await Promise.all(reads);
      const draft = context.store.getDraft(scope);
      const staleCommentIds = draft.comments
        .filter(comment => {
          const source = comment.anchor.capture.sourceCloudAgentSessionId;
          const read = latest[sources.indexOf(source)];
          return (
            getWorktreeReviewFreshness(
              comment,
              read?.isSuccess
                ? currentWorktreeReviewCapture(scope, source, read.data?.snapshot)
                : null
            ) !== 'current'
          );
        })
        .map(comment => comment.id);
      assert.deepEqual(staleCommentIds, ['comment-b']);
      const serialized = serializeWorktreeReview(draft.comments);
      return serialized.ok ? { ok: true, value: context.frozen } : serialized;
    };
    const pendingSend = context.send();
    client.setQueryData(siblingKey, savedCapture(2));
    delayed.resolve(savedCapture(1));
    await pendingSend;
    const latestSibling = await reads[1];
    assert.equal(latestSibling?.data?.snapshot?.revision, 2);
    assert.equal(client.getQueryData<GetWorktreeChangesOutput>(siblingKey)?.snapshot?.revision, 2);
    assert.equal((await reads[0])?.data?.snapshot?.revision, 1);
    assert.equal(context.submitted.length, 1);
    observers.forEach(observer => observer.destroy());
    client.clear();
  });

  for (const unavailable of ['missing', 'failed'] as const) {
    it(`keeps ${unavailable} reads unknown without losing the cached per-source revision`, async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const source = anchor.capture.sourceCloudAgentSessionId;
      const queryKey = ['getWorktreeChanges', { cloudAgentSessionId: source }];
      const observer = new QueryObserver<GetWorktreeChangesOutput>(client, {
        queryKey,
        enabled: false,
        ...worktreeReviewSavedReadOptions(async () => {
          if (unavailable === 'failed') throw new Error('Unavailable');
          return { snapshot: null };
        }),
      });
      client.setQueryData(queryKey, savedCapture(2));
      const result = await observer.refetch();
      assert.equal(
        getWorktreeReviewFreshness(
          anchor.capture,
          result.isSuccess
            ? currentWorktreeReviewCapture(scope, source, result.data?.snapshot)
            : null
        ),
        'unknown'
      );
      assert.equal(result.isSuccess, false);
      assert.equal(result.isError, true);
      assert.equal(client.getQueryData<GetWorktreeChangesOutput>(queryKey)?.snapshot?.revision, 2);
      observer.destroy();
      client.clear();
    });
  }
});

describe('review configuration snapshots', () => {
  const selected = { mode: 'debug', model: 'selected-model', variant: 'high' };

  it('copies only the exact active destination configuration before passive reads and freezes retries', async () => {
    const context = setup();
    const config: SessionConfig = {
      ...selected,
      sessionId: 'workspace_target' as CloudAgentSessionId,
      repository: 'owner/repo',
    };
    context.foreground.activeKiloSessionId = 'ses_target';
    context.foreground.activeSessionConfig = config;
    const freshness = deferred<void>();
    context.callbacks.prepare = async configuration => {
      await freshness.promise;
      assert.deepEqual(configuration, selected);
      assert.ok(Object.isFrozen(configuration));
      return {
        ok: true,
        value: { ...context.frozen, payload: { ...context.frozen.payload, ...configuration } },
      };
    };
    context.callbacks.submit = async () => ({ status: 'unknown', error: 'Lost acknowledgement' });
    const first = context.send();
    assert.deepEqual(context.configurations, [selected]);
    config.mode = 'plan';
    config.model = 'later-model';
    config.variant = 'low';
    context.foreground.activeKiloSessionId = 'ses_other';
    context.foreground.activeSessionConfig = { ...config, model: 'other-chat-model' };
    freshness.resolve();
    await first;
    assert.equal(context.submitted[0]?.payload.model, 'selected-model');
    context.callbacks.submit = async () => ({ status: 'accepted', delivery: 'sent' });
    await context.send();
    assert.equal(context.configurations.length, 1);
    assert.equal(context.submitted[0], context.submitted[1]);
    assert.equal(context.submitted[1]?.payload.variant, 'high');
  });

  it('omits configuration for inactive destinations and missing active models', async () => {
    assert.equal(
      snapshotWorktreeReviewConfiguration('ses_target', 'ses_other', selected),
      undefined
    );
    assert.equal(
      snapshotWorktreeReviewConfiguration('ses_target', 'ses_target', { mode: 'code' }),
      undefined
    );
    assert.equal(
      snapshotWorktreeReviewConfiguration('ses_target', 'ses_target', { mode: 'code', model: '' }),
      undefined
    );
    const context = setup();
    context.foreground.activeKiloSessionId = 'ses_other';
    context.foreground.activeSessionConfig = {
      ...selected,
      sessionId: 'workspace_other' as CloudAgentSessionId,
      repository: 'owner/repo',
    };
    const freshness = deferred<void>();
    context.callbacks.prepare = async configuration => {
      await freshness.promise;
      assert.equal(configuration, undefined);
      return { ok: true, value: context.frozen };
    };
    const first = context.send();
    context.foreground.activeKiloSessionId = 'ses_target';
    freshness.resolve();
    await first;
    assert.deepEqual(context.configurations, [undefined]);
  });

  it('uses runtime-agent model and variant pins with normal send precedence', () => {
    const config = {
      mode: 'reviewer',
      model: 'picker-model',
      variant: 'picker-variant',
      runtimeAgents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          model: ' pinned-model ',
          variant: ' pinned-variant ',
        },
      ],
    };
    assert.deepEqual(snapshotWorktreeReviewConfiguration('ses_target', 'ses_target', config), {
      mode: 'reviewer',
      model: 'pinned-model',
      variant: 'pinned-variant',
    });
    config.runtimeAgents[0].variant = '';
    assert.equal(
      snapshotWorktreeReviewConfiguration('ses_target', 'ses_target', config)?.variant,
      undefined
    );
    config.runtimeAgents[0].model = '';
    config.runtimeAgents[0].variant = 'ignored-unpinned-variant';
    assert.deepEqual(snapshotWorktreeReviewConfiguration('ses_target', 'ses_target', config), {
      mode: 'reviewer',
      model: 'picker-model',
      variant: 'picker-variant',
    });
  });
});

describe('page-owned worktree review state', () => {
  it('tracks an optional overall comment as pending work', () => {
    const { store } = setup();
    assert.equal(hasPendingWorktreeReview(store.getDraft(scope)), true);
    store.removeComment(scope, 'comment-a');
    assert.equal(hasPendingWorktreeReview(store.getDraft(scope)), false);
    store.setOverall(scope, 'Overall direction');
    assert.equal(store.getDraft(scope).overall, 'Overall direction');
    assert.equal(hasPendingWorktreeReview(store.getDraft(scope)), true);
    store.setOverall(scope, '  ');
    assert.equal(hasPendingWorktreeReview(store.getDraft(scope)), false);
  });

  it('discards an idle draft, clears persistence, and refuses locked delivery', async () => {
    const cleared: string[] = [];
    const persistence = {
      load: async () => null,
      save: async () => {},
      clear: async (key: string) => {
        cleared.push(key);
      },
    };
    const store = createWorktreeReviewStore(persistence);
    const key = worktreeReviewScopeKey(scope);
    store.getDraft(scope);
    await flushPromises();
    cleared.length = 0;

    store.setEditor(scope, { anchor, text: 'Discard this draft' });
    store.saveEditor(scope, 'discarded-comment');
    store.setEditor(scope, { anchor, text: 'Unsaved editor' });
    store.setOverall(scope, 'Discard this summary');
    store.setDestination(scope, 'ses_target');
    store.setAllowOlderCapture(scope, true);

    assert.equal(store.discardDraft(scope), true);
    const reset = store.getDraft(scope);
    assert.deepEqual(reset.comments, []);
    assert.equal(reset.editor, null);
    assert.equal(reset.overall, '');
    assert.equal(reset.destinationKiloSessionId, null);
    assert.equal(reset.allowOlderCapture, false);
    assert.deepEqual(cleared, [key]);

    store.setEditor(scope, { anchor, text: 'Lock this draft' });
    store.saveEditor(scope, 'locked-comment');
    store.setDestination(scope, 'ses_target');
    const preparation = deferred<WorktreeReviewResult<WorktreeReviewSubmission>>();
    const sending = store.send({
      scope,
      prepare: async () => preparation.promise,
      submit: async () => ({ status: 'accepted', delivery: 'sent' }),
      isScopeCurrent: () => true,
      onAccepted: () => {},
    });
    await Promise.resolve();
    assert.notEqual(store.getDraft(scope).delivery.phase, 'idle');
    assert.equal(store.discardDraft(scope), false);
    preparation.resolve({ ok: false, error: 'Preparation stopped' });
    await sending;
  });

  it('restores comments and editors after hydration while overlaying local fields', async () => {
    const loading = deferred<PersistedWorktreeReviewDraft | null>();
    const saves: Array<{ key: string; value: PersistedWorktreeReviewDraft }> = [];
    const persistence = {
      load: () => loading.promise,
      save: (key: string, value: PersistedWorktreeReviewDraft) => {
        saves.push({ key, value });
      },
      clear: async () => {},
    };
    const store = createWorktreeReviewStore(persistence);
    store.setDestination(scope, 'local-destination');
    store.setOverall(scope, 'Local overall');
    assert.equal(store.getHydration(worktreeReviewScopeKey(scope)), 'pending');
    assert.equal(store.setEditor(scope, { anchor, text: 'Local editor' }), false);
    assert.equal(store.saveEditor(scope, 'pending-comment'), false);
    assert.equal(store.removeComment(scope, 'restored'), false);
    assert.equal(store.getDraft(scope).editor, null);
    assert.equal(saves.length, 0);

    const restored: PersistedWorktreeReviewDraft = {
      version: 1,
      comments: [{ id: 'restored', anchor, text: 'Restored comment' }],
      editor: { anchor, text: 'Restored editor' },
      overall: 'Restored overall',
      destinationKiloSessionId: 'restored-destination',
      allowOlderCapture: true,
    };
    loading.resolve(restored);
    await flushPromises();
    assert.equal(store.getHydration(worktreeReviewScopeKey(scope)), 'ready');
    assert.deepEqual(store.getDraft(scope).comments, restored.comments);
    assert.equal(store.getDraft(scope).editor?.text, 'Restored editor');
    assert.equal(store.getDraft(scope).destinationKiloSessionId, 'local-destination');
    assert.equal(store.getDraft(scope).overall, 'Local overall');
    assert.equal(store.getDraft(scope).allowOlderCapture, true);
    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.key, worktreeReviewScopeKey(scope));
    assert.equal(Object.hasOwn(saves[0]?.value ?? {}, 'delivery'), false);
  });

  it('keeps restored fields when pending local overlays are empty', async () => {
    const loading = deferred<PersistedWorktreeReviewDraft | null>();
    const persistence = {
      load: () => loading.promise,
      save: async () => {},
      clear: async () => {},
    };
    const store = createWorktreeReviewStore(persistence);
    store.getDraft(scope);
    store.setDestination(scope, null);
    store.setOverall(scope, ' \n\t ');

    loading.resolve({
      version: 1,
      comments: [{ id: 'restored', anchor, text: 'Restored comment' }],
      editor: null,
      overall: 'Restored overall',
      destinationKiloSessionId: 'restored-destination',
      allowOlderCapture: false,
    });
    await flushPromises();

    assert.equal(store.getDraft(scope).destinationKiloSessionId, 'restored-destination');
    assert.equal(store.getDraft(scope).overall, 'Restored overall');
  });

  it('settles an empty database and enables authoring without opening Review', async () => {
    let loads = 0;
    const persistence = {
      load: async () => {
        loads += 1;
        return null;
      },
      save: async () => {},
      clear: async () => {},
    };
    const store = createWorktreeReviewStore(persistence);
    const key = worktreeReviewScopeKey(scope);
    store.getDraft(scope);
    assert.equal(loads, 1);
    assert.equal(store.getHydration(key), 'pending');
    await flushPromises();
    assert.equal(store.getHydration(key), 'ready');
    assert.equal(store.setEditor(scope, { anchor, text: 'Authoring works' }), true);
    assert.equal(store.getDraft(scope).editor?.text, 'Authoring works');
  });

  it('enables authoring after hydration fails and keeps the in-memory draft', async () => {
    const persistence = {
      load: async () => {
        throw new Error('IndexedDB unavailable');
      },
      save: async () => {},
      clear: async () => {},
    };
    const store = createWorktreeReviewStore(persistence);
    store.getDraft(scope);
    await flushPromises();
    assert.equal(store.getHydration(worktreeReviewScopeKey(scope)), 'failed');
    assert.equal(store.setEditor(scope, { anchor, text: 'In memory' }), true);
    assert.equal(store.getDraft(scope).editor?.text, 'In memory');
  });

  it('resets an accepted review when persistence clear rejects', async () => {
    const persistence = {
      load: async () => null,
      save: async () => {},
      clear: async () => {
        throw new Error('IndexedDB unavailable');
      },
    };
    const store = createWorktreeReviewStore(persistence);
    store.getDraft(scope);
    await flushPromises();
    store.setEditor(scope, { anchor, text: 'Send this' });
    store.saveEditor(scope, 'sent-comment');
    store.setDestination(scope, 'ses_target');
    const accepted: string[] = [];
    const result = await store.send({
      scope,
      prepare: async () => ({ ok: true, value: submission() }),
      submit: async () => ({ status: 'accepted', delivery: 'sent' }),
      isScopeCurrent: () => true,
      onAccepted: destination => accepted.push(destination),
    });
    assert.deepEqual(result, { status: 'accepted', delivery: 'sent' });
    assert.deepEqual(accepted, ['ses_target']);
    assert.equal(store.getDraft(scope).comments.length, 0);
  });

  it('completes an accepted review when persistence clear hangs', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const persistence = {
        load: async () => null,
        save: async () => {},
        clear: async () => await new Promise<void>(() => {}),
      };
      const store = createWorktreeReviewStore(persistence);
      store.getDraft(scope);
      await flushPromises();
      store.setEditor(scope, { anchor, text: 'Send this' });
      store.saveEditor(scope, 'sent-comment');
      store.setDestination(scope, 'ses_target');
      const accepted: string[] = [];
      const resultPromise = store.send({
        scope,
        prepare: async () => ({ ok: true, value: submission() }),
        submit: async () => ({ status: 'accepted', delivery: 'sent' }),
        isScopeCurrent: () => true,
        onAccepted: destination => accepted.push(destination),
      });
      await flushPromises();
      t.mock.timers.tick(WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS);
      const result = await resultPromise;
      assert.deepEqual(result, { status: 'accepted', delivery: 'sent' });
      assert.deepEqual(accepted, ['ses_target']);
      assert.equal(store.getDraft(scope).comments.length, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('persists configuration-only fields and restores them in a new store', async () => {
    const stored = new Map<string, PersistedWorktreeReviewDraft>();
    const persistence = {
      load: async (key: string) => stored.get(key) ?? null,
      save: (key: string, value: PersistedWorktreeReviewDraft) => {
        stored.set(key, value);
      },
      clear: async (key: string) => {
        stored.delete(key);
      },
    };
    const key = worktreeReviewScopeKey(scope);
    const first = createWorktreeReviewStore(persistence);
    first.getDraft(scope);
    await flushPromises();
    first.setDestination(scope, 'destination-only');
    first.setAllowOlderCapture(scope, true);
    assert.equal(stored.get(key)?.comments.length, 0);
    assert.equal(stored.get(key)?.destinationKiloSessionId, 'destination-only');
    assert.equal(stored.get(key)?.allowOlderCapture, true);

    const second = createWorktreeReviewStore(persistence);
    second.getDraft(scope);
    await flushPromises();
    assert.equal(second.getDraft(scope).destinationKiloSessionId, 'destination-only');
    assert.equal(second.getDraft(scope).allowOlderCapture, true);
    assert.equal(second.getDraft(scope).comments.length, 0);
    assert.equal(second.getDraft(scope).editor, null);
    assert.equal(second.getDraft(scope).overall, '');
  });

  it('isolates account, organization, and worktree drafts while retaining edits', () => {
    const { store } = setup();
    const scopes = [
      { ...scope, userId: 'user-b' },
      { ...scope, organizationId: 'org-a' },
      { ...scope, workspaceScope: 'worktree:b' },
    ];
    store.setEditor(scope, { anchor, text: 'Unsaved across tabs' });
    for (const other of scopes) {
      assert.notEqual(worktreeReviewScopeKey(other), worktreeReviewScopeKey(scope));
      assert.equal(hasPendingWorktreeReview(store.getDraft(other)), false);
      store.setEditor(other, {
        anchor: { ...anchor, capture: { ...anchor.capture, ...other } },
        text: 'Other draft',
      });
    }
    assert.equal(store.getDraft(scope).editor?.text, 'Unsaved across tabs');
    assert.equal(store.getDraft(scope).comments.length, 1);
    assert.equal(store.getSnapshot().size, 4);
  });

  it('does not let a file or sibling selection replace an unsaved editor', () => {
    const { store } = setup();
    store.setEditor(scope, { anchor, text: 'Keep me' });
    store.setEditor(scope, { anchor: { ...anchor, path: 'other.ts' }, text: '' });
    assert.equal(store.getDraft(scope).editor?.text, 'Keep me');
    assert.match(store.getDraft(scope).error ?? '', /Save or discard/);
    store.setEditor(scope, null);
    store.setEditor(scope, { anchor: { ...anchor, path: 'other.ts' }, text: 'Now replace' });
    assert.equal(store.getDraft(scope).editor?.anchor.path, 'other.ts');
  });

  it('rejects cross-scope editors and keeps invalid feedback for correction', () => {
    const { store } = setup();
    store.setEditor(scope, {
      anchor: { ...anchor, capture: { ...anchor.capture, userId: 'other' } },
      text: 'Wrong scope',
    });
    assert.equal(store.getDraft(scope).editor, null);
    store.setEditor(scope, { anchor, text: ' ' });
    store.saveEditor(scope, 'comment-b');
    assert.equal(store.getDraft(scope).editor?.text, ' ');
    assert.equal(store.getDraft(scope).comments.length, 1);
    assert.ok(store.getDraft(scope).error);
  });

  it('edits text without reanchoring and removes only the selected comment', () => {
    const { store } = setup();
    store.setEditor(scope, { commentId: 'comment-a', anchor, text: 'Updated feedback' });
    store.saveEditor(scope, 'ignored');
    assert.deepEqual(store.getDraft(scope).comments[0], {
      id: 'comment-a',
      anchor,
      text: 'Updated feedback',
    });
    store.setEditor(scope, { anchor: { ...anchor, path: 'second.ts' }, text: 'Second file' });
    store.saveEditor(scope, 'comment-b');
    store.removeComment(scope, 'comment-a');
    assert.deepEqual(
      store.getDraft(scope).comments.map(comment => comment.id),
      ['comment-b']
    );
  });

  it('requires a saved editor before starting a batch', async () => {
    const context = setup();
    context.store.setEditor(scope, { anchor, text: 'Not saved' });
    await context.send();
    assert.equal(context.prepared.length, 0);
    assert.equal(context.submitted.length, 0);
    assert.equal(context.store.getDraft(scope).editor?.text, 'Not saved');
  });

  for (const delivery of ['sent', 'queued'] as const) {
    it(`clears only the accepted batch on ${delivery} acknowledgement`, async () => {
      const context = setup();
      const other = { ...scope, workspaceScope: 'worktree:b' };
      context.store.setEditor(other, {
        anchor: { ...anchor, capture: { ...anchor.capture, ...other } },
        text: 'Other worktree',
      });
      context.callbacks.submit = async () => ({ status: 'accepted', delivery });
      await context.send();
      assert.equal(hasPendingWorktreeReview(context.store.getDraft(scope)), false);
      assert.equal(context.store.getDraft(other).editor?.text, 'Other worktree');
      assert.deepEqual(context.accepted, [{ destination: 'ses_target', delivery }]);
    });
  }

  it('locks synchronously against double clicks and changed active targets during preparation and sending', async () => {
    const context = setup();
    const prepared = deferred<WorktreeReviewResult<WorktreeReviewSubmission>>();
    const outcome = deferred<WorktreeReviewOutcome>();
    context.callbacks.prepare = () => prepared.promise;
    context.callbacks.submit = () => outcome.promise;
    const first = context.send();
    await context.send();
    context.store.removeComment(scope, 'comment-a');
    context.store.setDestination(scope, 'ses_changed');
    context.store.setEditor(scope, { anchor, text: 'Do not replace' });
    assert.equal(context.store.getDraft(scope).comments.length, 1);
    assert.equal(context.store.getDraft(scope).destinationKiloSessionId, 'ses_target');
    assert.equal(context.store.getDraft(scope).editor, null);
    assert.equal(context.prepared.length, 1);
    prepared.resolve({ ok: true, value: context.frozen });
    await Promise.resolve();
    await context.send();
    assert.equal(context.submitted.length, 1);
    outcome.resolve({ status: 'accepted', delivery: 'sent' });
    await first;
    assert.deepEqual(context.accepted, [{ destination: 'ses_target', delivery: 'sent' }]);
  });

  it('keeps rejected drafts editable and does not navigate', async () => {
    const context = setup();
    context.callbacks.submit = async () => ({
      status: 'rejected',
      error: 'Destination unavailable',
    });
    await context.send();
    assert.equal(context.store.getDraft(scope).comments.length, 1);
    assert.equal(context.store.getDraft(scope).delivery.phase, 'idle');
    assert.equal(context.store.getDraft(scope).error, 'Destination unavailable');
    assert.equal(context.accepted.length, 0);
    context.store.setDestination(scope, 'ses_other');
    assert.equal(context.store.getDraft(scope).destinationKiloSessionId, 'ses_other');
  });

  it('retains the same payload, target, and ID for unknown retries without refreshing or preparing again', async () => {
    const context = setup();
    context.callbacks.submit = async () => ({ status: 'unknown', error: 'Lost acknowledgement' });
    await context.send();
    assert.equal(context.store.getDraft(scope).delivery.phase, 'unknown');
    context.store.removeComment(scope, 'comment-a');
    context.store.setDestination(scope, 'ses_changed');
    context.store.setAllowOlderCapture(scope, true);
    assert.equal(context.store.getDraft(scope).comments.length, 1);
    assert.equal(context.store.getDraft(scope).allowOlderCapture, false);
    context.callbacks.submit = async () => ({ status: 'accepted', delivery: 'queued' });
    await context.send();
    assert.equal(context.prepared.length, 1);
    assert.equal(context.submitted[0], context.frozen);
    assert.equal(context.submitted[1], context.frozen);
    assert.deepEqual(context.accepted, [{ destination: 'ses_target', delivery: 'queued' }]);
  });

  it('treats unexpected send exceptions as unresolved instead of unlocking', async () => {
    const context = setup();
    context.callbacks.submit = async () => {
      throw new Error('Network failed');
    };
    await context.send();
    assert.equal(context.store.getDraft(scope).delivery.phase, 'unknown');
    assert.equal(context.store.removeComment(scope, 'comment-a'), false);
  });

  it('keeps feedback when passive checks or destination preparation fail', async () => {
    const context = setup();
    context.callbacks.prepare = async () => {
      throw new Error('Access denied');
    };
    await context.send();
    assert.equal(context.store.getDraft(scope).delivery.phase, 'idle');
    assert.equal(context.store.getDraft(scope).comments.length, 1);
    assert.equal(context.submitted.length, 0);
  });

  it('keeps feedback and returns the freshness confirmation failure without sending', async () => {
    const context = setup();
    context.callbacks.prepare = async () => ({ ok: false, error: 'Confirm older feedback' });
    await context.send();
    assert.equal(context.store.getDraft(scope).delivery.phase, 'idle');
    assert.equal(context.store.getDraft(scope).comments.length, 1);
    assert.equal(context.store.getDraft(scope).error, 'Confirm older feedback');
    assert.equal(context.submitted.length, 0);
  });

  it('does not dispatch if the account changes during preparation', async () => {
    const context = setup();
    const prepared = deferred<WorktreeReviewResult<WorktreeReviewSubmission>>();
    context.callbacks.prepare = () => prepared.promise;
    const first = context.send();
    context.callbacks.scopeCurrent = false;
    prepared.resolve({ ok: true, value: context.frozen });
    await first;
    assert.equal(context.submitted.length, 0);
    assert.equal(context.store.getDraft(scope).comments.length, 1);
  });

  it('does not navigate a newly selected account on late acceptance', async () => {
    const context = setup();
    const outcome = deferred<WorktreeReviewOutcome>();
    context.callbacks.submit = () => outcome.promise;
    const first = context.send();
    await Promise.resolve();
    context.callbacks.scopeCurrent = false;
    outcome.resolve({ status: 'accepted', delivery: 'sent' });
    await first;
    assert.equal(context.accepted.length, 0);
    assert.equal(context.store.getDraft(scope).comments.length, 0);
  });
});
