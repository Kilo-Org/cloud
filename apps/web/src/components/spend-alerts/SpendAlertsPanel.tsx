'use client';

import { useEffect, useId, useState } from 'react';
import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { cn } from '@/lib/utils';
import {
  SPEND_ALERTS_OFF_COPY,
  SPEND_ALERTS_SAVED,
  SPEND_ALERT_WINDOW_HOURS,
  WINDOW_LABELS,
  derivePanelView,
  panelControlsVisible,
  pushChannelNote,
  toDraft,
  toSaveInput,
  type SpendAlertFieldErrors,
  type SpendAlertRuleDraft,
  type SpendAlertRuleKind,
  type SpendAlertsDraft,
  type SpendAlertWindowHours,
} from './spendAlertsPanelState';

/**
 * Every state renders into this slot. The skeleton mirrors the ready panel's
 * rows, so the settings arriving (or failing) never moves the dashboard below.
 */
const PANEL_SLOT_CLASS = 'min-h-[45rem]';

export type SpendAlertsPanelProps = {
  /** Organization scope when set; personal scope when omitted. */
  organizationId?: string;
  /**
   * Caller's role in `organizationId`. A role that cannot manage billing gets
   * no panel at all; omitted in personal scope, which the owner always manages.
   */
  callerRole?: OrganizationRole;
};

/**
 * Spend-alert settings, mounted above the usage summary of the spend views.
 * Enabling the feature, choosing which alerts fire, at which thresholds, and on
 * which channels all happen here; the mobile app's notification category is the
 * push gate and agrees with the push choices saved here.
 */
