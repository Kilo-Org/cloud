import { type TextStyle } from 'react-native';

export const MESSAGE_INPUT_MIN_HEIGHT = 40;
export const MESSAGE_INPUT_MAX_HEIGHT = 128;
export const MESSAGE_INPUT_LINE_HEIGHT = 20;
export const MESSAGE_INPUT_BORDER_WIDTH = 1;
export const MESSAGE_INPUT_BOTTOM_CLEARANCE = 8;

const MESSAGE_INPUT_VERTICAL_PADDING =
  (MESSAGE_INPUT_MIN_HEIGHT - MESSAGE_INPUT_LINE_HEIGHT - MESSAGE_INPUT_BORDER_WIDTH * 2) / 2;

export const messageInputTextStyle = {
  includeFontPadding: false,
  lineHeight: MESSAGE_INPUT_LINE_HEIGHT,
  maxHeight: MESSAGE_INPUT_MAX_HEIGHT,
  minHeight: MESSAGE_INPUT_MIN_HEIGHT,
  paddingBottom: MESSAGE_INPUT_VERTICAL_PADDING,
  paddingTop: MESSAGE_INPUT_VERTICAL_PADDING,
  textAlignVertical: 'top',
} satisfies TextStyle;

export function resolveMessageInputBottomPadding(): number {
  return MESSAGE_INPUT_BOTTOM_CLEARANCE;
}
