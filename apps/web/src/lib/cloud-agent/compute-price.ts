import {
  CLOUDFLARE_CONTAINERS_INSTANCES,
  type CloudflareContainersInstance,
  type SandboxAllocationRequest,
  type SandboxDestination,
} from '@kilocode/worker-utils/sandbox-allocation';

/** The instance of a Kilo-hosted container. Other providers bill compute themselves, so they get no price. */
export function kiloContainersInstance(
  destination: SandboxAllocationRequest | SandboxDestination | undefined
): CloudflareContainersInstance | null {
  if (
    destination?.provider.id !== 'cloudflare-containers' ||
    destination.provider.account !== 'kilo'
  )
    return null;
  return (
    CLOUDFLARE_CONTAINERS_INSTANCES.find(instance => instance === destination.instanceType) ?? null
  );
}

function isKnownHourlyRate(hourlyUsd: number | null | undefined): hourlyUsd is number {
  return hourlyUsd != null && Number.isFinite(hourlyUsd) && hourlyUsd > 0;
}

export function formatComputePrice(hourlyUsd: number | null | undefined): string {
  if (!isKnownHourlyRate(hourlyUsd)) return 'Price unavailable';
  if (hourlyUsd < 0.01) return '<$0.01/hr';
  return `~${formatHourlyRate(hourlyUsd)}`;
}

export function formatHourlyRate(hourlyUsd: number): string {
  return `${new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hourlyUsd)}/hr`;
}

export type ComputeBillingMode = 'shadow' | 'paid';

/** Shadow-mode usage is metered but not charged yet, so its price is an upcoming one. */
export function computePriceLabel(billingMode: ComputeBillingMode): string {
  return billingMode === 'shadow' ? 'Upcoming compute price' : 'Compute price';
}

/** The price to show before a session starts, or null when the billing mode or price is unknown. */
export function computePriceNote(
  billingMode: ComputeBillingMode | undefined,
  rate: { hourlyUsd: number | null; available: boolean } | undefined
): { label: string; price: string } | null {
  if (!billingMode || !rate?.available || !isKnownHourlyRate(rate.hourlyUsd)) return null;
  return { label: computePriceLabel(billingMode), price: formatComputePrice(rate.hourlyUsd) };
}
