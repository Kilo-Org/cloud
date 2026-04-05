import { ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';

type TodoReadToolCardProps = {
  toolPart: ToolPart;
};

type TodoItem = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
};

function parseTodoOutput(output: string | undefined): TodoItem[] {
  if (!output) return [];
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed as TodoItem[];
    }
    if (parsed && typeof parsed === 'object' && 'todos' in parsed && Array.isArray(parsed.todos)) {
      return parsed.todos as TodoItem[];
    }
  } catch {
    // Output might not be JSON
  }
  return [];
}

function getStatusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '→';
    case 'cancelled':
      return '✗';
    case 'pending':
    default:
      return '○';
  }
}

function getStatusColor(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return 'text-green-500';
    case 'in_progress':
      return 'text-blue-500';
    case 'cancelled':
      return 'text-muted-foreground line-through';
    case 'pending':
    default:
      return 'text-muted-foreground';
  }
}

export function TodoReadToolCard({ toolPart }: TodoReadToolCardProps) {
  const state = toolPart.state;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const todos = parseTodoOutput(output);
  const completedCount = todos.filter(t => t.status === 'completed').length;
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;

  const summaryParts: string[] = [];
  if (todos.length > 0) {
    summaryParts.push(`${todos.length} todos`);
    if (inProgressCount > 0) summaryParts.push(`${inProgressCount} active`);
    if (completedCount > 0) summaryParts.push(`${completedCount} done`);
  }

  return (
    <ToolCardShell
      icon={ListTodo}
      title="Todos"
      status={state.status}
      badge={
        state.status === 'completed' ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {summaryParts.join(', ') || 'empty'}
          </span>
        ) : undefined
      }
    >
      {/* Todo list */}
      {todos.length > 0 && (
        <div className="space-y-1">
          {todos.map(todo => (
            <div key={todo.id} className={cn('text-xs', getStatusColor(todo.status))}>
              <span className="mr-1 font-mono">{getStatusIcon(todo.status)}</span>
              <span className={todo.status === 'cancelled' ? 'line-through' : ''}>
                {todo.content}
              </span>
              {todo.priority === 'high' && <span className="ml-1 text-red-400">(high)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {state.status === 'completed' && todos.length === 0 && (
        <div className="text-muted-foreground text-xs italic">No todos</div>
      )}

      {/* Error */}
      {error && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Error:</div>
          <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
            <code>{error}</code>
          </pre>
        </div>
      )}

      {/* Running state */}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Reading todos...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to read...</div>
      )}
    </ToolCardShell>
  );
}
