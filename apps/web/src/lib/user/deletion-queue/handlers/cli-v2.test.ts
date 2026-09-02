jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import {
  cli_sessions_v2,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionCloudSubjectResolution,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { USER_DELETION_RESOURCE_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handleCliV2Sessions } from '@/lib/user/deletion-queue/handlers/cli-v2';
import { insertTestUser } from '@/tests/helpers/user.helper';

const INGEST_BASE = 'https://test-ingest.example.com/api/session/';
const boundedTokenFlag = 'BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED';
const originalBoundedTokenFlag = process.env[boundedTokenFlag];

describe('handleCliV2Sessions', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBoundedTokenFlag === undefined) {
      delete process.env[boundedTokenFlag];
    } else {
      process.env[boundedTokenFlag] = originalBoundedTokenFlag;
    }
  });

  describe.each([
    { name: 'disabled', enabled: false },
    { name: 'enabled', enabled: true },
  ])('bounded deletion assertions when issuance is $name', ({ enabled }) => {
    beforeEach(() => {
      if (enabled) {
        process.env[boundedTokenFlag] = 'true';
      } else {
        delete process.env[boundedTokenFlag];
      }
    });

    it('signs a leaf DELETE and preserves confirmed 404 cleanup semantics', async () => {
      const user = await insertTestUser();
      const sessionId = newSessionId('cleanup404');
      await insertSession(user.id, sessionId);
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        await deleteSessionRow(user.id, sessionId);
        const authorization = new Headers(init?.headers).get('authorization');
        expect(authorization).toMatch(/^Bearer .+$/);
        if (!authorization) throw new Error('expected authorization header');
        const token = authorization.slice('Bearer '.length);
        const claims = jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
        if (typeof claims === 'string') throw new Error('expected JWT claims');

        expect(claims).toMatchObject({
          aud: 'session-ingest:user-deletion',
          kiloUserId: user.id,
        });
        expect(claims.exp! - claims.iat!).toBe(5 * 60);
        expect(claims.organizationId).toBeUndefined();
        expect(claims.apiTokenPepper).toBeUndefined();
        expect(claims.env).toBeUndefined();
        if (enabled) {
          expect(claims).toMatchObject({
            tokenPurpose: 'internal-service',
            credentialExchange: false,
          });
        } else {
          expect(claims.tokenPurpose).toBeUndefined();
          expect(claims.credentialExchange).toBeUndefined();
        }
        return new Response(JSON.stringify({ cleanup: 'done' }), { status: 404 });
      });

      await expect(
        handleCliV2Sessions({
          request: { user_id: user.id } as UserDeletionRequest,
          step: runningStep(),
          context: handlerContext(),
        })
      ).resolves.toEqual({ kind: 'succeeded', progress: { processed_count: 1 } });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${INGEST_BASE}${encodeURIComponent(sessionId)}`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(await remainingSessionIds(user.id)).toEqual([]);
    });
  });

  it('returns not_applicable when the user has no CLI v2 sessions', async () => {
    const user = await insertTestUser();
    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'not_applicable' });
  });

  it('deletes a parent after its children across batches in one claim', async () => {
    const user = await insertTestUser();
    const parentId = newSessionId('parent');
    const childA = newSessionId('childa');
    const childB = newSessionId('childb');
    await insertSession(user.id, parentId);
    await insertSession(user.id, childA, parentId);
    await insertSession(user.id, childB, parentId);

    const deleted = mockIngestDelete(user.id);

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded', progress: { processed_count: 3 } });
    expect(deleted.sort()).toEqual([childA, childB, parentId].sort());
    expect(await remainingSessionIds(user.id)).toEqual([]);
  });

  it('drains more than one leaf batch before succeeding', async () => {
    const user = await insertTestUser();
    const count = USER_DELETION_RESOURCE_BATCH_SIZE + 1;
    const sessionIds = Array.from({ length: count }, (_, index) => newSessionId(`b${index}`));
    for (const sessionId of sessionIds) {
      await insertSession(user.id, sessionId);
    }

    mockIngestDelete(user.id);

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded', progress: { processed_count: count } });
    expect(await remainingSessionIds(user.id)).toEqual([]);
  });

  it('deletes a leaf batch in parallel', async () => {
    const user = await insertTestUser();
    const sessionIds = [newSessionId('p0'), newSessionId('p1'), newSessionId('p2')];
    for (const sessionId of sessionIds) {
      await insertSession(user.id, sessionId);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const sessionId = sessionIdFromUrl(input);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight -= 1;
      await deleteSessionRow(user.id, sessionId);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded', progress: { processed_count: 3 } });
    expect(maxInFlight).toBe(3);
  });

  it('nulls public_id before the ingest DELETE is sent', async () => {
    const user = await insertTestUser();
    const sessionId = newSessionId('pub');
    await insertSession(user.id, sessionId, undefined, '00000000-0000-4000-8000-000000000001');

    let publicIdAtDelete: string | null | undefined = 'unset';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const sid = sessionIdFromUrl(input);
      publicIdAtDelete = await publicIdFor(user.id, sid);
      await deleteSessionRow(user.id, sid);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded', progress: { processed_count: 1 } });
    expect(publicIdAtDelete).toBeNull();
  });

  it('leaves public_id null when the ingest DELETE fails', async () => {
    const user = await insertTestUser();
    const sessionId = newSessionId('failpub');
    await insertSession(user.id, sessionId, undefined, '00000000-0000-4000-8000-000000000002');

    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 500 }));

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome.kind).toBe('retry');
    expect(await publicIdFor(user.id, sessionId)).toBeNull();
  });

  it('does not null public_id on a session owned by another user', async () => {
    const user = await insertTestUser();
    const other = await insertTestUser();
    const targetId = newSessionId('targetpub');
    const otherId = newSessionId('otherpub');
    await insertSession(user.id, targetId, undefined, '00000000-0000-4000-8000-000000000003');
    await insertSession(other.id, otherId, undefined, '00000000-0000-4000-8000-000000000004');

    mockIngestDelete(user.id);

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded', progress: { processed_count: 1 } });
    expect(await publicIdFor(other.id, otherId)).toBe('00000000-0000-4000-8000-000000000004');
  });

  it('continues after a 409 without dropping already-deleted siblings', async () => {
    const user = await insertTestUser();
    const keepId = newSessionId('keep');
    const dropId = newSessionId('drop');
    await insertSession(user.id, keepId);
    await insertSession(user.id, dropId);

    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const sessionId = sessionIdFromUrl(input);
      if (sessionId === keepId) {
        return new Response(JSON.stringify({ success: false, error: 'session_not_leaf' }), {
          status: 409,
        });
      }
      await deleteSessionRow(user.id, sessionId);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'continue', progress: { processed_count: 1 } });
    expect(await remainingSessionIds(user.id)).toEqual([keepId]);
  });

  it('stops starting another batch when the cron reserve is gone', async () => {
    const user = await insertTestUser();
    const count = USER_DELETION_RESOURCE_BATCH_SIZE + 1;
    for (let index = 0; index < count; index += 1) {
      await insertSession(user.id, newSessionId(`t${index}`));
    }

    let remainingMs = 60_000;
    mockIngestDelete(user.id, () => {
      remainingMs = 0;
    });

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(() => remainingMs),
    });

    expect(outcome).toEqual({
      kind: 'continue',
      progress: { processed_count: USER_DELETION_RESOURCE_BATCH_SIZE },
    });
    expect(await remainingSessionIds(user.id)).toHaveLength(1);
  });

  it('keeps processed progress when a later batch fails', async () => {
    const user = await insertTestUser();
    const count = USER_DELETION_RESOURCE_BATCH_SIZE + 1;
    for (let index = 0; index < count; index += 1) {
      await insertSession(user.id, newSessionId(`f${index}`));
    }

    let deleted = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const sessionId = sessionIdFromUrl(input);
      if (deleted >= USER_DELETION_RESOURCE_BATCH_SIZE) {
        return new Response('unavailable', { status: 500 });
      }
      deleted += 1;
      await deleteSessionRow(user.id, sessionId);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'retry',
      errorCode: 'http_500',
      httpStatusClass: '5xx',
      progress: { processed_count: USER_DELETION_RESOURCE_BATCH_SIZE },
    });
    expect(await remainingSessionIds(user.id)).toHaveLength(1);
  });

  it('treats a successful DELETE that leaves the row as an identity mismatch', async () => {
    const user = await insertTestUser();
    const sessionId = newSessionId('stuck');
    await insertSession(user.id, sessionId);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const outcome = await handleCliV2Sessions({
      request: { user_id: user.id } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome.kind).toBe('needs_attention');
    if (outcome.kind === 'needs_attention') {
      expect(outcome.errorCode).toBe('session_identity_mismatch');
    }
    expect(await remainingSessionIds(user.id)).toEqual([sessionId]);
  });

  it('handles authoritative absence without touching database', async () => {
    const outcome = await handleCliV2Sessions({
      request: {
        cloud_subject_resolution: UserDeletionCloudSubjectResolution.AuthoritativeAbsence,
      } as UserDeletionRequest,
      step: runningStep(),
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'not_applicable', errorCode: 'authoritative_absence' });
  });
});

function runningStep(): UserDeletionStep {
  return {
    step_key: UserDeletionStepKey.CliV2Sessions,
    status: UserDeletionStepStatus.Running,
    progress_json: {},
  } as UserDeletionStep;
}

function handlerContext(remainingMs: () => number = () => 60_000): DeletionHandlerContext {
  return {
    requestId: 'req-cli-v2',
    stepKey: UserDeletionStepKey.CliV2Sessions,
    claimToken: 'claim',
    deadlineAt: Date.now() + remainingMs(),
    remainingMs,
    signal: new AbortController().signal,
  };
}

function newSessionId(label: string): string {
  return `ses_${label}${crypto.randomUUID().replaceAll('-', '')}`.slice(0, 30);
}

async function insertSession(
  userId: string,
  sessionId: string,
  parentSessionId?: string,
  publicId?: string
) {
  await db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: userId,
    parent_session_id: parentSessionId,
    public_id: publicId,
    created_on_platform: 'cli',
  });
}

async function deleteSessionRow(userId: string, sessionId: string) {
  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, sessionId))
    );
}

async function remainingSessionIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.kilo_user_id, userId));
  return rows.map(row => row.session_id).sort();
}

async function publicIdFor(userId: string, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ public_id: cli_sessions_v2.public_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, sessionId))
    );
  return rows[0]?.public_id ?? null;
}

function sessionIdFromUrl(input: RequestInfo | URL): string {
  const url = String(input);
  if (!url.startsWith(INGEST_BASE)) {
    throw new Error(`unexpected fetch ${url}`);
  }
  return decodeURIComponent(url.slice(INGEST_BASE.length));
}

function mockIngestDelete(userId: string, onDelete?: () => void) {
  const deleted: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const sessionId = sessionIdFromUrl(input);
    await deleteSessionRow(userId, sessionId);
    deleted.push(sessionId);
    onDelete?.();
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  return deleted;
}
