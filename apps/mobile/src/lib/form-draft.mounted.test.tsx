import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearFormDrafts, useFormDraftState } from '@/lib/form-draft';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/** The live field value and setter, read back through the mounted probe. */
const field: {
  value: string;
  set: ((next: string) => void) | undefined;
} = { value: '', set: undefined };

function Probe({ scope }: Readonly<{ scope: string }>) {
  const [value, setValue] = useFormDraftState(scope, 'key', 'initial');
  field.value = value;
  field.set = setValue;
  return null;
}

function mount(scope: string) {
  return renderWithProviders(createElement(Probe, { scope }));
}

function type(next: string): void {
  if (field.set === undefined) {
    throw new Error('the probe never rendered');
  }
  act(() => {
    field.set?.(next);
  });
}

describe('useFormDraftState', () => {
  beforeEach(() => {
    clearFormDrafts();
    field.value = '';
    field.set = undefined;
  });

  it('restores the typed text on a remount and seeds fresh once every draft is dropped', async () => {
    const scope = 'profiles:variables:profile-a';
    const first = await mount(scope);
    type('typed-key');
    first.unmount();

    const second = await mount(scope);
    expect(field.value).toBe('typed-key');
    second.unmount();

    clearFormDrafts();

    const third = await mount(scope);
    expect(field.value).toBe('initial');
    third.unmount();
  });
});
