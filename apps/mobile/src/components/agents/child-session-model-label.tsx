import { Text } from '@/components/ui/text';

export function ChildSessionModelLabel({ modelLabel }: Readonly<{ modelLabel: string }>) {
  return (
    <Text
      className="text-xs leading-4 text-muted-foreground"
      numberOfLines={1}
      accessibilityLabel={`Model: ${modelLabel}`}
    >
      {modelLabel}
    </Text>
  );
}
