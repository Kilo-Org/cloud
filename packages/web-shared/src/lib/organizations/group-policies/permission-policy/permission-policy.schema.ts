import {
  MAX_ORGANIZATION_GROUPS,
  type OrganizationGroupAgentPermissionsPolicy,
  type OrganizationGroupClientConfigurationPolicy,
} from '@kilocode/db/schema-types';
import * as z from 'zod';

export const PERMISSION_POLICY_MAX_AGE_SECONDS = 300;
export const PERMISSION_POLICY_OS_ADDITIONS = ['linux', 'macos', 'windows'] as const;
export const PermissionPolicyExecutionOsSchema = z.enum([
  ...PERMISSION_POLICY_OS_ADDITIONS,
  'other',
]);
export type PermissionPolicyExecutionOs = z.infer<typeof PermissionPolicyExecutionOsSchema>;

const MAX_POLICY_BYTES = 32 * 1024;
const MAX_MEMBER_POLICY_BYTES = 256 * 1024;
const MAX_RULES = 100;
const MAX_TOOLS = 100;
const MAX_LAYERS = 2 * (MAX_ORGANIZATION_GROUPS + 1);
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

const AgentPermissionSetSchema = z.strictObject({
  unrestricted_mode: z.enum(['allow', 'deny']).optional(),
  auto_approve: z.literal('deny').optional(),
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
});

const agentPermissionsLayerShape = {
  schema_version: z.literal(1),
  ...AgentPermissionSetSchema.shape,
};

function isPolicySizeValid(data: object) {
  return utf8.encode(JSON.stringify(data)).length <= MAX_POLICY_BYTES;
}

const AgentPermissionsLayerSchema = z
  .strictObject(agentPermissionsLayerShape)
  .refine(isPolicySizeValid, 'Policy too large');

const AgentPermissionsDataSchema = z
  .strictObject({
    ...agentPermissionsLayerShape,
    by_os: z
      .strictObject({
        linux: AgentPermissionSetSchema,
        macos: AgentPermissionSetSchema,
        windows: AgentPermissionSetSchema,
      })
      .partial()
      .optional(),
  })
  .refine(isPolicySizeValid, 'Policy too large');

export const OrganizationGroupAgentPermissionsPolicySchema = z.strictObject({
  type: z.literal('agent_permissions'),
  data: AgentPermissionsDataSchema,
}) satisfies z.ZodType<OrganizationGroupAgentPermissionsPolicy>;

const ClientConfigurationSchema = z.strictObject({ show_session_dollar_values: z.boolean() });

export const OrganizationGroupClientConfigurationPolicySchema = z.strictObject({
  type: z.literal('client_configuration'),
  data: z.strictObject({ schema_version: z.literal(1), ...ClientConfigurationSchema.shape }),
}) satisfies z.ZodType<OrganizationGroupClientConfigurationPolicy>;

export const OrganizationPermissionPolicyTypeSchema = z.enum([
  'agent_permissions',
  'client_configuration',
]);
export const OrganizationPermissionPolicySchema = z.discriminatedUnion('type', [
  OrganizationGroupAgentPermissionsPolicySchema,
  OrganizationGroupClientConfigurationPolicySchema,
]);

export type AgentPermissionSet = z.infer<typeof AgentPermissionSetSchema>;
export type AgentPermissionsPolicy = z.infer<typeof OrganizationGroupAgentPermissionsPolicySchema>;
export type ClientConfigurationPolicy = z.infer<
  typeof OrganizationGroupClientConfigurationPolicySchema
>;
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
          .strictObject({ layers: z.array(AgentPermissionsLayerSchema).min(1).max(MAX_LAYERS) })
          .optional(),
        client_configuration: ClientConfigurationSchema.optional(),
      }),
    }),
  ])
  .refine(
    response => utf8.encode(JSON.stringify(response)).length <= MAX_MEMBER_POLICY_BYTES,
    'Effective policy too large'
  );

export type MemberPermissionPolicy = z.infer<typeof MemberPermissionPolicySchema>;
