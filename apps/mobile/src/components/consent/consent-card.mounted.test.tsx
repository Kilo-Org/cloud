/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/markdown-image.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentCard } from './consent-card';

const mockedAcceptConsent = vi.hoisted(() => vi.fn());
const mockedReadConsent = vi.hoisted(() => vi.fn());
const mockedSetOptionalConsent = vi.hoisted(() => vi.fn());
const mockedRevokeConsent = vi.hoisted(() => vi.fn());
const mockedSignOut = vi.hoisted(() => vi.fn());

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
    userId: 'test-user-1',
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
vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  LineChart: 'LineChart',
  MessageSquare: 'MessageSquare',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
  User: 'User',
}));
vi.mock('@/components/consent/consent-row', () => ({ ConsentRow: 'ConsentRow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
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

async function flush() {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 10);
  });
}

describe('ConsentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('defaults the optional switch to off', () => {
    const renderer = mountCard('onboarding');
    expect(singleSwitch(renderer.root).props.value).toBe(false);
  });

  it('calls acceptConsent with optional value on primary action', async () => {
    const renderer = mountCard('onboarding');
    const sw = singleSwitch(renderer.root);
    await act(async () => {
      await Promise.resolve();
      (sw.props.onValueChange as (v: boolean) => void)(true);
    });
    const btn = findButton(renderer.root, 'Accept and continue');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });
    expect(mockedAcceptConsent).toHaveBeenCalledWith('test-user-1', true);
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
});
