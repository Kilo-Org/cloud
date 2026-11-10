import { describe, expect, it } from 'vitest';
import {
  PREVIEW_HOST_TEMPLATE_PORT,
  matchPreviewHost,
  parsePreviewLabel,
  previewHostTemplate,
  previewLabel,
  previewTargetId,
} from './host.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const WORKTREE_ID = 'worktree_22222222-2222-4222-8222-222222222222';
const HEX = '11111111111141118111111111111111';
const WORKTREE_HEX = '22222222222242228222222222222222';

describe('previewLabel', () => {
  it('round-trips session and port', () => {
    const label = previewLabel(SESSION_ID, 5173);
    expect(label).toBe(`p5173-${HEX}`);
    expect(parsePreviewLabel(label ?? '')).toEqual({
      label: `p5173-${HEX}`,
      port: 5173,
      cloudAgentSessionId: SESSION_ID,
    });
  });

  it('round-trips a worktree target in its own label namespace', () => {
    const label = previewLabel(WORKTREE_ID, 5173);
    expect(label).toBe(`w5173-${WORKTREE_HEX}`);
    expect(parsePreviewLabel(label ?? '')).toEqual({
      label: `w5173-${WORKTREE_HEX}`,
      port: 5173,
      worktreeId: WORKTREE_ID,
    });
  });

  it('accepts the port bounds and the 63-char label limit', () => {
    expect(previewLabel(SESSION_ID, 1024)).toBe(`p1024-${HEX}`);
    expect(previewLabel(SESSION_ID, 65535)).toBe(`p65535-${HEX}`);
    expect(previewLabel(SESSION_ID, 65535)?.length).toBeLessThanOrEqual(63);
    expect(previewLabel(WORKTREE_ID, 65535)?.length).toBeLessThanOrEqual(63);
    expect(previewLabel(SESSION_ID, 1023)).toBeNull();
    expect(previewLabel(SESSION_ID, 65536)).toBeNull();
  });

  it('rejects a non-workspace and non-worktree id', () => {
    expect(previewLabel('agent_11111111-1111-4111-8111-111111111111', 5173)).toBeNull();
    expect(previewLabel('workspace_not-a-uuid', 5173)).toBeNull();
    expect(previewLabel('worktree_not-a-uuid', 5173)).toBeNull();
  });
});

describe('previewTargetId', () => {
  it('returns the one target id from either claim shape', () => {
    expect(previewTargetId({ cloudAgentSessionId: SESSION_ID })).toBe(SESSION_ID);
    expect(previewTargetId({ worktreeId: WORKTREE_ID })).toBe(WORKTREE_ID);
    expect(previewTargetId({})).toBeNull();
  });
});

describe('previewHostTemplate', () => {
  it('gives the same host as previewLabel once the port is filled in', () => {
    const template = previewHostTemplate(SESSION_ID, 'preview.example.test');
    expect(template).toBe(`p${PREVIEW_HOST_TEMPLATE_PORT}-${HEX}.preview.example.test`);
    const host = template?.replace(PREVIEW_HOST_TEMPLATE_PORT, '5173') ?? '';
    expect(host).toBe(`${previewLabel(SESSION_ID, 5173)}.preview.example.test`);
    expect(matchPreviewHost(host, 'preview.example.test')?.port).toBe(5173);
  });

  it('gives a workspace template under the w namespace', () => {
    const template = previewHostTemplate(WORKTREE_ID, 'preview.example.test');
    expect(template).toBe(`w${PREVIEW_HOST_TEMPLATE_PORT}-${WORKTREE_HEX}.preview.example.test`);
    const host = template?.replace(PREVIEW_HOST_TEMPLATE_PORT, '5173') ?? '';
    expect(matchPreviewHost(host, 'preview.example.test')).toMatchObject({
      worktreeId: WORKTREE_ID,
      port: 5173,
    });
  });

  it('rejects a non-workspace and non-worktree id', () => {
    expect(
      previewHostTemplate('agent_11111111-1111-4111-8111-111111111111', 'preview.example.test')
    ).toBeNull();
  });
});

describe('parsePreviewLabel', () => {
  it('rejects leading zeros, underscores, extra dots and bad ports', () => {
    expect(parsePreviewLabel(`p0173-${HEX}`)).toBeNull();
    expect(parsePreviewLabel(`p51_73-${HEX}`)).toBeNull();
    expect(parsePreviewLabel(`p5173.abc-${HEX}`)).toBeNull();
    expect(parsePreviewLabel(`p999-${HEX}`)).toBeNull();
    expect(parsePreviewLabel(`p5173-${HEX.slice(0, 31)}`)).toBeNull();
    expect(parsePreviewLabel(`q5173-${HEX}`)).toBeNull();
    expect(parsePreviewLabel(`w5173-${HEX.slice(0, 31)}`)).toBeNull();
  });
});

describe('matchPreviewHost', () => {
  it('matches an exact label under the suffix', () => {
    expect(matchPreviewHost(`p5173-${HEX}.localhost`, 'localhost')).toMatchObject({
      port: 5173,
      cloudAgentSessionId: SESSION_ID,
    });
  });

  it('matches a workspace label distinctly from a session label', () => {
    expect(matchPreviewHost(`w5173-${WORKTREE_HEX}.localhost`, 'localhost')).toMatchObject({
      port: 5173,
      worktreeId: WORKTREE_ID,
    });
    expect(matchPreviewHost(`w5173-${WORKTREE_HEX}.localhost`, 'localhost')).not.toHaveProperty(
      'cloudAgentSessionId'
    );
  });

  it('never matches the worker hostname', () => {
    expect(matchPreviewHost('cloud-agent-next.example.test', 'localhost')).toBeNull();
    expect(matchPreviewHost('worker.test', 'test')).toBeNull();
  });

  it('matches nothing when the suffix is unset or empty', () => {
    expect(matchPreviewHost(`p5173-${HEX}.localhost`, undefined)).toBeNull();
    expect(matchPreviewHost(`p5173-${HEX}.localhost`, '')).toBeNull();
  });

  it('requires exactly one label and rejects deeper subdomains', () => {
    expect(matchPreviewHost(`a.p5173-${HEX}.localhost`, 'localhost')).toBeNull();
    expect(matchPreviewHost(`.p5173-${HEX}.localhost`, 'localhost')).toBeNull();
  });
});
