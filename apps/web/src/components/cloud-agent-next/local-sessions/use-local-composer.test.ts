import React, { act, createElement } from 'react';
import { createRequire } from 'node:module';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider, type PrimitiveAtom } from 'jotai';
import type { FetchedSessionData, SessionConfig, SessionManager } from '@kilocode/cloud-agent-sdk';
import {
  LocalSessionsProvider,
  useLocalSessions,
  type SendLocalSession,
} from './LocalSessionsProvider';
import { readStoredLocalSessions } from './local-session-storage';
import { useLocalComposer } from './use-local-composer';

describe('local workspace composer settings', () => {
  let root: Root;
  let restore: () => void;
  let local: ReturnType<typeof useLocalSessions>;
  let composer: ReturnType<typeof useLocalComposer>;
  let store: ReturnType<typeof createStore>;
  let manager: SessionManager;
  let configAtom: PrimitiveAtom<SessionConfig | null>;
  let metadataAtom: PrimitiveAtom<FetchedSessionData | null>;
  let settleCreation: ((id: string) => void) | undefined;

  beforeEach(() => {
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: Window; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const previous = {
      React: (globalThis as { React?: typeof React }).React,
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT,
    };
    Object.assign(globalThis, { React, window, document, IS_REACT_ACT_ENVIRONMENT: true });
    restore = () => Object.assign(globalThis, previous);
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    store = createStore();
    configAtom = atom<SessionConfig | null>(null);
    metadataAtom = atom<FetchedSessionData | null>(null);
    manager = {
      atoms: {
        sessionConfig: configAtom,
        fetchedSessionData: metadataAtom,
      },
      setCloudAgentModelOverride: jest.fn(),
    } as unknown as SessionManager;
    settleCreation = undefined;
    const send: SendLocalSession = () =>
      new Promise(resolve => {
        settleCreation = resolve;
      });

    function Probe() {
      local = useLocalSessions();
      composer = useLocalComposer(manager, local.localSessions[0] ?? null);
      return null;
    }
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(LocalSessionsProvider, {
            storageKey: 'local-composer-test',
            send,
            onAdopted: jest.fn(),
            onDiscard: jest.fn(),
            children: createElement(Probe),
          })
        )
      );
    });
    act(() => {
      local.createLocalSession({
        organizationId: 'org-local',
        worktreeId: 'worktree_local',
        repository: 'example/repository',
        branch: 'main',
        request: { kind: 'worktree-chat', sourceKiloSessionId: 'ses_source' },
        composer: {
          mode: 'code',
          model: 'example/model',
          variant: 'high',
          runtimeAgents: [{ slug: 'reviewer', name: 'Reviewer', model: 'example/pinned' }],
        },
        firstMessage: null,
      });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  it('edits and stores modes, models, and variants before the server creates the chat', () => {
    const initial = composer.composer;
    if (!initial) throw new Error('Local settings missing');
    act(() =>
      composer.updateComposer({
        ...initial,
        mode: 'reviewer',
        model: 'example/new',
        variant: 'low',
      })
    );

    expect(local.localSessions[0].sync.state).toBe('syncing');
    expect(composer.composer).toMatchObject({
      mode: 'reviewer',
      model: 'example/new',
      variant: 'low',
    });
    expect(readStoredLocalSessions('local-composer-test')[0]?.composer).toEqual(composer.composer);
    expect(store.get(manager.atoms.sessionConfig)).toBeNull();
  });

  it('preserves edits through synchronization and adopts the confirmed installed modes once', async () => {
    const initial = composer.composer;
    if (!initial) throw new Error('Local settings missing');
    act(() =>
      composer.updateComposer({
        ...initial,
        mode: 'reviewer',
        model: 'example/new',
        variant: 'low',
      })
    );
    const id = local.localSessions[0].kiloSessionId;
    if (!settleCreation) throw new Error('Creation did not start');
    await act(async () => settleCreation?.(id));
    const installed = [{ slug: 'reviewer', name: 'Confirmed reviewer' }];
    const config: SessionConfig = {
      sessionId: 'workspace_local' as SessionConfig['sessionId'],
      repository: 'example/repository',
      mode: 'code',
      model: 'example/model',
      runtimeAgents: installed,
    };
    act(() => {
      store.set(metadataAtom, {
        kiloSessionId: id,
        cloudAgentSessionId: config.sessionId,
        organizationId: 'org-local',
      } as FetchedSessionData);
      store.set(configAtom, config);
    });

    expect(store.get(manager.atoms.sessionConfig)).toEqual({
      ...config,
      mode: 'reviewer',
      model: 'example/new',
      variant: 'low',
    });
    expect(manager.setCloudAgentModelOverride).toHaveBeenCalledWith({
      model: 'example/new',
      variant: 'low',
    });
    expect(manager.setCloudAgentModelOverride).toHaveBeenCalledTimes(1);
    expect(local.localSessions[0].composer).toBeNull();
    expect(composer.composer).toBeNull();

    act(() => store.set(configAtom, { ...config, mode: 'ask' }));
    expect(store.get(manager.atoms.sessionConfig)?.mode).toBe('ask');
    expect(manager.setCloudAgentModelOverride).toHaveBeenCalledTimes(1);
  });

  it('does not apply a local draft to another loaded chat', () => {
    act(() => {
      store.set(metadataAtom, {
        kiloSessionId: 'ses_other',
        cloudAgentSessionId: 'workspace_other',
      } as FetchedSessionData);
      store.set(configAtom, {
        sessionId: 'workspace_other',
        repository: 'example/other',
        mode: 'ask',
        model: 'example/other',
      } as SessionConfig);
    });
    expect(store.get(manager.atoms.sessionConfig)?.mode).toBe('ask');
    expect(manager.setCloudAgentModelOverride).not.toHaveBeenCalled();
    expect(local.localSessions[0].composer).not.toBeNull();
  });
});
