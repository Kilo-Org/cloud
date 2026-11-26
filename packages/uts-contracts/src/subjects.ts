import { z } from 'zod';
import { UTS_OAUTH_PROVIDERS } from './signin-methods';

/**
 * Subject operations, identity import and authority sync (design 5.2, 5.6). The web app and Workers
 * tell UTS about authority writes the app still owns: a block, a deletion, a recovery, an ended
 * session set, a primary email, an organization's SSO setup and a membership. UTS also hands the
 * app one event of its own, `user.created`, for each account a UTS sign-in creates.
 *
 * Workers call the mint Worker's named entrypoint `SubjectRevocation` with the bodies below. The
 * web app calls `POST <issuer>/internal/...` with `Authorization: Bearer <STS token>`, audience
 * `uts` and the scope of the route; each STS token carries one scope.
 */

/** Every STS token for these routes names this audience. */
export const UTS_INTERNAL_AUDIENCE = 'uts';

/**
 * The workloads whose STS tokens these routes accept. The STS policy decides which workload may
 * mint each scope; UTS checks the workload again, so a policy mistake cannot widen it.
 */
export const UTS_INTERNAL_WORKLOADS = ['web'] as const;

/** The mint Worker's named entrypoint for Worker callers, bound with `props.caller`. */
export const UTS_SUBJECT_REVOCATION_ENTRYPOINT = 'SubjectRevocation';

export const UTS_SUBJECT_OPERATIONS_PATH_PREFIX = '/internal/subjects/';
export const UTS_ACCOUNT_IMPORT_PATH = '/internal/accounts/import';
export const UTS_AUTHORITY_PATH_PREFIX = '/internal/authority/';
export const UTS_APP_EVENTS_READ_PATH = '/internal/app-events/read';
export const UTS_APP_EVENTS_ACK_PATH = '/internal/app-events/ack';

/** `operation_id` is kept this long; a repeat within it answers `already_applied`. */
export const UTS_OPERATION_ID_RETENTION_DAYS = 7;

/** `unblock` is refused while the block is younger than this. */
export const UTS_UNBLOCK_MIN_BLOCK_AGE_SECONDS = 60;

/** The app's authoritative per-subject (or per-organization) authority version: 0 to 2^53 - 1. */
export const SourceVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Who asked, as the app derived it after its own authorization; never taken from a client. UTS
 * stores it in the audit row and never authorizes with it: the STS token's workload and scope do.
 */
export const OperationActorSchema = z
  .string()
  .regex(/^(?:(?:user|admin):[A-Za-z0-9_:./-]{1,255}|system:[a-z0-9_.-]{1,64})$/);

/** A UTS account id: an imported app user id, or `uts_` plus 26 base32 characters. */
export const SubjectSchema = z.string().min(1).max(255);

/** The id format of an account a UTS sign-in creates; no app user id has it. */
export const UTS_CREATED_ACCOUNT_ID = /^uts_[a-z2-7]{26}$/;

/** The path segment of each subject operation: `POST /internal/subjects/<operation>`. */
export const SubjectOperationSchema = z.enum([
  'revoke',
  'unblock',
  'end-browser-sessions',
  'end-device-sessions',
  'revoke-api-credentials',
]);
export type SubjectOperation = z.infer<typeof SubjectOperationSchema>;

/** Each subject operation's RPC method, its STS scope and the reasons it accepts. */
export const UTS_SUBJECT_OPERATIONS = {
  revoke: {
    method: 'revokeSubject',
    scope: 'uts:subjects.revoke',
    reasons: ['access_block', 'account_recovery', 'account_reset', 'account_deleted'],
  },
  unblock: {
    method: 'unblockSubject',
    scope: 'uts:subjects.revoke',
    reasons: ['access_unblock'],
  },
  'end-browser-sessions': {
    method: 'endBrowserSessions',
    scope: 'uts:browser-sessions.end',
    reasons: ['staff_signout', 'workos_relink', 'scim_mailbox_move', 'apple_consent_revoked'],
  },
  'end-device-sessions': {
    method: 'endDeviceSessions',
    scope: 'uts:device-sessions.end',
    reasons: ['apple_consent_revoked'],
  },
  'revoke-api-credentials': {
    method: 'revokeApiCredentials',
    scope: 'uts:api-credentials.revoke',
    reasons: ['staff_api_reset'],
  },
} as const satisfies Record<
  SubjectOperation,
  { method: string; scope: string; reasons: readonly [string, ...string[]] }
