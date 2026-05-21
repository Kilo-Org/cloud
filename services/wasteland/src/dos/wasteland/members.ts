import { query } from '../../util/query.util';
import {
  createTableWastelandMembers,
  wasteland_members,
  WastelandMemberRecord,
} from '../../db/tables/wasteland-members.table';

export type WastelandMemberResult = {
  member_id: string;
  user_id: string;
  trust_level: number;
  role: 'contributor' | 'maintainer' | 'owner';
  joined_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandMembers(), []);
}

export function listMembers(sql: SqlStorage, wastelandId: string): WastelandMemberResult[] {
  const rows: Record<string, unknown>[] = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_members}
        WHERE ${wasteland_members.wasteland_id} = ?
        ORDER BY ${wasteland_members.columns.joined_at} ASC
      `,
      [wastelandId]
    ),
  ];
  return WastelandMemberRecord.array().parse(rows);
}

export function addMember(
  sql: SqlStorage,
  wastelandId: string,
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
        ${wasteland_members.columns.wasteland_id},
        ${wasteland_members.columns.user_id},
        ${wasteland_members.columns.role},
        ${wasteland_members.columns.trust_level},
        ${wasteland_members.columns.joined_at}
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [memberId, wastelandId, userId, role, trustLevel, timestamp]
  );
  return memberId;
}

export function removeMember(sql: SqlStorage, memberId: string): void {
  query(
    sql,
    /* sql */ `DELETE FROM ${wasteland_members} WHERE ${wasteland_members.columns.member_id} = ?`,
    [memberId]
  );
}

export function getMember(
  sql: SqlStorage,
  wastelandId: string,
  userId: string
): WastelandMemberResult | null {
  const rows: Record<string, unknown>[] = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_members}
        WHERE ${wasteland_members.wasteland_id} = ?
          AND ${wasteland_members.columns.user_id} = ?
      `,
      [wastelandId, userId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandMemberRecord.parse(rows[0]);
}

export function updateMember(
  sql: SqlStorage,
  wastelandId: string,
  memberId: string,
  update: { role?: string; trust_level?: number }
): WastelandMemberResult | null {
  const rows: Record<string, unknown>[] = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_members} WHERE ${wasteland_members.columns.member_id} = ?`,
      [memberId]
    ),
  ];
  if (rows.length === 0) return null;
  const current = WastelandMemberRecord.parse(rows[0]);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (update.role !== undefined) {
    sets.push(`${wasteland_members.columns.role} = ?`);
    params.push(update.role);
  }
  if (update.trust_level !== undefined) {
    sets.push(`${wasteland_members.columns.trust_level} = ?`);
    params.push(update.trust_level);
  }

  if (sets.length === 0) {
    return current;
  }

  const allParams = [...params, memberId];

  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_members}
      SET ${sets.join(', ')}
      WHERE ${wasteland_members.columns.member_id} = ?
    `,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    allParams as any
  );

  const updatedRows: Record<string, unknown>[] = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_members} WHERE ${wasteland_members.columns.member_id} = ?`,
      [memberId]
    ),
  ];
  if (updatedRows.length === 0) return null;
  return WastelandMemberRecord.parse(updatedRows[0]);
}
