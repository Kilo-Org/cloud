'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { ProfileSelector } from '@/components/cloud-agent/ProfileSelector';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { ModeCombobox } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  normalizeTriggerId,
  triggerIdSchema,
  triggerIdCreateSchema,
  RESERVED_TRIGGER_IDS,
} from '@/lib/webhook-trigger-validation';
import { TimezoneSelector } from './TimezoneSelector';
import { ScheduleBuilder } from './ScheduleBuilder';
import { cn } from '@/lib/utils';
import { AlertCircle, Check, Clock, Copy, Loader2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentMode } from '@/components/cloud-agent/types';

export type TriggerFormData = {
  triggerId: string;
  activationMode: 'webhook' | 'scheduled';
  cronExpression?: string;
  cronTimezone?: string;
  githubRepo: string;
  mode: AgentMode;
  model: string;
  promptTemplate: string;
  profileId: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  isActive?: boolean;
  webhookAuth: {
    enabled: boolean;
    header?: string;
    secret?: string;
  };
};

export type TriggerFormProps = {
  mode: 'create' | 'edit';
  organizationId?: string;
  initialData?: {
    triggerId: string;
    activationMode?: 'webhook' | 'scheduled';
    cronExpression?: string | null;
    cronTimezone?: string | null;
    githubRepo: string;
    mode: AgentMode;
    model: string;
    promptTemplate: string;
    profileId?: string;
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
    isActive?: boolean;
    webhookAuthHeader?: string;
    webhookAuthConfigured?: boolean;
  };
  /** Repositories available for selection (should be fetched by parent) */
  repositories: RepositoryOption[];
  isLoadingRepositories?: boolean;
  repositoriesError?: string;
  /** Models available for selection (should be fetched by parent) */
  models: ModelOption[];
  isLoadingModels?: boolean;
  onSubmit: (data: TriggerFormData) => Promise<void>;
  onCancel?: () => void;
  onDelete?: () => Promise<void>;
  isLoading?: boolean;
  /** Full inbound webhook URL (only needed in edit mode) */
  inboundUrl?: string;
};

/**
 * Shared form component for creating and editing webhook triggers.
 *
 * Key behaviors:
 * - Trigger ID auto-transforms to lowercase-hyphenated format
 * - Trigger ID and GitHub repo are read-only in edit mode
 * - Profile is REQUIRED for webhook triggers (unlike manual sessions)
 * - Shows webhook URL with copy button in edit mode
 * - Shows delete button with confirmation in edit mode
 */
