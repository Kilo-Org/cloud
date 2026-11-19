import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import arCatalog from '@/i18n/locales/ar.json';
import { type LegalDocumentState } from '@/lib/hooks/use-legal-document';
import { LegalDocumentScreen } from './legal-document-screen';

const CONTENT_HTML = '<h1>Terms of Service</h1><p>English body.</p>';
const mockedRetry = vi.hoisted(() => vi.fn());
const mockedPush = vi.hoisted(() => vi.fn());

const legalDocumentState = vi.hoisted(() => {
  const holder: { value: LegalDocumentState } = {
    value: { kind: 'content', html: '<h1>Terms of Service</h1><p>English body.</p>' },
  };
  return holder;
});

vi.mock('@/lib/hooks/use-legal-document', () => ({
  useLegalDocument: () => ({ state: legalDocumentState.value, retry: mockedRetry }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mockedPush, replace: vi.fn(), back: vi.fn() }),
}));
// The body marker replaces the real markdown renderer, so the tree carries one
// findable node for the document body without pulling in its dependency graph.
vi.mock('@/components/agents/markdown-text', () => ({
  MarkdownText: 'MarkdownText',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/screen-insets', () => ({
  useSideInsetStyle: () => ({}),
  useScreenInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  View: 'View',
}));

type I = TestRenderer.ReactTestInstance;

const mountedRenderer: { current: TestRenderer.ReactTestRenderer | undefined } = {
  current: undefined,
};

function mountScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(LegalDocumentScreen, { document: 'terms', group: '(app)' })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderer.current = renderer;
  return renderer;
}

/** Child elements of the loaded state's ScrollView, in render order. */
function scrollViewChildren(renderer: TestRenderer.ReactTestRenderer): I[] {
  const scrollViews = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ScrollView'
  );
  const scrollView = scrollViews.at(0);
  if (scrollViews.length !== 1 || !scrollView) {
    throw new Error(`expected 1 ScrollView, got ${scrollViews.length}`);
  }
  return scrollView.children.filter((child): child is I => typeof child !== 'string');
}

const isNotice = (node: I) =>
  typeof node.type === 'string' &&
  (node.type as string) === 'Text' &&
  node.props.children === i18n.t('common.legalDocumentEnglishOnly');

const isBody = (node: I) =>
  typeof node.type === 'string' &&
  (node.type as string) === 'MarkdownText' &&
  node.props.value === CONTENT_HTML;

/** The node itself and every component instance under it, host nodes included:
 * the mocked Text/View/ScrollView markers are instances whose `type` is a string. */
function deepDescendants(node: I): I[] {
  return [
    node,
    ...node.children.flatMap(child => (typeof child === 'string' ? [] : deepDescendants(child))),
  ];
}

const countMatches = (root: I, match: (n: I) => boolean) =>
  root.findAll(node => match(node)).length;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
  // The loading test mutates the shared holder; no test may inherit that state.
  legalDocumentState.value = { kind: 'content', html: CONTENT_HTML };
});

afterEach(async () => {
  mountedRenderer.current?.unmount();
  // Other suites keep their catalog language; restore the default.
  await i18n.changeLanguage('en');
});

describe('LegalDocumentScreen English-only notice', () => {
  it('shows the Arabic notice above the document body', async () => {
    await i18n.changeLanguage('ar');

    const renderer = mountScreen();
    const children = scrollViewChildren(renderer);

    // The notice leads the scroll content so the reader meets the heads-up
    // before the English legal text itself.
    const noticeIndex = children.findIndex(node => deepDescendants(node).some(n => isNotice(n)));
    const bodyIndex = children.findIndex(node => deepDescendants(node).some(n => isBody(n)));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(bodyIndex).toBeGreaterThan(noticeIndex);

    // The wording comes from the real Arabic catalog, not a hard-coded string,
    // and exactly one notice renders inside the scroll content.
    const noticeNodes = children.flatMap(child => deepDescendants(child)).filter(n => isNotice(n));
    expect(noticeNodes).toHaveLength(1);
    const notice = noticeNodes.at(0);
    expect(notice?.props.children).toBe(arCatalog.common.legalDocumentEnglishOnly);

    // The English legal prose keeps its own base direction while the
    // interface mirrors.
    const body = children.flatMap(child => deepDescendants(child)).find(n => isBody(n));
    expect(body?.props.documentDirection).toBe('ltr');
  });

  it('shows no notice when the app language is English', async () => {
    await i18n.changeLanguage('en');
    const renderer = mountScreen();

    expect(countMatches(renderer.root, isNotice)).toBe(0);
    expect(countMatches(renderer.root, isBody)).toBe(1);
  });

  it('shows no notice while the document is loading', async () => {
    await i18n.changeLanguage('ar');
    legalDocumentState.value = { kind: 'loading' };

    const renderer = mountScreen();

    expect(countMatches(renderer.root, isNotice)).toBe(0);
    expect(countMatches(renderer.root, isBody)).toBe(0);
  });
});
