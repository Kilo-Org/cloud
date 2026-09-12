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
});
