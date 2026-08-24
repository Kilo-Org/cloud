/* eslint-disable max-lines -- one file for the save/toggle serialization and generation-guard rollback suites */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ConfigPatch, PERSONAL_SCOPE } from '@/lib/code-reviewer-config';

import { useSaveReviewConfig, useToggleReviewer } from './use-code-reviewer';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars?: unknown, context?: unknown) => void;
  onSettled?: () => void;
  onSuccess?: (data: unknown) => void;
  scope?: { id: string };
};

type PersonalPatch = {
  platform: string;
  reviewStyle?: string;
  focusAreas?: string[];
  customInstructions?: string;
  modelSlug?: string;
  thinkingEffort?: string | null;
  gateThreshold?: string;
  repositorySelectionMode?: string;
  selectedRepositoryIds?: (number | string)[];
  repositoryModelOverrides?: {
    repositoryId: number | string;
    repoFullName: string;
    modelSlug: string;
    thinkingEffort?: string | null;
  }[];
  disableReviewMd?: boolean;
  autoConfigureWebhooks?: boolean;
};

type OrgPatch = PersonalPatch & { organizationId: string };

const personalPatchMutateMock = vi.fn();
const orgPatchMutateMock = vi.fn();
const personalSaveMutateMock = vi.fn();
const orgSaveMutateMock = vi.fn();
const personalToggleMutateMock = vi.fn();
const orgToggleMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const toastErrorMock = vi.fn();

let lastCapturedOptions: MutationOptions | null = null;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn() };
  },
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    cancelQueries: cancelQueriesMock,
    getQueryData: getQueryDataMock,
    setQueryData: setQueryDataMock,
    invalidateQueries: invalidateQueriesMock,
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    personalReviewAgent: {
      getReviewConfig: { queryKey: () => ['personalReviewAgent', 'getReviewConfig'] },
    },
    organizations: {
      reviewAgent: {
        getReviewConfig: { queryKey: () => ['organizations', 'reviewAgent', 'getReviewConfig'] },
      },
    },
  }),
  trpcClient: {
    personalReviewAgent: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      patchReviewConfig: { mutate: (vars: unknown) => personalPatchMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      saveReviewConfig: { mutate: (vars: unknown) => personalSaveMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      toggleReviewAgent: { mutate: (vars: unknown) => personalToggleMutateMock(vars) },
    },
    organizations: {
      reviewAgent: {
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        patchReviewConfig: { mutate: (vars: unknown) => orgPatchMutateMock(vars) },
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        saveReviewConfig: { mutate: (vars: unknown) => orgSaveMutateMock(vars) },
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        toggleReviewAgent: { mutate: (vars: unknown) => orgToggleMutateMock(vars) },
      },
    },
  },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: (msg: string) => toastErrorMock(msg) },
}));

// use-code-reviewer.ts re-exports from use-reviewer-permission, which
// imports `useRouter` from expo-router. Loading the real module in node
// blows up on the expo-router source map, so stub just the surface the
// re-export's transitive imports actually reach.
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

function getSaveOptions(
  scope: string,
  platform: 'github' | 'gitlab' | 'bitbucket'
): MutationOptions {
  lastCapturedOptions = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useSaveReviewConfig(scope, platform);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options for useSaveReviewConfig were not captured');
  }
  return lastCapturedOptions;
}

function getToggleOptions(
  scope: string,
  platform: 'github' | 'gitlab' | 'bitbucket'
): MutationOptions {
  lastCapturedOptions = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useToggleReviewer(scope, platform);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options for useToggleReviewer were not captured');
  }
  return lastCapturedOptions;
}

