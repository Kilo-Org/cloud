/**
 * Member list management.
 * Tracks wasteland members with roles and trust levels.
 */

import { query } from '../../util/query.util';
import {
  wasteland_members,
  WastelandMemberRecord,
  createTableWastelandMembers,
  getIndexesWastelandMembers,
} from '../../db/tables/wasteland-members.table';

export type WastelandMember = WastelandMemberRecord;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initMemberTables(sql: SqlStorage): void {
  query(sql, createTableWastelandMembers(), []);
  for (const idx of getIndexesWastelandMembers()) {
    query(sql, idx, []);
  }
}

export function addMember(
  sql: SqlStorage,
  userId: string,
  role: string,
  trustLevel: number
): string {
  const memberId = generateId();
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${wasteland_members} (
        ${wasteland_members.columns.member_id},
        ${wasteland_members.columns.user_id},
        ${wasteland_members.columns.trust_level},
        ${wasteland_members.columns.role},
        ${wasteland_members.columns.joined_at}
      ) VALUES (?, ?, ?, ?, ?)
    `,
    [memberId, userId, trustLevel, role, timestamp]
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

export function getMember(sql: SqlStorage, memberId: string): WastelandMember | null {
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

export function getMemberByUserId(sql: SqlStorage, userId: string): WastelandMember | null {
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

export function listMembers(sql: SqlStorage): WastelandMember[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_members} ORDER BY ${wasteland_members.joined_at} ASC`,
      []
    ),
  ];
  return WastelandMemberRecord.array().parse(rows);
}
