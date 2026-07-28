import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  applyRetryMutationSuccess,
  applySaveMutationError,
  applySaveMutationSuccess,
  buildRetryBody,
  buildSaveBody,
  emptyPoolCopy,
  formatLoadErrorMessage,
  formatSaveErrorMessage,
  hasBenchmarkingEntries,
  isDirectByokOnlyModel,
  isDraftDirty,
  isEligiblePoolModel,
  isExperimentSelectorModel,
  mapPoolEntryDisplayStatus,
  NOT_SAVED_ENTRY_LABEL,
  ORGANIZATION_EMPTY_POOL_COPY,
  PERSONAL_EMPTY_POOL_COPY,
  removePoolEntry,
  resolveEditableChrome,
  resolveEffectiveDraft,
  settingsEndpoint,
  settingsQueryKey,
  settingsRefetchInterval,
  SETTINGS_POLL_INTERVAL_MS,
  shouldShowClearPoolControl,
  toEligibleModelOptions,
  tryAddPoolEntry,
  UNAVAILABLE_ENTRY_EXPLANATION,
  variantLabel,
  type AutoRoutingSettingsApiResponse,
  type DraftPool,
  type PoolEntryWithAvailability,
} from './AutoRoutingModeCard';
import type { BenchmarkProfileEntryStatus, PoolEntry } from '@kilocode/auto-routing-contracts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const entryReady: PoolEntry = { model: 'anthropic/claude-sonnet-4', variant: 'high' };
const entryFailed: PoolEntry = { model: 'google/gemini-2.5-flash', variant: null };
const entryPending: PoolEntry = { model: 'openai/gpt-5', variant: 'xhigh' };
const entryUnavailable: PoolEntry = { model: 'removed/model', variant: null };
const entryDraftOnly: PoolEntry = { model: 'meta-llama/llama-4', variant: null };

const statuses: BenchmarkProfileEntryStatus[] = [
  { entry: entryReady, status: 'ready' },
  {
    entry: entryFailed,
    status: 'failed',
    failureReason: 'Benchmark container exited with code 1',
  },
  { entry: entryPending, status: 'pending' },
  { entry: entryUnavailable, status: 'ready' },
];

