import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  ProfileDescriptionField,
  ProfileNameField,
} from '@/components/profiles/profile-bound-field';
import { PROFILE_DESCRIPTION_MAX_LENGTH, PROFILE_NAME_MAX_LENGTH } from '@/lib/agent-profile-forms';
import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
}));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));

const onChangeText = vi.fn<(value: string) => void>();

beforeEach(() => {
  onChangeText.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function mount(element: ReactElement): TestRenderer.ReactTestRenderer {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(element);
  });
  const { renderer } = holder;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function nodes(root: ReactTestInstance, tag: string): ReactTestInstance[] {
  return root.findAll(node => node.type === tag);
}

function field(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
  const [input] = nodes(renderer.root, 'FormField');
  if (input === undefined) {
    throw new Error('the profile field was not rendered');
  }
  return input;
}

/** The value the field holds now, as the native input reported it. */
function enter(renderer: TestRenderer.ReactTestRenderer, value: string): void {
  act(() => {
    (field(renderer).props.onChangeText as (next: string) => void)(value);
  });
}

function counter(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance | undefined {
  return nodes(renderer.root, 'Text').find(node => /^\d+$/.test(String(node.props.children)));
}

function boundMessages(renderer: TestRenderer.ReactTestRenderer): unknown[] {
  return nodes(renderer.root, 'AccessibleStatus').map(node => node.props.message);
}

describe('profile bound field', () => {
  it('caps the name at the server bound and keeps it a single line', () => {
    const renderer = mount(createElement(ProfileNameField, { onChangeText }));

    expect(field(renderer).props.maxLength).toBe(PROFILE_NAME_MAX_LENGTH);
    expect(field(renderer).props.multiline).toBeUndefined();
    expect(field(renderer).props.label).toBe('Profile name');
  });

  it('caps the description at the server bound as a multiline field', () => {
    const renderer = mount(createElement(ProfileDescriptionField, { onChangeText }));

    expect(field(renderer).props.maxLength).toBe(PROFILE_DESCRIPTION_MAX_LENGTH);
    expect(field(renderer).props.multiline).toBe(true);
    expect(field(renderer).props.label).toBe('Profile description');
  });

  it('passes every typed value through to the caller', () => {
    const renderer = mount(createElement(ProfileDescriptionField, { onChangeText }));

    enter(renderer, 'eu-west');

    expect(onChangeText).toHaveBeenCalledWith('eu-west');
  });

  it('says nothing about the bound while the value is well inside it', () => {
    const renderer = mount(createElement(ProfileDescriptionField, { onChangeText }));

    enter(renderer, 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH - 200));

    expect(counter(renderer)).toBeUndefined();
    expect(boundMessages(renderer)).toHaveLength(0);
  });

  it('counts the room left once the value reaches the last tenth of the bound', () => {
    const renderer = mount(createElement(ProfileDescriptionField, { onChangeText }));

    enter(renderer, 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH - 20));

    const remaining = counter(renderer);
    expect(remaining?.props.children).toBe(20);
    expect(remaining?.props.accessibilityLabel).toBe('20 characters remaining');
    expect(boundMessages(renderer)).toHaveLength(0);
  });

  it('states the bound instead of the count at it', () => {
    const renderer = mount(createElement(ProfileDescriptionField, { onChangeText }));

    enter(renderer, 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH));

    expect(counter(renderer)).toBeUndefined();
    expect(boundMessages(renderer)).toEqual([
      `Use at most ${PROFILE_DESCRIPTION_MAX_LENGTH} characters`,
    ]);
  });

  it('states the bound for a value the server already holds above it', () => {
    const renderer = mount(
      createElement(ProfileDescriptionField, {
        defaultValue: 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH + 50),
        onChangeText,
      })
    );

    expect(counter(renderer)).toBeUndefined();
    expect(boundMessages(renderer)).toEqual([
      `Use at most ${PROFILE_DESCRIPTION_MAX_LENGTH} characters`,
    ]);
  });

  it('leaves the bound line to the error that already names the problem', () => {
    const renderer = mount(
      createElement(ProfileDescriptionField, {
        defaultValue: 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH),
        error: 'Description is too long',
        onChangeText,
      })
    );

    expect(counter(renderer)).toBeUndefined();
    expect(boundMessages(renderer)).toHaveLength(0);
    expect(field(renderer).props.error).toBe('Description is too long');
  });

  it('shows no bound line while the read-only form disables the field', () => {
    const renderer = mount(
      createElement(ProfileDescriptionField, {
        defaultValue: 'x'.repeat(PROFILE_DESCRIPTION_MAX_LENGTH),
        disabled: true,
        onChangeText,
      })
    );

    expect(boundMessages(renderer)).toHaveLength(0);
    expect(field(renderer).props.disabled).toBe(true);
  });

  it('counts the name against its own bound', () => {
    const renderer = mount(createElement(ProfileNameField, { onChangeText }));

    enter(renderer, 'x'.repeat(PROFILE_NAME_MAX_LENGTH));

    expect(boundMessages(renderer)).toEqual([`Use at most ${PROFILE_NAME_MAX_LENGTH} characters`]);
  });
});
