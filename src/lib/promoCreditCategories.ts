import 'server-only';
import type {
  PromoCreditCategoryConfig,
  SelfServicePromoCreditCategoryConfig,
  NonSelfServicePromoCreditCategoryConfig,
} from './PromoCreditCategoryConfig';
import {
  FIRST_TOPUP_BONUS_AMOUNT,
  REFERRAL_BONUS_AMOUNT,
  PROMO_CREDIT_EXPIRY_HRS,
} from '@/lib/constants';
import { promoCategoriesOld } from '@/lib/promoCreditCategoriesOld';
import {
  has_githubAuth,
  has_githubAuthAndWelcomeCredits,
  has_holdOrPayment,
  has_Payment,
  has_stytchApprovedOrHoldOrPayment,
  has_used1usd_andHoldOrPayment,
} from './promoCustomerRequirement';
import { team_topup_bonus_requirement } from './organizations/organizationRequirement';
import { decryptPromoCode } from './promoCreditEncryption';

/**
 * Type for encrypted self-service promo configuration.
 * The `encrypted_credit_category` field contains the AES-256-GCM encrypted promo code.
 * At runtime, this is decrypted to produce the actual `credit_category` value.
 */
type EncryptedSelfServicePromoCreditCategoryConfig = Omit<
  SelfServicePromoCreditCategoryConfig,
  'credit_category'
> & {
  encrypted_credit_category: string;
};

const adminUI_goodwill_promoCodes: readonly (PromoCreditCategoryConfig &
  Required<Pick<PromoCreditCategoryConfig, 'adminUI_label'>>)[] = [
  {
    credit_category: 'manual_decrement',
    adminUI_label: 'Manually Decrement Credits',
    expect_negative_amount: true,
    is_idempotent: false,
  },
  {
    credit_category: 'influencer',
    adminUI_label: '$200 - Influencer',
    amount_usd: 200,
    description: 'Promotional credit for influencer',
  },
  {
    credit_category: 'usage_issue',
    adminUI_label: '$100-500 - Usage Issue',
    amount_usd: 100,
    description: 'Credit for usage issue compensation',
  },
  {
    credit_category: 'pull_request',
    adminUI_label: '$100 - Pull Request',
    amount_usd: 100,
    description: 'Credit for meaningful pull request',
  },
  {
    credit_category: 'vibeday',
    adminUI_label: '$50 - Vibe Eng Day reply',
    amount_usd: 50,
    description: 'Credit for vibe eng day reply',
  },
  {
    credit_category: 'feedback',
    adminUI_label: '$30 - Feedback/Interview',
    amount_usd: 30,
    description: 'Credit for great feedback or user interview',
  },
  {
    credit_category: 'referral',
    adminUI_label: `$${REFERRAL_BONUS_AMOUNT} - Referral/Review`,
    amount_usd: REFERRAL_BONUS_AMOUNT,
    description: 'Credit for referral or review',
  },
  {
    credit_category: 'custom',
    adminUI_label: '$$$ - Custom',
    is_idempotent: false,
  },
] as const;

export const referralReferringBonus = {
  credit_category: 'referral-referring-bonus',
  description: 'Referral bonus for users who refer others',
  amount_usd: REFERRAL_BONUS_AMOUNT,
  is_idempotent: false,
};

export const referralRedeemingBonus = {
  credit_category: 'referral-redeeming-bonus',
  description: 'Referral bonus for users who redeem referral codes',
  amount_usd: REFERRAL_BONUS_AMOUNT,
  // can only ever redeem 1 referral code
  is_idempotent: true,
};

