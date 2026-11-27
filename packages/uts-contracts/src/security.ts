import { z } from 'zod';

/**
 * The user security view (design 5.13 and 8.4): recent sign-ins, live sessions, credentials and
 * security notices of the caller's account, from the identity store's read replica. The route is
 * on the issuer origin and takes a UTS access token for the `uts` audience with
 * `uts:security.read` that names its grant (`sid`).
 *
 * `device_label`, `platform`, `client_name` and `client_id` are the client's or app's own text,
 * which an attacker chooses when the event is an attack: a page renders them as escaped text,
 * never as markup or a link.
 */
export const UTS_SECURITY_PATH = '/account/security';

/** The view lists at most this many sign-ins and this many notices, newest first. */
export const UTS_SECURITY_LIST_LIMIT = 50;

/** The kinds of security notice (design 5.13), plus the two operational notices UTS sends. */
export const UTS_NOTICE_KINDS = [
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
export const UtsNoticeKindSchema = z.enum(UTS_NOTICE_KINDS);
export type UtsNoticeKind = z.infer<typeof UtsNoticeKindSchema>;

const Timestamp = z.iso.datetime();

/** Approximate place of a sign-in or session, derived from its network; never the address. */
export const ApproximateNetworkSchema = z.strictObject({
  asn: z.number().int().positive().nullable(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  city: z.string().max(128).nullable(),
});

export const SecuritySignInSchema = z.strictObject({
  id: z.uuid(),
  signed_in_at: Timestamp,
  session_kind: z.enum(['browser', 'device']),
  device_label: z.string().nullable(),
  platform: z.string().nullable(),
  methods: z.array(z.string()),
  network: ApproximateNetworkSchema,
  new_device: z.boolean(),
  new_network: z.boolean(),
});

export const SecuritySessionSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['browser', 'device']),
  /** `desktop` or `mobile` for a device session; null for a browser session. */
  client_class: z.enum(['desktop', 'mobile']).nullable(),
  device_label: z.string().nullable(),
  platform: z.string().nullable(),
  signed_in_at: Timestamp,
  last_seen_at: Timestamp,
  methods: z.array(z.string()),
  network: ApproximateNetworkSchema,
});

export const SecurityCredentialsSchema = z.strictObject({
  passkeys: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      backed_up: z.boolean(),
      added_at: Timestamp,
      last_used_at: Timestamp.nullable(),
    })
  ),
  sign_in_methods: z.array(
    z.strictObject({
      id: z.uuid(),
      provider: z.string(),
      added_at: Timestamp,
      last_used_at: Timestamp.nullable(),
    })
  ),
  pats: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      audience: z.string(),
      scope: z.string(),
      last_four: z.string(),
      created_at: Timestamp,
      expires_at: Timestamp,
      last_used_at: Timestamp.nullable(),
    })
  ),
  third_party_clients: z.array(
    z.strictObject({
      id: z.uuid(),
      client_id: z.string(),
      client_name: z.string(),
      scopes: z.array(z.string()),
      granted_at: Timestamp,
    })
  ),
  ci_trust_policies: z.array(
    z.strictObject({
      id: z.uuid(),
      repository: z.string(),
      audience: z.string(),
      scopes: z.array(z.string()),
      created_at: Timestamp,
    })
  ),
});

/** One channel tried for a notice: push, then email, in each delivery round. */
export const SecurityNoticeAttemptSchema = z.strictObject({
  round: z.number().int().min(1).max(3),
  channel: z.enum(['push', 'email']),
  outcome: z.enum([
    'sent',
    'no_target',
    'not_configured',
    'retryable_failure',
    'permanent_failure',
  ]),
  attempted_at: Timestamp,
});

export const SecurityNoticeSchema = z.strictObject({
  id: z.uuid(),
  kind: UtsNoticeKindSchema,
  created_at: Timestamp,
  /** The same words the push and email carry; plain text without links. */
  title: z.string(),
  text: z.string(),
  delivery: z.enum(['pending', 'sending', 'delivered', 'failed']),
  attempts: z.array(SecurityNoticeAttemptSchema),
});

export const SecurityViewSchema = z.strictObject({
  sign_ins: z.array(SecuritySignInSchema).max(UTS_SECURITY_LIST_LIMIT),
  sessions: z.array(SecuritySessionSchema),
  credentials: SecurityCredentialsSchema,
  notices: z.array(SecurityNoticeSchema).max(UTS_SECURITY_LIST_LIMIT),
});
export type SecurityView = z.infer<typeof SecurityViewSchema>;
