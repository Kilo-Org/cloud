import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

type ScriptOptions = {
  email: string;
  issueMonth?: string;
  invoiceId: string;
  includeBaseCredits: boolean;
};

function loadLocalEnv(): void {
  for (const envPath of [
    resolve(process.cwd(), '../../.env.local'),
    resolve(process.cwd(), '.env.local'),
  ]) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      break;
    }
  }

  Object.assign(process.env, { NODE_ENV: 'development' });
  process.env.IS_IN_AUTOMATED_TEST ??= 'true';
  process.env.POSTGRES_CONNECT_TIMEOUT ??= '30000';
  process.env.POSTGRES_MAX_QUERY_TIME ??= '30000';
  process.env.POSTGRES_SCRIPT_URL ??= process.env.POSTGRES_URL;
  process.env.NEXT_PUBLIC_GASTOWN_URL ??= 'http://localhost:8787';
  process.env.NEXT_PUBLIC_KILO_CHAT_URL ??= 'http://localhost:8788';
  process.env.NEXT_PUBLIC_EVENT_SERVICE_URL ??= 'http://localhost:8789';
  process.env.NEXT_PUBLIC_WASTELAND_URL ??= 'http://localhost:8790';
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter web script src/scripts/dev-apply-kilo-pass-referral.ts <email> [--issue-month YYYY-MM-01] [--invoice-id in_local_...] [--include-base]

Examples:
  pnpm --filter web script src/scripts/dev-apply-kilo-pass-referral.ts kilopass-referee1@example.com
  pnpm --filter web script src/scripts/dev-apply-kilo-pass-referral.ts kilopass-referrer@example.com --include-base
`);
}

function parseArgs(argv: string[]): ScriptOptions {
  const email = argv.find(arg => !arg.startsWith('--'));
  if (!email) {
    printUsage();
    throw new Error('Missing email argument');
  }

  const getFlagValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  return {
    email,
    issueMonth: getFlagValue('--issue-month'),
    invoiceId: getFlagValue('--invoice-id') ?? `in_local_referral_bonus_${Date.now()}`,
    includeBaseCredits: argv.includes('--include-base'),
  };
}

function assertIssueMonth(issueMonth: string): void {
  if (!/^\d{4}-\d{2}-01$/.test(issueMonth)) {
    throw new Error(`Invalid --issue-month ${issueMonth}; expected YYYY-MM-01`);
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const [
    drizzleOrm,
    balanceCache,
    drizzle,
    constants,
    dayjsModule,
    enums,
    issuance,
    state,
    schema,
  ] = await Promise.all([
    import('drizzle-orm'),
    import('@/lib/balanceCache'),
    import('@/lib/drizzle'),
    import('@/lib/kilo-pass/constants'),
    import('@/lib/kilo-pass/dayjs'),
    import('@/lib/kilo-pass/enums'),
    import('@/lib/kilo-pass/issuance'),
    import('@/lib/kilo-pass/state'),
    import('@kilocode/db/schema'),
  ]);

  const { eq, desc } = drizzleOrm;
  const { forceImmediateExpirationRecomputation } = balanceCache;
  const { db, closeAllDrizzleConnections } = drizzle;
  const { KILO_PASS_TIER_CONFIG } = constants;
  const { dayjs } = dayjsModule;
  const { KiloPassCadence, KiloPassIssuanceSource } = enums;
  const {
    applyPendingKiloPassReferralBonusForIssuance,
    computeIssueMonth,
    createOrGetIssuanceHeader,
    issueBaseCreditsForIssuance,
  } = issuance;
  const { getKiloPassStateForUser } = state;
  const { kilo_pass_issuances, kilocode_users } = schema;

  try {
    const options = parseArgs(process.argv.slice(2));
    const user = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.google_user_email, options.email),
    });

    if (!user) {
      throw new Error(`User not found: ${options.email}`);
    }

    const subscription = await getKiloPassStateForUser(db, user.id);
    if (!subscription) {
      throw new Error(`No Kilo Pass subscription for ${options.email}`);
    }
    if (subscription.cadence !== KiloPassCadence.Monthly) {
      throw new Error(`Referral bonus application is monthly-only; got ${subscription.cadence}`);
    }
    if (subscription.status !== 'active') {
      throw new Error(`Kilo Pass subscription must be active; got ${subscription.status}`);
    }

    const getDefaultNextIssueMonth = async (): Promise<string> => {
      const latestIssuance = await db.query.kilo_pass_issuances.findFirst({
        where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription.subscriptionId),
        orderBy: desc(kilo_pass_issuances.issue_month),
      });

      const baseMonth = latestIssuance?.issue_month
        ? dayjs(`${latestIssuance.issue_month}T00:00:00.000Z`).utc()
        : dayjs(subscription.startedAt ?? new Date().toISOString()).utc();

      return computeIssueMonth(baseMonth.add(1, 'month'));
    };

    const issueMonth = options.issueMonth ?? (await getDefaultNextIssueMonth());
    assertIssueMonth(issueMonth);

    const result = await db.transaction(async tx => {
      const createdIssuance = await createOrGetIssuanceHeader(tx, {
        subscriptionId: subscription.subscriptionId,
        issueMonth,
        source: KiloPassIssuanceSource.StripeInvoice,
        stripeInvoiceId: options.invoiceId,
      });

      const baseCreditsResult = options.includeBaseCredits
        ? await issueBaseCreditsForIssuance(tx, {
            issuanceId: createdIssuance.issuanceId,
            subscriptionId: subscription.subscriptionId,
            kiloUserId: user.id,
            amountUsd: KILO_PASS_TIER_CONFIG[subscription.tier].monthlyPriceUsd,
            stripeInvoiceId: options.invoiceId,
            description: `Local Kilo Pass base credits (${subscription.tier}, ${subscription.cadence})`,
          })
        : null;

      const referralBonusResult = await applyPendingKiloPassReferralBonusForIssuance(tx, {
        issuanceId: createdIssuance.issuanceId,
        subscriptionId: subscription.subscriptionId,
        kiloUserId: user.id,
        stripeInvoiceId: options.invoiceId,
      });

      return {
        issuance: createdIssuance,
        baseCreditsResult,
        referralBonusResult,
      };
    });

    await forceImmediateExpirationRecomputation(user.id);

    console.log(
      JSON.stringify(
        {
          email: options.email,
          userId: user.id,
          subscriptionId: subscription.subscriptionId,
          issueMonth,
          invoiceId: options.invoiceId,
          includeBaseCredits: options.includeBaseCredits,
          result,
        },
        null,
        2
      )
    );
  } finally {
    await closeAllDrizzleConnections();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
