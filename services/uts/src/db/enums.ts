/**
 * The identity store's enum types, in their database order. `test/db/schema-drift.test.ts` fails
 * when one of these differs from the migrated schema.
 */

export const ACCOUNT_STATUSES = ['active', 'blocked'] as const;
export const SIGN_IN_PROVIDERS = [
  'google',
  'openai',
  'anthropic',
  'anaconda',
  'apple',
  'github',
  'gitlab',
  'discord',
  'linkedin',
  'workos',
  'email',
] as const;
export const AUTH_METHODS = [
  'oauth',
  'sso',
  'email_link',
  'email_code',
  'passkey',
  'device_grant',
  'native',
  'access_code',
] as const;
export const CLIENT_CLASSES = ['desktop', 'mobile'] as const;
export const CLIENT_KINDS = ['first_party', 'third_party'] as const;
export const REVOKE_REASONS = [
  'sign_out',
  'user_revoke',
  'admin_revoke',
  'org_admin_revoke',
  'account_blocked',
  'member_removed',
  'credential_change',
  'reuse_detected',
  'session_ended',
] as const;
export const SESSION_STATUSES = ['active', 'revoked'] as const;
export const GRANT_STATUSES = ['active', 'revoked'] as const;
export const REFRESH_TOKEN_STATUSES = ['active', 'rotated'] as const;
export const CODE_STATUSES = ['issued', 'consumed'] as const;
export const DEVICE_CODE_STATUSES = ['pending', 'approved', 'denied', 'consumed'] as const;
export const EMAIL_CODE_PURPOSES = ['sign_in', 'tier_a'] as const;
export const EMAIL_CODE_STATUSES = ['pending', 'consumed', 'exhausted'] as const;
export const EMAIL_CODE_LIMIT_STATUSES = ['open', 'stopped'] as const;
export const TICKET_PURPOSES = [
  'sign_in',
  'stream',
  'terminal',
  'preview',
  'dispatch',
  'download',
] as const;
export const CREDENTIAL_STATUSES = ['active', 'revoked'] as const;
export const BOT_KEY_STATUSES = ['active', 'flagged', 'kept', 'revoked'] as const;
export const SSO_CONNECTION_STATUSES = ['active', 'inactive'] as const;
export const SSO_DOMAIN_STATUSES = ['pending', 'verified'] as const;
export const SSO_ENFORCEMENTS = ['off', 'optional', 'required'] as const;
export const ORG_ROLES = ['owner', 'admin', 'member', 'billing_manager'] as const;
export const MEMBERSHIP_STATUSES = ['active', 'removed'] as const;
export const CLIENT_STATUSES = ['active', 'blocked'] as const;
export const SANDBOX_GRANT_STATUSES = ['active', 'ended'] as const;
export const REVOCATION_KINDS = [
  'subject',
  'session',
  'grant',
  'third_party_family',
  'pat',
  'bot_key',
  'sandbox_grant',
  'kid',
] as const;
export const GATE_TIERS = ['a', 'b'] as const;
export const GATED_ACTIONS = [
  'passkey_add',
  'passkey_remove',
  'method_add',
  'method_remove',
  'email_change',
  'pat_create',
  'bot_key_create',
  'ci_policy_create',
  'device_approve',
  'third_party_approve',
] as const;
export const GATE_CHECKS = ['recent_sign_in', 'passkey', 'email_code', 'email_code_new'] as const;
export const GATE_PASS_STATUSES = ['open', 'consumed'] as const;
export const STEP_UP_PURPOSES = ['gate', 'admin'] as const;
export const NOTICE_KINDS = [
  'new_device_network',
  'sign_in_method_changed',
  'primary_email_changed',
  'credential_created',
  'device_sign_in_approved',
  'ci_trust_policy_changed',
  'third_party_client_approved',
  'sessions_revoked',
  'suspicious_sign_in',
  'sign_in_code_stopped',
  'bot_key_flagged',
] as const;
export const NOTICE_CHANNELS = ['push', 'email', 'in_app'] as const;
export const NOTICE_DELIVERIES = ['pending', 'sending', 'delivered', 'failed'] as const;
export const NOTICE_ATTEMPT_OUTCOMES = [
  'sent',
  'no_target',
  'not_configured',
  'retryable_failure',
  'permanent_failure',
] as const;
export const SIGN_IN_SESSION_KINDS = ['browser', 'device'] as const;

/** Each enum by its type name in the `uts` schema. */
export const IDENTITY_STORE_ENUMS = {
  account_status: ACCOUNT_STATUSES,
  sign_in_provider: SIGN_IN_PROVIDERS,
  auth_method: AUTH_METHODS,
  client_class: CLIENT_CLASSES,
  client_kind: CLIENT_KINDS,
  revoke_reason: REVOKE_REASONS,
  session_status: SESSION_STATUSES,
  grant_status: GRANT_STATUSES,
  refresh_token_status: REFRESH_TOKEN_STATUSES,
  code_status: CODE_STATUSES,
  device_code_status: DEVICE_CODE_STATUSES,
  email_code_purpose: EMAIL_CODE_PURPOSES,
  email_code_status: EMAIL_CODE_STATUSES,
  email_code_limit_status: EMAIL_CODE_LIMIT_STATUSES,
  ticket_purpose: TICKET_PURPOSES,
  credential_status: CREDENTIAL_STATUSES,
  bot_key_status: BOT_KEY_STATUSES,
  sso_connection_status: SSO_CONNECTION_STATUSES,
  sso_domain_status: SSO_DOMAIN_STATUSES,
  sso_enforcement: SSO_ENFORCEMENTS,
  org_role: ORG_ROLES,
  membership_status: MEMBERSHIP_STATUSES,
  client_status: CLIENT_STATUSES,
  sandbox_grant_status: SANDBOX_GRANT_STATUSES,
  revocation_kind: REVOCATION_KINDS,
  gate_tier: GATE_TIERS,
  gated_action: GATED_ACTIONS,
  gate_check: GATE_CHECKS,
  gate_pass_status: GATE_PASS_STATUSES,
  step_up_purpose: STEP_UP_PURPOSES,
  notice_kind: NOTICE_KINDS,
  notice_channel: NOTICE_CHANNELS,
  notice_delivery: NOTICE_DELIVERIES,
  notice_attempt_outcome: NOTICE_ATTEMPT_OUTCOMES,
  sign_in_session_kind: SIGN_IN_SESSION_KINDS,
} as const;
