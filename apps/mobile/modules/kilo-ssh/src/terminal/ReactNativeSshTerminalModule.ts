import { requireNativeModule } from 'expo-modules-core';

import type { TerminalSize } from './terminal.types';

type Subscription = { remove(): void };

export type NativeFeedSource = {
  readonly sourceId: string;
  feed(bytes: Uint8Array): void;
  close(exitStatus?: number | null, error?: string | null): void;
  addListener(event: 'onInput', listener: (bytes: Uint8Array) => void): Subscription;
  addListener(event: 'onResize', listener: (size: TerminalSize) => void): Subscription;
  removeListener(event: 'onInput', listener: (bytes: Uint8Array) => void): void;
  removeListener(event: 'onResize', listener: (size: TerminalSize) => void): void;
};

export type NativeTerminalModule = {
  createFeedSource(): NativeFeedSource;
};

export default requireNativeModule<NativeTerminalModule>('ReactNativeSshTerminal');
