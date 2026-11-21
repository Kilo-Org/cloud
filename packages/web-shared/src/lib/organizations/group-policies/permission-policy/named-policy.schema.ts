import type { NamedOrganizationPolicyKind } from '@kilocode/db/schema-types';
import * as z from 'zod';
import {
  AgentPermissionFields,
  MAX_MEMBER_PERMISSION_POLICY_BYTES,
  MAX_PERMISSION_POLICY_BYTES,
  MemberAgentPermissionsSchema,
  permissionPolicyEnvelope,
} from './permission-policy.schema';

export const NamedPolicyKindSchema = z.enum([
  'agent_permissions',
  'client_configuration',
] satisfies NamedOrganizationPolicyKind[]);

export const NAMED_POLICY_SCHEMA_VERSION = 1;
export const NAMED_POLICY_EXECUTION_OSES = ['linux', 'macos', 'windows'] as const;
const utf8 = new TextEncoder();

const agentPermissionSet = z.strictObject(AgentPermissionFields);
const agentPermissionsDocument = agentPermissionSet.extend({
  by_os: z.partialRecord(z.enum(NAMED_POLICY_EXECUTION_OSES), agentPermissionSet).optional(),
});
const clientConfigurationDocument = z.strictObject({
  disable_auto_approve: z.boolean().optional(),
  disable_telemetry: z.boolean().optional(),
  hide_session_dollar_values: z.boolean().optional(),
});

export const EffectiveNamedClientConfigurationSchema = z.strictObject({
  disable_auto_approve: z.literal(true).optional(),
  disable_telemetry: z.literal(true).optional(),
  hide_session_dollar_values: z.literal(true).optional(),
});

export const NamedMemberPermissionPolicySchema = z
  .discriminatedUnion('managed', [
    permissionPolicyEnvelope.extend({ managed: z.literal(false), policy: z.strictObject({}) }),
    permissionPolicyEnvelope.extend({
      managed: z.literal(true),
      policy: z.strictObject({
        agent_permissions: MemberAgentPermissionsSchema.optional(),
        client_configuration: EffectiveNamedClientConfigurationSchema.optional(),
      }),
    }),
  ])
  .refine(
    response => utf8.encode(JSON.stringify(response)).length <= MAX_MEMBER_PERMISSION_POLICY_BYTES,
    'Effective policy too large'
  );

export const NamedPolicyDocumentSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('agent_permissions'), document: agentPermissionsDocument }),
    z.strictObject({
      kind: z.literal('client_configuration'),
      document: clientConfigurationDocument,
    }),
  ])
  .refine(
    ({ document }) => utf8.encode(JSON.stringify(document)).length <= MAX_PERMISSION_POLICY_BYTES,
    'Policy too large'
  );

export type NamedPolicyDocument = z.infer<typeof NamedPolicyDocumentSchema>;
