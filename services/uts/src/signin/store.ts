import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';
import { AUTH_METHODS, type WEBAUTHN_CEREMONIES } from '../db/enums';
import type { DeviceContext, ProofBinding } from '../grants/store';

/**
 * The sign-in statements (migration `0008_passkeys_device_tickets.sql`): browser sessions,
 * WebAuthn challenges and passkeys, step-ups and the device grant. Each call is one SQL statement,
 * a SECURITY DEFINER function that writes its rows and audit row together, or a read. Results
 * arrive as one row whose `outcome` column picks the shape.
 */

export type AuthMethod = (typeof AUTH_METHODS)[number];

/** The signed-in user of a browser session. */
export type BrowserSession = {
  sessionId: string;
  accountId: string;
  authTime: Date;
  amr: AuthMethod[];
};

/** Where a request came from, for a browser session's row (design 8.2 network fields). */
export type NetworkContext = {
  userAgent: string | null;
  clientIp: string | null;
  asn: number | null;
  country: string | null;
  city: string | null;
};

export type Ceremony = (typeof WEBAUTHN_CEREMONIES)[number];

/** A passkey as WebAuthn options list it (`excludeCredentials`, `allowCredentials`). */
export type PasskeyDescriptor = { credentialId: Uint8Array; transports: string[] };

export type ChallengeInput = {
  ceremony: Ceremony;
  challengeHash: Uint8Array;
  rpId: string;
  /** The session cookie's hash; null for a sign-in. */
  sessionTokenHash: Uint8Array | null;
  /** A registration's user handle when the account has no passkey yet. */
  newUserHandle: Uint8Array | null;
};

export type ChallengeResult =
  | {
      outcome: 'created';
      /** A registration's user name and handle; null for the other ceremonies. */
      registration: { accountEmail: string; userHandle: Uint8Array } | null;
      /** A registration's passkeys to exclude, or a step-up's passkeys to allow. */
      passkeys: PasskeyDescriptor[];
    }
  | { outcome: 'no_session' | 'no_passkey' | 'limit_reached' };

export type AssertionInput = {
  ceremony: 'sign_in' | 'step_up';
  challengeHash: Uint8Array;
  credentialId: Uint8Array;
  sessionTokenHash: Uint8Array | null;
};

export type StoredPasskey = {
  passkeyId: string;
  accountId: string;
  publicKey: Uint8Array;
  signCount: bigint;
  userHandle: Uint8Array;
  transports: string[];
};

export type AssertionRead =
  | ({ outcome: 'ok' } & StoredPasskey)
  | { outcome: 'unknown_challenge' | 'unknown_passkey' };

/** The counter move of a verified assertion. */
export type PasskeyUse = {
  challengeHash: Uint8Array;
  passkeyId: string;
  previousCount: bigint;
  newCount: bigint;
  backedUp: boolean;
};

export type SignInInput = PasskeyUse & {
  environment: UtsEnvironment;
  sessionTokenHash: Uint8Array;
  network: NetworkContext;
};

export type SignInResult =
  | { outcome: 'signed_in'; session: BrowserSession }
  | { outcome: 'challenge_used' | 'counter_conflict' | 'account_inactive' | 'sso_required' };

export type StepUpInput = PasskeyUse & {
  environment: UtsEnvironment;
  sessionTokenHash: Uint8Array;
};

export type StepUpResult =
  | { outcome: 'completed'; stepUpId: string; expiresAt: Date }
  | { outcome: 'no_session' | 'challenge_used' | 'counter_conflict' };

export type RegistrationInput = {
  environment: UtsEnvironment;
  challengeHash: Uint8Array;
  sessionTokenHash: Uint8Array;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  signCount: bigint;
  aaguid: string | null;
  transports: string[];
  backupEligible: boolean;
  backedUp: boolean;
  name: string;
};

export type RegistrationResult =
  | { outcome: 'registered'; passkeyId: string }
  | {
      outcome:
        | 'no_session'
        | 'challenge_used'
        | 'gate_required'
        | 'already_registered'
        | 'limit_reached';
    };

export type DeviceCodeInput = {
  deviceCodeHash: Uint8Array;
  userCodeHash: Uint8Array;
  clientId: string;
  /** A canonical scope set: unique and in ascending byte order. */
  scopes: readonly string[];
  network: NetworkContext;
};

export type DeviceCodeCreated =
  | { outcome: 'created'; expiresAt: Date; interval: number }
  | { outcome: 'user_code_taken' }
  | { outcome: 'too_many_pending' };

