'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Info, X } from 'lucide-react';
import { useState } from 'react';
import { AlertEditorFooter } from '@/components/organizations/alerts/AlertEditorFooter';
import type { OrganizationAlertEditorProps } from '@/components/organizations/alerts/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MAX_ORGANIZATION_ALERT_RECIPIENTS } from '@/lib/organizations/alerts/organization-alerts';
import { useTRPC } from '@/lib/trpc/utils';
import {
  addMonthlySpendingRecipient,
  buildMonthlySpendingSubmission,
  monthlySpendingAdmissionNotice,
  monthlySpendingDisclosureRequired,
  monthlySpendingFormState,
  type MonthlySpendingFormErrors,
  type MonthlySpendingFormState,
} from './monthly-spending-form';

const THRESHOLD_ID = 'monthly-spending-threshold';
const SCOPE_ID = 'monthly-spending-scope';
const GROUP_ID = 'monthly-spending-group';
const RECIPIENT_ID = 'monthly-spending-recipient';
const DISCLOSURE_ID = 'monthly-spending-disclosure';

/**
 * `organizations.groups.list` returns a different shape for a manager (every
 * group in the organization, with extra fields this picker does not need)
 * than for an ordinary member (only the groups they belong to, already
 * `{id, name, description}`). Normalized to one flat list here rather than in
 * the router, since that role-scoping is the groups feature's own access
 * model and this picker only needs to read it, not change it. A caller with
 * the `admin` role is inheriting that same member-shaped restriction today, so
 * they see only their own groups here too.
 */
function useOrganizationGroupOptions(
  organizationId: string
): { id: string; name: string }[] | undefined {
  const trpc = useTRPC();
  const groupsQuery = useQuery(trpc.organizations.groups.list.queryOptions({ organizationId }));
  if (!groupsQuery.data) return undefined;
  return groupsQuery.data.groups.map(group => ({ id: group.id, name: group.name }));
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="type-label text-status-destructive">
      {message}
    </p>
  );
}

/**
 * Owns every Monthly Spending field and its validation. The shell contributes
 * only the generic lifecycle chrome, so a future alert type brings its own editor
 * instead of adding optional fields here.
 */
