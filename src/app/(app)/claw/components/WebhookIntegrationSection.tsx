'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import { ConfirmActionDialog } from './ConfirmActionDialog';

const DEFAULT_PROMPT_TEMPLATE =
  'You received a webhook event. Here is the payload:\n\n{{bodyJson}}';

/**
 * Generate a trigger ID with enough entropy that the webhook URL acts as its own credential.
 * Format: claw-{random} (e.g., "claw-a1b2c3d4e5f6"). The random suffix uses crypto.randomUUID
 * with hyphens stripped for a clean URL segment.
 */
function generateTriggerId(): string {
  return `claw-${crypto.randomUUID().replace(/-/g, '')}`;
}

export function WebhookIntegrationSection() {
  const [manageOpen, setManageOpen] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
  const [promptDirty, setPromptDirty] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authHeader, setAuthHeader] = useState('x-webhook-secret');
  const [authSecret, setAuthSecret] = useState('');
  const [authDirty, setAuthDirty] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Get the active instance ID
  const { data: instanceData, isLoading: isLoadingInstance } = useQuery(
    trpc.kiloclaw.getActiveInstanceId.queryOptions()
  );
  const instanceId = instanceData?.instanceId;

  // Query existing triggers to find a kiloclaw_chat trigger for this user
  const { data: triggers, isLoading: isLoadingTriggers } = useQuery(
    trpc.webhookTriggers.list.queryOptions({})
  );

  // Only match a trigger for the current active instance
  const clawTrigger = instanceId
    ? triggers?.find(t => t.targetType === 'kiloclaw_chat' && t.kiloclawInstanceId === instanceId)
    : undefined;
  const isSetUp = !!clawTrigger;
  const isActive = clawTrigger?.isActive ?? false;

  // Fetch full trigger config (includes webhookAuthConfigured) when a trigger exists
  const { data: triggerConfig } = useQuery(
    trpc.webhookTriggers.get.queryOptions(
      { triggerId: clawTrigger?.triggerId ?? '' },
      { enabled: isSetUp && !!clawTrigger?.triggerId }
    )
  );

  // Seed local state from existing trigger config
  useEffect(() => {
    if (triggerConfig) {
      setPromptTemplate(triggerConfig.promptTemplate);
      setPromptDirty(false);
      setAuthEnabled(triggerConfig.webhookAuthConfigured ?? false);
      if (triggerConfig.webhookAuthHeader) {
        setAuthHeader(triggerConfig.webhookAuthHeader);
      }
      setAuthDirty(false);
      // Secret is never returned — keep field blank (write-only)
    }
  }, [triggerConfig]);

  // Create trigger mutation
  const { mutateAsync: createTrigger, isPending: isCreating } = useMutation(
    trpc.webhookTriggers.create.mutationOptions({
      onSuccess: () => {
        toast.success('Webhook created');
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => {
        toast.error(`Failed to create webhook: ${err.message}`);
      },
    })
  );

  // Delete trigger mutation
  const { mutateAsync: deleteTrigger, isPending: isDeleting } = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => {
        toast.error(`Failed to delete webhook: ${err.message}`);
      },
    })
  );

  // Update trigger mutation (for isActive toggle + prompt template)
  const { mutateAsync: updateTrigger, isPending: isUpdating } = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => {
        toast.error(`Failed to update: ${err.message}`);
      },
    })
  );

  const isPending = isCreating || isDeleting || isUpdating;

  // First-time setup — create a new trigger
  async function handleSetUp() {
    if (!instanceId) {
      toast.error('No active KiloClaw instance found');
      return;
    }
    if (authEnabled && (!authHeader || !authSecret)) {
      toast.error('Both header name and secret are required when authentication is enabled');
      return;
    }
    const triggerId = generateTriggerId();
    await createTrigger({
      triggerId,
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: instanceId,
      promptTemplate,
      ...(authEnabled && authHeader && authSecret
        ? { webhookAuth: { header: authHeader, secret: authSecret } }
        : {}),
    });
  }

  // Toggle active/inactive — preserves the URL
  async function handleActiveToggle(active: boolean) {
    if (!clawTrigger) return;
    await updateTrigger({ triggerId: clawTrigger.triggerId, isActive: active });
    toast.success(active ? 'Webhook activated' : 'Webhook paused');
  }

  // Rotate URL — create new trigger first, then delete old (safer: if create fails, old is untouched)
  async function handleConfirmRotate() {
    if (!clawTrigger || !instanceId) return;
    // If auth is enabled, the secret must be re-entered since rotation creates a new trigger
    // and the existing secret hash can't be carried forward
    if (authEnabled && authHeader && !authSecret) {
      toast.error(
        'Please re-enter the shared secret before rotating — the new URL needs a fresh secret'
      );
      setConfirmRotateOpen(false);
      return;
    }
    const oldTriggerId = clawTrigger.triggerId;
    const newTriggerId = generateTriggerId();
    await createTrigger({
      triggerId: newTriggerId,
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: instanceId,
      promptTemplate,
      ...(authEnabled && authHeader && authSecret
        ? { webhookAuth: { header: authHeader, secret: authSecret } }
        : {}),
    });
    await deleteTrigger({ triggerId: oldTriggerId });
    setConfirmRotateOpen(false);
    toast.success('Webhook URL rotated — update your integrations with the new URL');
  }

  async function handleSavePrompt() {
    if (!clawTrigger) return;
    await updateTrigger({ triggerId: clawTrigger.triggerId, promptTemplate });
    toast.success('Prompt template updated');
    setPromptDirty(false);
  }

  async function handleSaveAuth() {
    if (!clawTrigger) return;
    if (authEnabled) {
      if (!authHeader) {
        toast.error('Header name is required');
        return;
      }
      // If enabling auth for the first time, secret is required.
      // If auth is already configured, secret is optional (keeps existing hash).
      const isNewAuth = !triggerConfig?.webhookAuthConfigured;
      if (isNewAuth && !authSecret) {
        toast.error('Shared secret is required when enabling authentication');
        return;
      }
      await updateTrigger({
        triggerId: clawTrigger.triggerId,
        webhookAuth: {
          header: authHeader,
          ...(authSecret ? { secret: authSecret } : {}),
        },
      });
    } else {
      await updateTrigger({
        triggerId: clawTrigger.triggerId,
        webhookAuth: { header: null, secret: null },
      });
    }
    toast.success(
      authEnabled ? 'Webhook authentication updated' : 'Webhook authentication disabled'
    );
    setAuthDirty(false);
  }

  function handleCopyUrl() {
    if (!clawTrigger?.inboundUrl) return;
    void navigator.clipboard.writeText(clawTrigger.inboundUrl);
    setCopied(true);
    toast.success('Webhook URL copied');
    setTimeout(() => setCopied(false), 2000);
  }

  const isLoading = isLoadingTriggers || isLoadingInstance;

  return (
    <div className="rounded-lg border px-4 py-3">
      {/* ── Compact header (always visible) ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Globe className="text-muted-foreground h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Webhook Integration</p>
            <div className="text-muted-foreground text-xs">
              {isLoading ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading...
                </span>
              ) : isSetUp ? (
                <span>
                  Status:{' '}
                  <strong className={isActive ? 'text-green-400' : 'text-amber-400'}>
                    {isActive ? 'Active' : 'Paused'}
                  </strong>
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

      {/* ── Expanded content ── */}
      {manageOpen && (
        <>
          <Separator className="my-3" />
          <div className="space-y-4">
            <p className="text-muted-foreground text-xs">
              Receive external events (GitHub pushes, form submissions, etc.) as messages in your
              KiloClaw chat. The bot will process and respond to each webhook payload.
            </p>

            {!isSetUp ? (
              // First-time setup
              <Button size="sm" onClick={handleSetUp} disabled={isPending}>
                {isCreating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                Set Up Webhook
              </Button>
            ) : (
              <>
                {/* Active toggle — pauses/resumes without changing URL */}
                <Label className="flex cursor-pointer items-center space-x-2">
                  <Switch
                    checked={isActive}
                    onCheckedChange={handleActiveToggle}
                    disabled={isPending}
                  />
                  <span className="text-sm">
                    {isPending ? 'Processing...' : isActive ? 'Active' : 'Paused'}
                  </span>
                </Label>

                {/* Webhook URL */}
                {clawTrigger?.inboundUrl && (
                  <div className="space-y-2">
                    <Label className="text-sm">Webhook URL</Label>
                    <div className="flex items-center gap-2">
                      <code className="bg-muted flex-1 truncate rounded-md px-3 py-2 text-xs">
                        {clawTrigger.inboundUrl}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopyUrl}
                        title="Copy webhook URL"
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-muted-foreground flex-1 text-xs">
                        Treat this URL as a secret. Anyone with it can send messages to your
                        instance.
                      </p>
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
                    rows={5}
                    className="font-mono text-xs"
                    placeholder="Enter your prompt template..."
                  />
                  <p className="text-muted-foreground text-xs">
                    Available variables: {'{{body}}'}, {'{{bodyJson}}'}, {'{{method}}'},{' '}
                    {'{{headers}}'}, {'{{path}}'}, {'{{query}}'}, {'{{timestamp}}'}
                  </p>
                  {promptDirty && (
                    <Button size="sm" onClick={handleSavePrompt} disabled={isUpdating}>
                      {isUpdating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                      Save Template
                    </Button>
                  )}
                </div>

                {/* Webhook Authentication */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Webhook Authentication</Label>
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
                  <p className="text-muted-foreground text-xs">
                    Require inbound requests to include a shared secret header before they are
                    accepted. Optional — only required if the sending program requires it.
                  </p>
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
                              ? 'Leave blank to keep existing secret'
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
              </>
            )}
          </div>
        </>
      )}

      {/* Rotate URL confirmation dialog */}
      <ConfirmActionDialog
        open={confirmRotateOpen}
        onOpenChange={setConfirmRotateOpen}
        title="Rotate Webhook URL"
        description="This will permanently invalidate your current webhook URL and generate a new one. Any services sending events to the current URL will stop working until you update them with the new URL."
        confirmLabel="Rotate URL"
        isPending={isDeleting || isCreating}
        pendingLabel="Rotating"
        onConfirm={handleConfirmRotate}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      />
    </div>
  );
}
