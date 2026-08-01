/* eslint-disable vitest/prefer-describe-function-title -- conflicts with jest/valid-title which requires string titles */
import { describe, expect, it } from 'vitest';
import {
  SIDE_PANEL_MODE_STORAGE_KEY,
  loadSidePanelMode,
  saveSidePanelMode,
} from './side-panel-mode';
import type { SidePanelMode } from './side-panel-mode';

const makeStorage = (initial?: unknown) => {
  let stored: unknown = initial;
  return {
    getItem: () => stored,
    removeItem: () => {
      stored = undefined;
    },
    setItem: (_key: string, value: SidePanelMode) => {
      stored = value;
    },
  };
};

describe('loadSidePanelMode', () => {
  it('returns browser when nothing is stored', async () => {
    const mode = await loadSidePanelMode(makeStorage());
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is null', async () => {
    const mode = await loadSidePanelMode(makeStorage(null));
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is a junk string', async () => {
    const mode = await loadSidePanelMode(makeStorage('junk'));
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is a number', async () => {
    const mode = await loadSidePanelMode(makeStorage(42));
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is an object', async () => {
    const mode = await loadSidePanelMode(makeStorage({ foo: 'bar' }));
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is an empty string', async () => {
    const mode = await loadSidePanelMode(makeStorage(''));
    expect(mode).toBe('browser');
  });

  it('returns browser when getItem throws', async () => {
    const storage = {
      ...makeStorage(),
      getItem: () => {
        throw new Error('boom');
      },
    };
    const mode = await loadSidePanelMode(storage);
    expect(mode).toBe('browser');
  });

  it('returns browser when stored value is "browser"', async () => {
    const mode = await loadSidePanelMode(makeStorage('browser'));
    expect(mode).toBe('browser');
  });

  it('returns agents when stored value is "agents"', async () => {
    const mode = await loadSidePanelMode(makeStorage('agents'));
    expect(mode).toBe('agents');
  });
});

describe('saveSidePanelMode', () => {
  it('saves browser', async () => {
    const storage = makeStorage();
    await saveSidePanelMode(storage, 'browser');
    const mode = await loadSidePanelMode(storage);
    expect(mode).toBe('browser');
  });

  it('saves agents', async () => {
    const storage = makeStorage();
    await saveSidePanelMode(storage, 'agents');
    const mode = await loadSidePanelMode(storage);
    expect(mode).toBe('agents');
  });

  it('overwrites previous value', async () => {
    const storage = makeStorage('browser');
    await saveSidePanelMode(storage, 'agents');
    const mode = await loadSidePanelMode(storage);
    expect(mode).toBe('agents');
  });

  it('uses the correct storage key', async () => {
    // eslint-disable-next-line init-declarations -- captured by closure, initialized before use
    let capturedKey: string | undefined;
    const storage = {
      getItem: (_key: unknown) => {},
      removeItem: () => {},
      setItem: (key: string, _value: SidePanelMode) => {
        capturedKey = key;
      },
    };
    await saveSidePanelMode(storage, 'agents');
    expect(capturedKey).toBe(SIDE_PANEL_MODE_STORAGE_KEY);
  });
});
