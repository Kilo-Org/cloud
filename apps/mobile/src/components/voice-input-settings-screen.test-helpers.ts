/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer types for the mounted-test finders (same pattern as the sibling mounted tests) */
import { type ReactTestRenderer } from 'react-test-renderer';

/**
 * Finders shared by the voice input settings mounted tests. They live here so
 * the test file stays under the repository's file-length limit.
 */
export function findConfigureRow(renderer: ReactTestRenderer, title: string) {
  const rows = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
  );
  const row = rows.find(item => item.props.title === title);
  if (!row) {
    throw new Error(`ConfigureRow for ${title} not found`);
  }
  return row;
}

export function findGatewaySwitch(renderer: ReactTestRenderer) {
  const found = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Switch'
  );
  const foundSwitch = found.find(sw => sw.props.accessibilityLabel === 'Gateway transcription');
  if (!foundSwitch) {
    throw new Error('Gateway transcription switch not found');
  }
  return foundSwitch;
}

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

export function findQueryErrors(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'QueryError'
  );
}
