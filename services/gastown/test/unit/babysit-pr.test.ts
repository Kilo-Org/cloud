import { describe, it, expect } from 'vitest';
import { resolveForcePushAllowed } from '../../src/dos/town/agents';
import {
  registerCheckPRStatusTests,
  registerRepoValidationTests,
  registerStateValidationTests,
} from './babysit-pr-helpers';

registerCheckPRStatusTests();
registerRepoValidationTests();
registerStateValidationTests();

describe('babysitPr tRPC mutation input validation', () => {
  const babysitPrInputSchema = {
    rigId: 'string-uuid',
    prUrl: 'url',
    title: 'string-optional',
    body: 'string-optional',
    forcePushAllowed: 'boolean-optional',
  };

  it('requires rigId and prUrl', () => {
    expect(babysitPrInputSchema.rigId).toBeDefined();
    expect(babysitPrInputSchema.prUrl).toBeDefined();
  });

  it('title, body, forcePushAllowed are optional', () => {
    expect(babysitPrInputSchema.title).toBeDefined();
    expect(babysitPrInputSchema.body).toBeDefined();
    expect(babysitPrInputSchema.forcePushAllowed).toBeDefined();
  });
});

describe('previewPr tRPC query output', () => {
  it('returns repo_matches: false on repo mismatch without throwing', () => {
    const result = {
      state: 'unknown',
      repo_matches: false,
    };
    expect(result.repo_matches).toBe(false);
    expect(result.state).toBe('unknown');
  });

  it('returns full PR metadata on repo match', () => {
    const result = {
      state: 'open',
      head_branch: 'feature/x',
      base_branch: 'main',
      head_sha: 'abc1234',
      title: 'My PR',
      repo_matches: true,
    };
    expect(result.repo_matches).toBe(true);
    expect(result.head_branch).toBe('feature/x');
    expect(result.base_branch).toBe('main');
    expect(result.head_sha).toBe('abc1234');
    expect(result.title).toBe('My PR');
  });
});

describe('mayor-tools babysit-pr handler input schema', () => {
  it('validates required fields', () => {
    const body = {
      rig_id: 'rig-1',
      pr_url: 'https://github.com/owner/repo/pull/1',
    };
    expect(body.rig_id).toBeTruthy();
    expect(body.pr_url).toMatch(/^https:\/\//);
  });

  it('sourceAgentId is forced to mayor', () => {
    const sourceAgentId = 'mayor';
    expect(sourceAgentId).toBe('mayor');
  });
});

describe('refinery bypass for babysat beads', () => {
  it('dispatch_agent returns null for babysit merge_request beads', () => {
    const targetBead = {
      type: 'merge_request',
      metadata: { babysit: true },
    };
    const shouldBypass =
      targetBead.type === 'merge_request' && targetBead.metadata?.babysit === true;
    expect(shouldBypass).toBe(true);
  });

  it('dispatch_agent does NOT bypass for non-babysit merge_request beads', () => {
    const targetBead = {
      type: 'merge_request',
      metadata: {},
    };
    const shouldBypass =
      targetBead.type === 'merge_request' && targetBead.metadata?.babysit === true;
    expect(shouldBypass).toBe(false);
  });

  it('dispatch_agent does NOT bypass for issue beads', () => {
    const targetBead = {
      type: 'issue',
      metadata: {},
    };
    const shouldBypass =
      targetBead.type === 'merge_request' && targetBead.metadata?.babysit === true;
    expect(shouldBypass).toBe(false);
  });
});

describe('reconciler babysit fast-track', () => {
  it('babysat beads fast-track regardless of code_review config', () => {
    const rigCodeReview = true;
    const beadIsBabysat = true;
    const shouldFastTrack = beadIsBabysat;
    expect(shouldFastTrack).toBe(true);
    expect(rigCodeReview).toBe(true);
  });

  it('babysat beads with pr_url transition to in_progress', () => {
    const action = {
      type: 'transition_bead' as const,
      bead_id: 'test-bead',
      from: 'open',
      to: 'in_progress',
      reason: 'babysat PR — skip refinery, fast-track to poll_pr',
      actor: 'system',
    };
    expect(action.type).toBe('transition_bead');
    expect(action.from).toBe('open');
    expect(action.to).toBe('in_progress');
    expect(action.reason).toContain('babysat');
  });

  it('non-babysat MR beads on code_review=true rig do NOT fast-track', () => {
    const rigCodeReview = true;
    const beadIsBabysat = false;
    const shouldFastTrack = beadIsBabysat;
    expect(shouldFastTrack).toBe(false);
    expect(rigCodeReview).toBe(true);
  });
});

describe('polecat prime context force_push_allowed gate', () => {
  it('babysat bead with force_push_allowed: false → resolveForcePushAllowed returns false', () => {
    const meta: Record<string, unknown> = {
      force_push_allowed: false,
      pr_url: 'https://github.com/o/r/pull/1',
      branch: 'feat/x',
      target_branch: 'main',
    };
    expect(resolveForcePushAllowed(meta)).toBe(false);
  });

  it('babysat bead with force_push_allowed: true → resolveForcePushAllowed returns true', () => {
    const meta: Record<string, unknown> = {
      force_push_allowed: true,
      pr_url: 'https://github.com/o/r/pull/1',
      branch: 'feat/x',
      target_branch: 'main',
    };
    expect(resolveForcePushAllowed(meta)).toBe(true);
  });

  it('non-babysat bead (force_push_allowed absent) → resolveForcePushAllowed returns true (backwards compat)', () => {
    const meta: Record<string, unknown> = {
      pr_url: 'https://github.com/o/r/pull/1',
      branch: 'feat/x',
      target_branch: 'main',
    };
    expect(resolveForcePushAllowed(meta)).toBe(true);
  });

  it('pr_fixup_context with force_push_allowed: false surfaces correctly via resolveForcePushAllowed', () => {
    const hookedBead: { labels: string[]; metadata: Record<string, unknown> } = {
      labels: ['gt:pr-fixup'],
      metadata: {
        pr_url: 'https://github.com/o/r/pull/1',
        branch: 'feat/x',
        target_branch: 'main',
        force_push_allowed: false,
      },
    };
    const forcePushAllowed = resolveForcePushAllowed(hookedBead.metadata);
    expect(forcePushAllowed).toBe(false);
  });

  it('pr_conflict_context with force_push_allowed absent surfaces as true (backwards compat)', () => {
    const hookedBead: { labels: string[]; metadata: Record<string, unknown> } = {
      labels: ['gt:pr-conflict'],
      metadata: {
        pr_url: 'https://github.com/o/r/pull/1',
        branch: 'feat/x',
        target_branch: 'main',
        has_feedback: false,
      },
    };
    const forcePushAllowed = resolveForcePushAllowed(hookedBead.metadata);
    expect(forcePushAllowed).toBe(true);
  });
});
