import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { type DeepPartial, type Theme } from 'stream-chat-expo';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function useStreamChatTheme(): DeepPartial<Theme> {
  const colorScheme = useColorScheme();
  const colors = useThemeColors();

  const [theme, setTheme] = useState<DeepPartial<Theme>>(() => buildTheme(colorScheme, colors));

  useEffect(() => {
    setTheme(buildTheme(colorScheme, colors));
  }, [colorScheme, colors]);

  return theme;
}

function buildTheme(
  colorScheme: ReturnType<typeof useColorScheme>,
  colors: ReturnType<typeof useThemeColors>
): DeepPartial<Theme> {
  return {
    colors:
      colorScheme === 'dark'
        ? {
            black: colors.foreground,
            white: colors.background,
            white_smoke: colors.secondary,
            white_snow: colors.muted,
            grey: colors.mutedForeground,
            grey_dark: colors.mutedForeground,
            grey_gainsboro: colors.border,
            grey_whisper: colors.border,
            light_blue: 'hsl(0, 0%, 20%)',
            light_gray: 'hsl(0, 0%, 20%)',
            blue_alice: 'hsl(0, 0%, 18%)',
            text_high_emphasis: colors.foreground,
            text_low_emphasis: colors.mutedForeground,
            bg_gradient_start: colors.background,
            bg_gradient_end: colors.secondary,
            icon_background: colors.card,
            overlay: 'rgba(0, 0, 0, 0.8)',
          }
        : {},
    dateHeader: {
      container: {
        backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : undefined,
      },
      text: {
        color: colorScheme === 'dark' ? colors.foreground : undefined,
      },
    },
    inlineDateSeparator: {
      container: {
        backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : undefined,
      },
      text: {
        color: colorScheme === 'dark' ? colors.foreground : undefined,
      },
    },
    messageInput: {
      container: {
        paddingHorizontal: 12,
        borderColor: colors.border,
      },
    },
  };
}
