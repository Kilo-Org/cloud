import { useQuery } from '@tanstack/react-query';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import { ORGANIZATION_DATA_REGION_NAMES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';

const PILL_BASE =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none';

const REGION_FLAGS = {
  us: '🇺🇸',
  eu: '🇪🇺',
  au: '🇦🇺',
  jp: '🇯🇵',
} as const satisfies Record<OrganizationDataRegion, string>;

function AvailabilityPill({ available }: { available: boolean }) {
  return available ? (
    <span className={`${PILL_BASE} border-emerald-500/30 bg-emerald-500/15 text-emerald-300`}>
      Yes
    </span>
  ) : (
    <span className={`${PILL_BASE} border-border bg-muted text-muted-foreground`}>No</span>
  );
}

function RegionFlags({ regions }: { regions: ReadonlyArray<OrganizationDataRegion> }) {
  if (regions.length === 0) {
    return <span className="text-muted-foreground text-xs">None</span>;
  }
  return (
    <ul className="flex items-center gap-1.5" aria-label="Inference regions">
      {regions.map(region => (
        <li key={region} title={ORGANIZATION_DATA_REGION_NAMES[region]} className="text-base">
          <span aria-hidden="true">{REGION_FLAGS[region]}</span>
          <span className="sr-only">{ORGANIZATION_DATA_REGION_NAMES[region]}</span>
        </li>
      ))}
    </ul>
  );
}

export function GatewayAvailabilityTable({
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Gateway</TableHead>
          <TableHead>Available</TableHead>
          <TableHead>Inference regions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isPending || isError ? (
          <TableRow>
            <TableCell colSpan={3} className="text-muted-foreground text-xs">
              {isPending ? 'Loading gateway availability…' : 'Could not load gateway availability.'}
            </TableCell>
          </TableRow>
        ) : (
          <>
            <TableRow>
              <TableCell className="font-medium">Vercel AI Gateway</TableCell>
              <TableCell>
                <AvailabilityPill available={data.vercel.available} />
              </TableCell>
              <TableCell>
                {data.vercel.available ? (
                  <RegionFlags regions={data.vercel.regions} />
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">OpenRouter</TableCell>
              <TableCell>
                <AvailabilityPill available={data.openrouter.available} />
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground text-xs">—</span>
              </TableCell>
            </TableRow>
          </>
        )}
      </TableBody>
    </Table>
  );
}
