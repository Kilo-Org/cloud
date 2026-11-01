/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  putSharePayload,
  takeSharePayload,
} from '@/lib/share-payload';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';

import { applySharePrefill } from './share-prefill';

vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `share-id-${n}`;
    },
  };
});

const expoFileSystemMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const File = vi.fn(function FileMock(_base: unknown, ...rest: unknown[]) {
    const uri =
      rest.length > 0 ? `${(_base as { uri: string }).uri}/${String(rest[0])}` : String(_base);
    return {
      uri,
      get exists() {
        return files.has(uri);
      },
      write(content: string) {
        files.set(uri, content);
      },
      textSync() {
        return files.get(uri) ?? '';
      },
      delete() {
        files.delete(uri);
      },
    };
  });
  return {
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

// share-prefill also exports the React hook (expo-router). Keep the pure core
// testable without a renderer by stubbing RN + router so vitest never parses
// react-native's Flow sources.
vi.mock('react-native', () => ({}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    setParams: vi.fn(),
  }),
}));

function makeInput() {
  const calls: { text: string }[] = [];
  const input = {
    setNativeProps(props: { text: string }): void {
      calls.push({ text: props.text });
    },
  };
  return { input, calls };
}

function makeChange() {
  const calls: string[] = [];
  const onChangeText = (draft: string): void => {
    calls.push(draft);
  };
  return { onChangeText, calls };
}

function noopChange(): void {
  // no-op change handler for cases that only assert side effects
}

function noopClear(): void {
  // no-op clear for cases that only assert text delivery
}

async function resolveImmediately(): Promise<void> {
  await Promise.resolve();
}

async function rejectAfterTick(): Promise<void> {
  await Promise.resolve();
  throw new Error('upload failed');
}

