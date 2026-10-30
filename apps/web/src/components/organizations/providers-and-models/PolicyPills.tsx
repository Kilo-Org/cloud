import type { PolicyPillVariant } from '@/components/organizations/providers-and-models/providersAndModels.types';

const PILL_BASE =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none';

export const BYOK_ONLY_DESCRIPTION =
  'Only serves requests through your organization’s own API key for this provider, when the key uses Kilo catalog model IDs.';

export function PolicyPill({ value, variant }: { value: boolean; variant: PolicyPillVariant }) {
  if (!value) {
    return <span className={`${PILL_BASE} border-border bg-muted text-muted-foreground`}>No</span>;
  }

  if (variant === 'trains') {
    return <span className={`${PILL_BASE} border-red-500/30 bg-red-500/15 text-red-300`}>Yes</span>;
  }

  return (
    <span className={`${PILL_BASE} border-orange-500/30 bg-orange-500/15 text-orange-300`}>
      Yes
    </span>
  );
}

export function ProviderPolicyTag({
  value,
  variant,
}: {
  value: boolean;
  variant: PolicyPillVariant;
}) {
  if (!value) return null;

  if (variant === 'trains') {
    return (
      <span className={`${PILL_BASE} border-red-500/30 bg-red-500/15 text-red-300`}>Trains</span>
    );
  }

  return (
    <span className={`${PILL_BASE} border-orange-500/30 bg-orange-500/15 text-orange-300`}>
      Retains prompts
    </span>
  );
}

/** Marks a provider that Kilo never routes to: it only serves the organization's own keys. */
export function ByokOnlyTag({ value }: { value: boolean | undefined }) {
  if (!value) return null;
  return (
    <span
      className={`${PILL_BASE} border-border bg-muted text-muted-foreground`}
      title={BYOK_ONLY_DESCRIPTION}
    >
      BYOK only
    </span>
  );
}

/** Replaces both price cells of a BYOK-only offering: the provider bills the organization. */
export function ByokOnlyPriceCell() {
  return <span className="text-muted-foreground text-xs">Billed by provider</span>;
}
