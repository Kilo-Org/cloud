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
  OPENCLAW_SECURITY_ADVISOR_BONUS_EXPIRY_HRS,
} from '@/lib/constants';
import { promoCategoriesOld } from '@/lib/promoCreditCategoriesOld';
import {
  created_before,
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
  // Sales demo organization credits
  {
    credit_category: 'sales-demo',
    description: 'Sales demo organization credits',
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
    credit_category: 'openclaw-security-advisor-signup-bonus',
    description: 'Bonus for new users signing up via the OpenClaw Security Advisor plugin',
    amount_usd: 7.13,
    is_idempotent: true,
    expiry_hours: OPENCLAW_SECURITY_ADVISOR_BONUS_EXPIRY_HRS,
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
    amount_usd: 0,
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
    description: `First top-up bonus - $${FIRST_TOPUP_BONUS_AMOUNT} credit`,
    amount_usd: FIRST_TOPUP_BONUS_AMOUNT,
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
    credit_category: 'admin-cancel-refund-kilo-pass',
    description: 'Balance zeroed by admin during Kilo Pass cancellation and refund',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'admin-cancel-kilo-pass-no-refund',
    description: 'Balance zeroed by admin during Kilo Pass cancellation without refund',
    is_idempotent: false,
    expect_negative_amount: true,
  },
  {
    credit_category: 'organization_custom',
    description: 'Custom credit grant for organization',
    is_idempotent: false,
  },
  {
    credit_category: 'contributor-champion-credits',
    description: 'Contributor Champion monthly credits',
    is_idempotent: false,
    expiry_hours: 30 * 24,
  },
];

/**
 * Encrypted self-service promo configurations.
 * The `encrypted_credit_category` field contains an AES-256-GCM encrypted promo code.
 * These are decrypted at runtime to build the actual selfServicePromos array.
 *
 * To add a new promo code:
 * 1. Run: vercel env run -e production -- pnpm promo encrypt PROMO_CODE
 * 2. Copy the encrypted value and use in encrypted_credit_category
 */
