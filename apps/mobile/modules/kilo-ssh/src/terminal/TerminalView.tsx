import { requireNativeView } from 'expo';
import { type Ref, forwardRef, useMemo } from 'react';

import type {
  NativeTerminalViewProps,
  TerminalViewHandle,
  TerminalViewProps,
} from './terminal.types';
import { resolveTheme } from './theme';

const NativeTerminalView = requireNativeView<
  NativeTerminalViewProps & { ref?: Ref<TerminalViewHandle> }
>('ReactNativeSshTerminal', 'ReactNativeSshTerminalView');

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  {
    sourceId,
    autoFocus,
    fontFamily,
    fontSize,
    theme,
    cursorStyle,
    onResize,
    onLinkPress,
    onBell,
    onTitleChange,
    onSelectionChange,
    onFontSizeChange,
    onClosed,
    ...viewProps
  },
  ref
) {
  const nativeTheme = useMemo(() => resolveTheme(theme), [theme]);

  return (
    <NativeTerminalView
      {...viewProps}
      ref={ref}
      sourceId={sourceId}
      autoFocus={autoFocus ?? false}
      fontFamily={fontFamily}
      fontSize={fontSize}
      cursorStyle={cursorStyle}
      theme={nativeTheme}
      onResize={onResize && (event => onResize(event.nativeEvent))}
      onLinkPress={onLinkPress && (event => onLinkPress(event.nativeEvent.url))}
      onBell={onBell}
      onTitleChange={onTitleChange && (event => onTitleChange(event.nativeEvent.title))}
      onSelectionChange={
        onSelectionChange && (event => onSelectionChange(event.nativeEvent.selecting))
      }
      onFontSizeChange={onFontSizeChange && (event => onFontSizeChange(event.nativeEvent.fontSize))}
      onClosed={onClosed && (event => onClosed(event.nativeEvent))}
    />
  );
});
