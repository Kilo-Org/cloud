import { type GestureResponderEvent } from 'react-native';

export type MarkdownLinkLongPressHandler = (href: string, event?: GestureResponderEvent) => void;

/** Returns `true` when the host fully handled the press; falsy runs the confirm-and-open flow. */
export type MarkdownLinkPressHandler = (href: string) => boolean;

/** Hands a code fence's source to the host; fences show a copy button only when supplied. */
export type MarkdownCopyCodeHandler = (code: string) => void;
