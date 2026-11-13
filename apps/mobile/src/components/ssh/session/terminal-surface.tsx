import { TerminalView, type TerminalViewHandle } from '@kilocode/react-native-ssh';
import { type RefObject, useMemo } from 'react';

import { terminalThemeFor } from '@/lib/ssh/terminal-theme';

/**
 * JetBrains Mono is the app's loaded monospace face (the PR diff renders it),
 * and it carries the block glyphs a terminal draws.
 */
const FONT_FAMILY = 'JetBrainsMono_500Medium';

type TerminalSurfaceProps = Readonly<{
  /** The native byte source the shell writes to. */
  sourceId: string;
  fontSize: number;
  dark: boolean;
  /** Receives the view's handle, which is how input reaches the pty. */
  handleRef: RefObject<TerminalViewHandle | null>;
  onResize?: (cols: number, rows: number) => void;
  onFontSizeChange?: (fontSize: number) => void;
  onLinkPress?: (url: string) => void;
  onTitleChange?: (title: string | null) => void;
  /** A closed shell: `error` is null for a clean remote exit. */
  onClosed?: (error: string | null) => void;
}>;

/**
 * The native terminal, themed for the app's current scheme. This file is the
 * one place that renders the package's view, so its colour contract and the
 * font family have a single owner.
 */
export function TerminalSurface({
  sourceId,
  fontSize,
  dark,
  handleRef,
  onResize,
  onFontSizeChange,
  onLinkPress,
  onTitleChange,
  onClosed,
}: TerminalSurfaceProps) {
  const theme = useMemo(() => terminalThemeFor(dark), [dark]);

  return (
    <TerminalView
      className="flex-1"
      ref={instance => {
        handleRef.current = instance;
      }}
      sourceId={sourceId}
      fontFamily={FONT_FAMILY}
      fontSize={fontSize}
      theme={theme}
      onResize={size => onResize?.(size.cols, size.rows)}
      onFontSizeChange={onFontSizeChange}
      onLinkPress={onLinkPress}
      onTitleChange={onTitleChange}
      onClosed={notice => onClosed?.(notice.error)}
    />
  );
}
