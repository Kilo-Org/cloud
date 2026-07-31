import { storage } from '#imports';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  FolderGit2,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { formatSessionError } from '@kilocode/cloud-agent-sdk';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import type { StoredAuth } from '@/src/shared/auth';
import { getKiloApiBaseUrl, loadStoredAuth } from '@/src/shared/auth';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { thinkingEffortLabel } from '@/src/shared/kilo-api-client';
import { useExtensionAgents } from './agents-provider';
import { activeSessionsQueryKey, sessionHistoryQueryKey } from './agents-session-list';
import { useGatewayModels } from './use-gateway-models';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROMPT_MIN_LENGTH = 3;
const PROMPT_MAX_LENGTH = 4000;
const MODE = 'code' as const;

export { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, MODE }; // Exported for focused test coverage.

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

type RepoOption = {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
};

type LastSelected = {
  readonly model: string;
  readonly variant?: string;
};

export type PrepareSessionAction = {
  readonly path: 'cloudAgentNext.prepareSession' | 'organizations.cloudAgentNext.prepareSession';
  readonly payload: Record<string, unknown>;
};

export const buildPrepareSessionInput = (
  organizationId: string | null | undefined,
  baseInput: Record<string, unknown>
): PrepareSessionAction => {
  if (organizationId) {
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
  prompt,
  selectedModel,
  selectedVariant,
  selectedRepo,
  initialMessageId,
}: {
  prompt: string;
  selectedModel: string;
  selectedVariant: string;
  selectedRepo: string;
  initialMessageId: string;
}): Record<string, unknown> => ({
  prompt,
  mode: MODE,
  model: selectedModel,
  githubRepo: selectedRepo,
  autoCommit: true,
  autoInitiate: true,
  initialMessageId,
  ...(selectedVariant ? { variant: selectedVariant } : {}),
});

const isModelPreferencesGetResult = (
  value: unknown
): value is { favorites: string[]; lastSelected: LastSelected | null } =>
  typeof value === 'object' &&
  value !== null &&
  'favorites' in value &&
  Array.isArray((value as Record<string, unknown>)['favorites']);

