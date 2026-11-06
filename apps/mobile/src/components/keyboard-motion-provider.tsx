import { createContext, type ReactNode, useContext, useEffect } from 'react';
import {
  KeyboardProvider,
  useGenericKeyboardHandler,
  useKeyboardContext,
} from 'react-native-keyboard-controller';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';

const KeyboardMotionContext = createContext<SharedValue<number> | null>(null);

export function KeyboardMotionProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <KeyboardProvider>
      <KeyboardMotionValues>{children}</KeyboardMotionValues>
    </KeyboardProvider>
  );
}

/** The library's shared iOS progress reports destinations; its motion handlers report native frames. */
function KeyboardMotionValues({ children }: Readonly<{ children: ReactNode }>) {
  const { reanimated } = useKeyboardContext();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = reanimated.progress.value;
  }, [progress, reanimated.progress]);

  useGenericKeyboardHandler(
    {
      onMove: event => {
        'worklet';
        progress.value = event.progress;
      },
      onInteractive: event => {
        'worklet';
        progress.value = event.progress;
      },
      onEnd: event => {
        'worklet';
        progress.value = event.progress;
      },
    },
    []
  );

  return <KeyboardMotionContext value={progress}>{children}</KeyboardMotionContext>;
}

export function useKeyboardMotionProgress(): SharedValue<number> {
  const progress = useContext(KeyboardMotionContext);
  if (progress === null) {
    throw new Error('KeyboardMotionProvider is required for keyboard motion');
  }
  return progress;
}
