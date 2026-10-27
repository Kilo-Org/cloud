import { type Href } from 'expo-router';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { type SharePayload } from '@/lib/share-payload';

import { PrCommentFixWithKilo } from './pr-comment-fix-with-kilo';

// Single-push behaviour of the "Fix with Kilo" pill: the surface's own
// rendering assertions live in pr-comment-fix-with-kilo.test.tsx, which keeps
// this file focused on the double-press guard.

const state = vi.hoisted(() => ({
  push: vi.fn((_href: Href | string) => undefined),
  putSharePayload: vi.fn((_payload: SharePayload) => 'share-1'),
  focusEffects: [] as (() => void)[],
  now: 1_700_000_000_000,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push }),
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.push(effect);
  },
}));
vi.mock('@/lib/share-payload', () => ({ putSharePayload: state.putSharePayload }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ WandSparkles: 'WandSparkles' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

const GITHUB_REF: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello',
  number: 7,
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function nodesOfType(type: string): TestRenderer.ReactTestInstance[] {
  return renderer === undefined
    ? []
    : renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The pill's press handler, narrowed once for the calls below. */
function pressHandler(): () => void {
  const handler: unknown = nodesOfType('Pressable')[0]?.props.onPress;
  if (typeof handler !== 'function') {
    throw new TypeError('Expected the Fix with Kilo pill to carry a press handler');
  }
  return handler as () => void;
}

function press(): void {
  pressHandler()();
}

async function regainFocus(): Promise<void> {
  await act(async () => {
    for (const effect of state.focusEffects) {
      effect();
    }
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <ProviderPrScopeProvider value={{ ref: GITHUB_REF, organizationId: null }}>
        <PrCommentFixWithKilo owner="octocat" repo="hello" number={7} commentId={7} kind="review" />
      </ProviderPrScopeProvider>
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.push.mockReset();
  state.putSharePayload.mockReset().mockReturnValue('share-1');
  state.focusEffects = [];
  state.now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => state.now);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

describe('PrCommentFixWithKilo single push', () => {
  it('opens the composer once when the pill is double tapped', async () => {
    await mount();

    press();
    press();

    expect(state.putSharePayload).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledTimes(1);
  });

  it('opens the composer again on a press after the guard window', async () => {
    await mount();
    press();

    state.now += 1000;
    press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });

  it('opens the composer again after the screen regains focus', async () => {
    await mount();
    press();
    press();
    await regainFocus();

    press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });
});
