import { microdollar_usage, organization_memberships, organizations } from '@kilocode/db/schema';
import { createUsageId } from '@kilocode/worker-utils/usage-id';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { resolveSeedUserId } from '../lib/users';

export const usage = '<owner-email>';

/** Stable organization id, so a second run replaces its own rows instead of adding more. */
const ORGANIZATION_ID = 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e0a';
const ORGANIZATION_NAME = 'Request log lab org';

/**
 * One window of gateway requests, minutes old so they fall inside the hour the
 * request-log screen shows first.
 *
 * The first row names the gateway itself as the inference provider, which is
 * what a request whose upstream answer carries no provider records, and the
 * other two carry the upstream names the same column holds. The provider
 * column is what the screen's copy proves, so the rows keep their own spelling.
 */
const REQUESTS = [
  {
    minutesAgo: 42,
    provider: 'openrouter',
    inferenceProvider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    cost: 89_012,
    inputTokens: 12_480,
    outputTokens: 2_140,
  },
  {
    minutesAgo: 18,
    provider: 'openrouter',
    inferenceProvider: 'deepinfra',
    model: 'deepseek/deepseek-v3.2',
    cost: 240_000,
    inputTokens: 3_100,
    outputTokens: 940,
  },
  {
    minutesAgo: 4,
    provider: 'vercel',
    inferenceProvider: 'anthropic',
    model: 'anthropic/claude-sonnet-4-5',
    cost: 1_500_000,
    inputTokens: 22_400,
    outputTokens: 4_460,
  },
] as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:org-request-logs ${usage}`);
  console.log('');
  console.log('Seeds an organization the account owns, with one window of gateway');
  console.log('requests whose provider column names the gateway and two upstreams.');
  console.log('Requires a localhost database. Open the organization request-log screen in');
  console.log('the signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...rest] = args;
  if (!email || rest.length > 0) {
    printUsage();
    throw new Error('Expected exactly one argument: the account email');
  }

  assertLocalSeedDatabase('app:org-request-logs');
  const db = getSeedDb();
  const ownerUserId = await resolveSeedUserId(email);
  const now = Date.now();

  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: ORGANIZATION_NAME,
      created_by_kilo_user_id: ownerUserId,
      settings: {},
    })
    .onConflictDoUpdate({ target: organizations.id, set: { name: ORGANIZATION_NAME } });

  await db
    .insert(organization_memberships)
    .values({ organization_id: ORGANIZATION_ID, kilo_user_id: ownerUserId, role: 'owner' })
    .onConflictDoUpdate({
      target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
      set: { role: 'owner' },
    });

  await db.delete(microdollar_usage).where(eq(microdollar_usage.organization_id, ORGANIZATION_ID));

  await db.insert(microdollar_usage).values(
    REQUESTS.map(request => ({
      id: createUsageId(),
      kilo_user_id: ownerUserId,
      organization_id: ORGANIZATION_ID,
      created_at: new Date(now - request.minutesAgo * 60 * 1000).toISOString(),
      provider: request.provider,
      model: request.model,
      requested_model: request.model,
      inference_provider: request.inferenceProvider,
      cost: request.cost,
      input_tokens: request.inputTokens,
      output_tokens: request.outputTokens,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      cache_discount: null,
      abuse_classification: 0,
      has_error: false,
      project_id: null,
    }))
  );

  console.log('This fixture represents: a billing owner reading the last hour of requests,');
  console.log('including one that went through the gateway with no upstream name.');
  console.log(`Next: open the organization request-log screen as ${email}.`);

  return {
    organizationId: ORGANIZATION_ID,
    ownerUserId,
    ownerEmail: email,
    requestCount: REQUESTS.length,
  };
}
