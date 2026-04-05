import type { PolicyPillVariant } from '@/components/organizations/providers-and-models/providersAndModels.types';

export function PolicyPill({ value, variant }: { value: boolean; variant: PolicyPillVariant }) {
  const base =
    'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none';

  if (!value) {
    return <span className={`${base} border-border bg-muted text-muted-foreground`}>No</span>;
  }

  if (variant === 'trains') {
    return <span className={`${base} border-red-500/30 bg-red-500/15 text-red-300`}>Yes</span>;
  }

  return (
    <span className={`${base} border-orange-500/30 bg-orange-500/15 text-orange-300`}>Yes</span>
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

  const base =
    'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none';
  if (variant === 'trains') {
    return <span className={`${base} border-red-500/30 bg-red-500/15 text-red-300`}>Trains</span>;
  }

  return (
    <span className={`${base} border-orange-500/30 bg-orange-500/15 text-orange-300`}>
      Retains prompts
    </span>
  );
}
