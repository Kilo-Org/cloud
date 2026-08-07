import { View } from 'react-native';
import { Circle, CircleCheck, CircleDot, CircleX } from 'lucide-react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { type TodoTask } from '../tool-list-model';

type TodoTaskRowsProps = {
  tasks: readonly TodoTask[];
  truncated?: boolean;
};

const STATUS_ICON = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
  cancelled: CircleX,
} as const;

function iconColorFor(
  status: TodoTask['status'],
  colors: ReturnType<typeof useThemeColors>
): string {
  if (status === 'completed') {
    return colors.good;
  }
  if (status === 'in_progress') {
    return colors.foreground;
  }
  return colors.mutedForeground;
}

/**
 * One row per todo task for the todoread/todowrite sheets: a per-status
 * icon, selectable text, and muted line-through styling for cancelled tasks.
 * A truncated model shows the standard marker. Needs theme colors for the
 * icon inks, so it lives in its own module for the direct-call suites to mock.
 */
export function TodoTaskRows({ tasks, truncated = false }: Readonly<TodoTaskRowsProps>) {
  const colors = useThemeColors();

  return (
    <View>
      {tasks.map((task, index) => {
        const Icon = STATUS_ICON[task.status];
        return (
          <View
            key={index}
            className="flex-row items-center gap-2 border-b border-hair-soft px-2 py-1.5"
          >
            <Icon size={16} color={iconColorFor(task.status, colors)} />
            <SelectableText
              className={cn(
                'flex-1 text-sm',
                task.status === 'cancelled' && 'text-muted-foreground line-through'
              )}
            >
              {task.content}
            </SelectableText>
          </View>
        );
      })}
      {truncated ? (
        <Text accessibilityLabel="Content truncated" className="mt-1 text-xs text-muted-foreground">
          Truncated
        </Text>
      ) : null}
    </View>
  );
}
