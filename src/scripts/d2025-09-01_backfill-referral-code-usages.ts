import { readFile } from 'fs/promises';
import * as z from 'zod';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import {
  referral_codes,
  referral_code_usages,
  credit_transactions,
  user_admin_notes,
} from '@kilocode/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { referralRedeemingBonus, referralReferringBonus } from '@/lib/promoCreditCategories';
import { findUserById } from '@/lib/user';
import { successResult } from '@/lib/maybe-result';

type ReferredUserNotLoggedEvent = {
  eventTime: Date;
  referred_kilo_user_id: string;
  ip: string;
  userAgent: string;
  requestId: string;
};

const wrapperSchema = z.object({
  matches: z.array(
    z.object({
      _time: z.string(),
      data: z.record(z.string(), z.unknown()),
    })
  ),
});

const attemptedReferralDataSchema = z.object({
  'request.ip': z.string().trim().min(1),
  'request.userAgent': z.string().trim().min(1),
  'request.id': z.string().trim().min(1),
  'request.path': z.string().trim().min(1),
});

const referredUserNotLoggedDataSchema = z.object({
  message: z.string().trim().min(1),
  'request.ip': z.string().trim().min(1),
  'request.userAgent': z.string().trim().min(1),
  'request.id': z.string().trim().min(1),
});

const USER_ID_REGEX = /User (.+?) has reached the maximum number of referrals/;

type AttemptedReferralUsageEvent = {
  eventTime: Date;
  ip: string;
  userAgent: string;
  referralCode: string;
  requestId: string;
};

function extractReferralCodeFromPath(pathStr: string | null): string | null {
  if (!pathStr) return null;
  try {
    const url = new URL(pathStr, 'https://example.com');
    const value = url.searchParams.get('referral-code');
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function parseAttemptedReferralUsageEventsWithStats(
  filePaths: string[]
): Promise<AttemptedReferralUsageEvent[]> {
  let parsed = 0;
  let skipped = 0;
  const byRequestId = new Map<string, AttemptedReferralUsageEvent>();

  for (const p of filePaths) {
    const raw = await readFile(p, 'utf8');
    const jsonUnknown: unknown = JSON.parse(raw);
    const wrapper = wrapperSchema.safeParse(jsonUnknown);
    if (!wrapper.success) {
      const msg = wrapper.error.flatten();
      throw new Error(
        `Invalid input JSON: expected an object with matches[]. Errors: ${JSON.stringify(
          msg,
          null,
          2
        )}`
      );
    }

    for (const m of wrapper.data.matches) {
      const { data, success } = attemptedReferralDataSchema.safeParse(m.data);
      if (!success) {
        skipped++;
        continue;
      }

      const referralCode = extractReferralCodeFromPath(data['request.path']);
      if (!referralCode) {
        skipped++;
        continue;
      }

      // Count entries that are well-formed and contain a referral-code param (before dedupe)
      parsed++;

      byRequestId.set(data['request.id'], {
        eventTime: new Date(m._time),
        ip: data['request.ip'],
        userAgent: data['request.userAgent'],
        referralCode,
        requestId: data['request.id'],
      });
    }
  }
  const events = Array.from(byRequestId.values());

  console.log(`Skipped: ${skipped}`);
  console.log(`Parsed (before dedupe): ${parsed}`);
  console.log(`Deduped: ${events.length}`);

  return events;
}

async function parseReferredUserNotLoggedEvents(): Promise<ReferredUserNotLoggedEvent[]> {
  const jsonText = await readFile(referredPath, 'utf8');

  const jsonUnknown: unknown = JSON.parse(jsonText);

  const wrapper = wrapperSchema.safeParse(jsonUnknown);
  if (!wrapper.success) {
    const msg = wrapper.error.flatten();
    throw new Error(
      `Invalid input JSON: expected an object with matches[]. Errors: ${JSON.stringify(
        msg,
        null,
        2
      )}`
    );
  }

  let skipped = 0;
  const referredButUnlogged: ReferredUserNotLoggedEvent[] = [];

  for (const m of wrapper.data.matches) {
    const { data, success } = referredUserNotLoggedDataSchema.safeParse(m.data);
    if (!success) {
      skipped++;
      continue;
    }

    const userId = data.message.match(USER_ID_REGEX)?.[1]?.trim();
    if (!userId) {
      skipped++;
      continue;
    }

    referredButUnlogged.push({
      eventTime: new Date(m._time),
      referred_kilo_user_id: userId,
      ip: data['request.ip'],
      userAgent: data['request.userAgent'],
      requestId: data['request.id'],
    });
  }
  console.log(`Parsed: ${referredButUnlogged.length}`);
  console.log(`Skipped: ${skipped}`);
  return referredButUnlogged;
}

const applyMode = process.argv.includes('--apply');
async function getReferrerUserFromDb(cand?: AttemptedReferralUsageEvent | null) {
  if (!cand) return null;
  const refCodeRecord = await db.query.referral_codes.findFirst({
    where: eq(referral_codes.code, cand.referralCode),
    columns: { kilo_user_id: true },
  });
  if (!refCodeRecord) return null;
  return await findUserById(refCodeRecord.kilo_user_id);
}

async function getFirstTopUpIfExists(kilo_user_id: string) {
  const firstTopupRows = await db
    .select({ created_at: credit_transactions.created_at })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, kilo_user_id),
        eq(credit_transactions.is_free, false),
        gt(credit_transactions.amount_microdollars, 0),
        isNull(credit_transactions.organization_id)
      )
    )
    .orderBy(credit_transactions.created_at)
    .limit(1);
  return firstTopupRows[0] ?? null;
}

