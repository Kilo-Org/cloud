/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- DOM and storage must exist before loading the hook. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Environments from './useCloudAgentEnvironments';
import type { useSessionEnvironment as UseSessionEnvironment } from './useSessionEnvironment';
import type { RepositoryEnvironmentDefaultSetting } from '@kilocode/cloud-agent-profile';

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};
const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
const storage = new Map<string, string>();
Object.assign(dom.window, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let mockMatches: Environments.EnvironmentSummary[] | undefined;
let mockLoading = false;
let mockDefault: RepositoryEnvironmentDefaultSetting = { mode: 'automatic' };
let mockSettingsLoading = false;
let mockSettingsError = false;
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cloudAgentSettings: {
      getRepositoryEnvironmentDefault: { queryOptions: (input: unknown) => input },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (input: { platform: string; repoFullName: string }) => ({
    data:
      input.platform === 'github' && input.repoFullName.toLowerCase() === 'kilo-org/kilocode'
        ? mockDefault
        : { mode: 'automatic' },
    isLoading: mockSettingsLoading,
    isError: mockSettingsError,
  }),
}));
jest.mock('./useCloudAgentEnvironments', () => ({
  ...jest.requireActual<typeof Environments>('./useCloudAgentEnvironments'),
  useRepositoryEnvironments: () => ({ matches: mockMatches, isLoading: mockLoading }),
}));
const { useSessionEnvironment } = require('./useSessionEnvironment') as {
  useSessionEnvironment: typeof UseSessionEnvironment;
};

const repository = { platform: 'github', fullName: 'Kilo-Org/kilocode' } as const;
const environments: Environments.EnvironmentSummary[] = ['first', 'second'].map(id => ({
  id,
  name: id,
  repositories: [{ platform: 'github', repoFullName: repository.fullName }],
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
  plainVarCount: 0,
  secretCount: 0,
  commandCount: 0,
  sandboxAllocation: null,
  configurationRevision: 1,
}));
type Input = Parameters<typeof UseSessionEnvironment>[0];
let current: ReturnType<typeof UseSessionEnvironment> | undefined;

function Probe(props: Input) {
  current = useSessionEnvironment(props);
  return null;
}

function session() {
  if (!current) throw new Error('Session environment hook has not rendered');
  return current;
}

