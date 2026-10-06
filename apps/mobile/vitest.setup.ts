import { vi } from 'vitest';

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

// `react-native-keyboard-controller` is a native module. Tests assert the app's
// keyboard surfaces through host elements, so the provider and the views are
// plain hosts and the keyboard read reports a hidden keyboard. `useKeyboardState`
// honors its selector, as the real hook does: a reader that asks for
// `state.height` must receive the number, not the whole state object. A test
// that needs a lift mocks the hook itself with a driveable store.
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: 'KeyboardProvider',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  KeyboardChatScrollView: 'KeyboardChatScrollView',
  useKeyboardState: (selector?: (state: KeyboardStateSnapshot) => unknown) => {
    const snapshot: KeyboardStateSnapshot = {
      height: 0,
      isVisible: false,
      progress: 0,
      duration: 0,
    };
    return selector ? selector(snapshot) : snapshot;
  },
}));

// `react-native-enriched-markdown` and `react-native-webview` are native views.
// Tests assert the markdown and diagram elements through their host props
// (`markdown`, `onLinkPress`, `source`, …).
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: 'EnrichedMarkdownText' }));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));

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
import type { ReactNode } from 'react';

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
