'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useUser } from '@/hooks/useUser';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Save,
  Settings,
  GitBranch,
  GitPullRequest,
  Bot,
  Shield,
  Variable,
  Layers,
  RefreshCw,
  RotateCcw,
  Power,
  Container,
  User,
  Key,
  MessageSquareText,
  X,
} from 'lucide-react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { motion } from 'motion/react';
import { AdminViewingBanner } from '@/components/gastown/AdminViewingBanner';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useRouter } from 'next/navigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button as UiButton } from '@/components/ui/button';

type Props = { townId: string; readOnly?: boolean; organizationId?: string };

type EnvVarEntry = { key: string; value: string; isNew?: boolean };

// Section definitions for the scrollspy nav
const SECTIONS = [
  { id: 'git-auth', label: 'Git Authentication', icon: GitBranch },
  { id: 'github-cli', label: 'GitHub CLI', icon: Key },
  { id: 'commit-identity', label: 'Commit Identity', icon: User },
  { id: 'env-vars', label: 'Environment Variables', icon: Variable },
  { id: 'agent-defaults', label: 'Agent Defaults', icon: Bot },
  { id: 'convoys', label: 'Convoys', icon: Layers },
  { id: 'merge-strategy', label: 'Merge Strategy', icon: GitPullRequest },
  { id: 'refinery', label: 'Refinery', icon: Shield },
  { id: 'container', label: 'Container', icon: Container },
  { id: 'custom-instructions', label: 'Custom Instructions', icon: MessageSquareText },
  { id: 'danger-zone', label: 'Danger Zone', icon: Trash2 },
] as const;

function useScrollSpy(sectionIds: readonly string[]) {
  const [activeId, setActiveId] = useState<string>(sectionIds[0]);
  const suppressRef = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (suppressRef.current) return;
        // Find the topmost visible section
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
    const header = document.getElementById('settings-sticky-header');
    if (!el) return;

    // Immediately highlight the target and suppress observer during scroll
    setActiveId(id);
    suppressRef.current = true;

    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    const top = el.getBoundingClientRect().top + window.scrollY - headerHeight - 24;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

    // Re-enable observer after scroll settles
    setTimeout(() => {
      suppressRef.current = false;
    }, 1000);
  }

  return { activeId, scrollTo };
}

