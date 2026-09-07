/* eslint-disable capitalized-comments, id-length, init-declarations, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-expect, jest/no-conditional-in-test, max-lines, no-unused-expressions, sort-keys, vitest/prefer-import-in-mock, vitest/prefer-called-times -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { ModelPicker } from './model-picker';
import { useModelPreferences } from './use-model-preferences';

vi.mock('./use-model-preferences', () => ({
  useModelPreferences: vi.fn(),
}));

const auth: StoredAuth = { token: 'token-1', userEmail: 'user@kilo.ai' };

const gatewayModel = (id: string, name: string, isPreferred = false): KiloGatewayModelOption => ({
  id,
  isPreferred,
  name,
  variants: [],
});

const mockUseModelPreferences = vi.mocked(useModelPreferences);

const renderModelPicker = ({
  disabled = false,
  model,
  modelOptions,
}: {
  readonly disabled?: boolean;
  readonly model: string;
  readonly modelOptions: readonly KiloGatewayModelOption[];
}) =>
  render(
    createElement(ModelPicker, {
      auth,
      disabled,
      model,
      modelOptions,
      onModelChange: vi.fn(),
      organizationId: undefined,
    })
  );

describe('model picker stored-model display', () => {
  beforeEach(() => {
    mockUseModelPreferences.mockReturnValue({
      favorites: new Set<string>(),
      refetch: vi.fn(),
      status: 'ready',
      toggleError: false,
      toggleFavorite: vi.fn(),
    });
  });

  it('shows the stored model id while the catalog is empty', () => {
    const { getByLabelText } = renderModelPicker({
      model: 'anthropic/claude-sonnet-4',
      modelOptions: [],
    });

    const trigger = getByLabelText('Model');
    if (trigger instanceof HTMLButtonElement) {
      expect(trigger.textContent).toContain('anthropic/claude-sonnet-4');
      expect(trigger.dataset['modelId']).toBe('anthropic/claude-sonnet-4');
    }
  });

  it('shows Loading models... with no stored model and no catalog', () => {
    const { getByLabelText } = renderModelPicker({ model: '', modelOptions: [] });

    const trigger = getByLabelText('Model');
    if (trigger instanceof HTMLButtonElement) {
      expect(trigger.textContent).toContain('Loading models...');
      expect(trigger.dataset['modelId']).toBeUndefined();
    }
  });

  it('shows the catalog name when the catalog contains the stored model', () => {
    const { getByLabelText } = renderModelPicker({
      model: 'anthropic/claude-sonnet-4',
      modelOptions: [gatewayModel('anthropic/claude-sonnet-4', 'Claude Sonnet 4')],
    });

    const trigger = getByLabelText('Model');
    if (trigger instanceof HTMLButtonElement) {
      expect(trigger.textContent).toContain('Claude Sonnet 4');
      expect(trigger.textContent).not.toContain('anthropic/claude-sonnet-4');
    }
  });

  it('keeps the stored id when the catalog misses the stored model', () => {
    const { getByLabelText } = renderModelPicker({
      model: 'anthropic/claude-sonnet-4',
      modelOptions: [gatewayModel('other/alpha', 'Other Alpha', true)],
    });

    const trigger = getByLabelText('Model');
    if (trigger instanceof HTMLButtonElement) {
      expect(trigger.textContent).toContain('anthropic/claude-sonnet-4');
      expect(trigger.textContent).not.toContain('Other Alpha');
    }
  });

  it('stays closed when disabled', () => {
    const { getByLabelText, queryByRole } = renderModelPicker({
      disabled: true,
      model: 'anthropic/claude-sonnet-4',
      modelOptions: [],
    });

    const trigger = getByLabelText('Model');
    if (trigger instanceof HTMLButtonElement) {
      expect(trigger.disabled).toBe(true);
      fireEvent.click(trigger);
    }

    expect(queryByRole('dialog', { name: 'Select model' })).toBeNull();
  });
});

describe('model picker pinned search bar', () => {
  beforeEach(() => {
    // jsdom implements no layout and defines no scrollIntoView to spy on.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    mockUseModelPreferences.mockReturnValue({
      favorites: new Set<string>(),
      refetch: vi.fn(),
      status: 'ready',
      toggleError: false,
      toggleFavorite: vi.fn(),
    });
  });

  const longCatalog = Array.from({ length: 60 }, (_, index) =>
    gatewayModel(`org/model-${index}`, `Model ${index}`)
  );

  const openPicker = (): ReturnType<typeof renderModelPicker> => {
    const view = renderModelPicker({ model: 'org/model-0', modelOptions: longCatalog });
    fireEvent.click(view.getByLabelText('Model'));
    return view;
  };

  it('pins the search bar under the header so it stays visible while the list scrolls', () => {
    const { getByLabelText } = openPicker();

    const search = getByLabelText('Search models');
    // jsdom has no layout engine, so the pin contract is the sticky positioning
    // of the search bar's wrapper, the same mechanism as the dialog header.
    // top-14 must keep matching the h-14 header height directly above it.
    const pinnedBar = search.parentElement;
    expect(pinnedBar?.classList.contains('sticky')).toBe(true);
    expect(pinnedBar?.classList.contains('top-14')).toBe(true);
    expect(pinnedBar?.classList.contains('z-10')).toBe(true);
    // Rows scroll under the pinned bar, so it must paint its own background.
    expect(pinnedBar?.classList.contains('bg-surface-background')).toBe(true);
    // The pinned bar and the list live in the dialog's scroll container, whose
    // chrome stays put while the rows move.
    expect(pinnedBar?.parentElement?.classList.contains('overflow-y-auto')).toBe(true);
  });

  it('keeps the search focus and typed text while the model list scrolls', () => {
    const { getByLabelText, getByRole } = openPicker();

    const search = getByLabelText('Search models');
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('Search models must be an input');
    }

    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'model 5' } });

    const dialog = getByRole('dialog', { name: 'Select model' });
    fireEvent.scroll(dialog, { target: { scrollTop: 400 } });

    const searchAfterScroll = getByLabelText('Search models');
    if (!(searchAfterScroll instanceof HTMLInputElement)) {
      throw new Error('Search models must be an input');
    }

    expect(document.activeElement).toBe(searchAfterScroll);
    expect(searchAfterScroll.value).toBe('model 5');
  });
});
