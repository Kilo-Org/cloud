import { expect } from 'vitest';

import { PREFERENCE_SETTINGS_SOURCES } from '@/lib/settings-search/preference-sources';
import { type ReactTestRenderer } from '@/test/renderer';

type SettingsTargetProps = { item: { id: string } };

/**
 * A screen's search targets must be exactly the rows its index source publishes,
 * in screen order: a row added without a target, or a target whose definition
 * differs from the published one, fails here.
 */
export function expectRenderedSettingsTargets(renderer: ReactTestRenderer, path: string): void {
  const source = PREFERENCE_SETTINGS_SOURCES.find(candidate => candidate.path === path);
  if (!source) {
    throw new Error(`settings source missing: ${path}`);
  }

  // The test renderer types host props as `unknown`; this names the mocked shape.
  const renderedIds: string[] = [];
  for (const target of renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'SettingsTarget'
  )) {
    const props = target.props as SettingsTargetProps;
    renderedIds.push(props.item.id);
  }

  expect(renderedIds).toEqual(source.settings.map(setting => setting.id));
}
