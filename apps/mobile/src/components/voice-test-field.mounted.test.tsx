/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as preferences-screen.mounted.test.tsx) */
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { VoiceTestField } from '@/components/voice-test-field';
import { renderWithProviders } from '@/test/render-with-providers';

type VoiceInputOptions = {
  disabled: boolean;
  getDraft: () => string;
  onDraftChange: (draft: string) => void;
};

const voice = vi.hoisted(() => ({
  options: undefined as VoiceInputOptions | undefined,
  available: true,
  feedback: null as {
    action: 'none' | 'open-settings' | 'open-transcription-settings';
    availability: 'available' | 'unavailable';
    message: string;
    retryable: boolean;
  } | null,
  isActive: false,
  status: 'idle' as 'idle' | 'starting' | 'listening' | 'transcribing' | 'stopping',
  abort: vi.fn<() => Promise<boolean>>(),
  toggle: vi.fn<() => Promise<void>>(),
}));
const applyVoiceDraftToInput = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: 'VoiceInputButton',
  VoiceInputStatus: 'VoiceInputStatus',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#000000' }),
}));
vi.mock('@/lib/voice-input/use-voice-input', () => ({
  useVoiceInput: (options: VoiceInputOptions) => {
    voice.options = options;
    return {
      abort: voice.abort,
      available: voice.available,
      feedback: voice.feedback,
      isActive: voice.isActive,
      settleBeforeSubmit: vi.fn<() => Promise<boolean>>(),
      status: voice.status,
      toggle: voice.toggle,
    };
  },
}));
vi.mock('@/lib/voice-input/voice-input-draft', () => ({
  applyVoiceDraftToInput,
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountVoiceTestField(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<VoiceTestField />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}

function findByType(renderer: ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findByLabel(renderer: ReactTestRenderer, label: string) {
  const node = findByType(renderer, 'Pressable').find(
    item => item.props.accessibilityLabel === label
  );
  if (!node) {
    throw new Error(`Pressable ${label} not found`);
  }
  return node;
}

function textValues(renderer: ReactTestRenderer): string[] {
  return findByType(renderer, 'Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  voice.options = undefined;
  voice.available = true;
  voice.feedback = null;
  voice.isActive = false;
  voice.status = 'idle';
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('VoiceTestField', () => {
  it('renders the title and the placeholder in a multiline input with no value', async () => {
    const renderer = await mountVoiceTestField();

    expect(textValues(renderer)).toContain('Test voice input');

    const [input] = findByType(renderer, 'TextInput');
    if (!input) {
      throw new Error('TextInput not found');
    }
    expect(input.props).toMatchObject({
      defaultValue: '',
      multiline: true,
      placeholder: 'Tap the microphone and start speaking.',
      textAlignVertical: 'top',
    });
    // Uncontrolled on iOS: text flows through the native draft writes, never a
    // controlled `value` prop.
    expect(input.props.value).toBeUndefined();
  });

  it('starts and stops the shared voice session from the mic button', async () => {
    const renderer = await mountVoiceTestField();

    const [button] = findByType(renderer, 'VoiceInputButton');
    if (!button) {
      throw new Error('VoiceInputButton not found');
    }
    expect(button.props).toMatchObject({ size: 'md', status: 'idle', disabled: false });

    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(voice.toggle).toHaveBeenCalledTimes(1);
  });

  it('routes live transcripts through applyVoiceDraftToInput', async () => {
    await mountVoiceTestField();

    if (!voice.options) {
      throw new Error('useVoiceInput options were not captured');
    }
    expect(voice.options.disabled).toBe(false);
    expect(voice.options.getDraft()).toBe('');

    act(() => {
      voice.options?.onDraftChange('hello');
    });
    expect(applyVoiceDraftToInput).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'hello' })
    );
  });

  it('aborts an active session and empties the field from Clear', async () => {
    voice.isActive = true;
    const renderer = await mountVoiceTestField();

    const clear = findByLabel(renderer, 'Clear text');
    expect(clear.props.disabled).toBe(false);

    act(() => {
      (clear.props.onPress as () => void)();
    });
    expect(voice.abort).toHaveBeenCalledTimes(1);
  });

  it('keeps Clear present but inert while there is nothing to clear', async () => {
    const renderer = await mountVoiceTestField();

    const clear = findByLabel(renderer, 'Clear text');
    expect(clear.props.disabled).toBe(true);
  });

  it('gives Clear a 44pt effective touch target distinct from its disabled state', async () => {
    const renderer = await mountVoiceTestField();

    const clear = findByLabel(renderer, 'Clear text');
    const className = clear.props.className as string;
    // DESIGN.md: touch surfaces keep at least a 44px target. An arbitrary px
    // value, not the rem-scaled min-h-11/min-w-11: NativeWind's rem is ~14px
    // on device, so those render ~38.5pt tall (e14, 2026-09-12).
    expect(className).toContain('min-h-[44px]');
    expect(className).toContain('min-w-[44px]');
    expect(className).toContain('items-center');
    expect(className).toContain('justify-center');
    expect(className).toContain('disabled:opacity-50');
  });

  it('renders a transient failure inline, where the accessibility tree can see it', async () => {
    voice.feedback = {
      action: 'none',
      availability: 'available',
      message: "Couldn't reach the Kilo gateway. Check your connection and try again.",
      retryable: true,
    };
    const renderer = await mountVoiceTestField();

    const [status] = findByType(renderer, 'AccessibleStatus');
    expect(status?.props).toMatchObject({
      message: "Couldn't reach the Kilo gateway. Check your connection and try again.",
      tone: 'error',
    });
    expect(textValues(renderer)).not.toContain('Listening...');
  });

  it('leaves alert-backed feedback to its own surface', async () => {
    voice.feedback = {
      action: 'open-settings',
      availability: 'available',
      message: 'Microphone access is off.',
      retryable: false,
    };
    const renderer = await mountVoiceTestField();

    expect(findByType(renderer, 'AccessibleStatus')).toHaveLength(0);
  });

  it('shows no failure line while the session is healthy', async () => {
    const renderer = await mountVoiceTestField();

    expect(findByType(renderer, 'AccessibleStatus')).toHaveLength(0);
  });
});
