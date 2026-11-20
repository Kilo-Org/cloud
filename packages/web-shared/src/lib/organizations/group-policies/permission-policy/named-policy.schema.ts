import type { NamedOrganizationPolicyKind } from '@kilocode/db/schema-types';
import * as z from 'zod';
import { AgentPermissionFields, MAX_PERMISSION_POLICY_BYTES } from './permission-policy.schema';

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
