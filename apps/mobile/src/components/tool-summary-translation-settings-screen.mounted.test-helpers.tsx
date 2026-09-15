/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer the mounted tests inspect (same pattern as voice-input-settings-screen.mounted.test.tsx) */
import { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/** The switch row on the subpage, found by its title. */
export function findPreferenceRow(renderer: ReactTestRenderer): ReactTestInstance {
  const rows = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'PreferenceRow'
  );
  const row = rows.find(item => item.props.title === 'Translate tool summaries');
  if (!row) {
    throw new Error('PreferenceRow for Translate tool summaries not found');
  }
  return row;
}

/** The model row on the subpage, found by its title. */
export function findConfigureRow(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const rows = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
  );
  const row = rows.find(item => item.props.title === title);
  if (!row) {
    throw new Error(`ConfigureRow for ${title} not found`);
  }
  return row;
}

/** The inline state blocks (error, empty) below the rows. */
export function findQueryErrors(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'QueryError'
  );
}

/** Every rendered Text node's string child, for the muted-notice assertions. */
export function findTexts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    )
    .map(node => node.props.children as string);
}
