'use client';

import { useState } from 'react';
import { useKiloClawConfig, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Save, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

function EnvVarEditor({
  envVars,
  onChange,
}: {
  envVars: Record<string, string>;
  onChange: (vars: Record<string, string>) => void;
}) {
  const entries = Object.entries(envVars);

  function addVar() {
    onChange({ ...envVars, '': '' });
  }

  function removeVar(key: string) {
    const next = { ...envVars };
    delete next[key];
    onChange(next);
  }

  function updateKey(oldKey: string, newKey: string) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(envVars)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  }

  function updateValue(key: string, value: string) {
    onChange({ ...envVars, [key]: value });
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, value], i) => (
        <div key={i} className="flex gap-2">
          <Input
            placeholder="KEY"
            value={key}
            onChange={e => updateKey(key, e.target.value)}
            className="font-mono text-sm"
          />
          <Input
            placeholder="value"
            value={value}
            onChange={e => updateValue(key, e.target.value)}
            className="font-mono text-sm"
          />
          <Button variant="ghost" size="icon" onClick={() => removeVar(key)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={addVar}>
        <Plus className="mr-2 h-3 w-3" />
        Add Variable
      </Button>
    </div>
  );
}

export default function ClawSettingsPage() {
  const { data: config, isLoading } = useKiloClawConfig();
  const { updateConfig } = useKiloClawMutations();

  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [channels, setChannels] = useState({
    telegramBotToken: '',
    discordBotToken: '',
    slackBotToken: '',
    slackAppToken: '',
  });

  async function handleSave() {
    // Filter out empty keys
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

  if (isLoading) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <Button onClick={handleSave} disabled={updateConfig.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {updateConfig.isPending ? 'Saving...' : 'Save & Provision'}
        </Button>
      </div>

      {config && (
        <div className="text-muted-foreground mb-6 rounded-lg border p-4 text-sm">
          Current config: {config.envVarKeys.length} env vars, {config.secretCount} secrets,{' '}
          {[
            config.channels.telegram && 'Telegram',
            config.channels.discord && 'Discord',
            (config.channels.slackBot || config.channels.slackApp) && 'Slack',
          ]
            .filter(Boolean)
            .join(', ') || 'no channels'}
        </div>
      )}

      {/* Environment Variables */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Environment Variables</h2>
        <p className="text-muted-foreground mb-3 text-sm">
          Plaintext variables passed to the container. Visible in the config.
        </p>
        <EnvVarEditor envVars={envVars} onChange={setEnvVars} />
      </section>

      {/* Secrets */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Secrets</h2>
        <p className="text-muted-foreground mb-3 text-sm">
          Encrypted at rest. Values are never returned by the API. Override env vars on conflict.
        </p>
        <EnvVarEditor envVars={secrets} onChange={setSecrets} />
      </section>

      {/* Chat Channels */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Chat Channels</h2>
        <p className="text-muted-foreground mb-3 text-sm">
          Bot tokens are encrypted at rest. All channels are optional.
        </p>
        <div className="space-y-4">
          <div>
            <Label>Telegram Bot Token</Label>
            <Input
              type="password"
              placeholder="1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ"
              value={channels.telegramBotToken}
              onChange={e => setChannels(c => ({ ...c, telegramBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div>
            <Label>Discord Bot Token</Label>
            <Input
              type="password"
              placeholder="MTIz..."
              value={channels.discordBotToken}
              onChange={e => setChannels(c => ({ ...c, discordBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div>
            <Label>Slack Bot Token</Label>
            <Input
              type="password"
              placeholder="xoxb-..."
              value={channels.slackBotToken}
              onChange={e => setChannels(c => ({ ...c, slackBotToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
          <div>
            <Label>Slack App Token</Label>
            <Input
              type="password"
              placeholder="xapp-..."
              value={channels.slackAppToken}
              onChange={e => setChannels(c => ({ ...c, slackAppToken: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