const keyOf = (ip: string, ua: string) => `${ip}||${ua}`;

const referredPath = '/Users/eamonnerbonne/Downloads/http-requests-with-referral-code.json';
const attemptPaths = [
  '/Users/eamonnerbonne/Downloads/attempted-referrals-until-aug14.json',
  '/Users/eamonnerbonne/Downloads/attempted-referrals-after-aug14.json',
];

async function getSortedRedemptionReferralPairs() {
  // Unified single-pass mode. Side-effects controlled solely by --apply (applyMode).

  const referredButUnlogged = await parseReferredUserNotLoggedEvents();

  const failedRedemptionEvents = await parseAttemptedReferralUsageEventsWithStats(attemptPaths);

  // Common index for subsequent steps
  const failedRedemptionsByKey = Map.groupBy(failedRedemptionEvents, ev =>
    keyOf(ev.ip, ev.userAgent)
  );
  const failedRedemptionsUA = Map.groupBy(failedRedemptionEvents, ev => ev.userAgent);

  // Retained across steps
  // Step 3 — compute best/second-best (unordered), no logging
  return referredButUnlogged
    .map(referredEvent => {
      const redemptionMs = referredEvent.eventTime.getTime();

      const codeUsages =
        failedRedemptionsByKey.get(keyOf(referredEvent.ip, referredEvent.userAgent)) ?? [];

      const bestUsagesFirst = codeUsages
        .map(usage => ({
          usage,
          deltaMs: redemptionMs - usage.eventTime.getTime(),
          ipMatch: true,
        }))
        .filter(usage => Math.abs(usage.deltaMs) < 1000000)
        .sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));

      const fallbackUsages =
        bestUsagesFirst.length >= 2
          ? []
          : (failedRedemptionsUA.get(referredEvent.userAgent) ?? [])
              .map(usage => ({
                usage,
                deltaMs: redemptionMs - usage.eventTime.getTime(),
                ipMatch: false,
              }))
              .filter(o => o.deltaMs >= 0 && o.deltaMs <= 5 * 60 * 1000)
              .sort((a, b) => a.deltaMs - b.deltaMs);

      bestUsagesFirst.push(...fallbackUsages);

      return {
        referredEvent,
        matches: bestUsagesFirst.slice(0, 2),
      };
    })
    .sort((a, b) => {
      const ad =
        Math.abs(a.matches.at(0)?.deltaMs ?? Number.MAX_SAFE_INTEGER) +
        (a.matches.at(0)?.ipMatch ? 0 : 10_000_000);

      const bd =
        Math.abs(b.matches.at(0)?.deltaMs ?? Number.MAX_SAFE_INTEGER) +
        (b.matches.at(0)?.ipMatch ? 0 : 10_000_000);

      return ad !== bd
        ? ad - bd
        : a.referredEvent.referred_kilo_user_id.localeCompare(
            b.referredEvent.referred_kilo_user_id
          );
    });
}

