import { AuditEventSchema } from '@kilocode/sts-contracts';
import { z } from 'zod';
import * as enums from './enums';

/**
 * Row schemas for every identity-store table, as `pg` decodes them through `identityStoreTypes`:
 * `bigint` and `xid8` as `bigint`, `timestamptz` as `Date`, `bytea` as bytes, `inet` as text, and
 * `jsonb` as parsed JSON. Statements validate their rows against these at the database boundary.
 * `test/db/schema-drift.test.ts` fails when a column or its nullability differs from the schema.
 */

const uuid = z.uuid();
const timestamp = z.date();
const bytes = z.instanceof(Uint8Array);
const sha256 = bytes.refine(value => value.byteLength === 32, 'expected a 32-byte hash');
const jsonObject = z.record(z.string(), z.unknown());

/**
 * `pg` decodes only built-in array types. Enum arrays and arrays of a domain arrive as array
 * literals; their items here never need quoting, so a literal is a comma list in braces.
 */
const SIMPLE_ARRAY_LITERAL = /^\{([a-z0-9_-]+(,[a-z0-9_-]+)*)?\}$/;
function literalArray<Item extends z.ZodType<string, string>>(item: Item) {
  return z
    .string()
    .regex(SIMPLE_ARRAY_LITERAL)
    .transform(literal => (literal === '{}' ? [] : literal.slice(1, -1).split(',')))
    .pipe(z.array(item));
}

const amr = literalArray(z.enum(enums.AUTH_METHODS));
const network = {
  client_ip: z.string().nullable(),
  asn: z.number().int().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
};

export const AccountRowSchema = z.strictObject({
  id: z.string(),
  primary_email: z.string(),
  status: z.enum(enums.ACCOUNT_STATUSES),
  blocked_at: timestamp.nullable(),
  event_version: z.bigint(),
  created_at: timestamp,
  updated_at: timestamp,
  sign_in_denied_audited_at: timestamp.nullable(),
  imported_at: timestamp.nullable(),
  revoked_before: timestamp.nullable(),
  status_version: z.bigint(),
  email_version: z.bigint(),
});

export const SsoConnectionRowSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  workos_connection_id: z.string(),
  status: z.enum(enums.SSO_CONNECTION_STATUSES),
  created_at: timestamp,
  updated_at: timestamp,
  workos_organization_id: z.string().nullable(),
});

export const SsoDomainRowSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  domain: z.string(),
  status: z.enum(enums.SSO_DOMAIN_STATUSES),
  dns_challenge_hash: sha256.nullable(),
  requested_at: timestamp,
  verified_at: timestamp.nullable(),
});

export const OrgSsoPolicyRowSchema = z.strictObject({
  org_id: uuid,
  enforcement: z.enum(enums.SSO_ENFORCEMENTS),
  event_version: z.bigint(),
  updated_at: timestamp,
});

export const OrgMembershipRowSchema = z.strictObject({
  org_id: uuid,
  account_id: z.string(),
  role: z.enum(enums.ORG_ROLES),
  status: z.enum(enums.MEMBERSHIP_STATUSES),
  removed_at: timestamp.nullable(),
  event_version: z.bigint(),
  updated_at: timestamp,
});

export const SignInMethodRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  provider: z.enum(enums.SIGN_IN_PROVIDERS),
  provider_subject: z.string(),
  verified_email: z.string().nullable(),
  sso_connection_id: uuid.nullable(),
  added_at: timestamp,
  last_used_at: timestamp.nullable(),
  gate_pass_id: uuid.nullable(),
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
});

export const PasskeyCredentialRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  credential_id: bytes,
  public_key: bytes,
  sign_count: z.bigint(),
  aaguid: uuid.nullable(),
  transports: z.array(z.string()),
  backup_eligible: z.boolean(),
  backed_up: z.boolean(),
  rp_id: z.string(),
  name: z.string(),
  added_at: timestamp,
  last_used_at: timestamp.nullable(),
  user_handle: bytes,
  gate_pass_id: uuid.nullable(),
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  denied_audited_at: timestamp.nullable(),
  imported_at: timestamp.nullable(),
});

