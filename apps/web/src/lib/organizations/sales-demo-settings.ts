export const SALES_DEMO_REMAINING_MICRODOLLARS = 25_030_000;

export function demoOrganizationSettings(now: Date) {
  return {
    enable_usage_limits: true,
    code_indexing_enabled: true,
    suppress_trial_messaging: true,
    recommendations_digest_enabled: true,
    is_sales_demo: true,
    sales_demo_last_reset_at: now.toISOString(),
  };
}
