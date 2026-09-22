/* oxlint-disable eslint/max-lines -- loading and error state coverage grows the file past 300 lines */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_DISCLOSURE_MAX_FONT_SCALE, ConsentCard } from './consent-card';
import { i18n } from '@/i18n';

const mockedAcceptConsent = vi.hoisted(() => vi.fn());
const mockedReadConsent = vi.hoisted(() => vi.fn());
const mockedSetOptionalConsent = vi.hoisted(() => vi.fn());
const mockedRevokeConsent = vi.hoisted(() => vi.fn());
const mockedSignOut = vi.hoisted(() => vi.fn());
const currentUserId = vi.hoisted(() => ({ value: 'test-user-1' as string | undefined }));

vi.mock('@/lib/consent', () => ({
  acceptConsent: mockedAcceptConsent,
  readConsent: mockedReadConsent,
  setOptionalConsent: mockedSetOptionalConsent,
  revokeConsent: mockedRevokeConsent,
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signOut: mockedSignOut, token: 'fake-token' }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: currentUserId.value,
    email: 'a@b.com',
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
const mockedReplace = vi.hoisted(() => vi.fn());
const mockedPush = vi.hoisted(() => vi.fn());
const mockedBack = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockedReplace, push: mockedPush, back: mockedBack }),
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({
  ChevronRight: 'ChevronRight',
  LineChart: 'LineChart',
  MessageSquare: 'MessageSquare',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
  User: 'User',
}));
vi.mock('@/components/consent/consent-row', () => ({ ConsentRow: 'ConsentRow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://kilo.ai' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#fff',
    foreground: '#000',
    primary: '#4F5A10',
    secondary: '#F0EEE6',
    mutedForeground: '#6F6A61',
    card: '#FFFFFF',
    border: 'rgba(20, 15, 10, 0.09)',
  }),
}));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function mountCard(mode: 'onboarding' | 'review' = 'onboarding'): R {
  const ref: { current: R | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(createElement(ConsentCard, { mode }));
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function singleSwitch(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Switch');
  if (nodes.length !== 1) {
    throw new Error(`expected 1 Switch, got ${nodes.length}`);
  }
  const n = nodes[0];
  if (!n) {
    throw new Error('switch not found');
  }
  return n;
}

function countByType(root: I, type: string): number {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type).length;
}

function findButton(root: I, label: string): I {
  const buttons = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
  const btn = buttons.find(b => (b.props.accessibilityLabel as string) === label);
  if (!btn) {
    throw new Error(`button "${label}" not found`);
  }
  return btn;
}

function texts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

function disclosureTexts(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Text' &&
      n.props.children === 'Kilo privacy policy'
  );
}

function requireDisclosure(root: I): I {
  const nodes = disclosureTexts(root);
  if (nodes.length !== 1) {
    throw new Error(`expected 1 privacy disclosure, got ${nodes.length}`);
  }
  const n = nodes[0];
  if (!n) {
    throw new Error('privacy disclosure not found');
  }
  return n;
}

function requireParent(node: I): I {
  const parent = node.parent;
  if (!parent) {
    throw new Error('node has no parent');
  }
  return parent;
}

function hasAncestorOfType(node: I, type: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === type) {
      return true;
    }
  }
  return false;
}

async function flush() {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 10);
  });
}

