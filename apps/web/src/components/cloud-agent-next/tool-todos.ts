import * as z from 'zod';

const todoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']).optional().catch(undefined),
  changed: z.boolean().optional().catch(undefined),
});

const todoListSchema = z.array(z.unknown()).transform(items =>
  items.flatMap(item => {
    const parsed = todoSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })
);

const todoViewSchema = z.object({
  mode: z.enum(['full', 'compact']).catch('full'),
  todos: todoListSchema,
  hiddenBefore: z.number().int().nonnegative().catch(0),
  hiddenAfter: z.number().int().nonnegative().catch(0),
});

export function getTodoPresentation(
  inputTodos: unknown,
  metadata?: { todos?: unknown; view?: unknown }
) {
  const parsedTodos = todoListSchema.safeParse(
    Array.isArray(metadata?.todos) ? metadata.todos : inputTodos
  );
  const todos = parsedTodos.success ? parsedTodos.data : [];
  const parsedView = todoViewSchema.safeParse(metadata?.view);
  const view = parsedView.success ? parsedView.data : undefined;

  return {
    shown: view?.todos ?? todos,
    completed: todos.filter(todo => todo.status === 'completed').length,
    total: todos.length,
    hiddenBefore: view?.mode === 'compact' ? view.hiddenBefore : 0,
    hiddenAfter: view?.mode === 'compact' ? view.hiddenAfter : 0,
  };
}
