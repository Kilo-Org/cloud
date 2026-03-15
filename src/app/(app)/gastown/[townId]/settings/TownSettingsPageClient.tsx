'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
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
  Container,
} from 'lucide-react';
import { motion } from 'motion/react';

type Props = { townId: string };

type EnvVarEntry = { key: string; value: string; isNew?: boolean };

// Section definitions for the scrollspy nav
const SECTIONS = [
  { id: 'git-auth', label: 'Git Authentication', icon: GitBranch },
  { id: 'env-vars', label: 'Environment Variables', icon: Variable },
  { id: 'agent-defaults', label: 'Agent Defaults', icon: Bot },
  { id: 'convoys', label: 'Convoys', icon: Layers },
  { id: 'merge-strategy', label: 'Merge Strategy', icon: GitPullRequest },
  { id: 'refinery', label: 'Refinery', icon: Shield },
  { id: 'container', label: 'Container', icon: Container },
] as const;

function useScrollSpy(sectionIds: readonly string[]) {
  const [activeId, setActiveId] = useState<string>(sectionIds[0]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        // Find the topmost visible section
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

export function TownSettingsPageClient({ townId }: Props) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const townQuery = useQuery(trpc.gastown.getTown.queryOptions({ townId }));
  const configQuery = useQuery(trpc.gastown.getTownConfig.queryOptions({ townId }));

  const updateConfig = useMutation(
    trpc.gastown.updateTownConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getTownConfig.queryKey({ townId }),
        });
        toast.success('Configuration saved');
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

  // Local state for form fields
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
  const [githubToken, setGithubToken] = useState('');
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [maxPolecats, setMaxPolecats] = useState<number | undefined>(undefined);
  const [refineryGates, setRefineryGates] = useState<string[]>([]);
  const [autoMerge, setAutoMerge] = useState(true);
  const [mergeStrategy, setMergeStrategy] = useState<'direct' | 'pr'>('direct');
  const [stagedConvoysDefault, setStagedConvoysDefault] = useState(false);
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
    setMaxPolecats(cfg.max_polecats_per_rig);
    setRefineryGates(cfg.refinery?.gates ?? []);
    setAutoMerge(cfg.refinery?.auto_merge ?? true);
    setMergeStrategy(cfg.merge_strategy === 'pr' ? 'pr' : 'direct');
    setStagedConvoysDefault(cfg.staged_convoys_default ?? false);
    setInitialized(true);
  }

  const activeSection = useScrollSpy(SECTIONS.map(s => s.id));

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
          ...(githubToken && !githubToken.startsWith('****') ? { github_token: githubToken } : {}),
          ...(gitlabToken && !gitlabToken.startsWith('****') ? { gitlab_token: gitlabToken } : {}),
          ...(gitlabInstanceUrl ? { gitlab_instance_url: gitlabInstanceUrl } : {}),
        },
        ...(defaultModel ? { default_model: defaultModel } : {}),
        ...(maxPolecats ? { max_polecats_per_rig: maxPolecats } : {}),
        merge_strategy: mergeStrategy,
        staged_convoys_default: stagedConvoysDefault,
        refinery: {
          gates: refineryGates.filter(g => g.trim()),
          auto_merge: autoMerge,
          require_clean_merge: true,
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
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2.5">
          <Settings className="size-4 text-white/40" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Settings</h1>
          <span className="text-sm text-white/30">{townQuery.data?.name}</span>
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

      {/* Two-column body — single scroll container so sticky works */}
      <div className="flex-1 overflow-y-auto scroll-smooth">
        <div className="flex">
          {/* Main content */}
          <div className="min-w-0 flex-1">
            <div className="mx-auto max-w-2xl space-y-8 px-6 pt-6 pb-24">
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

              {/* ── Environment Variables ────────────────────────────── */}
              <SettingsSection
                id="env-vars"
                title="Environment Variables"
                description="Injected into all agent processes. Agent-level overrides take precedence."
                icon={Variable}
                index={1}
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
                index={2}
              >
                <div className="space-y-4">
                  <FieldGroup label="Default Model">
                    <Input
                      value={defaultModel}
                      onChange={e => setDefaultModel(e.target.value)}
                      placeholder="anthropic/claude-sonnet-4.6"
                      className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>

                  <FieldGroup
                    label="Max Polecats per Rig"
                    hint="Upper bound on concurrent worker agents per rig."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={maxPolecats ?? ''}
                      onChange={e =>
                        setMaxPolecats(e.target.value ? parseInt(e.target.value, 10) : undefined)
                      }
                      placeholder="5"
                      className="w-28 border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>
                </div>
              </SettingsSection>

              {/* ── Convoys ──────────────────────────────────────── */}
              <SettingsSection
                id="convoys"
                title="Convoys"
                description="Settings for convoy (batch task) behavior."
                icon={Layers}
                index={3}
              >
                <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <Switch
                    checked={stagedConvoysDefault}
                    onCheckedChange={setStagedConvoysDefault}
                  />
                  <div>
                    <Label className="text-sm text-white/70">Stage convoys by default</Label>
                    <p className="text-[11px] text-white/30">
                      When enabled, new convoys are created in staged mode — agents are not
                      dispatched until the convoy is explicitly started. This gives the mayor a
                      chance to review and adjust the plan before execution begins.
                    </p>
                  </div>
                </div>
              </SettingsSection>

              {/* ── Merge Strategy ──────────────────────────────────── */}
              <SettingsSection
                id="merge-strategy"
                title="Merge Strategy"
                description="How agent work lands in the default branch. Per-rig overrides coming soon."
                icon={GitPullRequest}
                index={4}
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
                index={5}
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
                  <Switch checked={autoMerge} onCheckedChange={setAutoMerge} />
                  <div>
                    <Label className="text-sm text-white/70">Auto-merge</Label>
                    <p className="text-[11px] text-white/30">
                      Automatically merge when all gates pass.
                    </p>
                  </div>
                </div>
              </SettingsSection>

              {/* ── Container ──────────────────────────────────────── */}
              <SettingsSection
                id="container"
                title="Container"
                description="Manage the town's container runtime and authentication tokens."
                icon={Container}
                index={6}
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
                      disabled={refreshToken.isPending}
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
                </div>
              </SettingsSection>
            </div>
          </div>

          {/* Right sidebar — sticky scrollspy nav */}
          <div className="hidden w-52 shrink-0 lg:block">
            <nav className="sticky top-6 px-4 pt-6">
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
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                          isActive
                            ? 'bg-white/[0.06] text-white/80'
                            : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                        }`}
                      >
                        <SectionIcon className="size-3 shrink-0" />
                        <span>{section.label}</span>
                        {isActive && (
                          <motion.div
                            layoutId="settings-nav-indicator"
                            className="ml-auto size-1 rounded-full bg-[color:oklch(95%_0.15_108)]"
                            transition={{ type: 'spring', stiffness: 350, damping: 30 }}
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
      className="scroll-mt-6"
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
