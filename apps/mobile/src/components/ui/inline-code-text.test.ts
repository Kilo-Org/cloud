import { describe, expect, it, vi } from 'vitest';

import { InlineCodeText } from '@/components/ui/inline-code-text';
import { i18n } from '@/i18n';

// The component is called as a plain function, matching the repo's
// component-test convention, so the elements it returns are inspected without
// a renderer. The app `Text` wrapper is a distinct host name from the raw
// React Native span, which keeps the two findable apart.
vi.mock('react-native', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/text', () => ({ Text: 'AppText' }));

type Element = { type?: unknown; props?: Record<string, unknown> } | null | undefined | string;
type Node = Element | number | boolean;

/** Every node of `typeName` in the static element tree, in render order. */
function elementsOfType(node: Node, typeName: string): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const props = node.props ?? {};
  const here = node.type === typeName ? [props] : [];
  const children = props.children;
  const childrenList = Array.isArray(children) ? children : [children];
  return [...here, ...childrenList.flatMap(child => elementsOfType(child as Node, typeName))];
}

/** Every string the element tree renders, in render order. */
function textRuns(node: Node): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const children = node.props?.children;
  const childrenList = Array.isArray(children) ? children : [children];
  return childrenList.flatMap(child => textRuns(child as Node));
}

function render(value: string, props: { className?: string; variant?: 'muted' } = {}) {
  // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
  return InlineCodeText({ value, ...props }) as {
    type?: unknown;
    props?: Record<string, unknown>;
  };
}

describe('InlineCodeText', () => {
  it('renders each command of the composer hint as an inline-code span', () => {
    const spans = elementsOfType(render(i18n.t('agentChat.newSession.remoteHint')), 'Text');

    expect(spans.map(span => span.children)).toEqual(['kilo remote', '/remote']);
    for (const span of spans) {
      expect(span.className).toContain('font-mono-medium');
      expect(span.className).toContain('bg-muted');
    }
  });

  it('never renders a literal backtick for any catalog copy that carries one', () => {
    // Every catalog string that marks a command with backticks, not only the
    // composer's: the component strips the markers wherever it is used.
    for (const key of [
      'agentChat.newSession.remoteHint',
      'agentChat.instancePicker.noCliInstancesDescription',
      'tour.remoteOptionBody',
      'tour.remoteEmptyBody',
    ]) {
      const value = i18n.t(key);
      // Guard the guard: if the catalog copy lost its markers this check would
      // pass for the wrong reason.
      expect(value).toContain('`');

      expect(textRuns(render(value)).join('')).toBe(value.replaceAll('`', ''));
    }
  });

  it('passes copy without markers through as plain text', () => {
    const element = render('Just a sentence.');

    expect(elementsOfType(element, 'Text')).toEqual([]);
    expect(textRuns(element)).toEqual(['Just a sentence.']);
  });

  it('keeps an unpaired marker visible rather than dropping the copy after it', () => {
    const element = render('run `kilo remote now');

    expect(elementsOfType(element, 'Text')).toEqual([]);
    expect(textRuns(element).join('')).toBe('run `kilo remote now');
  });

  it('forwards the caller styling to the wrapping Text', () => {
    const element = render('Run `kilo remote`.', { className: 'mt-2 text-xs', variant: 'muted' });

    expect(element.type).toBe('AppText');
    expect(element.props).toMatchObject({ className: 'mt-2 text-xs', variant: 'muted' });
  });
});