>;

/** Whether `reason` is one the operation accepts; any other is `reason_not_allowed`. */
export function reasonAllowed(operation: SubjectOperation, reason: string): boolean {
  const reasons: readonly string[] = UTS_SUBJECT_OPERATIONS[operation].reasons;
  return reasons.includes(reason);
}

/**
 * The body of every subject operation, over HTTPS and RPC alike. `reason` is checked against the
 * operation after this parse, so an unknown reason is `409 reason_not_allowed`, not `400`.
 */
export const SubjectOperationRequestSchema = z.strictObject({
  operation_id: z.uuid(),
  subject: SubjectSchema,
  reason: z.string().regex(/^[a-z_]{1,64}$/),
  actor: OperationActorSchema,
  source_version: SourceVersionSchema,
});
export type SubjectOperationRequest = z.infer<typeof SubjectOperationRequestSchema>;

/**
 * The typed outcomes. Over HTTPS: `applied`, `already_applied` and `no_subject` are 200;
 * `retry_later` and `refused` are 409 (only `retry_later` carries `Retry-After`); a malformed body
 * is `400 invalid_request`; `unavailable` is `503 temporarily_unavailable` with `Retry-After`.
 * An outbox marks an operation done on the three 200 outcomes, retries `retry_later` and
 * `unavailable` after the wait, and stops on the others.
 */
export type SubjectOperationResult =
  | { outcome: 'applied' | 'already_applied' | 'no_subject'; operationId: string }
  | {
      outcome: 'retry_later';
      error: 'unblock_too_soon';
      operationId: string;
      retryAfterSeconds: number;
    }
  | { outcome: 'refused'; error: 'account_deleted' | 'reason_not_allowed' }
  | { outcome: 'invalid_request' }
  | { outcome: 'unavailable'; retryAfterSeconds: number };

export const SubjectOperationAnswerSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.enum(['applied', 'already_applied', 'no_subject']),
    operation_id: z.uuid(),
  }),
  z.strictObject({
    outcome: z.literal('retry_later'),
    error: z.literal('unblock_too_soon'),
    operation_id: z.uuid(),
  }),
  z.strictObject({
    outcome: z.literal('refused'),
    error: z.enum(['account_deleted', 'reason_not_allowed']),
  }),
]);
export type SubjectOperationAnswer = z.infer<typeof SubjectOperationAnswerSchema>;

/** The Worker RPC surface of `SubjectRevocation`; each method takes the request body above. */
export type SubjectRevocationRpc = {
  [Operation in SubjectOperation as (typeof UTS_SUBJECT_OPERATIONS)[Operation]['method']]: (
    request: unknown
  ) => Promise<SubjectOperationResult>;
};

const ProviderSchema = z.enum([...UTS_OAUTH_PROVIDERS, 'workos', 'email']);
const PastTimeSchema = z.iso.datetime({ offset: true });
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const EmailSchema = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+$/)
  .refine(value => value === value.toLowerCase(), 'a lower-case address');
const WorkosIdSchema = z.string().min(1).max(255);
export const OrgRoleSchema = z.enum(['owner', 'admin', 'member', 'billing_manager']);

/**
 * One provider identity the app verified. `workos_connection_id` names the WorkOS connection of a
 * `workos` identity and nothing else; the connection must already be synced
 * (`sso-organization`). `linked_at` is when the app linked it, so the 24-hour cooling-off of a
 * new method (design 5.11) does not start again at import.
 */
