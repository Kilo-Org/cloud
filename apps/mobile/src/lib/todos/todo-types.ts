import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type TodosOutputs = inferRouterOutputs<MobileRouter>['todos'];

export type TodoList = TodosOutputs['lists']['list'][number];
export type TodoItem = TodosOutputs['items']['list'][number];
export type TodoLinkedSession = TodoItem['sessions'][number];
export type TodoItemDetail = TodosOutputs['items']['get'];
export type UpNextTodo = TodosOutputs['items']['upNext'][number];
export type TodoCandidate = TodosOutputs['items']['candidatesForSession'][number];
export type SessionTodo = NonNullable<TodosOutputs['items']['forSession']>;
