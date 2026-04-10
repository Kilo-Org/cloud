'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import {
  Save,
  Settings,
  GitPullRequest,
  Bot,
  Shield,
  MessageSquareText,
  GitBranch,
  X,
  Wrench,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { motion } from 'motion/react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import Link from 'next/link';

type Props = { townId: string; rigId: string; organizationId?: string };

// Section definitions for the scrollspy nav
const SECTIONS = [
  { id: 'models', label: 'Models', icon: Bot },
  { id: 'refinery', label: 'Refinery', icon: Shield },
  { id: 'merge-strategy', label: 'Merge Strategy', icon: GitPullRequest },
  { id: 'custom-instructions', label: 'Custom Instructions', icon: MessageSquareText },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'agent-limits', label: 'Agent Limits', icon: Wrench },
] as const;

function useScrollSpy(sectionIds: readonly string[]) {
  const [activeId, setActiveId] = useState<string>(sectionIds[0]);
  const suppressRef = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (suppressRef.current) return;
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-56px 0px -60% 0px', threshold: 0 }
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sectionIds]);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    const header = document.getElementById('rig-settings-sticky-header');
    if (!el) return;

    setActiveId(id);
    suppressRef.current = true;

    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    const top = el.getBoundingClientRect().top + window.scrollY - headerHeight - 24;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

    setTimeout(() => {
      suppressRef.current = false;
    }, 1000);
  }

  return { activeId, scrollTo };
}