const nonSelfServicePromos: readonly NonSelfServicePromoCreditCategoryConfig[] = [
  // Kilo Pass issuance bonuses and promos.
  // These are not user self-service codes; they are created by backend flows.
  {
    credit_category: 'kilo-pass-bonus',
    description: 'Kilo Pass bonus credits',
    is_idempotent: false,
  },
  // Admin bulk credit grant
  {
    credit_category: 'admin-bulk-grant',
    description: 'Admin bulk credit grant to personal accounts',
    is_idempotent: false,
  },
  // OSS Sponsorship Program credits
  {
    credit_category: 'oss-sponsorship',
    description: 'OSS Sponsorship Program initial credits',
    is_idempotent: false,
  },
  {
    credit_category: 'oss-monthly-reset',
    description: 'OSS Sponsorship Program monthly credit reset',
    is_idempotent: false,
  },
  {
    credit_category: 'kilo-pass-first-month-50pct',
    description: 'Kilo Pass first month 50% promo credits',
    is_idempotent: false,
  },
  {
    credit_category: 'auto-top-up-promo-2025-12-19',
    description: 'Auto top up promo',
    expiry_hours: PROMO_CREDIT_EXPIRY_HRS,
    is_idempotent: true,
    total_redemptions_allowed: 200,
    amount_usd: 20,
  },
  {
    credit_category: 'team-topup-bonus-2025',
    description: 'Team top-up bonus: $20 extra when you have team members',
    amount_usd: 20,
    is_idempotent: true,
    expiry_hours: undefined,
    organization_requirement: team_topup_bonus_requirement,
  },
  {
    credit_category: 'github-promo-2025-07-03',
    is_idempotent: true,
    amount_usd: 100,
    description: 'Vibe Eng 2025-07-03',
  },
  {
    credit_category: 'windsurf-promo-2025-07-12',
    is_idempotent: true,
    amount_usd: 100,
    description: 'Windsurf promo 2025-07-12',
  },
  {
    credit_category: 'temp-stytch-1usd-fix',
    is_idempotent: true,
    amount_usd: 5,
    description: 'temp stytch 1usd fix',
  },
  {
    credit_category: 'tempfix-stytch-bug-27-jun-2025',
    is_idempotent: true,
    amount_usd: 5,
    description: 'temp fix for stytch 1usd bug',
  },
  {
    credit_category: 'automatic-welcome-credits',
    description: 'Free credits for new users who pass both Turnstile and Stytch validation',
    amount_usd: 5,
    is_idempotent: true,
    expiry_hours: PROMO_CREDIT_EXPIRY_HRS,
  },
  {
    credit_category: 'autocomplete-rollout-2025-11',
    description: 'Autocomplete feature rollout - $1 credit with 30 day expiry',
    amount_usd: 1,
    is_idempotent: true,
    expiry_hours: 30 * 24,
  },

  {
    credit_category: 'payment-tripled',
    is_idempotent: false,
    amount_usd: 30,
    description: 'Automatically tripled payment as part of Vibe Coding Thursday 26 June',
  },
  {
    credit_category: 'payment-tripled-starting-2025-07-05',
    is_idempotent: false,
    amount_usd: 30,
    description: 'Tripled payment as part of an anti-Cursor promo',
  },
  {
    credit_category: 'in-app-5usd',
    is_idempotent: true,
    customer_requirement: has_used1usd_andHoldOrPayment,
    amount_usd: 5,
    description:
      'In-app promotional credit for users who have used $1 and have a hold or payment method',
  },
  {
    credit_category: 'github-superstars-100-usd',
    is_idempotent: true,
    amount_usd: 100,
    description: 'Issuing $100 to sign ups with popular GitHub projects',
  },
  {
    credit_category: 'newsletter',
    is_idempotent: true,
    amount_usd: 10,
    description: 'Users who read our newsletter in detail',
    total_redemptions_allowed: 2000,
  },
  {
    credit_category: 'XCURSOR-W92X91',
    is_idempotent: true,
    amount_usd: 100,
    customer_requirement: has_holdOrPayment,
    promotion_ends_at: new Date('2025-07-20'),
    description: 'Cursor promo 2025-07-17',
    total_redemptions_allowed: 1000,
  },
  {
    credit_category: 'XCURSOR-REF-W92X91',
    is_idempotent: true,
    amount_usd: 100,
    customer_requirement: has_holdOrPayment,
    promotion_ends_at: new Date('2025-07-20'),
    description: 'Cursor promo 2025-07-17 (referral)',
    total_redemptions_allowed: 1000,
  },
  {
    credit_category: '20-usd-after-first-top-up',
    amount_usd: 20,
    description: 'Bonus for users who top up for the first time',
    expiry_hours: PROMO_CREDIT_EXPIRY_HRS,
    is_idempotent: true,
  },
  {
    //NOTE: the intent is to never grant both bonus-multiplier-top-up and 20-usd-after-first-top-up based off one payment.
    //ref: https://kilo-code.slack.com/archives/C092HV3AHDE/p1752928737222359
    credit_category: 'bonus-multiplier-top-up',
    description: 'Free-credits on top of paid top up',
    expiry_hours: 30 * 24,
  },
  {
    credit_category: 'fibonacci-topup-bonus',
    description: 'Fibonacci bonus for topup - Vibe Thursday 2025-07-22',
    expiry_hours: 30 * 24,
    is_idempotent: false,
  },
  {
    credit_category: 'first-topup-bonus',
    description: `First top-up bonus - $${FIRST_TOPUP_BONUS_AMOUNT()} credit`,
    amount_usd: FIRST_TOPUP_BONUS_AMOUNT(),
    expiry_hours: PROMO_CREDIT_EXPIRY_HRS,
    is_idempotent: true,
  },
  {
    credit_category: 'non-card-payment-promotion',
    description: 'Bonus for using a non-card payment method',
    expiry_hours: 30 * 24,
    is_idempotent: false,
  },
  referralRedeemingBonus,
  referralReferringBonus,
  {
    credit_category: 'github-star-incentive-2025sept',
    description: 'Participated in the github star promo',
    expiry_hours: 30 * 24,
    amount_usd: 1,
    is_idempotent: true,
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
  },
  {
    credit_category: 'orb_migration_accounting_adjustment',
    description: 'Adjustment for Orb migration accounting discrepancies',
    is_idempotent: true,
  },
  {
    credit_category: 'orb_manual_decrement',
    description: 'Manual decrement from Orb ledger',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'orb_credit_expired',
    description: 'Credit expiration from Orb system',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'orb_credit_voided',
    description: 'Credit voided from Orb system',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'credits_expired',
    description: 'Local credit expiration',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'organization_custom',
    description: 'Custom credit grant for organization',
    is_idempotent: false,
  },
];

