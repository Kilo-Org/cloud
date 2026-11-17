/* eslint-disable max-lines -- one harness stubs every native module a mounted
   suite reaches without a device binary; keeping them together is what makes
   "what is faked here" a single answer. */
import { type ReactNode } from 'react';
import { vi } from 'vitest';

// React Native and the Expo runtime read this flag at import time: the app
// build substitutes it, a Node test worker has no such global, and the Expo
// runtime crashes on the missing reference before a suite can mount anything.
// `true` is the configuration the app ships in development, which is what a
// rendered tree expects: development warnings stay on and the routes gated on
// `__DEV__` (the fixture screens) render.
Object.assign(globalThis, { __DEV__: true });

// The live system font scale comes from a local Expo module, and the test
// projects have no Expo runtime (importing `expo` fails on its ESM resolution).
// The value the app ships at a default scale is all a rendered tree needs; a
// suite that needs another one can register its own mock, which wins.
vi.mock('@/lib/font-scale/native-font-scale', () => ({
  readLiveFontScale: () => null,
  subscribeToFontScale: () => null,
}));

// `expo-localization` imports the `expo` runtime, so the Node test projects
// cannot load it either. The app's root provider tree reads the device locale
// list to follow a device language change, so an English device answers the
// default and nothing else is needed. A suite that needs another locale
// registers its own mock, which wins.
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
  useLocales: () => [{ languageTag: 'en-US' }],
}));

/** The subset of keyboard state the app reads through `useKeyboardState`. */
type KeyboardStateSnapshot = {
  height: number;
  isVisible: boolean;
  progress: number;
  duration: number;
};

// The mobile vitest projects run with no app build, so `@/lib/config` cannot
// load: its real module needs the baked `extra`. Tests that exercise modules
// importing it (the auth retry helpers and everything built on them) would
// otherwise fail before their first assertion.
//
// A Proxy answers every export Vitest resolves, and an unset value keeps the
// build-gated E2E windows closed. A test that needs a config value still mocks
// this module itself; its later registration wins over this one.
vi.mock('@/lib/config', () => new Proxy({}, { get: () => undefined, has: () => true }));

// `@expo/ui/community/bottom-sheet` reaches expo-modules-core and re-exports
// React Native's scroll wrappers, so it cannot load in either project: the
// mounted tests mock `react-native` partially, and the sheet's re-exports read
// names those mocks do not define. The app's `Sheet` wrapper asserts on host
// elements, so a plain host stub is enough. A test that needs real behaviour
// registers its own mock; its later registration wins over this one.
vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheet: 'BottomSheet' }));

// `expo-video` loads a native module at import time, which the test projects do
// not have. The inline video surface is asserted through host elements.
vi.mock('expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: () => ({}) }));

// `@bsky.app/react-native-uitextview` registers native views at import time,
// and `react-native-css` loads the native CSS runtime; neither exists in Node.
// The selectable iOS fence is asserted through the `UITextView` host element.
vi.mock('@bsky.app/react-native-uitextview', () => ({ UITextView: 'UITextView' }));
vi.mock('react-native-css', () => ({ styled: (component: unknown) => component }));

// `expo-background-task` loads the Expo native runtime at import time. The
// result values match the library's enum, so an executor's return is real.
vi.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  registerTaskAsync: vi.fn(() => Promise.resolve()),
}));

// `react-native-keyboard-controller` is a native module. Tests assert the app's
// keyboard surfaces through host elements, so the provider and the views are
// plain hosts and the keyboard read reports a hidden keyboard. `useKeyboardState`
// honors its selector, as the real hook does: a reader that asks for
// `state.height` must receive the number, not the whole state object. A test
// that needs a lift mocks the hook itself with a driveable store.
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: 'KeyboardProvider',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  KeyboardAwareScrollView: 'KeyboardAwareScrollView',
  KeyboardChatScrollView: 'KeyboardChatScrollView',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  useKeyboardState: <T>(selector?: (state: KeyboardStateSnapshot) => T) => {
    const snapshot: KeyboardStateSnapshot = {
      height: 0,
      isVisible: false,
      progress: 0,
      duration: 0,
    };
    return selector ? selector(snapshot) : snapshot;
  },
}));

