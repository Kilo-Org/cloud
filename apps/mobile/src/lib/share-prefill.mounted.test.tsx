import { type ReactNode, type RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  putSharePayload,
} from '@/lib/share-payload';
import { act, TestRenderer } from '@/test/renderer';

import { type SharePrefillControl, useSharePrefill } from './share-prefill';

vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2)}`),
}));

vi.mock('expo-file-system', () => ({
  // No cache copy exists in these cases, so the store never deletes one.
  File: class {
    exists = false;
  },
  Paths: { cache: { uri: 'file:///cache/' } },
}));

// The hook only reads the router to clear the param; the payload store, the
// retry state and the text it applies are what these cases assert.
const routerMock = vi.hoisted(() => ({ setParams: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => routerMock }));

type PrefillInput = { setNativeProps: (props: { text: string }) => void };

type HarnessProps = {
  shareId: string;
  input: RefObject<PrefillInput | null>;
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  onChangeText: (text: string) => void;
  onControl: (control: SharePrefillControl) => void;
};

function Harness({
  shareId,
  input,
  addCandidates,
  onChangeText,
  onControl,
}: HarnessProps): ReactNode {
  onControl(
    useSharePrefill({ shareId, inputRef: input, maxLength: 4000, onChangeText, addCandidates })
  );
  return null;
}

function makeInput(): { ref: RefObject<PrefillInput | null>; calls: { text: string }[] } {
  const calls: { text: string }[] = [];
  return {
    calls,
    ref: {
      current: {
        setNativeProps: (props: { text: string }) => {
          calls.push(props);
        },
      },
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let control: SharePrefillControl | undefined = undefined;

function currentControl(): SharePrefillControl {
  if (!control) {
    throw new Error('hook never rendered');
  }
  return control;
}

async function mount(
  props: Omit<HarnessProps, 'onControl'>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      <Harness
        {...props}
        onControl={next => {
          control = next;
        }}
      />
    );
  });
  await settle();
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

beforeEach(() => {
  __resetSharePayloadStoreForTests();
  routerMock.setParams.mockReset();
  control = undefined;
});

describe('useSharePrefill control', () => {
  it('reports a failed delivery, keeps the payload, and re-delivers it on retry', async () => {
    const id = putSharePayload({
      text: 'shared body',
      files: [{ name: 'photo.jpg', uri: 'file:///cache/photo.jpg' }],
      failedFiles: [],
    });
    const attempted: AgentAttachmentCandidate[][] = [];
    const addCandidates = async (candidates: AgentAttachmentCandidate[]): Promise<void> => {
      attempted.push(candidates);
      await Promise.resolve();
      if (attempted.length === 1) {
        throw new Error('attach failed');
      }
    };
    const input = makeInput();
    const changed: string[] = [];

    await mount({
      shareId: id,
      input: input.ref,
      addCandidates,
      onChangeText: text => {
        changed.push(text);
      },
    });

    expect(currentControl().failed).toBe(true);
    expect(peekSharePayload(id)).not.toBeNull();
    expect(changed).toEqual(['shared body']);
    expect(routerMock.setParams).not.toHaveBeenCalled();

    act(() => {
      currentControl().retry();
    });
    await settle();

    expect(currentControl().failed).toBe(false);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toEqual([{ name: 'photo.jpg', uri: 'file:///cache/photo.jpg' }]);
    // The text landed once, on the first attempt.
    expect(changed).toEqual(['shared body']);
    expect(peekSharePayload(id)).toBeNull();
    expect(routerMock.setParams).toHaveBeenCalledExactlyOnceWith({
      shareId: undefined,
      autoSend: undefined,
    });
  });

  it('still applies the text of a later share after an earlier one failed', async () => {
    const firstId = putSharePayload({
      text: 'first body',
      files: [{ name: 'first.jpg', uri: 'file:///cache/first.jpg' }],
      failedFiles: [],
    });
    const secondId = putSharePayload({
      text: 'second body',
      files: [],
      failedFiles: [],
    });
    const input = makeInput();
    const changed: string[] = [];
    const reject = async (): Promise<void> => {
      await Promise.resolve();
      throw new Error('attach failed');
    };

    const renderer = await mount({
      shareId: firstId,
      input: input.ref,
      addCandidates: reject,
      onChangeText: text => {
        changed.push(text);
      },
    });
    expect(currentControl().failed).toBe(true);

    // A second share arrives on the same mounted composer.
    await act(async () => {
      await Promise.resolve();
      renderer.update(
        <Harness
          shareId={secondId}
          input={input.ref}
          addCandidates={async () => {
            await Promise.resolve();
            // nothing to attach in the second share
          }}
          onChangeText={text => {
            changed.push(text);
          }}
          onControl={next => {
            control = next;
          }}
        />
      );
    });
    await settle();

    expect(changed).toEqual(['first body', 'second body']);
    expect(currentControl().failed).toBe(false);
    expect(peekSharePayload(firstId)).not.toBeNull();
    expect(peekSharePayload(secondId)).toBeNull();
  });

  it('dismiss abandons the staged payload and clears the param', async () => {
    const id = putSharePayload({
      text: '',
      files: [{ name: 'photo.jpg', uri: 'file:///cache/photo.jpg' }],
      failedFiles: [],
    });
    const reject = async (): Promise<void> => {
      await Promise.resolve();
      throw new Error('attach failed');
    };

    await mount({
      shareId: id,
      input: makeInput().ref,
      addCandidates: reject,
      onChangeText: vi.fn<() => void>(),
    });
    expect(currentControl().failed).toBe(true);
    expect(peekSharePayload(id)).not.toBeNull();

    act(() => {
      currentControl().dismiss();
    });
    await settle();

    expect(currentControl().failed).toBe(false);
    expect(peekSharePayload(id)).toBeNull();
    expect(routerMock.setParams).toHaveBeenCalledWith({ shareId: undefined, autoSend: undefined });
  });
});
