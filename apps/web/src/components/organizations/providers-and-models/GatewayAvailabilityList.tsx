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

  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">Available on</div>
      {isPending || isError ? (
        <p className="text-muted-foreground text-xs">
          {isPending ? 'Loading gateway availability…' : 'Could not load gateway availability.'}
        </p>
      ) : data.gateways.length === 0 ? (
        <p className="text-muted-foreground text-xs">No gateway serves this model.</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {data.gateways.map(gateway => (
            <li key={gateway}>{GATEWAY_NAMES[gateway]}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
