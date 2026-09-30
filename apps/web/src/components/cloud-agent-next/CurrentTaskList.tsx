'use client';

import { useState } from 'react';
import { ChevronRight, CircleDot, ListChecks, Square, SquareCheck, SquareX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CurrentTodos } from './current-todos';

const todoStatuses = {
  pending: { icon: Square, label: 'Pending' },
  in_progress: { icon: CircleDot, label: 'In progress' },
  completed: { icon: SquareCheck, label: 'Completed' },
  cancelled: { icon: SquareX, label: 'Cancelled' },
} as const;

type CurrentTaskListProps = {
  todos: CurrentTodos | null;
};

export function CurrentTaskList({ todos }: CurrentTaskListProps) {
  const [expanded, setExpanded] = useState(true);

  if (!todos || todos.total === 0) return null;

  const { shown, completed, total, hiddenBefore, hiddenAfter } = todos;
  const active = shown.find(todo => todo.status === 'in_progress');

  return (
    <div className="border-border/60 bg-muted/20 mb-2 rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-6 w-full items-center gap-2 px-2 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11"
      >
        <ListChecks className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">Tasks</span>
        {active && <span className="text-foreground min-w-0 truncate">{active.content}</span>}
        <span className="flex-1" />
        <span aria-label={`${completed} of ${total} tasks completed`}>
          {completed}/{total}
        </span>
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="max-h-48 space-y-2 overflow-auto px-2 pb-2">
          {hiddenBefore > 0 && (
            <div className="text-muted-foreground text-xs">
              {hiddenBefore} earlier {hiddenBefore === 1 ? 'task' : 'tasks'} hidden
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
              {hiddenAfter} later {hiddenAfter === 1 ? 'task' : 'tasks'} hidden
            </div>
          )}
        </div>
      )}
    </div>
  );
}
