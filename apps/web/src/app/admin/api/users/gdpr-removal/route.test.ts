import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';
import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user/server';
import { findUserById } from '@/lib/user';
import { getUserDeletionRequestById, getUserDeletionRequestForUser } from '@/lib/user/deletion';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { DeletionRefusalCode } from '@/lib/user/deletion-queue/deletion-intake';
import { captureException } from '@sentry/nextjs';
import { GET, POST } from './route';

jest.mock('@/lib/user/server');
jest.mock('@/lib/user');
jest.mock('@/lib/user/deletion', () => ({
  getUserDeletionRequestById: jest.fn(),
  getUserDeletionRequestForUser: jest.fn(),
}));
jest.mock('@/lib/user/deletion-queue/deletion-enqueue', () => ({
  enqueueUserDeletionTargets: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedFindUserById = jest.mocked(findUserById);
const mockedGetUserDeletionRequestById = jest.mocked(getUserDeletionRequestById);
const mockedGetUserDeletionRequestForUser = jest.mocked(getUserDeletionRequestForUser);
const mockedEnqueueUserDeletionTargets = jest.mocked(enqueueUserDeletionTargets);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = 'user-id';
const ADMIN_ID = 'admin-id';
const REQUEST_ID = 'req-1';
const USER_EMAIL = 'user@example.com';

const deletionRequest = {
  id: REQUEST_ID,
  user_id: USER_ID,
  status: 'in_progress',
  catalog_version: 1,
  requested_by_kilo_user_id: ADMIN_ID,
  target_email: USER_EMAIL,
  target_email_hmac: 'hmac',
  pylon_ticket_ref: null,
  cloud_subject_resolution: 'current_user',
  cloud_subject_proof_ref: null,
  preflight_attention_code: null,
  created_at: '2026-08-11T00:00:00.000Z',
  last_progress_at: '2026-08-11T00:00:00.000Z',
  anonymized_at: null,
  completed_at: null,
  cancelled_at: null,
} as UserDeletionRequest;

const deletionSteps = [
  {
    id: 'step-1',
    request_id: REQUEST_ID,
    step_key: 'kiloclaw_destroy',
    status: 'pending',
    available_at: '2026-08-11T00:00:00.000Z',
    claim_token: null,
    claimed_until: null,
    window_attempt_count: 0,
    lifetime_attempt_count: 0,
    progress_json: {},
    last_error_code: null,
    rate_limited_since: null,
    manual_evidence_json: null,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
  },
] as UserDeletionStep[];

function postRequest(body: unknown = { userId: USER_ID }) {
  return new NextRequest('http://localhost:3000/admin/api/users/gdpr-removal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(params: { userId?: string; requestId?: string } = {}) {
  const url = new URL('http://localhost:3000/admin/api/users/gdpr-removal');
  if (params.userId !== undefined) url.searchParams.set('userId', params.userId);
  if (params.requestId !== undefined) url.searchParams.set('requestId', params.requestId);
  return new NextRequest(url, { method: 'GET' });
}

describe('/admin/api/users/gdpr-removal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: ADMIN_ID, google_user_email: 'admin@example.com' },
      authFailedResponse: null,
    } as never);
    mockedFindUserById.mockResolvedValue({
      id: USER_ID,
      google_user_email: USER_EMAIL,
    } as never);
    mockedEnqueueUserDeletionTargets.mockResolvedValue([
      { status: 'enqueued', requestId: REQUEST_ID },
    ]);
    mockedGetUserDeletionRequestForUser.mockResolvedValue({
      request: deletionRequest,
      steps: deletionSteps,
    });
    mockedGetUserDeletionRequestById.mockResolvedValue({
      request: deletionRequest,
      steps: deletionSteps,
    });
  });

  describe('GET', () => {
    test('returns 400 when userId and requestId are missing', async () => {
      const response = await GET(getRequest());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'User ID is required' });
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test('returns 404 when the user does not exist', async () => {
      mockedFindUserById.mockResolvedValue(undefined);

      const response = await GET(getRequest({ userId: USER_ID }));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'User not found' });
      expect(mockedGetUserDeletionRequestForUser).not.toHaveBeenCalled();
    });

    test('returns 200 with the active request for a userId', async () => {
      const response = await GET(getRequest({ userId: USER_ID }));

      expect(response.status).toBe(200);
      expect(mockedGetUserDeletionRequestForUser).toHaveBeenCalledWith(USER_ID);
      await expect(response.json()).resolves.toEqual({
        request: deletionRequest,
        steps: deletionSteps,
      });
    });

    test('returns 200 with null request when no active deletion exists', async () => {
      mockedGetUserDeletionRequestForUser.mockResolvedValue(null);

      const response = await GET(getRequest({ userId: USER_ID }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ request: null, steps: [] });
    });

    test('loads by requestId without looking up the user', async () => {
      const response = await GET(getRequest({ requestId: REQUEST_ID }));

      expect(response.status).toBe(200);
      expect(mockedFindUserById).not.toHaveBeenCalled();
      expect(mockedGetUserDeletionRequestById).toHaveBeenCalledWith(REQUEST_ID);
      await expect(response.json()).resolves.toEqual({
        request: deletionRequest,
        steps: deletionSteps,
      });
    });

    test('returns the authentication failure without looking up the target user', async () => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      } as never);

      const response = await GET(getRequest({ userId: USER_ID }));

      expect(response.status).toBe(401);
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });
  });

  describe('POST', () => {
    test('returns 202 with requestId and does not process steps', async () => {
      const response = await POST(postRequest());

      expect(response.status).toBe(202);
      expect(mockedEnqueueUserDeletionTargets).toHaveBeenCalledWith({
        actor: { kiloUserId: ADMIN_ID, email: 'admin@example.com' },
        targets: [{ email: USER_EMAIL, trustedUserId: USER_ID }],
        catalogVersion: 2,
      });
      await expect(response.json()).resolves.toEqual({
        requestId: REQUEST_ID,
        status: 'enqueued',
      });
    });

    test('returns 202 when a request is already active', async () => {
      mockedEnqueueUserDeletionTargets.mockResolvedValue([
        { status: 'already_active', requestId: REQUEST_ID },
      ]);

      const response = await POST(postRequest());

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        requestId: REQUEST_ID,
        status: 'already_active',
      });
    });

    test('returns 400 when enqueue refuses a protected account', async () => {
      mockedEnqueueUserDeletionTargets.mockResolvedValue([
        { status: 'refused', code: DeletionRefusalCode.ProtectedAdmin },
      ]);

      const response = await POST(postRequest());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'This account is protected and cannot be deleted from this form',
      });
    });

    test('returns 404 when the user does not exist', async () => {
      mockedFindUserById.mockResolvedValue(undefined);

      const response = await POST(postRequest());

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'User not found' });
      expect(mockedEnqueueUserDeletionTargets).not.toHaveBeenCalled();
    });

    test('returns 500 and reports unexpected errors to Sentry', async () => {
      const failure = new Error('worker unavailable');
      mockedEnqueueUserDeletionTargets.mockRejectedValue(failure);

      const response = await POST(postRequest());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: 'User deletion failed — check Sentry for details',
      });
      expect(mockedCaptureException).toHaveBeenCalledWith(failure, {
        tags: { source: 'gdpr-removal' },
        extra: { userId: USER_ID },
      });
    });

    test('returns the authentication failure without looking up the target user', async () => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      } as never);

      const response = await POST(postRequest());

      expect(response.status).toBe(401);
      expect(mockedFindUserById).not.toHaveBeenCalled();
      expect(mockedEnqueueUserDeletionTargets).not.toHaveBeenCalled();
    });

    test('does not import Phase 1 processor helpers', async () => {
      const source = readFileSync(join(__dirname, 'route.ts'), 'utf8');

      expect(source).not.toContain('beginUserDeletion');
      expect(source).not.toContain('processUserDeletionSteps');
      expect(source).not.toContain('deletion-processor');
      expect(source).not.toContain('softDeleteUser');
      expect(source).not.toContain('softDeleteUserExternalServices');

      await POST(postRequest());

      expect(mockedEnqueueUserDeletionTargets).toHaveBeenCalled();
    });
  });
});
