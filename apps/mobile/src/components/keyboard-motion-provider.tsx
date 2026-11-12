import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import {
  KeyboardProvider,
  useGenericKeyboardHandler,
  useKeyboardContext,
} from 'react-native-keyboard-controller';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';

type KeyboardMotion = {
  /** 0 while the keyboard is down, 1 when it has landed. */
  progress: SharedValue<number>;
  /** The keyboard's height in dp; 0 while it is down. */
  height: SharedValue<number>;
};

const KeyboardMotionContext = createContext<KeyboardMotion | null>(null);

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
  const motion = useSharedMotionValue();
  const progress = motion.progress;

  useEffect(() => {
    progress.value = reanimated.progress.value;
  }, [progress, reanimated.progress]);

  useGenericKeyboardHandler(
    {
      onMove: event => {
        'worklet';
        progress.value = event.progress;
        motion.height.value = event.height;
      },
      onInteractive: event => {
        'worklet';
        progress.value = event.progress;
        motion.height.value = event.height;
      },
      onEnd: event => {
        'worklet';
        progress.value = event.progress;
        motion.height.value = event.height;
      },
    },
    // The value object is stable for the provider's lifetime.
    [motion]
  );

  return <KeyboardMotionContext value={motion}>{children}</KeyboardMotionContext>;
}

function useSharedMotionValue(): KeyboardMotion {
  const progress = useSharedValue(0);
  const height = useSharedValue(0);
  return useMemo(() => ({ progress, height }), [progress, height]);
}

function useKeyboardMotion(): KeyboardMotion {
  const motion = useContext(KeyboardMotionContext);
  if (motion === null) {
    throw new Error('KeyboardMotionProvider is required for keyboard motion');
  }
  return motion;
}

export function useKeyboardMotionProgress(): SharedValue<number> {
  return useKeyboardMotion().progress;
}

/**
 * The keyboard's height, updated on the UI thread with the keyboard's own
 * frames. A view that follows it moves in the same frame as the keyboard, with
 * no layout pass in between.
 */
export function useKeyboardMotionHeight(): SharedValue<number> {
  return useKeyboardMotion().height;
}
