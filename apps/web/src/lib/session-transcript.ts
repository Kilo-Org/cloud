import 'server-only';

import {
  fetchNativeSnapshot,
  projectNativeSnapshot,
} from '@kilocode/cloud-agent-sdk/native-sync-snapshot';
import { CLI_SESSION_VERSION_BY_RUNTIME_HARNESS } from '@kilocode/session-ingest-contracts';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import {
  SESSION_TRANSCRIPT_TOKEN_AUDIENCE,
  SESSION_TRANSCRIPT_TOKEN_ISSUER,
  SESSION_TRANSCRIPT_TOKEN_SCHEME,
  SESSION_TRANSCRIPT_TOKEN_TTL_SECONDS,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { fetchSessionSnapshot } from '@/lib/session-ingest-client';
import { SESSION_SYNC_WORKER_URL } from '@/lib/web-config.server';

type TranscriptSession = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  version: number;
};

const syncErrorSchema = z.object({ error: z.object({ code: z.string() }) });

async function fetchSyncedTranscript({ sessionId, userId, organizationId }: TranscriptSession) {
  const signingKey = new TextEncoder().encode(NEXTAUTH_SECRET);
  const env = process.env.VERCEL_TARGET_ENV === 'staging' ? 'staging' : process.env.NODE_ENV;

  async function request(path: string, init?: RequestInit) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sessionID: sessionId,
      organizationID: organizationId ?? undefined,
      env,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(SESSION_TRANSCRIPT_TOKEN_ISSUER)
      .setAudience(SESSION_TRANSCRIPT_TOKEN_AUDIENCE)
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + SESSION_TRANSCRIPT_TOKEN_TTL_SECONDS)
      .sign(signingKey);
    const response = await fetch(new URL(path, SESSION_SYNC_WORKER_URL), {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: `${SESSION_TRANSCRIPT_TOKEN_SCHEME} ${token}` },
    });
    if (!response.ok) {
      const parsed = syncErrorSchema.safeParse(await response.json().catch(() => null));
      throw Object.assign(new Error(`Session sync transcript read failed (${response.status})`), {
        code: parsed.success ? parsed.data.error.code : undefined,
      });
    }
    return response;
  }

  return fetchNativeSnapshot(
    async <T>(path: string, init?: RequestInit): Promise<T> => (await request(path, init)).json(),
    sessionId,
    undefined,
    async (path, size, init) => {
      const { body } = await request(path, init);
      if (!body) throw new Error('Session sync attachment is missing a response body');
      const result = await readBoundedStream(body, size);
      if (!result.ok) throw new Error('Session sync attachment exceeds its advertised size');
      return result.bytes.slice().buffer;
    }
  );
}

export async function fetchSessionTranscript(session: TranscriptSession) {
  if (session.version === CLI_SESSION_VERSION_BY_RUNTIME_HARNESS.kilo2 && SESSION_SYNC_WORKER_URL) {
    try {
      const snapshot = await fetchSyncedTranscript(session);
      if (!snapshot.session) return null;
      const { messages, incompleteMessageIDs } = projectNativeSnapshot(snapshot);
      return {
        source: 'sync' as const,
        messages,
        incompleteMessageCount: incompleteMessageIDs.length,
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'session_deleted') return null;
      if (code !== 'session_not_found') throw error;
    }
  }

  const snapshot = await fetchSessionSnapshot(session.sessionId, session.userId);
  return snapshot ? { source: 'ingest' as const, messages: snapshot.messages } : null;
}
