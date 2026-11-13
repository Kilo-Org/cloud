import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

import type { UsageFixtureRow } from '../../mock-snowflake/warehouse';
import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';

export const usage = '<fake-email> [--days <count>]';

const MEMBER_NAME = 'Usage lab member';
const OWNER_ORGANIZATION_NAME = 'Usage lab org';
const MEMBER_ORGANIZATION_NAME = 'Usage lab member org';

const MODELS = ['anthropic/claude-sonnet-4', 'openai/gpt-5', 'google/gemini-3-pro'];
const FEATURES = ['code-review', 'agent-chat', 'cli'];
const PROVIDER = 'openrouter';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../mock-snowflake/fixtures');

/** A stable UUID per seed string, so a second run reuses the same fixture rows. */
function fixtureUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed usage:usage-rows ${usage}`);
  console.log('');
  console.log('Fills the usage screens for one fake account, against the dev warehouse stub.');
  console.log('Run pnpm dev:mock-snowflake and point apps/web at it first; this topic writes');
  console.log('the fixture rows that stub answers from, never a real warehouse.');
  console.log('');
  console.log('It also creates the two organizations the organization screens need:');
  console.log(`  - ${OWNER_ORGANIZATION_NAME}: the caller owns it and it is a sales demo, so`);
  console.log('    the members screen pairs each spend with its daily limit, as web does.');
  console.log(`  - ${MEMBER_ORGANIZATION_NAME}: the caller is a plain member, so the usage`);
  console.log('    screen reads their own usage and the members screen shows limits only.');
  console.log('Writes only local rows and local fixture files; never calls a provider.');
  console.log('');
  console.log('Options:');
  console.log('  --days <count>   Days of history to write. Default 90.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed usage:usage-rows ada@example.com');
  console.log('  pnpm dev:seed usage:usage-rows ada@example.com --days 30');
}

type Options = { email: string; days: number };

function parseArgs(args: string[]): Options {
  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  let days = 90;
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--days') {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 400) {
        throw new Error('--days requires a whole number of days between 1 and 400');
      }
      days = value;
      index += 2;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { email, days };
}

/**
 * One request per day per scope. A day index picks the model, the feature and
 * the cost, so the breakdowns have three rows each and the 7/30/90-day windows
 * differ by the days they include rather than by their shape.
 */
function usageRowsFor(input: {
  userId: string;
  organizationId: string;
  days: number;
  costScale: number;
}): UsageFixtureRow[] {
  const now = Date.now();
  const rows: UsageFixtureRow[] = [];
  for (let dayIndex = 0; dayIndex < input.days; dayIndex += 1) {
    const date = new Date(now - dayIndex * 24 * 60 * 60 * 1000);
    const inputTokens = 1200 + (dayIndex % 11) * 140;
    const outputTokens = 400 + (dayIndex % 7) * 60;
    // A little under a cent to a few cents per request: a 90-day window lands
    // in single-dollar territory, which is the scale a reader can eyeball.
    const cost = Math.round((8_000 + (dayIndex % 13) * 1_500) * input.costScale);
    rows.push({
      usage_date: date.toISOString().slice(0, 10),
      kilo_user_id: input.userId,
      organization_id: input.organizationId,
      model: MODELS[dayIndex % MODELS.length],
      feature: FEATURES[dayIndex % FEATURES.length],
      provider: PROVIDER,
      mode: '',
      project_id: '',
      request_count: 1,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      total_cache_write_tokens: dayIndex % 4 === 0 ? 300 : 0,
      total_cache_hit_tokens: dayIndex % 5 === 0 ? 900 : 0,
      error_count: dayIndex % 17 === 0 ? 1 : 0,
      cancelled_count: 0,
      free_request_count: 0,
      user_byok_request_count: 0,
      total_latency_ms: 700 + (dayIndex % 9) * 40,
      total_generation_time_ms: 520 + (dayIndex % 6) * 35,
      latency_count: 1,
      total_tokens: inputTokens + outputTokens,
      total_cost_microdollars: cost,
      total_market_cost_microdollars: Math.round(cost * 1.15),
    });
  }
  return rows;
}

/** The rows file the mock warehouse reads for one fixture account. */
function writeFixtureFile(email: string, rows: UsageFixtureRow[]): string {
  mkdirSync(fixturesDir, { recursive: true });
  const slug = createHash('sha256').update(email).digest('hex').slice(0, 16);
  const path = join(fixturesDir, `usage-${slug}.json`);
  writeFileSync(path, `${JSON.stringify({ owner: email, rows }, null, 2)}\n`);
  return path;
}

async function upsertOrganization(input: {
  id: string;
  name: string;
  createdBy: string;
  salesDemo: boolean;
}): Promise<void> {
  const db = getSeedDb();
  await db
    .insert(organizations)
    .values({
      id: input.id,
      name: input.name,
      created_by_kilo_user_id: input.createdBy,
      settings: input.salesDemo ? { is_sales_demo: true } : {},
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: { name: input.name, settings: input.salesDemo ? { is_sales_demo: true } : {} },
    });
}

async function upsertMembership(
  organizationId: string,
  userId: string,
  role: 'owner' | 'member'
): Promise<void> {
  const db = getSeedDb();
  await db
    .insert(organization_memberships)
    .values({ organization_id: organizationId, kilo_user_id: userId, role })
    .onConflictDoUpdate({
      target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
      set: { role },
    });
}

/** A daily limit and today's spend, which the members screen reads per row. */
async function upsertDailyLimit(
  organizationId: string,
  userId: string,
  limitMicrodollars: number,
  usageMicrodollars: number
): Promise<void> {
  const db = getSeedDb();
  await db
    .insert(organization_user_limits)
    .values({
      organization_id: organizationId,
      kilo_user_id: userId,
      limit_type: 'daily',
      microdollar_limit: limitMicrodollars,
    })
    .onConflictDoUpdate({
      target: [
        organization_user_limits.organization_id,
        organization_user_limits.kilo_user_id,
        organization_user_limits.limit_type,
      ],
      set: { microdollar_limit: limitMicrodollars },
    });
  await db
    .insert(organization_user_usage)
    .values({
      organization_id: organizationId,
      kilo_user_id: userId,
      usage_date: sql`CURRENT_DATE`,
      limit_type: 'daily',
      microdollar_usage: usageMicrodollars,
    })
    .onConflictDoUpdate({
      target: [
        organization_user_usage.organization_id,
        organization_user_usage.kilo_user_id,
        organization_user_usage.limit_type,
        organization_user_usage.usage_date,
      ],
      set: { microdollar_usage: usageMicrodollars },
    });
}

async function ensureMemberUser(callerUserId: string, email: string): Promise<string> {
  const db = getSeedDb();
  const memberId = `dev-seed:usage-lab-member:${callerUserId}`;
  const memberEmail = `usage-lab-member-${fixtureUuid(`${email}:member`).slice(0, 8)}@example.com`;
  await db
    .insert(kilocode_users)
    .values({
      id: memberId,
      google_user_email: memberEmail,
      normalized_email: memberEmail,
      google_user_name: MEMBER_NAME,
      google_user_image_url: '',
      stripe_customer_id: `cus_local_usage_member_${randomUUID()}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  return memberId;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email, days } = parseArgs(args);
  assertLocalSeedDatabase('usage:usage-rows');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }

  const db = getSeedDb();
  const userId = await resolveSeedUserId(email);
  const memberUserId = await ensureMemberUser(userId, email);

  const ownerOrganizationId = fixtureUuid(`${email}:usage-owner`);
  const memberOrganizationId = fixtureUuid(`${email}:usage-member`);

  await upsertOrganization({
    id: ownerOrganizationId,
    name: OWNER_ORGANIZATION_NAME,
    createdBy: userId,
    salesDemo: true,
  });
  await upsertOrganization({
    id: memberOrganizationId,
    name: MEMBER_ORGANIZATION_NAME,
    createdBy: userId,
    salesDemo: false,
  });
  await upsertMembership(ownerOrganizationId, userId, 'owner');
  await upsertMembership(ownerOrganizationId, memberUserId, 'member');
  await upsertMembership(memberOrganizationId, userId, 'member');

  // The owner organization is the sales-demo case web pairs spend with the
  // limit in; the member organization is the plain case that shows the limit
  // alone, because the server strips the other members' spend from a member.
  await upsertDailyLimit(ownerOrganizationId, userId, 10_000_000, 2_400_000);
  await upsertDailyLimit(ownerOrganizationId, memberUserId, 10_000_000, 8_600_000);
  await upsertDailyLimit(memberOrganizationId, userId, 5_000_000, 1_200_000);

  const rows = [
    ...usageRowsFor({ userId, organizationId: '', days, costScale: 1 }),
    ...usageRowsFor({ userId, organizationId: ownerOrganizationId, days, costScale: 1.4 }),
    ...usageRowsFor({ userId, organizationId: memberOrganizationId, days, costScale: 0.6 }),
    ...usageRowsFor({
      userId: memberUserId,
      organizationId: ownerOrganizationId,
      days,
      costScale: 0.35,
    }),
  ];
  const fixturePath = writeFixtureFile(email, rows);

  console.log('This fixture represents: an account that has spent credits over the past');
  console.log(`${days} days, owns a sales-demo organization, and belongs to another as a member.`);
  console.log(`Warehouse rows: ${fixturePath}`);
  console.log('Suggested next step: open Profile → Usage in the mobile dev client.');

  return {
    userId,
    email,
    days,
    fixtureRows: rows.length,
    ownerOrganizationId,
    memberOrganizationId,
    usageDeepLink: 'kiloapp:///(app)/usage',
    organizationUsageDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/organization/usage',
    membersDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/organization/members',
  };
}
