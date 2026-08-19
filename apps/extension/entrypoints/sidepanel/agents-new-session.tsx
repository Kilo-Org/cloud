/* eslint-disable import/max-dependencies */
/* eslint-disable max-lines -- Cohesive single-purpose new-session form; splitting would scatter form state */
import { storage } from '#imports';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  FolderGit2,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  TerminalSquare,
} from 'lucide-react';
import {
  CLI_MODEL_ID,
  cliModelLabel,
  createRemoteSessionOnConnection,
  formatSessionError,
  parseCreateSessionResponse,
} from '@kilocode/cloud-agent-sdk';
import type { CreateRemoteSessionInput } from '@kilocode/cloud-agent-sdk';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import type { StoredAuth } from '@/src/shared/auth';
import { getKiloApiBaseUrl, loadStoredAuth } from '@/src/shared/auth';
import { fetchModelPreferences } from '@/src/shared/model-preferences-client';
import { isGatewayModelId } from '@/src/shared/model-picker-rows';
import { getModelPreferencesQueryKey } from '@/src/shared/side-panel-query-options';
import { thinkingEffortLabel } from '@/src/shared/kilo-api-client';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { useExtensionAgents } from './agents-provider';
import { activeSessionsQueryKey, sessionHistoryQueryKey } from './agents-session-list';
import { ModelPicker } from './model-picker';
import { useGatewayModels } from './use-gateway-models';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROMPT_MIN_LENGTH = 3;
const PROMPT_MAX_LENGTH = 4000;
const MODE = 'code' as const;

/**
 * Synthetic first row for a CLI target: keep the CLI on its own configured
 * model. Picking it omits `model` from `create_session`, so the CLI decides.
 * The shared picker hides the favorite star on it: model preferences are keyed
 * by gateway model id, and this id is not one.
 */
const CLI_DEFAULT_MODEL_OPTION: KiloGatewayModelOption = {
  id: CLI_MODEL_ID,
  isPreferred: true,
  name: cliModelLabel(null),
  variants: [],
};

export { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, MODE };
// Exported for focused test coverage.

// ---------------------------------------------------------------------------
// Stored Auth hook
// ---------------------------------------------------------------------------

const storedAuthQueryKey = ['side-panel', 'stored-auth'] as const;

