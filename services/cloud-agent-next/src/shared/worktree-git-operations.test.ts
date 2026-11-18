import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  worktreeBranchOperationRefusalReasonSchema as publicRefusalReasonSchema,
  worktreeBranchOperationRequestSchema as publicRequestSchema,
  worktreeBranchOperationResultSchema as publicResultSchema,
  worktreeBranchOperationSchema as publicOperationSchema,
} from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import {
  worktreeBranchOperationRefusalReasonSchema,
  worktreeBranchOperationRequestSchema,
  worktreeBranchOperationResultSchema,
  worktreeBranchOperationSchema,
} from './worktree-git-operations.js';

const head = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);
const fields = {
  operation: 'restack',
  branch: 'feature',
  baseBranch: 'main',
  baseSha: 'c'.repeat(40),
  previousRemoteSha: null,
  remoteSha: sha256,
  headSha: head,
} as const;

const requests: unknown[] = [
  { operation: 'sync' },
  { operation: 'restack', baseBranch: 'main', upstreamSha: head },
  { operation: 'sync', extra: true },
  { operation: 'merge' },
  { operation: 'restack', baseBranch: '-main' },
  { operation: 'restack', baseBranch: 'main\nother' },
  { operation: 'restack', baseBranch: 'b'.repeat(257) },
  { operation: 'restack', upstreamSha: 'ABC' },
];

const results: unknown[] = [
  { status: 'changed', ...fields },
  { status: 'unchanged', ...fields },
  { status: 'changed', ...fields, extra: true },
  { status: 'changed', ...fields, branch: null },
  {
    status: 'conflict',
    ...fields,
    files: ['src/a.ts'],
    command: 'git rebase --onto origin/main abc',
    instruction: 'Resolve and push',
  },
  { status: 'conflict', ...fields, files: ['../a.ts'], command: 'git rebase', instruction: 'x' },
  { status: 'conflict', ...fields, files: [], command: '', instruction: 'x' },
  {
    status: 'refused',
    ...fields,
    branch: null,
    headSha: null,
    reason: 'branch_owned_by_sibling',
    message: 'Another worktree owns the branch',
  },
  { status: 'refused', ...fields, reason: 'unknown_reason', message: 'x' },
  { status: 'refused', ...fields, reason: 'turn_running', message: '' },
];

describe('standalone worktree branch operation schema parity', () => {
  it('accepts the same operations and refusal reasons as the public contract', () => {
    expect(worktreeBranchOperationSchema.options).toEqual(publicOperationSchema.options);
    expect(worktreeBranchOperationRefusalReasonSchema.options).toEqual(
      publicRefusalReasonSchema.options
    );
  });

  it.each(requests.map(value => [JSON.stringify(value), value]))(
    'parses request %s like the public contract',
    (_name, value) => {
      expect(worktreeBranchOperationRequestSchema.safeParse(value).success).toBe(
        publicRequestSchema.safeParse(value).success
      );
    }
  );

  it.each(results.map(value => [JSON.stringify(value), value]))(
    'parses result %s like the public contract',
    (_name, value) => {
      expect(worktreeBranchOperationResultSchema.safeParse(value).success).toBe(
        publicResultSchema.safeParse(value).success
      );
    }
  );

  it('has the same input and output types as the public contract', () => {
    expectTypeOf<z.input<typeof worktreeBranchOperationRequestSchema>>().toEqualTypeOf<
      z.input<typeof publicRequestSchema>
    >();
    expectTypeOf<z.output<typeof worktreeBranchOperationRequestSchema>>().toEqualTypeOf<
      z.output<typeof publicRequestSchema>
    >();
    expectTypeOf<z.input<typeof worktreeBranchOperationResultSchema>>().toEqualTypeOf<
      z.input<typeof publicResultSchema>
    >();
    expectTypeOf<z.output<typeof worktreeBranchOperationResultSchema>>().toEqualTypeOf<
      z.output<typeof publicResultSchema>
    >();
  });
});