/** What the approval page shows of a pending device sign-in (design 5.4). */
export type PendingDevice = {
  clientId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  country: string | null;
  city: string | null;
};

export type DeviceCodeRead =
  | ({ outcome: 'pending' } & PendingDevice)
  | { outcome: 'no_session' | 'unknown_code' | 'too_many_attempts' };

/**
 * Where the user code on the device page came from: typed by the user, or filled in from the
 * verification URL (RFC 8628 `verification_uri_complete`), which someone else may have sent.
 */
export type UserCodeSource = 'typed' | 'link';

/** A user code entered on the device page, and who entered it from where. */
export type UserCodeEntry = {
  userCodeHash: Uint8Array;
  sessionTokenHash: Uint8Array;
  /** The connecting address; its network shares one count of wrong codes. */
  clientIp: string | null;
};

export type DeviceDecisionInput = UserCodeEntry & {
  environment: UtsEnvironment;
  source: UserCodeSource;
  approve: boolean;
};

export type DeviceDecision =
  | 'approved'
  | 'denied'
  | 'no_session'
  | 'unknown_code'
  | 'too_many_attempts'
  | 'gate_required';

export type DeviceExchangeInput = {
  environment: UtsEnvironment;
  deviceCodeHash: Uint8Array;
  clientId: string;
  clientClass: 'desktop' | 'mobile';
  proof: ProofBinding;
  /** Derived from the device code (`grantIdOfCode`), so every attempt names one grant. */
  grantId: string;
  refreshTokenHash: Uint8Array;
  device: DeviceContext;
  scopes: readonly string[] | null;
  resources: readonly string[] | null;
};

export type DeviceExchangeResult =
  | {
      outcome: 'issued';
      subjectId: string;
      orgId: string | null;
      authTime: Date;
      amr: string[];
      tokenIds: string[];
      scopes: string[];
      refreshExpiresAt: Date;
    }
  | {
      outcome:
        | 'authorization_pending'
        | 'slow_down'
        | 'access_denied'
        | 'expired_token'
        | 'invalid_grant'
        | 'invalid_scope'
        | 'invalid_target'
        | 'dpop_replay';
    };

export type SignInStore = {
  readSession(sessionTokenHash: Uint8Array): Promise<BrowserSession | null>;
  createChallenge(input: ChallengeInput): Promise<ChallengeResult>;
  readAssertion(input: AssertionInput): Promise<AssertionRead>;
  completeSignIn(input: SignInInput): Promise<SignInResult>;
  completeStepUp(input: StepUpInput): Promise<StepUpResult>;
  recordPasskeyFailure(
    environment: UtsEnvironment,
    passkeyId: string,
    ceremony: 'sign_in' | 'step_up',
    reason: string
  ): Promise<void>;
  registerPasskey(input: RegistrationInput): Promise<RegistrationResult>;
  createDeviceCode(input: DeviceCodeInput): Promise<DeviceCodeCreated>;
  readDeviceCode(entry: UserCodeEntry): Promise<DeviceCodeRead>;
  decideDeviceCode(input: DeviceDecisionInput): Promise<DeviceDecision>;
  exchangeDeviceCode(input: DeviceExchangeInput): Promise<DeviceExchangeResult>;
};

/** Runs `work` with the sign-in statements of one request's identity-store connection. */
export type SignInAccess = <Result>(
  work: (store: SignInStore) => Promise<Result>
) => Promise<Result>;

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function signInAccess(connectionString: string, context: WaitUntil): SignInAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreSignIn(store)));
}

const bytes = z.instanceof(Uint8Array);
const amr = z.array(z.enum(AUTH_METHODS)).min(1);

const SessionRowSchema = z.object({
  session_id: z.uuid(),
  session_account: z.string(),
  session_auth_time: z.date(),
  session_amr: amr,
});

const ChallengeRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    account_email: z.string().nullable(),
    user_handle: bytes.nullable(),
    credential_ids: z.array(bytes).nullable(),
    credential_transports: z.array(z.string()).nullable(),
  }),
  z.object({ outcome: z.enum(['no_session', 'no_passkey', 'limit_reached']) }),
]);

const AssertionRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    passkey_id: z.uuid(),
    passkey_account: z.string(),
    public_key: bytes,
    sign_count: z.bigint(),
    user_handle: bytes,
    transports: z.array(z.string()),
  }),
  z.object({ outcome: z.enum(['unknown_challenge', 'unknown_passkey']) }),
]);

const SignInRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('signed_in'),
    session_id: z.uuid(),
    session_account: z.string(),
    signed_in_at: z.date(),
  }),
  z.object({
    outcome: z.enum(['challenge_used', 'counter_conflict', 'account_inactive', 'sso_required']),
  }),
]);

const StepUpRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('completed'), step_up_id: z.uuid(), step_up_expires_at: z.date() }),
  z.object({ outcome: z.enum(['no_session', 'challenge_used', 'counter_conflict']) }),
]);

const RegistrationRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('registered'), passkey_id: z.uuid() }),
  z.object({
    outcome: z.enum([
      'no_session',
      'challenge_used',
      'gate_required',
      'already_registered',
      'limit_reached',
    ]),
  }),
]);

const DeviceCodeCreatedRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    code_expires_at: z.date(),
    interval_seconds: z.number().int().positive(),
  }),
  z.object({ outcome: z.literal('user_code_taken') }),
  z.object({ outcome: z.literal('too_many_pending') }),
]);

const DeviceCodeReadRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('pending'),
    code_client_id: z.string(),
    code_scopes: z.array(z.string()).min(1),
    code_created_at: z.date(),
    code_expires_at: z.date(),
    code_user_agent: z.string().nullable(),
    code_country: z.string().nullable(),
    code_city: z.string().nullable(),
  }),
  z.object({ outcome: z.enum(['no_session', 'unknown_code', 'too_many_attempts']) }),
]);

const DeviceDecisionRowSchema = z.object({
  outcome: z.enum([
    'approved',
    'denied',
    'no_session',
    'unknown_code',
    'too_many_attempts',
    'gate_required',
  ]),
});

const DeviceExchangeRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    subject_id: z.string(),
    bound_org_id: z.uuid().nullable(),
    signed_in_at: z.date(),
    sign_in_methods: z.array(z.string()).min(1),
    token_ids: z.array(z.uuid()).min(1),
    token_scopes: z.array(z.string()).min(1),
    refresh_expires_at: z.date(),
  }),
  z.object({
    outcome: z.enum([
      'authorization_pending',
      'slow_down',
      'access_denied',
      'expired_token',
      'invalid_grant',
      'invalid_scope',
      'invalid_target',
      'dpop_replay',
    ]),
  }),
]);

/** The transports of each listed passkey travel as one comma-joined text per passkey. */
function descriptors(ids: Uint8Array[] | null, transports: string[] | null): PasskeyDescriptor[] {
  return (ids ?? []).map((credentialId, index) => {
    const joined = transports?.[index] ?? '';
    return { credentialId, transports: joined === '' ? [] : joined.split(',') };
  });
}