describe('applySharePrefill', () => {
  beforeEach(() => {
    __resetSharePayloadStoreForTests();
  });

  it('clears the route params when take returns null (already consumed or unknown id)', async () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const addCandidatesCalls: AgentAttachmentCandidate[][] = [];
    const clearCalls: number[] = [];
    const deliveredCalls: number[] = [];

    await applySharePrefill({
      shareId: 'missing',
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: async candidates => {
        await Promise.resolve();
        addCandidatesCalls.push(candidates);
      },
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
    });

    expect(nativeCalls).toEqual([]);
    expect(changeCalls).toEqual([]);
    expect(addCandidatesCalls).toEqual([]);
    expect(deliveredCalls).toEqual([]);
    expect(clearCalls).toEqual([1]);
  });

  it('no-ops when shareId is empty or undefined', async () => {
    const { onChangeText, calls: changeCalls } = makeChange();
    const addCandidatesCalls: AgentAttachmentCandidate[][] = [];
    const clearCalls: number[] = [];
    const addCandidates = async (candidates: AgentAttachmentCandidate[]): Promise<void> => {
      await Promise.resolve();
      addCandidatesCalls.push(candidates);
    };
    const clearShareIdParam = (): void => {
      clearCalls.push(1);
    };

    await applySharePrefill({
      shareId: undefined,
      input: null,
      maxLength: 4000,
      onChangeText,
      addCandidates,
      clearShareIdParam,
    });
    await applySharePrefill({
      shareId: '',
      input: null,
      maxLength: 4000,
      onChangeText,
      addCandidates,
      clearShareIdParam,
    });

    expect(changeCalls).toEqual([]);
    expect(addCandidatesCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
  });

  it('applies text before files are awaited', async () => {
    const id = putSharePayload({
      text: 'shared body',
      files: [{ name: 'a.png', uri: 'file:///a.png' }],
      failedFiles: [],
    });
    const { input, calls: nativeCalls } = makeInput();
    const order: string[] = [];
    const onChangeText = (text: string): void => {
      order.push(`text:${text}`);
    };
    const fileHold = {
      release: (): void => {
        // replaced when the gate promise is constructed
      },
    };
    const filesGate = new Promise<undefined>(resolve => {
      fileHold.release = (): void => {
        resolve(undefined);
      };
    });
    const addCandidates = async (): Promise<void> => {
      order.push('files-start');
      await filesGate;
      order.push('files-done');
    };
    const clearShareIdParam = (): void => {
      order.push('clear');
    };

    const run = applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates,
      clearShareIdParam,
    });

    // Text is applied synchronously before addCandidates is entered; the
    // files promise is still pending so clear has not run yet.
    expect(order).toEqual(['text:shared body', 'files-start']);
    expect(nativeCalls).toEqual([{ text: 'shared body' }]);
    expect(order.indexOf('text:shared body')).toBeLessThan(order.indexOf('files-start'));
    expect(order).not.toContain('clear');

    fileHold.release();
    await run;

    expect(order).toEqual(['text:shared body', 'files-start', 'files-done', 'clear']);
  });

  it('keeps text, restores the payload, and leaves the param when addCandidates throws', async () => {
    const id = putSharePayload({
      text: 'keep me',
      files: [{ name: 'bad.png', uri: 'file:///bad.png' }],
      failedFiles: [],
    });
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const clearCalls: number[] = [];
    const deliveredCalls: number[] = [];

    const delivered = await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: rejectAfterTick,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
    });

    expect(delivered).toBe(false);
    expect(changeCalls).toEqual(['keep me']);
    expect(nativeCalls).toEqual([{ text: 'keep me' }]);
    // Nothing was delivered, so neither the delivery signal nor the param clear
    // runs: the param is what re-arms the retry.
    expect(deliveredCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
    // The files are back under the same id, so the retry re-delivers them.
    expect(peekSharePayload(id)).not.toBeNull();

    // The retry — the composer's own Retry — delivers the same files, and does
    // not put the text back over whatever the person typed after the failure.
    changeCalls.length = 0;
    nativeCalls.length = 0;
    const retried = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const retryDelivered = await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: retried,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
      applyText: false,
    });
    expect(retryDelivered).toBe(true);
    expect(retried).toHaveBeenCalledExactlyOnceWith([{ name: 'bad.png', uri: 'file:///bad.png' }]);
    expect(changeCalls).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(deliveredCalls).toEqual([1]);
    expect(clearCalls).toEqual([1]);
  });

  it('delivers nothing for a share whose composer moved on', async () => {
    const id = putSharePayload({
      text: 'stale body',
      files: [{ name: 'stale.png', uri: 'file:///stale.png' }],
      failedFiles: [],
    });
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const addCandidates = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const clearCalls: number[] = [];
    const deliveredCalls: number[] = [];

    const delivered = await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
      isCurrent: () => false,
    });

    expect(delivered).toBe(false);
    expect(changeCalls).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(addCandidates).not.toHaveBeenCalled();
    // The param now names the newer share, so it must not be cleared here.
    expect(clearCalls).toEqual([]);
    expect(deliveredCalls).toEqual([]);
    // The staged payload is not lost to the take.
    expect(peekSharePayload(id)).not.toBeNull();
  });

  it('with files, calls onDelivered after addCandidates and before clearShareIdParam', async () => {
    const id = putSharePayload({
      text: 'shared body',
      files: [{ name: 'a.png', uri: 'file:///a.png' }],
      failedFiles: [],
    });
    const order: string[] = [];
    const addCandidates = async (): Promise<void> => {
      order.push('files-start');
      // Resolve on a later microtask so a wrong order actually fails.
      await Promise.resolve();
      order.push('files-done');
    };

    await applySharePrefill({
      shareId: id,
      input: null,
      maxLength: 4000,
      onChangeText: () => {
        order.push('text');
      },
      addCandidates,
      clearShareIdParam: () => {
        order.push('clear');
      },
      onDelivered: () => {
        order.push('delivered');
      },
    });

    expect(order).toEqual(['text', 'files-start', 'files-done', 'delivered', 'clear']);
  });

  it('fires onDelivered for a text-only payload before clearShareIdParam', async () => {
    const id = putSharePayload({ text: 'text only', files: [], failedFiles: [] });
    const order: string[] = [];

    await applySharePrefill({
      shareId: id,
      input: null,
      maxLength: 4000,
      onChangeText: () => {
        order.push('text');
      },
      addCandidates: resolveImmediately,
      clearShareIdParam: () => {
        order.push('clear');
      },
      onDelivered: () => {
        order.push('delivered');
      },
    });

    expect(order).toEqual(['text', 'delivered', 'clear']);
  });

  it('fires neither onDelivered nor clearShareIdParam when shareId is undefined or empty', async () => {
    const deliveredCalls: number[] = [];
    const clearCalls: number[] = [];

    await applySharePrefill({
      shareId: undefined,
      input: null,
      maxLength: 4000,
      onChangeText: noopChange,
      addCandidates: resolveImmediately,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
    });
    await applySharePrefill({
      shareId: '',
      input: null,
      maxLength: 4000,
      onChangeText: noopChange,
      addCandidates: resolveImmediately,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
      onDelivered: () => {
        deliveredCalls.push(1);
      },
    });

    expect(deliveredCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
  });

  it('clears the route param after a successful prefill', async () => {
    const id = putSharePayload({ text: 'ok', files: [], failedFiles: [] });
    const clearCalls: number[] = [];

    await applySharePrefill({
      shareId: id,
      input: null,
      maxLength: 4000,
      onChangeText: noopChange,
      addCandidates: resolveImmediately,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
    });

    expect(clearCalls).toHaveLength(1);
    expect(takeSharePayload(id)).toBeNull();
  });

  it('re-applies when a second share arrives with a new id', async () => {
    const firstId = putSharePayload({ text: 'first', files: [], failedFiles: [] });
    const secondId = putSharePayload({ text: 'second', files: [], failedFiles: [] });
    const { onChangeText, calls: changeCalls } = makeChange();

    await applySharePrefill({
      shareId: firstId,
      input: null,
      maxLength: 4000,
      onChangeText,
      addCandidates: resolveImmediately,
      clearShareIdParam: noopClear,
    });
    await applySharePrefill({
      shareId: secondId,
      input: null,
      maxLength: 4000,
      onChangeText,
      addCandidates: resolveImmediately,
      clearShareIdParam: noopClear,
    });

    expect(changeCalls).toEqual(['first', 'second']);
  });

  it('skips the text call for empty text + files-only payloads', async () => {
    const files = [{ name: 'only.png', uri: 'file:///only.png' }];
    const id = putSharePayload({ text: '', files, failedFiles: [] });
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const addCandidatesCalls: AgentAttachmentCandidate[][] = [];
    const clearCalls: number[] = [];

    await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: async candidates => {
        await Promise.resolve();
        addCandidatesCalls.push(candidates);
      },
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
    });

    expect(nativeCalls).toEqual([]);
    expect(changeCalls).toEqual([]);
    expect(addCandidatesCalls).toEqual([files]);
    expect(clearCalls).toHaveLength(1);
  });
});