const encryptedSelfServicePromos: readonly EncryptedSelfServicePromoCreditCategoryConfig[] = [
  {
    encrypted_credit_category: 'npRJk1O/OkLHSao8YUh5fg==:w6gQihplxtmmrFgLROaY6g==:FEFfQAn6VUeOxKat',
    description: 'Friday promo',
    expiry_hours: 60 * 24,
    amount_usd: 5,
    is_user_selfservicable: true,
    total_redemptions_allowed: 5_000,
    is_idempotent: true,
    promotion_ends_at: new Date('2026-04-17T23:59:59Z'),
  },
  {
    encrypted_credit_category: 'v7CwlWTk0QZXn7ab6xZCeQ==:MtXTBCed7YTfzkYYzEGEzg==:OZD48zJh',
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
    encrypted_credit_category: 'eHrsSFTqVjP1/7WSuaK07g==:DYSgjmZfj5PeyPTXyIGRpw==:Tp9rLHQNqg==',
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
    encrypted_credit_category: 'xmq91nXGdp/Gz4Avnza8Sw==:c7q2di4MLBydN+2uNB0j7g==:MjcxI1eyUE8=',
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
      '9TtQ1++USjC2fKWITqU/yw==:gsvVnfK4kRmS36vdDSAUvA==:5yEWieNypMzZh5i2yuo0pQ==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 13.37,
    description: 'Promo for small influencer',
    promotion_ends_at: new Date('2025-08-31T23:59:59Z'),
    total_redemptions_allowed: 300,
  },
  {
    // ref: https://kilo-code.slack.com/archives/C08HFNY5457/p1753805417217909?thread_ts=1753802681.932019&cid=C08HFNY5457
    encrypted_credit_category: 'vXY/Q5ONiXCV5qWizOY/ug==:9RUiwrE9D0RFXF8Wdsm3Bw==:Vbi/AbyFNly+2nc8',
    description: 'Welcome back for previous payers who churned',
    is_user_selfservicable: true,
    amount_usd: 20,
    is_idempotent: true,
    expiry_hours: 30 * 24,
    total_redemptions_allowed: 5000,
    customer_requirement: has_used1usd_andHoldOrPayment, // ref: https://kilo-code.slack.com/archives/C08H16KGBUK/p1753874625951609
  },
  {
    encrypted_credit_category: 'vu9Vd/guKd8N5rxWrBOHXQ==:tM3iW5pSdbUzScAoVWp/rA==:7YMUVtW/TME1',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-14T00:00:00Z'),
    total_redemptions_allowed: 2000,
    promotion_ends_at: new Date('2025-08-01T00:00:00Z'),
  },
  {
    encrypted_credit_category: 'DggfZR8YH5olfslwFX63og==:MJ4YPPfDMMbAYywdTYHx8Q==:1RgFeAVCSoo=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-20T00:00:00Z'),
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-07T03:00:00Z'),
  },
  {
    encrypted_credit_category: '7SrRrUHfDOQHi1NGL2OfbA==:JqSJxJoXwyH4Xoi43AmApw==:lG1gjhcHg9U=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    expiry_hours: 24 * 14,
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-16T03:00:00Z'),
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
  },
  {
    encrypted_credit_category: 'lYOiVk5sBw4AJhgm+uN02Q==:Hlb9EGjHPEqBOXhiD5m3bA==:Zb3GrOVDB+Y=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    expiry_hours: 24 * 14,
    total_redemptions_allowed: 200,
    promotion_ends_at: new Date('2025-08-23T03:00:00Z'),
    customer_requirement: has_stytchApprovedOrHoldOrPayment,
  },
  {
    encrypted_credit_category: 'wNTVFl71h65+85ILFgwLSA==:KE7OaaFW4DZOyi3IPK95wg==:0JL1aHcnVg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 48,
    expiry_hours: 48,
    total_redemptions_allowed: 2012,
    promotion_ends_at: new Date('2025-08-08T03:00:00Z'),
  },
  {
    encrypted_credit_category:
      'lYp7th9S/X1aDIUm+AOzSA==:V84owhnMn+BwSZpm2o46uA==:NRn8oUjoWXOY9Ga3iw==',
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
    encrypted_credit_category: 'arTJ8jpU3ApP9zJ6vmB2ww==:Ly0prRAHER/NNeBBGVSqNA==:InaeZA==',
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
    encrypted_credit_category: 'RJs4C9WiSPBNpMoOkJAUgA==:rKMRrvlf1RqZEyqUCW+kpQ==:DGIRZg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: mori',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'iutoU0G1wpqyupTVeZ4zjg==:nEbiH4Lpp0QrUo9fxjeltw==:JdHGSYhbUw==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Anthony Sistilli',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '9/1LzjWBHd+sLrTdL0YDaA==:bfBQlPaJFUfQff3Y6VZ9uw==:dIVl0g==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: pikacodes',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '93AOl0JY3OPv7a+G3DEkmw==:NZX6ONqmEfv2V0oSK0+FGA==:KM70ZRl3',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Moritz | AI Builder',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '5pMKo2DUhAbUN7sozMPshQ==:MD3SwxEOSKuiraHqAhjAgQ==:4xjv/A==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Nate Gold | AI Builder',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'rtghl1Ox+53Q+n0f1y+wqw==:j0an0KxAmUGq9vTnRGsumw==:MC8bUg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: tiny_kiri',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'Nl+5hgZ6KOs9jjUOYq+pQA==:RYDgxo36Kc1ml0mhdCj1JQ==:KMhYTdWU',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Alvaro Cintas',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '+dmizu2C8oTyUGDcAbw42Q==:89VgVNELylKGEQaGzJ+jqA==:ues/EBbWVA==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: kortexy.ai',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'RkcKq8lXnNERDPlIGXgTqA==:ii+TfQfoeEDcrgLdvYsrCg==:cS8xXsYJ',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Sam | AI Tools & Tech',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '2JXUG2b8I5xSBJRy6lVwog==:VLfQrcnrQNrJI7FDmDBA2w==:gUzAj0A=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Mehul Mohan',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: '8F8BYuEsHpp0l9Asm0H51w==:V3teTY4W064xMc6Np1JG/A==:2QFGNbg=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-03-01'),
    description: 'Creator: Daily AI Digest',
    total_redemptions_allowed: 5000,
    customer_requirement: has_Payment,
  },
  {
    encrypted_credit_category: 'SxAz6FRWvkkdD74gTjt0Iw==:Rua56Lqu7CmLiq22e/R4xQ==:md/XvfAx',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    promotion_ends_at: new Date('2026-09-16'),
    description: 'Emilie Valentine Experiment',
    total_redemptions_allowed: 5000,
  },
  {
    encrypted_credit_category: '6t5DuiB0djbUtFV5ahkcyw==:5XLIrrhZkAjbzKUk+fi5AQ==:fwxIYM/v1Sw=',
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
      '3mxJjt/8VsFrt8ReFrvjMg==:hzJPfJoeWEl1nm9YNjS2dg==:c6iOCOY2p4afagvxeYWU',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    promotion_ends_at: new Date('2025-07-30'), //i.e. active on july 29th
    description: 'Hackathon: Power of Europe Amsterdam 2025',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: '+9ccNqMgf/tnvTQhUNNMjA==:s6a3Va/1nEIpG7bMmYVFvA==:eO3NGhlvvQ==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    credit_expiry_date: new Date('2025-08-01T00:00:00Z'),
    total_redemptions_allowed: 2000,
    promotion_ends_at: new Date('2025-07-12T00:00:00Z'),
  },
  {
    encrypted_credit_category: 'fZbpUDbusEoRUdAaN04peA==:xwNdzVyaJ6PbSCZjK7vI/g==:d2pGvk41LeM=',
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
      'Ll1D9fFzM4EBYSTZynp6kQ==:Y9f1iwaN6LKRi5yJCt1d2g==:yLXPSWBO2ilkmVYNvhQ=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2025-11-25'),
    description: 'Conference $20 promotional credit',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: 'qg9tWiS+yKLb6BERnKwn8A==:mYrn4BpshhGzzQWRQHhlOA==:C71AdyDiinwIB1lG',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2025-11-25'),
    description: 'Conference $20 promotional credit',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: 'UPPw13ZjDPF253lAQ9H0mg==:L4sXfqtLbZgwt0fYJmb7Kg==:NIp0C1R2Xm+ARA==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    promotion_ends_at: new Date('2026-02-20'),
    description: 'Promo code for Solveo candidates/team expansion',
    total_redemptions_allowed: 20,
  },
  {
    encrypted_credit_category:
      'kK3TxQiRRrybX/lRtokmuw==:2Ya4zINN/ATr1E53P7XWYw==:ql85CNhT/gv1R5Y1I3NghGm9qF5+8Qs=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 20,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2026-02-15'),
    description: 'Builders event promotional credit',
    total_redemptions_allowed: 200,
  },
  {
    encrypted_credit_category: '1tUyCI4PXf55lYRMegAYRA==:oCyDfEkERD01aYZ9ato26A==:Xhe535+6KA==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    expiry_hours: 30 * 24,
    promotion_ends_at: new Date('2026-04-30'),
    description: 'New York City ClawCon Credits',
    total_redemptions_allowed: 2000,
  },
  {
    encrypted_credit_category: 'eDleuTp6Nb8gv0VN8V2scg==:Ql1vQvO4nAW6Ql/DVa8BWQ==:Q7CaOl/+1zM=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 50,
    expiry_hours: 14 * 24,
    promotion_ends_at: new Date('2026-04-30'),
    description: 'Austin ClawCon Credits',
    total_redemptions_allowed: 2000,
  },
  {
    encrypted_credit_category: 'BFZDiYs28gFhxZgnlla7Tg==:Xv3GK0ztm1jvyvxnAq2gSg==:XGLy0E3SF1bGfg==',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 100,
    expiry_hours: 30 * 24,
    description: 'Creator promo',
    total_redemptions_allowed: 30,
  },
  {
    encrypted_credit_category: 'Ask7EbCTpqKCGzYQb/Zpxw==:WUETQMOyhUlPm+QbEwKZXA==:f/fLRPibgFo=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 50,
    expiry_hours: 14 * 24,
    promotion_ends_at: new Date('2026-04-30'),
    description: 'Miami ClawCon Credits',
    total_redemptions_allowed: 1050,
  },
  {
    encrypted_credit_category:
      'QnEXhs31+/tUpgUJCyxsUg==:yr86uoJW07lXPbGVaz25gA==:zW0mCF3n7Aq3JK55yxFb3Fs=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 9,
    promotion_ends_at: new Date('2026-04-30'),
    total_redemptions_allowed: 563,
  },
  {
    encrypted_credit_category:
      'nP8snVufUYT0JZ6S6lG9CQ==:qv4cQcPsg1yjrNWaavFRBA==:9kdOHDfw8+0DWG4ky/Y=',
    is_user_selfservicable: true,
    is_idempotent: true,
    amount_usd: 10,
    description: 'Free AI Inference KiloClaw email',
    promotion_ends_at: new Date('2026-04-22'),
    total_redemptions_allowed: 4175,
    expiry_hours: 7 * 24,
    customer_requirement: created_before(new Date('2026-04-11')),
  },
];

const selfServicePromos: readonly SelfServicePromoCreditCategoryConfig[] =
  encryptedSelfServicePromos.flatMap(({ encrypted_credit_category, ...rest }) => {
    try {
      return [
        {
          ...rest,
          credit_category: decryptPromoCode(encrypted_credit_category),
        },
      ];
    } catch (error) {
      // Decrypting the whole catalogue happens at module scope, so an
      // undecryptable entry (for example a missing or rotated
      // CREDIT_CATEGORIES_ENCRYPTION_KEY_V2) would otherwise take down every
      // route that imports this module, sign-in included. Report it and keep
      // the entries that did decrypt.
      console.error(
        'Failed to decrypt a self-service promo credit category; skipping it. Check CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 / CREDIT_CATEGORIES_ENCRYPTION_KEY.',
        error
      );
      return [];
    }
  });

export const promoCreditCategories: readonly PromoCreditCategoryConfig[] = [
  ...promoCategoriesOld,
  ...adminUI_goodwill_promoCodes,
  ...selfServicePromos,
  ...nonSelfServicePromos,
] as const;

export const promoCreditCategoriesByKey = new Map<string, PromoCreditCategoryConfig>(
  promoCreditCategories.map(category => [category.credit_category, category])
);