export const BrowserSessionRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  /** Null for a session the legacy bridge created, which has no sign-in cookie. */
  token_hash: sha256.nullable(),
  auth_time: timestamp,
  amr,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  expires_at: timestamp,
  user_agent: z.string().nullable(),
  ...network,
  status: z.enum(enums.SESSION_STATUSES),
  revoked_at: timestamp.nullable(),
  revoke_reason: z.enum(enums.REVOKE_REASONS).nullable(),
  denied_audited_at: timestamp.nullable(),
  cleanup_kept_at: timestamp.nullable(),
  device_key_hash: sha256.nullable(),
  /** The web BFF's handle (migration 0013): its hash, issue time and the sign-in it carries. */
  handle_hash: sha256.nullable(),
  handle_issued_at: timestamp.nullable(),
  handle_auth_time: timestamp.nullable(),
  handle_amr: amr.nullable(),
  sso_connection_id: z.string().nullable(),
  sso_organization_id: z.string().nullable(),
});

export const DeviceSessionRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  client_class: z.enum(enums.CLIENT_CLASSES),
  device_label: z.string(),
  platform: z.string(),
  auth_time: timestamp,
  amr,
  created_at: timestamp,
  last_seen_at: timestamp,
  ...network,
  status: z.enum(enums.SESSION_STATUSES),
  revoked_at: timestamp.nullable(),
  revoke_reason: z.enum(enums.REVOKE_REASONS).nullable(),
});

export const GatePassRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  browser_session_id: uuid.nullable(),
  device_session_id: uuid.nullable(),
  tier: z.enum(enums.GATE_TIERS),
  action: z.enum(enums.GATED_ACTIONS),
  satisfied_by: literalArray(z.enum(enums.GATE_CHECKS)),
  passed_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.GATE_PASS_STATUSES),
  consumed_at: timestamp.nullable(),
});

export const StepUpRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  browser_session_id: uuid.nullable(),
  device_session_id: uuid.nullable(),
  purpose: z.enum(enums.STEP_UP_PURPOSES),
  passkey_credential_id: uuid,
  completed_at: timestamp,
  expires_at: timestamp,
  sso_auth_time: timestamp.nullable(),
  client_ip: z.string().nullable(),
});

export const RefreshGrantRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  device_session_id: uuid,
  client_id: z.string(),
  client_class: z.enum(enums.CLIENT_CLASSES),
  token_hash: sha256,
  dpop_jkt: sha256,
  allowed_scopes: z.array(z.string()),
  org_id: uuid.nullable(),
  created_at: timestamp,
  last_used_at: timestamp,
  idle_expires_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.GRANT_STATUSES),
  revoked_at: timestamp.nullable(),
  revoke_reason: z.enum(enums.REVOKE_REASONS).nullable(),
  denied_audited_at: timestamp.nullable(),
});

export const ThirdPartyClientRowSchema = z.strictObject({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  document: jsonObject,
  etag: z.string().nullable(),
  fetched_at: timestamp,
  cache_expires_at: timestamp,
  status: z.enum(enums.CLIENT_STATUSES),
});

export const ThirdPartyConsentRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  client_id: z.string(),
  org_id: uuid.nullable(),
  scopes: z.array(z.string()),
  gate_pass_id: uuid,
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  granted_at: timestamp,
  status: z.enum(enums.CREDENTIAL_STATUSES),
  revoked_at: timestamp.nullable(),
});

export const ThirdPartyGrantFamilyRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  client_id: z.string(),
  consent_id: uuid,
  scopes: z.array(z.string()),
  org_id: uuid.nullable(),
  auth_time: timestamp,
  amr,
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.GRANT_STATUSES),
  revoked_at: timestamp.nullable(),
  revoke_reason: z.enum(enums.REVOKE_REASONS).nullable(),
  denied_audited_at: timestamp.nullable(),
});

export const ThirdPartyRefreshTokenRowSchema = z.strictObject({
  family_id: uuid,
  token_hash: sha256,
  issued_at: timestamp,
  idle_expires_at: timestamp,
});

export const ThirdPartyRotatedTokenRowSchema = z.strictObject({
  token_key: uuid,
  family_id: uuid,
  family_expires_at: timestamp,
});

export const AuthorizationCodeRowSchema = z.strictObject({
  code_hash: sha256,
  client_id: z.string(),
  client_kind: z.enum(enums.CLIENT_KINDS),
  account_id: z.string(),
  browser_session_id: uuid.nullable(),
  redirect_uri: z.string(),
  resources: literalArray(z.string()),
  scopes: z.array(z.string()),
  org_id: uuid.nullable(),
  code_challenge: z.string(),
  dpop_jkt: sha256.nullable(),
  auth_time: timestamp,
  amr,
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.CODE_STATUSES),
  consumed_at: timestamp.nullable(),
  consent_id: uuid.nullable(),
  grant_id: uuid.nullable(),
});

