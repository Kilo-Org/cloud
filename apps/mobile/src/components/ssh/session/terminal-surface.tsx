import { TerminalView, type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import { type RefObject, useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { TERMINAL_BACKGROUND, TERMINAL_THEME } from '@/lib/ssh/terminal-theme';

/**
 * DESIGN.md names Roboto Mono for terminal text. It is loaded beside JetBrains
 * Mono in the root layout; the PR diff keeps JetBrains Mono, which is why both
 * families are in the bundle.
 */
const FONT_FAMILY = 'RobotoMono_500Medium';

/** The inset the shell's glyphs stay clear of, matched by the key bar's padding. */
const HORIZONTAL_INSET = 8;

const styles = StyleSheet.create({
  // The package's view is a plain native view, not a NativeWind component, so
  // its height comes from this style rather than a class: without it the view
  // lays out at zero height and draws nothing. The background is painted here
  // as well, so a view that remounts after a reconnect never shows the parent
  // surface through it.
  frame: { flex: 1, backgroundColor: TERMINAL_BACKGROUND, paddingHorizontal: HORIZONTAL_INSET },
});

type TerminalSurfaceProps = Readonly<{
  /** The native byte source the shell writes to. */
  sourceId: string;
  fontSize: number;
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
 * The native terminal. This file is the one place that renders the package's
 * view, so its colour contract, its inset and the font family have a single
 * owner.
 */
export function TerminalSurface({
  sourceId,
  fontSize,
  handleRef,
  onResize,
  onFontSizeChange,
  onLinkPress,
  onTitleChange,
  onClosed,
}: TerminalSurfaceProps) {
  const theme = useMemo(() => TERMINAL_THEME, []);

  return (
    <TerminalView
      style={styles.frame}
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