describe('ConsentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserId.value = 'test-user-1';
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: false });
    mockedAcceptConsent.mockResolvedValue(undefined);
    mockedSetOptionalConsent.mockResolvedValue(undefined);
    mockedRevokeConsent.mockResolvedValue(undefined);
    mockedSignOut.mockResolvedValue(undefined);
  });

  it('renders required rows grouped under "Required to use Kilo"', () => {
    const renderer = mountCard('onboarding');
    const t = texts(renderer.root);
    expect(t).toContain('Required to use Kilo');
    expect(t).toContain('Optional');
    expect(t).toContain('Help improve Kilo');
    expect(t).toContain('Accept and continue');
    expect(t).toContain('Decline');
  });

  it('defaults the optional switch to on', () => {
    const renderer = mountCard('onboarding');
    expect(singleSwitch(renderer.root).props.value).toBe(true);
  });

  it('keeps the privacy line clear of the pinned actions', () => {
    // Finding 2 (the sentence cut in half at the footer boundary) is fixed at
    // the base revision by pinning the disclosure into the footer above the
    // actions, so the footer edge can no longer cut it and the actions cannot
    // overlay it. The earlier assertion that the sentence was the tail of the
    // scrolling body no longer holds: the sentence has left the scroller.
    const renderer = mountCard('onboarding');
    const scroller = renderer.root.findByType('ScrollView' as never);

    const privacyPrefix = i18n.t('consent.privacyPolicyPrefix');
    const privacyLine = renderer.root.findAll(node => {
      const text = node.children
        .filter((child): child is string => typeof child === 'string')
        .join('');
      return (node.type as string) === 'Text' && text.length > 0 && text.includes(privacyPrefix);
    });
    expect(privacyLine).toHaveLength(1);
    const line = privacyLine[0];
    if (!line) {
      throw new Error('privacy line not found');
    }
    expect(hasAncestorOfType(line, 'ScrollView')).toBe(false);

    // The pinned actions are outside the scroller, so they never cover it.
    const primary = findButton(renderer.root, 'Accept and continue');
    expect(scroller.findAll(node => node === primary)).toHaveLength(0);
  });

  it('accepts with optional on when the switch is untouched', async () => {
    const renderer = mountCard('onboarding');
    const btn = findButton(renderer.root, 'Accept and continue');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });
    expect(mockedAcceptConsent).toHaveBeenCalledWith('test-user-1', true);
  });

  it('calls acceptConsent with optional value on primary action', async () => {
    const renderer = mountCard('onboarding');
    const sw = singleSwitch(renderer.root);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(false);
    });
    const btn = findButton(renderer.root, 'Accept and continue');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });
    expect(mockedAcceptConsent).toHaveBeenCalledWith('test-user-1', false);
  });

  it('shows error when acceptConsent fails and does not navigate', async () => {
    mockedAcceptConsent.mockRejectedValue(new Error('write failed'));
    const renderer = mountCard('onboarding');
    const btn = findButton(renderer.root, 'Accept and continue');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });
    await act(flush);
    expect(texts(renderer.root)).toContain('Could not save your consent. Please try again.');
    expect(mockedReplace).not.toHaveBeenCalled();
  });

  it('renders the consent card in onboarding mode without crashing', () => {
    const renderer = mountCard('onboarding');
    expect(renderer).toBeTruthy();
  });

  it('loads stored optional value in review mode', async () => {
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: true });
    const renderer = mountCard('review');
    await act(flush);
    expect(mockedReadConsent).toHaveBeenCalledWith('test-user-1');
    expect(singleSwitch(renderer.root).props.value).toBe(true);
  });

  it('shows a same-size placeholder, not a default-off switch, while the stored value loads', async () => {
    let resolveLoad: ((v: { mandatory: boolean; optional: boolean }) => void) | undefined =
      undefined;
    mockedReadConsent.mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      })
    );
    const renderer = mountCard('review');
    await act(async () => {
      await Promise.resolve();
    });
    // The pre-load state must not claim "off": an e3 revoke check mistook the
    // pre-load off for a completed revoke (b911 vr5, e3-toggled-off.png).
    expect(countByType(renderer.root, 'Switch')).toBe(0);
    expect(countByType(renderer.root, 'Skeleton')).toBe(1);

    await act(() => {
      resolveLoad?.({ mandatory: true, optional: true });
    });
    await act(flush);
    expect(countByType(renderer.root, 'Skeleton')).toBe(0);
    expect(singleSwitch(renderer.root).props.value).toBe(true);
  });

  it('shows the switch with an error when the stored value fails to load', async () => {
    mockedReadConsent.mockRejectedValue(new Error('keychain read failed'));
    const renderer = mountCard('review');
    await act(flush);
    expect(texts(renderer.root)).toContain(
      'Could not load your consent settings. Please try again.'
    );
    // The placeholder is gone: the error names the unreliability, so the
    // control is at least operable (a failed toggle reverts with its error).
    expect(singleSwitch(renderer.root)).toBeTruthy();
  });

  it('writes optional choice immediately without sign-out on toggle', async () => {
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: false });
    const renderer = mountCard('review');
    await act(flush);
    const sw = singleSwitch(renderer.root);
    expect(sw.props.value).toBe(false);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    await act(flush);
    expect(mockedSetOptionalConsent).toHaveBeenCalledWith('test-user-1', true);
    expect(mockedSignOut).not.toHaveBeenCalled();
  });

  it('reverts switch and shows error when setOptionalConsent fails', async () => {
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: false });
    mockedSetOptionalConsent.mockRejectedValue(new Error('write failed'));
    const renderer = mountCard('review');
    await act(flush);
    const sw = singleSwitch(renderer.root);
    expect(sw.props.value).toBe(false);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    await act(flush);
    expect(mockedSetOptionalConsent).toHaveBeenCalledWith('test-user-1', true);
    expect(texts(renderer.root)).toContain('Could not save your choice. Please try again.');
    expect(singleSwitch(renderer.root).props.value).toBe(false);
  });

  it('does not call readConsent in onboarding mode', async () => {
    mountCard('onboarding');
    await act(flush);
    expect(mockedReadConsent).not.toHaveBeenCalled();
  });

  it('clears error when optional toggle succeeds after a prior failure', async () => {
    // First attempt: fail.
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: false });
    mockedSetOptionalConsent.mockRejectedValueOnce(new Error('write failed'));
    const renderer = mountCard('review');
    await act(flush);
    const sw = singleSwitch(renderer.root);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    await act(flush);
    expect(texts(renderer.root)).toContain('Could not save your choice. Please try again.');

    // Second attempt: succeed.
    mockedSetOptionalConsent.mockResolvedValueOnce(undefined);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    await act(flush);
    expect(mockedSetOptionalConsent).toHaveBeenCalledTimes(2);
    expect(texts(renderer.root)).not.toContain('Could not save your choice. Please try again.');
  });

  it('allows stored load after review toggle reverts without userId', async () => {
    currentUserId.value = undefined;
    mockedReadConsent.mockResolvedValue({ mandatory: true, optional: true });
    const renderer = mountCard('review');

    // Toggle should revert — no userId available.
    const sw = singleSwitch(renderer.root);
    expect(sw.props.value).toBe(false);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    await act(flush);
    // Switch reverted.
    expect(singleSwitch(renderer.root).props.value).toBe(false);
    expect(texts(renderer.root)).toContain('Could not load your account. Please try again.');

    // Later: userId arrives — stored value must load.
    currentUserId.value = 'test-user-1';
    await act(() => {
      renderer.update(createElement(ConsentCard, { mode: 'review' }));
    });
    await act(flush);
    expect(mockedReadConsent).toHaveBeenCalledWith('test-user-1');
    expect(singleSwitch(renderer.root).props.value).toBe(true);
  });

  it('renders Account row with literal ampersand, not HTML entity', () => {
    const renderer = mountCard('onboarding');
    const rows = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'ConsentRow' &&
        (n.props.title as string).includes('usage data')
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.props.title).toBe('Account & usage data');
    expect(row?.props.title).not.toContain('&amp;');
  });

  it('renders the privacy disclosure in the pinned footer, outside the scrolling body', () => {
    for (const mode of ['onboarding', 'review'] as const) {
      const renderer = mountCard(mode);
      const root = renderer.root;
      // One scroll region and one disclosure: the disclosure lives in the
      // pinned footer, where the footer edge cannot cut it (the body tail
      // rendered across the fold on a full-height screen).
      expect(countByType(root, 'ScrollView')).toBe(1);
      const disclosure = requireDisclosure(root);
      expect(hasAncestorOfType(disclosure, 'ScrollView')).toBe(false);

      const primary = mode === 'onboarding' ? 'Accept and continue' : 'Back';
      const footer = requireParent(findButton(root, primary));
      expect(disclosureTexts(footer).length).toBe(1);
    }
  });

  it('keeps the privacy disclosure in the footer when an error occupies the footer slot', async () => {
    mockedReadConsent.mockRejectedValue(new Error('keychain read failed'));
    const renderer = mountCard('review');
    await act(flush);
    const root = renderer.root;
    expect(texts(root)).toContain('Could not load your consent settings. Please try again.');
    const footer = requireParent(findButton(root, 'Back'));
    expect(disclosureTexts(footer).length).toBe(1);
    expect(hasAncestorOfType(requireDisclosure(root), 'ScrollView')).toBe(false);
  });

  it('caps the pinned disclosure font scale so its footer height stays bounded', () => {
    for (const mode of ['onboarding', 'review'] as const) {
      const root = mountCard(mode).root;
      // The sentence has no line cap: uncapped it grows to several lines at
      // the largest system text size and the pinned footer's fixed height
      // pushes the actions off the sheet.
      const outer = root.findAll(
        n =>
          typeof n.type === 'string' &&
          (n.type as string) === 'Text' &&
          Array.isArray(n.props.children) &&
          n.props.children.includes('Your data is handled per the')
      );
      expect(outer.length).toBe(1);
      expect(outer[0]?.props.maxFontSizeMultiplier).toBe(CONSENT_DISCLOSURE_MAX_FONT_SCALE);
      // The nested link is its own native text node, so it needs the cap too.
      expect(requireDisclosure(root).props.maxFontSizeMultiplier).toBe(
        CONSENT_DISCLOSURE_MAX_FONT_SCALE
      );
    }
  });
});
