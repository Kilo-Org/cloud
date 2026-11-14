import nativeModule from './ReactNativeSshTerminalModule';
import type { TerminalSize } from './terminal.types';

export type FeedSource = {
  readonly sourceId: string;
  feed(bytes: Uint8Array): void;
  onInput(listener: (bytes: Uint8Array) => void): () => void;
  onResize(listener: (size: TerminalSize) => void): () => void;
  close(exitStatus?: number | null, error?: string | null): void;
};

export function createFeedSource(): FeedSource {
  const native = nativeModule.createFeedSource();

  return {
    sourceId: native.sourceId,
    feed: bytes => native.feed(bytes),
    onInput: listener => {
      const subscription = native.addListener('onInput', listener);
      return () => subscription.remove();
    },
    onResize: listener => {
      const subscription = native.addListener('onResize', listener);
      return () => subscription.remove();
    },
    close: (exitStatus, error) => native.close(exitStatus, error),
  };
}
