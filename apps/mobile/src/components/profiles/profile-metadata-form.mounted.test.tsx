import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileMetadataForm } from './profile-metadata-form';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: ReactNode }) => createElement('Button', props),
}));
vi.mock('@/components/ui/form-field', () => ({
  FormField: (props: Record<string, unknown>) => createElement('FormField', props),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});

const SAVED = { name: 'Backend debugging', description: 'Runs the integration suite' } as const;

/** The host stubs keep the form's own props untyped; these suites call one handler each. */
function handler(value: unknown): (...args: unknown[]) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as (...args: unknown[]) => void;
}

function field(root: TestRenderer.ReactTestRenderer['root'], label: string) {
  const instance = root
    .findAllByType('FormField' as never)
    .find(candidate => candidate.props.label === label);
  if (!instance) {
    throw new Error(`no FormField labelled ${label}`);
  }
  return instance;
}

function type(root: TestRenderer.ReactTestRenderer['root'], label: string, value: string) {
  act(() => {
    handler(field(root, label).props.onChangeText)(value);
  });
}

async function submit(root: TestRenderer.ReactTestRenderer['root']) {
  await act(async () => {
    handler(root.findByType('Button' as never).props.onPress)();
    await Promise.resolve();
  });
}

function mount(
  overrides: { onSave?: () => Promise<boolean>; onDirtyChange?: (d: boolean) => void } = {}
) {
  const onSave = overrides.onSave ?? vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const holder: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    holder.current = TestRenderer.create(
      createElement(ProfileMetadataForm, {
        profile: SAVED,
        isSaving: false,
        onSave,
        onDirtyChange: overrides.onDirtyChange,
      })
    );
  });
  const renderer = holder.current;
  if (renderer === null) {
    throw new Error('the metadata form did not render');
  }
  return { renderer, onSave };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ProfileMetadataForm', () => {
  it('seeds the saved metadata', () => {
    const { renderer } = mount();

    expect(field(renderer.root, 'Profile name').props.defaultValue).toBe('Backend debugging');
  });

  it('recomputes the name message from the typed text after a refused submit', async () => {
    const { renderer, onSave } = mount();

    type(renderer.root, 'Profile name', '');
    await submit(renderer.root);
    expect(field(renderer.root, 'Profile name').props.error).toBe('Enter a profile name');

    type(renderer.root, 'Profile name', 'x'.repeat(101));
    expect(field(renderer.root, 'Profile name').props.error).toBe('Profile name is too long');

    type(renderer.root, 'Profile name', 'Renamed');
    expect(field(renderer.root, 'Profile name').props.error).toBeUndefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the trimmed metadata and reports the form clean', async () => {
    const onDirtyChange = vi.fn<(dirty: boolean) => void>();
    const { renderer, onSave } = mount({ onDirtyChange });

    type(renderer.root, 'Profile name', '  Renamed  ');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    type(renderer.root, 'Profile description', '  Shorter description  ');
    await submit(renderer.root);

    expect(onSave).toHaveBeenCalledWith({ name: 'Renamed', description: 'Shorter description' });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('reports whitespace that a submit would not send as no edit', () => {
    const onDirtyChange = vi.fn<(dirty: boolean) => void>();
    const { renderer } = mount({ onDirtyChange });

    type(renderer.root, 'Profile name', `  ${SAVED.name}  `);

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
