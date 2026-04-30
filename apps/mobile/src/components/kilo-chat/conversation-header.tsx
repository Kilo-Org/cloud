import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';

type Props = { title: string; subtitle?: string };

export function ConversationHeader({ title, subtitle }: Props) {
  return (
    <ScreenHeader
      title={title}
      headerRight={
        subtitle ? <Text className="text-sm text-muted-foreground">{subtitle}</Text> : undefined
      }
    />
  );
}
