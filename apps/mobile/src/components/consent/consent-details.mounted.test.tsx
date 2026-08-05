/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-member-access @typescript-eslint/no-unsafe-argument -- footer prop inspection walks raw React element tree */
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ConsentDetails } from './consent-details';

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
}));

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
    expect(titles).toContain('Install attribution');
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
    // Must contain the session-replay callout (still in crash section).
    expect(texts.some((t: string) => t.includes('session replay'))).toBe(true);
    // Must NOT contain the analytics callout — it moved to Product analytics.
    expect(texts.some((t: string) => t.includes('No prompt or conversation content'))).toBe(false);
  });
});
