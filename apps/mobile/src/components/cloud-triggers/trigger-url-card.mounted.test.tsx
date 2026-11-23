/**
 * The trigger detail's URL field: the address, and a copy control a finger can
 * reach.
 *
 * The control is the field itself, not the glyph beside the address. React
 * Native confines a touch to every ancestor view's bounds, so a control sized
 * to the address line can never reach the platform target: the field carries
 * `TOUCH_TARGET_CLASS` on its own node and declares no `hitSlop`, so nothing
 * promises reach the layout cannot deliver. It is also in flow with no
 * negative margin, which is what kept the label beside its value and the field
 * on the section's own gap.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOUCH_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerUrlCard } from './trigger-url-card';

const URL = 'https://inbound.example/trigger-a';

const copyWebhookUrl = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  // The card imports the shared tap-target module, which reads the platform.
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
}));
vi.mock('@/lib/cloud-triggers/copy-webhook-url', () => ({ copyWebhookUrl }));
vi.mock('@/components/ui/icons', () => ({ Copy: 'Copy' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field-label', () => ({ FormFieldLabel: 'FormFieldLabel' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000000' }),
}));

const PRESSABLE = 'Pressable' as ElementType;
const TEXT = 'Text' as ElementType;
const FORM_FIELD_LABEL = 'FormFieldLabel' as ElementType;
const COPY = 'Copy' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(): Promise<ReactTestInstance> {
  const view = await renderWithProviders(createElement(TriggerUrlCard, { url: URL }));
  renderer = view.renderer;
  return view.renderer.root;
}

function copyControl(root: ReactTestInstance): ReactTestInstance {
  const pressables = root.findAll(node => Object.is(node.type, PRESSABLE));
  expect(pressables).toHaveLength(1);
  const [control] = pressables;
  if (!control) {
    throw new Error('missing copy control');
  }
  return control;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  copyWebhookUrl.mockClear();
});

describe('TriggerUrlCard copy control', () => {
  it('makes the whole field the copy control, at the shared target floor', async () => {
    const control = copyControl(await mount());

    expect(control.props.accessibilityRole).toBe('button');
    // The action and the address it copies, so a reader hears both.
    expect(control.props.accessibilityLabel).toContain(i18n.t('common.copyLink'));
    expect(control.props.accessibilityLabel).toContain(URL);
    // The target is the field's own box: a declared reach would be clipped at
    // the address line, which is the shorter ancestor.
    expect(control.props.hitSlop).toBeUndefined();
    const classes = String(control.props.className).split(' ');
    expect(classes).toEqual(expect.arrayContaining(TOUCH_TARGET_CLASS.split(' ')));
    // In flow: a negative margin is what pulled the label away from its value.
    expect(classes.filter(name => name.startsWith('-m'))).toEqual([]);
  });

  it('keeps the label and the address inside the control', async () => {
    const control = copyControl(await mount());

    expect(
      control.findAll(node => Object.is(node.type, FORM_FIELD_LABEL)).map(node => node.props.label)
    ).toEqual([i18n.t('cloudAgent.triggers.webhookUrl')]);
    expect(
      control.findAll(node => Object.is(node.type, TEXT)).map(node => node.props.children)
    ).toContain(URL);
  });

  it('paints the copy glyph as decoration inside the control', async () => {
    const control = copyControl(await mount());

    expect(control.findAll(node => Object.is(node.type, COPY))).toHaveLength(1);
  });

  it('copies the URL when the field is pressed', async () => {
    const control = copyControl(await mount());

    act(() => {
      (control.props.onPress as () => void)();
    });

    expect(copyWebhookUrl).toHaveBeenCalledWith(URL);
  });
});
