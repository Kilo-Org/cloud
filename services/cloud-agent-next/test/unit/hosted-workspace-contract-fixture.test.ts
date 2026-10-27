import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudAgentWorktreeDeletionManifestSchema } from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../src/db/pg.js', () => ({ getPgDb: vi.fn() }));
vi.mock('../../src/session/model-preflight.js', () => ({
  preflightSessionRuntime: vi.fn().mockResolvedValue(undefined),
  preflightExistingPromptModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn(), Sandbox: class {} }));

import {
  CreateHostedWorkspaceInput,
  CreateHostedWorkspaceOutput,
  DeleteHostedWorkspaceSessionInput,
  DeleteHostedWorkspaceSessionOutput,
} from '../../src/router/handlers/hosted-workspace-mutations.js';
import {
  getHostedWorkspaceInput,
  getHostedWorkspaceOutput,
  listHostedWorkspacesInput,
  listHostedWorkspacesOutput,
} from '../../src/router/handlers/hosted-workspace-list.js';
import {
  getHostedWorkspaceStatusInput,
  getHostedWorkspaceStatusOutput,
} from '../../src/router/handlers/hosted-workspace-status.js';
import {
  CreateHostedWorkspaceSessionInput,
  CreateHostedWorkspaceSessionOutput,
} from '../../src/router/handlers/session-worktree.js';
import {
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
} from '../../src/router/handlers/worktree-deletion.js';
import { appRouter } from '../../src/router.js';
import {
  SandboxLifecycleStatusSchema,
  SandboxProviderLabelSchema,
  SandboxStatusDetailCodeSchema,
} from '../../src/shared/sandbox-status.js';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/hosted-workspace-contract'
);
const handlerDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/router/handlers'
);
const sessionRegistrationSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/session/session-registration.ts'
);
const contractSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/session-ingest-contracts/src/rpc-contract.ts'
);

const entrySchema = z
  .object({
    procedure: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1),
    example: z.unknown(),
  })
  .strict();

const fixtureSchema = z
  .object({
    contractVersion: z.literal(1),
    deletionManifestVersion: z.number().int().positive(),
    procedures: z.record(z.string(), z.enum(['query', 'mutation'])),
    requests: z.array(entrySchema),
    responses: z.array(entrySchema),
    status: z
      .object({
        computeStatuses: z.array(z.string().min(1)),
        detailCodes: z.array(z.string().min(1)),
        providers: z.array(z.string().min(1)),
        deletionStates: z.array(z.string().min(1)),
        deletionPhases: z.array(z.string().min(1)),
        wakeBlockedReasons: z.array(z.string().min(1)),
      })
      .strict(),
    errorCodes: z.array(z.string().min(1)).min(1),
  })
  .strict();

type Fixture = z.infer<typeof fixtureSchema>;
type FixtureEntry = Fixture['requests'][number];

type SchemaLike = {
  parse(value: unknown): unknown;
};

const requestSchemas: Record<string, unknown> = {
  listHostedWorkspaces: listHostedWorkspacesInput,
  getHostedWorkspace: getHostedWorkspaceInput,
  getHostedWorkspaceStatus: getHostedWorkspaceStatusInput,
  createHostedWorkspace: CreateHostedWorkspaceInput,
  createHostedWorkspaceSession: CreateHostedWorkspaceSessionInput,
  deleteHostedWorkspaceSession: DeleteHostedWorkspaceSessionInput,
  deleteWorktree: DeleteWorktreeInput,
};

const responseSchemas: Record<string, unknown> = {
  listHostedWorkspaces: listHostedWorkspacesOutput,
  getHostedWorkspace: getHostedWorkspaceOutput,
  getHostedWorkspaceStatus: getHostedWorkspaceStatusOutput,
  createHostedWorkspace: CreateHostedWorkspaceOutput,
  createHostedWorkspaceSession: CreateHostedWorkspaceSessionOutput,
  deleteHostedWorkspaceSession: DeleteHostedWorkspaceSessionOutput,
  deleteWorktree: DeleteWorktreeOutput,
};

function unwrapNullable(schema: unknown): unknown {
  const candidate = schema as { unwrap?: () => unknown };
  return typeof candidate.unwrap === 'function' ? candidate.unwrap() : schema;
}

function topLevelFields(schema: unknown): string[] {
  const shape = (unwrapNullable(schema) as { shape?: Record<string, unknown> }).shape;
  if (!shape) throw new Error('schema is not a strict object');
  return Object.keys(shape).sort();
}

