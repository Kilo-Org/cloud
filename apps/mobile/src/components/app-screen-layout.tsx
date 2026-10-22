import { type ReactElement, useEffect, useState } from 'react';
import { View } from 'react-native';

import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';

/**
 * Hides every covered `(app)` stack scene from screen readers.
 *
 * The native Stack keeps all covered scenes mounted: a formSheet (the
 * folder/model/repo/instance pickers, share-gate, the todos sheets) or a
 * pushed screen renders on top while the screen underneath stays in the view
 * hierarchy. Its controls stay in the accessibility tree, so a screen reader
 * reaches — and a full snapshot reads out — buttons behind the sheet before
 * any sheet content (explorer finding: the covered new-session screen read
 * before the folder picker). A wrapper keyed on the scene's own focus state
 * hides the whole covered subtree with the app's established presentation:
 * `accessibilityElementsHidden` on iOS,
 * `importantForAccessibility='no-hide-descendants'` on Android, the same
 * pattern the unlock scene and the root redirect wrapper use.
 *
 * The gate tracks the layout's own `navigation` prop, not `useIsFocused`:
 * the screen layout renders outside the route's `NavigationProvider`, so the
 * context-based hook sees the parent navigator's focus and never flips. The
 * per-route navigation object reports the scene's real position in the stack;
 * its focus/blur events fire on push, pop, and sheet dismissal. Exactly one
 * scene — the one a sighted user sees — stays exposed.
 */
function CoveredScreenA11yGate({
  navigation,
  children,
}: {
  navigation: ScreenLayoutProps['navigation'];
  children: ReactElement;
}) {
  const [focused, setFocused] = useState(() => navigation.isFocused());
  useEffect(() => {
    const sync = () => {
      setFocused(navigation.isFocused());
    };
    sync();
    const unsubscribeFocus = navigation.addListener('focus', sync);
    const unsubscribeBlur = navigation.addListener('blur', sync);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);
  return (
    <View
      className="flex-1"
      // Keep the native view: Android collapses Views whose only props are
      // styles, and a collapsed view drops its accessibility props, so the
      // hiding would silently no-op. The sheet header uses the same escape.
      collapsable={false}
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </View>
  );
}

/**
 * The gate on its own, for a nested Stack whose scene already sits inside the
 * root `(app)` scene: the tab and section stacks push sibling routes over each
 * other in exactly the same way, and their scenes must leave the accessibility
 * tree when covered. The unlock surface belongs to the root scene only, so
 * these stacks must not wrap a second `NativeStateSurface` around theirs.
 */
export function appSceneLayout({ navigation, children }: ScreenLayoutProps): ReactElement {
  return <CoveredScreenA11yGate navigation={navigation}>{children}</CoveredScreenA11yGate>;
}

// The unlock surface stays the scene's layout (its NativeStateSurface hosts
// the unlock overlay above the scene content); the a11y gate wraps both.
export function appScreenLayout({ navigation, ...props }: ScreenLayoutProps): ReactElement {
  return (
    <CoveredScreenA11yGate navigation={navigation}>
      {appUnlockScreenLayout({ navigation, ...props })}
    </CoveredScreenA11yGate>
  );
}
