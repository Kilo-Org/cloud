import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
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
  /**
   * Register the row a target matched. The scope owns the measurement and the
   * scroll; the row only reports that its layout is known.
   */
  readonly reveal: (ids: readonly string[], node: ViewInstance) => void;
};

const SettingsTargetContext = createContext<SettingsTargetContextValue | null>(null);

/**
 * Which interaction owns the body on screen. A caller's `resetKey` bump replaces
 * the body, and only a selection — a change of `settingsTarget`/`revealKey` —
 * may reveal a row in the body that replaces it.
 */
type BodySwap = {
  readonly settingsTarget: string | undefined;
  readonly revealKey: number;
  readonly resetKey: number;
  /** This swap replaced the body without a selection, so no row may reveal. */
  readonly suppressed: boolean;
  /** This swap moved `resetKey` itself, so it also owns the instant reset. */
  readonly resetPending: boolean;
};

type SettingsSearchTargetScopeProps = {
  settingsTarget?: string;
  /** The scrolling ancestor a target is measured and revealed inside. */
  scrollRef: RefObject<ScrollViewInstance | null>;
  /**
   * Bumped when the same target is selected again. A bare id cannot tell a
   * second selection from the first, so the row would otherwise stay wherever
   * the previous reveal left it.
   */
  revealKey?: number;
  /**
   * The scroller's committed content height, when it reports one. The results
   * body is replaced by the full settings body in the same commit that mounts
   * the target row, so a scroll dispatched before the taller body's size exists
   * is clamped against the shorter body and lost on Android. Every committed
   * change re-measures the armed row.
   */
  contentHeight?: number;
  /**
   * The scroller's committed viewport height. The IME's occlusion changes it
   * around the selection, and a scroll that landed against the previous frame
   * is repeated against the settled one.
   */
  frameHeight?: number;
  /**
   * A body swap counter, as the caller's `SettingsSearchScrollView` receives
   * it. This scope owns the swap: it drops the reveal the replaced body armed,
   * suppresses layout-driven reveals for the body the caller just replaced, and
   * returns the scroller to its first row.
   */
  resetKey?: number;
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
  revealKey = 0,
  contentHeight,
  frameHeight,
  resetKey = 0,
  children,
}: Readonly<SettingsSearchTargetScopeProps>) {
  // One owner per body swap. The scroller is one native view for whichever body
  // the caller renders, so a `resetKey` bump says the caller replaced the whole
  // body and the offset belongs to a body that is gone. The reveal the outgoing
  // body armed belongs to the interaction that just ended too: left armed, the
  // replacement's row lays out in the same commit, re-arms, and animates the
  // scroller that the swap had just returned to its first row. Measured on the
  // Profile tab, that parked the credits card 328 px above the viewport with
  // `Add credits` unreachable.
  //
  // The swap is decided here, during render, rather than in an effect: the
  // replacement must render the stale row inactive in its very first commit, so
  // its `onLayout` never reaches `reveal` and the geometry pass has nothing
  // armed to re-fire. Ordering alone settles it — no timer, no debounce and no
  // second scroll path behind the reset. A selection is the one reveal the
  // person asked for: a change of `settingsTarget`/`revealKey` clears the
  // suppression before the row it selects lays out, so that swap still
  // highlights and animates.
  const [bodySwap, setBodySwap] = useState<BodySwap>(() => ({
    settingsTarget,
    revealKey,
    resetKey,
    suppressed: false,
    resetPending: false,
  }));
  let swap = bodySwap;
  if (
    swap.settingsTarget !== settingsTarget ||
    swap.revealKey !== revealKey ||
    swap.resetKey !== resetKey
  ) {
    // Only a target the person chose is a selection: a dropped target (the
    // search ended without one) removes the highlight, it never reveals a row.
    const selection =
      settingsTarget !== undefined &&
      (swap.settingsTarget !== settingsTarget || swap.revealKey !== revealKey);
    swap = {
      settingsTarget,
      revealKey,
      resetKey,
      suppressed: !selection,
      // A caller that moves `resetKey` replaced the whole body; only that, and
      // only when no selection owns the transition, resets the offset.
      resetPending: !selection && swap.resetKey !== resetKey,
    };
    // React's own way to adjust state from props: this render restarts with the
    // decided swap, so nothing reaches layout from the superseded pass.
    setBodySwap(swap);
  }
  // The target the rows render against: a body the caller replaced shows no
  // highlight until a selection asks for one.
  const effectiveTarget = swap.suppressed ? undefined : settingsTarget;
  // The latest target and mounted state, read when an asynchronous measurement
  // lands: an old measurement must never scroll after a target change or after
  // the screen is gone. StrictMode runs the effect twice, so the body re-arms
  // the flag its simulated cleanup cleared.
  const targetRef = useRef(effectiveTarget);
  targetRef.current = effectiveTarget;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The row that most recently reported layout for the active target. A row
  // that lays out repeatedly must not scroll the screen back to it; a new
  // selection, a new target or a committed geometry change drives the next
  // attempt instead.
  const armedRef = useRef<{ target: string; node: ViewInstance } | null>(null);
  // The attempt a measurement belongs to: an older measurement that lands after
  // a newer attempt (a replaced body, a settled frame) publishes nothing.
  const attemptRef = useRef(0);
  // The last reveal that was dispatched and the range the scroller had then.
  // Geometry changes repeat the reveal only when the row moved or the previous
  // dispatch was clamped by a shorter body or wider viewport; a keyboard that
  // merely re-opens later must not pull the screen back to a row the person has
  // already left.
  const landedRef = useRef<{
    target: string;
    top: number;
    requested: number;
    maxOffset: number | undefined;
  } | null>(null);
  // The committed geometry the reveal decides against, read inside the callback
  // so a content-size report does not rebuild the context value and re-render
  // every settings row.
  const geometryRef = useRef({ contentHeight, frameHeight });

  const revealArmed = useCallback(
    (force: boolean) => {
      const target = targetRef.current;
      const armed = armedRef.current;
      if (target === undefined || armed === null || armed.target !== target) {
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
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      armed.node.measureLayout(
        content,
        (_left, top) => {
          if (
            attempt !== attemptRef.current ||
            !mountedRef.current ||
            targetRef.current !== target
          ) {
            return;
          }
          const requested = Math.max(0, top - REVEAL_TOP_GAP);
          const committed = geometryRef.current;
          const maxOffset =
            committed.contentHeight === undefined || committed.frameHeight === undefined
              ? undefined
              : Math.max(0, committed.contentHeight - committed.frameHeight);
          const landed = landedRef.current;
          const clamped = landed?.maxOffset !== undefined && landed.requested > landed.maxOffset;
          const settled =
            !force &&
            landed?.maxOffset !== undefined &&
            landed.target === target &&
            landed.top === top &&
            !clamped;
          if (settled) {
            return;
          }
          scroll.scrollTo({ y: requested, animated: true });
          landedRef.current = { target, top, requested, maxOffset };
        },
        () => {
          // The row may not be attached to the measured content while the body
          // is replaced; the next committed content or frame change retries.
        }
      );
    },
    [scrollRef]
  );

  const reveal = useCallback(
    (ids: readonly string[], node: ViewInstance) => {
      const target = targetRef.current;
      if (target === undefined || !ids.includes(target)) {
        return;
      }
      const armed = armedRef.current;
      if (armed?.target === target && armed.node === node) {
        return;
      }
      armedRef.current = { target, node };
      revealArmed(true);
    },
    [revealArmed]
  );

  // One effect decides a swap: it drops the row the outgoing body armed (so the
  // geometry triggers below have nothing to re-fire), leaves the replacement's
  // layout inactive — `effectiveTarget` already rendered it so — and returns the
  // scroller to its first row. A selection's swap is exempt: its reveal is the
  // destination the person asked for.
  const appliedSwapRef = useRef(swap);
  useEffect(() => {
    if (appliedSwapRef.current === swap) {
      return;
    }
    appliedSwapRef.current = swap;
    if (!swap.suppressed) {
      return;
    }
    armedRef.current = null;
    attemptRef.current += 1;
    if (swap.resetPending) {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  }, [swap, scrollRef]);

  // `onContentSizeChange` is the scroller's post-layout report: the taller body
  // that contains the row exists by the time it fires, so re-measuring here is
  // what turns the Android clamp into the intended offset. The viewport frame
  // is the second trigger: the IME settles after the selection, and the reveal
  // must follow the frame it finally has.
  useEffect(() => {
    const previous = geometryRef.current;
    if (previous.contentHeight === contentHeight && previous.frameHeight === frameHeight) {
      return;
    }
    geometryRef.current = { contentHeight, frameHeight };
    revealArmed(false);
  }, [contentHeight, frameHeight, revealArmed]);

  // A repeated selection of the same result keeps the target id, so the row
  // never re-lays out; the bumped key asks the scope to reveal it again. Only a
  // target the rows actually render against is a selection: a suppressed swap
  // leaves nothing armed and nothing to reveal.
  const selectionRef = useRef({ target: effectiveTarget, revealKey });
  useEffect(() => {
    const previous = selectionRef.current;
    if (previous.target === effectiveTarget && previous.revealKey === revealKey) {
      return;
    }
    selectionRef.current = { target: effectiveTarget, revealKey };
    revealArmed(true);
  }, [effectiveTarget, revealKey, revealArmed]);

  const value = useMemo<SettingsTargetContextValue>(
    () => ({ target: effectiveTarget, reveal }),
    [effectiveTarget, reveal]
  );

  return <SettingsTargetContext.Provider value={value}>{children}</SettingsTargetContext.Provider>;
}

type SettingsSearchScrollViewProps = ComponentProps<typeof TabScreenScrollView> & {
  settingsTarget?: string;
  revealKey?: number;
  /**
   * A body swap counter. The scroller is one native view for whichever body the
   * caller renders, so its scroll offset survives a body the person scrolled
   * while a different body was in place. A caller that replaces the whole body
   * (Profile swaps its settings list for the search results and back) bumps this
   * when the replacing body is not the destination of a reveal; the scope then
   * returns the scroller to its start, so the new body never opens scrolled past
   * its own first row, and the replaced body's stale row renders inactive so its
   * layout cannot animate the scroller back. A reveal owns its transition
   * instead: it bumps `revealKey`, so a selection neither moves the scroller nor
   * is moved by it.
   */
  resetKey?: number;
  ref?: Ref<ScrollViewInstance>;
};

/**
 * A settings screen's scrolling body that can reveal one routed target row.
 * Every `TabScreenScrollView` prop — including its IME reveal callback — and the
 * forwarded scroll ref pass through; the additions are `settingsTarget`, the
 * `revealKey` that repeats a reveal for the same target, and the `resetKey` that
 * returns a replaced body to its first row.
 */
export function SettingsSearchScrollView({
  settingsTarget,
  revealKey,
  resetKey,
  ref,
  children,
  onContentSizeChange,
  onLayout,
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
  // The committed geometry the reveal re-measures against. Both are reports
  // the native scroller emits after the body and frame have laid out, so the
  // scope keeps one reveal owner instead of a second scroll path.
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const [frameHeight, setFrameHeight] = useState<number | undefined>(undefined);
  const handleContentSizeChange = useCallback(
    (width: number, height: number) => {
      setContentHeight(current => (current === height ? current : height));
      onContentSizeChange?.(width, height);
    },
    [onContentSizeChange]
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      setFrameHeight(current => (current === height ? current : height));
      onLayout?.(event);
    },
    [onLayout]
  );
  return (
    <SettingsSearchTargetScope
      settingsTarget={settingsTarget}
      revealKey={revealKey}
      resetKey={resetKey}
      scrollRef={scrollRef}
      contentHeight={contentHeight}
      frameHeight={frameHeight}
    >
      <TabScreenScrollView
        {...props}
        ref={scrollRef}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
      >
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
  const target = context?.target;
  const active =
    target !== undefined && (target === item.id || targetIds?.includes(target) === true);

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
