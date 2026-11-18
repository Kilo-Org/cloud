import { z } from 'zod';
import { egressDomainSchema } from './egress-allowlist';
import { setupScriptSchema } from './setup-script';

export const environmentSetupClaimSchema = z
  .object({ runId: z.uuid(), environmentId: z.uuid() })
  .strict();

const runId = z.uuid();
const auditCursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const checkSchema = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().min(1).max(2000),
    expect: z.string().min(1).max(500),
  })
  .strict();
const childSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

export const environmentSetupAgentOperations = {
  getDraft: { kind: 'query', schema: z.object({ runId, auditCursor }).strict() },
  updateDraft: {
    kind: 'mutation',
    schema: z
      .object({
        runId,
        expectedRevision: z.number().int().positive(),
        script: setupScriptSchema.optional(),
        plainVars: z.record(z.string().min(1).max(128), z.string().max(256)).optional(),
        secrets: z
          .array(
            z.union([
              z
                .object({
                  key: z.string().min(1).max(128),
                  value: z.string().min(1).max(8192),
                })
                .strict(),
              z.object({ key: z.string().min(1).max(128), delete: z.literal(true) }).strict(),
            ])
          )
          .max(50)
          .optional(),
        sandboxAllocation: z.string().min(1).max(100).nullable().optional(),
        requiredHosts: z.array(egressDomainSchema).max(50).optional(),
      })
      .strict(),
  },
  requestSecrets: {
    kind: 'mutation',
    schema: z
      .object({
        runId,
        secrets: z
          .array(
            z
              .object({
                key: z.string().min(1).max(128),
                reason: z.string().min(1).max(500),
                references: z
                  .array(
                    z
                      .object({
                        repoFullName: z.string().min(3).max(200),
                        path: z.string().min(1).max(500),
                        line: z.number().int().min(1),
                      })
                      .strict()
                  )
                  .min(1)
                  .max(5),
              })
              .strict()
          )
          .min(1)
          .max(10),
      })
      .strict(),
  },
  requestNetworkHosts: {
    kind: 'mutation',
    schema: z
      .object({
        runId,
        childSessionId: childSessionIdSchema.optional(),
        auditCursor,
        hosts: z
          .array(
            z.object({ host: egressDomainSchema, reason: z.string().min(1).max(500) }).strict()
          )
          .min(1)
          .max(20),
      })
      .strict(),
  },
  startVerification: {
    kind: 'mutation',
    schema: z.object({ runId, checks: z.array(checkSchema).min(1).max(10) }).strict(),
  },
  recordVerification: {
    kind: 'mutation',
    schema: z
      .object({
        runId,
        childSessionId: childSessionIdSchema,
        results: z
          .array(
            z
              .object({
                name: z.string().min(1).max(100),
                passed: z.boolean(),
                evidence: z.string().max(2000),
              })
              .strict()
          )
          .min(1)
          .max(10),
      })
      .strict(),
  },
  complete: {
    kind: 'mutation',
    schema: z.object({ runId, summary: z.string().min(1).max(5000) }).strict(),
  },
  fail: {
    kind: 'mutation',
    schema: z.object({ runId, reason: z.string().min(1).max(2000) }).strict(),
  },
} as const;

export const environmentSetupChildOperations = {
  getEgressAudit: {
    kind: 'query',
    schema: z
      .object({
        cloudAgentSessionId: childSessionIdSchema,
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
  },
} as const;

export const ENVIRONMENT_SETUP_PROCEDURE_PREFIX = 'cloudEnvironments.setupRuns.agent.';

export function environmentSetupProcedure(name: keyof typeof environmentSetupAgentOperations) {
  return `${ENVIRONMENT_SETUP_PROCEDURE_PREFIX}${name}`;
}
