import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const OrgTownRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_org_id: z.string(),
  created_by_user_id: z.string(), // userId of the member who created it
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrgTownRecord = z.output<typeof OrgTownRecord>;

export const org_towns = getTableFromZodSchema('org_towns', OrgTownRecord);

export function createTableOrgTowns(): string {
  return getCreateTableQueryFromTable(org_towns, {
    id: 'text primary key',
    name: 'text not null',
    owner_org_id: 'text not null',
    created_by_user_id: 'text not null',
    created_at: 'text not null',
    updated_at: 'text not null',
  });
}