beforeEach(() => {
  lastCapturedOptions = null;
  personalPatchMutateMock.mockReset();
  orgPatchMutateMock.mockReset();
  personalSaveMutateMock.mockReset();
  orgSaveMutateMock.mockReset();
  personalToggleMutateMock.mockReset();
  orgToggleMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  getQueryDataMock.mockReset();
  setQueryDataMock.mockReset();
  toastErrorMock.mockReset();
  // Default: each patch mutate resolves to a successful payload. Tests
  // override per-case when they need a different outcome.
  personalPatchMutateMock.mockResolvedValue({ success: true, webhookSync: null });
  orgPatchMutateMock.mockResolvedValue({ success: true, webhookSync: null });
  personalToggleMutateMock.mockResolvedValue({ success: true });
  orgToggleMutateMock.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSaveReviewConfig mutationFn payload shape', () => {
  it('sends ONLY edited fields + platform for a personal github patch (NOT a full document)', async () => {
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    const patch: ConfigPatch = { reviewStyle: 'strict' };
    await opts.mutationFn?.(patch);

    expect(personalPatchMutateMock).toHaveBeenCalledTimes(1);
    const sent = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    // Platform is always present.
    expect(sent.platform).toBe('github');
    // Only the edited key reaches the wire — every other mobile-editable
    // field must be absent. (A full-doc save would carry all of these.)
    expect(sent).toEqual({ platform: 'github', reviewStyle: 'strict' });
    // Explicit negative assertions, since `toEqual` would pass for a
    // full-doc payload that happens to also include the same keys.
    expect(sent).not.toHaveProperty('focusAreas');
    expect(sent).not.toHaveProperty('customInstructions');
    expect(sent).not.toHaveProperty('modelSlug');
    expect(sent).not.toHaveProperty('thinkingEffort');
    expect(sent).not.toHaveProperty('gateThreshold');
    expect(sent).not.toHaveProperty('repositorySelectionMode');
    expect(sent).not.toHaveProperty('selectedRepositoryIds');
    expect(sent).not.toHaveProperty('repositoryModelOverrides');
    expect(sent).not.toHaveProperty('disableReviewMd');
    expect(sent).not.toHaveProperty('autoConfigureWebhooks');
    // And the route family must be the PATCH, not the legacy save.
    expect(personalSaveMutateMock).not.toHaveBeenCalled();
  });

  it('sends ONLY edited fields for a personal github multi-field patch', async () => {
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    const patch: ConfigPatch = {
      reviewStyle: 'lenient',
      focusAreas: ['security', 'performance'],
      modelSlug: 'openai/gpt-5',
    };
    await opts.mutationFn?.(patch);

    expect(personalPatchMutateMock).toHaveBeenCalledTimes(1);
    const sent = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    expect(sent).toEqual({
      platform: 'github',
      reviewStyle: 'lenient',
      focusAreas: ['security', 'performance'],
      modelSlug: 'openai/gpt-5',
    });
    expect(sent).not.toHaveProperty('customInstructions');
    expect(sent).not.toHaveProperty('thinkingEffort');
    expect(sent).not.toHaveProperty('gateThreshold');
    expect(sent).not.toHaveProperty('repositorySelectionMode');
    expect(sent).not.toHaveProperty('selectedRepositoryIds');
    expect(sent).not.toHaveProperty('repositoryModelOverrides');
    expect(sent).not.toHaveProperty('disableReviewMd');
    expect(sent).not.toHaveProperty('autoConfigureWebhooks');
  });

  it('narrow personal selectedRepositoryIds / repositoryModelOverrides to numeric ids and does not include them when absent from the patch', async () => {
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    // Patch carries both keys with mixed string/number ids (a defensive
    // shape — the production UI only sends numbers, but the type permits
    // strings). The personal schema rejects strings, so they must be
    // filtered out before going on the wire.
    const patch = {
      reviewStyle: 'strict' as const,
      selectedRepositoryIds: [101, 'bitbucket-uuid', 202] as (number | string)[],
      repositoryModelOverrides: [
        { repositoryId: 101, repoFullName: 'a/a', modelSlug: 'm', thinkingEffort: null },
        {
          repositoryId: 'bitbucket-uuid',
          repoFullName: 'b/b',
          modelSlug: 'm',
          thinkingEffort: null,
        },
      ],
    };
    await opts.mutationFn?.(patch);

    const sent = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    expect(sent.platform).toBe('github');
    expect(sent.reviewStyle).toBe('strict');
    expect(sent.selectedRepositoryIds).toEqual([101, 202]);
    expect(sent.repositoryModelOverrides).toEqual([
      { repositoryId: 101, repoFullName: 'a/a', modelSlug: 'm', thinkingEffort: null },
    ]);
  });

  it('does not inject selectedRepositoryIds / repositoryModelOverrides when the patch omits them', async () => {
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    await opts.mutationFn?.({ focusAreas: ['security'] });

    const sent = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    expect(sent).toEqual({ platform: 'github', focusAreas: ['security'] });
    // An empty array would still be a real edit that could clobber stored
    // values — the hook must not silently synthesize one.
    expect(sent).not.toHaveProperty('selectedRepositoryIds');
    expect(sent).not.toHaveProperty('repositoryModelOverrides');
  });

  it('includes autoConfigureWebhooks on a GitLab personal patch only when selectedRepositoryIds is present', async () => {
    const opts = getSaveOptions(PERSONAL_SCOPE, 'gitlab');

    // Repo-selection edit: webhook re-sync must run server-side.
    await opts.mutationFn?.({ selectedRepositoryIds: [101] });
    const sentSelection = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    expect(sentSelection).toEqual({
      platform: 'gitlab',
      selectedRepositoryIds: [101],
      autoConfigureWebhooks: true,
    });

    // Unrelated edit: webhook re-sync must NOT run server-side (gated on
    // selectedRepositoryIds being present in the patch).
    personalPatchMutateMock.mockClear();
    await opts.mutationFn?.({ focusAreas: ['security'] });
    const sentUnrelated = personalPatchMutateMock.mock.calls[0]?.[0] as PersonalPatch;
    expect(sentUnrelated).toEqual({ platform: 'gitlab', focusAreas: ['security'] });
    expect(sentUnrelated).not.toHaveProperty('autoConfigureWebhooks');
  });

  it('sends ONLY edited fields + organizationId + platform for an org github patch', async () => {
    const opts = getSaveOptions('org_42', 'github');

    const patch: ConfigPatch = { gateThreshold: 'critical' };
    await opts.mutationFn?.(patch);

    expect(orgPatchMutateMock).toHaveBeenCalledTimes(1);
    const sent = orgPatchMutateMock.mock.calls[0]?.[0] as OrgPatch;
    expect(sent).toEqual({
      organizationId: 'org_42',
      platform: 'github',
      gateThreshold: 'critical',
    });
    expect(sent).not.toHaveProperty('reviewStyle');
    expect(sent).not.toHaveProperty('focusAreas');
    expect(sent).not.toHaveProperty('selectedRepositoryIds');
    expect(sent).not.toHaveProperty('repositoryModelOverrides');
    expect(sent).not.toHaveProperty('autoConfigureWebhooks');
    expect(personalPatchMutateMock).not.toHaveBeenCalled();
    expect(personalSaveMutateMock).not.toHaveBeenCalled();
    expect(orgSaveMutateMock).not.toHaveBeenCalled();
  });

  it('does NOT narrow string-id repository overrides for the org path (org schema accepts both)', async () => {
    const opts = getSaveOptions('org_42', 'bitbucket');

    const patch: ConfigPatch = {
      selectedRepositoryIds: ['bitbucket-uuid-1', 'bitbucket-uuid-2'],
      repositoryModelOverrides: [
        { repositoryId: 'bitbucket-uuid-1', repoFullName: 'a/a', modelSlug: 'm' },
      ],
    };
    await opts.mutationFn?.(patch);

    const sent = orgPatchMutateMock.mock.calls[0]?.[0] as OrgPatch;
    // String ids are preserved end-to-end on the org route.
    expect(sent.selectedRepositoryIds).toEqual(['bitbucket-uuid-1', 'bitbucket-uuid-2']);
    expect(sent.repositoryModelOverrides).toEqual([
      { repositoryId: 'bitbucket-uuid-1', repoFullName: 'a/a', modelSlug: 'm' },
    ]);
  });

  it('includes autoConfigureWebhooks on a GitLab org patch only when selectedRepositoryIds is present', async () => {
    const opts = getSaveOptions('org_42', 'gitlab');

    await opts.mutationFn?.({ selectedRepositoryIds: [202, 303] });
    const sentSelection = orgPatchMutateMock.mock.calls[0]?.[0] as OrgPatch;
    expect(sentSelection).toEqual({
      organizationId: 'org_42',
      platform: 'gitlab',
      selectedRepositoryIds: [202, 303],
      autoConfigureWebhooks: true,
    });

    orgPatchMutateMock.mockClear();
    await opts.mutationFn?.({ focusAreas: ['security'] });
    const sentUnrelated = orgPatchMutateMock.mock.calls[0]?.[0] as OrgPatch;
    expect(sentUnrelated).toEqual({
      organizationId: 'org_42',
      platform: 'gitlab',
      focusAreas: ['security'],
    });
    expect(sentUnrelated).not.toHaveProperty('autoConfigureWebhooks');
  });
});

