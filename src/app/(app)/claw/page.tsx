'use client';

import { useState } from 'react';
import {
  useKiloClawStatus,
  useKiloClawConfig,
  useKiloClawStorageInfo,
  useKiloClawMutations,
} from '@/hooks/useKiloClaw';
import { PageLayout } from '@/components/PageLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ExternalLink, Play, Square, RotateCw, RefreshCw, Trash2, Plus, Save } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

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

function EnvVarEditor({
  vars,
  onChange,
  secretMode,
}: {
  vars: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  secretMode?: boolean;
}) {
  const entries = Object.entries(vars);
  return (
    <div className="space-y-2">
      {entries.map(([key, value], i) => (
        <div key={i} className="flex gap-2">
          <Input
            placeholder="KEY"
            value={key}
            onChange={e => {
              const next: Record<string, string> = {};
              for (const [k, v] of Object.entries(vars)) {
                next[k === key ? e.target.value : k] = v;
              }
              onChange(next);
            }}
            className="font-mono text-sm"
          />
          <Input
            type={secretMode ? 'password' : 'text'}
            placeholder="value"
            value={value}
            onChange={e => onChange({ ...vars, [key]: e.target.value })}
            className="font-mono text-sm"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = { ...vars };
              delete next[key];
              onChange(next);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...vars, '': '' })}>
        <Plus className="mr-2 h-3 w-3" />
        Add
      </Button>
    </div>
  );
}

// ─── Tab: Overview ────────────────────────────────────────────────────

