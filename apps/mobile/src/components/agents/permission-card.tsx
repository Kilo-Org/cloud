import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PermissionCardProps = {
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  onRespond: (response: 'once' | 'always' | 'reject') => void;
  isSubmitting?: boolean;
};

export function PermissionCard({
  permission,
  patterns,
  metadata,
  onRespond,
  isSubmitting = false,
}: Readonly<PermissionCardProps>) {
  const colors = useThemeColors();
  const [activeResponse, setActiveResponse] = useState<'once' | 'always' | 'reject' | null>(null);

  function handleRespond(response: 'once' | 'always' | 'reject') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveResponse(response);
    onRespond(response);
  }

  // Format permission name for display
  const permissionDisplay = permission
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return (
    <View className="mx-4 my-2 overflow-hidden rounded-xl border border-border bg-card">
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text className="text-sm font-medium">Permission Required</Text>
      </View>

      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground">
          Allow <Text className="font-medium">{permissionDisplay}</Text>?
        </Text>

        {patterns.length > 0 && (
          <View className="gap-1 rounded-lg bg-muted p-2">
            <Text className="text-xs font-medium text-muted-foreground">Applies to:</Text>
            {patterns.map((pattern, index) => (
              <Text key={index} className="text-xs text-muted-foreground">
                • {pattern}
              </Text>
            ))}
          </View>
        )}

        {metadata && Object.keys(metadata).length > 0 && (
          <View className="gap-1">
            {Object.entries(metadata).map(([key, value]) => (
              <Text key={key} className="text-xs text-muted-foreground">
                {key}: {String(value)}
              </Text>
            ))}
          </View>
        )}
      </View>

      <View className="flex-row gap-2 border-t border-border p-3">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onPress={() => {
            handleRespond('reject');
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Deny permission"
        >
          {activeResponse === 'reject' && isSubmitting ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : (
            <Text className={cn('text-xs', activeResponse === 'reject' && 'font-medium')}>
              Deny
            </Text>
          )}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          onPress={() => {
            handleRespond('once');
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Allow once"
        >
          {activeResponse === 'once' && isSubmitting ? (
            <ActivityIndicator size="small" color={colors.secondaryForeground} />
          ) : (
            <Text className={cn('text-xs', activeResponse === 'once' && 'font-medium')}>
              Allow Once
            </Text>
          )}
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onPress={() => {
            handleRespond('always');
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Always allow"
        >
          {activeResponse === 'always' && isSubmitting ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text
              className={cn(
                'text-xs text-primary-foreground',
                activeResponse === 'always' && 'font-medium'
              )}
            >
              Always Allow
            </Text>
          )}
        </Button>
      </View>
    </View>
  );
}
