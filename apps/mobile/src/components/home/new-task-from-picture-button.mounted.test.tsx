import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';
import { NewTaskFromPictureButton } from '@/components/home/new-task-from-picture-button';

const state = vi.hoisted(() => ({
  userId: 'user-1' as string | undefined,
  push: vi.fn(),
  focusEffects: [] as (() => void)[],
  now: 1_700_000_000_000,
  pickAgentPicture: vi.fn(),
  stagePictureForNewSession: vi.fn(),
  recovery: vi.fn(),
  themedSheet: {
    containerStyle: { backgroundColor: '#17171A', paddingBottom: 18 },
    textStyle: { color: '#F2F0EB' },
    titleTextStyle: { color: '#8A8680' },
    messageTextStyle: { color: '#8A8680' },
    destructiveColor: '#F28B7A',
  },
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push }),
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.push(effect);
  },
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-themed-action-sheet', () => ({
  useThemedActionSheetOptions: () => state.themedSheet,
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Camera: 'Camera' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ secondaryForeground: '#14130F' }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: state.userId }),
}));
// The picker, the staging path, and the Android recovery hook each reach a
// native module at load time; these mocks keep the entry's own wiring under
// test instead of the modules it composes.
vi.mock('@/components/agents/attachment-picker', () => ({
  pickAgentPicture: state.pickAgentPicture,
}));
vi.mock('@/lib/agent-attachments/picture-entry', () => ({
  stagePictureForNewSession: state.stagePictureForNewSession,
}));
vi.mock('@/lib/agent-attachments/use-android-pending-picker-recovery', () => ({
  useAndroidPendingPickerRecovery: state.recovery,
}));

type Candidate = { name: string; uri: string };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function nodesOfType(type: string): TestRenderer.ReactTestInstance[] {
  return renderer === undefined
    ? []
    : renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function entry(): TestRenderer.ReactTestInstance {
  const nodes = nodesOfType('Button');
  const node = nodes[0];
  if (nodes.length !== 1 || !node) {
    throw new Error(`Expected one entry button, received ${nodes.length}`);
  }
  return node;
}

/** The entry's press handler, narrowed once for the calls below. */
function pressHandler(): () => void {
  const handler: unknown = entry().props.onPress;
  if (typeof handler !== 'function') {
    throw new TypeError('Expected the picture entry to carry a press handler');
  }
  return handler as () => void;
}

/** Press the entry and let its async handler settle. */
async function press(): Promise<void> {
  await act(async () => {
    pressHandler()();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Press the entry twice, as a fast double tap does, and let both settle. */
async function doublePress(): Promise<void> {
  await act(async () => {
    const handler = pressHandler();
    handler();
    handler();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Run the focus effect the way the screen regaining focus does. */
async function regainFocus(): Promise<void> {
  await act(async () => {
    for (const effect of state.focusEffects) {
      effect();
    }
    await Promise.resolve();
  });
}

function labels(): string[] {
  return nodesOfType('Text').map(node =>
    node.children.filter(child => typeof child === 'string').join('')
  );
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(NewTaskFromPictureButton, { organizationId: 'org-1' })
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.userId = 'user-1';
  state.push.mockReset();
  state.focusEffects = [];
  state.now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => state.now);
  state.pickAgentPicture.mockReset();
  state.stagePictureForNewSession.mockReset().mockReturnValue(null);
  state.recovery.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

describe('NewTaskFromPictureButton', () => {
  it('stages the picked picture and opens the composer href it returns', async () => {
    const candidate: Candidate = { name: 'photo.png', uri: 'file:///cache/photo.png' };
    state.pickAgentPicture.mockResolvedValue([candidate]);
    state.stagePictureForNewSession.mockReturnValue('/(app)/agent-chat/new?shareId=share-1');
    await mount();

    await press();

    expect(state.stagePictureForNewSession).toHaveBeenCalledExactlyOnceWith({
      candidates: [candidate],
      organizationId: 'org-1',
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/new?shareId=share-1');
    expect(labels()).toContain('New task from a picture');
  });

  it('stages nothing and pushes nothing when no picture came back', async () => {
    state.pickAgentPicture.mockResolvedValue([]);
    await mount();

    await press();

    expect(state.stagePictureForNewSession).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('leaves the screen untouched when the picker launch rejects', async () => {
    state.pickAgentPicture.mockRejectedValueOnce(new Error('picker unavailable'));
    await mount();

    await press();

    expect(state.stagePictureForNewSession).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('asks the picker for the agent-picture surface of the current account', async () => {
    state.pickAgentPicture.mockResolvedValue([]);
    await mount();

    await press();

    expect(state.pickAgentPicture).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      {
        userId: 'user-1',
        surface: 'agent-picture',
        sessionId: null,
      },
      state.themedSheet
    );
  });

  it('mounts Android pending-picker recovery for the agent-picture surface and delivers the recovered picture', async () => {
    await mount();

    expect(state.recovery).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'agent-picture', sessionId: null })
    );
    const recovered: Candidate = { name: 'camera.jpg', uri: 'file:///cache/camera.jpg' };
    state.stagePictureForNewSession.mockReturnValue('/(app)/agent-chat/new?shareId=share-2');
    const options = state.recovery.mock.calls[0]?.[0] as {
      addCandidates: (candidates: Candidate[]) => Promise<void>;
    };

    await act(async () => {
      await options.addCandidates([recovered]);
    });

    expect(state.stagePictureForNewSession).toHaveBeenCalledExactlyOnceWith({
      candidates: [recovered],
      organizationId: 'org-1',
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/new?shareId=share-2');
  });

  it('opens the composer once on a fast double tap', async () => {
    const candidate: Candidate = { name: 'photo.png', uri: 'file:///cache/photo.png' };
    state.pickAgentPicture.mockResolvedValue([candidate]);
    state.stagePictureForNewSession.mockReturnValue('/(app)/agent-chat/new?shareId=share-1');
    await mount();

    await doublePress();

    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/new?shareId=share-1');
  });

  it('opens the composer again on a tap after the guard window', async () => {
    const candidate: Candidate = { name: 'photo.png', uri: 'file:///cache/photo.png' };
    state.pickAgentPicture.mockResolvedValue([candidate]);
    state.stagePictureForNewSession.mockReturnValue('/(app)/agent-chat/new?shareId=share-1');
    await mount();
    await press();

    state.now += 1000;
    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });

  it('opens the composer again after the screen regains focus', async () => {
    const candidate: Candidate = { name: 'photo.png', uri: 'file:///cache/photo.png' };
    state.pickAgentPicture.mockResolvedValue([candidate]);
    state.stagePictureForNewSession.mockReturnValue('/(app)/agent-chat/new?shareId=share-1');
    await mount();
    await doublePress();
    await regainFocus();

    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });
});