export const DeviceCodeRowSchema = z.strictObject({
  id: uuid,
  device_code_hash: sha256,
  user_code_hash: sha256,
  client_id: z.string(),
  scopes: z.array(z.string()),
  created_at: timestamp,
  expires_at: timestamp,
  poll_interval_seconds: z.number().int(),
  last_polled_at: timestamp.nullable(),
  user_agent: z.string().nullable(),
  ...network,
  status: z.enum(enums.DEVICE_CODE_STATUSES),
  account_id: z.string().nullable(),
  gate_pass_id: uuid.nullable(),
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  approved_at: timestamp.nullable(),
  denied_at: timestamp.nullable(),
  consumed_at: timestamp.nullable(),
  auth_time: timestamp.nullable(),
  amr: amr.nullable(),
  grant_id: uuid.nullable(),
  dpop_jkt: sha256.nullable(),
  anonymous_writer: z.string().nullable(),
});

export const EmailCodeRowSchema = z.strictObject({
  id: uuid,
  purpose: z.enum(enums.EMAIL_CODE_PURPOSES),
  email_hash: sha256,
  account_id: z.string().nullable(),
  code_hash: sha256.nullable(),
  attempts: z.number().int(),
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.EMAIL_CODE_STATUSES),
  consumed_at: timestamp.nullable(),
  address: z.enum(enums.EMAIL_CODE_ADDRESSES).nullable(),
  email: z.string().nullable(),
  link_hash: sha256.nullable(),
  return_to: z.string().nullable(),
  binder_hash: sha256.nullable(),
});

export const EmailCodeLimitRowSchema = z.strictObject({
  purpose: z.enum(enums.EMAIL_CODE_PURPOSES),
  email_hash: sha256,
  hour_started_at: timestamp,
  sent_in_hour: z.number().int(),
  day_started_at: timestamp,
  failures_in_day: z.number().int(),
  status: z.enum(enums.EMAIL_CODE_LIMIT_STATUSES),
  stopped_until: timestamp.nullable(),
});

export const TicketRowSchema = z.strictObject({
  ticket_hash: sha256,
  purpose: z.enum(enums.TICKET_PURPOSES),
  audience: z.string(),
  account_id: z.string(),
  resource: z.string().nullable(),
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.CODE_STATUSES),
  consumed_at: timestamp.nullable(),
  grant_id: uuid,
  client_id: z.string(),
  org_id: uuid.nullable(),
  denied_audited_at: timestamp.nullable(),
});

export const WebauthnChallengeRowSchema = z.strictObject({
  challenge_hash: sha256,
  ceremony: z.enum(enums.WEBAUTHN_CEREMONIES),
  rp_id: z.string(),
  account_id: z.string().nullable(),
  browser_session_id: uuid.nullable(),
  user_handle: bytes.nullable(),
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.CODE_STATUSES),
  consumed_at: timestamp.nullable(),
});

export const SignInFlowRowSchema = z.strictObject({
  state_hash: sha256,
  provider: z.enum(enums.SIGN_IN_PROVIDERS),
  binder_hash: sha256,
  intent: z.enum(enums.SIGN_IN_INTENTS),
  link_session_id: uuid.nullable(),
  gate_pass_id: uuid.nullable(),
  sso_connection_id: uuid.nullable(),
  return_to: z.string(),
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.CODE_STATUSES),
  consumed_at: timestamp.nullable(),
});

export const AccountUserCodeFailureRowSchema = z.strictObject({
  account_id: z.string(),
  failures: z.number().int(),
  window_started_at: timestamp,
});

export const NetworkUserCodeFailureRowSchema = z.strictObject({
  client_network: z.string(),
  failures: z.number().int(),
  window_started_at: timestamp,
});

export const PersonalAccessTokenRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  name: z.string(),
  token_hash: sha256,
  last_four: z.string(),
  audience: z.string(),
  scope: z.string(),
  org_id: uuid.nullable(),
  gate_pass_id: uuid,
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  created_at: timestamp,
  expires_at: timestamp,
  last_used_at: timestamp.nullable(),
  last_used_ip: z.string().nullable(),
  last_used_asn: z.number().int().nullable(),
  last_used_country: z.string().nullable(),
  status: z.enum(enums.CREDENTIAL_STATUSES),
  revoked_at: timestamp.nullable(),
  revoke_reason: z.enum(enums.REVOKE_REASONS).nullable(),
});

