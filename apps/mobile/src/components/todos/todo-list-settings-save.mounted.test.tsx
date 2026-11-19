import {
  deferred,
  enterName,
  errorLine,
  header,
  list,
  mount,
  nameInput,
  pressDone,
  resetTodoState,
  settle,
  state,
  unmountSuite,
} from './todo-list-settings-sheet.test-helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

beforeEach(async () => {
  await resetTodoState();
});

afterEach(() => {
  unmountSuite();
});

describe('To-do list settings save', () => {
  it('keeps the sheet open with an error when the update fails', async () => {
    state.update.mockRejectedValueOnce(new Error('offline'));
    mount(list);
    enterName('Renamed list');

    await pressDone();

    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      id: 'test-list',
      name: 'Renamed list',
      emoji: null,
      gitUrl: null,
      mode: null,
      model: null,
      variant: null,
    });
    expect(state.back).not.toHaveBeenCalled();
    expect(errorLine()).toBe(i18n.t('todos.listSettings.saveFailed'));
    expect(nameInput().value).toBe('Renamed list');
  });

  it('closes only after the update resolves, and disables the header meanwhile', async () => {
    const pending = deferred();
    state.update.mockReturnValueOnce(pending.promise);
    mount(list);
    enterName('Renamed list');

    await settle(() => {
      header().onDone();
    });

    expect(state.back).not.toHaveBeenCalled();
    expect(header().disabled).toBe(true);
    expect(header().doneDisabled).toBe(true);

    await settle(() => {
      pending.resolve(undefined);
    });

    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('sends one update when Done is pressed twice while it is in flight', async () => {
    const pending = deferred();
    state.update.mockReturnValueOnce(pending.promise);
    mount(list);
    enterName('Renamed list');

    await settle(() => {
      const sheet = header();
      sheet.onDone();
      sheet.onDone();
    });

    expect(state.update).toHaveBeenCalledTimes(1);

    await settle(() => {
      pending.resolve(undefined);
    });

    expect(state.back).toHaveBeenCalledTimes(1);
  });
});