export function TriggerForm({
  mode: formMode,
  organizationId,
  initialData,
  repositories,
  isLoadingRepositories,
  repositoriesError,
  models,
  isLoadingModels,
  onSubmit,
  onCancel,
  onDelete,
  isLoading = false,
  inboundUrl,
}: TriggerFormProps) {
  const isEditMode = formMode === 'edit';

  // Form state
  const [activationMode, setActivationMode] = useState<'webhook' | 'scheduled'>(
    initialData?.activationMode ?? 'webhook'
  );
  const [cronExpression, setCronExpression] = useState(initialData?.cronExpression ?? '');
  const [cronTimezone, setCronTimezone] = useState(
    initialData?.cronTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const isScheduled = activationMode === 'scheduled';
  const [triggerId, setTriggerId] = useState(initialData?.triggerId ?? '');
  const [triggerIdError, setTriggerIdError] = useState<string | null>(null);
  const [githubRepo, setGithubRepo] = useState(initialData?.githubRepo ?? '');
  const [agentMode, setAgentMode] = useState<AgentMode>((initialData?.mode as AgentMode) ?? 'ask');
  const [model, setModel] = useState(initialData?.model ?? '');
  const WEBHOOK_DEFAULT_PROMPT = 'Describe this webhook request payload:\n\n{{body}}';
  const SCHEDULED_DEFAULT_PROMPT = 'Run the scheduled task. Triggered at {{scheduledTime}}.';
  const [promptTemplate, setPromptTemplate] = useState(
    initialData?.promptTemplate ??
      (activationMode === 'scheduled' ? SCHEDULED_DEFAULT_PROMPT : WEBHOOK_DEFAULT_PROMPT)
  );
  const [profileId, setProfileId] = useState<string | null>(initialData?.profileId ?? null);
  const [autoCommit, setAutoCommit] = useState(initialData?.autoCommit ?? false);
  const [condenseOnComplete, setCondenseOnComplete] = useState(
    initialData?.condenseOnComplete ?? false
  );
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const initialWebhookAuthConfigured = initialData?.webhookAuthConfigured ?? false;
  const [webhookAuthEnabled, setWebhookAuthEnabled] = useState(initialWebhookAuthConfigured);
  const [webhookAuthHeader, setWebhookAuthHeader] = useState(initialData?.webhookAuthHeader ?? '');
  const [webhookAuthSecret, setWebhookAuthSecret] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Reset form when initialData changes (for edit mode)
  useEffect(() => {
    if (initialData) {
      setActivationMode(initialData.activationMode ?? 'webhook');
      setCronExpression(initialData.cronExpression ?? '');
      setCronTimezone(initialData.cronTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      setTriggerId(initialData.triggerId);
      setGithubRepo(initialData.githubRepo);
      setAgentMode(initialData.mode ?? 'ask');
      setModel(initialData.model);
      setPromptTemplate(initialData.promptTemplate);
      setProfileId(initialData.profileId ?? null);
      setAutoCommit(initialData.autoCommit ?? false);
      setCondenseOnComplete(initialData.condenseOnComplete ?? false);
      setIsActive(initialData.isActive ?? true);
      setWebhookAuthEnabled(initialData.webhookAuthConfigured ?? false);
      setWebhookAuthHeader(initialData.webhookAuthHeader ?? '');
    }
    if (!initialData) {
      setWebhookAuthEnabled(false);
      setWebhookAuthHeader('');
    }
    setWebhookAuthSecret('');
  }, [initialData]);

  // Update default prompt when activation mode toggles (create mode only)
  useEffect(() => {
    if (isEditMode) return;
    setPromptTemplate(prev =>
      prev === WEBHOOK_DEFAULT_PROMPT || prev === SCHEDULED_DEFAULT_PROMPT
        ? isScheduled
          ? SCHEDULED_DEFAULT_PROMPT
          : WEBHOOK_DEFAULT_PROMPT
        : prev
    );
  }, [isScheduled, isEditMode]);

  // Auto-select first model if none selected
  useEffect(() => {
    if (!model && models.length > 0) {
      setModel(models[0].id);
    }
  }, [model, models]);

  const trimmedWebhookAuthHeader = webhookAuthHeader.trim();
  const trimmedWebhookAuthSecret = webhookAuthSecret.trim();
  const webhookAuthHeaderError =
    webhookAuthEnabled && !trimmedWebhookAuthHeader ? 'Webhook auth header is required' : null;
  const webhookAuthSecretError =
    webhookAuthEnabled && !initialWebhookAuthConfigured && !trimmedWebhookAuthSecret
      ? 'Webhook auth secret is required when enabling authentication'
      : null;

  // Trigger ID validation — use stricter schema for new triggers
  const activeTriggerIdSchema = isEditMode ? triggerIdSchema : triggerIdCreateSchema;
  const validateTriggerId = useCallback(
    (value: string) => {
      const result = activeTriggerIdSchema.safeParse(value);
      if (!result.success) {
        setTriggerIdError(result.error.issues[0].message);
        return false;
      }
      setTriggerIdError(null);
      return true;
    },
    [activeTriggerIdSchema]
  );

  // Handle trigger ID change with auto-transform
  const handleTriggerIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const normalized = normalizeTriggerId(e.target.value);
      setTriggerId(normalized);
      if (normalized) {
        validateTriggerId(normalized);
      } else {
        setTriggerIdError(null);
      }
    },
    [validateTriggerId]
  );

  // Copy webhook URL to clipboard
  const handleCopyUrl = useCallback(async () => {
    if (!inboundUrl) return;
    try {
      await navigator.clipboard.writeText(inboundUrl);
      toast.success('Webhook URL copied to clipboard');
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [inboundUrl]);

  // Form validation
  const formErrors = useMemo(() => {
    const errors: string[] = [];

    if (!triggerId) {
      errors.push('Trigger Name is required');
    } else {
      const result = activeTriggerIdSchema.safeParse(triggerId);
      if (!result.success) {
        errors.push(result.error.issues[0].message);
      }
    }

    if (isScheduled) {
      if (!cronExpression.trim()) {
        errors.push('Cron expression is required for scheduled triggers');
      }
    }

    if (!githubRepo) {
      errors.push('Repository is required');
    }

    if (!model) {
      errors.push('Model is required');
    }

    if (!promptTemplate.trim()) {
      errors.push('Prompt template is required');
    }

    if (!profileId) {
      errors.push('Profile is required');
    }

    if (!isScheduled && webhookAuthHeaderError) {
      errors.push(webhookAuthHeaderError);
    }

    if (!isScheduled && webhookAuthSecretError) {
      errors.push(webhookAuthSecretError);
    }

    return errors;
  }, [
    activeTriggerIdSchema,
    triggerId,
    isScheduled,
    cronExpression,
    githubRepo,
    model,
    promptTemplate,
    profileId,
    webhookAuthHeaderError,
    webhookAuthSecretError,
  ]);

  const isFormValid = formErrors.length === 0;

  // Handle form submission
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!isFormValid || !profileId) {
        toast.error('Please fix form errors before submitting');
        return;
      }

      const webhookAuthData: TriggerFormData['webhookAuth'] =
        !isScheduled && webhookAuthEnabled
          ? {
              enabled: true,
              header: trimmedWebhookAuthHeader,
              secret: trimmedWebhookAuthSecret ? trimmedWebhookAuthSecret : undefined,
            }
          : { enabled: false };

      await onSubmit({
        triggerId,
        activationMode,
        cronExpression: isScheduled ? cronExpression.trim() : undefined,
        cronTimezone: isScheduled ? cronTimezone : undefined,
        githubRepo,
        mode: agentMode,
        model,
        promptTemplate: promptTemplate.trim(),
        profileId,
        autoCommit,
        condenseOnComplete,
        isActive: isEditMode ? isActive : undefined,
        webhookAuth: webhookAuthData,
      });
    },
    [
      isFormValid,
      profileId,
      onSubmit,
      triggerId,
      activationMode,
      cronExpression,
      cronTimezone,
      isScheduled,
      githubRepo,
      agentMode,
      model,
      promptTemplate,
      autoCommit,
      condenseOnComplete,
      isEditMode,
      isActive,
      webhookAuthEnabled,
      trimmedWebhookAuthHeader,
      trimmedWebhookAuthSecret,
    ]
  );

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!onDelete) return;

    setIsDeleting(true);
    try {
      await onDelete();
      setShowDeleteDialog(false);
    } catch {
      // Error is expected to be handled by the parent
    } finally {
      setIsDeleting(false);
    }
  }, [onDelete]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isScheduled ? <Clock className="h-5 w-5" /> : <Webhook className="h-5 w-5" />}
            {isEditMode ? 'Edit Trigger' : 'Create New Trigger'}
          </CardTitle>
          <CardDescription>
            {isEditMode
              ? 'Update the configuration for this trigger'
              : 'Configure a new trigger to automatically start cloud agent sessions'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Trigger ID */}
            <TriggerIdField
              value={triggerId}
              onChange={handleTriggerIdChange}
              error={triggerIdError}
              disabled={isEditMode || isLoading}
            />

            {/* Activation Mode (immutable in edit mode) */}
            <div className="space-y-2">
              <Label>Activation Mode</Label>
              {isEditMode ? (
                <div className="bg-muted flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  {isScheduled ? (
                    <>
                      <Clock className="h-4 w-4" /> Scheduled
                    </>
                  ) : (
                    <>
                      <Webhook className="h-4 w-4" /> Webhook
                    </>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={!isScheduled ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActivationMode('webhook')}
                    disabled={isLoading}
                  >
                    <Webhook className="mr-1 h-4 w-4" /> Webhook
                  </Button>
                  <Button
                    type="button"
                    variant={isScheduled ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActivationMode('scheduled')}
                    disabled={isLoading}
                  >
                    <Clock className="mr-1 h-4 w-4" /> Scheduled
                  </Button>
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                {isScheduled
                  ? 'Trigger runs on a recurring cron schedule'
                  : 'Trigger fires when an HTTP request is received'}
              </p>
            </div>

            {/* Schedule (scheduled mode only) */}
            {isScheduled && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                  <ScheduleBuilder
                    cronExpression={cronExpression}
                    onCronExpressionChange={setCronExpression}
                    timezone={cronTimezone}
                    disabled={isLoading}
                  />
                  <TimezoneSelector
                    value={cronTimezone}
                    onValueChange={setCronTimezone}
                    disabled={isLoading}
                  />
                </div>
              </div>
            )}

            {/* Webhook URL (edit mode, webhook activation only) */}
            {isEditMode && !isScheduled && inboundUrl && (
              <WebhookUrlDisplay url={inboundUrl} onCopy={handleCopyUrl} />
            )}

            {/* GitHub Repository */}
            <div className="space-y-2">
              <Label>
                Repository <span className="text-red-400">*</span>
              </Label>
              {isEditMode ? (
                <>
                  <div className="bg-muted truncate rounded-md border px-3 py-2 font-mono text-sm">
                    {githubRepo || 'No repository selected'}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Repository cannot be changed after creation
                  </p>
                </>
              ) : (
                <RepositoryCombobox
                  repositories={repositories}
                  value={githubRepo}
                  onValueChange={setGithubRepo}
                  isLoading={isLoadingRepositories}
                  error={repositoriesError}
                  placeholder="Select a repository"
                  emptyStateText="Requires a GitHub integration — configure in Integrations"
                  hideLabel
                />
              )}
            </div>

            {/* Mode and Model Row */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <ModeCombobox
                label="Mode"
                value={agentMode}
                onValueChange={setAgentMode}
                disabled={isLoading}
              />
              <ModelCombobox
                label="Model"
                models={models}
                value={model}
                onValueChange={setModel}
                isLoading={isLoadingModels}
                required
                disabled={isLoading}
              />
            </div>

            {/* Prompt Template */}
            <PromptTemplateField
              value={promptTemplate}
              onChange={setPromptTemplate}
              disabled={isLoading}
              isScheduled={isScheduled}
            />

            {/* Profile Selection (Required) */}
            <div className="space-y-2">
              <Label>
                Environment Profile <span className="text-red-400">*</span>
              </Label>
              <ProfileSelector
                organizationId={organizationId}
                selectedProfileId={profileId}
                onProfileSelect={setProfileId}
                disabled={isLoading}
                orgProfilesOnly={!!organizationId}
              />
              {!profileId && (
                <p className="flex items-center gap-1 text-xs text-amber-400">
                  <AlertCircle className="h-3 w-3" />A profile is required for webhook triggers
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                Profile secrets will be resolved at webhook execution time
              </p>
            </div>

            {/* Webhook Authentication (webhook mode only) */}
            {!isScheduled && (
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <Label>Webhook Authentication</Label>
                    <p className="text-muted-foreground text-xs">
                      Require inbound requests to include a shared secret header before they are
                      accepted.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="webhookAuthEnabled"
                      checked={webhookAuthEnabled}
                      onCheckedChange={value => {
                        const enabled = value === true;
                        setWebhookAuthEnabled(enabled);
                        if (!enabled) {
                          setWebhookAuthSecret('');
                        }
                      }}
                      disabled={isLoading}
                    />
                    <Label htmlFor="webhookAuthEnabled" className="cursor-pointer font-normal">
                      {webhookAuthEnabled ? 'Authentication enabled' : 'Authentication disabled'}
                    </Label>
                  </div>
                </div>

                {webhookAuthEnabled && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="webhookAuthHeader">
                        Secret Header <span className="text-red-400">*</span>
                      </Label>
                      <Input
                        id="webhookAuthHeader"
                        value={webhookAuthHeader}
                        onChange={event => setWebhookAuthHeader(event.target.value)}
                        placeholder="x-webhook-secret"
                        autoComplete="off"
                        disabled={isLoading}
                      />
                      {webhookAuthHeaderError ? (
                        <p className="text-destructive text-xs">{webhookAuthHeaderError}</p>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          Header names are stored in lowercase and matched case-insensitively.
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="webhookAuthSecret">
                        Shared Secret
                        {initialWebhookAuthConfigured ? (
                          <span className="text-muted-foreground"> (optional)</span>
                        ) : (
                          <span className="text-red-400">*</span>
                        )}
                      </Label>
                      <Input
                        id="webhookAuthSecret"
                        type="password"
                        value={webhookAuthSecret}
                        onChange={event => setWebhookAuthSecret(event.target.value)}
                        placeholder={
                          initialWebhookAuthConfigured
                            ? 'Leave blank to keep existing secret'
                            : 'Enter shared secret'
                        }
                        autoComplete="new-password"
                        disabled={isLoading}
                      />
                      {webhookAuthSecretError ? (
                        <p className="text-destructive text-xs">{webhookAuthSecretError}</p>
                      ) : initialWebhookAuthConfigured ? (
                        <p className="text-muted-foreground text-xs">
                          Leave blank to keep the current secret. Provide a new value to rotate it.
                        </p>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          Use a strong random string. This value must be supplied with each webhook
                          call.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {!webhookAuthEnabled && initialWebhookAuthConfigured && (
                  <p className="text-muted-foreground text-xs">
                    Authentication will be disabled after you save changes.
                  </p>
                )}
              </div>
            )}

            {/* Options */}
            <div className="space-y-4">
              <Label>Options</Label>

              {/* Auto Commit */}
              <div className="flex items-center gap-3">
                <Checkbox
                  id="autoCommit"
                  checked={autoCommit}
                  onCheckedChange={checked => setAutoCommit(checked === true)}
                  disabled={isLoading}
                />
                <Label htmlFor="autoCommit" className="cursor-pointer font-normal">
                  Auto commit changes
                </Label>
              </div>

              {/* Condense on Complete */}
              <div className="flex items-center gap-3">
                <Checkbox
                  id="condenseOnComplete"
                  checked={condenseOnComplete}
                  onCheckedChange={checked => setCondenseOnComplete(checked === true)}
                  disabled={isLoading}
                />
                <Label htmlFor="condenseOnComplete" className="cursor-pointer font-normal">
                  Condense context on completion
                </Label>
              </div>

              {/* Active Toggle (edit mode only) */}
              {isEditMode && (
                <div className="flex items-center gap-3">
                  <Switch
                    id="isActive"
                    checked={isActive}
                    onCheckedChange={setIsActive}
                    disabled={isLoading}
                  />
                  <Label htmlFor="isActive" className="cursor-pointer font-normal">
                    Trigger is active
                  </Label>
                  {!isActive && (
                    <span className="text-muted-foreground text-xs">
                      {isScheduled ? '(schedule paused)' : '(webhooks will return 404)'}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Form Actions */}
            <div className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={!isFormValid || isLoading}
                  className="min-w-[120px]"
                >
                  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isLoading
                    ? isEditMode
                      ? 'Saving...'
                      : 'Creating...'
                    : isEditMode
                      ? 'Save Changes'
                      : 'Create Trigger'}
                </Button>
                {onCancel && (
                  <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
                    Cancel
                  </Button>
                )}
              </div>

              {/* Delete Button (edit mode only) */}
              {isEditMode && onDelete && (
                <InlineDeleteConfirmation
                  onDelete={() => setShowDeleteDialog(true)}
                  disabled={isLoading}
                  showAsButton
                  buttonText="Delete Trigger"
                />
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Trigger</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the trigger &quot;{triggerId}&quot;? This action
              cannot be undone. Any pending webhook requests will fail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Trigger ID input field with auto-transform and validation
 */
type TriggerIdFieldProps = {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  disabled?: boolean;
};

const TriggerIdField = memo(function TriggerIdField({
  value,
  onChange,
  error,
  disabled,
}: TriggerIdFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="triggerId">
        Trigger Name <span className="text-red-400">*</span>
      </Label>
      <Input
        id="triggerId"
        value={value}
        onChange={onChange}
        placeholder="my-webhook-trigger"
        disabled={disabled}
        aria-invalid={!!error}
        className={cn(error && 'border-destructive')}
        maxLength={64}
      />
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : (
        <p className="text-muted-foreground text-xs">
          8-64 characters, lowercase alphanumeric with hyphens. Reserved words:{' '}
          {RESERVED_TRIGGER_IDS.join(', ')}
        </p>
      )}
    </div>
  );
});

/**
 * Webhook URL display with copy button
 */
type WebhookUrlDisplayProps = {
  url: string;
  onCopy: () => void;
};

const WebhookUrlDisplay = memo(function WebhookUrlDisplay({ url, onCopy }: WebhookUrlDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [onCopy]);

  return (
    <div className="space-y-2">
      <Label>Webhook URL</Label>
      <div className="flex items-center gap-2">
        <div className="bg-muted flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm">
          {url}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Send HTTP requests to this URL to trigger cloud agent sessions
      </p>
    </div>
  );
});

/**
 * Prompt template textarea with variable hints
 */
type PromptTemplateFieldProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  isScheduled?: boolean;
};

const PromptTemplateField = memo(function PromptTemplateField({
  value,
  onChange,
  disabled,
  isScheduled,
}: PromptTemplateFieldProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <div className="space-y-2">
      <Label htmlFor="promptTemplate">
        Prompt Template <span className="text-red-400">*</span>
      </Label>
      <Textarea
        id="promptTemplate"
        value={value}
        onChange={handleChange}
        placeholder={
          isScheduled
            ? 'Run the scheduled task. Triggered at {{scheduledTime}}.'
            : `Process the incoming webhook request:\n\n{{body}}\n\nExtract the relevant information and take appropriate action.`
        }
        rows={6}
        className="resize-y font-mono text-sm"
        disabled={disabled}
        maxLength={10000}
      />
      <div className="text-muted-foreground space-y-1 text-xs">
        <p>Available variables:</p>
        <ul className="ml-4 list-disc space-y-0.5">
          {isScheduled ? (
            <>
              <li>
                <code className="bg-muted rounded px-1">{'{{scheduledTime}}'}</code> - Scheduled
                trigger timestamp
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{timestamp}}'}</code> - Request timestamp
              </li>
            </>
          ) : (
            <>
              <li>
                <code className="bg-muted rounded px-1">{'{{body}}'}</code> - Raw request body
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{bodyJson}}'}</code> - Parsed JSON body
                (pretty-printed)
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{headers}}'}</code> - Request headers
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{method}}'}</code> - HTTP method (GET,
                POST, etc.)
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{path}}'}</code> - Request path after
                trigger ID
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{query}}'}</code> - Query string
                parameters
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{sourceIp}}'}</code> - Client IP address
              </li>
              <li>
                <code className="bg-muted rounded px-1">{'{{timestamp}}'}</code> - Request timestamp
              </li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
});
