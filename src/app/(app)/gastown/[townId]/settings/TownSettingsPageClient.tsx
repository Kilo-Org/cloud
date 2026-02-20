'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { toast } from 'sonner';
import { ArrowLeft, Plus, Trash2, Eye, EyeOff, Save, Settings } from 'lucide-react';

type Props = { townId: string };

type EnvVarEntry = { key: string; value: string; isNew?: boolean };

export function TownSettingsPageClient({ townId }: Props) {
  const router = useRouter();
  const trpc = useTRPC();
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

  // Local state for form fields
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
  const [githubToken, setGithubToken] = useState('');
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [maxPolecats, setMaxPolecats] = useState<number | undefined>(undefined);
  const [refineryGates, setRefineryGates] = useState<string[]>([]);
  const [autoMerge, setAutoMerge] = useState(true);
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
    setInitialized(true);
  }

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
          // Only send non-masked values (masked values contain ****)
          ...(githubToken && !githubToken.startsWith('****') ? { github_token: githubToken } : {}),
          ...(gitlabToken && !gitlabToken.startsWith('****') ? { gitlab_token: gitlabToken } : {}),
          ...(gitlabInstanceUrl ? { gitlab_instance_url: gitlabInstanceUrl } : {}),
        },
        ...(defaultModel ? { default_model: defaultModel } : {}),
        ...(maxPolecats ? { max_polecats_per_rig: maxPolecats } : {}),
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
      <PageContainer>
        <GastownBackdrop contentClassName="p-5 md:p-7">
          <Skeleton className="h-8 w-64" />
        </GastownBackdrop>
        <div className="space-y-4 px-1">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/gastown/${townId}`)}
            className="flex items-center gap-1 text-sm text-white/60 transition-colors hover:text-white/90"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Settings className="h-6 w-6 text-white/70" />
          <h1 className="text-xl font-semibold text-white/95">
            {townQuery.data?.name ?? 'Town'} — Settings
          </h1>
        </div>
        <p className="mt-1 text-sm text-white/55">
          Configure environment variables, git authentication, and agent defaults.
        </p>
      </GastownBackdrop>

      <div className="space-y-6 px-1">
        {/* Git Authentication */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <CardTitle className="text-base text-white/90">Git Authentication</CardTitle>
            <p className="text-sm text-white/55">
              Tokens used for cloning and pushing to private repositories.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTokens(!showTokens)}
                className="flex items-center gap-1 text-xs text-white/50 hover:text-white/80"
              >
                {showTokens ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                {showTokens ? 'Hide' : 'Show'} tokens
              </button>
            </div>

            <div className="space-y-1">
              <Label className="text-white/70">GitHub Token (PAT or Installation Token)</Label>
              <Input
                type={showTokens ? 'text' : 'password'}
                value={githubToken}
                onChange={e => setGithubToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="border-white/10 bg-white/[0.05] text-white/90 placeholder:text-white/30"
              />
              <p className="text-xs text-white/40">
                Used to authenticate <code>git clone</code> and <code>git push</code> for GitHub
                repos.
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-white/70">GitLab Token</Label>
              <Input
                type={showTokens ? 'text' : 'password'}
                value={gitlabToken}
                onChange={e => setGitlabToken(e.target.value)}
                placeholder="glpat-xxxxxxxxxxxx"
                className="border-white/10 bg-white/[0.05] text-white/90 placeholder:text-white/30"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-white/70">GitLab Instance URL (self-hosted)</Label>
              <Input
                value={gitlabInstanceUrl}
                onChange={e => setGitlabInstanceUrl(e.target.value)}
                placeholder="https://gitlab.example.com"
                className="border-white/10 bg-white/[0.05] text-white/90 placeholder:text-white/30"
              />
            </div>
          </CardContent>
        </Card>

        {/* Environment Variables */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base text-white/90">Environment Variables</CardTitle>
                <p className="text-sm text-white/55">
                  Injected into all agent processes. Agent-level overrides take precedence.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={addEnvVar}>
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {envVars.length === 0 ? (
              <p className="text-sm text-white/40">No environment variables configured.</p>
            ) : (
              <div className="space-y-2">
                {envVars.map((entry, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={entry.key}
                      onChange={e => updateEnvVar(i, 'key', e.target.value)}
                      placeholder="KEY"
                      className="w-40 border-white/10 bg-white/[0.05] font-mono text-sm text-white/90 placeholder:text-white/30"
                    />
                    <span className="text-white/40">=</span>
                    <Input
                      value={entry.value}
                      onChange={e => updateEnvVar(i, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 border-white/10 bg-white/[0.05] font-mono text-sm text-white/90 placeholder:text-white/30"
                    />
                    <button
                      onClick={() => removeEnvVar(i)}
                      className="text-white/40 transition-colors hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Agent Defaults */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <CardTitle className="text-base text-white/90">Agent Defaults</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label className="text-white/70">Default Model</Label>
              <Input
                value={defaultModel}
                onChange={e => setDefaultModel(e.target.value)}
                placeholder="anthropic/claude-sonnet-4.6"
                className="border-white/10 bg-white/[0.05] text-white/90 placeholder:text-white/30"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-white/70">Max Polecats per Rig</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={maxPolecats ?? ''}
                onChange={e =>
                  setMaxPolecats(e.target.value ? parseInt(e.target.value, 10) : undefined)
                }
                placeholder="5"
                className="w-24 border-white/10 bg-white/[0.05] text-white/90 placeholder:text-white/30"
              />
            </div>
          </CardContent>
        </Card>

        {/* Refinery Configuration */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base text-white/90">Refinery (Quality Gates)</CardTitle>
                <p className="text-sm text-white/55">
                  Commands run before merging polecat branches into the default branch.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={addRefineryGate}>
                <Plus className="mr-1 h-3 w-3" />
                Add Gate
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {refineryGates.length === 0 ? (
              <p className="text-sm text-white/40">No quality gates configured.</p>
            ) : (
              <div className="space-y-2">
                {refineryGates.map((gate, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={gate}
                      onChange={e => updateRefineryGate(i, e.target.value)}
                      placeholder="npm test"
                      className="flex-1 border-white/10 bg-white/[0.05] font-mono text-sm text-white/90 placeholder:text-white/30"
                    />
                    <button
                      onClick={() => removeRefineryGate(i)}
                      className="text-white/40 transition-colors hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Switch checked={autoMerge} onCheckedChange={setAutoMerge} />
              <Label className="text-white/70">Auto-merge when all gates pass</Label>
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end pb-8">
          <Button onClick={handleSave} disabled={updateConfig.isPending}>
            <Save className="mr-2 h-4 w-4" />
            {updateConfig.isPending ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </div>
    </PageContainer>
  );
}
