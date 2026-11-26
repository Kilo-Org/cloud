import { z } from 'zod';

export const RuntimeResourceKindSchema = z.literal('cloud-agent-next');
export type RuntimeResourceKind = z.infer<typeof RuntimeResourceKindSchema>;

export function runtimeAuthorizationMaximumLifetimeMs(resourceKind: RuntimeResourceKind): number {
  switch (resourceKind) {
    case 'cloud-agent-next':
      return 24 * 60 * 60_000;
    default: {
      const exhaustive: never = resourceKind;
      return exhaustive;
    }
  }
}

/** Who were the two parties of the admitting credential: the user, or an automation. */
export const RuntimeAdmissionSourceSchema = z.enum(['user', 'automation']);
export type RuntimeAdmissionSource = z.infer<typeof RuntimeAdmissionSourceSchema>;

export const RuntimeAdmissionSchema = z.object({
  source: RuntimeAdmissionSourceSchema,
  authorizationUserId: z.string().min(1),
  authorizationPepper: z.string().nullable(),
});

/** Deployment environments that can mint and admit runtime authorization tokens. */
export const RuntimeEnvironmentSchema = z.enum(['production', 'development']);
export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;
export type RuntimeAdmission = z.infer<typeof RuntimeAdmissionSchema>;

/**
 * The deployment environment every runtime-token minter writes into the `env`
 * claim and the runtime compares it with. A missing or unrecognized value
 * resolves to `production`, so a mistyped configuration refuses
 * development-labelled tokens instead of admitting them.
 */
export function resolveRuntimeEnvironment(value: string | undefined): RuntimeEnvironment {
  return value === 'development' ? 'development' : 'production';
}

/**
 * The services that receive a Cloud Agent runtime token. Each destination gets
 * its own token, so the token one service accepts is refused by the others.
 */
export const RuntimeTokenDestinationSchema = z.enum(['kilo-api', 'kilo-gateway', 'session-ingest']);
export type RuntimeTokenDestination = z.infer<typeof RuntimeTokenDestinationSchema>;
export const RUNTIME_TOKEN_DESTINATIONS = RuntimeTokenDestinationSchema.options;

/** The runtime tokens of one issuance, one per destination, with one expiry. */
export const RuntimeTokensSchema = z
  .object({
    'kilo-api': z.string().min(1),
    'kilo-gateway': z.string().min(1),
    'session-ingest': z.string().min(1),
  })
  .strict();
export type RuntimeTokens = z.infer<typeof RuntimeTokensSchema>;

/**
 * How the issuer assigns runtime token audiences. `per-destination` mints one
 * single-audience token for each destination. `combined` mints the earlier
 * single token whose audience lists every destination; it remains only so the
 * rollout can return to it with a configuration change, until verifiers refuse
 * multi-audience tokens.
 */
export const RuntimeTokenAudienceModeSchema = z.enum(['combined', 'per-destination']);
export type RuntimeTokenAudienceMode = z.infer<typeof RuntimeTokenAudienceModeSchema>;

/**
 * The issuer mode a deployment configures. A missing value keeps `combined`,
 * the token shape every deployed reader handles; any other value must name a
 * mode, so a mistyped configuration fails closed instead of reverting.
 */
export function resolveRuntimeTokenAudienceMode(
  value: string | undefined
): RuntimeTokenAudienceMode {
  return value === undefined ? 'combined' : RuntimeTokenAudienceModeSchema.parse(value);
}

/** Whether `aud` is exactly the combined claim: every destination, in issuance order. */
export function isCombinedRuntimeTokenAudience(aud: unknown): boolean {
  return (
    Array.isArray(aud) &&
    aud.length === RUNTIME_TOKEN_DESTINATIONS.length &&
    RUNTIME_TOKEN_DESTINATIONS.every((value, index) => aud[index] === value)
  );
}

/**
 * Whether a stored runtime token may still be sent to `destination`: its
 * audience is exactly that destination, or exactly the combined claim. Either
 * issuer mode reads both forms, so a mode change renews nothing early; every
 * other layout is refused.
 */
export function isRuntimeTokenAudience(
  aud: unknown,
  destination: RuntimeTokenDestination
): boolean {
  return aud === destination || isCombinedRuntimeTokenAudience(aud);
}

/** A lowercase SHA-256 hex digest, the shape every runtime credential digest field uses. */
export const Sha256HexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nullablePepperDigest = z.union([Sha256HexDigestSchema, z.literal('null')]);

export const RuntimeAuthorizationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    resourceKind: RuntimeResourceKindSchema,
    resourceId: z.string().min(1),
    userId: z.string().min(1),
    authorizationUserId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    issuedAt: z.string().datetime(),
    delegationExpiresAt: z.string().datetime(),
    state: z.enum(['active', 'revoked']),
    bindings: z
      .object({
        userPepperDigest: nullablePepperDigest,
        authorizationPepperDigest: nullablePepperDigest,
        userMembershipId: z.string().min(1).optional(),
        authorizationUserMembershipId: z.string().min(1).optional(),
        /**
         * The device session that admitted a `device-access` credential, when
         * one did. A record minted before this field existed has none and
         * keeps its own lifetime; see `requireBindings`.
         */
        deviceSessionId: z.string().min(1).optional(),
      })
      .strict(),
    source: z
      .object({
        tokenSource: z.string().optional(),
        botId: z.string().optional(),
        createdOnPlatform: z.string().optional(),
        admissionSource: RuntimeAdmissionSourceSchema,
      })
      .strict(),
    env: z.string().optional(),
  })
  .strict()
  .superRefine((authorization, ctx) => {
    const issuedAt = Date.parse(authorization.issuedAt);
    const delegationExpiresAt = Date.parse(authorization.delegationExpiresAt);
    if (delegationExpiresAt <= issuedAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'Delegation expiration must follow issuance',
        path: ['delegationExpiresAt'],
      });
    }
    if (
      delegationExpiresAt >
      issuedAt + runtimeAuthorizationMaximumLifetimeMs(authorization.resourceKind)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Delegation expiration exceeds the resource maximum lifetime',
        path: ['delegationExpiresAt'],
      });
    }
  });

export type RuntimeAuthorization = z.infer<typeof RuntimeAuthorizationSchema>;