export { isModelPreferencesGetResult }; // Exported for focused test coverage.

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AgentsNewSession = ({
  onCreated,
  onCancel,
}: {
  onCreated: (kiloSessionId: string) => void;
  onCancel: () => void;
}): JSX.Element => {
  const { organizationId, trpcClient } = useExtensionAgents();
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
  const { data: modelPrefsData } = useQuery({
    queryKey: ['agents-new-session', 'model-preferences', organizationId],
    queryFn: async () => {
      const input = organizationId ? { organizationId } : undefined;
      return trpcClient.modelPreferences.get.query(input as never);
    },
    enabled: auth !== undefined && auth.token !== '',
  });

  const lastSelected: LastSelected | null = useMemo(() => {
    if (!modelPrefsData || !isModelPreferencesGetResult(modelPrefsData)) return null;
    return modelPrefsData.lastSelected;
  }, [modelPrefsData]);

  const setLastSelectedMutation = useMutation({
    mutationFn: (input: { model: string; variant?: string }) =>
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
    queryKey: ['agents-new-session', 'repos', organizationId],
    queryFn: async () =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.listGitHubRepositories.query({
            organizationId,
            forceRefresh: false,
          } as never)
        : trpcClient.cloudAgentNext.listGitHubRepositories.query({
            forceRefresh: false,
          } as never),
    enabled: auth !== undefined && auth.token !== '',
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

  // ---- Form state ----
  const [prompt, setPrompt] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVariant, setSelectedVariant] = useState('');
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // ---- Close dropdowns on outside click ----
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setRepoDropdownOpen(false);
        setRepoSearch('');
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, []);

  // ---- Auto-select model from lastSelected, then first available ----
  useEffect(() => {
    if (isModelUserSelected || modelOptions.length === 0) return;

    if (lastSelected?.model) {
      const match = modelOptions.find(m => m.id === lastSelected.model);
      if (match) {
        setSelectedModel(match.id);
        if (lastSelected.variant !== undefined) {
          setSelectedVariant(lastSelected.variant);
        } else {
          setSelectedVariant('');
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
    if (selectedRepo || repos.length !== 1) return;
    setSelectedRepo(repos[0]?.fullName ?? '');
  }, [repos, selectedRepo]);

  // ---- Variants for current model ----
  const selectedModelOption = useMemo(
    () => modelOptions.find(m => m.id === selectedModel),
    [modelOptions, selectedModel]
  );
  const availableVariants = selectedModelOption?.variants ?? [];

  // ---- Derived state ----
  const trimmed = trimValue(prompt);
  const isPromptValid = trimmed.length >= PROMPT_MIN_LENGTH && trimmed.length <= PROMPT_MAX_LENGTH;
  const isFormValid = isPromptValid && selectedModel !== '' && selectedRepo !== '';
  const repoStatus: 'loading' | 'ready' | 'error' = isRepoLoading
    ? 'loading'
    : isRepoError
      ? 'error'
      : 'ready';

  // Filter repos by search term
  const filteredRepos = useMemo(() => {
    const normalized = repoSearch.toLowerCase().trim();
    if (normalized.length === 0) return repos;
    return repos.filter(
      r =>
        r.fullName.toLowerCase().includes(normalized) || r.name.toLowerCase().includes(normalized)
    );
  }, [repos, repoSearch]);

  const isCreditsError = submitError?.toLowerCase().includes('insufficient credits') ?? false;

  // ---- Handlers ----
  const handleModelSelect = useCallback(
    (model: KiloGatewayModelOption) => {
      setSelectedModel(model.id);
      setIsModelUserSelected(true);
      setSelectedVariant('');
      setLastSelectedMutation.mutate({ model: model.id });
    },
    [setLastSelectedMutation]
  );

  const handleVariantSelect = useCallback(
    (variant: string) => {
      setSelectedVariant(variant);
      if (selectedModel) {
        setLastSelectedMutation.mutate({ model: selectedModel, variant });
      }
    },
    [selectedModel, setLastSelectedMutation]
  );

  const handleSubmit = useCallback(async () => {
    if (!isFormValid || isSubmitting) return;

    setSubmitError(null);
    setIsSubmitting(true);

    const messageId = generateMessageId();
    const input = buildSubmitInput({
      prompt: trimmed,
      selectedModel,
      selectedVariant,
      selectedRepo,
      initialMessageId: messageId,
    });

    const action = buildPrepareSessionInput(organizationId, input);

    try {
      const result =
        action.path === 'organizations.cloudAgentNext.prepareSession'
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate(
              action.payload as never
            )
          : await trpcClient.cloudAgentNext.prepareSession.mutate(action.payload as never);

      const kiloSessionId = (result as { kiloSessionId?: string }).kiloSessionId;
      if (!kiloSessionId) {
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
    return organizationId
      ? `${base}/organizations/${encodeURIComponent(organizationId)}`
      : `${base}/credits`;
  }, [organizationId]);

  // ---- isSubmitting error display ----
  const displayError: string | null = submitError;

  // ---- Textarea auto-resize ----
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.35;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(e.target.value);
      resizeTextarea();
    },
    [resizeTextarea]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (isFormValid) void handleSubmit();
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
        <span className="type-label text-foreground">New Cloud Session</span>
      </div>

      {/* Error banner */}
      {displayError !== null ? (
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
      ) : null}

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
            <p className="mt-1 type-label text-status-red-400">
              Enter at least {PROMPT_MIN_LENGTH} characters
            </p>
          ) : null}
        </div>

        {/* Toolbar: model + variant + repo */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Model picker */}
          <div ref={modelDropdownRef} className="relative">
            <button
              aria-label="Select model"
              className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSubmitting || modelOptions.length === 0}
              onClick={() => {
                setModelDropdownOpen(prev => !prev);
              }}
              type="button"
            >
              <span className="max-w-[140px] truncate">
                {selectedModelOption?.name ?? 'Select model'}
              </span>
              <ChevronDown className="size-3.5 shrink-0" />
            </button>
            {modelDropdownOpen ? (
              <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-56 overflow-y-auto rounded-lg border border-border bg-surface-overlay py-1 shadow-lg">
                {modelLoadError ? (
                  <div className="px-3 py-2">
                    <p className="type-label text-status-red-400">{modelLoadError}</p>
                    <button
                      className="mt-1 type-label text-link hover:text-link-hover underline underline-offset-4"
                      onClick={() => {
                        void refetchModels();
                      }}
                      type="button"
                    >
                      Retry
                    </button>
                  </div>
                ) : isModelsLoading ? (
                  <p className="px-3 py-2 type-label text-foreground-muted">Loading models…</p>
                ) : modelOptions.length === 0 ? (
                  <p className="px-3 py-2 type-label text-foreground-muted">No models available</p>
                ) : (
                  modelOptions.map(model => (
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-body transition hover:bg-surface-hover outline-none focus-visible:bg-surface-hover"
                      key={model.id}
                      onClick={() => {
                        handleModelSelect(model);
                        setModelDropdownOpen(false);
                      }}
                      type="button"
                    >
                      <span className="truncate flex-1">{model.name}</span>
                      {model.id === selectedModel ? (
                        <Check className="size-3.5 shrink-0 text-brand-primary" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
          {modelDropdownOpen ? null : modelLoadError ? (
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
          ) : isModelsLoading ? (
            <span className="type-label text-foreground-muted">Loading models…</span>
          ) : modelOptions.length === 0 ? (
            <div className="flex items-center gap-1.5">
              <span className="type-label text-foreground-muted">No models available</span>
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
          ) : null}

          {/* Variant picker */}
          {availableVariants.length > 0 ? (
            <div className="relative">
              <button
                aria-label="Select thinking effort"
                className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSubmitting}
                onClick={() => {
                  setModelDropdownOpen(false);
                }}
                type="button"
              >
                <select
                  aria-label="Thinking effort"
                  className="appearance-none bg-transparent outline-none"
                  disabled={isSubmitting}
                  onChange={e => {
                    handleVariantSelect(e.target.value);
                  }}
                  value={selectedVariant}
                >
                  <option value="">Auto</option>
                  {availableVariants.map(v => (
                    <option key={v} value={v}>
                      {thinkingEffortLabel(v)}
                    </option>
                  ))}
                </select>
              </button>
            </div>
          ) : null}

          <div className="flex-1" />

          {/* Repo picker */}
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
                {repoStatus === 'loading' ? (
                  <p className="px-3 py-2 type-label text-foreground-muted">
                    Loading repositories...
                  </p>
                ) : repoStatus === 'error' ? (
                  <div className="px-3 py-2">
                    <p className="type-label text-status-red-400">Failed to load repositories</p>
                    <button
                      className="mt-1 flex items-center gap-1 type-label text-link hover:text-link-hover underline underline-offset-4"
                      disabled={isRepoRefetching}
                      onClick={() => {
                        void refetchRepos();
                      }}
                      type="button"
                    >
                      <RefreshCw className={`size-3 ${isRepoRefetching ? 'animate-spin' : ''}`} />
                      {isRepoRefetching ? 'Retrying...' : 'Retry'}
                    </button>
                  </div>
                ) : !integrationInstalled ? (
                  <div className="px-3 py-2 text-center">
                    <p className="type-label text-foreground-muted">
                      GitHub integration not connected
                    </p>
                    <p className="mt-1 type-label text-foreground-muted">
                      <a
                        className="text-link hover:text-link-hover underline underline-offset-4"
                        href={`${getKiloApiBaseUrl().replace(/\/+$/, '')}${organizationId ? `/organizations/${organizationId}/integrations` : '/integrations'}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Connect GitHub
                      </a>{' '}
                      to start a session
                    </p>
                  </div>
                ) : repos.length === 0 ? (
                  <div className="px-3 py-2 text-center">
                    <p className="type-label text-foreground-muted">No repositories found</p>
                  </div>
                ) : (
                  <>
                    {/* Repo search */}
                    <div className="sticky top-0 z-10 border-b border-border bg-surface-overlay px-2 py-1.5">
                      <div className="flex items-center gap-1.5 rounded-md border border-border bg-input-bg px-2 py-1">
                        <Search className="size-3 shrink-0 text-foreground-muted" />
                        <input
                          aria-label="Search repositories"
                          className="w-full bg-transparent type-label text-foreground placeholder:text-foreground-muted outline-none"
                          onChange={e => {
                            setRepoSearch(e.target.value);
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
                )}
              </div>
            ) : null}
          </div>

          {/* Submit */}
          <button
            aria-label="Start session"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-primary text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!isFormValid || isSubmitting}
            onClick={() => {
              void handleSubmit();
            }}
            type="button"
          >
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
