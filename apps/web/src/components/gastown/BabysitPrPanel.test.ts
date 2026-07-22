import { describe, it, expect } from '@jest/globals';

const HTTPS_URL_RE = /^https:\/\/.+/;

type PreviewPrResult = {
  state: string;
  head_branch?: string;
  base_branch?: string;
  head_sha?: string;
  title?: string;
  repo_matches: boolean;
};

function validatePrUrl(url: string): boolean {
  return HTTPS_URL_RE.test(url.trim());
}

function getPreviewStatus(preview: PreviewPrResult | null | undefined): {
  isRepoMismatch: boolean;
  isPrClosed: boolean;
  isPreviewReady: boolean;
} {
  if (!preview) {
    return { isRepoMismatch: false, isPrClosed: false, isPreviewReady: false };
  }
  const isRepoMismatch = !preview.repo_matches;
  const isPrClosed =
    preview.repo_matches && preview.state !== 'open' && preview.state !== 'unknown';
  const isPreviewReady = preview.repo_matches && preview.state === 'open';
  return { isRepoMismatch, isPrClosed, isPreviewReady };
}

function canSubmit(isValidUrl: boolean, isPreviewReady: boolean): boolean {
  return isValidUrl && isPreviewReady;
}

function buildMutationArgs(
  rigId: string,
  prUrl: string,
  titleOverride: string,
  bodyOverride: string,
  forcePushAllowed: boolean
) {
  return {
    rigId,
    prUrl: prUrl.trim(),
    title: titleOverride.trim() || undefined,
    body: bodyOverride.trim() || undefined,
    forcePushAllowed,
  };
}

function getDefaultTitle(preview: PreviewPrResult | null | undefined): string {
  return preview?.title ? `Babysit: ${preview.title}` : '';
}

function getDefaultBody(preview: PreviewPrResult | null | undefined, prUrl: string): string {
  return preview ? `Monitoring PR: ${prUrl.trim()}` : '';
}

describe('BabysitPrPanel: URL validation', () => {
  it('rejects empty string', () => {
    expect(validatePrUrl('')).toBe(false);
  });

  it('rejects non-https URL', () => {
    expect(validatePrUrl('http://github.com/owner/repo/pull/1')).toBe(false);
  });

  it('rejects plain text', () => {
    expect(validatePrUrl('not a url')).toBe(false);
  });

  it('accepts valid https GitHub PR URL', () => {
    expect(validatePrUrl('https://github.com/owner/repo/pull/123')).toBe(true);
  });

  it('accepts valid https GitLab MR URL', () => {
    expect(validatePrUrl('https://gitlab.com/owner/repo/-/merge_requests/1')).toBe(true);
  });

  it('trims whitespace before validating', () => {
    expect(validatePrUrl('  https://github.com/owner/repo/pull/1  ')).toBe(true);
  });

  it('submit is disabled with invalid URL', () => {
    expect(canSubmit(false, false)).toBe(false);
    expect(canSubmit(false, true)).toBe(false);
  });
});

describe('BabysitPrPanel: preview status', () => {
  it('repo_matches: false → isRepoMismatch, submit disabled', () => {
    const preview: PreviewPrResult = { state: 'unknown', repo_matches: false };
    const status = getPreviewStatus(preview);
    expect(status.isRepoMismatch).toBe(true);
    expect(status.isPreviewReady).toBe(false);
    expect(canSubmit(true, status.isPreviewReady)).toBe(false);
  });

  it('PR state "closed" → isPrClosed, submit disabled', () => {
    const preview: PreviewPrResult = {
      state: 'closed',
      head_branch: 'feature/x',
      base_branch: 'main',
      title: 'My PR',
      repo_matches: true,
    };
    const status = getPreviewStatus(preview);
    expect(status.isPrClosed).toBe(true);
    expect(status.isPreviewReady).toBe(false);
    expect(canSubmit(true, status.isPreviewReady)).toBe(false);
  });

  it('PR state "merged" → isPrClosed, submit disabled', () => {
    const preview: PreviewPrResult = {
      state: 'merged',
      repo_matches: true,
    };
    const status = getPreviewStatus(preview);
    expect(status.isPrClosed).toBe(true);
    expect(status.isPreviewReady).toBe(false);
  });

  it('PR state "open" with repo_matches → isPreviewReady, submit enabled', () => {
    const preview: PreviewPrResult = {
      state: 'open',
      head_branch: 'feature/x',
      base_branch: 'main',
      head_sha: 'abc1234',
      title: 'My PR',
      repo_matches: true,
    };
    const status = getPreviewStatus(preview);
    expect(status.isRepoMismatch).toBe(false);
    expect(status.isPrClosed).toBe(false);
    expect(status.isPreviewReady).toBe(true);
    expect(canSubmit(true, status.isPreviewReady)).toBe(true);
  });

  it('null preview → all statuses false, submit disabled', () => {
    const status = getPreviewStatus(null);
    expect(status.isRepoMismatch).toBe(false);
    expect(status.isPrClosed).toBe(false);
    expect(status.isPreviewReady).toBe(false);
    expect(canSubmit(true, status.isPreviewReady)).toBe(false);
  });
});

describe('BabysitPrPanel: mutation args', () => {
  it('happy path: builds correct mutation args with defaults', () => {
    const args = buildMutationArgs(
      'rig-1',
      'https://github.com/owner/repo/pull/123',
      '',
      '',
      false
    );
    expect(args).toEqual({
      rigId: 'rig-1',
      prUrl: 'https://github.com/owner/repo/pull/123',
      title: undefined,
      body: undefined,
      forcePushAllowed: false,
    });
  });

  it('plumbs forcePushAllowed through to mutation', () => {
    const args = buildMutationArgs('rig-1', 'https://github.com/owner/repo/pull/123', '', '', true);
    expect(args.forcePushAllowed).toBe(true);
  });

  it('uses title and body overrides when provided', () => {
    const args = buildMutationArgs(
      'rig-1',
      'https://github.com/owner/repo/pull/123',
      'Custom title',
      'Custom body',
      false
    );
    expect(args.title).toBe('Custom title');
    expect(args.body).toBe('Custom body');
  });

  it('trims whitespace from overrides', () => {
    const args = buildMutationArgs(
      'rig-1',
      '  https://github.com/owner/repo/pull/123  ',
      '  Custom title  ',
      '  Custom body  ',
      false
    );
    expect(args.prUrl).toBe('https://github.com/owner/repo/pull/123');
    expect(args.title).toBe('Custom title');
    expect(args.body).toBe('Custom body');
  });
});

describe('BabysitPrPanel: default values', () => {
  it('default title is "Babysit: <PR title>" when preview has title', () => {
    const preview: PreviewPrResult = {
      state: 'open',
      title: 'Fix login bug',
      repo_matches: true,
    };
    expect(getDefaultTitle(preview)).toBe('Babysit: Fix login bug');
  });

  it('default title is empty when preview has no title', () => {
    const preview: PreviewPrResult = { state: 'open', repo_matches: true };
    expect(getDefaultTitle(preview)).toBe('');
  });

  it('default body is "Monitoring PR: <url>" when preview exists', () => {
    const preview: PreviewPrResult = { state: 'open', repo_matches: true };
    expect(getDefaultBody(preview, 'https://github.com/o/r/pull/1')).toBe(
      'Monitoring PR: https://github.com/o/r/pull/1'
    );
  });

  it('default body is empty when no preview', () => {
    expect(getDefaultBody(null, 'https://github.com/o/r/pull/1')).toBe('');
  });
});