const useStoredAuth = (): {
  readonly auth: StoredAuth | undefined;
  readonly isLoading: boolean;
} => {
  const query = useQuery({
    queryFn: async () => (await loadStoredAuth(storage)) ?? null,
    queryKey: storedAuthQueryKey,
    select: data => data ?? undefined,
    staleTime: Infinity,
  });

  return { auth: query.data ?? undefined, isLoading: query.isLoading };
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface RepoOption {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
}

interface LastSelected {
  readonly model: string;
  readonly variant?: string;
}

export interface PrepareSessionAction {
  readonly path: 'cloudAgentNext.prepareSession' | 'organizations.cloudAgentNext.prepareSession';
  readonly payload: Record<string, unknown>;
}

export const buildPrepareSessionInput = (
  organizationId: string | null | undefined,
  baseInput: Record<string, unknown>
): PrepareSessionAction => {
  if (organizationId !== null && organizationId !== undefined) {
    return {
      path: 'organizations.cloudAgentNext.prepareSession',
      payload: { ...baseInput, organizationId },
    };
  }
  return {
    path: 'cloudAgentNext.prepareSession',
    payload: baseInput,
  };
};

const trimValue = (value: string): string => value.trim();

export const buildSubmitInput = ({
  initialMessageId,
  prompt,
  selectedModel,
  selectedRepo,
  selectedVariant,
}: {
  prompt: string;
  selectedModel: string;
  selectedVariant: string;
  selectedRepo: string;
  initialMessageId: string;
}): Record<string, unknown> => ({
  autoCommit: true,
  autoInitiate: true,
  githubRepo: selectedRepo,
  initialMessageId,
  mode: MODE,
  model: selectedModel,
  prompt,
  ...(selectedVariant ? { variant: selectedVariant } : {}),
});

/**
 * `create_session` carries the model itself, so a CLI session starts on the
 * picked gateway model — no first-prompt override needed. `CLI_MODEL_ID` means
 * "leave the CLI on its own model": the field is omitted from the wire.
 */
export const buildCreateRemoteSessionInput = ({
  organizationId,
  selectedModel,
  selectedVariant,
}: {
  organizationId: string | null | undefined;
  selectedModel: string;
  selectedVariant: string;
}): CreateRemoteSessionInput => ({
  ...(organizationId === null || organizationId === undefined ? {} : { orgId: organizationId }),
  ...(selectedModel === '' || selectedModel === CLI_MODEL_ID
    ? {}
    : {
        model: {
          modelID: selectedModel,
          providerID: 'kilo',
          ...(selectedVariant ? { variant: selectedVariant } : {}),
        },
      }),
});

/**
 * One line saying why Start session is unavailable. A disabled button with no
 * reason is a dead end — most often no GitHub integration, so a cloud session
 * can never get a repository.
 */
export const submitBlockedReason = ({
  hasModels,
  integrationInstalled,
  isCloudTarget,
  isLoading,
  isPromptValid,
  repoCount,
  selectedRepo,
}: {
  hasModels: boolean;
  integrationInstalled: boolean;
  isCloudTarget: boolean;
  /** Repositories or models still in flight; an empty list means nothing yet. */
  isLoading: boolean;
  isPromptValid: boolean;
  repoCount: number;
  selectedRepo: string;
}): 'connect-github' | 'no-repos' | 'pick-repo' | 'no-models' | null => {
  if (!isPromptValid || !isCloudTarget) {
    // The textarea already reports a short prompt; a CLI target needs nothing else.
    return null;
  }
  if (isLoading) {
    // Naming a blocker mid-load would name the wrong one.
    return null;
  }
  if (!integrationInstalled) {
    return 'connect-github';
  }
  if (repoCount === 0) {
    return 'no-repos';
  }
  if (!hasModels) {
    return 'no-models';
  }
  if (selectedRepo === '') {
    return 'pick-repo';
  }
  return null;
};

const isModelPreferencesGetResult = (
  value: unknown
): value is { favorites: string[]; lastSelected: LastSelected | null } =>
  typeof value === 'object' &&
  value !== null &&
  'favorites' in value &&
  Array.isArray((value as Record<string, unknown>)['favorites']);

export { isModelPreferencesGetResult };
// Exported for focused test coverage.

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines -- Cohesive single-purpose new-session form; splitting would scatter form state
export const AgentsNewSession = ({
  onCreated,
  onCancel,
}: {
  onCreated: (kiloSessionId: string, initialPrompt?: string) => void;
  onCancel: () => void;
}): JSX.Element => {
  const { organizationId, trpcClient, userWebConnection } = useExtensionAgents();
  const queryClient = useQueryClient();

  // ---- Auth (for gateway models) ----
  const { auth, isLoading: isAuthLoading } = useStoredAuth();

  // ---- Models ----
  const {
    isLoading: isModelsLoading,
    modelLoadError,
    modelOptions,
    refetchModels,
  } = useGatewayModels({
    auth: auth ?? { token: '', userEmail: undefined },
    organizationId: organizationId ?? undefined,
  });

  // ---- Model preferences (lastSelected) ----
  // Same key and fetcher as the embedded ModelPicker's `useModelPreferences`,
  // So favorites and lastSelected arrive on one request.
  const { data: modelPrefsData } = useQuery({
    enabled: auth !== undefined && auth.token !== '',
    queryFn: ({ signal }) =>
      fetchModelPreferences({
        apiBaseUrl: getKiloApiBaseUrl(),
        fetch: (input, init) => fetch(input, init),
        organizationId: organizationId ?? undefined,
        signal,
        token: auth?.token ?? '',
      }),
    queryKey: getModelPreferencesQueryKey({
      organizationId: organizationId ?? undefined,
      token: auth?.token ?? '',
    }),
  });

  const lastSelected: LastSelected | null = useMemo(() => {
    if (!modelPrefsData || !isModelPreferencesGetResult(modelPrefsData)) {
      return null;
    }
    return modelPrefsData.lastSelected;
  }, [modelPrefsData]);

  const setLastSelectedMutation = useMutation({
    mutationFn: (input: { model: string; variant?: string }) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tRPC mutation input union
      trpcClient.modelPreferences.setLastSelected.mutate(input as never),
  });

  // ---- Repos ----
  const {
    data: repoData,
    isLoading: isRepoLoading,
    isError: isRepoError,
    refetch: refetchRepos,
    isRefetching: isRepoRefetching,
  } = useQuery({
    enabled: auth !== undefined && auth.token !== '',
    queryFn: () =>
      organizationId === null
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- personal endpoint is untyped
          trpcClient.cloudAgentNext.listGitHubRepositories.query({
            forceRefresh: false,
          } as never)
        : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- org endpoint adds organizationId
          trpcClient.organizations.cloudAgentNext.listGitHubRepositories.query({
            forceRefresh: false,
            organizationId,
          } as never),
    queryKey: ['agents-new-session', 'repos', organizationId],
    retry: 2,
  });

  const repos: RepoOption[] = useMemo(() => {
    const raw = repoData as { repositories?: RepoOption[] } | undefined;
    return raw?.repositories ?? [];
  }, [repoData]);

  const integrationInstalled: boolean = useMemo(() => {
    const raw = repoData as { integrationInstalled?: boolean } | undefined;
    return raw?.integrationInstalled ?? true;
  }, [repoData]);

  // ---- Connected CLI instances (spawn targets) ----
  // A failed query degrades to cloud-only; the form never blocks on this.
  const { data: instancesData } = useQuery({
    enabled: auth !== undefined && auth.token !== '',
    queryFn: () => trpcClient.activeSessions.listInstances.query(),
    queryKey: ['agents-new-session', 'instances'],
    retry: 1,
  });
  const instances = useMemo(() => instancesData?.instances ?? [], [instancesData]);

  // ---- Form state ----
  const [prompt, setPrompt] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVariant, setSelectedVariant] = useState('');
  /* A CLI target keeps its own model choice, so switching targets never leaks
     the synthetic CLI id into a cloud submit, or a cloud model into the CLI. */
  const [cliModel, setCliModel] = useState<string>(CLI_MODEL_ID);
  const [cliVariant, setCliVariant] = useState('');
  /** 'cloud' or a CLI instance connectionId. */
  const [runTarget, setRunTarget] = useState('cloud');
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const repoDropdownRef = useRef<HTMLDivElement>(null);

  const isCloudTarget = runTarget === 'cloud';
  const selectedInstance = useMemo(
    () => instances.find(instance => instance.connectionId === runTarget),
    [instances, runTarget]
  );

  // A picked instance that disconnects falls back to cloud.
  useEffect(() => {
    if (!isCloudTarget && selectedInstance === undefined) {
      setRunTarget('cloud');
    }
  }, [isCloudTarget, selectedInstance]);

  // ---- Close the repo dropdown on outside click ----
  useEffect(() => {
    const handler = (evt: MouseEvent): void => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- browser DOM event target
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(evt.target as Node)) {
        setRepoDropdownOpen(false);
        setRepoSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, []);

  // ---- Auto-select model from lastSelected, then first available ----
  useEffect(() => {
    if (isModelUserSelected || modelOptions.length === 0) {
      return;
    }

    if (lastSelected?.model !== undefined) {
      const match = modelOptions.find(opt => opt.id === lastSelected.model);
      if (match) {
        setSelectedModel(match.id);
        if (lastSelected.variant === undefined) {
          setSelectedVariant('');
        } else {
          setSelectedVariant(lastSelected.variant);
        }
        return;
      }
    }

    // Fallback: first model in loaded list (index 0)
    setSelectedModel(modelOptions[0]?.id ?? '');
    setSelectedVariant('');
  }, [modelOptions, lastSelected, isModelUserSelected]);

  // ---- Auto-select repo: if only one, use it ----
  useEffect(() => {
    if (selectedRepo || repos.length !== 1) {
      return;
    }
    setSelectedRepo(repos[0]?.fullName ?? '');
  }, [repos, selectedRepo]);

  // ---- Picker values per run target ----
  const pickerModelOptions = useMemo(
    () => (isCloudTarget ? modelOptions : [CLI_DEFAULT_MODEL_OPTION, ...modelOptions]),
    [isCloudTarget, modelOptions]
  );
  const pickerModel = isCloudTarget ? selectedModel : cliModel;
  const pickerVariant = isCloudTarget ? selectedVariant : cliVariant;

  // ---- Variants for current model ----
  const selectedModelOption = useMemo(
    () => modelOptions.find(opt => opt.id === pickerModel),
    [modelOptions, pickerModel]
  );
  const availableVariants = selectedModelOption?.variants ?? [];

  // ---- Derived state ----
  const trimmed = trimValue(prompt);
  const isPromptValid = trimmed.length >= PROMPT_MIN_LENGTH && trimmed.length <= PROMPT_MAX_LENGTH;
  /* A CLI instance inherits the repo from the CLI and defaults to its own
     model; cloud needs both picked. */
  const isFormValid = isCloudTarget
    ? isPromptValid && selectedModel !== '' && selectedRepo !== ''
    : isPromptValid;
  const repoStatus = (() => {
    if (isRepoLoading) {
      return 'loading';
    }
    if (isRepoError) {
      return 'error';
    }
    return 'ready';
  })();

  // Filter repos by search term
  const filteredRepos = useMemo(() => {
    const normalized = repoSearch.toLowerCase().trim();
    if (normalized.length === 0) {
      return repos;
    }
    return repos.filter(
      repo =>
        repo.fullName.toLowerCase().includes(normalized) ||
        repo.name.toLowerCase().includes(normalized)
    );
  }, [repos, repoSearch]);

  const blockedReason = submitBlockedReason({
    hasModels: modelOptions.length > 0,
    integrationInstalled,
    isCloudTarget,
    isLoading: isRepoLoading || isModelsLoading,
    isPromptValid,
    repoCount: repos.length,
    selectedRepo,
  });

  const isCreditsError = submitError?.toLowerCase().includes('insufficient credits') ?? false;

  // ---- Handlers ----
  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (isCloudTarget) {
        setSelectedModel(modelId);
        setIsModelUserSelected(true);
        setSelectedVariant('');
      } else {
        setCliModel(modelId);
        setCliVariant('');
      }
      if (isGatewayModelId(modelId)) {
        // Never persist a non-gateway id: it would wipe the real lastSelected.
        setLastSelectedMutation.mutate({ model: modelId });
      }
    },
    [isCloudTarget, setLastSelectedMutation]
  );

  const handleVariantSelect = useCallback(
    (variant: string) => {
      if (isCloudTarget) {
        setSelectedVariant(variant);
      } else {
        setCliVariant(variant);
      }
      if (isGatewayModelId(pickerModel)) {
        setLastSelectedMutation.mutate({ model: pickerModel, variant });
      }
    },
    [isCloudTarget, pickerModel, setLastSelectedMutation]
  );

  const handleSubmit = useCallback(async () => {
    if (!isFormValid || isSubmitting) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);

    // ---- CLI instance target: spawn over the user-web socket ----
    if (!isCloudTarget) {
      try {
        const raw = await createRemoteSessionOnConnection(
          userWebConnection,
          runTarget,
          buildCreateRemoteSessionInput({
            organizationId,
            selectedModel: cliModel,
            selectedVariant: cliVariant,
          })
        );
        const parsed = parseCreateSessionResponse(raw);
        if (!parsed.ok) {
          setSubmitError('The CLI did not return a session id. Update the Kilo CLI and retry.');
          setIsSubmitting(false);
          return;
        }
        void queryClient.invalidateQueries({
          queryKey: activeSessionsQueryKey(organizationId),
        });
        setIsSubmitting(false);
        onCreated(parsed.kiloSessionId, trimmed);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Failed to start the session.');
        setIsSubmitting(false);
      }
      return;
    }

    const messageId = generateMessageId();
    const input = buildSubmitInput({
      initialMessageId: messageId,
      prompt: trimmed,
      selectedModel,
      selectedRepo,
      selectedVariant,
    });

    const action = buildPrepareSessionInput(organizationId, input);

    try {
      const result =
        action.path === 'organizations.cloudAgentNext.prepareSession'
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- org endpoint payload is untyped
            await trpcClient.organizations.cloudAgentNext.prepareSession.mutate(
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- org endpoint payload is untyped
              action.payload as never
            )
          : await trpcClient.cloudAgentNext.prepareSession.mutate(
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- personal endpoint payload is untyped
              action.payload as never
            );

      const { kiloSessionId } = result as { kiloSessionId?: string };
      if (kiloSessionId === undefined || kiloSessionId === '') {
        setSubmitError('Session creation failed. Please try again.');
        setIsSubmitting(false);
        return;
      }

      // Invalidate pinned session list keys
      void queryClient.invalidateQueries({
        queryKey: activeSessionsQueryKey(organizationId),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionHistoryQueryKey(organizationId),
      });

      setIsSubmitting(false);
      onCreated(kiloSessionId);
    } catch (error) {
      const message = formatSessionError(error);
      setSubmitError(message);
      setIsSubmitting(false);
    }
  }, [
    isFormValid,
    isSubmitting,
    isCloudTarget,
    runTarget,
    cliModel,
    cliVariant,
    userWebConnection,
    trimmed,
    selectedModel,
    selectedVariant,
    selectedRepo,
    organizationId,
    trpcClient,
    queryClient,
    onCreated,
  ]);

  // ---- Credits CTA URL ----
  const creditsUrl = useMemo(() => {
    const base = getKiloApiBaseUrl().replace(/\/+$/, '');
    return organizationId === null
      ? `${base}/credits`
      : `${base}/organizations/${encodeURIComponent(organizationId)}`;
  }, [organizationId]);

  // ---- isSubmitting error display ----
  const displayError: string | null = submitError;

  // ---- Textarea auto-resize ----
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) {
      return;
    }
    ta.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.35;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  const handlePromptChange = useCallback(
    (evt: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(evt.target.value);
      resizeTextarea();
    },
    [resizeTextarea]
  );

  const handleKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // eslint-disable-next-line react/no-deprecated -- keyCode 229 catches Chrome IME composition on older input method paths
      if (evt.nativeEvent.isComposing || evt.nativeEvent.keyCode === 229) {
        return;
      }
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        if (isFormValid) {
          void handleSubmit();
        }
      }
    },
    [isFormValid, handleSubmit]
  );

  // ---- Render: loading auth ----
  if (isAuthLoading) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <Loader2 className="size-5 animate-spin text-foreground-muted" />
      </div>
    );
  }

  // ---- Render ----
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          aria-label="Back"
          className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
          onClick={onCancel}
          type="button"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="type-label text-foreground">New session</span>
      </div>

      {/* Error banner */}
      {displayError === null ? null : (
        <div className="shrink-0 px-4 pt-3">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-raised p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-red-400" />
            <div className="min-w-0 flex-1">
              <p className="type-label text-status-red-400">{displayError}</p>
              {isCreditsError ? (
                <a
                  className="type-label mt-1 inline-block text-link hover:text-link-hover underline underline-offset-4"
                  href={creditsUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Add credits
                </a>
              ) : null}
            </div>
            {isCreditsError ? null : (
              <button
                className="h-7 shrink-0 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                onClick={() => {
                  setSubmitError(null);
                  void handleSubmit();
                }}
                type="button"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {/* Form body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        {/* Prompt textarea */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            aria-label="What would you like to do?"
            className="min-h-[80px] w-full resize-none rounded-lg border border-border bg-input-bg p-3 type-body text-foreground placeholder:text-foreground-muted outline-none transition focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting}
            maxLength={PROMPT_MAX_LENGTH}
            onChange={handlePromptChange}
            onKeyDown={handleKeyDown}
            placeholder="What would you like to do?"
            rows={3}
            value={prompt}
          />
          {prompt.length > 0 && prompt.length < PROMPT_MIN_LENGTH ? (
            <p className="mt-1 type-label text-foreground-muted">
              Enter at least {PROMPT_MIN_LENGTH} characters
            </p>
          ) : null}
        </div>

        {/* Toolbar: model + variant + repo */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Model picker — same component as the browser tab, for both run
              targets. A CLI target also gets the synthetic "CLI default" row.
              The wrapper's min width stops the flexible trigger collapsing to a
              sliver once the repo and Run-on pickers share the row; the row
              wraps instead. */}
          {auth === undefined ? null : (
            <div className="flex min-w-36 flex-1">
              <ModelPicker
                auth={auth}
                disabled={isSubmitting || pickerModelOptions.length === 0}
                model={pickerModel}
                modelOptions={pickerModelOptions}
                onModelChange={handleModelSelect}
                organizationId={organizationId ?? undefined}
              />
            </div>
          )}
          {(() => {
            if (modelLoadError !== undefined) {
              return (
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5 shrink-0 text-status-red-400" />
                  <span className="type-label text-status-red-400">{modelLoadError}</span>
                  <button
                    className="type-label text-link hover:text-link-hover underline underline-offset-4"
                    onClick={() => {
                      void refetchModels();
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              );
            }
            if (isModelsLoading) {
              return null;
            }
            if (modelOptions.length === 0) {
              return (
                <div className="flex items-center gap-1.5">
                  <span className="type-label text-foreground-muted">
                    {isCloudTarget ? 'No models available' : 'Only the CLI model is available'}
                  </span>
                  <button
                    className="type-label text-link hover:text-link-hover underline underline-offset-4"
                    onClick={() => {
                      void refetchModels();
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              );
            }
            return null;
          })()}

          {/* Variant picker */}
          {availableVariants.length > 0 ? (
            <div className="relative">
              <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-within:ring-2 focus-within:ring-brand-primary-ring">
                <select
                  aria-label="Thinking effort"
                  className="appearance-none bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isSubmitting}
                  onChange={changeEvent => {
                    handleVariantSelect(changeEvent.target.value);
                  }}
                  value={pickerVariant}
                >
                  <option value="">Auto</option>
                  {availableVariants.map(variant => (
                    <option key={variant} value={variant}>
                      {thinkingEffortLabel(variant)}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" className="pointer-events-none size-3.5 shrink-0" />
              </div>
            </div>
          ) : null}

          {/* Repo picker (cloud target only) */}
          {isCloudTarget ? (
            <div ref={repoDropdownRef} className="relative">
              <button
                aria-label="Select repository"
                className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-overlay px-2 type-label transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSubmitting || repoStatus === 'loading'}
                onClick={() => {
                  setRepoDropdownOpen(prev => !prev);
                }}
                type="button"
              >
                <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
                <span
                  className={`max-w-[120px] truncate ${selectedRepo ? 'text-foreground' : 'text-foreground-muted'}`}
                >
                  {selectedRepo || 'Repository'}
                </span>
                {repoStatus === 'loading' ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0" />
                )}
              </button>
              {repoDropdownOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-surface-overlay py-1 shadow-lg">
                  {(() => {
                    if (repoStatus === 'loading') {
                      return (
                        <p className="px-3 py-2 type-label text-foreground-muted">
                          Loading repositories...
                        </p>
                      );
                    }
                    if (repoStatus === 'error') {
                      return (
                        <div className="px-3 py-2">
                          <p className="type-label text-status-red-400">
                            Failed to load repositories
                          </p>
                          <button
                            className="mt-1 flex items-center gap-1 type-label text-link hover:text-link-hover underline underline-offset-4"
                            disabled={isRepoRefetching}
                            onClick={() => {
                              void refetchRepos();
                            }}
                            type="button"
                          >
                            <RefreshCw
                              className={`size-3 ${isRepoRefetching ? 'animate-spin' : ''}`}
                            />
                            {isRepoRefetching ? 'Retrying...' : 'Retry'}
                          </button>
                        </div>
                      );
                    }
                    if (!integrationInstalled) {
                      return (
                        <div className="px-3 py-2 text-center">
                          <p className="type-label text-foreground-muted">
                            GitHub integration not connected
                          </p>
                          <p className="mt-1 type-label text-foreground-muted">
                            <a
                              className="text-link hover:text-link-hover underline underline-offset-4"
                              href={`${getKiloApiBaseUrl().replace(/\/+$/, '')}${organizationId === null ? '/integrations' : `/organizations/${organizationId}/integrations`}`}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Connect GitHub
                            </a>{' '}
                            to start a session
                          </p>
                        </div>
                      );
                    }
                    if (repos.length === 0) {
                      return (
                        <div className="px-3 py-2 text-center">
                          <p className="type-label text-foreground-muted">No repositories found</p>
                        </div>
                      );
                    }
                    return (
                      <>
                        {/* Repo search */}
                        <div className="sticky top-0 z-10 border-b border-border bg-surface-overlay px-2 py-1.5">
                          <div className="flex items-center gap-1.5 rounded-md border border-border bg-input-bg px-2 py-1">
                            <Search className="size-3 shrink-0 text-foreground-muted" />
                            <input
                              aria-label="Search repositories"
                              className="w-full bg-transparent type-label text-foreground placeholder:text-foreground-muted outline-none"
                              onChange={changeEvent => {
                                setRepoSearch(changeEvent.target.value);
                              }}
                              placeholder="Search repositories..."
                              type="text"
                              value={repoSearch}
                            />
                          </div>
                        </div>
                        {filteredRepos.length === 0 ? (
                          <p className="px-3 py-2 type-label text-foreground-muted">
                            No repositories match your search
                          </p>
                        ) : (
                          filteredRepos.map(repo => (
                            <button
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-body transition hover:bg-surface-hover outline-none focus-visible:bg-surface-hover"
                              key={repo.id}
                              onClick={() => {
                                setSelectedRepo(repo.fullName);
                                setRepoDropdownOpen(false);
                                setRepoSearch('');
                              }}
                              type="button"
                            >
                              <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
                              <span className="truncate flex-1">{repo.fullName}</span>
                              {repo.private ? (
                                <Lock className="size-3 shrink-0 text-foreground-muted" />
                              ) : null}
                              {repo.fullName === selectedRepo ? (
                                <Check className="size-3.5 shrink-0 text-brand-primary" />
                              ) : null}
                            </button>
                          ))
                        )}
                      </>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Run-on picker — visible only when a CLI instance is connected */}
          {instances.length > 0 ? (
            <div className="relative">
              <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-within:ring-2 focus-within:ring-brand-primary-ring">
                {isCloudTarget ? (
                  <Cloud aria-hidden="true" className="size-3.5 shrink-0 text-foreground-muted" />
                ) : (
                  <TerminalSquare
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-foreground-muted"
                  />
                )}
                <select
                  aria-label="Run on"
                  className="max-w-40 appearance-none truncate bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isSubmitting}
                  onFocus={() => {
                    setRepoDropdownOpen(false);
                  }}
                  onChange={changeEvent => {
                    setRunTarget(changeEvent.target.value);
                  }}
                  value={runTarget}
                >
                  <option value="cloud">Cloud agent</option>
                  {instances.map(instance => (
                    <option key={instance.connectionId} value={instance.connectionId}>
                      {instance.name} · {instance.projectName}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" className="pointer-events-none size-3.5 shrink-0" />
              </div>
            </div>
          ) : null}
        </div>

        {/* CLI target hint */}
        {isCloudTarget || selectedInstance === undefined ? null : (
          <p className="type-label -mt-2 text-foreground-muted">
            Runs in {selectedInstance.projectName} with the repository of the CLI.
          </p>
        )}

        {/* Why Start session is unavailable */}
        {blockedReason === null ? null : (
          <p className="type-label -mt-2 text-foreground-muted">
            {blockedReason === 'connect-github' ? (
              <>
                <a
                  className="text-link hover:text-link-hover underline underline-offset-4"
                  href={`${getKiloApiBaseUrl().replace(/\/+$/, '')}${organizationId === null ? '/integrations' : `/organizations/${organizationId}/integrations`}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  Connect GitHub
                </a>{' '}
                to start a cloud session, or pick a connected CLI instance.
              </>
            ) : null}
            {blockedReason === 'no-repos' ? 'No repositories available on this account.' : null}
            {blockedReason === 'no-models' ? 'No models available. Retry above.' : null}
            {blockedReason === 'pick-repo' ? 'Choose a repository to start.' : null}
          </p>
        )}

        {/* Submit */}
        <button
          className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-brand-primary type-label font-medium text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle"
          disabled={!isFormValid || isSubmitting}
          onClick={() => {
            void handleSubmit();
          }}
          type="button"
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {isSubmitting ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </div>
  );
};
