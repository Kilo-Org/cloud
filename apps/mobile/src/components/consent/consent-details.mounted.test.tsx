/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-member-access @typescript-eslint/no-unsafe-argument -- footer prop inspection walks raw React element tree */
/* oxlint-disable eslint/max-lines -- loading and error state coverage grows the file past 300 lines */
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentDetails, VoiceTranscriptionControl } from './consent-details';

// ---- mocks ----

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));

vi.mock('@/components/consent/section', () => ({
  Section: 'Section',
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://kilo.ai',
  PRIVACY_URL: 'https://kilo.ai/privacy-app',
}));

const useCurrentUserIdMock = vi.hoisted(() => ({
  useCurrentUserId: vi.fn(() => ({
    userId: 'u1' as string | undefined,
    email: 'a@b.c',
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  })),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: useCurrentUserIdMock.useCurrentUserId,
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

const voiceInputControllerMock = vi.hoisted(() => ({
  supportsOnDevice: vi.fn<() => boolean>(() => true),
}));

vi.mock('@/lib/voice-input/native-voice-input', () => ({
  voiceInputController: voiceInputControllerMock,
}));

const voiceNetworkConsentMock = vi.hoisted(() => ({
  readVoiceNetworkConsent: vi.fn<() => Promise<'granted' | 'declined' | 'unset'>>(),
  writeVoiceNetworkConsent: vi.fn(),
  subscribeToVoiceNetworkConsent: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/voice-input/voice-network-consent', () => voiceNetworkConsentMock);

// ---- helpers ----

type SectionProps = {
  title?: string;
  footer?: React.ReactElement;
};

function findAllSectionProps(root: TestRenderer.ReactTestInstance): SectionProps[] {
  return root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Section')
    .map(n => n.props as SectionProps);
}

/** Walk a React element tree and collect string children from "Text" nodes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectTextStrings(element: any): string[] {
  if (
    element == null ||
    typeof element === 'string' ||
    typeof element === 'number' ||
    typeof element === 'boolean'
  ) {
    return [];
  }

  // React element
  const children: string[] = [];
  if (element.type === 'Text' && typeof element.props?.children === 'string') {
    children.push(element.props.children);
  }

  // Walk props.children (which can be string, element, or array)
  const childProp = element.props?.children;
  if (childProp !== undefined && childProp !== null) {
    if (Array.isArray(childProp)) {
      for (const child of childProp) {
        children.push(...collectTextStrings(child));
      }
    } else {
      children.push(...collectTextStrings(childProp));
    }
  }

  return children;
}

function mount(mode?: 'onboarding' | 'review'): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(createElement(ConsentDetails, { mode }));
  });
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- act callback assignment, not statically guaranteed
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findTextStrings(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Text')
    .map(n => (n.props as { children?: unknown }).children)
    .filter((child): child is string => typeof child === 'string');
}

function findSwitches(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Switch');
}

async function flush() {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 10);
  });
}

// ---- tests ----

describe('ConsentDetails copy', () => {
  it('renders all sections', () => {
    const renderer = mount();
    const sections = findAllSectionProps(renderer.root);
    const titles = sections.map(s => s.title);
    expect(titles).toContain('AI model providers');
    expect(titles).toContain('Kilo Gateway (our backend)');
    expect(titles).toContain('Crash reporting');
    expect(titles).toContain('Product analytics');
    expect(titles).toContain('Error screenshots and session replay');
    expect(titles).toContain('Install attribution');
    expect(titles).toContain('Voice transcription');
  });

  it('onboarding heading states the default-on behavior', () => {
    const renderer = mount('onboarding');
    const texts = findTextStrings(renderer.root);
    expect(texts).toContain('Optional — on unless you turn it off');
  });

  it('review heading does not claim optional telemetry is on', () => {
    const renderer = mount('review');
    const texts = findTextStrings(renderer.root);
    expect(texts).toContain('Optional — you can change this any time in Settings');
    expect(texts).not.toContain('Optional — on unless you turn it off');
  });

  it('product analytics footer names the correct surface', () => {
    const renderer = mount();
    const sections = findAllSectionProps(renderer.root);
    const productAnalytics = sections.find(s => s.title === 'Product analytics');
    expect(productAnalytics).toBeDefined();
    if (!productAnalytics) {
      throw new Error('Product analytics section not found');
    }

    // footer is a React element passed as a prop — inspect it directly
    const footer = productAnalytics.footer;
    expect(footer).toBeDefined();

    const texts = collectTextStrings(footer);
    expect(texts.some((t: string) => t.includes('No prompt or conversation content'))).toBe(true);
    expect(texts.some((t: string) => t.includes('product analytics'))).toBe(true);
  });

  it('crash reporting section does not name the analytics surface', () => {
    const renderer = mount();
    const sections = findAllSectionProps(renderer.root);
    const crashReporting = sections.find(s => s.title === 'Crash reporting');
    expect(crashReporting).toBeDefined();

    const footer = crashReporting?.footer;
    expect(footer).toBeDefined();

    const texts = collectTextStrings(footer);
    // Must state that screen capture is gated on optional sharing.
    expect(
      texts.some((t: string) => t.includes('no screen capture unless optional sharing is on'))
    ).toBe(true);
    // Must NOT contain the analytics callout — it moved to Product analytics.
    expect(texts.some((t: string) => t.includes('No prompt or conversation content'))).toBe(false);
  });

  it('replay section discloses on-device masking', () => {
    const renderer = mount();
    const sections = findAllSectionProps(renderer.root);
    const replay = sections.find(s => s.title === 'Error screenshots and session replay');
    expect(replay).toBeDefined();

    const footer = replay?.footer;
    expect(footer).toBeDefined();

    const texts = collectTextStrings(footer);
    expect(texts.some((t: string) => t.includes('masked on your device'))).toBe(true);
  });
});

describe('Voice transcription section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(true);
    voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
    useCurrentUserIdMock.useCurrentUserId.mockReturnValue({
      userId: 'u1',
      email: 'a@b.c',
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  function mountVoiceControl(): TestRenderer.ReactTestRenderer {
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(VoiceTranscriptionControl));
    });
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- act callback assignment, not statically guaranteed
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer;
  }

  it('shows On device with no switch when on-device is supported', () => {
    const renderer = mountVoiceControl();
    expect(findTextStrings(renderer.root)).toContain('On device');
    expect(findSwitches(renderer.root).length).toBe(0);
  });

  it('shows Online, allowed with the switch on when consent is granted', async () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('granted');
    const renderer = mountVoiceControl();
    await TestRenderer.act(flush);

    expect(findTextStrings(renderer.root)).toContain('Online, allowed');
    const switches = findSwitches(renderer.root);
    expect(switches.length).toBe(1);
    const sw = switches[0];
    if (!sw) {
      throw new Error('expected a Switch');
    }
    expect((sw.props as { value?: boolean }).value).toBe(true);
  });

  it('shows Online, not allowed with the switch off when consent is unset', async () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
    const renderer = mountVoiceControl();
    await TestRenderer.act(flush);

    expect(findTextStrings(renderer.root)).toContain('Online, not allowed');
    const switches = findSwitches(renderer.root);
    expect(switches.length).toBe(1);
    const sw = switches[0];
    if (!sw) {
      throw new Error('expected a Switch');
    }
    expect((sw.props as { value?: boolean }).value).toBe(false);
  });

  it('rolls back the switch and toasts when the write fails', async () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
    voiceNetworkConsentMock.writeVoiceNetworkConsent.mockRejectedValue(new Error('boom'));
    const renderer = mountVoiceControl();
    await TestRenderer.act(flush);

    const switches = findSwitches(renderer.root);
    expect(switches.length).toBe(1);
    const sw = switches[0];
    if (!sw) {
      throw new Error('expected a Switch');
    }
    expect((sw.props as { value?: boolean }).value).toBe(false);

    await TestRenderer.act(async () => {
      (sw.props.onValueChange as (v: boolean) => void)(true);
      await flush();
    });

    // Rolled back to the prior value, no stuck optimistic state.
    const switchesAfter = findSwitches(renderer.root);
    expect(switchesAfter.length).toBe(1);
    const swAfter = switchesAfter[0];
    if (!swAfter) {
      throw new Error('expected a Switch after rollback');
    }
    expect((swAfter.props as { value?: boolean }).value).toBe(false);
    expect(findTextStrings(renderer.root)).toContain('Online, not allowed');
    expect(toast.error).toHaveBeenCalledWith('Could not save your choice. Please try again.');
    expect(voiceNetworkConsentMock.writeVoiceNetworkConsent).toHaveBeenCalledWith('u1', 'granted');
  });

  it('shows a sign-in message and no switch when there is no user', async () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    useCurrentUserIdMock.useCurrentUserId.mockReturnValue({
      userId: undefined,
      email: 'a@b.c',
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const renderer = mountVoiceControl();
    await TestRenderer.act(flush);

    expect(findTextStrings(renderer.root)).toContain('Sign in to manage online transcription.');
    expect(findSwitches(renderer.root).length).toBe(0);
  });

  it('shows a loading placeholder and no switch while the user loads', () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    useCurrentUserIdMock.useCurrentUserId.mockReturnValue({
      userId: undefined,
      email: 'a@b.c',
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    const renderer = mountVoiceControl();

    const texts = findTextStrings(renderer.root);
    expect(texts).toContain('Loading…');
    expect(texts).not.toContain('Sign in to manage online transcription.');
    expect(findSwitches(renderer.root).length).toBe(0);
  });

  it('shows a retry CTA that refetches when loading the user fails', () => {
    voiceInputControllerMock.supportsOnDevice.mockReturnValue(false);
    const refetch = vi.fn();
    useCurrentUserIdMock.useCurrentUserId.mockReturnValue({
      userId: undefined,
      email: 'a@b.c',
      isLoading: false,
      isError: true,
      refetch,
    });
    const renderer = mountVoiceControl();

    const texts = findTextStrings(renderer.root);
    expect(texts).toContain('Could not load your transcription setting.');
    expect(texts).not.toContain('Sign in to manage online transcription.');
    expect(findSwitches(renderer.root).length).toBe(0);

    const buttons = renderer.root.findAll(
      n => typeof n.type === 'string' && (n.type as string) === 'Button'
    );
    expect(buttons.length).toBe(1);
    const button = buttons[0];
    if (!button) {
      throw new Error('expected a Retry Button');
    }
    TestRenderer.act(() => {
      (button.props.onPress as () => void)();
    });
    expect(refetch).toHaveBeenCalled();
  });
});