vi.mock('@/components/keyboard-motion-provider', () => ({
  KeyboardMotionProvider: 'KeyboardMotionProvider',
  useKeyboardMotionProgress: () => ({ value: 0 }),
  useKeyboardMotionHeight: () => ({ value: 0 }),
}));

// `KeyboardFollowPane` reads the keyboard's shared values and reanimated's
// `useAnimatedStyle`. Hosts that mount `ChatComposer` outside the pane only need
// the answer to "am I inside one"; a test that wants the inside path registers
// its own mock, which wins.
vi.mock('@/components/keyboard-follow-pane', () => ({
  KeyboardFollowPane: 'KeyboardFollowPane',
  useInsideKeyboardFollowPane: () => false,
}));

// `react-native-enriched-markdown` and `react-native-webview` are native views.
// Tests assert the markdown and diagram elements through their host props
// (`markdown`, `onLinkPress`, `source`, …).
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: 'EnrichedMarkdownText' }));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));

// `lucide-react-native` renders every icon through `react-native-svg`, whose
// CommonJS entry `require`s the Flow source of `react-native` at import time.
// Node cannot parse it, and a suite's own `react-native` mock cannot reach a
// `require` issued inside an externalized package. Both projects inline
// `lucide-react-native` (see the vitest configs) so this mock replaces the
// module before it loads: an icon and the app's own few SVG surfaces render as
// the host element of the same name, which is what their suites query. A suite
// that mocks `react-native-svg` itself registers later and wins over this one.
vi.mock('react-native-svg', async () => {
  const React = await import('react');

  function host(name: string) {
    const Stub = React.forwardRef<unknown, { children?: ReactNode }>(
      ({ children, ...props }, _ref) => React.createElement(name, props, children)
    );
    Stub.displayName = name;
    return Stub;
  }

  // Every element the icon set draws with, plus the ones the app's own SVG
  // surfaces use (`react-native-svg` exports each of these as a component).
  const elements = {
    Svg: host('Svg'),
    Path: host('Path'),
    Circle: host('Circle'),
    Rect: host('Rect'),
    Line: host('Line'),
    Ellipse: host('Ellipse'),
    Polyline: host('Polyline'),
    Polygon: host('Polygon'),
    Text: host('Text'),
    TSpan: host('TSpan'),
    G: host('G'),
    Defs: host('Defs'),
    ClipPath: host('ClipPath'),
    Mask: host('Mask'),
    Use: host('Use'),
    Stop: host('Stop'),
    LinearGradient: host('LinearGradient'),
    RadialGradient: host('RadialGradient'),
    Pattern: host('Pattern'),
    Symbol: host('Symbol'),
    Marker: host('Marker'),
    Image: host('Image'),
    ForeignObject: host('ForeignObject'),
  };

  return { ...elements, default: elements.Svg };
});

// `expo` is the native runtime. Its entry evaluates the Expo runtime, which
// reads `__DEV__` and registers native modules no Node test has, and its module
// lookups answer for a binary: an optional module is absent, a required one
// throws. Those are the answers a test project has, and the app already reads
// them that way (`requireOptionalNativeModule` behind a null check).
// `reloadAppAsync` is the other export the app reads: it restarts the app after
// a language change, which the test worker has nothing to restart.
vi.mock('expo', () => ({
  reloadAppAsync: () => Promise.resolve(),
  requireOptionalNativeModule: () => null,
  requireNativeModule: (name: string) => {
    throw new Error(`Cannot find native module '${name}'`);
  },
}));

