import { randomUUID } from 'node:crypto';

import { computeDatabaseUrl } from '@kilocode/db';
import {
  captureCostInsightSpend,
  COST_INSIGHT_DRIVER_FALLBACK,
  COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
  type CostInsightSpendOwner,
} from '@kilocode/db/cost-insights-rollups';
import {
  api_kind,
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_rollup_coverage,
  credit_transactions,
  feature,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_metadata,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import type { GatewayApiKind } from '@kilocode/db/schema-types';
import { eq, inArray, like, or, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const COVERAGE_DAYS = 90;
const BALANCE_BUFFER_MICRODOLLARS = 100_000_000;
const CREDIT_CATEGORY_PREFIX = 'dev-seed:cost-insights';

const PERSONAL_OWNER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6701';
const BILLING_MANAGER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6702';
const ORGANIZATION_MEMBER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6703';
const ORGANIZATION_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6790';

const PERSONAL_OWNER_EMAIL = 'cost-insights-owner@example.com';
const BILLING_MANAGER_EMAIL = 'cost-insights-billing-manager@example.com';
const ORGANIZATION_MEMBER_EMAIL = 'cost-insights-member@example.com';
const ORGANIZATION_NAME = '[seed:cost-insights] Northstar Labs';

const PERSONAL_OWNER: CostInsightSpendOwner = { type: 'user', id: PERSONAL_OWNER_ID };
const ORGANIZATION_OWNER: CostInsightSpendOwner = {
  type: 'organization',
  id: ORGANIZATION_ID,
};
const SEED_USER_IDS = [PERSONAL_OWNER_ID, BILLING_MANAGER_ID, ORGANIZATION_MEMBER_ID];

export const usage = '';

type VariableDriver = {
  featureKey: string;
  apiKind: GatewayApiKind;
  modelKey: string;
  providerKey: string;
};

type VariableSpendEvent = VariableDriver & {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
};

type ScheduledSpendEvent = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  featureKey: 'enrollment' | 'renewal';
  planKey: 'standard' | 'commit';
};

const PERSONAL_DRIVERS: VariableDriver[] = [
  {
    featureKey: 'cli',
    apiKind: 'messages',
    modelKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
  },
  {
    featureKey: 'vscode-extension',
    apiKind: 'chat_completions',
    modelKey: 'openai/gpt-4.1-mini',
    providerKey: 'openai',
  },
  {
    featureKey: 'cloud-agent',
    apiKind: 'responses',
    modelKey: 'google/gemini-2.5-pro',
    providerKey: 'google',
  },
];

const ORGANIZATION_DRIVERS: VariableDriver[] = [
  {
    featureKey: 'code-review',
    apiKind: 'messages',
    modelKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
  },
  {
    featureKey: 'cloud-agent',
    apiKind: 'responses',
    modelKey: 'openai/gpt-4.1',
    providerKey: 'openai',
  },
  {
    featureKey: 'security-agent',
    apiKind: 'messages',
    modelKey: 'google/gemini-2.5-pro',
    providerKey: 'google',
  },
];

function printUsage(): void {
  console.log('Usage: pnpm dev:seed cost-insights:spend-evidence');
  console.log('');
  console.log('Creates dedicated personal and organization Spend owners with 90 days of');
  console.log('canonical spend evidence and matching Cost Insights hourly rollups.');
  console.log('');
  console.log('The fixture includes current-hour anomaly spikes, rolling 24-hour spend above');
  console.log('typical test thresholds, recurring Scheduled Credit spend, and organization');
  console.log("member driver attribution. Reruns replace only this fixture's data.");
}

function requireNoArguments(args: string[]): void {
  if (args.length > 0) {
    printUsage();
    throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  }
}

function assertLocalDatabaseTarget(): { hostname: string; database: string; port: string } {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Cost Insights dev seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `Cost Insights dev seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return {
    hostname: databaseUrl.hostname,
    database: decodeURIComponent(databaseUrl.pathname.slice(1)),
    port: databaseUrl.port || '5432',
  };
}

function floorUtcHour(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

function timestampAtHourOffset(currentHour: number, hourOffset: number): string {
  return new Date(currentHour - hourOffset * HOUR_MS).toISOString();
}

function chooseByIndex<T>(values: T[], index: number, label: string): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error(`Missing ${label} seed value.`);
  }
  return value;
}

function buildVariableSpendEvents(currentHour: number): VariableSpendEvent[] {
  const events: VariableSpendEvent[] = [];
  const organizationActors = [PERSONAL_OWNER_ID, BILLING_MANAGER_ID, ORGANIZATION_MEMBER_ID];

  for (let hourOffset = 1; hourOffset <= 23; hourOffset += 1) {
    const personalDriver = chooseByIndex(PERSONAL_DRIVERS, hourOffset, 'personal driver');
    events.push({
      ...personalDriver,
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 180_000 + ((hourOffset * 47_000) % 420_000),
    });

    const organizationDriver = chooseByIndex(
      ORGANIZATION_DRIVERS,
      hourOffset,
      'organization driver'
    );
    events.push({
      ...organizationDriver,
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, hourOffset, 'organization actor'),
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 320_000 + ((hourOffset * 83_000) % 880_000),
    });
  }

  let historicalIndex = 0;
  for (
    let hourOffset = 24;
    hourOffset < COVERAGE_DAYS * 24;
    hourOffset += 12, historicalIndex += 1
  ) {
    if (historicalIndex % 11 === 0) {
      continue;
    }

    const personalDriver = chooseByIndex(PERSONAL_DRIVERS, historicalIndex, 'personal driver');
    events.push({
      ...personalDriver,
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 140_000 + ((historicalIndex * 71_000) % 760_000),
    });

    const organizationDriver = chooseByIndex(
      ORGANIZATION_DRIVERS,
      historicalIndex,
      'organization driver'
    );
    events.push({
      ...organizationDriver,
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, historicalIndex, 'organization actor'),
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 280_000 + ((historicalIndex * 137_000) % 1_520_000),
    });
  }

  const personalSpikeAmounts = [12_000_000, 11_000_000, 9_000_000];
  for (const [index, amountMicrodollars] of personalSpikeAmounts.entries()) {
    events.push({
      ...chooseByIndex(PERSONAL_DRIVERS, index, 'personal spike driver'),
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: new Date(currentHour).toISOString(),
      amountMicrodollars,
    });
  }

  const organizationSpikeAmounts = [18_000_000, 15_000_000, 13_000_000];
  for (const [index, amountMicrodollars] of organizationSpikeAmounts.entries()) {
    events.push({
      ...chooseByIndex(ORGANIZATION_DRIVERS, index, 'organization spike driver'),
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, index, 'organization spike actor'),
      occurredAt: new Date(currentHour).toISOString(),
      amountMicrodollars,
    });
  }

  return events;
}

function buildScheduledSpendEvents(currentHour: number): ScheduledSpendEvent[] {
  return [
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: new Date(currentHour).toISOString(),
      amountMicrodollars: 29_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: new Date(currentHour - 30 * DAY_MS).toISOString(),
      amountMicrodollars: 29_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: new Date(currentHour - 60 * DAY_MS).toISOString(),
      amountMicrodollars: 99_000_000,
      featureKey: 'enrollment',
      planKey: 'commit',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: BILLING_MANAGER_ID,
      occurredAt: new Date(currentHour).toISOString(),
      amountMicrodollars: 49_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: ORGANIZATION_MEMBER_ID,
      occurredAt: new Date(currentHour - 30 * DAY_MS).toISOString(),
      amountMicrodollars: 49_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: new Date(currentHour - 60 * DAY_MS).toISOString(),
      amountMicrodollars: 149_000_000,
      featureKey: 'enrollment',
      planKey: 'commit',
    },
  ];
}

function ownerColumns(owner: CostInsightSpendOwner): {
  organizationId: string | null;
  userId: string | null;
} {
  return owner.type === 'organization'
    ? { organizationId: owner.id, userId: null }
    : { organizationId: null, userId: owner.id };
}

function sumAmounts<T extends { amountMicrodollars: number }>(events: T[]): number {
  return events.reduce((total, event) => total + event.amountMicrodollars, 0);
}

function sumOwnerAmounts<T extends { owner: CostInsightSpendOwner; amountMicrodollars: number }>(
  events: T[],
  owner: CostInsightSpendOwner
): number {
  return sumAmounts(
    events.filter(event => event.owner.type === owner.type && event.owner.id === owner.id)
  );
}

function requireLookupId(
  lookup: ReadonlyMap<string, number>,
  value: string,
  lookupName: string
): number {
  const id = lookup.get(value);
  if (id === undefined) {
    throw new Error(`Missing ${lookupName} lookup row for ${value}.`);
  }
  return id;
}

function kiloclawCreditCategory(event: ScheduledSpendEvent, index: number): string {
  const sourcePrefix =
    event.planKey === 'commit' ? 'kiloclaw-subscription-commit' : 'kiloclaw-subscription';
  return `${sourcePrefix}:${CREDIT_CATEGORY_PREFIX}:${index}`;
}

function kiloclawDescription(event: ScheduledSpendEvent): string {
  return `KiloClaw ${event.planKey} ${event.featureKey}`;
}

function loginPath(email: string, callbackPath: string): string {
  const params = new URLSearchParams({ fakeUser: email, callbackPath });
  return `/users/sign_in?${params.toString()}`;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  requireNoArguments(args);

  const databaseTarget = assertLocalDatabaseTarget();
  const db = getSeedDb();
  const currentHour = floorUtcHour(Date.now());
  const currentHourIso = new Date(currentHour).toISOString();
  const coverageStartIso = new Date(currentHour - COVERAGE_DAYS * DAY_MS).toISOString();
  const variableEvents = buildVariableSpendEvents(currentHour);
  const scheduledEvents = buildScheduledSpendEvents(currentHour);

  const personalVariableMicrodollars = sumOwnerAmounts(variableEvents, PERSONAL_OWNER);
  const personalScheduledMicrodollars = sumOwnerAmounts(scheduledEvents, PERSONAL_OWNER);
  const organizationVariableMicrodollars = sumOwnerAmounts(variableEvents, ORGANIZATION_OWNER);
  const organizationScheduledMicrodollars = sumOwnerAmounts(scheduledEvents, ORGANIZATION_OWNER);

  const featureKeys = [...new Set(variableEvents.map(event => event.featureKey))];
  const apiKinds = [...new Set(variableEvents.map(event => event.apiKind))];

  await db.transaction(async tx => {
    const seedUsageIds = tx
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(
        or(
          inArray(microdollar_usage.kilo_user_id, SEED_USER_IDS),
          eq(microdollar_usage.organization_id, ORGANIZATION_ID)
        )
      );

    await tx
      .delete(microdollar_usage_metadata)
      .where(inArray(microdollar_usage_metadata.id, seedUsageIds));
    await tx
      .delete(microdollar_usage_daily)
      .where(
        or(
          inArray(microdollar_usage_daily.kilo_user_id, SEED_USER_IDS),
          eq(microdollar_usage_daily.organization_id, ORGANIZATION_ID)
        )
      );
    await tx
      .delete(microdollar_usage)
      .where(
        or(
          inArray(microdollar_usage.kilo_user_id, SEED_USER_IDS),
          eq(microdollar_usage.organization_id, ORGANIZATION_ID)
        )
      );
    await tx
      .delete(credit_transactions)
      .where(
        or(
          like(
            credit_transactions.credit_category,
            `kiloclaw-subscription:${CREDIT_CATEGORY_PREFIX}:%`
          ),
          like(
            credit_transactions.credit_category,
            `kiloclaw-subscription-commit:${CREDIT_CATEGORY_PREFIX}:%`
          )
        )
      );
    await tx
      .delete(cost_insight_owner_hour_driver_buckets)
      .where(
        or(
          eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, PERSONAL_OWNER_ID),
          eq(cost_insight_owner_hour_driver_buckets.owned_by_organization_id, ORGANIZATION_ID)
        )
      );
    await tx
      .delete(cost_insight_owner_hour_totals)
      .where(
        or(
          eq(cost_insight_owner_hour_totals.owned_by_user_id, PERSONAL_OWNER_ID),
          eq(cost_insight_owner_hour_totals.owned_by_organization_id, ORGANIZATION_ID)
        )
      );

    const seedUsers = [
      {
        id: PERSONAL_OWNER_ID,
        email: PERSONAL_OWNER_EMAIL,
        name: 'Morgan Lee',
        stripeCustomerId: 'cus_dev_seed_cost_insights_owner',
      },
      {
        id: BILLING_MANAGER_ID,
        email: BILLING_MANAGER_EMAIL,
        name: 'Priya Shah',
        stripeCustomerId: 'cus_dev_seed_cost_insights_billing',
      },
      {
        id: ORGANIZATION_MEMBER_ID,
        email: ORGANIZATION_MEMBER_EMAIL,
        name: 'Diego Santos',
        stripeCustomerId: 'cus_dev_seed_cost_insights_member',
      },
    ];

    for (const user of seedUsers) {
      await tx
        .insert(kilocode_users)
        .values({
          id: user.id,
          google_user_email: user.email,
          google_user_name: user.name,
          google_user_image_url: `https://example.com/dev-seed/${user.id}.png`,
          stripe_customer_id: user.stripeCustomerId,
          normalized_email: user.email,
          has_validation_stytch: true,
          customer_source: 'dev-seed',
          microdollars_used: 0,
          total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
        })
        .onConflictDoUpdate({
          target: kilocode_users.id,
          set: {
            google_user_email: user.email,
            google_user_name: user.name,
            google_user_image_url: `https://example.com/dev-seed/${user.id}.png`,
            normalized_email: user.email,
            has_validation_stytch: true,
            customer_source: 'dev-seed',
            microdollars_used: 0,
            total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
          },
        });
    }

    await tx
      .insert(organizations)
      .values({
        id: ORGANIZATION_ID,
        name: ORGANIZATION_NAME,
        created_by_kilo_user_id: PERSONAL_OWNER_ID,
        plan: 'teams',
        seat_count: 3,
        require_seats: true,
        microdollars_used: 0,
        microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
        total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
      })
      .onConflictDoUpdate({
        target: organizations.id,
        set: {
          name: ORGANIZATION_NAME,
          created_by_kilo_user_id: PERSONAL_OWNER_ID,
          plan: 'teams',
          seat_count: 3,
          require_seats: true,
          deleted_at: null,
          microdollars_used: 0,
          microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
          total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
        },
      });

    const memberships = [
      {
        organization_id: ORGANIZATION_ID,
        kilo_user_id: PERSONAL_OWNER_ID,
        role: 'owner',
      },
      {
        organization_id: ORGANIZATION_ID,
        kilo_user_id: BILLING_MANAGER_ID,
        role: 'billing_manager',
      },
      {
        organization_id: ORGANIZATION_ID,
        kilo_user_id: ORGANIZATION_MEMBER_ID,
        role: 'member',
      },
    ] satisfies (typeof organization_memberships.$inferInsert)[];

    for (const membership of memberships) {
      await tx
        .insert(organization_memberships)
        .values(membership)
        .onConflictDoUpdate({
          target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
          set: { role: membership.role },
        });
    }

    await tx
      .insert(feature)
      .values(featureKeys.map(featureKey => ({ feature: featureKey })))
      .onConflictDoNothing();
    await tx
      .insert(api_kind)
      .values(apiKinds.map(apiKind => ({ api_kind: apiKind })))
      .onConflictDoNothing();

    const featureRows = await tx
      .select({ id: feature.feature_id, value: feature.feature })
      .from(feature)
      .where(inArray(feature.feature, featureKeys));
    const apiKindRows = await tx
      .select({ id: api_kind.api_kind_id, value: api_kind.api_kind })
      .from(api_kind)
      .where(inArray(api_kind.api_kind, apiKinds));
    const featureIds = new Map<string, number>(featureRows.map(row => [row.value, row.id]));
    const apiKindIds = new Map<string, number>(apiKindRows.map(row => [row.value, row.id]));

    const preparedVariableEvents = variableEvents.map((event, index) => {
      const id = randomUUID();
      return {
        event,
        usage: {
          id,
          kilo_user_id: event.actorUserId,
          organization_id: ownerColumns(event.owner).organizationId,
          cost: event.amountMicrodollars,
          input_tokens: 2_000 + (index % 8) * 750,
          output_tokens: 800 + (index % 5) * 450,
          cache_write_tokens: index % 3 === 0 ? 400 : 0,
          cache_hit_tokens: index % 2 === 0 ? 1_200 : 0,
          created_at: event.occurredAt,
          provider: event.providerKey,
          model: event.modelKey,
          requested_model: event.modelKey,
          inference_provider: event.providerKey,
          has_error: false,
          abuse_classification: 0,
        } satisfies typeof microdollar_usage.$inferInsert,
        metadata: {
          id,
          created_at: event.occurredAt,
          message_id: `${CREDIT_CATEGORY_PREFIX}:usage:${index}`,
          feature_id: requireLookupId(featureIds, event.featureKey, 'feature'),
          api_kind_id: requireLookupId(apiKindIds, event.apiKind, 'API kind'),
          streamed: index % 2 === 0,
          is_byok: false,
          is_user_byok: false,
          has_tools: true,
        } satisfies typeof microdollar_usage_metadata.$inferInsert,
      };
    });

    await tx.insert(microdollar_usage).values(preparedVariableEvents.map(item => item.usage));
    await tx
      .insert(microdollar_usage_metadata)
      .values(preparedVariableEvents.map(item => item.metadata));

    for (const event of variableEvents) {
      await captureCostInsightSpend(tx, {
        owner: event.owner,
        actorUserId: event.actorUserId,
        occurredAt: event.occurredAt,
        amountMicrodollars: event.amountMicrodollars,
        category: 'variable',
        source: 'ai_gateway',
        productKey: event.featureKey,
        featureKey: event.apiKind,
        modelOrPlanKey: event.modelKey,
        providerKey: event.providerKey,
      });
    }

    const scheduledRows = scheduledEvents.map((event, index) => ({
      id: randomUUID(),
      kilo_user_id: event.actorUserId,
      organization_id: ownerColumns(event.owner).organizationId,
      amount_microdollars: -event.amountMicrodollars,
      is_free: false,
      description: kiloclawDescription(event),
      credit_category: kiloclawCreditCategory(event, index),
      created_at: event.occurredAt,
      check_category_uniqueness: false,
    })) satisfies (typeof credit_transactions.$inferInsert)[];

    await tx.insert(credit_transactions).values(scheduledRows);

    for (const event of scheduledEvents) {
      await captureCostInsightSpend(tx, {
        owner: event.owner,
        actorUserId: event.actorUserId,
        occurredAt: event.occurredAt,
        amountMicrodollars: event.amountMicrodollars,
        category: 'scheduled',
        source: 'kiloclaw',
        productKey: COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
        featureKey: event.featureKey,
        modelOrPlanKey: event.planKey,
        providerKey: COST_INSIGHT_DRIVER_FALLBACK,
      });
    }

    const personalSpendMicrodollars = personalVariableMicrodollars + personalScheduledMicrodollars;
    const organizationSpendMicrodollars =
      organizationVariableMicrodollars + organizationScheduledMicrodollars;

    await tx
      .update(kilocode_users)
      .set({
        microdollars_used: personalSpendMicrodollars,
        total_microdollars_acquired: personalSpendMicrodollars + BALANCE_BUFFER_MICRODOLLARS,
      })
      .where(eq(kilocode_users.id, PERSONAL_OWNER_ID));
    await tx
      .update(organizations)
      .set({
        microdollars_used: organizationSpendMicrodollars,
        microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
        total_microdollars_acquired: organizationSpendMicrodollars + BALANCE_BUFFER_MICRODOLLARS,
      })
      .where(eq(organizations.id, ORGANIZATION_ID));

    await tx
      .insert(cost_insight_rollup_coverage)
      .values({
        rollup_version: 1,
        live_capture_start_hour: currentHourIso,
        coverage_start_hour: coverageStartIso,
      })
      .onConflictDoUpdate({
        target: cost_insight_rollup_coverage.rollup_version,
        set: {
          live_capture_start_hour: sql`COALESCE(${cost_insight_rollup_coverage.live_capture_start_hour}, ${currentHourIso})`,
          coverage_start_hour: sql`LEAST(
            COALESCE(${cost_insight_rollup_coverage.coverage_start_hour}, ${coverageStartIso}),
            ${coverageStartIso},
            COALESCE(${cost_insight_rollup_coverage.live_capture_start_hour}, ${currentHourIso})
          )`,
          updated_at: sql`CURRENT_TIMESTAMP`,
        },
      });
  });

  console.log('');
  console.log('This fixture represents:');
  console.log('- 90 days of personal and organization Variable Credit spend.');
  console.log('- Monthly KiloClaw Scheduled Credit spend.');
  console.log('- Current-hour anomaly spikes and rolling 24-hour threshold crossings.');
  console.log('- Three organization members contributing distinct top spend drivers.');
  console.log('');
  console.log('Seed users are DB-only Cost Insights fixtures with placeholder Stripe IDs.');
  console.log('Use development fake login; avoid Stripe-backed billing pages with these users.');

  return {
    databaseTarget: `${databaseTarget.hostname}:${databaseTarget.port}/${databaseTarget.database}`,
    personalOwnerId: PERSONAL_OWNER_ID,
    personalOwnerEmail: PERSONAL_OWNER_EMAIL,
    personalPath: '/cost-insights',
    personalLoginPath: loginPath(PERSONAL_OWNER_EMAIL, '/cost-insights'),
    organizationId: ORGANIZATION_ID,
    organizationName: ORGANIZATION_NAME,
    organizationPath: `/organizations/${ORGANIZATION_ID}/cost-insights`,
    organizationLoginPath: loginPath(
      PERSONAL_OWNER_EMAIL,
      `/organizations/${ORGANIZATION_ID}/cost-insights`
    ),
    billingManagerId: BILLING_MANAGER_ID,
    billingManagerEmail: BILLING_MANAGER_EMAIL,
    organizationMemberId: ORGANIZATION_MEMBER_ID,
    organizationMemberEmail: ORGANIZATION_MEMBER_EMAIL,
    coverageStartHour: coverageStartIso,
    currentHour: currentHourIso,
    variableRecordCount: variableEvents.length,
    scheduledRecordCount: scheduledEvents.length,
    personalVariableMicrodollars,
    personalScheduledMicrodollars,
    organizationVariableMicrodollars,
    organizationScheduledMicrodollars,
  };
}
