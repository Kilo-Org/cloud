import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import { ORGANIZATION_DATA_REGION_NAMES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

const REGION_FLAGS = {
  us: '🇺🇸',
  eu: '🇪🇺',
  au: '🇦🇺',
  jp: '🇯🇵',
} as const satisfies Record<OrganizationDataRegion, string>;

export function InferenceRegionFlags({
  regions,
}: {
  regions: ReadonlyArray<OrganizationDataRegion>;
}) {
  if (regions.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
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
