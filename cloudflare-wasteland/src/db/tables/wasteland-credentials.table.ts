import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandCredentialRecord = z.object({
  user_id: z.string(),
  encrypted_token: z.string(),
  dolthub_org: z.string(),
  rig_handle: z.string().nullable(),
  connected_at: z.string(),
});

export type WastelandCredentialRecord = z.output<typeof WastelandCredentialRecord>;

export const wasteland_credentials = getTableFromZodSchema(
  'wasteland_credentials',
  WastelandCredentialRecord
);

export function createTableWastelandCredentials(): string {
  return getCreateTableQueryFromTable(wasteland_credentials, {
    user_id: `text primary key`,
    encrypted_token: `text not null`,
    dolthub_org: `text not null`,
    rig_handle: `text`,
    connected_at: `text not null default (datetime('now'))`,
  });
}