async function run(): Promise<void> {
  console.log(`mode: ${applyMode ? 'apply' : 'dry-run'}`);

  const bestPairs = await getSortedRedemptionReferralPairs();

  console.log(
    'referringUserId,referringUserEmail,referralCode,ipMatch,referredUserId,referredUserEmail,dbReferredUserExists,failedReferralEventTime,referralCodeEventTime,deltaMs,secondBestReferralCode,secondBestReferralCodeEventTime,deltaMsSecondBest,dbUsageExists,topupFound,referrerCreditGranted,referredCreditGranted,paidAtSet'
  );

  const totalEvaluated = bestPairs.length;
  let totalEligible = 0;
  const skippedReasons = new Map<string, number>();
  const incReason = (r: string) => skippedReasons.set(r, (skippedReasons.get(r) ?? 0) + 1);

  for (const bp of bestPairs) {
    const referred = bp.referredEvent;
    const bestMatch = bp.matches.at(0);
    const bestCodeUsage = bestMatch?.usage ?? null;
    const referringUser = await getReferrerUserFromDb(bestCodeUsage);

    // Fetch usage incl paid_at
    const preexistingReferralCodeUsage =
      !bestCodeUsage || !referringUser
        ? null
        : ((
            await db
              .select({ id: referral_code_usages.id, paid_at: referral_code_usages.paid_at })
              .from(referral_code_usages)
              .where(
                and(
                  eq(referral_code_usages.code, bestCodeUsage.referralCode),
                  eq(referral_code_usages.redeeming_kilo_user_id, referred.referred_kilo_user_id),
                  eq(referral_code_usages.referring_kilo_user_id, referringUser?.id)
                )
              )
              .limit(1)
          )[0] ?? null);

    const referralCodeUsageAlreadyExists = !!preexistingReferralCodeUsage;
    const referredUser = await findUserById(referred.referred_kilo_user_id);
    const second = bp.matches.at(1);
    const firstTopup = await getFirstTopUpIfExists(referred.referred_kilo_user_id);
    totalEligible += firstTopup ? 1 : 0;

    let referrerCreditGranted: 'granted' | 'already' | 'skipped' | 'no_topUp' | 'n/a' = 'n/a';
    let referredCreditGranted: 'granted' | 'already' | 'skipped' | 'no_topUp' | 'n/a' = 'n/a';
    let paidAtSet: 'set' | 'already' | 'skipped' | 'no_topUp' = 'skipped';

    if (!bestCodeUsage) {
      incReason('no-match');
    } else if (!referringUser) {
      incReason('missing-referrer');
    } else if (!referredUser) {
      incReason('missing-referred');
    } else {
      if (!referralCodeUsageAlreadyExists) {
        paidAtSet = firstTopup?.created_at ? 'set' : 'no_topUp';
        if (applyMode) {
          await db.insert(user_admin_notes).values({
            kilo_user_id: referred.referred_kilo_user_id,
            note_content: `Implicitly determined referral (https://github.com/Kilo-Org/kilocode-backend/issues/2284); deltaMs:${bestMatch?.deltaMs}; ipMatch:${bestMatch?.ipMatch}; referrer:${referringUser?.id}`,
          });

          await db
            .insert(referral_code_usages)
            .values({
              referring_kilo_user_id: referringUser?.id,
              redeeming_kilo_user_id: referred.referred_kilo_user_id,
              code: bestCodeUsage.referralCode,
              paid_at: firstTopup?.created_at,
              created_at: bestCodeUsage.eventTime.toISOString(),
            })
            .onConflictDoNothing({
              target: [
                referral_code_usages.redeeming_kilo_user_id,
                referral_code_usages.referring_kilo_user_id,
              ],
            });
        }
      }

      // Referrer grant
      const expectedMessage = `Referral bonus for referring user ${referred.referred_kilo_user_id} with code ${bestCodeUsage.referralCode}`;
      const referrerAlready =
        (
          await db
            .select({ id: credit_transactions.id })
            .from(credit_transactions)
            .where(
              and(
                eq(credit_transactions.kilo_user_id, referringUser?.id),
                eq(credit_transactions.credit_category, referralReferringBonus.credit_category),
                eq(credit_transactions.description, expectedMessage)
              )
            )
            .limit(1)
        ).length > 0;
      if (referrerAlready) {
        referrerCreditGranted = 'already';
      } else if (!firstTopup) {
        referrerCreditGranted = 'no_topUp';
      } else if (!referringUser || !firstTopup) {
        referrerCreditGranted = 'skipped';
      } else {
        const res = applyMode
          ? await grantCreditForCategory(referringUser, {
              credit_category: referralReferringBonus.credit_category,
              counts_as_selfservice: false,
              description: expectedMessage,
            })
          : successResult();
        referrerCreditGranted = res.success ? 'granted' : 'skipped';
      }

      // Referred grant
      const expectedMessage2 = `Referral bonus for redeeming code ${bestCodeUsage.referralCode}`;
      const referredAlready =
        (
          await db
            .select({ id: credit_transactions.id })
            .from(credit_transactions)
            .where(
              and(
                eq(credit_transactions.kilo_user_id, referred.referred_kilo_user_id),
                eq(credit_transactions.credit_category, referralRedeemingBonus.credit_category)
              )
            )
            .limit(1)
        ).length > 0;
      if (referredAlready) {
        referredCreditGranted = 'already';
      } else if (!referredUser) {
        referredCreditGranted = 'skipped';
      } else if (!firstTopup) {
        referredCreditGranted = 'no_topUp';
      } else {
        const { success } = applyMode
          ? await grantCreditForCategory(referredUser, {
              credit_category: referralRedeemingBonus.credit_category,
              counts_as_selfservice: false,
              description: expectedMessage2,
            })
          : successResult();

        referredCreditGranted = success ? 'granted' : 'skipped';
      }

      // paid_at update
      if (preexistingReferralCodeUsage?.paid_at) {
        paidAtSet = 'already';
      } else if (!firstTopup?.created_at) {
        paidAtSet = 'no_topUp';
        incReason('no_paid_at_source');
      } else if (preexistingReferralCodeUsage) {
        const updated = !applyMode
          ? [{ code: bestCodeUsage.referralCode }]
          : await db
              .update(referral_code_usages)
              .set({ paid_at: firstTopup.created_at })
              .where(
                and(
                  eq(referral_code_usages.code, bestCodeUsage.referralCode),
                  eq(referral_code_usages.redeeming_kilo_user_id, referred.referred_kilo_user_id),
                  eq(referral_code_usages.referring_kilo_user_id, referringUser?.id),
                  isNull(referral_code_usages.paid_at)
                )
              )
              .returning({ code: referral_code_usages.code });
        paidAtSet = updated.length > 0 ? 'set' : 'skipped';
      }
    }

    // referringUserId,referringUserEmail,referralCode,ipMatch,referredUserId,referredUserEmail,dbReferredUserExists,failedReferralEventTime,referralCodeEventTime,deltaMs,secondBestReferralCode,secondBestReferralCodeEventTime,deltaMsSecondBest,dbUsageExists,topupFound,referrerCreditGranted,referredCreditGranted,paidAtSet'

    console.log(
      [
        referringUser?.id ?? '',
        referringUser?.google_user_email ?? '',
        bestCodeUsage?.referralCode ?? '',
        bestMatch?.ipMatch ?? '',
        referred.referred_kilo_user_id,
        referredUser?.google_user_email ?? '',
        String(!!referredUser),
        referred.eventTime.toISOString(),
        bestCodeUsage?.eventTime.toISOString() ?? '',
        String(bestMatch?.deltaMs ?? ''),
        second?.usage.referralCode ?? '',
        second?.usage.eventTime.toISOString() ?? '',
        String(second?.deltaMs ?? ''),
        String(referralCodeUsageAlreadyExists),
        String(!!firstTopup),
        referrerCreditGranted,
        referredCreditGranted,
        paidAtSet,
      ].join(',')
    );
  }

  console.log(`Totals: totalEvaluated=${totalEvaluated}, totalEligible=${totalEligible}`);
  if (skippedReasons.size > 0) {
    const byReason = Array.from(skippedReasons.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(`Skipped by reason: ${byReason}`);
  }

  await closeAllDrizzleConnections();
}

void run()
  .then(() => {
    console.log(`Script completed successfully; mode: ${applyMode ? 'apply' : 'dry-run'}`);
    process.exit(0);
  })
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