export const ImportedIdentitySchema = z
  .strictObject({
    provider: ProviderSchema,
    provider_subject: z.string().min(1).max(512),
    verified_email: EmailSchema.nullable(),
    workos_connection_id: WorkosIdSchema.nullable(),
    linked_at: PastTimeSchema,
  })
  .refine(
    identity => (identity.provider === 'workos') === (identity.workos_connection_id !== null),
    'a WorkOS identity names its connection, and only a WorkOS identity does'
  );

/**
 * One passkey the app registered under the app host, with the WebAuthn user handle it was created
 * under. A user handle alone cannot verify an assertion, so the credential travels whole.
 */
export const ImportedPasskeySchema = z.strictObject({
  credential_id: Base64UrlSchema.min(22).max(1364),
  public_key: Base64UrlSchema.min(1).max(2731),
  sign_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  transports: z.array(z.string().regex(/^[a-z-]{1,32}$/)).max(8),
  backup_eligible: z.boolean(),
  backed_up: z.boolean(),
  aaguid: z.uuid().nullable(),
  name: z.string().min(1).max(100),
  user_handle: Base64UrlSchema.min(22).max(86),
  created_at: PastTimeSchema,
});

/** The account's tie to an organization's SSO: the WorkOS ids and the app organization. */
export const SsoAuthoritySchema = z.strictObject({
  app_organization_id: z.uuid(),
  workos_organization_id: WorkosIdSchema,
  workos_connection_id: WorkosIdSchema,
  role: OrgRoleSchema,
});

/** `POST /internal/accounts/import`, scope `uts:accounts.import`; idempotent by `app_user_id`. */
export const AccountImportRequestSchema = z
  .strictObject({
    app_user_id: SubjectSchema.refine(
      id => !id.startsWith('uts_'),
      'an app user id never takes the uts_ prefix'
    ),
    primary_email: EmailSchema,
    status: z.enum(['active', 'blocked']),
    verified_identities: z.array(ImportedIdentitySchema).max(32),
    sso_authority: SsoAuthoritySchema.nullable(),
    passkeys: z.array(ImportedPasskeySchema).max(16),
    source_version: SourceVersionSchema,
  })
  .refine(
    request =>
      new Set(
        request.verified_identities.map(item => `${item.provider}\u0000${item.provider_subject}`)
      ).size === request.verified_identities.length,
    'each provider identity once'
  )
  .refine(
    request =>
      new Set(request.passkeys.map(item => item.credential_id)).size === request.passkeys.length,
    'each passkey once'
  );
export type AccountImportRequest = z.infer<typeof AccountImportRequestSchema>;

/**
 * `imported` and `already_imported` are 200. `retry_later` (409 with `Retry-After`) means the SSO
 * connection is not synced yet. `refused` (409) is final for this snapshot: `deleted` (the subject
 * was deleted; it never comes back), `stale` (an operation with a newer source version reached
 * UTS first: read the account again and import the new snapshot), or a conflict with another
 * account (`identity_taken`, `email_taken`, `passkey_taken`) or with the synced SSO setup
 * (`sso_authority_mismatch`).
 */
export const AccountImportAnswerSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.enum(['imported', 'already_imported']),
    account_id: SubjectSchema,
  }),
  z.strictObject({ outcome: z.literal('retry_later'), error: z.literal('sso_connection_unknown') }),
  z.strictObject({
    outcome: z.literal('refused'),
    error: z.enum([
      'deleted',
      'stale',
      'identity_taken',
      'email_taken',
      'passkey_taken',
      'sso_authority_mismatch',
    ]),
  }),
]);
export type AccountImportAnswer = z.infer<typeof AccountImportAnswerSchema>;

