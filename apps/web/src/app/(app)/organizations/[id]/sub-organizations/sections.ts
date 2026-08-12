export const SUB_ORGANIZATION_SECTIONS = [
  'overview',
  'people',
  'usage',
  'credits',
  'distribute-funds',
  'models',
  'permissions',
] as const;

export type SubOrganizationSection = (typeof SUB_ORGANIZATION_SECTIONS)[number];

export function isSubOrganizationSection(value: string): value is SubOrganizationSection {
  return SUB_ORGANIZATION_SECTIONS.some(section => section === value);
}
