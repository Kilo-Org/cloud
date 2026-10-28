import { describe, expect, it, vi } from 'vitest';

import {
  buildContinueHref,
  readCloneFromKiloSessionId,
  readCloneSourceTitle,
  readCloneUpToMessageId,
  readForkPrefillText,
  readForkSourceIsCloudAgent,
} from './new-session-prefill';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ════════════════════════════════════════════════════════════════
// buildContinueHref
// ════════════════════════════════════════════════════════════════

describe('buildContinueHref', () => {
  const prefill = { repo: 'owner/repo', mode: 'plan', model: 'anthropic/claude-sonnet-4' };

  it('starts at the new-session route and includes the clone id', () => {
    const href = buildContinueHref({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      prefill,
    });
    expect(href).toContain('/(app)/agent-chat/new?');
    expect(href).toContain('cloneFromKiloSessionId=ses_12345678901234567890123456');
  });

  it('includes organizationId for an org session before the prefill and clone keys', () => {
    const href = buildContinueHref({
      organizationId: 'org-1',
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      prefill,
    });
    expect(href.startsWith('/(app)/agent-chat/new?organizationId=org-1')).toBe(true);
    expect(href).toContain('&prefillRepo=owner%2Frepo');
    expect(href).toContain('&cloneFromKiloSessionId=ses_12345678901234567890123456');
  });

  it('encodes the clone source title', () => {
    const href = buildContinueHref({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      cloneSourceTitle: 'Fix the login & signup',
      prefill,
    });
    expect(href).toContain('cloneSourceTitle=Fix%20the%20login%20%26%20signup');
  });

  it('omits the title param when the title is empty', () => {
    const href = buildContinueHref({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      cloneSourceTitle: '',
      prefill,
    });
    expect(href).not.toContain('cloneSourceTitle');
    expect(href).toContain('cloneFromKiloSessionId=ses_12345678901234567890123456');
  });

  it('omits the title param when the title is absent', () => {
    const href = buildContinueHref({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      prefill,
    });
    expect(href).not.toContain('cloneSourceTitle');
  });
});

// ════════════════════════════════════════════════════════════════
// readCloneFromKiloSessionId / readCloneSourceTitle
// ════════════════════════════════════════════════════════════════

describe('clone param readers', () => {
  it('reads a string clone id', () => {
    expect(
      readCloneFromKiloSessionId({ cloneFromKiloSessionId: 'ses_12345678901234567890123456' })
    ).toBe('ses_12345678901234567890123456');
  });

  it('takes the first array value for clone id and title', () => {
    expect(readCloneFromKiloSessionId({ cloneFromKiloSessionId: ['ses_a', 'ses_b'] })).toBe(
      'ses_a'
    );
    expect(readCloneSourceTitle({ cloneSourceTitle: ['First title', 'Second'] })).toBe(
      'First title'
    );
  });

  it('returns an empty string when absent', () => {
    expect(readCloneFromKiloSessionId({})).toBe('');
    expect(readCloneSourceTitle({})).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// Fork cut round-trip
// ════════════════════════════════════════════════════════════════

function searchParamsOf(href: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1)));
}

describe('fork cut href round-trip', () => {
  const prefill = { repo: 'owner/repo' };
  const cut = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

  it('round-trips the cut, the composer text, and the Cloud Agent source flag', () => {
    const params = searchParamsOf(
      buildContinueHref({
        cloneFromKiloSessionId: 'ses_12345678901234567890123456',
        cloneUpToMessageId: cut,
        forkPrefillText: 'Try again & use 50% less\nmemory?',
        forkSourceIsCloudAgent: true,
        prefill,
      })
    );
    expect(readCloneFromKiloSessionId(params)).toBe('ses_12345678901234567890123456');
    expect(readCloneUpToMessageId(params)).toBe(cut);
    expect(readForkPrefillText(params)).toBe('Try again & use 50% less\nmemory?');
    expect(readForkSourceIsCloudAgent(params)).toBe(true);
  });

  it('keeps a full Continue free of every fork param', () => {
    const href = buildContinueHref({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      forkPrefillText: 'ignored without a cut',
      forkSourceIsCloudAgent: true,
      prefill,
    });
    expect(href).not.toContain('cloneUpToMessageId');
    expect(href).not.toContain('forkPrefillText');
    expect(href).not.toContain('forkSourceIsCloudAgent');
    const params = searchParamsOf(href);
    expect(readCloneUpToMessageId(params)).toBe('');
    expect(readForkPrefillText(params)).toBe('');
    expect(readForkSourceIsCloudAgent(params)).toBe(false);
  });

  it('ignores fork text and source flag that arrive without a cut', () => {
    const params = { forkPrefillText: 'stray', forkSourceIsCloudAgent: '1' };
    expect(readForkPrefillText(params)).toBe('');
    expect(readForkSourceIsCloudAgent(params)).toBe(false);
  });

  it('omits the composer text for an assistant cut', () => {
    const params = searchParamsOf(
      buildContinueHref({
        cloneFromKiloSessionId: 'ses_12345678901234567890123456',
        cloneUpToMessageId: cut,
        forkPrefillText: null,
        prefill,
      })
    );
    expect(readCloneUpToMessageId(params)).toBe(cut);
    expect(readForkPrefillText(params)).toBe('');
    expect(readForkSourceIsCloudAgent(params)).toBe(false);
  });
});
