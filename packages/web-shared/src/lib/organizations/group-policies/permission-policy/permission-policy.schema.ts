import type { OrganizationGroupAgentPermissionsPolicy } from '@kilocode/db/schema-types';
import { MAX_ORGANIZATION_GROUPS } from '@kilocode/app-shared/organizations';
import * as z from 'zod';

export const PERMISSION_POLICY_MAX_AGE_SECONDS = 300;
export const MAX_PERMISSION_POLICY_BYTES = 32 * 1024;
export const MAX_MEMBER_PERMISSION_POLICY_BYTES = 256 * 1024;
export const ORGANIZATION_GROUP_AGENT_PERMISSIONS_POLICY_TYPE = 'agent_permissions';
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
// A tool's rule is either a string action, which is that tool's default action for
// every call, or an object holding patterns (last matching pattern wins) and an
// optional default for the calls no pattern matches; an object without a default
// states no decision of its own for those calls.
const toolRule = z.union([action, z.strictObject({ rules, fallback: action.optional() })]);
// A shell profile holds the command rules for one shell kind plus that profile's
// own default for commands no rule matches. The default stops short of `allow`, so
// an unmatched command stays guarded; a listed rule, including a `*` rule, can
// still allow the commands it covers.
const shellProfile = z.strictObject({ fallback: z.enum(['ask', 'deny']), rules });

export const AgentPermissionFields = {
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
    // `tools.bash` and `shell.bash`/`shell.powershell` describe different halves of
    // the same policy. A string `tools.bash` action is the default for the whole
    // Bash tool; the shell profiles carry the per-command rules and their own
    // default. Both forms are valid together, and `tools.bash` objects stay
    // rejected because command rules belong in a shell profile.
    //
    // The intended contract for a client that reads these layers is that both
    // forms apply in every layer that states either, and the more restrictive
    // outcome wins (`deny` over `ask` over `allow`) within a layer and across
    // layers. Neither form overrides the other, so a permissive `tools.bash`
    // cannot lift a shell rule or shell default, and a restrictive `tools.bash`
    // narrows an allowing shell profile. A layer that has a `shell` block denies a
    // Bash command when the block names no profile for the shell that runs the
    // command, and when the command's shell cannot be parsed at all; a layer with no
    // `shell` block states nothing about Bash and leaves the decision to its `tools`
    // entry.
    .refine(
      tools => tools.bash === undefined || typeof tools.bash === 'string',
      'Use shell profiles for Bash command rules'
    )
    .optional(),
  shell: z
    .strictObject({ bash: shellProfile.optional(), powershell: shellProfile.optional() })
    .optional(),
};

const AgentPermissionsDataSchema = z
  .strictObject({ schema_version: z.literal(1), ...AgentPermissionFields })
  .refine(
    data => utf8.encode(JSON.stringify(data)).length <= MAX_PERMISSION_POLICY_BYTES,
    'Policy too large'
  );

export const OrganizationGroupAgentPermissionsPolicySchema = z.strictObject({
  type: z.literal(ORGANIZATION_GROUP_AGENT_PERMISSIONS_POLICY_TYPE),
  data: AgentPermissionsDataSchema,
}) satisfies z.ZodType<OrganizationGroupAgentPermissionsPolicy>;

export const OrganizationPermissionPolicyTypeSchema = z.enum([
  ORGANIZATION_GROUP_AGENT_PERMISSIONS_POLICY_TYPE,
]);
export const OrganizationPermissionPolicySchema = OrganizationGroupAgentPermissionsPolicySchema;

export type OrganizationPermissionPolicy = z.infer<typeof OrganizationPermissionPolicySchema>;

export function isOrganizationPermissionPolicyType(
  type: string
): type is z.infer<typeof OrganizationPermissionPolicyTypeSchema> {
  return OrganizationPermissionPolicyTypeSchema.safeParse(type).success;
}

export const permissionPolicyEnvelope = z.strictObject({
  schema_version: z.literal(1),
  organization_id: z.guid(),
  revision: z.int().nonnegative(),
  max_age_seconds: z.int().positive().max(PERMISSION_POLICY_MAX_AGE_SECONDS),
});

export const MemberAgentPermissionsSchema = z.strictObject({
  layers: z.array(AgentPermissionsDataSchema).min(1).max(MAX_LAYERS),
});

export const MemberPermissionPolicySchema = z
  .discriminatedUnion('managed', [
    permissionPolicyEnvelope.extend({ managed: z.literal(false), policy: z.strictObject({}) }),
    permissionPolicyEnvelope.extend({
      managed: z.literal(true),
      policy: z.strictObject({
        agent_permissions: MemberAgentPermissionsSchema.optional(),
      }),
    }),
  ])
  .refine(
    response => utf8.encode(JSON.stringify(response)).length <= MAX_MEMBER_PERMISSION_POLICY_BYTES,
    'Effective policy too large'
  );

export type MemberPermissionPolicy = z.infer<typeof MemberPermissionPolicySchema>;
