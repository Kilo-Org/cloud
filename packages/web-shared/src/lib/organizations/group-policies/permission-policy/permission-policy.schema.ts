import type {
  OrganizationGroupAgentPermissionsPolicy,
  OrganizationGroupClientAccessPolicy,
} from '@kilocode/db/schema-types';
import { MAX_ORGANIZATION_GROUPS } from '@kilocode/db/schema-types';
import { FEATURE_VALUES } from '@kilocode/web-shared/lib/feature-detection';
import * as z from 'zod';

export const PERMISSION_POLICY_MAX_AGE_SECONDS = 300;
const MAX_POLICY_BYTES = 32 * 1024;
const MAX_MEMBER_POLICY_BYTES = 256 * 1024;
const MAX_RULES = 100;
const MAX_TOOLS = 100;
const MAX_LAYERS = MAX_ORGANIZATION_GROUPS + 1;
const utf8 = new TextEncoder();

const action = z.enum(['allow', 'ask', 'deny']);
const rules = z
  .array(
    z.strictObject({
      pattern: z
        .string()
        .min(1)
        .max(512)
        .regex(/\S/)
        .refine(pattern => !/\p{Cc}/u.test(pattern), 'Control characters are not allowed'),
      action,
    })
  )
  .max(MAX_RULES);
const toolRule = z.union([action, z.strictObject({ rules, fallback: action.optional() })]);
const shellProfile = z.strictObject({ fallback: z.enum(['ask', 'deny']), rules });

const AgentPermissionsDataSchema = z
  .strictObject({
    schema_version: z.literal(1),
    unrestricted_mode: z.enum(['allow', 'deny']).optional(),
    tools: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .refine(key => !/[^A-Za-z0-9_.*:-]/.test(key), 'Invalid tool key'),
        toolRule
      )
      .refine(tools => Object.keys(tools).length <= MAX_TOOLS, 'Too many tool permissions')
      .refine(
        tools => tools.bash === undefined || typeof tools.bash === 'string',
        'Use shell profiles for Bash command rules'
      )
      .optional(),
    shell: z
      .strictObject({ bash: shellProfile.optional(), powershell: shellProfile.optional() })
      .optional(),
  })
  .refine(data => utf8.encode(JSON.stringify(data)).length <= MAX_POLICY_BYTES, 'Policy too large');

const clientFeature = z.enum(FEATURE_VALUES);
const minVersion = z
  .string()
  .max(100)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'Expected a SemVer version'
  )
  .refine(version => version === version.trim(), 'Version must not contain surrounding whitespace');

const ClientAccessDataSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({
      schema_version: z.literal(1),
      mode: z.literal('allowlist'),
      clients: z
        .array(z.strictObject({ feature: clientFeature, min_version: minVersion.optional() }))
        .max(FEATURE_VALUES.length),
    }),
    z.strictObject({
      schema_version: z.literal(1),
      mode: z.literal('blocklist'),
      clients: z.array(z.strictObject({ feature: clientFeature })).max(FEATURE_VALUES.length),
    }),
  ])
  .refine(
    ({ clients }) => new Set(clients.map(client => client.feature)).size === clients.length,
    'Duplicate client feature'
  );

export const OrganizationGroupAgentPermissionsPolicySchema = z.strictObject({
  type: z.literal('agent_permissions'),
  data: AgentPermissionsDataSchema,
}) satisfies z.ZodType<OrganizationGroupAgentPermissionsPolicy>;

export const OrganizationGroupClientAccessPolicySchema = z.strictObject({
  type: z.literal('client_access'),
  data: ClientAccessDataSchema,
}) satisfies z.ZodType<OrganizationGroupClientAccessPolicy>;

export const OrganizationPermissionPolicyTypeSchema = z.enum([
  'agent_permissions',
  'client_access',
]);
export const OrganizationPermissionPolicySchema = z.discriminatedUnion('type', [
  OrganizationGroupAgentPermissionsPolicySchema,
  OrganizationGroupClientAccessPolicySchema,
]);

export type OrganizationPermissionPolicy = z.infer<typeof OrganizationPermissionPolicySchema>;

const permissionPolicyEnvelope = z.strictObject({
  schema_version: z.literal(1),
  organization_id: z.guid(),
  revision: z.int().nonnegative(),
  max_age_seconds: z.int().positive().max(PERMISSION_POLICY_MAX_AGE_SECONDS),
});

export const MemberPermissionPolicySchema = z
  .discriminatedUnion('managed', [
    permissionPolicyEnvelope.extend({ managed: z.literal(false), policy: z.strictObject({}) }),
    permissionPolicyEnvelope.extend({
      managed: z.literal(true),
      policy: z.strictObject({
        agent_permissions: z
          .strictObject({ layers: z.array(AgentPermissionsDataSchema).min(1).max(MAX_LAYERS) })
          .optional(),
        client_access: z
          .strictObject({ layers: z.array(ClientAccessDataSchema).min(1).max(MAX_LAYERS) })
          .optional(),
      }),
    }),
  ])
  .refine(
    response => utf8.encode(JSON.stringify(response)).length <= MAX_MEMBER_POLICY_BYTES,
    'Effective policy too large'
  );

export type MemberPermissionPolicy = z.infer<typeof MemberPermissionPolicySchema>;
