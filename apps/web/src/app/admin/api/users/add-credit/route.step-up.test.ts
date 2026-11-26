const mockHeaders = jest.fn<Promise<Headers>, []>();
const mockGetServerSession = jest.fn();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  credit_transactions,
  passkey_credentials,
  session_step_up_proofs,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { hashStepUpBinding, hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

// The real admission, proof claim and handler: only the session cookie and the
// request headers are stand-ins.
const route = '/admin/api/users/add-credit';
const webSessionId = 'add-credit-web-session';
const pepper = 'add-credit-session-pepper';
const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;

afterEach(() => {
  process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
  mockHeaders.mockReset();
  mockGetServerSession.mockReset();
});

async function creditOperator() {
  const operator = await insertTestUser({
    google_user_email: `add-credit-operator-${crypto.randomUUID()}@kilocode.ai`,
    hosted_domain: 'kilocode.ai',
    is_admin: true,
    can_manage_credits: true,
    web_session_pepper: pepper,
  });
  const [credential] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: operator.id,
      credential_id: `add-credit-credential-${crypto.randomUUID()}`,
      public_key: 'unused-public-key',
    })
    .returning();
  mockHeaders.mockResolvedValue(new Headers({ 'x-pathname': route, 'x-http-method': 'POST' }));
  mockGetServerSession.mockResolvedValue({
    kiloUserId: operator.id,
    webSessionPepper: pepper,
    webSessionId,
  });
  return { operator, credentialId: credential!.id };
}

/** A proof minted for crediting `recipientId`, as the confirmation stores it. */
async function proofFor(operatorId: string, credentialId: string, recipientId: string) {
  const verifiedAt = new Date();
  const [proof] = await db
    .insert(session_step_up_proofs)
    .values({
      kilo_user_id: operatorId,
      session_id_hash: hashWebSessionId(webSessionId),
      method: 'webauthn_uv',
      passkey_credential_id: credentialId,
      purpose: 'operation',
      action_binding_hash: hashStepUpBinding('sensitive_write', {
        surface: 'rest',
        route,
        method: 'post',
        target: { kind: 'user', id: recipientId },
      }),
      verified_at: verifiedAt.toISOString(),
      expires_at: new Date(verifiedAt.getTime() + 5 * 60_000).toISOString(),
    })
    .returning();
  return proof!;
}

function grant(email: string) {
  return new NextRequest(`http://localhost:3000${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, credit_category: 'custom', amount_usd: 5 }),
  });
}

async function consumedAt(proofId: string) {
  const [row] = await db
    .select({ consumed_at: session_step_up_proofs.consumed_at })
    .from(session_step_up_proofs)
    .where(eq(session_step_up_proofs.id, proofId));
  return row!.consumed_at;
}

async function creditRows(userId: string) {
  return db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(eq(credit_transactions.kilo_user_id, userId));
}

describe('POST /admin/api/users/add-credit operation proof', () => {
  it('refuses a proof minted for another recipient without spending it or writing', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    const { operator, credentialId } = await creditOperator();
    const confirmed = await insertTestUser();
    const other = await insertTestUser();
    const proof = await proofFor(operator.id, credentialId, confirmed.id);

    const response = await POST(grant(other.google_user_email));

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: string;
      stepUp: { binding: Record<string, unknown> };
    };
    expect(body.error).toBe('MFA_REQUIRED');
    // The retry must confirm the account this request credits, by id only.
    expect(body.stepUp.binding).toMatchObject({ targetKind: 'user', targetId: other.id });
    expect(JSON.stringify(body.stepUp.binding)).not.toContain(other.google_user_email);
    expect(await consumedAt(proof.id)).toBeNull();
    expect(await creditRows(other.id)).toHaveLength(0);
    expect(await creditRows(confirmed.id)).toHaveLength(0);
  });

  it('credits the recipient the proof names and spends it', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    const { operator, credentialId } = await creditOperator();
    const recipient = await insertTestUser();
    const proof = await proofFor(operator.id, credentialId, recipient.id);

    const response = await POST(grant(recipient.google_user_email));

    expect(response.status).toBe(200);
    expect(await consumedAt(proof.id)).not.toBeNull();
    expect(await creditRows(recipient.id)).toHaveLength(1);
  });
});
