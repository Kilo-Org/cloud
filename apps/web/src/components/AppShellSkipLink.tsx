export function AppShellSkipLink() {
  return (
    <a
      href="#main-content"
      className="bg-primary text-primary-foreground ring-ring/50 fixed top-4 left-4 z-50 -translate-y-20 rounded-md px-3.5 py-2 text-sm font-medium opacity-0 transition focus:translate-y-0 focus:ring-[3px] focus:outline-none focus:opacity-100"
    >
      Skip to main content
    </a>
  );
}
