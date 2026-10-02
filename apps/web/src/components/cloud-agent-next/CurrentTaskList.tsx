'use client';

import {
  Check,
  ChevronDown,
  CircleDot,
  ListChecks,
  Square,
  SquareCheck,
  SquareX,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  if (!todos || todos.total === 0) return null;

  const { shown, completed, total, hiddenBefore, hiddenAfter } = todos;
  const active = shown.find(todo => todo.status === 'in_progress');
  const StatusIcon = completed === total ? Check : ListChecks;

  return (
    <div className="mb-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:ring-ring flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11"
          >
            <StatusIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="shrink-0 font-medium">Tasks</span>
            <span
              className="shrink-0 tabular-nums"
              aria-label={`${completed} of ${total} tasks completed`}
            >
              {completed}/{total}
            </span>
            {active && <span className="text-foreground min-w-0 truncate">{active.content}</span>}
            <ChevronDown className="ml-auto size-3.5 shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Tasks"
          className="max-h-[min(20rem,var(--radix-popover-content-available-height))] w-[min(32rem,var(--radix-popover-trigger-width))] overflow-auto p-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">Tasks</span>
            <span className="text-muted-foreground tabular-nums">
              {completed}/{total} completed
            </span>
          </div>
          <div className="space-y-2">
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
        </PopoverContent>
      </Popover>
    </div>
  );
}
