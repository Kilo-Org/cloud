import type { User } from '@kilocode/db/schema';

/**
 * A complete `kilocode_users` row for unit tests.
 *
 * Tests that mock `findUserById` or a session reader need the full select
 * shape, so this factory spells out every column instead of asserting a
 * partial object into `User` and hiding what the row is missing.
 */
export function shellUser(id: string): User {
  return {
    id,
    google_user_email: `${id}@example.test`,
    google_user_name: 'Shell Test User',
    google_user_image_url: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    hosted_domain: null,
    microdollars_used: 0,
    kilo_pass_threshold: null,
    stripe_customer_id: `cus_${id}`,
    app_store_account_token: '00000000-0000-4000-8000-000000000010',
    is_admin: false,
    is_super_admin: false,
    can_view_sessions: false,
    can_manage_credits: false,
    can_export_api_request_logs: false,
    total_microdollars_acquired: 0,
    next_credit_expiration_at: null,
    has_validation_stytch: null,
    has_validation_novel_card_with_hold: false,
    blocked_reason: null,
    blocked_at: null,
    blocked_by_kilo_user_id: null,
    api_token_pepper: null,
    web_session_pepper: null,
    auto_top_up_enabled: false,
    is_bot: false,
    kiloclaw_early_access: false,
    default_model: null,
    cohorts: {},
    completed_welcome_form: false,
    linkedin_url: null,
    github_url: null,
    discord_server_membership_verified_at: null,
    openrouter_upstream_safety_identifier: null,
    openrouter_downstream_safety_identifier: null,
    vercel_downstream_safety_identifier: null,
    customer_source: null,
    signup_ip: null,
    account_deletion_requested_at: null,
    normalized_email: null,
    email_domain: null,
    external_id: null,
    personal_account_disabled: false,
  };
}
