'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useKiloClawStatus, useKiloClawConfig, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { PageLayout } from '@/components/PageLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ExternalLink,
  Play,
  Square,
  RotateCw,
  Trash2,
  Plus,
  Save,
  Copy,
  Check,
  KeyRound,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// ─── Helpers ──────────────────────────────────────────────────────────

function formatTs(ts: number | null | undefined) {
  if (!ts) return 'Never';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground text-sm">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

// ─── Env Var Editor ───────────────────────────────────────────────────

// ─── Tab: Overview ────────────────────────────────────────────────────

function OverviewTab() {
  const { data: status } = useKiloClawStatus();
  const { start, stop, restartGateway } = useKiloClawMutations();

  if (!status?.status) return null;

  const isRunning = status.status === 'running';
  const isStopped = status.status === 'stopped';
  const isProvisioned = status.status === 'provisioned';
  const isDestroying = status.status === 'destroying';

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Controls — always visible */}
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(isStopped || isProvisioned) && (
            <Button onClick={() => start.mutate()} disabled={start.isPending || isDestroying}>
              <Play className="mr-2 h-4 w-4" />
              {start.isPending ? 'Starting...' : 'Start'}
            </Button>
          )}
          {isRunning && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  stop.mutate(undefined, {
                    onSuccess: () => toast.success('Instance stopped'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={stop.isPending}
              >
                <Square className="mr-2 h-4 w-4" />
                {stop.isPending ? 'Stopping...' : 'Stop'}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  restartGateway.mutate(undefined, {
                    onSuccess: () => toast.success('Gateway restarting'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={restartGateway.isPending}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                {restartGateway.isPending ? 'Restarting...' : 'Restart Gateway'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Stat label="Status" value={isDestroying ? 'Destroying...' : status.status} />
          <Stat
            label="Sandbox ID"
            value={<span className="truncate font-mono text-xs">{status.sandboxId}</span>}
          />
          <Stat label="Provisioned" value={formatTs(status.provisionedAt)} />
          <Stat label="Last started" value={formatTs(status.lastStartedAt)} />
          <Stat label="Last stopped" value={formatTs(status.lastStoppedAt)} />
          <Stat label="Machine ID" value={status.flyMachineId ?? 'None'} />
          <Stat label="Volume ID" value={status.flyVolumeId ?? 'None'} />
          <Stat label="Fly Region" value={status.flyRegion ?? 'None'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <Stat label="Env vars" value={status.envVarCount} />
          <Stat label="Secrets" value={status.secretCount} />
          <Stat label="Channels" value={status.channelCount} />
        </CardContent>
      </Card>

      {isDestroying && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Destroy In Progress</CardTitle>
            <CardDescription>
              Cleanup is running in the background. Start/stop actions are temporarily unavailable.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}

// ─── Tab: Settings ────────────────────────────────────────────────────

function SettingsTab() {
  const { data: config } = useKiloClawConfig();
  const { patchConfig } = useKiloClawMutations();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();

  const [selectedModel, setSelectedModel] = useState('');
  const [hasAppliedDefaults, setHasAppliedDefaults] = useState(false);
  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );
  const defaultModel = config?.kilocodeDefaultModel?.startsWith('kilocode/')
    ? config.kilocodeDefaultModel.replace(/^kilocode\//, '')
    : '';

  useEffect(() => {
    if (hasAppliedDefaults) return;
    if (!config || modelOptions.length === 0) return;

    if (defaultModel && modelOptions.some(model => model.id === defaultModel)) {
      setSelectedModel(defaultModel);
    }
    setHasAppliedDefaults(true);
  }, [config, defaultModel, hasAppliedDefaults, modelOptions]);

  const isSaving = patchConfig.isPending;

  function handleSave() {
    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    patchConfig.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
      },
      {
        onSuccess: () => toast.success('Configuration saved'),
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  return (
    <div className="space-y-6">
      {config && (
        <Card>
          <CardHeader>
            <CardTitle>Current Config</CardTitle>
            <CardDescription>
              Default model: {config.kilocodeDefaultModel || 'not set'}
            </CardDescription>
          </CardHeader>
          {config.kilocodeApiKeyExpiresAt && (
            <CardContent>
              <p className="text-muted-foreground text-sm">
                API key expires: {new Date(config.kilocodeApiKeyExpiresAt).toLocaleString()}
              </p>
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>KiloCode</CardTitle>
          <CardDescription>Default model and API key for KiloCode gateway access.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-muted-foreground text-sm">
            API key is managed by the platform and refreshed every save.
          </div>
          <ModelCombobox
            label=""
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            isLoading={isLoadingModels}
            disabled={isSaving || isLoadingModels}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          <Save className="mr-2 h-4 w-4" />
          {isSaving ? 'Saving...' : 'Save & Provision'}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Actions ─────────────────────────────────────────────────────

function ActionsTab() {
  const { data: status } = useKiloClawStatus();
  const { restartGateway, stop, destroy } = useKiloClawMutations();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const isRunning = status?.status === 'running';
  const isDestroying = status?.status === 'destroying';

  return (
    <div className="space-y-4">
      {isRunning && (
        <Card>
          <CardHeader>
            <CardTitle>Instance Controls</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() =>
                restartGateway.mutate(undefined, {
                  onSuccess: () => toast.success('Gateway restarting'),
                  onError: e => toast.error(e.message),
                })
              }
              disabled={restartGateway.isPending}
            >
              <RotateCw className="mr-2 h-4 w-4" />
              Restart Gateway
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                stop.mutate(undefined, {
                  onSuccess: () => toast.success('Instance stopped'),
                  onError: e => toast.error(e.message),
                })
              }
              disabled={stop.isPending}
            >
              <Square className="mr-2 h-4 w-4" />
              Stop Instance
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Danger Zone</CardTitle>
          <CardDescription>Destructive actions that cannot be undone.</CardDescription>
        </CardHeader>
        <CardContent>
          {!confirmDestroy ? (
            <Button
              variant="destructive"
              onClick={() => setConfirmDestroy(true)}
              disabled={isDestroying}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {isDestroying ? 'Destroying...' : 'Destroy Instance'}
            </Button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-600">Destroy instance and data?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  destroy.mutate(undefined, {
                    onSuccess: () => {
                      toast.success('Instance destroyed');
                      setConfirmDestroy(false);
                    },
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={destroy.isPending || isDestroying}
              >
                {isDestroying ? 'Destroying...' : 'Yes, destroy'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmDestroy(false)}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Create Instance (empty state with inline settings) ──────────────

function CreateInstanceForm() {
  const { provision } = useKiloClawMutations();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [selectedModel, setSelectedModel] = useState('');
  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  function handleCreate() {
    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    provision.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
      },
      {
        onSuccess: () => toast.success('Instance created'),
        onError: err => toast.error(`Failed to create: ${err.message}`),
      }
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-6">
          <CardTitle>Create Instance</CardTitle>
          <CardDescription>Choose a default model for your KiloClaw instance.</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default Model</CardTitle>
        </CardHeader>
        <CardContent>
          <ModelCombobox
            label=""
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            isLoading={isLoadingModels}
            disabled={provision.isPending || isLoadingModels}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleCreate} disabled={provision.isPending}>
          <Plus className="mr-2 h-4 w-4" />
          {provision.isPending ? 'Creating...' : 'Create & Provision'}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function ClawPage() {
  const { data: status, isLoading, error } = useKiloClawStatus();
  const { start } = useKiloClawMutations();

  const [accessCode, setAccessCode] = useState<string | null>(null);
  const [accessCodeLoading, setAccessCodeLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const generateAccessCode = useCallback(async () => {
    setAccessCodeLoading(true);
    try {
      const res = await fetch('/api/kiloclaw/access-code', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate access code');
      const data = (await res.json()) as { code: string; expiresIn: number };
      setAccessCode(data.code);
      setCopied(false);
    } catch {
      toast.error('Failed to generate access code');
    } finally {
      setAccessCodeLoading(false);
    }
  }, []);

  const copyAccessCode = useCallback(async () => {
    if (!accessCode) return;
    await navigator.clipboard.writeText(accessCode);
    setCopied(true);
    toast.success('Access code copied');
    setTimeout(() => setCopied(false), 2000);
  }, [accessCode]);

  if (isLoading) {
    return (
      <PageLayout title="Claw" subtitle="Manage your KiloClaw instance">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading...</p>
          </CardContent>
        </Card>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout title="Claw" subtitle="Manage your KiloClaw instance">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-red-600">Failed to load: {error.message}</p>
          </CardContent>
        </Card>
      </PageLayout>
    );
  }

  const isRunning = status?.status === 'running';
  const isStopped = status?.status === 'stopped';
  const isProvisioned = status?.status === 'provisioned';
  const isDestroying = status?.status === 'destroying';
  const hasInstance = !!status?.status;

  const baseUrl = status?.workerUrl || 'https://claw.kilo.ai';
  const gatewayUrl = status?.userId
    ? `${baseUrl}/kilo-access-gateway?userId=${encodeURIComponent(status.userId)}`
    : baseUrl;

  const headerActions = hasInstance ? (
    <div className="flex gap-2">
      {(isStopped || isProvisioned) && (
        <Button onClick={() => start.mutate()} disabled={start.isPending || isDestroying}>
          <Play className="mr-2 h-4 w-4" />
          {start.isPending ? 'Starting...' : 'Start'}
        </Button>
      )}
      {isDestroying && (
        <Button variant="outline" disabled>
          Destroying...
        </Button>
      )}
      {isRunning && (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" onClick={generateAccessCode} disabled={accessCodeLoading}>
                <KeyRound className="mr-2 h-4 w-4" />
                {accessCodeLoading ? 'Generating...' : 'View Access Code'}
              </Button>
            </PopoverTrigger>
            {accessCode && (
              <PopoverContent className="w-auto" align="end">
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground text-xs">One-time code (expires in 10 min)</p>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted rounded px-3 py-2 font-mono text-lg tracking-widest">
                      {accessCode}
                    </code>
                    <Button variant="ghost" size="icon" onClick={copyAccessCode}>
                      {copied ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            )}
          </Popover>
          <Button variant="outline" asChild>
            <a href={gatewayUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open
            </a>
          </Button>
        </>
      )}
    </div>
  ) : undefined;

  return (
    <PageLayout title="Claw" subtitle="Manage your KiloClaw instance" headerActions={headerActions}>
      {!hasInstance ? (
        <CreateInstanceForm />
      ) : (
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
          <TabsContent value="actions">
            <ActionsTab />
          </TabsContent>
        </Tabs>
      )}
    </PageLayout>
  );
}
