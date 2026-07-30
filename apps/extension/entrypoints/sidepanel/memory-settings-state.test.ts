import { describe, expect, it } from 'vitest';
import type { AgentMemory } from '@/src/shared/agent-memories';
import {
  deriveMemoriesSettingsView,
  formatMemoryListDate,
  formatMemorySourceDomain,
  toMemorySettingsListItem,
} from './memory-settings-state';

const memory = (overrides: Partial<AgentMemory> = {}): AgentMemory => ({
  createdAt: 1_700_000_000_000,
  id: 'mem-1',
  pageTitle: 'Example',
  pageUrl: 'https://example.com/path',
  text: 'Stored text about widgets',
  ...overrides,
});

describe('memory source domain formatting', () => {
  it('returns hostname for http(s) URLs', () => {
    expect(formatMemorySourceDomain('https://docs.example.com/a?q=1')).toBe('docs.example.com');
  });

  it('omits empty, invalid, and file URLs', () => {
    expect(formatMemorySourceDomain('')).toBeUndefined();
    expect(formatMemorySourceDomain('[invalid URL]')).toBeUndefined();
    expect(formatMemorySourceDomain('not a url')).toBeUndefined();
    expect(formatMemorySourceDomain('file:///tmp/x')).toBeUndefined();
  });
});

describe('memory list date formatting', () => {
  it('formats UTC YYYY-MM-DD', () => {
    expect(formatMemoryListDate(Date.UTC(2024, 0, 15, 12, 0, 0))).toBe('2024-01-15');
  });
});

describe('memory settings list item mapping', () => {
  it('prefers note for preview and builds a unique delete label', () => {
    const item = toMemorySettingsListItem(
      memory({ note: 'Remember this', text: 'Longer body text' })
    );
    expect(item.preview).toBe('Remember this');
    expect(item.deleteAriaLabel).toBe('Delete memory "Remember this"');
    expect(item.domain).toBe('example.com');
  });

  it('falls back to text when note is absent', () => {
    expect(toMemorySettingsListItem(memory()).preview).toBe('Stored text about widgets');
  });
});

describe('memories settings view selection', () => {
  it('shows loading while not loaded', () => {
    expect(
      deriveMemoriesSettingsView({
        isLoaded: false,
        loadError: false,
        memories: [memory()],
      })
    ).toStrictEqual({ kind: 'loading' });
  });

  it('shows load error after load fails', () => {
    expect(
      deriveMemoriesSettingsView({
        isLoaded: true,
        loadError: true,
        memories: [],
      })
    ).toStrictEqual({ kind: 'loadError' });
  });

  it('shows empty when loaded with zero memories', () => {
    expect(
      deriveMemoriesSettingsView({
        isLoaded: true,
        loadError: false,
        memories: [],
      })
    ).toStrictEqual({ kind: 'empty' });
  });

  it('lists memories newest-first', () => {
    const older = memory({ createdAt: 100, id: 'old', text: 'Older' });
    const newer = memory({ createdAt: 200, id: 'new', text: 'Newer' });
    const view = deriveMemoriesSettingsView({
      isLoaded: true,
      loadError: false,
      memories: [older, newer],
    });

    expect(view).toStrictEqual({
      items: [
        {
          dateLabel: formatMemoryListDate(200),
          deleteAriaLabel: 'Delete memory "Newer"',
          domain: 'example.com',
          id: 'new',
          preview: 'Newer',
        },
        {
          dateLabel: formatMemoryListDate(100),
          deleteAriaLabel: 'Delete memory "Older"',
          domain: 'example.com',
          id: 'old',
          preview: 'Older',
        },
      ],
      kind: 'list',
    });
  });

  it('does not flash empty during loadError when prior memories exist', () => {
    // LoadError wins after isLoaded — list is not shown until reload succeeds.
    expect(
      deriveMemoriesSettingsView({
        isLoaded: true,
        loadError: true,
        memories: [memory()],
      })
    ).toStrictEqual({ kind: 'loadError' });
  });
});
