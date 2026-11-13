import type { ViewProps } from 'react-native';

export type CursorStyle = 'block' | 'bar' | 'underline';

export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TerminalTheme = {
  foreground?: string;
  background?: string;
  cursor?: string;
  selection?: string;
  ansi?: readonly string[];
};

export type NativeTerminalTheme = {
  foreground: number;
  background: number;
  cursor: number;
  selection: number;
  ansi: number[];
};

export type TerminalCloseNotice = {
  exitStatus: number;
  error: string | null;
};

export type TerminalViewHandle = {
  sendInput(base64: string): Promise<void>;
  copySelection(): Promise<void>;
  paste(text: string): Promise<void>;
  pasteFromClipboard(): Promise<void>;
  scrollToBottom(): Promise<void>;
};

export type TerminalViewProps = Omit<ViewProps, 'children'> & {
  sourceId: string;
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalTheme;
  cursorStyle?: CursorStyle;
  onResize?: (size: TerminalSize) => void;
  onLinkPress?: (url: string) => void;
  onBell?: () => void;
  onTitleChange?: (title: string | null) => void;
  onSelectionChange?: (selecting: boolean) => void;
  onFontSizeChange?: (fontSize: number) => void;
  onClosed?: (notice: TerminalCloseNotice) => void;
};

export type NativeTerminalViewProps = Omit<
  TerminalViewProps,
  | 'onResize'
  | 'onLinkPress'
  | 'onBell'
  | 'onTitleChange'
  | 'onSelectionChange'
  | 'onFontSizeChange'
  | 'onClosed'
  | 'theme'
> & {
  theme?: NativeTerminalTheme;
  onResize?: (event: { nativeEvent: TerminalSize }) => void;
  onLinkPress?: (event: { nativeEvent: { url: string } }) => void;
  onBell?: () => void;
  onTitleChange?: (event: { nativeEvent: { title: string | null } }) => void;
  onSelectionChange?: (event: { nativeEvent: { selecting: boolean } }) => void;
  onFontSizeChange?: (event: { nativeEvent: { fontSize: number } }) => void;
  onClosed?: (event: { nativeEvent: TerminalCloseNotice }) => void;
};
