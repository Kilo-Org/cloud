import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BackgroundActivityInventory,
  BackgroundJob,
} from '@kilocode/session-ingest-contracts';

jest.mock('./CloudAgentProvider', () => ({ useManager: jest.fn() }));
jest.mock('@/components/ui/popover', () => {
  const stub =
    (slot: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { 'data-slot': slot }, children);
  return {
    Popover: stub('popover'),
    PopoverTrigger: stub('popover-trigger'),
    PopoverContent: stub('popover-content'),
  };
});

import { BackgroundActivityStrip } from './BackgroundActivityStrip';

const command = 'pnpm inventory --check';

function shellJob(id: string, title?: string): BackgroundJob {
  return {
    id,
    sessionID: 'ses_root',
    kind: 'shell',
    shellID: `handle-${id}`,
    status: 'running',
    command,
    time: { started: 1000 },
    ...(title === undefined ? {} : { title }),
  };
}

function shellInventory(jobs: BackgroundJob[]): BackgroundActivityInventory {
  return { sessionID: 'ses_root', jobs, sessions: [{ id: 'ses_root' }], waits: [] };
}

describe('BackgroundActivityStrip shell rows', () => {
  let root: Root;
  let container: HTMLElement;
  let previous: Map<string, unknown>;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 13_000 });
    const requireFromHere = createRequire(__filename);
    const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
    const { window, document } = (
      requireFromNext('linkedom') as {
        parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
      }
    ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const replacements = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    previous = new Map(Object.keys(replacements).map(key => [key, globals[key]]));
    Object.assign(globals, replacements);
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    previous.forEach((value, key) => {
      globals[key] = value;
    });
    jest.useRealTimers();
  });

  function renderShells(jobs: BackgroundJob[]) {
    act(() => {
      root.render(
        createElement(BackgroundActivityStrip, {
          state: { status: 'current', inventory: shellInventory(jobs) },
          onRetry: jest.fn(),
          onOpenChildSession: jest.fn(),
        })
      );
    });
    act(() => jest.advanceTimersByTime(150));
    const section = container.querySelector('section[aria-label="Shells"]');
    if (!section) throw new Error('Shells section missing');
    return section;
  }

  function commandOccurrences(section: Element) {
    return (section.textContent ?? '').split(command).length - 1;
  }

  it.each([
    ['a title matching the command', `  ${command}  `],
    ['a whitespace-only title', '   '],
    ['no title', undefined],
  ] satisfies [string, string | undefined][])('shows the command once with %s', (_name, title) => {
    const section = renderShells([shellJob('shell-1', title)]);
    expect(section.querySelectorAll('li')).toHaveLength(1);
    expect(commandOccurrences(section)).toBe(1);
    expect(section.querySelector('pre')).toBeNull();
  });

  it('keeps a distinct title and the command below it', () => {
    const section = renderShells([shellJob('shell-1', 'Run inventory')]);
    expect(section.textContent).toContain('Run inventory');
    expect(section.querySelector('pre')?.textContent).toBe(command);
    expect(commandOccurrences(section)).toBe(1);
  });

  it('keeps separate runs of the same command as separate rows', () => {
    const section = renderShells([shellJob('shell-1', command), shellJob('shell-2', command)]);
    expect(section.querySelectorAll('li')).toHaveLength(2);
    expect(commandOccurrences(section)).toBe(2);
    expect(section.querySelector('pre')).toBeNull();
  });
});