function enumOptions(schema: unknown): readonly string[] {
  const options = (unwrapNullable(schema) as { options?: readonly string[] }).options;
  if (!options) throw new Error('schema is not an enum');
  return options;
}

async function loadFixture(): Promise<{ fixture: Fixture; source: string }> {
  const [raw, ...sources] = await Promise.all([
    readFile(path.join(fixtureDir, 'v1.json'), 'utf8'),
    readFile(path.join(handlerDir, 'hosted-workspace-mutations.ts'), 'utf8'),
    readFile(path.join(handlerDir, 'hosted-workspace-status.ts'), 'utf8'),
    readFile(path.join(handlerDir, 'hosted-workspace-list.ts'), 'utf8'),
    readFile(path.join(handlerDir, 'session-worktree.ts'), 'utf8'),
    readFile(path.join(handlerDir, 'worktree-deletion.ts'), 'utf8'),
    readFile(sessionRegistrationSource, 'utf8'),
    readFile(contractSource, 'utf8'),
  ]);
  return { fixture: fixtureSchema.parse(JSON.parse(raw)), source: sources.join('\n') };
}

function expectFieldLists(entries: FixtureEntry[], schemas: Record<string, unknown>): void {
  for (const entry of entries) {
    const schema = schemas[entry.procedure];
    expect(schema, `${entry.procedure} must export a schema`).toBeDefined();
    expect(topLevelFields(schema), `${entry.procedure} field drift`).toEqual(
      [...entry.fields].sort()
    );
    expect(
      (schema as SchemaLike).parse(entry.example),
      `${entry.procedure} example must parse`
    ).toBeDefined();
  }
}

describe('hosted workspace contract fixture', () => {
  it('covers every registered workspace procedure exactly once', async () => {
    const { fixture } = await loadFixture();
    const expected = Object.keys(fixture.procedures).sort();
    const registered = Object.entries(appRouter._def.procedures)
      .filter(([name]) => name.includes('HostedWorkspace') || name === 'deleteWorktree')
      .map(([name]) => name)
      .sort();
    expect(registered).toEqual(expected);
    expect([...fixture.requests.map(entry => entry.procedure)].sort()).toEqual(expected);
    expect([...fixture.responses.map(entry => entry.procedure)].sort()).toEqual(expected);
    for (const name of expected) {
      const procedure = appRouter._def.procedures[name];
      expect(procedure, `${name} must be registered`).toBeDefined();
      expect(procedure?._def.type, `${name} procedure kind drift`).toBe(fixture.procedures[name]);
    }
  });

  it('matches every request schema field list and example', async () => {
    const { fixture } = await loadFixture();
    expectFieldLists(fixture.requests, requestSchemas);
  });

  it('matches every response schema field list and example', async () => {
    const { fixture } = await loadFixture();
    expectFieldLists(fixture.responses, responseSchemas);
  });

  it('pins the status enums to the production schemas', async () => {
    const { fixture } = await loadFixture();
    expect([...fixture.status.computeStatuses].sort()).toEqual(
      [...SandboxLifecycleStatusSchema.options].sort()
    );
    expect([...fixture.status.detailCodes].sort()).toEqual(
      [...SandboxStatusDetailCodeSchema.options].sort()
    );
    expect([...fixture.status.providers].sort()).toEqual(
      [...SandboxProviderLabelSchema.options].sort()
    );
    const shape = getHostedWorkspaceStatusOutput.shape;
    expect([...fixture.status.deletionStates].sort()).toEqual(
      [...enumOptions(shape.deletionState)].sort()
    );
    expect([...fixture.status.deletionPhases].sort()).toEqual(
      [...enumOptions(shape.deletion.shape.phase)].sort()
    );
    expect([...fixture.status.wakeBlockedReasons].sort()).toEqual(
      [...enumOptions(shape.wakeOnInput.shape.blockedReason)].sort()
    );
  });

  it('keeps every documented error code in handler or contract source', async () => {
    const { fixture, source } = await loadFixture();
    for (const code of fixture.errorCodes) {
      expect(source.includes(code), `${code} must remain a literal contract code`).toBe(true);
    }
  });

  it('pins the deletion manifest version and rejects an unknown version', async () => {
    const { fixture } = await loadFixture();
    expect(() =>
      cloudAgentWorktreeDeletionManifestSchema.parse({
        version: fixture.deletionManifestVersion,
        sessions: [],
      })
    ).not.toThrow();
    expect(() =>
      cloudAgentWorktreeDeletionManifestSchema.parse({
        version: fixture.deletionManifestVersion + 1,
        sessions: [],
      })
    ).toThrow();
  });
});
