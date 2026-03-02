import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { POST } from './route';
import { db } from '@/lib/drizzle';
import { kilocode_users, cliSessions } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { failureResult } from '@/lib/maybe-result';
import { getUserFromAuth } from '@/lib/user.server';
import { generateSignedUploadUrl } from '@/lib/r2/cli-sessions';
import { eq } from 'drizzle-orm';

jest.mock('@/lib/user.server');
jest.mock('@/lib/r2/cli-sessions');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGenerateSignedUploadUrl = jest.mocked(generateSignedUploadUrl);

function makeRequest(body: { session_id?: string; blob_type?: string; content_length?: number }) {
  const url = new URL('http://localhost:3000/api/upload-cli-session-blob-v2');
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/upload-cli-session-blob-v2', () => {
  beforeEach(() => {
    mockedGetUserFromAuth.mockReset();
    mockedGenerateSignedUploadUrl.mockReset();
  });

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(cliSessions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('returns 401 when user is not authenticated', async () => {
    const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });

    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
        content_length: 1024,
      })
    );

    expect(response).toBe(authFailedResponse);
  });

  test('returns 400 when body is not valid JSON', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const url = new URL('http://localhost:3000/api/upload-cli-session-blob-v2');
    const request = new NextRequest(url, {
      method: 'POST',
      body: 'not valid json',
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  test('returns 400 when session_id is missing', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(makeRequest({ blob_type: 'task_metadata', content_length: 1024 }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when blob_type is missing', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        content_length: 1024,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when content_length is missing', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when content_length is not a positive integer', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
        content_length: -1,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when content_length is zero', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
        content_length: 0,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when content_length exceeds 5MB', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
        content_length: 5 * 1024 * 1024 + 1,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 200 when content_length is exactly 5MB', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'Test Session',
        created_on_platform: 'test',
      })
      .returning({ session_id: cliSessions.session_id });

    const mockSignedUrl = 'https://r2.example.com/signed-upload-url';
    const mockKey = `sessions/${session.session_id}/task_metadata.json`;
    mockedGenerateSignedUploadUrl.mockResolvedValue({
      signedUrl: mockSignedUrl,
      key: mockKey,
    });

    const response = await POST(
      makeRequest({
        session_id: session.session_id,
        blob_type: 'task_metadata',
        content_length: 5 * 1024 * 1024,
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signed_url).toBe(mockSignedUrl);
  });

  test('returns 400 when blob_type is invalid', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'invalid_type',
        content_length: 1024,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 400 when session_id is not a valid UUID', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: 'not-a-uuid',
        blob_type: 'task_metadata',
        content_length: 1024,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request body');
  });

  test('returns 404 when session does not exist', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const response = await POST(
      makeRequest({
        session_id: '00000000-0000-0000-0000-000000000000',
        blob_type: 'task_metadata',
        content_length: 1024,
      })
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Session not found');
  });

  test('returns 404 when session belongs to a different user', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();

    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: otherUser.id,
        title: 'Test Session',
        created_on_platform: 'test',
      })
      .returning({ session_id: cliSessions.session_id });

    const response = await POST(
      makeRequest({
        session_id: session.session_id,
        blob_type: 'task_metadata',
        content_length: 1024,
      })
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Session not found');
  });

  test('returns 200 with signed_url when successful', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'Test Session',
        created_on_platform: 'test',
      })
      .returning({ session_id: cliSessions.session_id });

    const mockSignedUrl = 'https://r2.example.com/signed-upload-url';
    const mockKey = `sessions/${session.session_id}/task_metadata.json`;
    mockedGenerateSignedUploadUrl.mockResolvedValue({
      signedUrl: mockSignedUrl,
      key: mockKey,
    });

    const response = await POST(
      makeRequest({
        session_id: session.session_id,
        blob_type: 'task_metadata',
        content_length: 2048,
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signed_url).toBe(mockSignedUrl);
    expect(body.session_id).toBe(session.session_id);
    expect(body.updated_at).toBeDefined();

    const [updatedSession] = await db
      .select({ task_metadata_blob_url: cliSessions.task_metadata_blob_url })
      .from(cliSessions)
      .where(eq(cliSessions.session_id, session.session_id));
    expect(updatedSession.task_metadata_blob_url).toBe(mockKey);

    expect(mockedGenerateSignedUploadUrl).toHaveBeenCalledWith(
      session.session_id,
      user.id,
      'sessions',
      'task_metadata',
      2048
    );
  });

  test('passes content_length to generateSignedUploadUrl', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'Test Session',
        created_on_platform: 'test',
      })
      .returning({ session_id: cliSessions.session_id });

    const mockSignedUrl = 'https://r2.example.com/signed-upload-url';
    const mockKey = `sessions/${session.session_id}/api_conversation_history.json`;
    mockedGenerateSignedUploadUrl.mockResolvedValue({
      signedUrl: mockSignedUrl,
      key: mockKey,
    });

    await POST(
      makeRequest({
        session_id: session.session_id,
        blob_type: 'api_conversation_history',
        content_length: 5000,
      })
    );

    expect(mockedGenerateSignedUploadUrl).toHaveBeenCalledWith(
      session.session_id,
      user.id,
      'sessions',
      'api_conversation_history',
      5000
    );
  });

  test('works with all valid blob types', async () => {
    const user = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
    });

    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: user.id,
        title: 'Test Session',
        created_on_platform: 'test',
      })
      .returning({ session_id: cliSessions.session_id });

    const mockSignedUrl = 'https://r2.example.com/signed-upload-url';

    const validBlobTypes = [
      'api_conversation_history',
      'task_metadata',
      'ui_messages',
      'git_state',
    ];

    for (const blobType of validBlobTypes) {
      const mockKey = `sessions/${session.session_id}/${blobType}.json`;
      mockedGenerateSignedUploadUrl.mockResolvedValue({
        signedUrl: mockSignedUrl,
        key: mockKey,
      });

      const response = await POST(
        makeRequest({
          session_id: session.session_id,
          blob_type: blobType,
          content_length: 1024,
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.signed_url).toBe(mockSignedUrl);
      expect(body.session_id).toBe(session.session_id);
      expect(body.updated_at).toBeDefined();
    }
  });
});
