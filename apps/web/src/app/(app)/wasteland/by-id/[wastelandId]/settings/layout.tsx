/**
 * Settings-specific layout override.
 *
 * The parent `wasteland/[wastelandId]/layout.tsx` wraps children in
 * `flex-1 overflow-hidden` so pages like Wanted/Members/Rigs can render
 * internal scroll regions (split-pane, fixed toolbars). Settings is a
 * simple scrolling form page, so we escape that container by absolutely
 * filling it and declaring ourselves the scroll viewport. The sticky
 * header and scrollspy sidebar inside the settings client then pin to
 * this container, matching the gastown settings pattern (which uses
 * the window as its scroll viewport).
 *
 * `relative` + `h-full` here give the absolutely-positioned child a
 * bounded positioning context without affecting any other sibling route.
 * The `id` here is the scroll root targeted by `useScrollSpy` — exposed
 * so `IntersectionObserver` and programmatic `scrollTo` can find it.
 */
export default function WastelandSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-full">
      <div id="wasteland-settings-scroll-root" className="absolute inset-0 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