export function RigSettingsPageClient({ townId, rigId, organizationId }: Props) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const {
    data: modelsData,
    isLoading: isLoadingModels,
    error: modelsError,
  } = useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(
    () => modelsData?.data.map(model => ({ id: model.id, name: model.name })) ?? [],
    [modelsData]
  );

  const rigQuery = useQuery(trpc.gastown.getRig.queryOptions({ rigId, townId }));
  const townConfigQuery = useQuery(trpc.gastown.getTownConfig.queryOptions({ townId }));

  // Local state for form fields (rig-level overrides)
  const [defaultModel, setDefaultModel] = useState('');
  const [polecatModel, setPolecatModel] = useState('');
  const [refineryModel, setRefineryModel] = useState('');
  const [refineryCodeReview, setRefineryCodeReview] = useState<boolean | undefined>(undefined);
  const [reviewMode, setReviewMode] = useState<'rework' | 'comments' | undefined>(undefined);
  const [autoResolvePrFeedback, setAutoResolvePrFeedback] = useState<boolean | undefined>(
    undefined
  );
  const [autoMergeDelayMinutes, setAutoMergeDelayMinutes] = useState<number | null | undefined>(
    undefined
  );
  const [mergeStrategy, setMergeStrategy] = useState<'direct' | 'pr' | undefined>(undefined);
  const [convoyMergeMode, setConvoyMergeMode] = useState<
    'review-then-land' | 'review-and-merge' | undefined
  >(undefined);
  const [polecatInstructions, setPolecatInstructions] = useState('');
  const [refineryInstructions, setRefineryInstructions] = useState('');
  const [pushFlags, setPushFlags] = useState('');
  const [maxPolecats, setMaxPolecats] = useState('');
  const [maxDispatchAttempts, setMaxDispatchAttempts] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Sync rig config into local state when loaded
  if (rigQuery.data && !initialized) {
    const cfg = rigQuery.data.config;
    if (cfg) {
      setDefaultModel(cfg.default_model ?? '');
      setPolecatModel(cfg.role_models?.polecat ?? '');
      setRefineryModel(cfg.role_models?.refinery ?? '');
      setRefineryCodeReview(cfg.code_review);
      setReviewMode(cfg.review_mode);
      setAutoResolvePrFeedback(cfg.auto_resolve_pr_feedback);
      setAutoMergeDelayMinutes(cfg.auto_merge_delay_minutes);
      setMergeStrategy(cfg.merge_strategy);
      setConvoyMergeMode(cfg.convoy_merge_mode);
      setPolecatInstructions(cfg.custom_instructions?.polecat ?? '');
      setRefineryInstructions(cfg.custom_instructions?.refinery ?? '');
      setPushFlags(cfg.git_push_flags ?? '');
      setMaxPolecats(
        cfg.max_concurrent_polecats !== undefined ? String(cfg.max_concurrent_polecats) : ''
      );
      setMaxDispatchAttempts(
        cfg.max_dispatch_attempts !== undefined ? String(cfg.max_dispatch_attempts) : ''
      );
    }
    setInitialized(true);
  }

  const updateConfig = useMutation(
    trpc.gastown.updateRigConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getRig.queryKey({ rigId, townId }),
        });
        toast.success('Rig configuration saved');
      },
      onError: err => toast.error(err.message),
    })
  );

  const { activeId: activeSection, scrollTo: scrollToSection } = useScrollSpy(
    SECTIONS.map(s => s.id)
  );

  const townCfg = townConfigQuery.data;

  function handleSave() {
    updateConfig.mutate({
      rigId,
      townId,
      config: {
        default_model: defaultModel || undefined,
        role_models: {
          polecat: polecatModel || undefined,
          refinery: refineryModel || undefined,
        },
        code_review: refineryCodeReview,
        review_mode: reviewMode,
        auto_resolve_pr_feedback: autoResolvePrFeedback,
        auto_merge_delay_minutes: autoMergeDelayMinutes,
        merge_strategy: mergeStrategy,
        convoy_merge_mode: convoyMergeMode,
        custom_instructions: {
          polecat: polecatInstructions || undefined,
          refinery: refineryInstructions || undefined,
        },
        git_push_flags: pushFlags || undefined,
        max_concurrent_polecats: maxPolecats ? parseInt(maxPolecats, 10) : undefined,
        max_dispatch_attempts: maxDispatchAttempts ? parseInt(maxDispatchAttempts, 10) : undefined,
      },
    });
  }

  const rigName = rigQuery.data?.name;
  const rigDetailPath = organizationId
    ? `/organizations/${organizationId}/gastown/${townId}/rigs/${rigId}`
    : `/gastown/${townId}/rigs/${rigId}`;

  if (rigQuery.isLoading || townConfigQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-white/[0.06] px-6 py-3">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 p-6">
          <div className="space-y-6">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Top bar */}
      <div
        id="rig-settings-sticky-header"
        className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3"
      >
        <div className="flex items-center gap-2.5">
          <SidebarTrigger className="-ml-3" />
          <Settings className="size-4 text-white/40" />
          <Link
            href={rigDetailPath}
            className="text-sm text-white/50 transition-colors hover:text-white/70"
          >
            {rigName}
          </Link>
          <span className="text-white/25">/</span>
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Settings</h1>
        </div>
        <Button
          onClick={handleSave}
          disabled={updateConfig.isPending}
          variant="primary"
          size="sm"
          className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
        >
          <Save className="size-3.5" />
          {updateConfig.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>

      {/* Two-column body */}
      <div className="scroll-smooth">
        <div className="mx-auto flex max-w-4xl px-6">
          {/* Main content */}
          <div className="min-w-0 flex-1">
            <div className="space-y-8 pt-6" style={{ paddingBottom: '75vh' }}>
              {/* ── Models ──────────────────────────────────── */}
              <SettingsSection
                id="models"
                title="Models"
                description="Override the model used for each agent role. Empty fields inherit the town default."
                icon={Bot}
                index={0}
              >
                <div className="space-y-4">
                  <FieldGroup
                    label="Default Model"
                    hint="Overrides the town default model for all roles in this rig."
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        {modelsError ? (
                          <Input
                            value={defaultModel}
                            onChange={e => setDefaultModel(e.target.value)}
                            placeholder={`Inherit from town (${townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                          />
                        ) : (
                          <ModelCombobox
                            label=""
                            models={modelOptions}
                            value={defaultModel}
                            onValueChange={setDefaultModel}
                            isLoading={isLoadingModels}
                            placeholder={`Inherit from town (${townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                          />
                        )}
                      </div>
                      {defaultModel && (
                        <button
                          onClick={() => setDefaultModel('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Clear override"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>

                  <FieldGroup
                    label="Polecat Model"
                    hint="Override the model used for polecat (worker) agents."
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        {modelsError ? (
                          <Input
                            value={polecatModel}
                            onChange={e => setPolecatModel(e.target.value)}
                            placeholder={`Inherit from town (${townCfg?.role_models?.polecat ?? townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                          />
                        ) : (
                          <ModelCombobox
                            label=""
                            models={modelOptions}
                            value={polecatModel}
                            onValueChange={setPolecatModel}
                            isLoading={isLoadingModels}
                            placeholder={`Inherit from town (${townCfg?.role_models?.polecat ?? townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                          />
                        )}
                      </div>
                      {polecatModel && (
                        <button
                          onClick={() => setPolecatModel('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Clear override"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>

                  <FieldGroup
                    label="Refinery Model"
                    hint="Override the model used for refinery (reviewer) agents."
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        {modelsError ? (
                          <Input
                            value={refineryModel}
                            onChange={e => setRefineryModel(e.target.value)}
                            placeholder={`Inherit from town (${townCfg?.role_models?.refinery ?? townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                          />
                        ) : (
                          <ModelCombobox
                            label=""
                            models={modelOptions}
                            value={refineryModel}
                            onValueChange={setRefineryModel}
                            isLoading={isLoadingModels}
                            placeholder={`Inherit from town (${townCfg?.role_models?.refinery ?? townCfg?.default_model ?? 'system default'})`}
                            className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                          />
                        )}
                      </div>
                      {refineryModel && (
                        <button
                          onClick={() => setRefineryModel('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Clear override"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── Refinery ──────────────────────────────────── */}
              <SettingsSection
                id="refinery"
                title="Refinery"
                description="Override refinery behavior for this rig. Empty toggles inherit from town settings."
                icon={Shield}
                index={1}
              >
                <div className="space-y-3">
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <Label className="text-sm text-white/70">Code Review</Label>
                        <p className="text-[11px] text-white/30">
                          Enable or disable the refinery code review for this rig.
                          {townCfg?.refinery?.code_review !== undefined && (
                            <span className="ml-1 text-white/20">
                              (Town default: {townCfg.refinery.code_review ? 'on' : 'off'})
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {refineryCodeReview !== undefined && (
                          <button
                            onClick={() => setRefineryCodeReview(undefined)}
                            className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                            title="Inherit from town"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                        <Switch
                          checked={refineryCodeReview ?? townCfg?.refinery?.code_review ?? true}
                          onCheckedChange={v => setRefineryCodeReview(v)}
                          className={refineryCodeReview === undefined ? 'opacity-40' : ''}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <Label className="mb-1.5 block text-sm text-white/70">Review Mode</Label>
                    <p className="mb-2 text-[11px] text-white/30">
                      How the refinery communicates its findings for this rig.
                      {townCfg?.refinery?.review_mode && (
                        <span className="ml-1 text-white/20">
                          (Town default: {townCfg.refinery.review_mode})
                        </span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setReviewMode('rework')}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          reviewMode === 'rework'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:border-white/10'
                        }`}
                      >
                        <div className="font-medium">Rework requests</div>
                        <div className="mt-0.5 text-[10px] opacity-60">
                          Creates internal rework beads for the polecat to fix.
                        </div>
                      </button>
                      <button
                        onClick={() => setReviewMode('comments')}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          reviewMode === 'comments'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:border-white/10'
                        }`}
                      >
                        <div className="font-medium">PR comments</div>
                        <div className="mt-0.5 text-[10px] opacity-60">
                          Posts GitHub review comments on the PR.
                        </div>
                      </button>
                      {reviewMode !== undefined && (
                        <button
                          onClick={() => setReviewMode(undefined)}
                          className="flex items-center gap-1 rounded-lg border border-white/[0.06] px-2 py-2 text-[10px] text-white/30 transition-colors hover:border-white/10 hover:text-white/50"
                          title="Inherit from town"
                        >
                          <X className="size-3" />
                          Inherit
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <Label className="text-sm text-white/70">Auto-resolve PR feedback</Label>
                        <p className="text-[11px] text-white/30">
                          Automatically dispatch a polecat to address unresolved review comments.
                          {townCfg?.refinery?.auto_resolve_pr_feedback !== undefined && (
                            <span className="ml-1 text-white/20">
                              (Town default:{' '}
                              {townCfg.refinery.auto_resolve_pr_feedback ? 'on' : 'off'})
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {autoResolvePrFeedback !== undefined && (
                          <button
                            onClick={() => setAutoResolvePrFeedback(undefined)}
                            className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                            title="Inherit from town"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                        <Switch
                          checked={
                            autoResolvePrFeedback ??
                            townCfg?.refinery?.auto_resolve_pr_feedback ??
                            false
                          }
                          onCheckedChange={v => setAutoResolvePrFeedback(v)}
                          className={autoResolvePrFeedback === undefined ? 'opacity-40' : ''}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <Label className="mb-1.5 block text-sm text-white/70">
                      Auto-merge delay (minutes)
                    </Label>
                    <p className="mb-3 text-[11px] text-white/30">
                      After all checks pass, merge the PR after this delay. Leave empty to inherit
                      from town.
                      {townCfg?.refinery?.auto_merge_delay_minutes !== null &&
                        townCfg?.refinery?.auto_merge_delay_minutes !== undefined && (
                          <span className="ml-1 text-white/20">
                            (Town default: {townCfg.refinery.auto_merge_delay_minutes}m)
                          </span>
                        )}
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1.5">
                        {[
                          { label: 'Off', value: null },
                          { label: '0', value: 0 },
                          { label: '15m', value: 15 },
                          { label: '1h', value: 60 },
                          { label: '4h', value: 240 },
                        ].map(preset => (
                          <button
                            key={preset.label}
                            onClick={() => setAutoMergeDelayMinutes(preset.value)}
                            className={`rounded px-2 py-1 text-[11px] transition-colors ${
                              autoMergeDelayMinutes === preset.value
                                ? 'bg-white/[0.12] text-white/80'
                                : 'bg-white/[0.04] text-white/40 hover:bg-white/[0.08] hover:text-white/60'
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                        {autoMergeDelayMinutes !== undefined && (
                          <button
                            onClick={() => setAutoMergeDelayMinutes(undefined)}
                            className="rounded px-2 py-1 text-[11px] text-white/25 transition-colors hover:bg-white/[0.04] hover:text-white/50"
                            title="Inherit from town"
                          >
                            Inherit
                          </button>
                        )}
                      </div>
                      {autoMergeDelayMinutes !== null && autoMergeDelayMinutes !== undefined && (
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={0}
                            value={autoMergeDelayMinutes}
                            onChange={e => {
                              const v = parseInt(e.target.value, 10);
                              setAutoMergeDelayMinutes(Number.isNaN(v) ? null : Math.max(0, v));
                            }}
                            className="h-[26px] w-[60px] border-white/[0.08] bg-white/[0.03] text-center font-mono text-xs text-white/85"
                          />
                          <span className="text-[11px] text-white/30">minutes</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </SettingsSection>

              {/* ── Merge Strategy ──────────────────────────────────── */}
              <SettingsSection
                id="merge-strategy"
                title="Merge Strategy"
                description="Override how agent work lands in the default branch."
                icon={GitPullRequest}
                index={2}
              >
                <div className="space-y-3">
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <Label className="mb-2 block text-sm text-white/70">
                      Direct merge vs Pull Request
                    </Label>
                    <p className="mb-2 text-[11px] text-white/30">
                      Overrides town merge strategy for this rig.
                      {townCfg?.merge_strategy && (
                        <span className="ml-1 text-white/20">
                          (Town default: {townCfg.merge_strategy})
                        </span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <MergeStrategyOption
                        selected={mergeStrategy === 'direct'}
                        onSelect={() => setMergeStrategy('direct')}
                        label="Direct push"
                        description="Push merged code directly to the default branch."
                      />
                      <MergeStrategyOption
                        selected={mergeStrategy === 'pr'}
                        onSelect={() => setMergeStrategy('pr')}
                        label="Pull request"
                        description="Create a PR for human review before merging."
                      />
                      {mergeStrategy !== undefined && (
                        <button
                          onClick={() => setMergeStrategy(undefined)}
                          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.06] px-2 py-2 text-[10px] text-white/30 transition-colors hover:border-white/10 hover:text-white/50"
                          title="Inherit from town"
                        >
                          <X className="size-3" />
                          Inherit
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <Label className="mb-2 block text-sm text-white/70">Convoy merge mode</Label>
                    <p className="mb-2 text-[11px] text-white/30">
                      Overrides town convoy merge mode for this rig.
                      {townCfg?.convoy_merge_mode && (
                        <span className="ml-1 text-white/20">
                          (Town default: {townCfg.convoy_merge_mode})
                        </span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConvoyMergeMode('review-then-land')}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          convoyMergeMode === 'review-then-land'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:border-white/10'
                        }`}
                      >
                        <div className="font-medium">Review then land</div>
                        <div className="mt-0.5 text-[10px] opacity-60">
                          Beads merge into a feature branch. One landing PR at the end.
                        </div>
                      </button>
                      <button
                        onClick={() => setConvoyMergeMode('review-and-merge')}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          convoyMergeMode === 'review-and-merge'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:border-white/10'
                        }`}
                      >
                        <div className="font-medium">Review and merge</div>
                        <div className="mt-0.5 text-[10px] opacity-60">
                          Each bead gets its own PR. Auto-merge applies per PR.
                        </div>
                      </button>
                      {convoyMergeMode !== undefined && (
                        <button
                          onClick={() => setConvoyMergeMode(undefined)}
                          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.06] px-2 py-2 text-[10px] text-white/30 transition-colors hover:border-white/10 hover:text-white/50"
                          title="Inherit from town"
                        >
                          <X className="size-3" />
                          Inherit
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </SettingsSection>

              {/* ── Custom Instructions ────────────────────────────────── */}
              <SettingsSection
                id="custom-instructions"
                title="Custom Instructions"
                description="Rig-specific instructions appended to the agent system prompt. Empty fields inherit the town instructions."
                icon={MessageSquareText}
                index={3}
              >
                <div className="space-y-5">
                  <FieldGroup
                    label="Polecat Instructions"
                    hint="Custom instructions for polecat (worker) agents in this rig."
                  >
                    <div className="relative">
                      <Textarea
                        value={polecatInstructions}
                        onChange={e => setPolecatInstructions(e.target.value.slice(0, 2000))}
                        placeholder={
                          townCfg?.custom_instructions?.polecat
                            ? `Town default: ${townCfg.custom_instructions.polecat}`
                            : 'Custom instructions for polecat agents…'
                        }
                        rows={4}
                        className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                      />
                      <span className="absolute right-2 bottom-2 text-[10px] text-white/20">
                        {polecatInstructions.length} / 2000
                      </span>
                    </div>
                  </FieldGroup>

                  <FieldGroup
                    label="Refinery Instructions"
                    hint="Custom instructions for refinery (reviewer) agents in this rig."
                  >
                    <div className="relative">
                      <Textarea
                        value={refineryInstructions}
                        onChange={e => setRefineryInstructions(e.target.value.slice(0, 2000))}
                        placeholder={
                          townCfg?.custom_instructions?.refinery
                            ? `Town default: ${townCfg.custom_instructions.refinery}`
                            : 'Custom instructions for refinery agents…'
                        }
                        rows={4}
                        className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                      />
                      <span className="absolute right-2 bottom-2 text-[10px] text-white/20">
                        {refineryInstructions.length} / 2000
                      </span>
                    </div>
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── Git ──────────────────────────────────────── */}
              <SettingsSection
                id="git"
                title="Git"
                description="Git-related settings for this rig."
                icon={GitBranch}
                index={4}
              >
                <FieldGroup
                  label="Push Flags"
                  hint="Extra flags passed to git push (e.g. --no-verify). Empty = no extra flags."
                >
                  <Input
                    value={pushFlags}
                    onChange={e => setPushFlags(e.target.value)}
                    placeholder="--no-verify"
                    className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                  />
                </FieldGroup>
              </SettingsSection>

              {/* ── Agent Limits ──────────────────────────────── */}
              <SettingsSection
                id="agent-limits"
                title="Agent Limits"
                description="Override the maximum number of concurrent agents and dispatch attempts for this rig."
                icon={Wrench}
                index={5}
              >
                <div className="space-y-4">
                  <FieldGroup
                    label="Max Concurrent Polecats"
                    hint="Maximum number of simultaneously running polecat agents. Empty = inherit town setting."
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={50}
                        value={maxPolecats}
                        onChange={e => setMaxPolecats(e.target.value)}
                        placeholder={
                          townCfg?.max_polecats_per_rig
                            ? `Inherit from town (${townCfg.max_polecats_per_rig})`
                            : 'Inherit from town'
                        }
                        className="w-40 border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                      />
                      {maxPolecats && (
                        <button
                          onClick={() => setMaxPolecats('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Inherit from town"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>

                  <FieldGroup
                    label="Max Dispatch Attempts"
                    hint="Maximum number of times a bead can be dispatched before it is marked as failed. Empty = inherit town setting."
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={maxDispatchAttempts}
                        onChange={e => setMaxDispatchAttempts(e.target.value)}
                        placeholder="Inherit from town"
                        className="w-40 border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                      />
                      {maxDispatchAttempts && (
                        <button
                          onClick={() => setMaxDispatchAttempts('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Inherit from town"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>
                </div>
              </SettingsSection>
            </div>
          </div>

          {/* Right sidebar — sticky scrollspy nav */}
          <div className="hidden w-52 shrink-0 lg:sticky lg:top-[53px] lg:self-start lg:block">
            <nav className="px-4 pt-6">
              <div className="mb-3 text-[10px] font-medium tracking-wide text-white/25 uppercase">
                On this page
              </div>
              <ul className="space-y-0.5">
                {SECTIONS.map(section => {
                  const isActive = activeSection === section.id;
                  const SectionIcon = section.icon;

                  return (
                    <li key={section.id}>
                      <button
                        onClick={() => scrollToSection(section.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors ${
                          isActive
                            ? 'bg-white/[0.06] text-white/80'
                            : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                        }`}
                      >
                        <SectionIcon className="size-3 shrink-0" />
                        <span className="truncate">{section.label}</span>
                        {isActive && (
                          <motion.div
                            layoutId="rig-settings-nav-indicator"
                            className="ml-auto size-1 rounded-full bg-[color:oklch(95%_0.15_108)]"
                            transition={{
                              type: 'spring',
                              stiffness: 350,
                              damping: 30,
                            }}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* Save button mirrored in sidebar */}
              <div className="mt-6 border-t border-white/[0.06] pt-4">
                <Button
                  onClick={handleSave}
                  disabled={updateConfig.isPending}
                  variant="primary"
                  size="sm"
                  className="w-full gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
                >
                  <Save className="size-3" />
                  {updateConfig.isPending ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </nav>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────

function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  index,
  action,
  children,
}: {
  id: string;
  title: string;
  description: string;
  icon: typeof Settings;
  index: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.35 }}
    >
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06]">
            <Icon className="size-4 text-white/40" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white/85">{title}</h2>
            <p className="mt-0.5 text-xs text-white/35">{description}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">{children}</div>
    </motion.section>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-white/55">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-white/25">{hint}</p>}
    </div>
  );
}

function MergeStrategyOption({
  selected,
  onSelect,
  label,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-1 items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-[color:oklch(95%_0.15_108_/_0.3)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
          : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
      }`}
    >
      <div
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-[color:oklch(95%_0.15_108_/_0.6)]' : 'border-white/20'
        }`}
      >
        {selected && <div className="size-2 rounded-full bg-[color:oklch(95%_0.15_108)]" />}
      </div>
      <div>
        <div className={`text-sm font-medium ${selected ? 'text-white/90' : 'text-white/60'}`}>
          {label}
        </div>
        <p className="mt-0.5 text-[11px] text-white/35">{description}</p>
      </div>
    </button>
  );
}
