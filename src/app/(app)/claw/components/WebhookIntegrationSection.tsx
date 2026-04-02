'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Clock,
  Copy,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { TimezoneSelector } from '@/components/webhook-triggers/TimezoneSelector';
import { ScheduleBuilder } from '@/components/webhook-triggers/ScheduleBuilder';
import { describeCron } from '@/components/webhook-triggers/describe-cron';
import { useTRPC } from '@/lib/trpc/utils';
import { ConfirmActionDialog } from './ConfirmActionDialog';

const DEFAULT_WEBHOOK_PROMPT = 'You received a webhook event. Here is the payload:\n\n{{bodyJson}}';
const DEFAULT_SCHEDULED_PROMPT = 'Run your scheduled task. Triggered at {{scheduledTime}}.';
const MAX_SCHEDULED_TRIGGERS = 5;

function generateTriggerId(): string {
  return `claw-${crypto.randomUUID().replace(/-/g, '')}`;
}

// ============================================================================
// Main Section
// ============================================================================

export function WebhookIntegrationSection() {
  const [manageOpen, setManageOpen] = useState(false);
  const trpc = useTRPC();

  // Get the active instance ID
  const { data: instanceData, isLoading: isLoadingInstance } = useQuery(
    trpc.kiloclaw.getActiveInstanceId.queryOptions()
  );
  const instanceId = instanceData?.instanceId;

  // Query all triggers for this user
  const { data: triggers, isLoading: isLoadingTriggers } = useQuery(
    trpc.webhookTriggers.list.queryOptions({})
  );

  // Split into webhook (single) and scheduled (array) for this instance
  // Narrow activationMode from string to the union type for downstream components
  const instanceTriggers = (
    instanceId
      ? triggers?.filter(
          t => t.targetType === 'kiloclaw_chat' && t.kiloclawInstanceId === instanceId
        )
      : []
  )?.map(t => ({
    ...t,
    activationMode:
      t.activationMode === 'scheduled' ? ('scheduled' as const) : ('webhook' as const),
  }));
  const webhookTrigger = instanceTriggers?.find(t => t.activationMode !== 'scheduled');
  const scheduledTriggers = instanceTriggers?.filter(t => t.activationMode === 'scheduled') ?? [];

  const isLoading = isLoadingTriggers || isLoadingInstance;
  const hasAnything = !!webhookTrigger || scheduledTriggers.length > 0;

  return (
    <div className="rounded-lg border px-4 py-3">
      {/* Compact header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Globe className="text-muted-foreground h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Webhooks / Triggers</p>
            <div className="text-muted-foreground text-xs">
              {isLoading ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading...
                </span>
              ) : hasAnything ? (
                <span>
                  {webhookTrigger ? '1 webhook' : ''}
                  {webhookTrigger && scheduledTriggers.length > 0 ? ', ' : ''}
                  {scheduledTriggers.length > 0
                    ? `${scheduledTriggers.length} schedule${scheduledTriggers.length !== 1 ? 's' : ''}`
                    : ''}
                </span>
              ) : (
                <span>Not configured</span>
              )}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setManageOpen(v => !v)}
          disabled={isLoading}
        >
          {manageOpen ? 'Close' : 'Manage'}
        </Button>
      </div>

      {/* Expanded content */}
      {manageOpen && (
        <>
          <Separator className="my-3" />
          <div className="space-y-6">
            <p className="text-muted-foreground text-xs">
              Send messages to your KiloClaw chat via incoming webhooks or on a recurring schedule.
            </p>

            {/* Webhook section */}
            <WebhookSubSection instanceId={instanceId} trigger={webhookTrigger} />

            <Separator />

            {/* Scheduled triggers section */}
            <ScheduledTriggersSubSection instanceId={instanceId} triggers={scheduledTriggers} />
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Webhook Sub-Section (single trigger)
// ============================================================================

type TriggerListItem = {
  triggerId: string;
  isActive: boolean;
  inboundUrl: string;
  activationMode: 'webhook' | 'scheduled';
  cronExpression: string | null;
  cronTimezone: string | null;
  kiloclawInstanceId: string | null;
  targetType: string;
};

function WebhookSubSection({
  instanceId,
  trigger,
}: {
  instanceId: string | undefined;
  trigger: TriggerListItem | undefined;
}) {
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_WEBHOOK_PROMPT);
  const [promptDirty, setPromptDirty] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authHeader, setAuthHeader] = useState('x-webhook-secret');
  const [authSecret, setAuthSecret] = useState('');
  const [authDirty, setAuthDirty] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const isSetUp = !!trigger;
  const isActive = trigger?.isActive ?? false;

  // Fetch full config for auth details
  const { data: triggerConfig } = useQuery(
    trpc.webhookTriggers.get.queryOptions(
      { triggerId: trigger?.triggerId ?? '' },
      { enabled: isSetUp && !!trigger?.triggerId }
    )
  );

  // Seed state from config
  useEffect(() => {
    if (triggerConfig) {
      setPromptTemplate(triggerConfig.promptTemplate);
      setPromptDirty(false);
      setAuthEnabled(triggerConfig.webhookAuthConfigured ?? false);
      if (triggerConfig.webhookAuthHeader) setAuthHeader(triggerConfig.webhookAuthHeader);
      setAuthDirty(false);
    }
  }, [triggerConfig]);

  const { mutateAsync: createTrigger, isPending: isCreating } = useMutation(
    trpc.webhookTriggers.create.mutationOptions({
      onSuccess: () => {
        toast.success('Webhook created');
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => toast.error(`Failed to create webhook: ${err.message}`),
    })
  );

  const { mutateAsync: deleteTrigger, isPending: isDeleting } = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() }),
      onError: err => toast.error(`Failed to delete webhook: ${err.message}`),
    })
  );

  const { mutateAsync: updateTrigger, isPending: isUpdating } = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() }),
      onError: err => toast.error(`Failed to update: ${err.message}`),
    })
  );

  const isPending = isCreating || isDeleting || isUpdating;

  async function handleSetUp() {
    if (!instanceId) {
      toast.error('No active KiloClaw instance found');
      return;
    }
    if (authEnabled && (!authHeader || !authSecret)) {
      toast.error('Both header name and secret are required when authentication is enabled');
      return;
    }
    await createTrigger({
      triggerId: generateTriggerId(),
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: instanceId,
      promptTemplate,
      ...(authEnabled && authHeader && authSecret
        ? { webhookAuth: { header: authHeader, secret: authSecret } }
        : {}),
    });
  }

  async function handleActiveToggle(active: boolean) {
    if (!trigger) return;
    await updateTrigger({ triggerId: trigger.triggerId, isActive: active });
    toast.success(active ? 'Webhook activated' : 'Webhook paused');
  }

  async function handleConfirmRotate() {
    if (!trigger || !instanceId) return;
    if (authEnabled && (!authHeader || !authSecret)) {
      toast.error('Both header name and secret are required — the new URL needs a fresh secret');
      setConfirmRotateOpen(false);
      return;
    }
    const oldId = trigger.triggerId;
    await createTrigger({
      triggerId: generateTriggerId(),
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: instanceId,
      promptTemplate,
      ...(authEnabled && authHeader && authSecret
        ? { webhookAuth: { header: authHeader, secret: authSecret } }
        : {}),
    });
    await deleteTrigger({ triggerId: oldId });
    setConfirmRotateOpen(false);
    toast.success('Webhook URL rotated — update your integrations with the new URL');
  }

  async function handleSavePrompt() {
    if (!trigger) return;
    await updateTrigger({ triggerId: trigger.triggerId, promptTemplate });
    toast.success('Prompt template updated');
    setPromptDirty(false);
  }

  async function handleSaveAuth() {
    if (!trigger) return;
    if (authEnabled) {
      if (!authHeader) {
        toast.error('Header name is required');
        return;
      }
      const isNewAuth = !triggerConfig?.webhookAuthConfigured;
      if (isNewAuth && !authSecret) {
        toast.error('Shared secret is required when enabling authentication');
        return;
      }
      await updateTrigger({
        triggerId: trigger.triggerId,
        webhookAuth: { header: authHeader, ...(authSecret ? { secret: authSecret } : {}) },
      });
    } else {
      await updateTrigger({
        triggerId: trigger.triggerId,
        webhookAuth: { header: null, secret: null },
      });
    }
    toast.success(
      authEnabled ? 'Webhook authentication updated' : 'Webhook authentication disabled'
    );
    setAuthDirty(false);
  }

  function handleCopyUrl() {
    if (!trigger?.inboundUrl) return;
    void navigator.clipboard.writeText(trigger.inboundUrl);
    setCopied(true);
    toast.success('Webhook URL copied');
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Webhook className="h-4 w-4" />
        <h4 className="text-sm font-medium">Webhook</h4>
        {isSetUp && (
          <Badge variant={isActive ? 'default' : 'secondary'} className="text-xs">
            {isActive ? 'Active' : 'Paused'}
          </Badge>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Receive external events (GitHub pushes, alerts, etc.) as messages in your KiloClaw chat.
      </p>

      {!isSetUp ? (
        <Button size="sm" onClick={handleSetUp} disabled={isPending}>
          {isCreating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          Set Up Webhook
        </Button>
      ) : (
        <div className="space-y-3">
          <Label className="flex cursor-pointer items-center space-x-2">
            <Switch checked={isActive} onCheckedChange={handleActiveToggle} disabled={isPending} />
            <span className="text-sm">
              {isPending ? 'Processing...' : isActive ? 'Active' : 'Paused'}
            </span>
          </Label>

          {/* Webhook URL */}
          {trigger?.inboundUrl && (
            <div className="space-y-2">
              <Label className="text-sm">Webhook URL</Label>
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 truncate rounded-md px-3 py-2 text-xs">
                  {trigger.inboundUrl}
                </code>
                <Button variant="outline" size="icon" onClick={handleCopyUrl} title="Copy">
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground flex-1 text-xs">Treat this URL as a secret.</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmRotateOpen(true)}
                  disabled={isPending}
                  className="text-muted-foreground hover:text-foreground shrink-0 text-xs"
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Rotate URL
                </Button>
              </div>
            </div>
          )}

          {/* Prompt template */}
          <div className="space-y-2">
            <Label className="text-sm">Prompt Template</Label>
            <Textarea
              value={promptTemplate}
              onChange={e => {
                setPromptTemplate(e.target.value);
                setPromptDirty(true);
              }}
              rows={4}
              maxLength={10000}
              className="font-mono text-xs"
            />
            <p className="text-muted-foreground text-xs">
              Variables: {'{{body}}'}, {'{{bodyJson}}'}, {'{{method}}'}, {'{{headers}}'},{' '}
              {'{{path}}'}, {'{{query}}'}, {'{{timestamp}}'}
            </p>
            {promptDirty && (
              <Button size="sm" onClick={handleSavePrompt} disabled={isUpdating}>
                {isUpdating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                Save Template
              </Button>
            )}
          </div>

          {/* Auth */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Authentication</Label>
              <Label className="flex cursor-pointer items-center space-x-2">
                <Switch
                  checked={authEnabled}
                  onCheckedChange={v => {
                    setAuthEnabled(v);
                    setAuthDirty(true);
                  }}
                  disabled={isPending}
                />
                <span className="text-muted-foreground text-xs">
                  {authEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </Label>
            </div>
            {authEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Secret Header</Label>
                  <Input
                    value={authHeader}
                    onChange={e => {
                      setAuthHeader(e.target.value);
                      setAuthDirty(true);
                    }}
                    placeholder="x-webhook-secret"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Shared Secret</Label>
                  <Input
                    type="password"
                    value={authSecret}
                    onChange={e => {
                      setAuthSecret(e.target.value);
                      setAuthDirty(true);
                    }}
                    placeholder={
                      triggerConfig?.webhookAuthConfigured
                        ? 'Leave blank to keep existing'
                        : 'Enter shared secret'
                    }
                    className="text-xs"
                  />
                </div>
              </div>
            )}
            {authDirty && (
              <Button size="sm" onClick={handleSaveAuth} disabled={isUpdating}>
                {isUpdating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                Save Authentication
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmActionDialog
        open={confirmRotateOpen}
        onOpenChange={setConfirmRotateOpen}
        title="Rotate Webhook URL"
        description="This will permanently invalidate your current webhook URL and generate a new one."
        confirmLabel="Rotate URL"
        isPending={isDeleting || isCreating}
        pendingLabel="Rotating"
        onConfirm={handleConfirmRotate}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      />
    </div>
  );
}

// ============================================================================
// Scheduled Triggers Sub-Section (multiple triggers)
// ============================================================================

function ScheduledTriggersSubSection({
  instanceId,
  triggers,
}: {
  instanceId: string | undefined;
  triggers: TriggerListItem[];
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [deletingTriggerId, setDeletingTriggerId] = useState<string | null>(null);
  const canAdd = triggers.length < MAX_SCHEDULED_TRIGGERS;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { mutateAsync: createTrigger, isPending: isCreating } = useMutation(
    trpc.webhookTriggers.create.mutationOptions({
      onSuccess: () => {
        toast.success('Scheduled trigger created');
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
        setShowAddForm(false);
      },
      onError: err => toast.error(`Failed to create: ${err.message}`),
    })
  );

  const { mutateAsync: updateTrigger, isPending: isUpdating } = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
        // Broad invalidation: clears all cached get queries so edit forms refetch fresh config
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.get.queryKey() });
        setEditingTriggerId(null);
      },
      onError: err => toast.error(`Failed to update: ${err.message}`),
    })
  );

  const { mutateAsync: deleteTrigger, isPending: isDeleting } = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Scheduled trigger deleted');
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => toast.error(`Failed to delete: ${err.message}`),
    })
  );

  const isPending = isCreating || isUpdating || isDeleting;

  async function handleCreate(
    cronExpression: string,
    cronTimezone: string,
    promptTemplate: string
  ) {
    if (!instanceId) {
      toast.error('No active KiloClaw instance found');
      return;
    }
    await createTrigger({
      triggerId: generateTriggerId(),
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: instanceId,
      activationMode: 'scheduled',
      cronExpression,
      cronTimezone,
      promptTemplate,
    });
  }

  async function handleUpdate(
    triggerId: string,
    cronExpression: string,
    cronTimezone: string,
    promptTemplate: string
  ) {
    await updateTrigger({ triggerId, cronExpression, cronTimezone, promptTemplate });
    toast.success('Schedule updated');
  }

  async function handleToggle(triggerId: string, active: boolean) {
    await updateTrigger({ triggerId, isActive: active });
    toast.success(active ? 'Schedule activated' : 'Schedule paused');
  }

  async function handleConfirmDelete() {
    if (!deletingTriggerId) return;
    await deleteTrigger({ triggerId: deletingTriggerId });
    setDeletingTriggerId(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4" />
          <h4 className="text-sm font-medium">Scheduled Triggers</h4>
          <span className="text-muted-foreground text-xs">
            ({triggers.length}/{MAX_SCHEDULED_TRIGGERS})
          </span>
        </div>
        {canAdd && !showAddForm && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddForm(true)}
            disabled={isPending}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add Schedule
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Send messages to your KiloClaw chat on a recurring schedule.
      </p>

      {/* Existing scheduled triggers */}
      {triggers.length > 0 && (
        <div className="space-y-2">
          {triggers.map(trigger => (
            <ScheduledTriggerRow
              key={trigger.triggerId}
              trigger={trigger}
              isEditing={editingTriggerId === trigger.triggerId}
              onEdit={() => setEditingTriggerId(trigger.triggerId)}
              onCancelEdit={() => setEditingTriggerId(null)}
              onUpdate={handleUpdate}
              onToggle={handleToggle}
              onDelete={async id => setDeletingTriggerId(id)}
              isPending={isPending}
            />
          ))}
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <ScheduledTriggerForm
          onSubmit={handleCreate}
          onCancel={() => setShowAddForm(false)}
          isPending={isCreating}
        />
      )}

      {triggers.length === 0 && !showAddForm && (
        <p className="text-muted-foreground py-2 text-center text-xs">
          No scheduled triggers configured. Click &quot;Add Schedule&quot; to create one.
        </p>
      )}

      <ConfirmActionDialog
        open={!!deletingTriggerId}
        onOpenChange={open => {
          if (!open) setDeletingTriggerId(null);
        }}
        title="Delete Scheduled Trigger"
        description="This will permanently remove this scheduled trigger. Any pending scheduled runs will be cancelled."
        confirmLabel="Delete"
        isPending={isDeleting}
        pendingLabel="Deleting"
        onConfirm={handleConfirmDelete}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      />
    </div>
  );
}

// ============================================================================
// Scheduled Trigger Row (display + inline edit)
// ============================================================================

function ScheduledTriggerRow({
  trigger,
  isEditing,
  onEdit,
  onCancelEdit,
  onUpdate,
  onToggle,
  onDelete,
  isPending,
}: {
  trigger: TriggerListItem;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (triggerId: string, cron: string, tz: string, prompt: string) => Promise<void>;
  onToggle: (triggerId: string, active: boolean) => Promise<void>;
  onDelete: (triggerId: string) => Promise<void>;
  isPending: boolean;
}) {
  const trpc = useTRPC();

  // Fetch full config for prompt template
  const { data: config } = useQuery(
    trpc.webhookTriggers.get.queryOptions({ triggerId: trigger.triggerId }, { enabled: isEditing })
  );

  if (isEditing && config) {
    return (
      <ScheduledTriggerForm
        initialCron={config.cronExpression ?? ''}
        initialTimezone={config.cronTimezone ?? 'UTC'}
        initialPrompt={config.promptTemplate}
        onSubmit={(cron, tz, prompt) => onUpdate(trigger.triggerId, cron, tz, prompt)}
        onCancel={onCancelEdit}
        isPending={isPending}
        submitLabel="Save"
      />
    );
  }

  return (
    <div className="bg-muted/30 grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 rounded-md border px-3 py-2">
      <Switch
        checked={trigger.isActive}
        onCheckedChange={v => onToggle(trigger.triggerId, v)}
        disabled={isPending}
      />
      <div className="text-sm">
        {describeCron(trigger.cronExpression ?? '')}
        <span className="text-muted-foreground ml-1 text-xs">
          ({trigger.cronTimezone ?? 'UTC'})
        </span>
      </div>
      <Badge variant={trigger.isActive ? 'default' : 'secondary'} className="text-xs">
        {trigger.isActive ? 'Active' : 'Paused'}
      </Badge>
      <Button variant="ghost" size="icon" onClick={onEdit} disabled={isPending} title="Edit">
        <Pencil className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(trigger.triggerId)}
        disabled={isPending}
        title="Delete"
      >
        <Trash2 className="text-destructive h-3 w-3" />
      </Button>
    </div>
  );
}

// ============================================================================
// Scheduled Trigger Form (create + edit)
// ============================================================================

function ScheduledTriggerForm({
  initialCron = '',
  initialTimezone,
  initialPrompt = DEFAULT_SCHEDULED_PROMPT,
  onSubmit,
  onCancel,
  isPending,
  submitLabel = 'Create Schedule',
}: {
  initialCron?: string;
  initialTimezone?: string;
  initialPrompt?: string;
  onSubmit: (cron: string, timezone: string, prompt: string) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
  submitLabel?: string;
}) {
  const [cron, setCron] = useState(initialCron);
  const [timezone, setTimezone] = useState(
    initialTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [prompt, setPrompt] = useState(initialPrompt);

  async function handleSubmit() {
    if (!cron.trim()) {
      toast.error('Cron expression is required');
      return;
    }
    await onSubmit(cron.trim(), timezone, prompt.trim());
  }

  return (
    <div className="bg-muted/30 space-y-3 rounded-md border p-3">
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <ScheduleBuilder
          cronExpression={cron}
          onCronExpressionChange={setCron}
          timezone={timezone}
        />
        <TimezoneSelector value={timezone} onValueChange={setTimezone} />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Prompt</Label>
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={3}
          maxLength={10000}
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">
          Variables: {'{{scheduledTime}}'}, {'{{timestamp}}'}
        </p>
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {submitLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
