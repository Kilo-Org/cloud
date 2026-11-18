import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

const GATEWAY_NAMES = {
  vercel: 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
} as const;

export function GatewayAvailabilityList({
  organizationId,
  modelId,
}: {
  organizationId: string;
  modelId: string;
}) {
  const trpc = useTRPC();
  const { data, isPending, isError } = useQuery(
    trpc.organizations.settings.getModelGatewayAvailability.queryOptions({
      organizationId,
      modelId,
    })
  );

  if (isPending || isError) {
    return (
      <p className="text-muted-foreground text-xs">
        {isPending ? 'Loading gateway availability…' : 'Could not load gateway availability.'}
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-xs">
      Available on:{' '}
      <span className="text-foreground">
        {data.gateways.length === 0
          ? 'no gateway'
          : data.gateways.map(gateway => GATEWAY_NAMES[gateway]).join(', ')}
      </span>
    </p>
  );
}
