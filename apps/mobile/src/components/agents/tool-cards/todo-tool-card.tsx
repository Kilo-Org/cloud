import { View } from 'react-native';
import { ListTodo } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
import { buildTodoListModel } from '../tool-list-model';
import { TodoTaskRows } from './todo-task-rows';

/**
 * Sheet body for a todoread/todowrite tool part: one row per task with its
 * state icon (cancelled tasks are muted and struck through), a muted
 * `No tasks.` line for an empty parsed list, the raw-output block fallback
 * when nothing parses, plus the error. Renders only inside the detail sheet —
 * attachments and the pending/running status line live in `ToolPartDetailBody`.
 */
export function TodoToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const todoModel = buildTodoListModel(part);

  return (
    <View className="gap-2">
      {todoModel && todoModel.tasks.length > 0 ? (
        <TodoTaskRows tasks={todoModel.tasks} truncated={todoModel.truncated} />
      ) : null}
      {todoModel && todoModel.tasks.length === 0 ? (
        // eslint-disable-next-line react-native/no-raw-text -- static copy inlined in place of the removed NO_TASKS_TEXT
        <SelectableText className="text-sm text-muted-foreground">No tasks.</SelectableText>
      ) : null}
      {!todoModel && output ? (
        <MonoScrollBlock content={output} textClassName="text-foreground" />
      ) : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function TodoToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={ListTodo}
      label={display.subtitle ?? display.title}
      status={part.state.status}
      accessibilityLabel={`${display.subtitle ?? display.title} tool, ${part.state.status}`}
      onPress={
        hasDetails && openPartDetail
          ? () => {
              openPartDetail(part.id);
            }
          : undefined
      }
    />
  );
}
