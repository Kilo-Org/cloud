import { content_moderation_reports, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray, or } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

/**
 * Four list rows for the Reports list: `received` twice (the state a fresh
 * report starts in), `actioned`, and `rejected` with an appeal filed. The two
 * `received` rows are filed at the same age, so they land on the same day, and
 * they differ in kind and reason — an AI-response report and a PR discussion
 * report — so a screen that names the reported item can be told apart from one
 * that does not. Each row mirrors the input the app really writes — the
 * AI-response report
 * (`buildReportAiResponseInput`) files `ai_output`/`message` with the owning
 * model and session, the PR discussion report
 * (`comment-moderation.tsx`) files `pr_discussion_content`/`comment`, both with
 * a report-form `reason` and `context: { platform: 'mobile' }` — and carries a
 * fixed primary and receipt id, so a rerun replaces its own rows.
 */
const FIXTURE_REPORTS = [
  {
    id: '3f6b9c25-8a4e-45d2-9f31-6c0a71e2b801',
    receiptId: '51b3d7c2-9f04-4e6a-a3b8-2d0c5f9e4a01',
    label: 'receivedReceiptId',
    surface: 'ai_output',
    targetKind: 'message',
    targetId: 'msg_000000000006ReportFixture',
    modelId: '~deepseek/deepseek-flash-latest',
    sessionId: 'ses_000000000006ReportFixture',
    reason: 'other',
    triageStatus: 'received',
    appealStatus: 'none',
    ageHours: 1,
  },
  {
    id: '3f6b9c25-8a4e-45d2-9f31-6c0a71e2b804',
    receiptId: '51b3d7c2-9f04-4e6a-a3b8-2d0c5f9e4a04',
    label: 'receivedCommentReceiptId',
    surface: 'pr_discussion_content',
    targetKind: 'comment',
    targetId: '71900000000000003',
    modelId: null,
    sessionId: null,
    reason: 'spam',
    triageStatus: 'received',
    appealStatus: 'none',
    ageHours: 1,
  },
  {
    id: '3f6b9c25-8a4e-45d2-9f31-6c0a71e2b802',
    receiptId: '51b3d7c2-9f04-4e6a-a3b8-2d0c5f9e4a02',
    label: 'actionedReceiptId',
    surface: 'pr_discussion_content',
    targetKind: 'comment',
    targetId: '71900000000000001',
    modelId: null,
    sessionId: null,
    reason: 'spam',
    triageStatus: 'actioned',
    appealStatus: 'none',
    ageHours: 48,
  },
  {
    id: '3f6b9c25-8a4e-45d2-9f31-6c0a71e2b803',
    receiptId: '51b3d7c2-9f04-4e6a-a3b8-2d0c5f9e4a03',
    label: 'rejectedReceiptId',
    surface: 'pr_discussion_content',
    targetKind: 'comment',
    targetId: '71900000000000002',
    modelId: null,
    sessionId: null,
    reason: 'other',
    triageStatus: 'rejected',
    appealStatus: 'submitted',
    ageHours: 120,
  },
] as const;

const HOUR_MS = 60 * 60 * 1000;
const REPORT_PLATFORM = 'mobile';

function printUsage(): void {
  console.log(
    'Seed the report receipts list for one local user: four rows, two sharing a status and a day.'
  );
  console.log('');
  console.log(`Usage: pnpm dev:seed app:mobile-report-receipts ${usage}`);
  console.log('');
  console.log('Options:');
  console.log('  --help, -h  Show this message.');
  console.log('');
  console.log('The topic replaces its own fixture rows, so a rerun is idempotent and');
  console.log('keeps any report the user already filed. Open Profile → Reports in the');
  console.log('mobile app to read them.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  if (args.length > 1) {
    throw new Error(`Unknown argument: ${args[1]}`);
  }

  assertLocalSeedDatabase('app:mobile-report-receipts');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);
  const matches = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  const exact = matches.filter(match => match.email === email);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }
  if (resolved.length > 1) {
    const listed = resolved.map(match => `${match.email} (${match.id})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${listed}`);
  }

  const [user] = resolved;
  const now = Date.now();

  // Reset only the rows this topic owns, so a rerun is idempotent and any real
  // report the user filed stays in the list. The rows are keyed by their own
  // fixed ids, and each carries a fixed receipt id, so a rerun replaces them;
  // a user agent cannot distinguish them, and neither can a receipt list.
  await db.delete(content_moderation_reports).where(
    inArray(
      content_moderation_reports.id,
      FIXTURE_REPORTS.map(report => report.id)
    )
  );

  await db.insert(content_moderation_reports).values(
    FIXTURE_REPORTS.map(report => ({
      id: report.id,
      kilo_user_id: user.id,
      surface: report.surface,
      target_kind: report.targetKind,
      target_id: report.targetId,
      model_id: report.modelId,
      session_id: report.sessionId,
      reason: report.reason,
      context_json: { platform: REPORT_PLATFORM },
      receipt_id: report.receiptId,
      triage_status: report.triageStatus,
      appeal_status: report.appealStatus,
      created_at: new Date(now - report.ageHours * HOUR_MS).toISOString(),
    }))
  );

  const rows = await db
    .select({
      receiptId: content_moderation_reports.receipt_id,
      triageStatus: content_moderation_reports.triage_status,
      appealStatus: content_moderation_reports.appeal_status,
    })
    .from(content_moderation_reports)
    .where(eq(content_moderation_reports.kilo_user_id, user.id));

  console.log(
    'This fixture represents: one reader whose reports list holds four rows, the oldest one appealed and two of them filed the same day in the same received state.'
  );

  return {
    email: user.email,
    reports: rows.length,
    ...Object.fromEntries(FIXTURE_REPORTS.map(report => [report.label, report.receiptId])),
  };
}
