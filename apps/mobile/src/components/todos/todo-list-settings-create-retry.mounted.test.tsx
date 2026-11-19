import {
  errorLine,
  list,
  mount,
  nameInput,
  pressDone,
  resetTodoState,
  state,
  unmountSuite,
} from './todo-list-settings-sheet.test-helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { act } from '@/test/renderer';

beforeEach(async () => {
  await resetTodoState();
});

afterEach(() => {
  unmountSuite();
});

describe('To-do list settings create retry', () => {
  it('keeps a failed new list on the form and opens it after the retry succeeds', async () => {
    state.create
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...list, id: 'list-new' });
    mount(null);
    act(() => {
      nameInput().onChangeText('New list');
    });

    await pressDone();

    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      organizationId: null,
      name: 'New list',
      emoji: null,
      gitUrl: null,
      mode: null,
      model: null,
      variant: null,
    });
    expect(state.back).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(errorLine()).toBe(i18n.t('todos.lists.createFailed'));

    await pressDone();

    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/(app)/todos/list-new');
    expect(errorLine()).toBeNull();
  });
});
