import { z } from 'zod';

export const RuntimeResourceKindSchema = z.enum(['cloud-agent-next', 'gastown']);
export type RuntimeResourceKind = z.infer<typeof RuntimeResourceKindSchema>;

export function runtimeAuthorizationMaximumLifetimeMs(resourceKind: RuntimeResourceKind): number {
  switch (resourceKind) {
    case 'cloud-agent-next':
      return 24 * 60 * 60_000;
    case 'gastown':
      return 30 * 24 * 60 * 60_000;
    default: {
      const exhaustive: never = resourceKind;
      return exhaustive;
    }
  }
}

export const RuntimeAdmissionSchema = z.object({
  source: z.enum(['user', 'automation']),
  authorizationUserId: z.string().min(1),
  authorizationPepper: z.string().nullable(),
});
export type RuntimeAdmission = z.infer<typeof RuntimeAdmissionSchema>;

const pepperDigest = z.string().regex(/^[a-f0-9]{64}$/);
const nullablePepperDigest = z.union([pepperDigest, z.literal('null')]);

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
      })
      .strict(),
    source: z
      .object({
        tokenSource: z.string().optional(),
        botId: z.string().optional(),
        createdOnPlatform: z.string().optional(),
        admissionSource: z.enum(['user', 'automation']),
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
