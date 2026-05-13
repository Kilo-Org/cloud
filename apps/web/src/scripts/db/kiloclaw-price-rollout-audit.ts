/**
 * Read-only KiloClaw price rollout audit.
 *
 * Usage:
 *   pnpm script db kiloclaw-price-rollout-audit --stripe-fixture ./stripe-kiloclaw-prices.json --legacy-entitlement-correction-deployed-at 2026-05-12T12:00:00.000Z
 *   pnpm script db kiloclaw-price-rollout-audit --stripe-live --legacy-entitlement-correction-deployed-at 2026-05-12T12:00:00.000Z
 *
 * Stripe fixture shape:
 *   [{ "subscriptionId": "sub_...", "priceIds": ["price_..."] }]
 *   { "subscriptions": [{ "subscriptionId": "sub_...", "priceIds": ["price_..."] }] }
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Stripe from 'stripe';
import { isNotNull } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  evaluateKiloClawPriceRolloutAudit,
  formatKiloClawPriceRolloutAuditReport,
  type KiloClawRolloutAuditHardcodedPriceHit,
  type KiloClawRolloutAuditStripeSubscriptionPrices,
} from '@/lib/kiloclaw/price-rollout-audit';
import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db';

const ROLLOUT_STARTED_AT_ISO = `${CURRENT_KILOCLAW_PRICE_VERSION}T00:00:00.000Z`;
// Split literals prevent the audit from matching its own pattern list.
const LEGACY_AMOUNT_PATTERNS = [
  '4' + '_000_000',
  '4' + '000000',
  '9' + '_000_000',
  '9' + '000000',
  '48' + '_000_000',
  '48' + '000000',
];
const SCAN_ROOTS = [
  'apps/web/src',
  'services/kiloclaw-billing/src',
  'services/kiloclaw/src',
  'packages/db/src',
];
const SCAN_EXTENSIONS = ['.ts', '.tsx'];

type AuditArgs =
  | {
      mode: 'stripe-fixture';
      fixturePath: string;
      legacyEntitlementCorrectionDeployedAtIso: string;
    }
  | { mode: 'stripe-live'; legacyEntitlementCorrectionDeployedAtIso: string };

function usage(): string {
  return [
    'Usage:',
    '  pnpm script db kiloclaw-price-rollout-audit --stripe-fixture ./stripe-kiloclaw-prices.json --legacy-entitlement-correction-deployed-at <ISO>',
    '  pnpm script db kiloclaw-price-rollout-audit --stripe-live --legacy-entitlement-correction-deployed-at <ISO>',
    '',
    'This audit is read-only. Provide either a Stripe price fixture or --stripe-live so Stripe family checks are complete.',
    'The legacy entitlement correction deployment cutoff must be an explicit ISO timestamp.',
  ].join('\n');
}

function requireIsoFlag(value: string | undefined): string {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(usage());
  }
  return value;
}

function parseArgs(args: string[]): AuditArgs {
  const cutoffFlagIndex = args.indexOf('--legacy-entitlement-correction-deployed-at');
  if (cutoffFlagIndex === -1) {
    throw new Error(usage());
  }
  const legacyEntitlementCorrectionDeployedAtIso = requireIsoFlag(args[cutoffFlagIndex + 1]);
  const remainingArgs = args.filter(
    (_arg, index) => index !== cutoffFlagIndex && index !== cutoffFlagIndex + 1
  );

  if (remainingArgs.length === 2 && remainingArgs[0] === '--stripe-fixture') {
    return {
      mode: 'stripe-fixture',
      fixturePath: remainingArgs[1],
      legacyEntitlementCorrectionDeployedAtIso,
    };
  }
  if (remainingArgs.length === 1 && remainingArgs[0] === '--stripe-live') {
    return { mode: 'stripe-live', legacyEntitlementCorrectionDeployedAtIso };
  }
  throw new Error(usage());
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var for KiloClaw price rollout audit: ${name}`);
  }
  return value;
}

function parseFixtureFile(value: unknown): KiloClawRolloutAuditStripeSubscriptionPrices[] {
  let subscriptions: unknown;
  if (Array.isArray(value)) {
    subscriptions = value;
  } else if (value && typeof value === 'object' && 'subscriptions' in value) {
    subscriptions = value.subscriptions;
  }

  if (!Array.isArray(subscriptions)) {
    throw new Error('Stripe fixture must be an array or an object with a subscriptions array.');
  }

  return subscriptions.map((row: unknown, index: number) => {
    if (!row || typeof row !== 'object') {
      throw new Error(`Invalid Stripe fixture entry at index ${index}.`);
    }
    const candidate = row as { subscriptionId?: unknown; priceIds?: unknown };
    if (
      typeof candidate.subscriptionId !== 'string' ||
      !Array.isArray(candidate.priceIds) ||
      candidate.priceIds.some((priceId: unknown) => typeof priceId !== 'string')
    ) {
      throw new Error(`Invalid Stripe fixture entry at index ${index}.`);
    }
    return { subscriptionId: candidate.subscriptionId, priceIds: candidate.priceIds };
  });
}

async function loadStripeFixture(
  path: string
): Promise<KiloClawRolloutAuditStripeSubscriptionPrices[]> {
  const raw = await readFile(path, 'utf8');
  return parseFixtureFile(JSON.parse(raw));
}

async function loadStripeLivePrices(
  stripeSubscriptionIds: string[]
): Promise<KiloClawRolloutAuditStripeSubscriptionPrices[]> {
  const secretKey = requireEnv('STRIPE_SECRET_KEY');
  const stripe = new Stripe(secretKey);
  const rows: KiloClawRolloutAuditStripeSubscriptionPrices[] = [];

  for (const subscriptionId of stripeSubscriptionIds) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    rows.push({
      subscriptionId,
      priceIds: subscription.items.data.flatMap(item => (item.price?.id ? [item.price.id] : [])),
    });
  }

  return rows;
}

async function walkFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
      continue;
    }
    if (entry.isFile() && SCAN_EXTENSIONS.some(extension => path.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

async function scanHardcodedLegacyAmounts(): Promise<KiloClawRolloutAuditHardcodedPriceHit[]> {
  const hits: KiloClawRolloutAuditHardcodedPriceHit[] = [];
  for (const root of SCAN_ROOTS) {
    for (const path of await walkFiles(root)) {
      const text = await readFile(path, 'utf8');
      const lines = text.split('\n');
      lines.forEach((lineText, index) => {
        for (const value of LEGACY_AMOUNT_PATTERNS) {
          if (lineText.includes(value)) {
            hits.push({ path, line: index + 1, value, text: lineText });
          }
        }
      });
    }
  }
  return hits;
}

export async function run(...args: string[]) {
  const parsedArgs = parseArgs(args);
  const subscriptions = await db
    .select({
      id: kiloclaw_subscriptions.id,
      userId: kiloclaw_subscriptions.user_id,
      createdAtIso: kiloclaw_subscriptions.created_at,
      status: kiloclaw_subscriptions.status,
      priceVersion: kiloclaw_subscriptions.kiloclaw_price_version,
      stripeSubscriptionId: kiloclaw_subscriptions.stripe_subscription_id,
      transferredToSubscriptionId: kiloclaw_subscriptions.transferred_to_subscription_id,
      instanceId: kiloclaw_subscriptions.instance_id,
    })
    .from(kiloclaw_subscriptions);
  const instances = await db
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      organizationId: kiloclaw_instances.organization_id,
      createdAtIso: kiloclaw_instances.created_at,
      destroyedAtIso: kiloclaw_instances.destroyed_at,
      instanceType: kiloclaw_instances.instance_type,
      adminSizeOverride: kiloclaw_instances.admin_size_override,
    })
    .from(kiloclaw_instances);
  const activeStripeRows = await db
    .select({ stripeSubscriptionId: kiloclaw_subscriptions.stripe_subscription_id })
    .from(kiloclaw_subscriptions)
    .where(isNotNull(kiloclaw_subscriptions.stripe_subscription_id));
  const stripeSubscriptionIds = Array.from(
    new Set(
      activeStripeRows.flatMap(row => (row.stripeSubscriptionId ? [row.stripeSubscriptionId] : []))
    )
  );
  const stripeSubscriptionPrices =
    parsedArgs.mode === 'stripe-fixture'
      ? await loadStripeFixture(parsedArgs.fixturePath)
      : await loadStripeLivePrices(stripeSubscriptionIds);

  const hardcodedPriceHits = await scanHardcodedLegacyAmounts();
  const result = evaluateKiloClawPriceRolloutAudit({
    nowIso: new Date().toISOString(),
    rolloutStartedAtIso: ROLLOUT_STARTED_AT_ISO,
    legacyEntitlementCorrectionDeployedAtIso: parsedArgs.legacyEntitlementCorrectionDeployedAtIso,
    stripePriceIds: {
      legacy: {
        standardIntro: requireEnv('STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID'),
        standard: requireEnv('STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID'),
        commit: requireEnv('STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID'),
      },
      current: {
        standard: requireEnv('STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID'),
        commit: requireEnv('STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID'),
      },
    },
    subscriptions,
    instances: instances.map(instance => ({
      id: instance.id,
      userId: instance.userId,
      organizationId: instance.organizationId,
      createdAtIso: instance.createdAtIso,
      destroyedAtIso: instance.destroyedAtIso,
      instanceType: instance.instanceType,
      hasAdminSizeOverride: instance.adminSizeOverride !== null,
    })),
    stripeSubscriptionPrices,
    hardcodedPriceHits,
  });

  console.log(formatKiloClawPriceRolloutAuditReport(result));
  if (!result.ok) {
    throw new Error('KiloClaw price rollout audit failed. See actionable findings above.');
  }
}
