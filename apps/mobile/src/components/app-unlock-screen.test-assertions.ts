import { type ElementType } from 'react';
import { expect } from 'vitest';
import { type unlockRoot } from './app-unlock-screen.test-helpers';

type Root = ReturnType<typeof unlockRoot>;

export function text(root: Root) {
  const texts = root.findAllByType('Text' as ElementType);
  return texts.map(node => node.props.children).join('\n');
}

export function expectHidden(root: Root, hidden: boolean) {
  const scenes = root.findAllByType('Scene' as ElementType);
  expect(scenes.length).toBeGreaterThan(0);
  for (const scene of scenes) {
    const wrapper = scene.find(
      node => (node.type as string) === 'View' && node.props.pointerEvents !== undefined
    );
    expect(wrapper.props).toMatchObject({
      pointerEvents: hidden ? 'none' : 'auto',
      accessibilityElementsHidden: hidden,
      importantForAccessibility: hidden ? 'no-hide-descendants' : 'auto',
    });
    expect((wrapper.props.className as string).includes('opacity-0')).toBe(hidden);
    expect(wrapper.findAllByType('Draft' as ElementType)).toHaveLength(1);
  }
}