export const OrgBotKeyRowSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  created_by: z.string(),
  name: z.string(),
  token_hash: sha256,
  last_four: z.string(),
  audience: z.string(),
  scope: z.string(),
  /** NULL once the creator's account is deleted; only a flagged, kept or revoked key has none. */
  gate_pass_id: uuid.nullable(),
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  created_at: timestamp,
  expires_at: timestamp,
  last_used_at: timestamp.nullable(),
  status: z.enum(enums.BOT_KEY_STATUSES),
  flagged_at: timestamp.nullable(),
  kept_by: z.string().nullable(),
  kept_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  revoked_by: z.string().nullable(),
});

export const CiTrustPolicyRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  org_id: uuid.nullable(),
  gate_pass_id: uuid,
  gate_pass_action: z.enum(enums.GATED_ACTIONS),
  repository: z.string(),
  repository_id: z.bigint(),
  ref_pattern: z.string().nullable(),
  environment: z.string().nullable(),
  audience: z.string(),
  scopes: z.array(z.string()),
  created_at: timestamp,
  updated_at: timestamp,
  status: z.enum(enums.CREDENTIAL_STATUSES),
  revoked_at: timestamp.nullable(),
});

export const SandboxGrantRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  sandbox_session_id: z.string(),
  allowed_scopes: z.array(z.string()),
  org_id: uuid.nullable(),
  created_at: timestamp,
  expires_at: timestamp,
  status: z.enum(enums.SANDBOX_GRANT_STATUSES),
  ended_at: timestamp.nullable(),
});

export const RevocationRowSchema = z.strictObject({
  id: z.bigint(),
  kind: z.enum(enums.REVOCATION_KINDS),
  subject_id: z.string(),
  revoked_before: timestamp.nullable(),
  revoked_at: timestamp,
  feed_expires_at: timestamp,
});

export const SubjectOperationRowSchema = z.strictObject({
  operation_id: uuid,
  operation: z.enum(enums.SUBJECT_OPERATIONS),
  target: z.string(),
  source_version: z.bigint(),
  feed_entries: z.array(z.unknown()),
  created_at: timestamp,
  expires_at: timestamp,
});

export const SubjectTombstoneRowSchema = z.strictObject({
  id: z.bigint(),
  subject: z.string(),
  operation: z.enum(enums.SUBJECT_OPERATIONS),
  reason: z.string().nullable(),
  source_version: z.bigint(),
  operation_id: uuid,
  created_at: timestamp,
});

export const AppAccountEventRowSchema = z.strictObject({
  event_id: uuid,
  event_type: z.literal('user.created'),
  account_id: z.string(),
  primary_email: z.string(),
  occurred_at: timestamp,
});

export const DpopProofRowSchema = z.strictObject({
  jkt: sha256,
  jti: z.string(),
  expires_at: timestamp,
});

export const NoticeRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  kind: z.enum(enums.NOTICE_KINDS),
  details: jsonObject,
  audit_event_id: uuid.nullable(),
  created_at: timestamp,
  delivery: z.enum(enums.NOTICE_DELIVERIES),
  delivered_at: timestamp.nullable(),
  failed_at: timestamp.nullable(),
  read_at: timestamp.nullable(),
  next_attempt_at: timestamp,
  rounds: z.number().int().min(0).max(3),
  claim_id: uuid.nullable(),
  claimed_at: timestamp.nullable(),
  recipient_email: z.string().nullable(),
  old_email: z.string().nullable(),
});

export const NoticeAttemptRowSchema = z.strictObject({
  notice_id: uuid,
  round: z.number().int().min(1).max(3),
  position: z.number().int().min(1).max(2),
  channel: z.enum(enums.NOTICE_CHANNELS),
  outcome: z.enum(enums.NOTICE_ATTEMPT_OUTCOMES),
  attempted_at: timestamp,
});

export const KnownDeviceRowSchema = z.strictObject({
  account_id: z.string(),
  device_key: sha256,
  first_seen_at: timestamp,
  last_seen_at: timestamp,
});

export const KnownNetworkRowSchema = z.strictObject({
  account_id: z.string(),
  network_key: z.string(),
  first_seen_at: timestamp,
  last_seen_at: timestamp,
});