// Haptics are decoration, and the app's wrapper already settles a rejected
// call; the stub resolves like a device with a haptic engine. The enums keep
// the library's values so a caller's argument is the same one it sends on a
// device. A suite that records haptics mocks this module itself and wins.
vi.mock('expo-haptics', () => ({
  selectionAsync: () => Promise.resolve(),
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  performAndroidHapticsAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
    Heavy: 'heavy',
    Soft: 'soft',
    Rigid: 'rigid',
  },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {
    Confirm: 'confirm',
    Reject: 'reject',
    Gesture_Start: 'gesture-start',
    Gesture_End: 'gesture-end',
    Toggle_On: 'toggle-on',
    Toggle_Off: 'toggle-off',
    Clock_Tick: 'clock-tick',
    Context_Click: 'context-click',
    Drag_Start: 'drag-start',
    Keyboard_Tap: 'keyboard-tap',
    Keyboard_Press: 'keyboard-press',
    Keyboard_Release: 'keyboard-release',
    Long_Press: 'long-press',
    Virtual_Key: 'virtual-key',
    Virtual_Key_Release: 'virtual-key-release',
    No_Haptics: 'no-haptics',
    Segment_Tick: 'segment-tick',
    Segment_Frequent_Tick: 'segment-frequent-tick',
    Text_Handle_Move: 'text-handle-move',
  },
}));

// The reduced-motion policy reads the battery so low power mode can switch the
// app's motion off. A test has no battery sensor, so the readings are the ones
// the library reports when the device cannot provide them: level `-1` and an
// unknown state, which the policy does not read as low power. A suite that
// drives a battery reading mocks this module itself and wins.
vi.mock('expo-battery', () => {
  const BatteryState = {
    UNKNOWN: 0,
    UNPLUGGED: 1,
    CHARGING: 2,
    FULL: 3,
    NOT_CHARGING: 4,
  } as const;
  const powerState = () => ({
    batteryLevel: -1,
    batteryState: BatteryState.UNKNOWN,
    lowPowerMode: false,
  });

  return {
    BatteryState,
    isAvailableAsync: () => Promise.resolve(false),
    getBatteryLevelAsync: () => Promise.resolve(-1),
    getBatteryStateAsync: () => Promise.resolve(BatteryState.UNKNOWN),
    isLowPowerModeEnabledAsync: () => Promise.resolve(false),
    isBatteryOptimizationEnabledAsync: () => Promise.resolve(false),
    getPowerStateAsync: () => Promise.resolve(powerState()),
    addBatteryLevelListener: () => ({ remove: () => undefined }),
    addBatteryStateListener: () => ({ remove: () => undefined }),
    addLowPowerModeListener: () => ({ remove: () => undefined }),
    useBatteryLevel: () => -1,
    useBatteryState: () => BatteryState.UNKNOWN,
    useLowPowerMode: () => false,
    usePowerState: () => powerState(),
  };
});

// `react-native-safe-area-context` is a native view library: its commonjs
// entry reads `react-native`'s Flow source and registers native views at import
// time. A test has no window edges, so every inset is zero and the frame is the
// viewport the other native stubs report (400x800). A suite that needs another
// inset mocks this module itself and wins.
vi.mock('react-native-safe-area-context', async () => {
  const React = await import('react');

  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 400, height: 800 };

  function wrapper(name: string) {
    return function Stub({ children, ...props }: { children?: ReactNode }) {
      return React.createElement(name, props, children);
    };
  }

  return {
    SafeAreaProvider: wrapper('SafeAreaProvider'),
    SafeAreaView: wrapper('SafeAreaView'),
    SafeAreaInsetsContext: React.createContext(insets),
    SafeAreaFrameContext: React.createContext(frame),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});

