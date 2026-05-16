/**
 * Settings-specific layout override for the owner/repo tree.
 *
 * The parent `wasteland/[owner]/[repo]/layout.tsx` wraps children in
 * `flex-1 overflow-hidden` so split-pane / sticky-toolbar pages can
 * manage their own scroll. Settings is a long, vertically-scrolling
 * form page, so we escape that container by absolutely filling it and
 * declaring ourselves the scroll viewport. The scrollspy nav inside
 * the settings client pins to this container via the `id` below —
 * `IntersectionObserver` and programmatic `scrollTo` find it through
 * `useScrollSpy({ scrollRootId })`.
 */
export default function WastelandRepoSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-full">
      <div id="wasteland-repo-settings-scroll-root" className="absolute inset-0 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
