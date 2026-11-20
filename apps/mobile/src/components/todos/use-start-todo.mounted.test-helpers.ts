// The mounted harness of the to-do start hook's suite: the probe component, the
// renderer lifecycle, and the two fixtures every case starts from. The mocks
// stay in the test file, because `vi.mock` is hoisted per file and a helper
// cannot register one for its importer.
import { createElement } from 'react';

import { type TodoList } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { type StartTodoControls, useStartTodo } from './use-start-todo';

export const TODO = { id: 'todo-1', title: 'Ship the fix', notes: null };

export const LIST: Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model' | 'variant'> = {
  organizationId: 'organization-1',
  gitUrl: 'test/project',
  mode: null,
  model: null,
  variant: null,
};

function Probe({ holder }: Readonly<{ holder: { current: StartTodoControls | null } }>) {
  holder.current = useStartTodo();
  return null;
}

/** One mounted hook for a case: mount, read its controls, start a to-do from it. */
export function createHarness() {
  const holder: { current: StartTodoControls | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

  const mounted = (): StartTodoControls => {
    if (!holder.current) {
      throw new TypeError('useStartTodo has not mounted');
    }
    return holder.current;
  };

  return {
    holder,
    mount: (): void => {
      act(() => {
        renderer = TestRenderer.create(createElement(Probe, { holder }));
      });
    },
    unmount: (): void => {
      renderer?.unmount();
      renderer = undefined;
      holder.current = null;
    },
    mounted,
    start: async (startList: typeof LIST = LIST): Promise<void> => {
      await act(async () => {
        await mounted().startNow(TODO, startList);
      });
    },
    /** Re-renders after a case changes what the membership list holds. */
    rerender: (): void => {
      act(() => {
        renderer?.update(createElement(Probe, { holder }));
      });
    },
  };
}