// `react-native-reanimated` is a native animation runtime: its entry reaches a
// worklets native module that no Node test has. Here an animation settles
// instantly — every `with*` helper answers its target value — and an animated
// style is read once, so the tree renders at the end state the app's static
// geometry describes. Animated hosts render the React Native host names the
// suites query. A suite that asserts real animation steps mocks this module and
// wins over this one.
vi.mock('react-native-reanimated', async () => {
  const React = await import('react');

  function animatedHost(name: string) {
    return React.forwardRef<unknown, { children?: ReactNode }>(({ children, ...props }, _ref) =>
      React.createElement(name, props, children)
    );
  }

  function sharedValue<T>(initial: T) {
    let current = initial;
    return {
      get value(): T {
        return current;
      },
      set value(next: T) {
        current = next;
      },
      get: () => current,
      set: (next: T) => {
        current = next;
      },
      addListener: () => 0,
      removeListener: () => undefined,
      modify: (updater: (value: T) => T) => {
        current = updater(current);
      },
    };
  }

  const easing = {
    linear: (t: number) => t,
    ease: (t: number) => t,
    quad: (t: number) => t,
    cubic: (t: number) => t,
    in: (fn: (t: number) => number) => fn,
    out: (fn: (t: number) => number) => fn,
    inOut: (fn: (t: number) => number) => fn,
    bezier: () => (t: number) => t,
  };

  const Extrapolation = { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' };
  const ReduceMotion = { System: 'system', Always: 'always', Never: 'never' };

  /** A layout or entrance animation description; a host ignores it. */
  const layoutAnimation = () => {
    const animation: Record<string, unknown> = {};
    for (const builder of ['duration', 'delay', 'easing', 'springify', 'withInitialValues']) {
      animation[builder] = () => animation;
    }
    return animation;
  };

  // eslint-disable-next-line max-params -- mirrors reanimated's interpolate(value, inputRange, outputRange, options)
  const interpolate = (
    value: number,
    input: readonly number[],
    output: readonly number[],
    extrapolate: string = Extrapolation.EXTEND
  ) => {
    let position = 0;
    while (position < input.length - 2 && value > (input[position + 1] ?? 0)) {
      position += 1;
    }
    const inFrom = input[position] ?? 0;
    const inTo = input[position + 1] ?? inFrom;
    const outFrom = output[position] ?? 0;
    const outTo = output[position + 1] ?? outFrom;
    const progress = inTo === inFrom ? 0 : (value - inFrom) / (inTo - inFrom);
    const bounded =
      extrapolate === Extrapolation.CLAMP ? Math.min(Math.max(progress, 0), 1) : progress;
    return outFrom + bounded * (outTo - outFrom);
  };

  const Animated = {
    View: animatedHost('View'),
    Text: animatedHost('Text'),
    ScrollView: animatedHost('ScrollView'),
    Image: animatedHost('Image'),
    Pressable: animatedHost('Pressable'),
    FlatList: animatedHost('FlatList'),
    createAnimatedComponent: (component: unknown) => component,
  };

  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    FadeIn: layoutAnimation(),
    FadeOut: layoutAnimation(),
    LinearTransition: layoutAnimation(),
    cancelAnimation: () => undefined,
    createAnimatedComponent: Animated.createAnimatedComponent,
    Easing: easing,
    Extrapolation,
    interpolate,
    makeMutable: sharedValue,
    ReduceMotion,
    ReducedMotionConfig: animatedHost('ReducedMotionConfig'),
    useAnimatedRef: () => React.useRef(null),
    useAnimatedStyle: <T>(factory: () => T) => factory(),
    useFrameCallback: () => ({
      setActive: () => undefined,
      isActive: false,
      callbackId: 0,
    }),
    useReducedMotion: () => false,
    useSharedValue: sharedValue,
    withDelay: <T>(_delay: number, animation: T) => animation,
    withRepeat: <T>(animation: T) => animation,
    withSequence: <T>(...animations: T[]) => animations.at(-1),
    withSpring: <T>(toValue: T) => toValue,
    withTiming: <T>(toValue: T) => toValue,
  };
});