export function MonthlySpendingAlertEditor({
  context,
  onSave,
  isSaving,
  error,
  onCancel,
  lifecycle,
}: OrganizationAlertEditorProps<'monthly_spending'>) {
  const saved = context.definition.configuration;
  const [state, setState] = useState<MonthlySpendingFormState>(() =>
    monthlySpendingFormState(saved)
  );
  const [errors, setErrors] = useState<MonthlySpendingFormErrors>({});

  // A new alert is saved enabled, so it needs a recipient; an existing alert
  // keeps whichever state it is already in.
  const willBeEnabled = lifecycle?.isEnabled ?? true;
  const disclosureRequired = monthlySpendingDisclosureRequired({
    state,
    mode: context.mode,
    saved,
  });
  const admissionNotice = monthlySpendingAdmissionNotice(context.admittedRecipientCount);
  // Without entitlement the editor still saves, but only shrinking changes:
  // removing a recipient must never be trapped by a downgrade.
  const canExpand = context.canExpand;
  const groupOptions = useOrganizationGroupOptions(context.organizationId);

  function addRecipient() {
    const result = addMonthlySpendingRecipient(state);
    if (!result.ok) {
      setErrors(current => ({ ...current, pendingRecipient: result.error }));
      return;
    }
    setState(current => ({ ...current, recipients: result.recipients, pendingRecipient: '' }));
    setErrors(current => ({ ...current, pendingRecipient: undefined, recipients: undefined }));
  }

  function removeRecipient(recipient: string) {
    setState(current => ({
      ...current,
      recipients: current.recipients.filter(configured => configured !== recipient),
    }));
    setErrors(current => ({ ...current, recipients: undefined }));
  }

  function save() {
    const submission = buildMonthlySpendingSubmission({
      state,
      mode: context.mode,
      saved,
      requireRecipient: willBeEnabled,
    });
    if (!submission.ok) {
      setErrors(submission.errors);
      return;
    }
    setErrors({});
    onSave({
      definition: submission.definition,
      recipientDisclosureConfirmed: submission.recipientDisclosureConfirmed,
    });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 content-start gap-5 p-5">
        <Alert>
          <Info />
          <AlertTitle>This alert only notifies people</AlertTitle>
          <AlertDescription>
            <p>
              Kilo emails the recipients below when the measured AI usage spend of whatever this
              alert measures reaches your amount during a UTC calendar month. It does not stop
              usage, block models, or cap charges, and the amount excludes seats, Kilo Pass,
              KiloClaw compute, Exa, and Coding Plans.
            </p>
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            {/* Covers save, enable, disable, and archive: they all report here. */}
            <AlertTitle>This change was not saved</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
            </AlertDescription>
          </Alert>
        )}

        {!canExpand && (
          <Alert>
            <Info />
            <AlertTitle>Enterprise plan required</AlertTitle>
            <AlertDescription>
              <p>
                {context.mode === 'create'
                  ? 'Monthly spending alerts can only be created by Enterprise organizations.'
                  : 'The amount and new recipients are locked while this organization is not on the Enterprise plan. Removing recipients, disabling, and archiving stay available.'}
              </p>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor={THRESHOLD_ID}>Notify at this month-to-date spend (USD)</Label>
          <Input
            id={THRESHOLD_ID}
            className="tabular-nums"
            inputMode="decimal"
            placeholder="500.00"
            value={state.thresholdUsd}
            disabled={!canExpand}
            aria-invalid={Boolean(errors.thresholdUsd)}
            aria-describedby={
              errors.thresholdUsd ? `${THRESHOLD_ID}-error` : `${THRESHOLD_ID}-help`
            }
            onChange={event =>
              setState(current => ({ ...current, thresholdUsd: event.target.value }))
            }
          />
          <p id={`${THRESHOLD_ID}-help`} className="type-label text-muted-foreground">
            Dollars and cents, measured from 00:00 UTC on the first of the month until the first of
            the next month. Usage earlier in the current month already counts.
          </p>
          <FieldError id={`${THRESHOLD_ID}-error`} message={errors.thresholdUsd} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={SCOPE_ID}>Measure</Label>
          <Select
            value={state.scopeType}
            disabled={!canExpand}
            onValueChange={value => {
              const scopeType = value as MonthlySpendingFormState['scopeType'];
              setState(current => ({ ...current, scopeType }));
              setErrors(current => ({ ...current, scope: undefined }));
            }}
          >
            <SelectTrigger id={SCOPE_ID} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="organization">Whole organization</SelectItem>
              <SelectItem value="group">A specific group</SelectItem>
            </SelectContent>
          </Select>
          <p id={`${SCOPE_ID}-help`} className="type-label text-muted-foreground">
            A group measures whoever currently belongs to it: changing the group&apos;s members
            changes what this alert measures, including for the rest of the current month.
          </p>

          {state.scopeType === 'group' && (
            <>
              <Select
                value={state.groupId ?? undefined}
                disabled={!canExpand}
                onValueChange={groupId => {
                  setState(current => ({ ...current, groupId }));
                  setErrors(current => ({ ...current, scope: undefined }));
                }}
              >
                <SelectTrigger
                  id={GROUP_ID}
                  className="w-full"
                  aria-invalid={Boolean(errors.scope)}
                  aria-describedby={errors.scope ? `${SCOPE_ID}-error` : undefined}
                >
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
                  {groupOptions?.map(group => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id={`${SCOPE_ID}-error`} message={errors.scope} />
            </>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={RECIPIENT_ID}>
            Recipients ({state.recipients.length}/{MAX_ORGANIZATION_ALERT_RECIPIENTS})
          </Label>
          <div className="flex gap-2">
            <Input
              id={RECIPIENT_ID}
              type="email"
              autoComplete="email"
              placeholder="finance@example.com"
              value={state.pendingRecipient}
              disabled={!canExpand || state.recipients.length >= MAX_ORGANIZATION_ALERT_RECIPIENTS}
              aria-invalid={Boolean(errors.pendingRecipient)}
              // The configured-list error is associated here too, because this is
              // the control that fixes it.
              aria-describedby={[
                errors.pendingRecipient ? `${RECIPIENT_ID}-error` : `${RECIPIENT_ID}-help`,
                errors.recipients ? `${RECIPIENT_ID}-list-error` : null,
              ]
                .filter(Boolean)
                .join(' ')}
              onChange={event =>
                setState(current => ({ ...current, pendingRecipient: event.target.value }))
              }
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addRecipient();
              }}
            />
            <Button
              variant="outline"
              disabled={!canExpand || !state.pendingRecipient.trim()}
              onClick={addRecipient}
            >
              Add
            </Button>
          </div>
          <p id={`${RECIPIENT_ID}-help`} className="type-label text-muted-foreground">
            Up to {MAX_ORGANIZATION_ALERT_RECIPIENTS} addresses, which do not have to be Kilo
            members. Addresses are lowercased and deduplicated. Links in the email still require
            normal Kilo sign-in.
          </p>
          <FieldError id={`${RECIPIENT_ID}-error`} message={errors.pendingRecipient} />

          {state.recipients.length > 0 && (
            <ul className="divide-border divide-y overflow-hidden rounded-lg border">
              {state.recipients.map(recipient => (
                <li key={recipient} className="flex min-h-11 items-center gap-2 px-3 py-2">
                  <span className="type-body min-w-0 flex-1 truncate">{recipient}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${recipient}`}
                    onClick={() => removeRecipient(recipient)}
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <FieldError id={`${RECIPIENT_ID}-list-error`} message={errors.recipients} />

          {admissionNotice && (
            <Alert>
              <Info />
              <AlertTitle>This month&apos;s recipients are already used up</AlertTitle>
              <AlertDescription>
                <p>{admissionNotice}</p>
              </AlertDescription>
            </Alert>
          )}
        </div>

        {disclosureRequired && (
          <div className="grid gap-1.5">
            <label
              htmlFor={DISCLOSURE_ID}
              className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3"
            >
              <Checkbox
                id={DISCLOSURE_ID}
                checked={state.disclosureConfirmed}
                aria-invalid={Boolean(errors.disclosure)}
                aria-describedby={errors.disclosure ? `${DISCLOSURE_ID}-error` : undefined}
                onCheckedChange={checked =>
                  setState(current => ({ ...current, disclosureConfirmed: checked === true }))
                }
              />
              <span className="type-body">
                I confirm every address above may receive this organization&apos;s name and the
                measured month-to-date AI usage spend this alert covers.
              </span>
            </label>
            <FieldError id={`${DISCLOSURE_ID}-error`} message={errors.disclosure} />
          </div>
        )}

        <p className="type-label text-muted-foreground">
          When you save, Kilo evaluates the full current month in the background and may queue email
          right away if the amount has already been reached. Saving does not wait for that
          evaluation, and measured amounts may lag recent usage.
        </p>
      </div>

      <AlertEditorFooter
        mode={context.mode}
        isSaving={isSaving}
        canExpand={canExpand}
        onSave={save}
        onCancel={onCancel}
        lifecycle={lifecycle}
      />
    </div>
  );
}
