import { type TextInputProps, type TextStyle } from 'react-native';

export const MESSAGE_INPUT_MIN_HEIGHT = 40;
export const MESSAGE_INPUT_FONT_SIZE = 14;
export const MESSAGE_INPUT_LINE_HEIGHT = 20;
export const MESSAGE_INPUT_BORDER_WIDTH = 1;
const MESSAGE_INPUT_BOTTOM_CLEARANCE = 8;
export const MESSAGE_INPUT_MAX_VISIBLE_LINES = 5;
export const MESSAGE_INPUT_HORIZONTAL_PADDING = 24;

const MESSAGE_INPUT_VERTICAL_PADDING =
  (MESSAGE_INPUT_MIN_HEIGHT - MESSAGE_INPUT_LINE_HEIGHT - MESSAGE_INPUT_BORDER_WIDTH * 2) / 2;
export const MESSAGE_INPUT_VERTICAL_INSET =
  MESSAGE_INPUT_VERTICAL_PADDING * 2 + MESSAGE_INPUT_BORDER_WIDTH * 2;

export const MESSAGE_INPUT_MAX_HEIGHT =
  MESSAGE_INPUT_LINE_HEIGHT * MESSAGE_INPUT_MAX_VISIBLE_LINES + MESSAGE_INPUT_VERTICAL_INSET;

export const messageInputTextStyle = {
  fontSize: MESSAGE_INPUT_FONT_SIZE,
  includeFontPadding: false,
  lineHeight: MESSAGE_INPUT_LINE_HEIGHT,
  maxHeight: MESSAGE_INPUT_MAX_HEIGHT,
  minHeight: MESSAGE_INPUT_MIN_HEIGHT,
  paddingBottom: MESSAGE_INPUT_VERTICAL_PADDING,
  paddingTop: MESSAGE_INPUT_VERTICAL_PADDING,
  textAlignVertical: 'top',
} satisfies TextStyle;

export const messageInputKeyboardProps = {
  keyboardType: 'default',
  returnKeyType: 'default',
  submitBehavior: 'newline',
} satisfies Pick<TextInputProps, 'keyboardType' | 'returnKeyType' | 'submitBehavior'>;

export function resolveMessageInputShouldScroll(inputHeight: number): boolean {
  return inputHeight >= MESSAGE_INPUT_MAX_HEIGHT;
}

export function resolveMessageInputHeight(contentHeight: number): number {
  const paddedHeight = Math.ceil(contentHeight + MESSAGE_INPUT_VERTICAL_INSET);
  return Math.min(Math.max(paddedHeight, MESSAGE_INPUT_MIN_HEIGHT), MESSAGE_INPUT_MAX_HEIGHT);
}

export function resolveMessageInputBottomPadding(): number {
  return MESSAGE_INPUT_BOTTOM_CLEARANCE;
}