export function TownSettingsPageClient({ townId, readOnly = false, organizationId }: Props) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const router = useRouter();

  const deleteTown = useMutation(
    trpc.gastown.deleteTown.mutationOptions({
      onSuccess: () => {
        toast.success('Town deleted');
        router.push('/gastown');
      },
      onError: err => toast.error(`Failed to delete town: ${err.message}`),
    })
  );

  const deleteOrgTown = useMutation(
    trpc.gastown.deleteOrgTown.mutationOptions({
      onSuccess: () => {
        toast.success('Town deleted');
        if (organizationId) {
          router.push(`/organizations/${organizationId}/gastown`);
        }
      },
      onError: err => toast.error(`Failed to delete town: ${err.message}`),
    })
  );

  const handleDeleteTown = () => {
    if (organizationId) {
      deleteOrgTown.mutate({ organizationId, townId });
    } else {
      deleteTown.mutate({ townId });
    }
  };

  const {
    data: modelsData,
    isLoading: isLoadingModels,
    error: modelsError,
  } = useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(
    () => modelsData?.data.map(model => ({ id: model.id, name: model.name })) ?? [],
    [modelsData]
  );

  const townQuery = useQuery(trpc.gastown.getTown.queryOptions({ townId }));
  const configQuery = useQuery(trpc.gastown.getTownConfig.queryOptions({ townId }));
  const adminAccessQuery = useQuery(trpc.gastown.checkAdminAccess.queryOptions({ townId }));

  // Admin viewing another user's town → force read-only
  const isAdminViewing = adminAccessQuery.data?.isAdminViewing ?? false;
  const effectiveReadOnly =
    isAdminViewing || (readOnly && currentUser?.id !== configQuery.data?.created_by_user_id);

  // Track server-side values so we can detect changes that require a reload
  const savedModelRef = useRef<string>('');
  const savedMayorModelRef = useRef<string>('');
  const savedGithubCliPatRef = useRef<string>('');
  const savedGithubTokenRef = useRef<string>('');
  const savedGitlabTokenRef = useRef<string>('');
  const savedGitlabInstanceUrlRef = useRef<string>('');

  const updateConfig = useMutation(
    trpc.gastown.updateTownConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getTownConfig.queryKey({ townId }),
        });

        const defaultModelChanged = defaultModel !== savedModelRef.current;
        const effectiveMayor = mayorModel || defaultModel;
        const previousEffectiveMayor = savedMayorModelRef.current || savedModelRef.current;
        const mayorEffectiveChanged = effectiveMayor !== previousEffectiveMayor;

        // Detect auth config changes that trigger an SDK server restart.
        // Compare against the non-masked form: if the current value starts
        // with "****" it wasn't changed by the user, so skip the comparison.
        const ghCliPatChanged =
          !githubCliPat.startsWith('****') && githubCliPat !== savedGithubCliPatRef.current;
        const ghTokenChanged =
          !githubToken.startsWith('****') && githubToken !== savedGithubTokenRef.current;
        const glTokenChanged =
          !gitlabToken.startsWith('****') && gitlabToken !== savedGitlabTokenRef.current;
        const glInstanceUrlChanged = gitlabInstanceUrl !== savedGitlabInstanceUrlRef.current;
        const authChanged =
          ghCliPatChanged || ghTokenChanged || glTokenChanged || glInstanceUrlChanged;

        savedModelRef.current = defaultModel;
        savedMayorModelRef.current = mayorModel;
        if (!githubCliPat.startsWith('****')) savedGithubCliPatRef.current = githubCliPat;
        if (!githubToken.startsWith('****')) savedGithubTokenRef.current = githubToken;
        if (!gitlabToken.startsWith('****')) savedGitlabTokenRef.current = gitlabToken;
        savedGitlabInstanceUrlRef.current = gitlabInstanceUrl;

        if (defaultModelChanged || mayorEffectiveChanged || authChanged) {
          const reason = authChanged ? 'credential change' : 'model change';
          toast.success(`Configuration saved — reloading for ${reason}…`);
          // Reload after a brief delay so the server-side SDK server
          // restart has time to complete.
          setTimeout(() => window.location.reload(), 2000);
        } else {
          toast.success('Configuration saved');
        }
      },
      onError: err => toast.error(err.message),
    })
  );

  const refreshToken = useMutation(
    trpc.gastown.refreshContainerToken.mutationOptions({
      onSuccess: () => toast.success('Container token refreshed'),
      onError: err => toast.error(`Token refresh failed: ${err.message}`),
    })
  );

  const restartContainer = useMutation(
    trpc.gastown.forceRestartContainer.mutationOptions({
      onSuccess: () =>
        toast.success('Container stopping gracefully — agents will save work before exiting'),
      onError: err => toast.error(`Container restart failed: ${err.message}`),
    })
  );

  const destroyContainer = useMutation(
    trpc.gastown.destroyContainer.mutationOptions({
      onSuccess: () => toast.success('Container destroyed — it will restart on next dispatch'),
      onError: err => toast.error(`Container destroy failed: ${err.message}`),
    })
  );

  // Local state for form fields
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
  const [githubToken, setGithubToken] = useState('');
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [smallModel, setSmallModel] = useState('');
  const [mayorModel, setMayorModel] = useState('');
  const [refineryModel, setRefineryModel] = useState('');
  const [polecatModel, setPolecatModel] = useState('');
  const [maxPolecats, setMaxPolecats] = useState<number | undefined>(undefined);
  const [refineryGates, setRefineryGates] = useState<string[]>([]);
  const [autoMerge, setAutoMerge] = useState(true);
  const [refineryCodeReview, setRefineryCodeReview] = useState(true);
  const [reviewMode, setReviewMode] = useState<'rework' | 'comments'>('rework');
  const [autoResolvePrFeedback, setAutoResolvePrFeedback] = useState(false);
  const [autoMergeDelayMinutes, setAutoMergeDelayMinutes] = useState<number | null>(null);
  const [mergeStrategy, setMergeStrategy] = useState<'direct' | 'pr'>('direct');
  const [stagedConvoysDefault, setStagedConvoysDefault] = useState(false);
  const [convoyMergeMode, setConvoyMergeMode] = useState<'review-then-land' | 'review-and-merge'>(
    'review-then-land'
  );
  const [githubCliPat, setGithubCliPat] = useState('');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [disableAiCoauthor, setDisableAiCoauthor] = useState(false);
  const [polecatInstructions, setPolecatInstructions] = useState('');
  const [refineryInstructions, setRefineryInstructions] = useState('');
  const [mayorInstructions, setMayorInstructions] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [showTokens, setShowTokens] = useState(false);

  // Sync config into local state when loaded
  if (configQuery.data && !initialized) {
    const cfg = configQuery.data;
    setEnvVars(Object.entries(cfg.env_vars).map(([key, value]) => ({ key, value })));
    setGithubToken(cfg.git_auth?.github_token ?? '');
    setGitlabToken(cfg.git_auth?.gitlab_token ?? '');
    setGitlabInstanceUrl(cfg.git_auth?.gitlab_instance_url ?? '');
    setDefaultModel(cfg.default_model ?? '');
    savedModelRef.current = cfg.default_model ?? '';
    setSmallModel(cfg.small_model ?? '');
    setMayorModel(cfg.role_models?.mayor ?? '');
    setRefineryModel(cfg.role_models?.refinery ?? '');
    setPolecatModel(cfg.role_models?.polecat ?? '');
    savedMayorModelRef.current = cfg.role_models?.mayor ?? '';
    setMaxPolecats(cfg.max_polecats_per_rig);
    setRefineryGates(cfg.refinery?.gates ?? []);
    setAutoMerge(cfg.refinery?.auto_merge ?? true);
    setRefineryCodeReview(cfg.refinery?.code_review ?? true);
    setReviewMode(cfg.refinery?.review_mode === 'comments' ? 'comments' : 'rework');
    setAutoResolvePrFeedback(cfg.refinery?.auto_resolve_pr_feedback ?? false);
    setAutoMergeDelayMinutes(cfg.refinery?.auto_merge_delay_minutes ?? null);
    setMergeStrategy(cfg.merge_strategy === 'pr' ? 'pr' : 'direct');
    setStagedConvoysDefault(cfg.staged_convoys_default ?? false);
    setConvoyMergeMode(
      cfg.convoy_merge_mode === 'review-and-merge' ? 'review-and-merge' : 'review-then-land'
    );
    setGithubCliPat(cfg.github_cli_pat ?? '');
    savedGithubCliPatRef.current = cfg.github_cli_pat ?? '';
    savedGithubTokenRef.current = cfg.git_auth?.github_token ?? '';
    savedGitlabTokenRef.current = cfg.git_auth?.gitlab_token ?? '';
    savedGitlabInstanceUrlRef.current = cfg.git_auth?.gitlab_instance_url ?? '';
    setGitAuthorName(cfg.git_author_name ?? '');
    setGitAuthorEmail(cfg.git_author_email ?? '');
    setDisableAiCoauthor(cfg.disable_ai_coauthor ?? false);
    setPolecatInstructions(cfg.custom_instructions?.polecat ?? '');
    setRefineryInstructions(cfg.custom_instructions?.refinery ?? '');
    setMayorInstructions(cfg.custom_instructions?.mayor ?? '');
    setInitialized(true);
  }

  const { activeId: activeSection, scrollTo: scrollToSection } = useScrollSpy(
    SECTIONS.map(s => s.id)
  );

  function handleSave() {
    const envVarObj: Record<string, string> = {};
    for (const entry of envVars) {
      if (entry.key.trim()) {
        envVarObj[entry.key.trim()] = entry.value;
      }
    }

    updateConfig.mutate({
      townId,
      config: {
        env_vars: envVarObj,
        git_auth: {
          // Omit masked values to preserve the real secret server-side.
          // Send empty string to clear, real value to update.
          ...(githubToken.startsWith('****') ? {} : { github_token: githubToken }),
          ...(gitlabToken.startsWith('****') ? {} : { gitlab_token: gitlabToken }),
          gitlab_instance_url: gitlabInstanceUrl,
        },
        default_model: defaultModel,
        small_model: smallModel || undefined,
        role_models: {
          mayor: mayorModel || undefined,
          refinery: refineryModel || undefined,
          polecat: polecatModel || undefined,
        },
        ...(maxPolecats ? { max_polecats_per_rig: maxPolecats } : {}),
        // Omit masked values to preserve the real secret; send empty string to clear.
        ...(githubCliPat.startsWith('****') ? {} : { github_cli_pat: githubCliPat }),
        git_author_name: gitAuthorName,
        git_author_email: gitAuthorEmail,
        disable_ai_coauthor: disableAiCoauthor,
        merge_strategy: mergeStrategy,
        staged_convoys_default: stagedConvoysDefault,
        refinery: {
          gates: refineryGates.filter(g => g.trim()),
          auto_merge: autoMerge,
          code_review: refineryCodeReview,
          review_mode: reviewMode,
          require_clean_merge: true,
          auto_resolve_pr_feedback: autoResolvePrFeedback,
          auto_merge_delay_minutes: autoMergeDelayMinutes,
        },
        convoy_merge_mode: convoyMergeMode,
        custom_instructions: {
          polecat: polecatInstructions || undefined,
          refinery: refineryInstructions || undefined,
          mayor: mayorInstructions || undefined,
        },
      },
    });
  }

  function addEnvVar() {
    setEnvVars(prev => [...prev, { key: '', value: '', isNew: true }]);
  }

  function removeEnvVar(index: number) {
    setEnvVars(prev => prev.filter((_, i) => i !== index));
  }

  function updateEnvVar(index: number, field: 'key' | 'value', val: string) {
    setEnvVars(prev => prev.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry)));
  }

  function addRefineryGate() {
    setRefineryGates(prev => [...prev, '']);
  }

  function removeRefineryGate(index: number) {
    setRefineryGates(prev => prev.filter((_, i) => i !== index));
  }

  function updateRefineryGate(index: number, val: string) {
    setRefineryGates(prev => prev.map((g, i) => (i === index ? val : g)));
  }

  if (townQuery.isLoading || configQuery.isLoading) {
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
      <AdminViewingBanner townId={townId} />
      {/* Top bar */}
      <div
        id="settings-sticky-header"
        className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3"
      >
        <div className="flex items-center gap-2.5">
          <SidebarTrigger className="-ml-3" />
          <Settings className="size-4 text-white/40" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Settings</h1>
          <span className="text-sm text-white/30">{townQuery.data?.name}</span>
        </div>
        {!effectiveReadOnly && (
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
        )}
        {effectiveReadOnly && (
          <span className="text-xs text-white/30">
            View only — only town creators and org owners can edit
          </span>
        )}
      </div>

      {/* Two-column body — viewport scrolls so sticky works */}
      <div className="scroll-smooth">
        <div className="mx-auto flex max-w-4xl px-6">
          {/* Main content */}
          <div className="min-w-0 flex-1">
            <div className="space-y-8 pt-6" style={{ paddingBottom: '75vh' }}>
              {/* ── Git Authentication ──────────────────────────────── */}
              <SettingsSection
                id="git-auth"
                title="Git Authentication"
                description="Tokens used for cloning and pushing to private repositories."
                icon={GitBranch}
                index={0}
              >
                <div className="mb-4 flex items-center gap-2">
                  <button
                    onClick={() => setShowTokens(!showTokens)}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/65"
                  >
                    {showTokens ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                    {showTokens ? 'Hide tokens' : 'Reveal tokens'}
                  </button>
                </div>

                <div className="space-y-4">
                  <FieldGroup
                    label="GitHub Token (PAT or Installation Token)"
                    hint="Used to authenticate git clone and git push for GitHub repos."
                  >
                    <Input
                      type={showTokens ? 'text' : 'password'}
                      value={githubToken}
                      onChange={e => setGithubToken(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxx"
                      className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>

                  <FieldGroup label="GitLab Token">
                    <Input
                      type={showTokens ? 'text' : 'password'}
                      value={gitlabToken}
                      onChange={e => setGitlabToken(e.target.value)}
                      placeholder="glpat-xxxxxxxxxxxx"
                      className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>

                  <FieldGroup label="GitLab Instance URL" hint="For self-hosted GitLab.">
                    <Input
                      value={gitlabInstanceUrl}
                      onChange={e => setGitlabInstanceUrl(e.target.value)}
                      placeholder="https://gitlab.example.com"
                      className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── GitHub CLI ─────────────────────────────────────── */}
              <SettingsSection
                id="github-cli"
                title="GitHub CLI"
                description="Personal Access Token used exclusively for gh CLI operations (PRs, issues, reviews). Git clone and push still use the integration token above."
                icon={Key}
                index={1}
              >
                <div className="space-y-4">
                  <FieldGroup
                    label="GitHub Personal Access Token"
                    hint="When set, PRs and issues created by agents will appear under your GitHub identity. Requires repo scope (or fine-grained: contents, pull_requests, issues)."
                  >
                    <Input
                      type={showTokens ? 'text' : 'password'}
                      value={githubCliPat}
                      onChange={e => setGithubCliPat(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxx or github_pat_xxxxxxxxxxxx"
                      className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── Commit Identity ─────────────────────────────────── */}
              <SettingsSection
                id="commit-identity"
                title="Commit Identity"
                description="Override the git commit author. When set, you become the primary author and the AI agent is added as co-author."
                icon={User}
                index={2}
              >
                <div className="space-y-4">
                  <FieldGroup
                    label="Author Name"
                    hint="Used as GIT_AUTHOR_NAME and GIT_COMMITTER_NAME for all commits in this town."
                  >
                    <Input
                      value={gitAuthorName}
                      onChange={e => setGitAuthorName(e.target.value)}
                      placeholder="Jane Smith"
                      className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>
                  <FieldGroup
                    label="Author Email"
                    hint="Used as GIT_AUTHOR_EMAIL and GIT_COMMITTER_EMAIL."
                  >
                    <Input
                      value={gitAuthorEmail}
                      onChange={e => setGitAuthorEmail(e.target.value)}
                      placeholder="jane@example.com"
                      className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>

                  <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div className="flex-1">
                      <Label className="text-sm text-white/70">Disable AI co-authorship</Label>
                      <p className="text-[11px] text-white/30">
                        When enabled, the AI agent&apos;s Co-authored-by trailer is omitted from
                        commits. Only takes effect when Author Name is set.
                      </p>
                    </div>
                    <Switch
                      checked={disableAiCoauthor}
                      onCheckedChange={setDisableAiCoauthor}
                      disabled={!gitAuthorName}
                    />
                  </div>
                </div>
              </SettingsSection>

              {/* ── Environment Variables ────────────────────────────── */}
              <SettingsSection
                id="env-vars"
                title="Environment Variables"
                description="Injected into all agent processes. Agent-level overrides take precedence."
                icon={Variable}
                index={3}
                action={
                  <button
                    onClick={addEnvVar}
                    className="inline-flex items-center gap-1 rounded-md bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/70"
                  >
                    <Plus className="size-3" />
                    Add
                  </button>
                }
              >
                {envVars.length === 0 ? (
                  <p className="text-xs text-white/25">No environment variables configured.</p>
                ) : (
                  <div className="space-y-2">
                    {envVars.map((entry, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="flex items-center gap-2"
                      >
                        <Input
                          value={entry.key}
                          onChange={e => updateEnvVar(i, 'key', e.target.value)}
                          placeholder="KEY"
                          className="w-40 border-white/[0.08] bg-white/[0.03] font-mono text-xs text-white/85 placeholder:text-white/20"
                        />
                        <span className="text-[10px] text-white/20">=</span>
                        <Input
                          value={entry.value}
                          onChange={e => updateEnvVar(i, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-1 border-white/[0.08] bg-white/[0.03] font-mono text-xs text-white/85 placeholder:text-white/20"
                        />
                        <button
                          onClick={() => removeEnvVar(i)}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                )}
              </SettingsSection>

              {/* ── Agent Defaults ───────────────────────────────────── */}
              <SettingsSection
                id="agent-defaults"
                title="Agent Defaults"
                description="Default configuration applied to newly spawned agents."
                icon={Bot}
                index={4}
              >
                <div className="space-y-4">
                  <FieldGroup label="Default Model">
                    {modelsError ? (
                      <Input
                        value={defaultModel}
                        onChange={e => setDefaultModel(e.target.value)}
                        placeholder="e.g. anthropic/claude-sonnet-4.6"
                        className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                      />
                    ) : (
                      <ModelCombobox
                        label=""
                        models={modelOptions}
                        value={defaultModel}
                        onValueChange={setDefaultModel}
                        isLoading={isLoadingModels}
                        placeholder="Select a model"
                        className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                      />
                    )}
                  </FieldGroup>

                  <FieldGroup
                    label="Small Model"
                    hint="Lightweight model for titles, summaries, and explore subagent. Defaults to Claude Haiku if not set."
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        {modelsError ? (
                          <Input
                            value={smallModel}
                            onChange={e => setSmallModel(e.target.value)}
                            placeholder="e.g. anthropic/claude-haiku-4.5"
                            className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                          />
                        ) : (
                          <ModelCombobox
                            label=""
                            models={modelOptions}
                            value={smallModel}
                            onValueChange={setSmallModel}
                            isLoading={isLoadingModels}
                            placeholder="Default (Claude Haiku)"
                            className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                          />
                        )}
                      </div>
                      {smallModel && (
                        <button
                          onClick={() => setSmallModel('')}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                          title="Reset to default"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </FieldGroup>

                  <Accordion type="single" collapsible className="border-none">
                    <AccordionItem value="role-overrides" className="border-none">
                      <AccordionTrigger className="py-0 text-xs text-white/40 hover:text-white/60 hover:no-underline">
                        Override by role (optional)
                      </AccordionTrigger>
                      <AccordionContent className="space-y-4 pt-2">
                        {(
                          [
                            ['Mayor', mayorModel, setMayorModel],
                            ['Refinery', refineryModel, setRefineryModel],
                            ['Polecat', polecatModel, setPolecatModel],
                          ] as const
                        ).map(([roleLabel, roleValue, setRoleValue]) => (
                          <FieldGroup key={roleLabel} label={roleLabel}>
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                {modelsError ? (
                                  <Input
                                    value={roleValue}
                                    onChange={e => setRoleValue(e.target.value)}
                                    placeholder="Use default"
                                    className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                                  />
                                ) : (
                                  <ModelCombobox
                                    label=""
                                    models={modelOptions}
                                    value={roleValue}
                                    onValueChange={setRoleValue}
                                    isLoading={isLoadingModels}
                                    placeholder="Use default"
                                    className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
                                  />
                                )}
                              </div>
                              {roleValue && (
                                <button
                                  onClick={() => setRoleValue('')}
                                  className="rounded p-1 text-white/25 transition-colors hover:bg-white/[0.06] hover:text-white/50"
                                  title="Reset to default"
                                >
                                  <X className="size-3.5" />
                                </button>
                              )}
                            </div>
                          </FieldGroup>
                        ))}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>

                  <FieldGroup
                    label="Max Polecats per Rig"
                    hint="Upper bound on concurrent worker agents per rig."
                  >
                    <div className="flex items-center gap-3">
                      <Slider
                        min={1}
                        max={50}
                        value={[maxPolecats ?? 5]}
                        onValueChange={([v]) => setMaxPolecats(v)}
                        className="w-full"
                      />
                      <span className="w-8 shrink-0 text-right font-mono text-sm text-white/70">
                        {maxPolecats ?? 5}
                      </span>
                    </div>
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── Convoys ──────────────────────────────────────── */}
              <SettingsSection
                id="convoys"
                title="Convoys"
                description="Settings for convoy (batch task) behavior."
                icon={Layers}
                index={5}
              >
                <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <div className="flex-1">
                    <Label className="text-sm text-white/70">Stage convoys by default</Label>
                    <p className="text-[11px] text-white/30">
                      When enabled, new convoys are created in staged mode — agents are not
                      dispatched until the convoy is explicitly started. This gives the mayor a
                      chance to review and adjust the plan before execution begins.
                    </p>
                  </div>
                  <Switch
                    checked={stagedConvoysDefault}
                    onCheckedChange={setStagedConvoysDefault}
                  />
                </div>

                <div className="mt-3">
                  <Label className="text-sm text-white/70">Default merge mode</Label>
                  <p className="mb-2 text-[11px] text-white/30">
                    Controls how convoy beads are merged.
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
                  </div>
                </div>
              </SettingsSection>

              {/* ── Merge Strategy ──────────────────────────────────── */}
              <SettingsSection
                id="merge-strategy"
                title="Merge Strategy"
                description="How agent work lands in the default branch. Per-rig overrides coming soon."
                icon={GitPullRequest}
                index={6}
              >
                <div className="space-y-3">
                  <MergeStrategyOption
                    selected={mergeStrategy === 'direct'}
                    onSelect={() => setMergeStrategy('direct')}
                    label="Direct push"
                    description="Refinery pushes merged code directly to the default branch. No PR, no human review step. Quality gates are the only check."
                  />
                  <MergeStrategyOption
                    selected={mergeStrategy === 'pr'}
                    onSelect={() => setMergeStrategy('pr')}
                    label="Pull request"
                    description="Refinery creates a GitHub PR or GitLab MR for human review. Code lands only after a human approves."
                  />
                </div>
              </SettingsSection>

              {/* ── Refinery (Quality Gates) ─────────────────────────── */}
              <SettingsSection
                id="refinery"
                title="Refinery"
                description="Quality gates run before merging polecat branches into the default branch."
                icon={Shield}
                index={7}
                action={
                  <button
                    onClick={addRefineryGate}
                    className="inline-flex items-center gap-1 rounded-md bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/70"
                  >
                    <Plus className="size-3" />
                    Add Gate
                  </button>
                }
              >
                {refineryGates.length === 0 ? (
                  <p className="text-xs text-white/25">No quality gates configured.</p>
                ) : (
                  <div className="space-y-2">
                    {refineryGates.map((gate, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="flex items-center gap-2"
                      >
                        <Input
                          value={gate}
                          onChange={e => updateRefineryGate(i, e.target.value)}
                          placeholder="npm test"
                          className="flex-1 border-white/[0.08] bg-white/[0.03] font-mono text-xs text-white/85 placeholder:text-white/20"
                        />
                        <button
                          onClick={() => removeRefineryGate(i)}
                          className="rounded p-1 text-white/25 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <div className="flex-1">
                    <Label className="text-sm text-white/70">Auto-merge</Label>
                    <p className="text-[11px] text-white/30">
                      Automatically merge when all gates pass.
                    </p>
                  </div>
                  <Switch checked={autoMerge} onCheckedChange={setAutoMerge} />
                </div>

                <div className="mt-3 flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <div className="flex-1">
                    <Label className="text-sm text-white/70">Refinery code review</Label>
                    <p className="text-[11px] text-white/30">
                      The refinery agent reviews PRs — runs quality gates, checks the diff, and may
                      request rework. When disabled, PRs skip the refinery entirely.
                    </p>
                  </div>
                  <Switch checked={refineryCodeReview} onCheckedChange={setRefineryCodeReview} />
                </div>

                {refineryCodeReview && (
                  <div className="mt-3">
                    <Label className="text-sm text-white/70">Review mode</Label>
                    <p className="mb-2 text-[11px] text-white/30">
                      How the refinery communicates its findings.
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
                        onClick={() => mergeStrategy === 'pr' && setReviewMode('comments')}
                        disabled={mergeStrategy !== 'pr'}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          reviewMode === 'comments'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : mergeStrategy !== 'pr'
                              ? 'cursor-not-allowed border-white/[0.03] bg-white/[0.01] text-white/20'
                              : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:border-white/10'
                        }`}
                      >
                        <div className="font-medium">PR comments</div>
                        <div className="mt-0.5 text-[10px] opacity-60">
                          {mergeStrategy !== 'pr'
                            ? 'Requires Pull Request merge strategy.'
                            : 'Posts GitHub review comments on the PR.'}
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <div className="flex-1">
                    <Label className="text-sm text-white/70">Auto-resolve PR feedback</Label>
                    <p className="text-[11px] text-white/30">
                      When enabled, a polecat is automatically dispatched to address unresolved
                      review comments and failing CI checks on open PRs.
                    </p>
                  </div>
                  <Switch
                    checked={autoResolvePrFeedback}
                    onCheckedChange={setAutoResolvePrFeedback}
                  />
                </div>

                {autoResolvePrFeedback && (
                  <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <Label className="mb-1.5 block text-sm text-white/70">Auto-merge delay</Label>
                    <p className="mb-3 text-[11px] text-white/30">
                      After all CI checks pass and all review threads are resolved, automatically
                      merge the PR after this delay. Leave empty to require manual merge.
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
                      </div>
                      {autoMergeDelayMinutes !== null && (
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
                )}
              </SettingsSection>

              {/* ── Container ──────────────────────────────────────── */}
              <SettingsSection
                id="container"
                title="Container"
                description="Manage the town's container runtime and authentication tokens."
                icon={Container}
                index={8}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div>
                      <p className="text-sm text-white/70">Container Token</p>
                      <p className="text-[11px] text-white/30">
                        JWT shared by all agents in the container. Auto-refreshed hourly (8h
                        expiry). Force a refresh if agents are experiencing auth failures.
                      </p>
                    </div>
                    <Button
                      onClick={() => refreshToken.mutate({ townId })}
                      disabled={refreshToken.isPending || effectiveReadOnly}
                      variant="secondary"
                      size="sm"
                      className="ml-4 shrink-0 gap-1.5"
                    >
                      <RefreshCw
                        className={`size-3 ${refreshToken.isPending ? 'animate-spin' : ''}`}
                      />
                      {refreshToken.isPending ? 'Refreshing...' : 'Refresh Token'}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div>
                      <p className="text-sm text-white/70">Graceful Stop</p>
                      <p className="text-[11px] text-white/30">
                        Sends SIGTERM — agents save their work before the container exits. It will
                        restart on the next dispatch cycle.
                      </p>
                    </div>
                    <Button
                      onClick={() => restartContainer.mutate({ townId })}
                      disabled={restartContainer.isPending || effectiveReadOnly}
                      variant="secondary"
                      size="sm"
                      className="ml-4 shrink-0 gap-1.5"
                    >
                      <RotateCcw
                        className={`size-3 ${restartContainer.isPending ? 'animate-spin' : ''}`}
                      />
                      {restartContainer.isPending ? 'Stopping...' : 'Graceful Stop'}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <div>
                      <p className="text-sm text-red-400">Destroy Container</p>
                      <p className="text-[11px] text-red-400/70">
                        Sends SIGKILL — the container dies immediately with no graceful drain. Use
                        when the container is stuck or unresponsive.
                      </p>
                    </div>
                    <Button
                      onClick={() => destroyContainer.mutate({ townId })}
                      disabled={destroyContainer.isPending || effectiveReadOnly}
                      variant="secondary"
                      size="sm"
                      className="ml-4 shrink-0 gap-1.5"
                    >
                      <Power
                        className={`size-3 ${destroyContainer.isPending ? 'animate-spin' : ''}`}
                      />
                      {destroyContainer.isPending ? 'Destroying...' : 'Destroy Container'}
                    </Button>
                  </div>
                </div>
              </SettingsSection>

              {/* ── Custom Instructions ────────────────────────────────── */}
              <SettingsSection
                id="custom-instructions"
                title="Custom Instructions"
                description="Customize the system prompt for each agent role. These instructions are appended to the default prompt and apply to all agents of that role."
                icon={MessageSquareText}
                index={10}
              >
                <div className="space-y-5">
                  {(
                    [
                      ['Polecat Instructions', polecatInstructions, setPolecatInstructions],
                      ['Refinery Instructions', refineryInstructions, setRefineryInstructions],
                      ['Mayor Instructions', mayorInstructions, setMayorInstructions],
                    ] as const
                  ).map(([roleLabel, value, setValue]) => (
                    <FieldGroup key={roleLabel} label={roleLabel}>
                      <div className="relative">
                        <Textarea
                          value={value}
                          onChange={e => setValue(e.target.value.slice(0, 2000))}
                          placeholder={`Custom instructions for ${roleLabel.replace(' Instructions', '').toLowerCase()} agents…`}
                          rows={4}
                          className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                        />
                        <span className="absolute right-2 bottom-2 text-[10px] text-white/20">
                          {value.length} / 2000
                        </span>
                      </div>
                    </FieldGroup>
                  ))}
                </div>
              </SettingsSection>

              {/* ── Danger Zone ──────────────────────────────────────── */}
              <SettingsSection
                id="danger-zone"
                title="Danger Zone"
                description="Irreversible actions for this town."
                icon={Trash2}
                index={11}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <div>
                      <p className="text-sm text-red-400">Delete Town</p>
                      <p className="text-[11px] text-red-400/70">
                        Permanently delete this town, all its agents, and all data. This action
                        cannot be undone.
                      </p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <UiButton
                          disabled={
                            deleteTown.isPending || deleteOrgTown.isPending || effectiveReadOnly
                          }
                          variant="secondary"
                          size="sm"
                          className="ml-4 shrink-0 gap-1.5"
                        >
                          <Trash2 className="size-3" />
                          Delete Town
                        </UiButton>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-red-500/20 bg-[oklch(0.15_0_0)] sm:max-w-md">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-red-400">
                            Delete this town?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-white/70">
                            This action cannot be undone. This will permanently delete the town and
                            all of its associated data, including agents, rigs, and settings.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleDeleteTown}
                            className="bg-red-500/80 text-white hover:bg-red-500"
                          >
                            {deleteTown.isPending || deleteOrgTown.isPending
                              ? 'Deleting...'
                              : 'Yes, delete town'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
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
                            layoutId="settings-nav-indicator"
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
              {!effectiveReadOnly && (
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
              )}
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
      className={`flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
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