describe('useSessionEnvironment', () => {
  let root: Root;

  function mount() {
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing session environment test root');
    root = createRoot(container);
  }

  function render(props: Input = { repository }) {
    act(() => root.render(createElement(Probe, props)));
  }

  function remount(props: Input = { repository }) {
    act(() => root.unmount());
    mount();
    render(props);
  }

  beforeEach(() => {
    storage.clear();
    mockMatches = environments;
    mockLoading = false;
    mockDefault = { mode: 'automatic' };
    mockSettingsLoading = false;
    mockSettingsError = false;
    current = undefined;
    mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    jest.restoreAllMocks();
  });

  it('requires a choice for multiple environments and sends the chosen ID', () => {
    render();
    expect(session().selection.status).toBe('choose');
    act(() => session().chooseEnvironment('second'));
    expect(session().environment?.id).toBe('second');
    expect(session().requestedEnvironment).toEqual({ id: 'second' });
  });

  it('restores the last choice after remounting without choosing the first match', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    remount();
    expect(session().environment?.id).toBe('second');
    expect(session().requestedEnvironment).toEqual({ id: 'second' });
    act(() => session().chooseEnvironment('first'));
    remount();
    expect(session().environment?.id).toBe('first');
  });

  it('remembers No environment and can return to automatic selection', () => {
    render();
    act(() => session().chooseEnvironment('none'));
    remount();
    expect(session().environment).toBeNull();
    expect(session().requestedEnvironment).toEqual({ mode: 'none' });
    render({ repository, organizationId: 'org-1' });
    expect(session().selection.status).toBe('choose');
    render();
    expect(session().requestedEnvironment).toEqual({ mode: 'none' });
    act(() => session().chooseEnvironment(null));
    remount();
    expect(session().selection.status).toBe('choose');
    expect(session().requestedEnvironment).toBeUndefined();
    expect(storage.size).toBe(0);
  });

  it('uses a saved No environment default and permits an explicit override', () => {
    mockDefault = { mode: 'none' };
    render();
    expect(session().environment).toBeNull();
    expect(session().requestedEnvironment).toBeUndefined();
    act(() => session().chooseEnvironment('first'));
    expect(session().environment?.id).toBe('first');
    expect(session().requestedEnvironment).toEqual({ id: 'first' });
    act(() => session().chooseEnvironment(null));
    expect(session().environment).toBeNull();
  });

  it('uses a saved named default without requiring a choice', () => {
    mockDefault = { mode: 'environment', environmentId: 'second' };
    render();
    expect(session().environment?.id).toBe('second');
    expect(session().requestedEnvironment).toBeUndefined();
    act(() => session().chooseEnvironment('none'));
    expect(session().requestedEnvironment).toEqual({ mode: 'none' });
  });

  it('waits for repository defaults but keeps an explicit opt-out usable', () => {
    mockSettingsLoading = true;
    render();
    expect(session().selection.status).toBe('loading');
    act(() => session().chooseEnvironment('none'));
    expect(session().requestedEnvironment).toEqual({ mode: 'none' });
    mockSettingsLoading = false;
    mockSettingsError = true;
    act(() => session().chooseEnvironment(null));
    expect(session().selection.status).toBe('unknown');
    expect(session().requestedEnvironment).toBeUndefined();
  });

  it('remembers each repository independently when switching back and forth', () => {
    const other: Input = { repository: { platform: 'github', fullName: 'Kilo-Org/cloud' } };
    render();
    act(() => session().chooseEnvironment('second'));
    render(other);
    expect(session().selection.status).toBe('choose');
    act(() => session().chooseEnvironment('first'));
    render();
    expect(session().environment?.id).toBe('second');
    render(other);
    expect(session().environment?.id).toBe('first');
  });

  it('isolates personal and organization choices, including different organizations', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    render({ repository, organizationId: 'org-1' });
    expect(session().selection.status).toBe('choose');
    act(() => session().chooseEnvironment('first'));
    render({ repository, organizationId: 'org-2' });
    expect(session().selection.status).toBe('choose');
    render();
    expect(session().environment?.id).toBe('second');
    render({ repository, organizationId: 'org-1' });
    expect(session().environment?.id).toBe('first');
  });

  it('normalizes repository casing when restoring a choice', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    remount({ repository: { platform: 'github', fullName: 'kilo-org/KILOCODE' } });
    expect(session().environment?.id).toBe('second');
  });

  it('does not reuse a choice for the same repository path on another provider', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    render({ repository: { platform: 'gitlab', projectPath: repository.fullName } });
    expect(session().selection.status).toBe('choose');
  });

  it('uses stable Bitbucket UUIDs rather than the display name', () => {
    const repo = {
      platform: 'bitbucket',
      fullName: 'team/repo',
      workspaceUuid: '{ABC}',
      repositoryUuid: '{DEF}',
    } as const;
    render({ repository: repo });
    act(() => session().chooseEnvironment('second'));
    remount({
      repository: { ...repo, fullName: 'team/renamed', workspaceUuid: '{abc}' },
    });
    expect(session().environment?.id).toBe('second');
    render({ repository: { ...repo, repositoryUuid: '{OTHER}' } });
    expect(session().selection.status).toBe('choose');
  });

  it('does not apply a cached GitHub default to the same path on Bitbucket', () => {
    mockDefault = { mode: 'none' };
    render({
      repository: {
        platform: 'bitbucket',
        fullName: repository.fullName,
        workspaceUuid: '{ABC}',
        repositoryUuid: '{DEF}',
      },
    });
    expect(session().selection.status).toBe('choose');
  });

  it('requires another choice when the remembered environment no longer matches', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    mockMatches = environments.map(environment =>
      environment.id === 'second' ? { ...environment, id: 'replacement' } : environment
    );
    remount();
    expect(session().selection.status).toBe('choose');
    expect(session().choice).toBeNull();
    expect(session().requestedEnvironment).toBeUndefined();
    expect(session().environment).toBeUndefined();
  });

  it('preserves the choice through loading and failed queries', () => {
    render();
    act(() => session().chooseEnvironment('second'));
    mockMatches = undefined;
    mockLoading = true;
    remount();
    expect(session().selection.status).toBe('loading');
    mockLoading = false;
    render();
    expect(session().selection.status).toBe('unknown');
    mockMatches = environments;
    render();
    expect(session().environment?.id).toBe('second');
  });

  it('still automatically selects a single match and supports no matches', () => {
    mockMatches = environments.slice(0, 1);
    render();
    expect(session().environment?.id).toBe('first');
    expect(session().requestedEnvironment).toBeUndefined();
    mockMatches = [];
    render();
    expect(session().environment).toBeNull();
    expect(storage.size).toBe(0);
  });

  it('keeps selection usable when browser storage is unavailable', () => {
    jest.spyOn(dom.window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    jest.spyOn(dom.window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    render();
    act(() => session().chooseEnvironment('second'));
    expect(session().environment?.id).toBe('second');
  });
});
