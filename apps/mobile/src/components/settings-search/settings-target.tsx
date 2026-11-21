import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  type Ref,
  type RefObject,
  type ScrollViewInstance,
  View,
  type ViewInstance,
} from 'react-native';

import { TabScreenScrollView } from '@/components/tab-screen';
import { type SettingDefinition } from '@/lib/settings-search/definitions';

/** The gap a revealed row keeps above the scroll viewport's top edge. */
const REVEAL_TOP_GAP = 12;

type SettingsTargetContextValue = {
  /** The route's target id, as forwarded by the destination screen. */
  readonly target: string | undefined;
  /** Scroll the row into view once; later calls for the same target are ignored. */
  readonly reveal: (ids: readonly string[], node: ViewInstance) => void;
};

const SettingsTargetContext = createContext<SettingsTargetContextValue | null>(null);

type SettingsSearchTargetScopeProps = {
  settingsTarget?: string;
  /** The scrolling ancestor a target is measured and revealed inside. */
  scrollRef: RefObject<ScrollViewInstance | null>;
  children: ReactNode;
};

/**
 * Supplies the target context a set of settings rows reveals against, without
 * touching layout: it renders only the provider, so a caller that already owns
 * a scrolling surface (the consent card's raw `ScrollView`) keeps its exact
 * geometry. Pass the scroll view's own ref here and to the scroll view.
 */
export function SettingsSearchTargetScope({
  settingsTarget,
  scrollRef,
  children,
}: Readonly<SettingsSearchTargetScopeProps>) {
  // The target a reveal was already performed for. Claiming it before the
  // measurement keeps a row that lays out repeatedly from scrolling the screen
  // again; the claim names its target, so a new target reveals independently.
  const revealedRef = useRef<string | null>(null);
  // The latest target and mounted state, read when an asynchronous measurement
  // lands: an old measurement must never scroll after a target change or after
  // the screen is gone.
  const targetRef = useRef(settingsTarget);
  targetRef.current = settingsTarget;
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );
  useEffect(() => {
    // Release only a claim left by a previous target. A layout may already have
    // claimed the current target before this effect runs; that claim must stay.
    if (revealedRef.current !== settingsTarget) {
      revealedRef.current = null;
    }
  }, [settingsTarget]);

  const reveal = useCallback(
    (ids: readonly string[], node: ViewInstance) => {
      const target = settingsTarget;
      if (target === undefined || !ids.includes(target) || revealedRef.current === target) {
        return;
      }
      const scroll = scrollRef.current;
      if (scroll === null) {
        return;
      }
      // Measure against the scroll view's content view, so the offset is in the
      // coordinate space `scrollTo` takes and never depends on the window.
      const content = scroll.getInnerViewRef() ?? scroll.getInnerViewNode();
      if (content == null) {
        return;
      }
      revealedRef.current = target;
      node.measureLayout(
        content,
        (_left, top) => {
          if (!mountedRef.current || targetRef.current !== target) {
            return;
          }
          scroll.scrollTo({ y: Math.max(0, top - REVEAL_TOP_GAP), animated: true });
        },
        () => {
          // Release only our own claim; a newer target may have claimed already.
          if (revealedRef.current === target) {
            revealedRef.current = null;
          }
        }
      );
    },
    [scrollRef, settingsTarget]
  );

  const value = useMemo<SettingsTargetContextValue>(
    () => ({ target: settingsTarget, reveal }),
    [settingsTarget, reveal]
  );

  return <SettingsTargetContext.Provider value={value}>{children}</SettingsTargetContext.Provider>;
}

type SettingsSearchScrollViewProps = ComponentProps<typeof TabScreenScrollView> & {
  settingsTarget?: string;
  ref?: Ref<ScrollViewInstance>;
};

/**
 * A settings screen's scrolling body that can reveal one routed target row.
 * Every `TabScreenScrollView` prop — including its IME reveal callback — and the
 * forwarded scroll ref pass through; the only addition is `settingsTarget`.
 */
export function SettingsSearchScrollView({
  settingsTarget,
  ref,
  children,
  ...props
}: Readonly<SettingsSearchScrollViewProps>) {
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  // The wrapper's own scroll ref, so the scope can measure even when the caller
  // passes none, and the caller's ref still receives the same instance.
  useImperativeHandle<ScrollViewInstance | null, ScrollViewInstance | null>(
    ref,
    () => scrollRef.current,
    []
  );
  return (
    <SettingsSearchTargetScope settingsTarget={settingsTarget} scrollRef={scrollRef}>
      <TabScreenScrollView {...props} ref={scrollRef}>
        {children}
      </TabScreenScrollView>
    </SettingsSearchTargetScope>
  );
}

type SettingsTargetProps = {
  item: SettingDefinition;
  /**
   * Other ids the same rendered row answers to — a segmented control whose
   * options are separate definitions. `item.id` always matches as well.
   */
  targetIds?: readonly string[];
  children: ReactNode;
};

/**
 * Marks the rendered row a routed target reveals. Without an active match it
 * returns the row untouched; with one it keeps the row's own element, role and
 * geometry, and draws a stationary highlight over it once it is on screen.
 */
export function SettingsTarget({ item, targetIds, children }: Readonly<SettingsTargetProps>) {
  const context = useContext(SettingsTargetContext);
  const nodeRef = useRef<ViewInstance | null>(null);
  const active =
    context !== null &&
    context.target !== undefined &&
    (context.target === item.id || targetIds?.includes(context.target) === true);

  // The row's layout is the reveal trigger: the frame is known by then, so the
  // measurement never lands on a zero-sized first pass.
  const reveal = () => {
    const node = nodeRef.current;
    if (!active || context === null || node === null) {
      return;
    }
    context.reveal([item.id, ...(targetIds ?? [])], node);
  };

  if (!active) {
    return children;
  }
  return (
    <View ref={nodeRef} collapsable={false} onLayout={reveal} className="relative">
      {children}
      <View pointerEvents="none" className="absolute inset-0 rounded-xl border-2 border-primary" />
    </View>
  );
}
