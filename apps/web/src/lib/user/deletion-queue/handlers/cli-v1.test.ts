import { eq } from 'drizzle-orm';
import {
  cliSessions,
  sharedCliSessions,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionCloudSubjectResolution,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { deleteBlobs } from '@/lib/r2/cli-sessions';
import { handleCliV1Blobs } from '@/lib/user/deletion-queue/handlers/cli-v1';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/r2/cli-sessions', () => ({
  deleteBlobs: jest.fn(async () => undefined),
}));

const deleteBlobsMock = jest.mocked(deleteBlobs);

describe('handleCliV1Blobs', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    deleteBlobsMock.mockClear();
  });

  it('returns not_applicable when the user has no sessions or shared sessions', async () => {
    const user = await insertTestUser();
    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'not_applicable' });
    expect(deleteBlobsMock).not.toHaveBeenCalled();
  });

  it('deletes R2 blobs and database rows for user CLI sessions', async () => {
    const user = await insertTestUser();

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'User session 1',
        created_on_platform: 'vscode',
        api_conversation_history_blob_url: 'sessions/test1/api_conversation_history.json',
        task_metadata_blob_url: 'sessions/test1/task_metadata.json',
      })
      .returning();

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: { processed_count: 1 },
    });

    expect(deleteBlobsMock).toHaveBeenCalledWith(
      session.session_id,
      [
        { folderName: 'sessions', filename: 'api_conversation_history' },
        { folderName: 'sessions', filename: 'task_metadata' },
      ],
      { signal: expect.any(AbortSignal) }
    );

    const remainingSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it('deletes R2 blobs and database rows for user shared CLI sessions', async () => {
    const user = await insertTestUser();

    const [shared] = await db
      .insert(sharedCliSessions)
      .values({
        kilo_user_id: user.id,
        shared_state: 'public',
        ui_messages_blob_url: 'shared-sessions/test1/ui_messages.json',
        git_state_blob_url: 'shared-sessions/test1/git_state.json',
      })
      .returning();

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: { processed_count: 1 },
    });

    expect(deleteBlobsMock).toHaveBeenCalledWith(
      shared.share_id,
      [
        { folderName: 'shared-sessions', filename: 'ui_messages' },
        { folderName: 'shared-sessions', filename: 'git_state' },
      ],
      { signal: expect.any(AbortSignal) }
    );

    const remainingShared = await db
      .select()
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.kilo_user_id, user.id));
    expect(remainingShared).toHaveLength(0);
  });

  it('deletes cross-user shared sessions referencing the target user sessions', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser({
      google_user_email: 'other-user@example.com',
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'Target session',
        created_on_platform: 'vscode',
      })
      .returning();

    const [crossShared] = await db
      .insert(sharedCliSessions)
      .values({
        session_id: session.session_id,
        kilo_user_id: otherUser.id,
        shared_state: 'public',
        api_conversation_history_blob_url: 'shared-sessions/cross/api_conversation_history.json',
      })
      .returning();

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: { processed_count: 2 },
    });

    expect(deleteBlobsMock).toHaveBeenCalledWith(
      crossShared.share_id,
      [{ folderName: 'shared-sessions', filename: 'api_conversation_history' }],
      { signal: expect.any(AbortSignal) }
    );

    const remainingShared = await db
      .select()
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.share_id, crossShared.share_id));
    expect(remainingShared).toHaveLength(0);

    const remainingSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it('deletes database rows even when session has no blob URLs', async () => {
    const user = await insertTestUser();

    await db.insert(cliSessions).values({
      kilo_user_id: user.id,
      title: 'Session without blobs',
      created_on_platform: 'vscode',
    });

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: { processed_count: 1 },
    });
    expect(deleteBlobsMock).not.toHaveBeenCalled();

    const remainingSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it('tolerates missing R2 objects (NoSuchKey/NotFound) and proceeds with row deletion', async () => {
    const user = await insertTestUser();

    await db.insert(cliSessions).values({
      kilo_user_id: user.id,
      title: 'Session with 404 blobs',
      created_on_platform: 'vscode',
      api_conversation_history_blob_url: 'sessions/missing/api_conversation_history.json',
    });

    const notFoundError = new Error('NoSuchKey');
    notFoundError.name = 'NoSuchKey';
    deleteBlobsMock.mockRejectedValueOnce(notFoundError);

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: { processed_count: 1 },
    });

    const remainingSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it('retries when R2 blob deletion fails with a non-404 error without deleting the row', async () => {
    const user = await insertTestUser();

    await db.insert(cliSessions).values({
      kilo_user_id: user.id,
      title: 'Session failing R2',
      created_on_platform: 'vscode',
      api_conversation_history_blob_url: 'sessions/fail/api_conversation_history.json',
    });

    deleteBlobsMock.mockRejectedValueOnce(new Error('Internal S3 Error'));

    const outcome = await handleCliV1Blobs({
      request: { user_id: user.id } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({
      kind: 'retry',
      errorCode: 'blob_delete_failed',
      httpStatusClass: 'error',
    });

    const remainingSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, user.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it('handles authoritative absence without touching database', async () => {
    const outcome = await handleCliV1Blobs({
      request: {
        cloud_subject_resolution: UserDeletionCloudSubjectResolution.AuthoritativeAbsence,
      } as UserDeletionRequest,
      step: {
        step_key: UserDeletionStepKey.CliV1Blobs,
        status: UserDeletionStepStatus.Running,
        progress_json: {},
      } as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'not_applicable', errorCode: 'authoritative_absence' });
    expect(deleteBlobsMock).not.toHaveBeenCalled();
  });
});

function handlerContext(): DeletionHandlerContext {
  return {
    requestId: 'req-cli-v1',
    stepKey: UserDeletionStepKey.CliV1Blobs,
    claimToken: 'claim',
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
}
