import { query } from '../../util/query.util';
import { wasteland_members, WastelandMemberRecord } from '../../db/tables/wasteland-members.table';

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
    /* sql */ `DELETE FROM ${wasteland_members} WHERE ${wasteland_members.member_id} = ?`,
    [memberId]
  );
}

export function getMember(sql: SqlStorage, userId: string): WastelandMemberRecord | null {
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

export function updateMember(
  sql: SqlStorage,
  memberId: string,
  update: { role?: string; trust_level?: number }
): WastelandMemberRecord | null {
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_members}
      SET ${wasteland_members.columns.role} = COALESCE(?, ${wasteland_members.columns.role}),
          ${wasteland_members.columns.trust_level} = COALESCE(?, ${wasteland_members.columns.trust_level})
      WHERE ${wasteland_members.member_id} = ?
    `,
    [update.role ?? null, update.trust_level ?? null, memberId]
  );

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_members}
        WHERE ${wasteland_members.member_id} = ?
      `,
      [memberId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandMemberRecord.parse(rows[0]);
}
