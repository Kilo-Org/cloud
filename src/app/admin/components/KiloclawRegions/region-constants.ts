export type RegionDef = {
  code: string;
  label: string;
  area: string;
  description?: string;
};

export const META_REGIONS: RegionDef[] = [
  {
    code: 'eu',
    label: 'Europe',
    area: 'Meta',
    description: 'Fly meta-region — all EU datacenters',
  },
  {
    code: 'us',
    label: 'United States',
    area: 'Meta',
    description: 'Fly meta-region — all US datacenters',
  },
];

export const SPECIFIC_REGIONS: RegionDef[] = [
  // Africa
  { code: 'jnb', label: 'Johannesburg, South Africa', area: 'Africa' },
  // Asia Pacific
  { code: 'bom', label: 'Mumbai, India', area: 'Asia Pacific' },
  { code: 'sin', label: 'Singapore, Singapore', area: 'Asia Pacific' },
  { code: 'syd', label: 'Sydney, Australia', area: 'Asia Pacific' },
  { code: 'nrt', label: 'Tokyo, Japan', area: 'Asia Pacific' },
  // Europe
  { code: 'ams', label: 'Amsterdam, Netherlands', area: 'Europe' },
  { code: 'fra', label: 'Frankfurt, Germany', area: 'Europe' },
  { code: 'lhr', label: 'London, United Kingdom', area: 'Europe' },
  { code: 'cdg', label: 'Paris, France', area: 'Europe' },
  { code: 'arn', label: 'Stockholm, Sweden', area: 'Europe' },
  // North America
  { code: 'iad', label: 'Ashburn, Virginia (US)', area: 'North America' },
  { code: 'ord', label: 'Chicago, Illinois (US)', area: 'North America' },
  { code: 'dfw', label: 'Dallas, Texas (US)', area: 'North America' },
  { code: 'lax', label: 'Los Angeles, California (US)', area: 'North America' },
  { code: 'sjc', label: 'San Jose, California (US)', area: 'North America' },
  { code: 'ewr', label: 'Secaucus, NJ (US)', area: 'North America' },
  { code: 'yyz', label: 'Toronto, Canada', area: 'North America' },
  // South America
  { code: 'gru', label: 'Sao Paulo, Brazil', area: 'South America' },
];

const META_CODES = new Set(META_REGIONS.map(r => r.code));
const SPECIFIC_CODES = new Set(SPECIFIC_REGIONS.map(r => r.code));

/** Check if a region list mixes meta and specific codes. */
export function hasMixedRegionTypes(regions: string[]): boolean {
  const hasMeta = regions.some(r => META_CODES.has(r));
  const hasSpecific = regions.some(r => SPECIFIC_CODES.has(r));
  return hasMeta && hasSpecific;
}
