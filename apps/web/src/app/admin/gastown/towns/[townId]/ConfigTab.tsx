'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDistanceToNow } from 'date-fns';

export function ConfigTab({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const configQuery = useQuery(trpc.admin.gastown.getTownConfig.queryOptions({ townId }));
  const credEventsQuery = useQuery(
    trpc.admin.gastown.listCredentialEvents.queryOptions({ townId })
  );

  const updateConfigMutation = useMutation(
    trpc.admin.gastown.updateTownConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(
          trpc.admin.gastown.getTownConfig.queryFilter({ townId })
        );
        setEditingField(null);
      },
    })
  );

  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const config = configQuery.data;
  const credEvents = credEventsQuery.data ?? [];

  const startEdit = (field: string, currentValue: string) => {
    setEditingField(field);
    setEditValue(currentValue);
  };

  const saveField = (field: string) => {
    if (field === 'default_model') {
      updateConfigMutation.mutate({ townId, update: { default_model: editValue || null } });
    } else if (field === 'small_model') {
      updateConfigMutation.mutate({ townId, update: { small_model: editValue || null } });
    } else if (field === 'max_polecats_per_rig') {
      const num = parseInt(editValue, 10);
      if (!isNaN(num) && num > 0) {
        updateConfigMutation.mutate({ townId, update: { max_polecats_per_rig: num } });
      }
    } else if (field === 'merge_strategy') {
      const validStrategies = ['direct', 'pr'] as const;
      const strategy = validStrategies.find(s => s === editValue);
      if (strategy) {
        updateConfigMutation.mutate({ townId, update: { merge_strategy: strategy } });
      }
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Town Config */}
      <Card>
        <CardHeader>
          <CardTitle>Town Config</CardTitle>
        </CardHeader>
        <CardContent>
          {configQuery.isLoading && (
            <p className="text-muted-foreground text-sm">Loading config…</p>
          )}
          {configQuery.isError && (
            <p className="text-sm text-red-400">
              Failed to load config: {configQuery.error.message}
            </p>
          )}
          {config && (
            <div className="space-y-4">
              {/* Merge Strategy */}
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <div>
                  <Label className="text-sm font-medium">Merge Strategy</Label>
                  <p className="text-muted-foreground text-xs">How branches are merged</p>
                </div>
                {editingField === 'merge_strategy' ? (
                  <div className="flex items-center gap-2">
                    <Select value={editValue} onValueChange={setEditValue}>
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">direct</SelectItem>
                        <SelectItem value="pr">pr</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => saveField('merge_strategy')}
                      disabled={updateConfigMutation.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingField(null)}
                      disabled={updateConfigMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{config.merge_strategy}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => startEdit('merge_strategy', config.merge_strategy)}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>

              {/* Default Model */}
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <div>
                  <Label className="text-sm font-medium">Default Model</Label>
                  <p className="text-muted-foreground text-xs">Primary AI model for agents</p>
                </div>
                {editingField === 'default_model' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      className="w-64"
                      placeholder="e.g. anthropic/claude-sonnet-4"
                    />
                    <Button
                      size="sm"
                      onClick={() => saveField('default_model')}
                      disabled={updateConfigMutation.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingField(null)}
                      disabled={updateConfigMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground font-mono text-sm">
                      {config.default_model ?? '—'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => startEdit('default_model', config.default_model ?? '')}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>

              {/* Small Model */}
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <div>
                  <Label className="text-sm font-medium">Small Model</Label>
                  <p className="text-muted-foreground text-xs">
                    Lightweight model for simple tasks
                  </p>
                </div>
                {editingField === 'small_model' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      className="w-64"
                      placeholder="e.g. anthropic/claude-haiku"
                    />
                    <Button
                      size="sm"
                      onClick={() => saveField('small_model')}
                      disabled={updateConfigMutation.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingField(null)}
                      disabled={updateConfigMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground font-mono text-sm">
                      {config.small_model ?? '—'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => startEdit('small_model', config.small_model ?? '')}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>

              {/* Max Polecats */}
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <div>
                  <Label className="text-sm font-medium">Max Polecats per Rig</Label>
                  <p className="text-muted-foreground text-xs">Concurrency limit per rig</p>
                </div>
                {editingField === 'max_polecats_per_rig' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      className="w-24"
                      min={1}
                    />
                    <Button
                      size="sm"
                      onClick={() => saveField('max_polecats_per_rig')}
                      disabled={updateConfigMutation.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingField(null)}
                      disabled={updateConfigMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground font-mono text-sm">
                      {config.max_polecats_per_rig ?? '—'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        startEdit('max_polecats_per_rig', String(config.max_polecats_per_rig ?? ''))
                      }
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>

              {/* Refinery Config */}
              {config.refinery && (
                <div className="border-b pb-3">
                  <Label className="text-sm font-medium">Refinery</Label>
                  <div className="mt-2 space-y-1 font-mono text-xs">
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-40">Auto Merge:</span>
                      <span>{String(config.refinery.auto_merge)}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-40">Require Clean Merge:</span>
                      <span>{String(config.refinery.require_clean_merge)}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-40">Gates:</span>
                      <span>{config.refinery.gates.join(', ') || '—'}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Git Auth */}
              <div className="pb-3">
                <Label className="text-sm font-medium">Git Auth</Label>
                <div className="mt-2 space-y-1 font-mono text-xs">
                  {config.git_auth.platform_integration_id && (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-48">Platform Integration:</span>
                      <span>{config.git_auth.platform_integration_id.slice(0, 16)}…</span>
                    </div>
                  )}
                  {config.git_auth.github_token && (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-48">GitHub Token:</span>
                      <span className="text-muted-foreground">••••••••</span>
                    </div>
                  )}
                  {config.git_auth.gitlab_token && (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-48">GitLab Token:</span>
                      <span className="text-muted-foreground">••••••••</span>
                    </div>
                  )}
                  {config.git_auth.gitlab_instance_url && (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-48">GitLab Instance URL:</span>
                      <span>{config.git_auth.gitlab_instance_url}</span>
                    </div>
                  )}
                  {!config.git_auth.github_token &&
                    !config.git_auth.gitlab_token &&
                    !config.git_auth.platform_integration_id && (
                      <span className="text-muted-foreground">No git auth configured</span>
                    )}
                </div>
              </div>

              {updateConfigMutation.isError && (
                <p className="text-sm text-red-400">
                  Failed to update config: {updateConfigMutation.error.message}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Credential Events */}
      <Card>
        <CardHeader>
          <CardTitle>Credential Events</CardTitle>
        </CardHeader>
        <CardContent>
          {credEventsQuery.isLoading && (
            <p className="text-muted-foreground text-sm">Loading credential events…</p>
          )}
          {!credEventsQuery.isLoading && credEvents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No credential events. (Requires bead 0 admin endpoints.)
            </p>
          )}
          {credEvents.length > 0 && (
            <div className="space-y-2">
              {credEvents.map(event => (
                <div key={event.id} className="flex items-start justify-between gap-4 text-sm">
                  <div>
                    <span className="font-mono text-xs">{event.event_type}</span>
                    {event.rig_id && (
                      <span className="text-muted-foreground ml-2 font-mono text-xs">
                        rig: {event.rig_id.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
