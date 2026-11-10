import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readKilo2Messages } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';
import type * as ReactI18next from 'react-i18next';

import '@/i18n';
import { CompactionSeparator as renderCompactionSeparator } from './compaction-separator';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }),
  };
});

function textContent(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(child => textContent(child)).join('');
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textContent(node.props.children);
  }
  return '';
}

describe('CompactionSeparator', () => {
  it.each([
    ['pending', undefined, 'Running'],
    ['running', undefined, 'Running'],
    ['completed', undefined, 'Context compacted'],
    ['failed', undefined, 'Failed'],
    ['failed', { type: 'model', message: 'Model unavailable' }, 'Failed'],
    ['failed', { type: 'aborted', message: 'Raw abort text' }, 'Cancelled'],
  ])('renders native %s compaction with error %j as %s', (status, error, label) => {
    const [message] = readKilo2Messages(
      {
        id: 'session',
        location: { directory: '/workspace' },
        time: { created: 1, updated: 2 },
      },
      [{ id: 'compaction', type: 'compaction', status, time: { created: 1 }, error }]
    );
    expect(message).toBeDefined();
    expect(textContent(renderCompactionSeparator({ info: message?.info }))).toBe(label);
  });

  it('preserves the V1 completed separator without assistant metadata', () => {
    expect(textContent(renderCompactionSeparator({}))).toBe('Context compacted');
  });
});
