import { env, SELF } from 'cloudflare:test';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Worker's own HTTP boundary for a prepared session: `prepareSession`
 * validates its input before any handler runs, so the reserved agent id list is
 * observable here, next to an accepted profile agent id.
 */

const USER_ID = 'usr_prepare_agent_id';
const PEPPER = `pepper-${USER_ID}`;

const db = createDrizzleClient({
  connectionString: env.HYPERDRIVE.connectionString,
  poolConfig: { max: 1 },
});

let secret: string;
let internalApiSecret: string;

function token(): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: USER_ID,
      apiTokenPepper: PEPPER,
      version: 3,
      tokenSource: 'cloud-agent',
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function prepareRequest(body: unknown): Request {
  return new Request('https://worker.test/trpc/prepareSession', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'x-internal-api-key': internalApiSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function input(runtimeAgentSlug: string) {
  return {
    prompt: 'Review the change',
    githubRepo: 'acme/repo',
    mode: 'code',
    model: 'anthropic/claude-sonnet-4.5',
    runtimeAgents: [{ slug: runtimeAgentSlug, name: 'Profile agent', config: {} }],
  };
}

beforeAll(async () => {
  const configuredSecret = env.NEXTAUTH_SECRET;
  if (typeof configuredSecret !== 'string' || configuredSecret.length === 0) {
    throw new Error('test config did not bind a string NEXTAUTH_SECRET');
  }
  secret = configuredSecret;
  const boundInternalSecret = env.INTERNAL_API_SECRET;
  if (typeof boundInternalSecret !== 'string' || boundInternalSecret.length === 0) {
    throw new Error('test config did not bind a string INTERNAL_API_SECRET');
  }
  internalApiSecret = boundInternalSecret;

  await db.db
    .insert(kilocode_users)
    .values({
      id: USER_ID,
      google_user_email: `${USER_ID}@e2e.test`,
      google_user_name: 'Prepare agent id',
      google_user_image_url: 'https://example.test/avatar.png',
      stripe_customer_id: `cus_${USER_ID}`,
      api_token_pepper: PEPPER,
      is_admin: false,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.db
    .delete(kilocode_users)
    .where(inArray(kilocode_users.id, [USER_ID]))
    .catch(() => undefined);
});

describe('prepareSession runtime agent ids', () => {
  it('rejects every CLI-owned id at the Worker input boundary', async () => {
    for (const slug of ['general', 'explore', 'compaction', 'title', 'summary']) {
      const response = await SELF.fetch(prepareRequest(input(slug)));
      expect(response.status, slug).toBe(400);
      const body = (await response.json()) as { error?: { message?: string } };
      expect(body.error?.message, slug).toContain(
        'Slug conflicts with a built-in agent; choose a different slug'
      );
    }
  });

  it('lets a profile agent id through the same boundary', async () => {
    const response = await SELF.fetch(prepareRequest(input('reviewer-probe')));
    const text = await response.text();
    expect(text).not.toContain('Slug conflicts with a built-in agent');
  });
});
