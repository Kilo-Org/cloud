export const USAGE_VERCEL_QUEUE_ENABLED =
  process.env.VERCEL_TARGET_ENV === 'staging' &&
  process.env.VERCEL_ENV !== 'production' &&
  process.env.USAGE_QUEUE_TRANSPORT === 'vercel';