// `@rn-primitives/slot@1.5.2` is the `asChild` bridge `Text` renders through;
// like `@rn-primitives/dialog` below it ships untranspiled JSX in `dist/*.mjs`,
// which no Node-side test transformer parses. The real Slot hands its props to
// its single child element, so this stub clones that child with the merged
// props and composes the handlers: a `Text asChild` around a `Pressable` still
// renders the `Pressable`, which is the element a suite queries.
vi.mock('@rn-primitives/slot', async () => {
  const React = await import('react');

  type SlotProps = Record<string, unknown> & { children?: ReactNode };
  type Handler = (...args: unknown[]) => void;

  function mergeProps(slotProps: SlotProps, childProps: SlotProps): SlotProps {
    const merged: SlotProps = { ...slotProps, ...childProps };
    for (const key of Object.keys(slotProps)) {
      if (key.startsWith('on') && key in childProps) {
        const slotHandler = slotProps[key] as Handler | undefined;
        const childHandler = childProps[key] as Handler | undefined;
        merged[key] = (...args: unknown[]) => {
          slotHandler?.(...args);
          childHandler?.(...args);
        };
      }
    }
    return merged;
  }

  function Slot({ children, ...props }: SlotProps) {
    if (!React.isValidElement<SlotProps>(children)) {
      return children === undefined || children === null
        ? null
        : React.createElement('Slot', props, children);
    }
    return React.cloneElement(children, mergeProps(props, children.props as SlotProps));
  }

  return { Text: Slot, View: Slot, Pressable: Slot, Image: Slot, Slottable: Slot };
});

// `@rn-primitives/dialog@1.5.2` ships untranspiled JSX inside `dist/*.mjs` and
// `dist/*.js`, and its ESM entry re-exports `./dialog` with no extension.
// Metro's Babel transform parses both for the app; no Node-side test transformer
// does, so the real module cannot be imported at all here.
//
// This stub keeps the primitive's contract so the app's own dialog stays under
// test: `Portal` renders only while `Root` is open, `Close` closes the dialog
// and then runs the caller's handler, and both support `asChild`. A test that
// wants to assert the app's dialog renders `@/components/ui/dialog`, not this
// module.
vi.mock('@rn-primitives/dialog', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // cannot be a static import here — it is not initialised when the factory
  // runs.
  const React = await import('react');

  type RootValue = { open: boolean; onOpenChange: (open: boolean) => void };
  type StubProps = {
    children?: ReactNode;
    asChild?: boolean;
    onPress?: () => void;
    [key: string]: unknown;
  };

  const RootContext = React.createContext<RootValue | null>(null);

  function useRoot(): RootValue {
    const value = React.useContext(RootContext);
    if (value === null) {
      throw new Error('the dialog stub was rendered outside its Root');
    }
    return value;
  }

  function Root({
    open = false,
    onOpenChange,
    children,
  }: StubProps & { open?: boolean; onOpenChange?: (open: boolean) => void }) {
    const value = React.useMemo(
      () => ({ open, onOpenChange: onOpenChange ?? (() => undefined) }),
      [open, onOpenChange]
    );
    return React.createElement(RootContext.Provider, { value }, children);
  }

  function Portal({ children }: StubProps) {
    return useRoot().open ? React.createElement(React.Fragment, null, children) : null;
  }

  function passThrough(host: string) {
    return function Stub({ children, ...props }: StubProps) {
      return React.createElement(host, props, children);
    };
  }

  function closing(host: string) {
    return function Stub({ asChild, onPress, children, ...props }: StubProps) {
      const { onOpenChange } = useRoot();
      const handlePress = () => {
        onOpenChange(false);
        onPress?.();
      };
      if (asChild && React.isValidElement<StubProps>(children)) {
        return React.cloneElement(children, { onPress: handlePress });
      }
      return React.createElement(host, { ...props, onPress: handlePress }, children);
    };
  }

  function Trigger({ asChild, onPress, children, ...props }: StubProps) {
    const { open, onOpenChange } = useRoot();
    const handlePress = () => {
      onOpenChange(!open);
      onPress?.();
    };
    if (asChild && React.isValidElement<StubProps>(children)) {
      return React.cloneElement(children, { onPress: handlePress });
    }
    return React.createElement('DialogTrigger', { ...props, onPress: handlePress }, children);
  }

  return {
    Close: closing('DialogClose'),
    Content: passThrough('DialogContent'),
    Description: passThrough('DialogDescription'),
    Overlay: passThrough('DialogOverlay'),
    Portal,
    Root,
    Title: passThrough('DialogTitle'),
    Trigger,
    useRootContext: useRoot,
  };
});