/** Every sign-in statement over one identity-store connection. */
export function identityStoreSignIn(store: IdentityStore): SignInStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a sign-in function returned no row');
    return result;
  }

  return {
    async readSession(sessionTokenHash) {
      const row = await store.maybeOne(
        { text: 'SELECT * FROM uts.read_browser_session($1)', values: [sessionTokenHash] },
        SessionRowSchema
      );
      return row === null
        ? null
        : {
            sessionId: row.session_id,
            accountId: row.session_account,
            authTime: row.session_auth_time,
            amr: row.session_amr,
          };
    },

    async createChallenge(input) {
      const row = await one(
        'SELECT * FROM uts.create_webauthn_challenge($1, $2, $3, $4, $5)',
        [
          input.ceremony,
          input.challengeHash,
          input.rpId,
          input.sessionTokenHash,
          input.newUserHandle,
        ],
        ChallengeRowSchema
      );
      if (row.outcome !== 'created') return { outcome: row.outcome };
      const passkeys = descriptors(row.credential_ids, row.credential_transports);
      if (input.ceremony !== 'registration') {
        return { outcome: 'created', registration: null, passkeys };
      }
      if (row.account_email === null || row.user_handle === null) {
        throw new Error('a registration challenge returned no user');
      }
      return {
        outcome: 'created',
        registration: { accountEmail: row.account_email, userHandle: row.user_handle },
        passkeys,
      };
    },

    async readAssertion(input) {
      const row = await one(
        'SELECT * FROM uts.read_passkey_assertion($1, $2, $3, $4)',
        [input.ceremony, input.challengeHash, input.credentialId, input.sessionTokenHash],
        AssertionRowSchema
      );
      if (row.outcome !== 'ok') return { outcome: row.outcome };
      return {
        outcome: 'ok',
        passkeyId: row.passkey_id,
        accountId: row.passkey_account,
        publicKey: row.public_key,
        signCount: row.sign_count,
        userHandle: row.user_handle,
        transports: row.transports,
      };
    },

    async completeSignIn(input) {
      const row = await one(
        'SELECT * FROM uts.complete_passkey_sign_in($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          input.environment,
          input.challengeHash,
          input.passkeyId,
          input.previousCount,
          input.newCount,
          input.backedUp,
          input.sessionTokenHash,
          input.network.userAgent,
          input.network.clientIp,
          input.network.asn,
          input.network.country,
          input.network.city,
        ],
        SignInRowSchema
      );
      if (row.outcome !== 'signed_in') return { outcome: row.outcome };
      return {
        outcome: 'signed_in',
        session: {
          sessionId: row.session_id,
          accountId: row.session_account,
          authTime: row.signed_in_at,
          amr: ['passkey'],
        },
      };
    },

    async completeStepUp(input) {
      const row = await one(
        'SELECT * FROM uts.complete_passkey_step_up($1, $2, $3, $4, $5, $6, $7)',
        [
          input.environment,
          input.challengeHash,
          input.sessionTokenHash,
          input.passkeyId,
          input.previousCount,
          input.newCount,
          input.backedUp,
        ],
        StepUpRowSchema
      );
      if (row.outcome !== 'completed') return { outcome: row.outcome };
      return { outcome: 'completed', stepUpId: row.step_up_id, expiresAt: row.step_up_expires_at };
    },

    async recordPasskeyFailure(environment, passkeyId, ceremony, reason) {
      await store.rows(
        {
          text: 'SELECT uts.record_passkey_failure($1, $2, $3, $4)',
          values: [environment, passkeyId, ceremony, reason],
        },
        z.unknown()
      );
    },

    async registerPasskey(input) {
      const row = await one(
        'SELECT * FROM uts.register_passkey($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          input.environment,
          input.challengeHash,
          input.sessionTokenHash,
          input.credentialId,
          input.publicKey,
          input.signCount,
          input.aaguid,
          input.transports,
          input.backupEligible,
          input.backedUp,
          input.name,
        ],
        RegistrationRowSchema
      );
      if (row.outcome !== 'registered') return { outcome: row.outcome };
      return { outcome: 'registered', passkeyId: row.passkey_id };
    },

    async createDeviceCode(input) {
      const row = await one(
        'SELECT * FROM uts.create_device_code($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          input.deviceCodeHash,
          input.userCodeHash,
          input.clientId,
          input.scopes,
          input.network.userAgent,
          input.network.clientIp,
          input.network.asn,
          input.network.country,
          input.network.city,
        ],
        DeviceCodeCreatedRowSchema
      );
      if (row.outcome !== 'created') return { outcome: row.outcome };
      return { outcome: 'created', expiresAt: row.code_expires_at, interval: row.interval_seconds };
    },

    async readDeviceCode(entry) {
      const row = await one(
        'SELECT * FROM uts.read_device_code($1, $2, $3)',
        [entry.userCodeHash, entry.sessionTokenHash, entry.clientIp],
        DeviceCodeReadRowSchema
      );
      if (row.outcome !== 'pending') return { outcome: row.outcome };
      return {
        outcome: 'pending',
        clientId: row.code_client_id,
        scopes: row.code_scopes,
        createdAt: row.code_created_at,
        expiresAt: row.code_expires_at,
        userAgent: row.code_user_agent,
        country: row.code_country,
        city: row.code_city,
      };
    },

    async decideDeviceCode(input) {
      const row = await one(
        'SELECT * FROM uts.decide_device_code($1, $2, $3, $4, $5, $6)',
        [
          input.environment,
          input.userCodeHash,
          input.sessionTokenHash,
          input.clientIp,
          input.source === 'typed',
          input.approve,
        ],
        DeviceDecisionRowSchema
      );
      return row.outcome;
    },

    async exchangeDeviceCode(input) {
      const row = await one(
        'SELECT * FROM uts.exchange_device_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
        [
          input.environment,
          input.deviceCodeHash,
          input.clientId,
          input.clientClass,
          input.proof.jkt,
          input.proof.jti,
          input.grantId,
          input.refreshTokenHash,
          input.device.label,
          input.device.platform,
          input.device.clientIp,
          input.device.asn,
          input.device.country,
          input.device.city,
          input.scopes,
          input.resources,
        ],
        DeviceExchangeRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return {
        outcome: 'issued',
        subjectId: row.subject_id,
        orgId: row.bound_org_id,
        authTime: row.signed_in_at,
        amr: row.sign_in_methods,
        tokenIds: row.token_ids,
        scopes: row.token_scopes,
        refreshExpiresAt: row.refresh_expires_at,
      };
    },
  };
}
