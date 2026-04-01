import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { query } from '../../util/query.util';

// ── Schema & Table ──────────────────────────────────────────────────────

export const WastelandMemberRecord = z.object({
  member_id: z.string(),
  user_id: z.string(),
  trust_level: z.number().int().min(1).max(3),
  role: z.enum(['contributor', 'maintainer', 'owner']),
  joined_at: z.string(),
});

export type WastelandMemberRecord = z.output<typeof WastelandMemberRecord>;

export const wasteland_members = getTableFromZodSchema(
  'wasteland_members',
  WastelandMemberRecord
);

export function createTableWastelandMembers(): string {
  return getCreateTableQueryFromTable(wasteland_members, {
    member_id: `TEXT PRIMARY KEY`,
    user_id: `TEXT NOT NULL`,
    trust_level: `INTEGER NOT NULL DEFAULT 1 CHECK(trust_level BETWEEN 1 AND 3)`,
    role: `TEXT NOT NULL DEFAULT 'contributor' CHECK(role IN ('contributor', 'maintainer', 'owner'))`,
    joined_at: `TEXT NOT NULL DEFAULT (datetime('now'))`,
  });
}

// ── Operations ──────────────────────────────────────────────────────────

export function addMember(
  sql: SqlStorage,
  userId: string,
  role: string,
  trustLevel: number
): string {
  const memberId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${wasteland_members} (
        ${wasteland_members.columns.member_id},
        ${wasteland_members.columns.user_id},
        ${wasteland_members.columns.role},
        ${wasteland_members.columns.trust_level},
        ${wasteland_members.columns.joined_at}
      ) VALUES (?, ?, ?, ?, ?)
    `,
    [memberId, userId, role, trustLevel, timestamp]
  );
  return memberId;
}

export function removeMember(sql: SqlStorage, memberId: string): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${wasteland_members}
      WHERE ${wasteland_members.member_id} = ?
    `,
    [memberId]
  );
}

export function listMembers(sql: SqlStorage): WastelandMemberRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_members}
        ORDER BY ${wasteland_members.joined_at} ASC
      `,
      []
    ),
  ];
  return WastelandMemberRecord.array().parse(rows);
}

export function getMember(
  sql: SqlStorage,
  userId: string
): WastelandMemberRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_members}
        WHERE ${wasteland_members.user_id} = ?
      `,
      [userId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandMemberRecord.parse(rows[0]);
}