describe('useSaveReviewConfig onError', () => {
  it('toasts the thrown error message and does not call invalidateQueries from onError', async () => {
    personalPatchMutateMock.mockReset();
    personalPatchMutateMock.mockResolvedValue({
      success: false,
      webhookSync: null,
    });
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({ reviewStyle: 'strict' });
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Failed to save review config');
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to save review config');
    // onSettled is the only place invalidateQueries should fire; onError
    // must not also invalidate (would clobber a follow-up optimistic save).
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('propagates a transport-level rejection from patchReviewConfig verbatim and still toasts it', async () => {
    personalPatchMutateMock.mockReset();
    personalPatchMutateMock.mockRejectedValue(new Error('Network unreachable'));
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({ reviewStyle: 'strict' });
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect((thrown as Error).message).toBe('Network unreachable');
    expect(toastErrorMock).toHaveBeenCalledWith('Network unreachable');
  });
});

describe('useSaveReviewConfig (generation guard)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('a failing older save does not roll back while a newer save owns the config', async () => {
    getQueryDataMock.mockReturnValue({ reviewStyle: 'lenient' });
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');
    const older = await opts.onMutate?.({ reviewStyle: 'strict' });
    const newer = await opts.onMutate?.({ reviewStyle: 'lenient' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { reviewStyle: 'strict' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    opts.onError?.(new Error('boom'), { reviewStyle: 'lenient' }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest save rolls back its snapshot and toasts', async () => {
    getQueryDataMock.mockReturnValue({ reviewStyle: 'lenient' });
    const opts = getSaveOptions(PERSONAL_SCOPE, 'github');
    const context = await opts.onMutate?.({ reviewStyle: 'strict' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { reviewStyle: 'strict' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('useToggleReviewer (generation guard + chain join)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
    personalToggleMutateMock.mockReset();
    personalToggleMutateMock.mockResolvedValue({ success: true });
  });

  it('joins the save chain key (rule 1) and adds no scope.id', async () => {
    const opts = getToggleOptions(PERSONAL_SCOPE, 'github');
    await opts.mutationFn?.({ isEnabled: true });
    expect(personalToggleMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'github', isEnabled: true })
    );
    expect(opts.scope).toBeUndefined();
  });

  it('serializes the toggle behind an in-flight save on the same chain key', async () => {
    const saveOpts = getSaveOptions(PERSONAL_SCOPE, 'github');
    const toggleOpts = getToggleOptions(PERSONAL_SCOPE, 'github');

    const saveGate = Promise.withResolvers<unknown>();
    personalPatchMutateMock.mockReset();
    personalPatchMutateMock.mockReturnValueOnce(saveGate.promise);
    personalToggleMutateMock.mockResolvedValue({ success: true });

    const savePromise = saveOpts.mutationFn?.({ reviewStyle: 'strict' });
    const togglePromise = toggleOpts.mutationFn?.({ isEnabled: true });

    await Promise.resolve();
    await Promise.resolve();
    // The toggle's network call must not start while the save is in flight.
    expect(personalToggleMutateMock).not.toHaveBeenCalled();

    saveGate.resolve({ success: true, webhookSync: null });
    await Promise.all([savePromise, togglePromise]);
    expect(personalToggleMutateMock).toHaveBeenCalledTimes(1);
  });

  it('a failing older toggle does not roll back while a newer toggle owns the config', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false });
    const opts = getToggleOptions(PERSONAL_SCOPE, 'github');
    const older = await opts.onMutate?.({ isEnabled: true });
    const newer = await opts.onMutate?.({ isEnabled: false });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { isEnabled: true }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    opts.onError?.(new Error('boom'), { isEnabled: false }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest toggle rolls back its snapshot and toasts', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false });
    const opts = getToggleOptions(PERSONAL_SCOPE, 'github');
    const context = await opts.onMutate?.({ isEnabled: true });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { isEnabled: true }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});
