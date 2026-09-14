/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer types for the mounted-test finders (same pattern as the sibling mounted tests) */
import { createElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { vi } from 'vitest';

import { VoiceInputSettingsScreen } from '@/components/voice-input-settings-screen';
import { renderWithProviders } from '@/test/render-with-providers';

let mountedView: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

/**
 * Mounts the voice input settings screen with its providers and lets pending
 * dynamic imports settle. The rendered tree is tracked so the caller can unmount
 * it from `afterEach`.
 */
export async function mountVoiceInputSettingsScreen(): Promise<ReactTestRenderer> {
  const view = await renderWithProviders(createElement(VoiceInputSettingsScreen));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  mountedView = view;
  return view.renderer;
}

export function unmountVoiceInputSettingsScreen(): void {
  mountedView?.unmount();
  mountedView = undefined;
}

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