function settings(
  overrides: Partial<AutoRoutingSettingsApiResponse> = {}
): AutoRoutingSettingsApiResponse {
  return {
    ownerType: 'user',
    ownerId: 'user-1',
    mode: 'cost_per_accuracy',
    configuredMode: null,
    defaultMode: 'cost_per_accuracy',
    configuredPool: null,
    poolStatuses: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Endpoint / query key
// ---------------------------------------------------------------------------

describe('settings endpoint and query key', () => {
  it('uses the settings route and never the legacy mode route', () => {
    expect(settingsEndpoint(undefined)).toBe('/api/auto-routing/settings');
    expect(settingsEndpoint('org-1')).toBe('/api/auto-routing/settings?organizationId=org-1');
    expect(settingsEndpoint(undefined)).not.toContain('/mode');
    expect(settingsQueryKey(undefined)).toEqual(['auto-routing-settings', 'personal']);
    expect(settingsQueryKey('org-9')).toEqual(['auto-routing-settings', 'org-9']);
  });
});

// ---------------------------------------------------------------------------
// Empty state copy (exact strings from the card module)
// ---------------------------------------------------------------------------

describe('empty / inherited pool copy', () => {
  it('uses the exact personal empty string', () => {
    expect(PERSONAL_EMPTY_POOL_COPY).toBe(
      'No custom pool. Efficient uses the platform model pool.'
    );
    expect(emptyPoolCopy(undefined)).toBe(PERSONAL_EMPTY_POOL_COPY);
  });

  it('uses the exact organization empty string and never implies a merged member pool', () => {
    expect(ORGANIZATION_EMPTY_POOL_COPY).toBe(
      'No organization override. Members use their personal pool, or the platform model pool if they have none.'
    );
    expect(emptyPoolCopy('org-1')).toBe(ORGANIZATION_EMPTY_POOL_COPY);
    expect(ORGANIZATION_EMPTY_POOL_COPY.toLowerCase()).not.toContain('organization owns');
    expect(ORGANIZATION_EMPTY_POOL_COPY.toLowerCase()).not.toContain('merged');
  });
});

// ---------------------------------------------------------------------------
// Status mapping (real helper used by the card rows)
// ---------------------------------------------------------------------------

describe('mapPoolEntryDisplayStatus', () => {
  it('maps ready, pending/running, failed, and unavailable exactly', () => {
    expect(mapPoolEntryDisplayStatus({ entry: entryReady, poolStatuses: statuses })).toEqual({
      kind: 'ready',
      label: 'Ready',
    });

    expect(mapPoolEntryDisplayStatus({ entry: entryPending, poolStatuses: statuses })).toEqual({
      kind: 'benchmarking',
      label: 'Benchmarking',
    });

    expect(
      mapPoolEntryDisplayStatus({
        entry: entryPending,
        poolStatuses: [{ entry: entryPending, status: 'running' }],
      })
    ).toEqual({ kind: 'benchmarking', label: 'Benchmarking' });

    expect(mapPoolEntryDisplayStatus({ entry: entryFailed, poolStatuses: statuses })).toEqual({
      kind: 'failed',
      label: 'Failed',
      failureReason: 'Benchmark container exited with code 1',
    });

    expect(
      mapPoolEntryDisplayStatus({
        entry: entryUnavailable,
        unavailable: true,
        poolStatuses: statuses,
      })
    ).toEqual({
      kind: 'unavailable',
      label: 'Unavailable',
      explanation: UNAVAILABLE_ENTRY_EXPLANATION,
    });
  });

  it('treats missing status on a saved entry as Benchmarking', () => {
    expect(
      mapPoolEntryDisplayStatus({ entry: entryReady, poolStatuses: [], isSaved: true })
    ).toEqual({
      kind: 'benchmarking',
      label: 'Benchmarking',
    });
  });

  it('labels unsaved draft-only rows Not saved, never Benchmarking', () => {
    const display = mapPoolEntryDisplayStatus({
      entry: entryDraftOnly,
      poolStatuses: statuses,
      isSaved: false,
    });
    expect(display).toEqual({ kind: 'not_saved', label: NOT_SAVED_ENTRY_LABEL });
    expect(display.label).toBe('Not saved');
    expect(display.kind).not.toBe('benchmarking');
  });

  it('does not map unsaved rows through unavailable/failed even if keys collide in statuses', () => {
    const display = mapPoolEntryDisplayStatus({
      entry: entryFailed,
      unavailable: true,
      poolStatuses: statuses,
      isSaved: false,
    });
    expect(display.kind).toBe('not_saved');
    expect(display.label).toBe('Not saved');
  });
});

// ---------------------------------------------------------------------------
// Polling stop condition
// ---------------------------------------------------------------------------

describe('settingsRefetchInterval / hasBenchmarkingEntries', () => {
  const configured: PoolEntryWithAvailability[] = [
    { ...entryReady, unavailable: false },
    { ...entryPending, unavailable: false },
  ];

  it('polls while any saved entry is pending/running', () => {
    expect(hasBenchmarkingEntries(configured, statuses)).toBe(true);
    expect(
      settingsRefetchInterval(
        settings({
          configuredPool: configured,
          poolStatuses: statuses,
        })
      )
    ).toBe(SETTINGS_POLL_INTERVAL_MS);
  });

  it('stops polling once every entry is terminal (ready/failed) or unavailable', () => {
    const terminalPool: PoolEntryWithAvailability[] = [
      { ...entryReady, unavailable: false },
      { ...entryFailed, unavailable: false },
      { ...entryUnavailable, unavailable: true },
    ];
    const terminalStatuses: BenchmarkProfileEntryStatus[] = [
      { entry: entryReady, status: 'ready' },
      { entry: entryFailed, status: 'failed', failureReason: 'x' },
      { entry: entryUnavailable, status: 'ready' },
    ];
    expect(hasBenchmarkingEntries(terminalPool, terminalStatuses)).toBe(false);
    expect(
      settingsRefetchInterval(
        settings({ configuredPool: terminalPool, poolStatuses: terminalStatuses })
      )
    ).toBe(false);
  });

  it('does not poll for null/empty pools', () => {
    expect(hasBenchmarkingEntries(null, [])).toBe(false);
    expect(settingsRefetchInterval(settings())).toBe(false);
    expect(settingsRefetchInterval(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Draft resolution the card executes on every render (poll-safe overrides)
// ---------------------------------------------------------------------------

describe('resolveEffectiveDraft (card-executed override-over-saved)', () => {
  it('keeps overrides when a poll updates the saved snapshot (dirty draft preserved)', () => {
    const previousSaved: DraftPool = [entryReady];
    const polledSaved: DraftPool = [entryReady, entryFailed];
    const dirtyPool: DraftPool = [entryReady, entryDraftOnly];

    // Simulate a refetch that changes savedMode/savedPool while the user holds overrides.
    const afterPoll = resolveEffectiveDraft({
      savedMode: 'cost_per_accuracy',
      savedPool: polledSaved,
      modeOverride: 'best_accuracy',
      poolOverride: dirtyPool,
    });

    expect(afterPoll.selectedMode).toBe('best_accuracy');
    expect(afterPoll.draftPool).toEqual(dirtyPool);
    expect(afterPoll.draftPool).not.toEqual(polledSaved);
    expect(previousSaved).not.toEqual(polledSaved);

    // Dirty relative to the polled server snapshot — Save stays enabled / error panel keeps draft.
    expect(
      isDraftDirty({
        selectedMode: afterPoll.selectedMode,
        draftPool: afterPoll.draftPool,
        savedMode: 'cost_per_accuracy',
        savedPool: polledSaved,
      })
    ).toBe(true);
  });

  it('follows the server when overrides are undefined (clean poll path)', () => {
    const previousSaved: DraftPool = [entryReady];
    const polledSaved: DraftPool = [entryReady, entryFailed];

    const afterPoll = resolveEffectiveDraft({
      savedMode: 'best_accuracy',
      savedPool: polledSaved,
      modeOverride: undefined,
      poolOverride: undefined,
    });

    expect(afterPoll.selectedMode).toBe('best_accuracy');
    expect(afterPoll.draftPool).toEqual(polledSaved);
    expect(afterPoll.draftPool).not.toEqual(previousSaved);
    expect(
      isDraftDirty({
        selectedMode: afterPoll.selectedMode,
        draftPool: afterPoll.draftPool,
        savedMode: 'best_accuracy',
        savedPool: polledSaved,
      })
    ).toBe(false);
  });

  it('treats poolOverride null as clear-to-inherit, distinct from undefined (follow server)', () => {
    const savedPool: DraftPool = [entryReady];

    expect(
      resolveEffectiveDraft({
        savedMode: 'inherit',
        savedPool,
        modeOverride: undefined,
        poolOverride: null,
      }).draftPool
    ).toBeNull();

    expect(
      resolveEffectiveDraft({
        savedMode: 'inherit',
        savedPool,
        modeOverride: undefined,
        poolOverride: undefined,
      }).draftPool
    ).toEqual(savedPool);
  });

  it('save-failure Try again rebuilds the body from the still-held dirty draft', () => {
    const savedPool: DraftPool = [entryReady];
    const draftPool: DraftPool = [entryReady, entryFailed];
    const held = resolveEffectiveDraft({
      savedMode: 'cost_per_accuracy',
      savedPool,
      modeOverride: 'best_accuracy',
      poolOverride: draftPool,
    });

    expect(
      isDraftDirty({
        selectedMode: held.selectedMode,
        draftPool: held.draftPool,
        savedMode: 'cost_per_accuracy',
        savedPool,
      })
    ).toBe(true);

    // Retry uses the same buildSaveBody draft the user still holds.
    expect(
      buildSaveBody({
        mode: held.selectedMode,
        pool: held.draftPool,
      })
    ).toEqual({
      mode: 'best_accuracy',
      pool: draftPool,
    });
  });
});

// ---------------------------------------------------------------------------
// Save / retry mutation callbacks the card wires into useMutation
// ---------------------------------------------------------------------------

describe('applySaveMutationSuccess / applySaveMutationError', () => {
  it('on save success updates the query cache and clears the save-error panel', () => {
    const setQueryData = jest.fn();
    const setSaveError = jest.fn();
    const setRetryingKey = jest.fn();
    const markClearOverridesAfterSave = jest.fn();
    const setModeOverride = jest.fn();
    const setPoolOverride = jest.fn();
    const toastSuccess = jest.fn();
    const queryKey = settingsQueryKey(undefined);
    const data = settings({
      configuredMode: 'best_accuracy',
      configuredPool: [{ ...entryReady, unavailable: false }],
      poolStatuses: [{ entry: entryReady, status: 'ready' }],
    });

    applySaveMutationSuccess({
      queryClient: { setQueryData },
      queryKey,
      data,
      setSaveError,
      setRetryingKey,
      markClearOverridesAfterSave,
      setModeOverride,
      setPoolOverride,
      toastSuccess,
    });

    expect(setQueryData).toHaveBeenCalledWith(queryKey, data);
    expect(setSaveError).toHaveBeenCalledWith(null);
    expect(setRetryingKey).toHaveBeenCalledWith(null);
    expect(markClearOverridesAfterSave).toHaveBeenCalled();
    expect(setModeOverride).toHaveBeenCalledWith('best_accuracy');
    expect(setPoolOverride).toHaveBeenCalledWith([entryReady]);
    expect(toastSuccess).toHaveBeenCalledWith('Auto routing settings saved');
  });

  it('on save error sets the inline Try again message and does not touch draft overrides', () => {
    const setRetryingKey = jest.fn();
    const setSaveError = jest.fn();
    const toastError = jest.fn();

    applySaveMutationError({
      error: new Error('Invalid routing settings'),
      setRetryingKey,
      setSaveError,
      toastError,
    });

    expect(setRetryingKey).toHaveBeenCalledWith(null);
    expect(setSaveError).toHaveBeenCalledWith('Invalid routing settings');
    expect(toastError).toHaveBeenCalledWith('Invalid routing settings');
  });
});

describe('applyRetryMutationSuccess', () => {
  it('invalidates the settings query key immediately after a successful retry', () => {
    const setQueryData = jest.fn();
    const invalidateQueries = jest.fn();
    const setRetryingKey = jest.fn();
    const toastSuccess = jest.fn();
    const queryKey = settingsQueryKey('org-1');
    const data = settings({
      ownerType: 'org',
      ownerId: 'org-1',
      configuredPool: [{ ...entryFailed, unavailable: false }],
      poolStatuses: [{ entry: entryFailed, status: 'pending' }],
    });

    applyRetryMutationSuccess({
      queryClient: { setQueryData, invalidateQueries },
      queryKey,
      data,
      setRetryingKey,
      toastSuccess,
    });

    expect(setQueryData).toHaveBeenCalledWith(queryKey, data);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['auto-routing-settings', 'org-1'],
    });
    expect(setRetryingKey).toHaveBeenCalledWith(null);
    expect(toastSuccess).toHaveBeenCalledWith('Benchmark retry requested');
  });
});

// ---------------------------------------------------------------------------
// Add flow
// ---------------------------------------------------------------------------

describe('tryAddPoolEntry', () => {
  it('requires a variant when the model exposes variants', () => {
    const result = tryAddPoolEntry({
      draftPool: null,
      modelId: 'anthropic/claude-sonnet-4',
      variant: undefined,
      modelVariants: ['low', 'high'],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'missing_variant',
      message: 'Choose a variant for this model.',
    });
  });

  it('adds a unique pair and rejects duplicates', () => {
    const first = tryAddPoolEntry({
      draftPool: null,
      modelId: 'anthropic/claude-sonnet-4',
      variant: 'high',
      modelVariants: ['low', 'high'],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const duplicate = tryAddPoolEntry({
      draftPool: first.pool,
      modelId: 'anthropic/claude-sonnet-4',
      variant: 'high',
      modelVariants: ['low', 'high'],
    });
    expect(duplicate).toEqual({
      ok: false,
      reason: 'duplicate',
      message: 'That model and variant pair is already in the pool.',
    });

    const otherVariant = tryAddPoolEntry({
      draftPool: first.pool,
      modelId: 'anthropic/claude-sonnet-4',
      variant: 'low',
      modelVariants: ['low', 'high'],
    });
    expect(otherVariant.ok).toBe(true);
  });

  it('allows null variant when the model has no variants', () => {
    const result = tryAddPoolEntry({
      draftPool: null,
      modelId: 'google/gemini-2.5-flash',
      variant: undefined,
      modelVariants: undefined,
    });
    expect(result).toEqual({
      ok: true,
      pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
    });
  });

  it('enforces the 10-entry cap', () => {
    const pool: PoolEntry[] = Array.from({ length: 10 }, (_, i) => ({
      model: `provider/model-${i}`,
      variant: null,
    }));
    const result = tryAddPoolEntry({
      draftPool: pool,
      modelId: 'provider/extra',
      variant: null,
      modelVariants: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pool_full');
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe('isDirectByokOnlyModel / isExperimentSelectorModel / isEligiblePoolModel', () => {
  it('excludes direct-BYOK-only entries via hasUserByokAvailable + provider prefix', () => {
    expect(
      isDirectByokOnlyModel({
        id: 'chutes-byok/some-model',
        hasUserByokAvailable: true,
      })
    ).toBe(true);
    expect(
      isEligiblePoolModel({
        id: 'chutes-byok/some-model',
        hasUserByokAvailable: true,
      })
    ).toBe(false);

    // Managed OpenRouter model with a user BYOK key remains eligible.
    expect(
      isDirectByokOnlyModel({
        id: 'anthropic/claude-sonnet-4',
        hasUserByokAvailable: true,
      })
    ).toBe(false);
    expect(
      isEligiblePoolModel({
        id: 'anthropic/claude-sonnet-4',
        hasUserByokAvailable: true,
        isFree: false,
        pricing: { prompt: '0.000003' },
      })
    ).toBe(true);
  });

  it('excludes experiment selector entries via zero pricing without isFree', () => {
    const experiment = {
      id: 'partner/preview-model',
      isFree: undefined,
      pricing: { prompt: '0.0000000' },
    };
    expect(isExperimentSelectorModel(experiment)).toBe(true);
    expect(isEligiblePoolModel(experiment)).toBe(false);

    // Managed free models set isFree: true and must stay eligible.
    expect(
      isExperimentSelectorModel({
        id: 'openrouter/free-ish',
        isFree: true,
        pricing: { prompt: '0' },
      })
    ).toBe(false);
    expect(
      isEligiblePoolModel({
        id: 'openrouter/free-ish',
        isFree: true,
        pricing: { prompt: '0' },
      })
    ).toBe(true);
  });

  it('still excludes virtual and custom ids', () => {
    expect(isEligiblePoolModel({ id: 'anthropic/claude' })).toBe(true);
    expect(isEligiblePoolModel({ id: 'kilo-auto/efficient' })).toBe(false);
    expect(isEligiblePoolModel({ id: 'kilo-internal/x' })).toBe(false);
  });
});

describe('toEligibleModelOptions', () => {
  it('excludes kilo-auto, custom LLM, BYOK-only, experiments, and pairs already in the draft', () => {
    const options = toEligibleModelOptions(
      [
        { id: 'kilo-auto/efficient', name: 'Efficient' },
        { id: 'kilo-internal/custom', name: 'Custom' },
        {
          id: 'chutes-byok/direct-only',
          name: 'Direct BYOK',
          hasUserByokAvailable: true,
        },
        {
          id: 'partner/preview-model',
          name: 'Experiment',
          pricing: { prompt: '0.0000000' },
        },
        {
          id: 'anthropic/claude-sonnet-4',
          name: 'Sonnet',
          hasUserByokAvailable: true,
          pricing: { prompt: '0.000003' },
          opencode: { variants: { high: {}, low: {} } },
        },
        {
          id: 'google/gemini-2.5-flash',
          name: 'Flash',
          pricing: { prompt: '0.0000001' },
        },
      ],
      [{ model: 'google/gemini-2.5-flash', variant: null }]
    );
    expect(options.map(o => o.id)).toEqual(['anthropic/claude-sonnet-4']);
    expect(options[0]?.variants).toEqual(['high', 'low']);
  });

  it('keeps a multi-variant model when only one variant is drafted', () => {
    const options = toEligibleModelOptions(
      [
        {
          id: 'anthropic/claude-sonnet-4',
          name: 'Sonnet',
          pricing: { prompt: '0.000003' },
          opencode: { variants: { high: {}, low: {} } },
        },
      ],
      [{ model: 'anthropic/claude-sonnet-4', variant: 'high' }]
    );
    expect(options).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Save / retry bodies
// ---------------------------------------------------------------------------

describe('buildSaveBody / buildRetryBody', () => {
  it('PUTs { mode, pool } with nulls for inherit (happy save payload)', () => {
    expect(buildSaveBody({ mode: 'inherit', pool: null })).toEqual({
      mode: null,
      pool: null,
    });
    expect(
      buildSaveBody({
        mode: 'best_accuracy',
        pool: [entryReady],
      })
    ).toEqual({
      mode: 'best_accuracy',
      pool: [entryReady],
    });
  });

  it('retry PUTs the current saved pool with retryEntries: [entry]', () => {
    const body = buildRetryBody({
      mode: 'cost_per_accuracy',
      savedPool: [entryReady, entryFailed],
      retryEntry: entryFailed,
    });
    expect(body).toEqual({
      mode: 'cost_per_accuracy',
      pool: [entryReady, entryFailed],
      retryEntries: [entryFailed],
    });
    expect(body.retryEntries).toHaveLength(1);
    expect(body.retryEntries[0]).toEqual(entryFailed);
  });
});

describe('removePoolEntry / clear', () => {
  it('removes one entry and clears to inherit when the last entry is removed', () => {
    const withTwo = [entryReady, entryFailed];
    expect(removePoolEntry(withTwo, entryReady)).toEqual([entryFailed]);
    expect(removePoolEntry([entryFailed], entryFailed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Clear pool + editable chrome (card-executed visibility)
// ---------------------------------------------------------------------------

describe('shouldShowClearPoolControl / resolveEditableChrome', () => {
  it('shows Clear pool only when a saved configured pool exists', () => {
    expect(shouldShowClearPoolControl(true)).toBe(true);
    expect(shouldShowClearPoolControl(false)).toBe(false);

    expect(
      resolveEditableChrome({
        readonly: false,
        hasConfiguredPool: true,
        hasSaveError: false,
      }).showClearPool
    ).toBe(true);
    expect(
      resolveEditableChrome({
        readonly: false,
        hasConfiguredPool: false,
        hasSaveError: false,
      }).showClearPool
    ).toBe(false);
  });

  it('save-error panel exposes Try again only when editable', () => {
    expect(
      resolveEditableChrome({
        readonly: false,
        hasConfiguredPool: false,
        hasSaveError: true,
      }).showSaveErrorRetry
    ).toBe(true);
    expect(
      resolveEditableChrome({
        readonly: true,
        hasConfiguredPool: true,
        hasSaveError: true,
      }).showSaveErrorRetry
    ).toBe(false);
  });

  it('org member readonly hides Save / Add / Remove / Retry / Clear', () => {
    const chrome = resolveEditableChrome({
      readonly: true,
      hasConfiguredPool: true,
      hasSaveError: true,
    });
    expect(chrome).toEqual({
      showClearPool: false,
      showAddModel: false,
      showSave: false,
      showSaveErrorRetry: false,
      showRemove: false,
      showRetryBenchmarkForFailed: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('error messages', () => {
  it('load failure message surfaces the API error string', () => {
    expect(formatLoadErrorMessage({ error: 'Authentication required' })).toBe(
      'Authentication required'
    );
    expect(formatLoadErrorMessage(null)).toBe('Failed to load auto routing settings');
  });

  it('save failure surfaces a specific message for the inline Try again path', () => {
    const message = formatSaveErrorMessage({ error: 'Invalid routing settings' }, 400);
    expect(message).toBe('Invalid routing settings');
  });

  it('429 message includes retry timing from retryAt', () => {
    const retryAt = '2026-07-29T12:00:00.000Z';
    const message = formatSaveErrorMessage(
      {
        error: 'Benchmark profile request limit exceeded',
        retryAt,
      },
      429
    );
    expect(message).toContain('Benchmark profile request limit exceeded');
    expect(message).toContain('New benchmarks can be requested');
    expect(message.toLowerCase()).toMatch(/after /);
  });
});

// ---------------------------------------------------------------------------
// Readonly / permission isolation (org member) — call-site derivation
// ---------------------------------------------------------------------------

describe('readonly org member controls', () => {
  it('billing-manager edit permission is isolated from page-level canEdit', () => {
    // Mirrors OrganizationProvidersAndModelsPage derivation.
    const derive = (role: string, isKiloAdmin = false) => {
      const canEdit = isKiloAdmin || role === 'owner';
      const canEditAutoRouting = isKiloAdmin || role === 'owner' || role === 'billing_manager';
      return { canEdit, canEditAutoRouting };
    };

    expect(derive('billing_manager')).toEqual({
      canEdit: false,
      canEditAutoRouting: true,
    });
    expect(derive('member')).toEqual({
      canEdit: false,
      canEditAutoRouting: false,
    });
    expect(derive('owner')).toEqual({
      canEdit: true,
      canEditAutoRouting: true,
    });
    expect(derive('member', true)).toEqual({
      canEdit: true,
      canEditAutoRouting: true,
    });

    // Card consumes readonly={!canEditAutoRouting}; member → no edit chrome.
    expect(
      resolveEditableChrome({
        readonly: !derive('member').canEditAutoRouting,
        hasConfiguredPool: true,
        hasSaveError: false,
      }).showSave
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variant labels used by real card rows
// ---------------------------------------------------------------------------

describe('variantLabel', () => {
  it('labels null as Default and known effort keys for display', () => {
    expect(variantLabel(null)).toBe('Default');
    expect(variantLabel('high')).toBe('High');
  });
});

beforeEach(() => {
  jest.clearAllMocks?.();
});
