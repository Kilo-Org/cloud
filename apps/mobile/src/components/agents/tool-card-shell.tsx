import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { ChevronDown, type LucideIcon, XCircle } from 'lucide-react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { getToolFileAttachments, getToolImageAttachments } from './tool-card-attachments';
import { ToolCardFileAttachments } from './tool-card-file-attachments';
import { ToolCardImageAttachments } from './tool-card-image-attachments';

type ToolCardShellProps = {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  badge?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  defaultExpanded?: boolean;
  /** When set, completed image attachments render above children in the expanded body. */
  part?: ToolPart;
  children?: React.ReactNode;
};

export function ToolCardShell({
  icon: Icon,
  title,
  subtitle,
  badge,
  status,
  defaultExpanded = false,
  part,
  children,
}: Readonly<ToolCardShellProps>) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const colors = useThemeColors();
  const imageAttachments = part ? getToolImageAttachments(part) : [];
  const fileAttachments = part ? getToolFileAttachments(part) : [];
  const hasContent = Boolean(children) || imageAttachments.length > 0 || fileAttachments.length > 0;

  const rotation = useSharedValue(defaultExpanded ? 180 : 0);

  useEffect(() => {
    rotation.value = withTiming(isExpanded ? 180 : 0, { duration: 200 });
  }, [isExpanded, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  function handlePress() {
    if (hasContent) {
      setIsExpanded(prev => !prev);
    }
  }

  let accessibilityHint: string | undefined = undefined;
  if (hasContent) {
    accessibilityHint = isExpanded ? 'Collapse details' : 'Expand details';
  }

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      className="overflow-hidden rounded-lg border border-border"
    >
      <Pressable
        className="flex-row items-center gap-2 px-3 py-2 active:bg-secondary"
        onPress={handlePress}
        disabled={!hasContent}
        accessibilityRole="button"
        accessibilityLabel={`${subtitle ?? title} tool, ${status}`}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !hasContent }}
      >
        {status === 'pending' || status === 'running' ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : null}
        {status === 'error' ? <XCircle size={16} color={colors.destructive} /> : null}
        {status === 'completed' ? <Icon size={16} color={colors.mutedForeground} /> : null}

        <View className="flex-1 flex-row items-center gap-1.5">
          <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
            {subtitle ?? title}
          </Text>
          {badge ? <Text className="text-xs text-muted-foreground">{badge}</Text> : null}
        </View>

        {hasContent ? (
          <Animated.View style={chevronStyle}>
            <ChevronDown size={14} color={colors.mutedForeground} />
          </Animated.View>
        ) : null}
      </Pressable>

      {isExpanded && hasContent ? (
        <Animated.View
          entering={FadeIn.duration(150)}
          className="gap-2 border-t border-border px-3 py-2"
        >
          {imageAttachments.length > 0 && part ? <ToolCardImageAttachments part={part} /> : null}
          {fileAttachments.length > 0 && part ? <ToolCardFileAttachments part={part} /> : null}
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
