/** The three schedules declared in wrangler.jsonc; `controller.cron` selects one. */
export const CRONS = {
  hourlyCheckpoint: '0 * * * *',
  dailyVerification: '30 3 * * *',
  monthlyVerification: '0 4 1 * *',
} as const;
