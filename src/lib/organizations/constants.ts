export const TOPUP_AMOUNT_QUERY_STRING_KEY = 'topup-amount-usd';
export const TOPUP_CANCELED_QUERY_STRING_KEY = 'topup-canceled';
// Default daily usage limit for members when accepting invitations
export const DEFAULT_MEMBER_DAILY_LIMIT_USD = 25.0;
export const STRIPE_SUB_QUERY_STRING_KEY = 'subscription_session_id';
// Monthly-billed rates (no annual commitment)
export const TEAM_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = 18;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = 72;

// Annually-billed rates ("12 months for the price of 10")
export const TEAM_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = 15;
export const TEAM_SEAT_PRICE_YEARLY_BILLED_ANNUALLY_USD =
  TEAM_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD * 12;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = 60;
export const ENTERPRISE_SEAT_PRICE_YEARLY_BILLED_ANNUALLY_USD =
  ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD * 12;

// Display prices used by UI components (annual billing rate)
export const TEAM_SEAT_PRICE_MONTHLY_USD = TEAM_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_USD = ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD;

export const KILO_ORGANIZATION_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