export function SpendAlertsPanel({ organizationId, callerRole }: SpendAlertsPanelProps) {
  const trpc = useTRPC();
  const fieldId = useId();
  const [draft, setDraft] = useState<SpendAlertsDraft | null>(null);

  // A non-billing caller never has settings to read: skip the query rather than
  // asking the server for an answer the panel will not render.
  const roleCanManage = callerRole === undefined || canManageOrganizationBilling(callerRole);

  const query = useQuery(
    trpc.spendAlerts.get.queryOptions(
      roleCanManage ? (organizationId ? { organizationId } : {}) : skipToken
    )
  );

  const saveMutation = useMutation(
    trpc.spendAlerts.save.mutationOptions({
      onSuccess: saved => {
        toast.success(SPEND_ALERTS_SAVED);
        setDraft(toDraft(saved));
        // The save also writes the viewer's push category column, so re-read it
        // to keep the channel-agreement note honest.
        void query.refetch();
      },
    })
  );

  // Seed the editable draft once; a background refetch must not discard edits.
  useEffect(() => {
    const data = query.data;
    if (data === undefined) return;
    setDraft(current => current ?? toDraft(data));
  }, [query.data]);

  const view = derivePanelView(
    { isLoading: query.isLoading, isError: query.isError, data: query.data },
    callerRole,
    { isPending: saveMutation.isPending, isError: saveMutation.isError }
  );

  if (view.status === 'hidden') return null;

  if (view.status === 'loading') {
    return (
      <Card className={cn(PANEL_SLOT_CLASS)} role="status">
        <span className="sr-only">Loading spend alerts</span>
        <CardHeader>
          <CardTitle>Spend alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6" aria-hidden="true">
            <div className="bg-muted h-24 rounded-lg" />
            <div className="bg-muted h-[13.5rem] rounded-lg" />
            <div className="bg-muted h-[13.5rem] rounded-lg" />
            <div className="flex justify-end">
              <div className="bg-muted h-9 w-20 rounded-md" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (view.status === 'load-error') {
    return (
      <Card className={cn(PANEL_SLOT_CLASS)}>
        <CardContent className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle className="text-muted-foreground size-5" />
          <p className="type-body text-muted-foreground max-w-md">{view.message}</p>
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (view.status === 'forbidden') {
    return (
      <Card className={cn(PANEL_SLOT_CLASS)}>
        <CardContent className="flex h-full items-center justify-center p-6 text-center">
          <p className="type-body text-muted-foreground max-w-md">{view.message}</p>
        </CardContent>
      </Card>
    );
  }

  const currentDraft = draft ?? view.draft;
  const validation = toSaveInput(currentDraft);
  const masterOff = !currentDraft.enabled;
  // Off with a saved row is not the empty state: its switch, its rules and Save
  // all stay live, so turning the feature off (or adjusting a saved limit) can
  // be persisted. The empty state reads back the unsaveable defaults, so its
  // only action is the master switch.
  const controlsVisible = panelControlsVisible(currentDraft, view.hasSettings);

  const updateDraft = (next: SpendAlertsDraft) => {
    // An edit invalidates a save failure the caller has not retried yet.
    saveMutation.reset();
    setDraft(next);
  };

  const updateRule = (kind: SpendAlertRuleKind, patch: Partial<SpendAlertRuleDraft>) => {
    updateDraft({
      ...currentDraft,
      rules: currentDraft.rules.map(rule => (rule.kind === kind ? { ...rule, ...patch } : rule)),
    });
  };

  const save = () => {
    if (!validation.ok || validation.input === null) return;
    saveMutation.mutate(
      organizationId ? { organizationId, ...validation.input } : validation.input
    );
  };

  return (
    <Card className={cn(PANEL_SLOT_CLASS)}>
      <CardHeader>
        <CardTitle>Spend alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor={`${fieldId}-enabled`} className="text-base font-semibold">
              Enable spend alerts
            </Label>
            {/* Two reserved lines: the copy must not move the rules when the
                switch toggles. */}
            <p className="type-body text-muted-foreground min-h-10">
              {masterOff ? SPEND_ALERTS_OFF_COPY : ''}
            </p>
          </div>
          <Switch
            id={`${fieldId}-enabled`}
            checked={currentDraft.enabled}
            onCheckedChange={enabled => updateDraft({ ...currentDraft, enabled })}
          />
        </div>

        {currentDraft.rules.map(rule => (
          <RuleEditor
            key={rule.kind}
            id={`${fieldId}-${rule.kind}`}
            rule={rule}
            disabled={!controlsVisible}
            errors={validation.errors}
            pushCategoryEnabled={query.data?.pushCategoryEnabled ?? true}
            onChange={patch => updateRule(rule.kind, patch)}
          />
        ))}

        {/* One call to action at a time: a failed save retries the same draft,
            otherwise Save posts it. The never-configured empty state has
            nothing to post, so both buttons are absent there and its only
            action is the switch above. */}
        {controlsVisible &&
          (saveMutation.isError ? (
            <div className="border-destructive/40 bg-destructive/10 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <p className="type-body text-destructive">{view.save.error}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={save}
                disabled={saveMutation.isPending}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button onClick={save} disabled={!validation.ok || saveMutation.isPending}>
                Save
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

type RuleEditorProps = {
  id: string;
  rule: SpendAlertRuleDraft;
  /**
   * The panel is showing the empty state, which has nothing to save: the rule
   * is shown, but not editable.
   */
  disabled: boolean;
  errors: SpendAlertFieldErrors;
  pushCategoryEnabled: boolean;
  onChange: (patch: Partial<SpendAlertRuleDraft>) => void;
};

function RuleEditor({
  id,
  rule,
  disabled,
  errors,
  pushCategoryEnabled,
  onChange,
}: RuleEditorProps) {
  const isThreshold = rule.kind === 'threshold';
  const channelNote = disabled ? null : pushChannelNote(pushCategoryEnabled, rule);
  // A disabled rule is not being edited, so its bounds are not the caller's
  // problem yet: only an editable field reports what is wrong with it.
  const fieldError = disabled ? undefined : isThreshold ? errors.threshold : errors.multiplier;

  return (
    <div className={cn('rounded-lg border p-4', disabled && 'opacity-50')}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor={`${id}-enabled`} className="text-base font-semibold">
            {isThreshold ? 'Threshold crossing' : 'Hourly spike'}
          </Label>
          <p className="type-body text-muted-foreground">
            {isThreshold
              ? 'Rolling spend crosses your limit'
              : "An hour is far above this scope's usual rate"}
          </p>
        </div>
        <Switch
          id={`${id}-enabled`}
          checked={rule.enabled}
          onCheckedChange={enabled => onChange({ enabled })}
          disabled={disabled}
        />
      </div>

      <div className="mt-4 space-y-3">
        {isThreshold ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-limit`}>Limit (USD)</Label>
              <Input
                id={`${id}-limit`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={rule.thresholdUsd}
                onChange={event => onChange({ thresholdUsd: event.target.value })}
                disabled={disabled}
                aria-invalid={fieldError !== undefined}
                aria-describedby={fieldError ? `${id}-limit-error` : undefined}
              />
              {/* Reserved line: a field error must not move the row. */}
              <p id={`${id}-limit-error`} className="text-destructive min-h-5 text-xs">
                {fieldError}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-window`}>Window</Label>
              <Select
                value={String(rule.windowHours)}
                onValueChange={value =>
                  onChange({ windowHours: Number(value) as SpendAlertWindowHours })
                }
                disabled={disabled}
              >
                <SelectTrigger id={`${id}-window`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPEND_ALERT_WINDOW_HOURS.map(hours => (
                    <SelectItem key={hours} value={String(hours)}>
                      {WINDOW_LABELS[hours]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-multiplier`}>Spike multiplier</Label>
            <Input
              id={`${id}-multiplier`}
              type="number"
              inputMode="decimal"
              min={1}
              max={50}
              step="0.1"
              value={rule.multiplier}
              onChange={event => onChange({ multiplier: event.target.value })}
              disabled={disabled}
              aria-invalid={fieldError !== undefined}
              aria-describedby={fieldError ? `${id}-multiplier-error` : undefined}
            />
            <p id={`${id}-multiplier-error`} className="text-destructive min-h-5 text-xs">
              {fieldError}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-email`}
              checked={rule.emailEnabled}
              onCheckedChange={emailEnabled => onChange({ emailEnabled })}
              disabled={disabled}
            />
            <Label htmlFor={`${id}-email`} className="font-normal">
              Email
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              id={`${id}-push`}
              checked={rule.pushEnabled}
              onCheckedChange={pushEnabled => onChange({ pushEnabled })}
              disabled={disabled}
            />
            <Label htmlFor={`${id}-push`} className="font-normal">
              Push
            </Label>
            {channelNote && (
              <a
                href={channelNote.href}
                className="type-label text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                {channelNote.message}
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
