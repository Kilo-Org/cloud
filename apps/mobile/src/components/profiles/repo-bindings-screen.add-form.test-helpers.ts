/**
 * Readers for the Add form's pickers that two sibling suites assert with: the
 * Add-form suite (field state and the disabled Add button) and the picker suite
 * (the profile sheet's empty state). The harness that mounts the screen lives
 * in `repo-bindings-screen.test-helpers`.
 */

import { type ReactTestInstance } from '@/test/renderer';

import { findAll } from '@/components/profiles/repo-bindings-screen.test-helpers';

/** The accessible names of every pressable the screen currently renders. */
export function pressableLabels(root: ReactTestInstance): string[] {
  return findAll(root, 'Pressable')
    .map(node => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

/** The props `EmptyState` receives; it is a host node here, so its action stays a prop. */
type EmptyStateNode = {
  props: {
    description?: string;
    // The state fills its action slot with a `StateAction`, which the suites
    // stub as a host node carrying its label and handler as props.
    action?: { props: { label: string; onPress: () => void } };
  };
};

/** The empty state with this title — the screen and the picker sheet each render one. */
export function emptyStateProps(root: ReactTestInstance, title: string): EmptyStateNode['props'] {
  const empty = findAll(root, 'EmptyState').find(node => node.props.title === title);
  if (!empty) {
    throw new Error(`empty state ${title} was not rendered`);
  }
  // The mocked surface is a host node, so its props are untyped at the boundary.
  return empty.props as EmptyStateNode['props'];
}