function OverviewTab() {
  const { data: status } = useKiloClawStatus();
  const { data: storage } = useKiloClawStorageInfo();
  const { start, stop, restartGateway, syncStorage } = useKiloClawMutations();

  if (!status?.status) return null;

  const isRunning = status.status === 'running';
  const isStopped = status.status === 'stopped';
  const isProvisioned = status.status === 'provisioned';

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Controls — always visible */}
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(isStopped || isProvisioned) && (
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
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
              <Button
                variant="outline"
                onClick={() =>
                  syncStorage.mutate(undefined, {
                    onSuccess: () => toast.success('Sync triggered'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={syncStorage.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {syncStorage.isPending ? 'Syncing...' : 'Force Sync'}
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
          <Stat label="Status" value={status.status} />
          <Stat
            label="Sandbox ID"
            value={<span className="truncate font-mono text-xs">{status.sandboxId}</span>}
          />
          <Stat label="Provisioned" value={formatTs(status.provisionedAt)} />
          <Stat label="Last started" value={formatTs(status.lastStartedAt)} />
          <Stat label="Last stopped" value={formatTs(status.lastStoppedAt)} />
          <Stat label="Last sync" value={formatTs(status.lastSyncAt)} />
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

      {storage && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>R2 Storage</CardTitle>
            <CardDescription>
              {storage.configured
                ? 'Data persists across container restarts.'
                : 'Not configured. Data is lost on container restart.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Stat label="Configured" value={storage.configured ? 'Yes' : 'No'} />
            <Stat label="Last sync" value={storage.lastSync ?? 'Never'} />
            {storage.syncInProgress && (
              <p className="col-span-2 text-sm text-yellow-600">Sync in progress...</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tab: Settings ────────────────────────────────────────────────────

function SettingsTab() {
  const { data: config } = useKiloClawConfig();
  const { updateConfig } = useKiloClawMutations();

  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [channels, setChannels] = useState({
    telegramBotToken: '',
    discordBotToken: '',
    slackBotToken: '',
    slackAppToken: '',
  });

  function handleSave() {
    const cleanEnvVars = Object.fromEntries(Object.entries(envVars).filter(([k]) => k.trim()));
    const cleanSecrets = Object.fromEntries(Object.entries(secrets).filter(([k]) => k.trim()));
    const cleanChannels = {
      telegramBotToken: channels.telegramBotToken || undefined,
      discordBotToken: channels.discordBotToken || undefined,
      slackBotToken: channels.slackBotToken || undefined,
      slackAppToken: channels.slackAppToken || undefined,
    };
    const hasChannels = Object.values(cleanChannels).some(Boolean);

    updateConfig.mutate(
      {
        envVars: Object.keys(cleanEnvVars).length > 0 ? cleanEnvVars : undefined,
        secrets: Object.keys(cleanSecrets).length > 0 ? cleanSecrets : undefined,
        channels: hasChannels ? cleanChannels : undefined,
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
              {config.envVarKeys.length} env vars, {config.secretCount} secrets,{' '}
              {[
                config.channels.telegram && 'Telegram',
                config.channels.discord && 'Discord',
                (config.channels.slackBot || config.channels.slackApp) && 'Slack',
              ]
                .filter(Boolean)
                .join(', ') || 'no channels'}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Environment Variables</CardTitle>
          <CardDescription>Plaintext variables passed to the container.</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvVarEditor vars={envVars} onChange={setEnvVars} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>Encrypted at rest. Override env vars on conflict.</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvVarEditor vars={secrets} onChange={setSecrets} secretMode />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chat Channels</CardTitle>
          <CardDescription>Bot tokens are encrypted at rest.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Telegram Bot Token</Label>
            <Input
              type="password"
              placeholder="1234567890:ABCdefGHI..."
              value={channels.telegramBotToken}
              onChange={e => setChannels(c => ({ ...c, telegramBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Discord Bot Token</Label>
            <Input
              type="password"
              placeholder="MTIz..."
              value={channels.discordBotToken}
              onChange={e => setChannels(c => ({ ...c, discordBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Slack Bot Token</Label>
            <Input
              type="password"
              placeholder="xoxb-..."
              value={channels.slackBotToken}
              onChange={e => setChannels(c => ({ ...c, slackBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Slack App Token</Label>
            <Input
              type="password"
              placeholder="xapp-..."
              value={channels.slackAppToken}
              onChange={e => setChannels(c => ({ ...c, slackAppToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={updateConfig.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {updateConfig.isPending ? 'Saving...' : 'Save & Provision'}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Actions ─────────────────────────────────────────────────────

function ActionsTab() {
  const { data: status } = useKiloClawStatus();
  const { restartGateway, syncStorage, stop, destroy } = useKiloClawMutations();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const isRunning = status?.status === 'running';

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
                syncStorage.mutate(undefined, {
                  onSuccess: () => toast.success('Sync triggered'),
                  onError: e => toast.error(e.message),
                })
              }
              disabled={syncStorage.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Force Sync
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
            <Button variant="destructive" onClick={() => setConfirmDestroy(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Destroy Instance
            </Button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-600">Delete all data?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  destroy.mutate(
                    { deleteData: true },
                    {
                      onSuccess: () => {
                        toast.success('Instance destroyed');
                        setConfirmDestroy(false);
                      },
                      onError: e => toast.error(e.message),
                    }
                  )
                }
                disabled={destroy.isPending}
              >
                Yes, destroy
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
  const { updateConfig } = useKiloClawMutations();

  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [channels, setChannels] = useState({
    telegramBotToken: '',
    discordBotToken: '',
    slackBotToken: '',
    slackAppToken: '',
  });

  function handleCreate() {
    const cleanEnvVars = Object.fromEntries(Object.entries(envVars).filter(([k]) => k.trim()));
    const cleanSecrets = Object.fromEntries(Object.entries(secrets).filter(([k]) => k.trim()));
    const cleanChannels = {
      telegramBotToken: channels.telegramBotToken || undefined,
      discordBotToken: channels.discordBotToken || undefined,
      slackBotToken: channels.slackBotToken || undefined,
      slackAppToken: channels.slackAppToken || undefined,
    };
    const hasChannels = Object.values(cleanChannels).some(Boolean);

    updateConfig.mutate(
      {
        envVars: Object.keys(cleanEnvVars).length > 0 ? cleanEnvVars : undefined,
        secrets: Object.keys(cleanSecrets).length > 0 ? cleanSecrets : undefined,
        channels: hasChannels ? cleanChannels : undefined,
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
          <CardDescription>
            Configure your KiloClaw instance. All fields are optional — you can update them later.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment Variables</CardTitle>
          <CardDescription>Plaintext variables passed to the container.</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvVarEditor vars={envVars} onChange={setEnvVars} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>Encrypted at rest. Override env vars on conflict.</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvVarEditor vars={secrets} onChange={setSecrets} secretMode />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chat Channels</CardTitle>
          <CardDescription>Bot tokens are encrypted at rest.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Telegram Bot Token</Label>
            <Input
              type="password"
              placeholder="1234567890:ABCdefGHI..."
              value={channels.telegramBotToken}
              onChange={e => setChannels(c => ({ ...c, telegramBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Discord Bot Token</Label>
            <Input
              type="password"
              placeholder="MTIz..."
              value={channels.discordBotToken}
              onChange={e => setChannels(c => ({ ...c, discordBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Slack Bot Token</Label>
            <Input
              type="password"
              placeholder="xoxb-..."
              value={channels.slackBotToken}
              onChange={e => setChannels(c => ({ ...c, slackBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Slack App Token</Label>
            <Input
              type="password"
              placeholder="xapp-..."
              value={channels.slackAppToken}
              onChange={e => setChannels(c => ({ ...c, slackAppToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleCreate} disabled={updateConfig.isPending}>
          <Plus className="mr-2 h-4 w-4" />
          {updateConfig.isPending ? 'Creating...' : 'Create & Provision'}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function ClawPage() {
  const { data: status, isLoading, error } = useKiloClawStatus();
  const { start } = useKiloClawMutations();

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
  const hasInstance = !!status?.status;

  const baseUrl = status?.workerUrl || 'https://claw.kilo.ai';
  const clawUrl = status?.gatewayToken ? `${baseUrl}/#token=${status.gatewayToken}` : `${baseUrl}/`;

  const headerActions = hasInstance ? (
    <div className="flex gap-2">
      {(isStopped || isProvisioned) && (
        <Button onClick={() => start.mutate()} disabled={start.isPending}>
          <Play className="mr-2 h-4 w-4" />
          {start.isPending ? 'Starting...' : 'Start'}
        </Button>
      )}
      {isRunning && (
        <>
          <Button variant="outline" asChild>
            <a href={clawUrl} target="_blank" rel="noopener noreferrer">
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
