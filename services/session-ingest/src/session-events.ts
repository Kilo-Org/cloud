import type { Env } from './env';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import {
  SessionStatusSchema,
  type SessionEventPayload,
  type SessionEventV2Row,
} from './types/user-connection-protocol';

export type SessionEventDbRow = {
  session_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  title: string | null;
  created_on_platform: string | null;
  organization_id: string | null;
  git_url: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  status: string | null;
  status_updated_at: string | Date | null;
};

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIsoString(value: string | Date | null): string | null {
  return value === null ? null : toIsoString(value);
}

export function mapSessionEventRow(row: SessionEventDbRow): SessionEventV2Row {
  return {
    source: 'v2',
    sessionId: row.session_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    title: row.title,
    createdOnPlatform: row.created_on_platform,
    organizationId: row.organization_id,
    gitUrl: row.git_url,
    gitBranch: row.git_branch,
    parentSessionId: row.parent_session_id,
    status: SessionStatusSchema.nullable().parse(row.status),
    statusUpdatedAt: toNullableIsoString(row.status_updated_at),
  };
}

export function notifyUserSessionEvent(
  env: Env,
  kiloUserId: string,
  event: SessionEventPayload,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): void {
  const notify = async () => {
    try {
      const stub = getUserConnectionDO(env, { kiloUserId });
      await stub.notifySessionEvent(event);
    } catch (error) {
      console.error('Failed to notify session event (non-fatal)', {
        event: event.type,
        sessionId: 'session' in event.data ? event.data.session.sessionId : event.data.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const promise = notify();
  if (ctx) {
    ctx.waitUntil(promise);
  }
}
