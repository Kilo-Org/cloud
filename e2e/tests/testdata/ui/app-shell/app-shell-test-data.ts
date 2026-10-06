/** The two shells the accessibility spec covers: the signed-in app and the admin panel. */
export const appShellCases = [
  { shell: 'app', isAdmin: false, path: '/usage', landingPath: '/usage', currentNavItem: 'Usage' },
  // `/admin` redirects to its users list.
  { shell: 'admin', isAdmin: true, path: '/admin', landingPath: '/admin/users', currentNavItem: 'Users' },
];

export const appShellMessages = {
  skipLink: 'Skip to main content',
  toggleSidebar: 'Toggle sidebar',
};

export const appShellLayout = {
  /** WCAG minimum touch target. */
  touchTargetMinPx: 44,
  headerHeight: '56px',
  /** The id the skip link targets. */
  mainContentId: 'main-content',
};
