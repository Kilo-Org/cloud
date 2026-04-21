'use client';

import { useState } from 'react';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { CREDIT_CAMPAIGN_SLUG_FORMAT } from '@/lib/credit-campaigns-shared';

/**
 * Shared schema with the tRPC `create`/`update` inputs. Values that are
 * empty in the UI (blank string for "no end date", blank for "no cap",
 * etc.) normalize to `null` for the server. Matching the server schema
 * close in shape keeps client + server validation from drifting.
 */
const campaignSharedFields = {
  slug: z.string().regex(CREDIT_CAMPAIGN_SLUG_FORMAT, {
    message: 'Slug must be 5-40 lowercase alphanumerics or hyphens',
  }),
  amount_usd: z
    .number({ message: 'Enter an amount' })
    .min(0.01, 'Amount must be at least $0.01')
    .max(1000, 'Amount capped at $1000 to prevent typo disasters'),
  credit_expiry_hours: z
    .number()
    .int()
    .positive()
    .max(87_600, 'Credit expiry capped at 87,600 hours (~10 years)')
    .nullable(),
  // Base campaign_ends_at shape without the future-only refine. Create mode
  // adds the refine on top; edit mode preserves existing past values so
  // admins can touch other fields on a naturally-expired campaign.
  campaign_ends_at: z.string().datetime({ offset: true }).nullable(),
  total_redemptions_allowed: z
    .number({ message: 'Max redemptions is required' })
    .int()
    .positive('Must be at least 1')
    .max(1_000_000, 'Max redemptions capped at 1,000,000'),
  active: z.boolean(),
  description: z
    .string()
    .min(1, 'Notes are required')
    .max(1000)
    .refine(v => v.trim().length > 0, 'Notes cannot be whitespace-only'),
};

const createFormSchema = z.object({
  ...campaignSharedFields,
  campaign_ends_at: campaignSharedFields.campaign_ends_at.refine(
    v => v === null || new Date(v).getTime() > Date.now(),
    { message: 'Campaign end date must be in the future' }
  ),
});

const updateFormSchema = z.object(campaignSharedFields);

export type CampaignFormValues = z.infer<typeof createFormSchema>;

type Props = {
  submitLabel: string;
  pending: boolean;
  defaultValues?: Partial<CampaignFormValues>;
  /**
   * When true, the slug input is disabled and a help note explains why.
   * Used on edit because the slug is immutable after create — changing it
   * would orphan existing `credit_transactions` rows from the new category.
   */
  slugReadOnly?: boolean;
  onSubmit: (values: CampaignFormValues) => void;
};

type RawForm = {
  slug: string;
  amountUsd: string;
  creditExpiryHours: string;
  campaignEndsAt: string;
  totalRedemptionsAllowed: string;
  active: boolean;
  description: string;
};

function toRaw(defaults?: Partial<CampaignFormValues>): RawForm {
  return {
    slug: defaults?.slug ?? '',
    amountUsd: defaults?.amount_usd != null ? String(defaults.amount_usd) : '',
    creditExpiryHours:
      defaults?.credit_expiry_hours != null ? String(defaults.credit_expiry_hours) : '',
    campaignEndsAt: defaults?.campaign_ends_at ? toDatetimeLocal(defaults.campaign_ends_at) : '',
    totalRedemptionsAllowed:
      defaults?.total_redemptions_allowed != null ? String(defaults.total_redemptions_allowed) : '',
    active: defaults?.active ?? true,
    description: defaults?.description ?? '',
  };
}

function nowDatetimeLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocal(iso: string): string {
  // Strip seconds/timezone for the `datetime-local` input. Values come
  // back in the browser's local TZ; we convert back to ISO on submit.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CampaignForm({
  submitLabel,
  pending,
  defaultValues,
  slugReadOnly = false,
  onSubmit,
}: Props) {
  const [raw, setRaw] = useState<RawForm>(() => toRaw(defaultValues));
  const [errors, setErrors] = useState<Partial<Record<keyof CampaignFormValues, string>>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount_usd = raw.amountUsd === '' ? NaN : Number(raw.amountUsd);
    const credit_expiry_hours = raw.creditExpiryHours === '' ? null : Number(raw.creditExpiryHours);
    const campaign_ends_at =
      raw.campaignEndsAt === '' ? null : new Date(raw.campaignEndsAt).toISOString();
    const total_redemptions_allowed =
      raw.totalRedemptionsAllowed === '' ? NaN : Number(raw.totalRedemptionsAllowed);

    const schema = slugReadOnly ? updateFormSchema : createFormSchema;
    const parsed = schema.safeParse({
      slug: raw.slug.trim(),
      amount_usd,
      credit_expiry_hours,
      campaign_ends_at,
      total_redemptions_allowed,
      active: raw.active,
      description: raw.description,
    });

    if (!parsed.success) {
      const next: Partial<Record<keyof CampaignFormValues, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof CampaignFormValues | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    onSubmit(parsed.data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={raw.slug}
            maxLength={40}
            disabled={slugReadOnly}
            onChange={e => setRaw(s => ({ ...s, slug: e.target.value }))}
            placeholder="e.g. summit"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            {slugReadOnly ? (
              <>
                Slug cannot be changed after creation — existing redemptions are tied to this value.
              </>
            ) : (
              <>
                Public URL: <code>/c/{raw.slug || '<slug>'}</code>
              </>
            )}
          </p>
          {errors.slug && <p className="text-destructive mt-1 text-xs">{errors.slug}</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount (USD)</Label>
          <Input
            id="amount"
            type="number"
            value={raw.amountUsd}
            min="0.01"
            step="0.01"
            max="1000"
            onChange={e => setRaw(s => ({ ...s, amountUsd: e.target.value }))}
            placeholder="5.00"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Bonus credits granted on signup, on top of the standard $2.50 new user welcome credit.
          </p>
          {errors.amount_usd && (
            <p className="text-destructive mt-1 text-xs">{errors.amount_usd}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="expiry">Credit expiry (hours)</Label>
          <Input
            id="expiry"
            type="number"
            value={raw.creditExpiryHours}
            min="1"
            step="1"
            max="87600"
            onChange={e => setRaw(s => ({ ...s, creditExpiryHours: e.target.value }))}
            placeholder="48 (or blank for no expiry)"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Credits expire this many hours after the user signs up.
          </p>
          {errors.credit_expiry_hours && (
            <p className="text-destructive mt-1 text-xs">{errors.credit_expiry_hours}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="campaign_ends_at">Campaign end date</Label>
          <Input
            id="campaign_ends_at"
            type="datetime-local"
            value={raw.campaignEndsAt}
            // Only nudge toward future dates on create. On edit the current
            // value may already be in the past and the admin is touching
            // unrelated fields — don't block that with a native min= hint.
            min={slugReadOnly ? undefined : nowDatetimeLocal()}
            onChange={e => setRaw(s => ({ ...s, campaignEndsAt: e.target.value }))}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            After this date the URL still works but the bonus is not awarded.
          </p>
          {errors.campaign_ends_at && (
            <p className="text-destructive mt-1 text-xs">{errors.campaign_ends_at}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cap">
            Max redemptions
            {(() => {
              const cap = Number(raw.totalRedemptionsAllowed);
              const amt = Number(raw.amountUsd);
              if (!raw.totalRedemptionsAllowed || !raw.amountUsd) return null;
              if (!Number.isFinite(cap) || !Number.isFinite(amt) || cap <= 0 || amt <= 0) {
                return null;
              }
              const total = cap * amt;
              const formatted =
                total % 1 === 0 ? `$${total.toLocaleString()}` : `$${total.toFixed(2)}`;
              return (
                <span className="text-muted-foreground font-normal">
                  {' '}
                  ({cap.toLocaleString()} × ${amt.toLocaleString()} = {formatted})
                </span>
              );
            })()}
          </Label>
          <Input
            id="cap"
            type="number"
            value={raw.totalRedemptionsAllowed}
            min="1"
            step="1"
            max="1000000"
            onChange={e => setRaw(s => ({ ...s, totalRedemptionsAllowed: e.target.value }))}
            placeholder="e.g. 100"
          />
          {errors.total_redemptions_allowed && (
            <p className="text-destructive mt-1 text-xs">{errors.total_redemptions_allowed}</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="active"
            checked={raw.active}
            onCheckedChange={checked => setRaw(s => ({ ...s, active: checked }))}
          />
          <Label htmlFor="active">Active</Label>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Notes</Label>
        <Textarea
          id="description"
          value={raw.description}
          maxLength={1000}
          onChange={e => setRaw(s => ({ ...s, description: e.target.value }))}
          placeholder="Who this is for, when it was promoted, etc."
          rows={3}
        />
        {errors.description && (
          <p className="text-destructive mt-1 text-xs">{errors.description}</p>
        )}
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}
