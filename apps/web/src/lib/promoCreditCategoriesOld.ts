import type { PromoCreditCategoryConfig } from '@/lib/PromoCreditCategoryConfig';
import { PROMO_CREDIT_EXPIRY_HRS } from '@/lib/constants';

export const promoCategoriesOld: PromoCreditCategoryConfig[] = [
  {
    credit_category: 'welcome20',
    adminUI_label: '$20 - New User Credits',
    amount_usd: 20,
    description: 'Credit for new users who got $0',
    obsolete: true,
  },
  {
    credit_category: 'welcome15',
    adminUI_label: '$15 - New User Credits',
    amount_usd: 15,
    description: 'Credit for new users who already got $5',
    obsolete: true,
  },
  {
    credit_category: 'stytch-validation',
    description: 'Free credits for passing Stytch fraud detection.',
    amount_usd: 5,
    is_idempotent: true,
    obsolete: true,
  },
  {
    credit_category: 'card-validation-no-stytch',
    description: 'Free credits for passing card validation without prior Stytch validation.',
    amount_usd: 20,
    is_idempotent: true,
    obsolete: true,
  },
  {
    credit_category: 'card-validation-upgrade',
    description:
      'Upgrade credits for passing card validation after having already passed Stytch validation.',
    amount_usd: 15,
    is_idempotent: true,
    obsolete: true,
  },
  {
    credit_category: 'multiplier-promo',
    description: 'Special multiplier promotion for the week of 2025-07-28',
    expiry_hours: PROMO_CREDIT_EXPIRY_HRS,
    is_idempotent: false,
    obsolete: true,
  },
];