/** The authority sync kinds: `POST /internal/authority/<kind>`, scope `uts:authority.sync`. */
export const UTS_AUTHORITY_SCOPE = 'uts:authority.sync';
export const UTS_ACCOUNT_IMPORT_SCOPE = 'uts:accounts.import';
export const UTS_APP_EVENTS_SCOPE = 'uts:app-events.read';

const AuthorityCommon = {
  operation_id: z.uuid(),
  actor: OperationActorSchema,
  source_version: SourceVersionSchema,
};

/** The subject's primary email changed in the app (an email change, a SCIM mailbox move). */
export const EmailSyncRequestSchema = z.strictObject({
  ...AuthorityCommon,
  subject: SubjectSchema,
  primary_email: EmailSchema,
});

/** A membership was added, changed (`role`) or removed (`role: null`). */
export const MembershipSyncRequestSchema = z.strictObject({
  ...AuthorityCommon,
  subject: SubjectSchema,
  app_organization_id: z.uuid(),
  role: OrgRoleSchema.nullable(),
});

/**
 * An organization's SSO setup: the WorkOS organization whose `externalId` is this app
 * organization, its connections (a connection left out becomes inactive), and the SSO policy.
 * `source_version` is the organization's own authority version.
 */
export const SsoOrganizationSyncRequestSchema = z.strictObject({
  operation_id: z.uuid(),
  actor: OperationActorSchema,
  source_version: SourceVersionSchema,
  app_organization_id: z.uuid(),
  workos_organization_id: WorkosIdSchema,
  workos_connection_ids: z.array(WorkosIdSchema).max(16),
  enforcement: z.enum(['off', 'optional', 'required']),
});

/** The path segment of each authority sync: `POST /internal/authority/<kind>`. */
export const AuthorityKindSchema = z.enum(['email', 'membership', 'sso-organization']);
export type AuthorityKind = z.infer<typeof AuthorityKindSchema>;

/**
 * `applied`, `already_applied` (the same `operation_id`, an effect that already holds, or a
 * source version older than one UTS applied) and `no_subject` are 200. `refused` (409) is final
 * for this request: `email_taken` (another account holds the address) or `connection_conflict`
 * (a WorkOS connection is active in another organization; it never moves while it is).
 */
export const AuthorityAnswerSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.enum(['applied', 'already_applied', 'no_subject']),
    operation_id: z.uuid(),
  }),
  z.strictObject({
    outcome: z.literal('refused'),
    error: z.enum(['email_taken', 'connection_conflict']),
  }),
]);
export type AuthorityAnswer = z.infer<typeof AuthorityAnswerSchema>;

/**
 * The event UTS writes, in the statement that creates the account, for every account a UTS
 * sign-in creates (`uts_` ids only; an imported account already has its app row). The app creates
 * its user row with `account.id` as the user id, so the account's `sub` names the same user in
 * both places. The app applies it idempotently by `account.id` and acknowledges `event_id`.
 */
export const AppUserCreatedEventSchema = z.strictObject({
  event_id: z.uuid(),
  type: z.literal('user.created'),
  occurred_at: z.iso.datetime(),
  account: z.strictObject({
    id: z.string().regex(UTS_CREATED_ACCOUNT_ID),
    primary_email: EmailSchema,
  }),
});
export type AppUserCreatedEvent = z.infer<typeof AppUserCreatedEventSchema>;

/** `POST /internal/app-events/read`: the oldest unacknowledged events, at most `limit`. */
export const AppEventsReadRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
});
export const AppEventsReadAnswerSchema = z.strictObject({
  events: z.array(AppUserCreatedEventSchema).max(100),
});

/** `POST /internal/app-events/ack`: acknowledged events leave the outbox; unknown ids count 0. */
export const AppEventsAckRequestSchema = z.strictObject({
  event_ids: z.array(z.uuid()).min(1).max(100),
});
export const AppEventsAckAnswerSchema = z.strictObject({
  acknowledged: z.number().int().min(0).max(100),
});
