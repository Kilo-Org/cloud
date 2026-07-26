import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharePayloadStoreForTests,
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

vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  copyAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
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

  it('no-ops when take returns null (already consumed or unknown id)', async () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const addCandidatesCalls: AgentAttachmentCandidate[][] = [];
    const clearCalls: number[] = [];

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
    });

    expect(nativeCalls).toEqual([]);
    expect(changeCalls).toEqual([]);
    expect(addCandidatesCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
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

  it('keeps text and does not restore the payload when addCandidates throws', async () => {
    const id = putSharePayload({
      text: 'keep me',
      files: [{ name: 'bad.png', uri: 'file:///bad.png' }],
    });
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const clearCalls: number[] = [];

    await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: rejectAfterTick,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
    });

    expect(changeCalls).toEqual(['keep me']);
    expect(nativeCalls).toEqual([{ text: 'keep me' }]);
    // Param still cleared after the throw path (hygiene; no retry).
    expect(clearCalls).toHaveLength(1);
    // Payload was consumed and not restored.
    expect(takeSharePayload(id)).toBeNull();

    // A second apply with the same id is a take-null no-op (no re-apply).
    changeCalls.length = 0;
    await applySharePrefill({
      shareId: id,
      input,
      maxLength: 4000,
      onChangeText,
      addCandidates: rejectAfterTick,
      clearShareIdParam: () => {
        clearCalls.push(1);
      },
    });
    expect(changeCalls).toEqual([]);
  });

  it('clears the route param after a successful prefill', async () => {
    const id = putSharePayload({ text: 'ok', files: [] });
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
    const firstId = putSharePayload({ text: 'first', files: [] });
    const secondId = putSharePayload({ text: 'second', files: [] });
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
    const id = putSharePayload({ text: '', files });
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
