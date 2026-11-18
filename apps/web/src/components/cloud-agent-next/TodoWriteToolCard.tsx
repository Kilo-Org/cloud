import { CircleDot, ListChecks, Square, SquareCheck, SquareX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';
import { getTodoPresentation } from './tool-todos';

type TodoWriteToolCardProps = {
  toolPart: ToolPart;
};

const todoStatuses = {
  pending: { icon: Square, label: 'Pending' },
  in_progress: { icon: CircleDot, label: 'In progress' },
  completed: { icon: SquareCheck, label: 'Completed' },
  cancelled: { icon: SquareX, label: 'Cancelled' },
};

export function TodoWriteToolCard({ toolPart }: TodoWriteToolCardProps) {
  const state = toolPart.state;
  if (state.status !== 'completed') return null;

  const { shown, completed, total, hiddenBefore, hiddenAfter } = getTodoPresentation(
    state.input.todos,
    state.metadata
  );

  return (
    <ToolCardShell
      icon={ListChecks}
      title="Todos"
      status={state.status}
      subtitle={
        total > 0 ? (
          <span aria-label={`${completed} of ${total} todos completed`}>
            {completed}/{total}
          </span>
        ) : undefined
      }
    >
      <div className="max-h-60 space-y-2 overflow-auto">
        {hiddenBefore > 0 && (
          <div className="text-muted-foreground text-xs">
            {hiddenBefore} earlier {hiddenBefore === 1 ? 'to-do' : 'to-dos'} hidden
          </div>
        )}
        {shown.length > 0 && (
          <ul className="space-y-1">
            {shown.map((todo, index) => {
              const { icon: Icon, label } = todoStatuses[todo.status];
              return (
                <li key={index} className="flex items-start gap-2 text-xs">
                  <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span
                    className={cn(
                      'min-w-0 break-words',
                      (todo.status === 'completed' || todo.status === 'cancelled') &&
                        'text-muted-foreground line-through',
                      todo.changed && 'font-medium'
                    )}
                  >
                    <span className="sr-only">{label}: </span>
                    {todo.content}
                  </span>
                  {todo.priority === 'high' && (
                    <span className="text-destructive shrink-0">(high)</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hiddenAfter > 0 && (
          <div className="text-muted-foreground text-xs">
            {hiddenAfter} later {hiddenAfter === 1 ? 'to-do' : 'to-dos'} hidden
          </div>
        )}
        {shown.length === 0 && hiddenBefore === 0 && hiddenAfter === 0 && (
          <div className="text-muted-foreground text-xs italic">No todos to display</div>
        )}
      </div>
    </ToolCardShell>
  );
}
