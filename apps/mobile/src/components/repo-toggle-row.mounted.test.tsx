// RepoToggleRow regression coverage for the shared repository checkbox row:
// a long name truncates with a middle ellipsis inside its own box (so the
// distinguishing suffix shows and the label never reaches the trailing
// checkmark), a private repo renders the lock icon before the name, and the
// privacy of a private row reaches the accessible name instead of the glyph.
import { act, type ElementType, type ReactElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { RepoToggleRow } from './repo-toggle-row';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Lock: 'Lock' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
// The catalog copy itself is checked by tools/i18n; here the mock only has to
// show which key the row names itself with and that it interpolates the name.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name === undefined ? key : `${values.name} | ${key}`,
  }),
}));

const LONG_NAME =
  'xmvd1ps9t28-aarav-consultant/xmvd1ps9t28-open-source-kubernetes-dashboard-engine-sandbox-003';

const TEXT = 'Text' as ElementType;
const LOCK = 'Lock' as ElementType;
const CHOICE_ROW = 'ChoiceRow' as ElementType;

const noop = (): void => undefined;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing RepoToggleRow renderer');
  }
  return renderer.root;
}

describe('<RepoToggleRow>', () => {
  it('truncates a long name with a middle ellipsis inside its own box', () => {
    const root = renderRow(
      <RepoToggleRow repo={{ id: 1, fullName: LONG_NAME }} selected={false} onPress={noop} />
    );
    const label = root.findByType(TEXT);
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.ellipsizeMode).toBe('middle');
    expect(label.props.children).toBe(LONG_NAME);
    // The name sits in a min-w-0 flex-1 box, so it truncates within the space
    // left of the checkmark instead of overflowing into it.
    const box = root.findAll(node => Object.is(node.type, 'View'))[1];
    expect(box).toBeDefined();
    expect(String(box?.props.className)).toContain('min-w-0');
    expect(String(box?.props.className)).toContain('flex-1');
  });

  it('renders the lock icon for a private repo inside a decorative wrapper', () => {
    const root = renderRow(
      <RepoToggleRow repo={{ id: 1, fullName: LONG_NAME, private: true }} selected onPress={noop} />
    );
    expect(root.findAllByType(LOCK)).toHaveLength(1);
    // The glyph itself carries no text, so the row exposes it to no screen
    // reader: the privacy is in the name below, and nothing else.
    expect(root.findByType(LOCK).parent?.props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
  });

  it('names a private row with its privacy qualifier and keeps its selection state', () => {
    const root = renderRow(
      <RepoToggleRow
        repo={{ id: 1, fullName: 'acme/api', private: true }}
        selected
        onPress={noop}
      />
    );
    expect(root.findByType(CHOICE_ROW).props).toMatchObject({
      accessibleName: 'acme/api | common.privateRepositoryA11y',
      selected: true,
      multi: true,
    });
  });

  it('leaves a public row on its plain name', () => {
    const root = renderRow(
      <RepoToggleRow repo={{ id: 1, fullName: 'owner/repo' }} selected onPress={noop} />
    );
    expect(root.findAllByType(LOCK)).toHaveLength(0);
    expect(root.findByType(CHOICE_ROW).props.accessibleName).toBeUndefined();
  });
});
