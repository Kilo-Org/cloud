import { ScrollView, View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { getFilename, truncateText } from '../tool-card-utils';

export function EditToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const oldString = typeof input.oldString === 'string' ? input.oldString : '';
  const newString = typeof input.newString === 'string' ? input.newString : '';

  const subtitle = filePath ? getFilename(filePath) : 'edit';
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const hasChanges = oldString.length > 0 || newString.length > 0;

  return (
    <ToolCardShell icon={Pencil} title="edit" subtitle={subtitle} status={part.state.status}>
      {hasChanges ? (
        <View className="gap-2">
          {oldString.length > 0 ? (
            <View className="rounded bg-red-50 px-2 py-1 dark:bg-red-950">
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text
                  selectable
                  className="font-mono text-xs leading-4 text-red-700 dark:text-red-400"
                >
                  {truncateText(oldString, 1000)}
                </Text>
              </ScrollView>
            </View>
          ) : null}
          {newString.length > 0 ? (
            <View className="rounded bg-green-50 px-2 py-1 dark:bg-green-950">
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text
                  selectable
                  className="font-mono text-xs leading-4 text-green-700 dark:text-green-400"
                >
                  {truncateText(newString, 1000)}
                </Text>
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text selectable className="text-xs text-red-500">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