export const SignInRowSchema = z.strictObject({
  id: uuid,
  account_id: z.string(),
  session_kind: z.enum(enums.SIGN_IN_SESSION_KINDS),
  browser_session_id: uuid.nullable(),
  device_session_id: uuid.nullable(),
  signed_in_at: timestamp,
  amr,
  device_label: z.string().nullable(),
  platform: z.string().nullable(),
  ...network,
  new_device: z.boolean(),
  new_network: z.boolean(),
  notice_id: uuid.nullable(),
});

export const AuditEventRowSchema = z.strictObject({
  id: z.bigint(),
  txid: z.bigint(),
  shard: z.number().int().min(0).max(7),
  created_at: timestamp,
  event_id: uuid,
  event_type: z.string(),
  account_id: z.string().nullable(),
  event: AuditEventSchema,
});

export const AuditRelayWatermarkRowSchema = z.strictObject({
  shard: z.number().int().min(0).max(7),
  last_txid: z.bigint(),
  last_id: z.bigint(),
  last_seq: z.bigint(),
  updated_at: timestamp,
});

export const AppAttestKeyRowSchema = z.strictObject({
  key_id: sha256,
  public_key: bytes,
  sign_count: z.bigint(),
  created_at: timestamp,
  last_used_at: timestamp,
});

export const CodeAttestationRowSchema = z.strictObject({
  code_hash: sha256,
  attestation_type: z.enum(enums.IDENTITY_STORE_ENUMS.attestation_type).nullable(),
  key_id: sha256.nullable(),
  state: z.enum(enums.ATTESTATION_STATES),
  claim_id: uuid,
  claimed_at: timestamp,
  settled_at: timestamp.nullable(),
});

/** Each row schema by its table name in the `uts` schema. */
export const IDENTITY_STORE_TABLES = {
  accounts: AccountRowSchema,
  sso_connections: SsoConnectionRowSchema,
  sso_domains: SsoDomainRowSchema,
  org_sso_policies: OrgSsoPolicyRowSchema,
  org_memberships: OrgMembershipRowSchema,
  sign_in_methods: SignInMethodRowSchema,
  passkey_credentials: PasskeyCredentialRowSchema,
  browser_sessions: BrowserSessionRowSchema,
  device_sessions: DeviceSessionRowSchema,
  gate_passes: GatePassRowSchema,
  step_ups: StepUpRowSchema,
  refresh_grants: RefreshGrantRowSchema,
  third_party_clients: ThirdPartyClientRowSchema,
  third_party_consents: ThirdPartyConsentRowSchema,
  third_party_grant_families: ThirdPartyGrantFamilyRowSchema,
  third_party_refresh_tokens: ThirdPartyRefreshTokenRowSchema,
  third_party_rotated_tokens: ThirdPartyRotatedTokenRowSchema,
  authorization_codes: AuthorizationCodeRowSchema,
  device_codes: DeviceCodeRowSchema,
  email_codes: EmailCodeRowSchema,
  email_code_limits: EmailCodeLimitRowSchema,
  tickets: TicketRowSchema,
  webauthn_challenges: WebauthnChallengeRowSchema,
  sign_in_flows: SignInFlowRowSchema,
  account_user_code_failures: AccountUserCodeFailureRowSchema,
  network_user_code_failures: NetworkUserCodeFailureRowSchema,
  personal_access_tokens: PersonalAccessTokenRowSchema,
  org_bot_keys: OrgBotKeyRowSchema,
  ci_trust_policies: CiTrustPolicyRowSchema,
  sandbox_grants: SandboxGrantRowSchema,
  revocations: RevocationRowSchema,
  dpop_proofs: DpopProofRowSchema,
  notices: NoticeRowSchema,
  notice_attempts: NoticeAttemptRowSchema,
  known_devices: KnownDeviceRowSchema,
  known_networks: KnownNetworkRowSchema,
  sign_ins: SignInRowSchema,
  subject_operations: SubjectOperationRowSchema,
  subject_tombstones: SubjectTombstoneRowSchema,
  app_account_events: AppAccountEventRowSchema,
  audit_events: AuditEventRowSchema,
  audit_relay_watermarks: AuditRelayWatermarkRowSchema,
  app_attest_keys: AppAttestKeyRowSchema,
  code_attestations: CodeAttestationRowSchema,
} as const;