/**
 * Encrypted self-service promo configurations.
 * The `encrypted_credit_category` field contains an AES-256-GCM encrypted promo code.
 * These are decrypted at runtime to build the actual selfServicePromos array.
 *
 * To add a new promo code:
 * 1. Run: pnpm promo encrypt PROMO_CODE
 * 2. Copy the encrypted value and use in encrypted_credit_category
 */
const encryptedSelfServicePromos: readonly EncryptedSelfServicePromoCreditCategoryConfig[] = [
  {
    encrypted_credit_category: 'DMAB+J9SP5P7rxN19iajXg==:l+/sU/o65wg/imvGdNPCTg==:SlcbjsV0',
    description: 'GitHub incentive',
    expiry_hours: 30 * 24,
    amount_usd: 5,
    is_user_selfservicable: true,
    is_idempotent: true,
    total_redemptions_allowed: 5_000,
    customer_requirement: has_githubAuth,
    promotion_ends_at: new Date('2025-11-07'),
  },
  {
    encrypted_credit_category: 'xg/r5QNfg/b2Hbvpgzsr/A==:8AzfSaWcIKnZEzbFr0Vraw==:XOdYcdPeoA==',
    description: 'Celebrating Kilo Code reaching 10k GitHub stars',
    expiry_hours: 60 * 24,
    amount_usd: 10,
    is_user_selfservicable: true,
    is_idempotent: true,
    total_redemptions_allowed: 5_000,
    customer_requirement: has_githubAuthAndWelcomeCredits,
    promotion_ends_at: new Date('2025-09-25'),
  },
  {
    encrypted_credit_category: 'mIm3nTc3wgDDq4YXZQp9ZA==:h5otxBPI32TG17ZtBIxI3g==:HDCcgZYZR/s=',
    description: 'Participated in live SF event with Alex, Olesya & Chris 2025-09-11',
    expiry_hours: 14 * 24,
    amount_usd: 20,
    is_user_selfservicable: true,
    is_idempotent: true,
    total_redemptions_allowed: 100,
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
    promotion_ends_at: new Date('2025-09-12T07:00Z'),
  },
  {
    encrypted_credit_category:
      '14Zfp5JfOOVUNq606Njbdw==:4jEDTrK5ROcDfK/oekr+rw==:GzmFKDBtooQJNFUaMnEvvg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 13.37,
    description: 'Promo for small influencer',
    promotion_ends_at: new Date('2025-08-31T23:59:59Z'),
    total_redemptions_allowed: 300,
  },
  {
    // ref: https://kilo-code.slack.com/archives/C08HFNY5457/p1753805417217909?thread_ts=1753802681.932019&cid=C08HFNY5457
    encrypted_credit_category: '4OXLJK+RolYrVlh4NdddqA==:w+wVzlDFjLCoDNTueeY/1w==:z86VakX2rzhPF/lr',
    description: 'Welcome back for previous payers who churned',
    is_user_selfservicable: true,
    amount_usd: 20,
    is_idempotent: true,
    expiry_hours: 30 * 24,
    total_redemptions_allowed: 5000,
    customer_requirement: has_used1usd_andHoldOrPayment, // ref: https://kilo-code.slack.com/archives/C08H16KGBUK/p1753874625951609
  },
  {
    encrypted_credit_category: 'FEZhjS28hWE20Pam4lVuiA==:xPVmp+fZVKYZV7YYh1cKsw==:HLP+lBdBivdM',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-14T00:00:00Z'),
    total_redemptions_allowed: 2000,
    promotion_ends_at: new Date('2025-08-01T00:00:00Z'),
  },
  {
    encrypted_credit_category: 'Dgm1duM/IXukF1ByEAEpQg==:ekQ7a5iHFaxG9oza+pyV3w==:gLGJhyFAxGw=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-20T00:00:00Z'),
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-07T03:00:00Z'),
  },
  {
    encrypted_credit_category: 'UqYUabCOrhX1QFq/1NpPDw==:Pw/kEurVK5h7Fj2BsjdoFg==:DSFcufScJ1A=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    expiry_hours: 24 * 14,
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-16T03:00:00Z'),
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
  },
  {
    encrypted_credit_category: 'dPwhggUz8RFJ1lZC/zi4oA==:rI7KH1nByxtT0IXpIdpo0g==:6nfc9Hdr9jg=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    expiry_hours: 24 * 14,
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-23T03:00:00Z'),
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
  },
  {
    encrypted_credit_category: 'CcBSaURLI/q62XjKkZ4LCw==:VFkIgLXXF7hkx74cYVBqLw==:HXY4CHhyxw==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 48,
    expiry_hours: 48,
    total_redemptions_allowed: 2012,
    promotion_ends_at: new Date('2025-08-08T03:00:00Z'),
  },
  {
    encrypted_credit_category:
      'GfQV0ooPWb7fumMTuhv2zQ==:WGlFbxgEaKegUfCpfGLvCw==:TkSVHWVgx3TASGtmWw==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 48,
    expiry_hours: 96,
    total_redemptions_allowed: 2000,
    customer_requirement: has_Payment,
    promotion_ends_at: new Date('2025-10-05T13:30:00Z'),
  },
  // Reactivated Nov 2025. Moved from promoCreditCategoriesOld.ts back to active
  // status since Theo specifically mentioned the code "REDACTED" in his latest video.
  {
    encrypted_credit_category: '7qXpqKvmKRScbtWtzyD1kA==:HI8gJUO6O/qwLyZNUjKqJA==:wT/7+g==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 13.37,
    promotion_ends_at: new Date('2026-06-01'),
    description: 'Influencer: Theo T3',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  // Creator promo codes - January 2026
  {
    encrypted_credit_category: '4aVd/vjpEbMGLJoEa55KOg==:hGSGXu8otdmUkX2d2nDJOQ==:F2zk8g==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: mori',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '9JwWBUyTj3/V/wx/Q2j9bw==:DQnC1IfP3ul3+XAkT7vQcQ==:clDQK9yYOg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Anthony Sistilli',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'D4pK6ddWXZIZKzLLAlFjIw==:AxeKVJ2ddJ2GtZKgDWigtw==:CrLtOw==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: pikacodes',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'JNUpAZEOIub4CrXKhMIIRw==:mNDvThJWHcOOD7driWhsqA==:CtytDNmr',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Moritz | AI Builder',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'D9KdkuVIeM0v+gfWhkYAUQ==:/fMdCDsc6//Kzgr224xS5Q==:fJUhsg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Nate Gold | AI Builder',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'NgNNcWcgnZ/0BvkQUXdiSA==:rG3ZRS78dIk/RidG8qFjIA==:oCdK1w==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: tiny_kiri',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'dDJQHG/ZF4zBEJFH8Dm7gA==:/OPvKUpk0WsHOp1yd9U0zQ==:+3jkN7n/',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Alvaro Cintas',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'T4mrIarsnjUH+d1mHyYLig==:qMVRwrfu0jwYaERsj03taQ==:5zC0ai1mrA==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: kortexy.ai',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'bUBH/KYgjDUDCAmsisO6gA==:os23+PKf/+ylzZrRIdTrMw==:aTjfaaFT',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Sam | AI Tools & Tech',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'Lv/n+j5FHRWZbFkUmiNWVg==:KW9t+ff7f1GIYjpJc7ygFw==:s43cvUA=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Mehul Mohan',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'DmCrimPb2V4wgkVbsNf0HQ==:lxbOSsz1m8Q8rjIugY09GA==:j/zWkOA=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Daily AI Digest',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'WYiw0GGnTc4IkH85VQlpOg==:OAcEL5bCRN7F5fbA50Mg6A==:+HldhiRr',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Emilie Valentine Experiment',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'C3wdUIGcWvHqGKkb+S1caw==:y0x+2EPqORv/Cj/0iJRAoQ==:8mc/1wDaNo0=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 13.37,
    promotion_ends_at: new Date('2025-09-20'),
    description: 'Influencer: Theo T3',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category:
      'dXWYTW0RN46CrqbYrC5R/Q==:r4lcZrq8nbBLVHx79tDP6A==:nmfM5TVjuJ9nqo2UWd/5',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    promotion_ends_at: new Date('2025-07-30'), //i.e. active on july 29th
    description: 'Hackathon: Power of Europe Amsterdam 2025',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: 'Hsa2A3AMnO9WALOpOUgShg==:QeOJcNa5uVzCEf6rzz5/qg==:/TJ9IpdtDw==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-01T00:00:00Z'),
    total_redemptions_allowed: 2000,
    promotion_ends_at: new Date('2025-07-12T00:00:00Z'),
  },
  {
    encrypted_credit_category: '8EgpuUwFg4M7Eer29TzJOQ==:VoVZ8nv07naqbLkF3LPFHw==:yWjPs94wmGI=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 5,
    customer_requirement: has_holdOrPayment,
    promotion_ends_at: new Date('2025-06-21'),
    description: 'Vibe-Code Thursday 2025-06-19',
    total_redemptions_allowed: 1000,
  },
  {
    encrypted_credit_category:
      'R6Xhw26/Yqlfbs/9OQqeVA==:9xYRMemIYt8kEK7bBGqYCQ==:/KC7MXLRNmATMH8Y5WQ=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2025-11-25'),
    description: 'Conference $20 promotional credit',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: 'xdmWWjmAONcAvH3BH7i5Tw==:ScHtinC8BbZ70KYeswSbsQ==:wWSH6jFnouY7YHgV',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2025-11-25'),
    description: 'Conference $20 promotional credit',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: 'rUz27MDgRmqf1gHHX+/Zbw==:GW4ojyf9ENrTCKHw31xUcA==:oTGF49ieP0peAQ==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    promotion_ends_at: new Date('2026-02-20'),
    description: 'Promo code for Solveo candidates/team expansion',
    total_redemptions_allowed: 20,
  },
  {
    encrypted_credit_category:
      'AGBh1ht9Ae9xm358inZC4A==:82DdufHKhw6kMS2KTtlJpw==:TiBmyJMaGtk2K/A9ELFQ0I7MIrG8kog=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2026-02-15'),
    description: 'Builders event promotional credit',
    total_redemptions_allowed: 200,
  },
];

const selfServicePromos: readonly SelfServicePromoCreditCategoryConfig[] =
  encryptedSelfServicePromos.map(
    ({ encrypted_credit_category, ...rest }): SelfServicePromoCreditCategoryConfig => ({
      ...rest,
      credit_category: decryptPromoCode(encrypted_credit_category),
    })
  );

export const promoCreditCategories: readonly PromoCreditCategoryConfig[] = [
  ...promoCategoriesOld,
  ...adminUI_goodwill_promoCodes,
  ...selfServicePromos,
  ...nonSelfServicePromos,
] as const;

export const promoCreditCategoriesByKey = new Map<string, PromoCreditCategoryConfig>(
  promoCreditCategories.map(category => [category.credit_category, category])
);
