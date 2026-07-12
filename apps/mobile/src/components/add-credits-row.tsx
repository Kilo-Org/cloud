import { Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';

type AddCreditsRowProps = Readonly<{
  url: string;
  className?: string;
}>;

/** Zero-balance CTA row: muted copy + an "Add credits" button to the web billing page. */
export function AddCreditsRow({ url, className }: AddCreditsRowProps) {
  // App Store review: iOS must not show an in-app CTA that opens an external
  // purchase/billing page. Credits are managed on the web there, so this row is
  // Android-only — gate it here so no call site can surface it on iOS.
  if (Platform.OS === 'ios') {
    return null;
  }
  return (
    <View className={cn('flex-row items-center justify-between', className)}>
      <Text className="flex-1 pr-3 text-xs text-muted-foreground">
        Add credits to keep usage running.
      </Text>
      <Button
        size="sm"
        variant="outline"
        onPress={() => {
          void openExternalUrl(url, { label: 'billing page' });
        }}
      >
        <Text className="text-xs font-semibold">Add credits</Text>
      </Button>
    </View>
  );
}
