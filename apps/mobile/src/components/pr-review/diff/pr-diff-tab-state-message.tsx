import { type ReactNode } from 'react';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Text } from '@/components/ui/text';

export function TabStateMessage({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  /** Optional recovery row under the message (provider retry/check actions). */
  action?: ReactNode;
}) {
  return (
    <CenteredState>
      <View className="items-center gap-2 px-6">
        <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
        <Text variant="muted" className="text-center">
          {message}
        </Text>
        {action}
      </View>
    </CenteredState>
  );
}
