import type { Metadata } from 'next';
import { ShellProviders } from './components/shell-providers';

export const metadata: Metadata = {
  title: 'Kilo App',
  robots: { index: false, follow: false },
};

/**
 * The app shell: the pages the native app opens in its in-app browser.
 *
 * It renders no sidebar, no topbar, no promo banner and no link out — the
 * whole point is that a page reached from the app cannot lead to a purchase
 * surface. Everything here lives under `/app-shell`, which is also the `Path`
 * of the shell session cookie, so the browser enforces the boundary.
 */
export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ShellProviders>
      <div className="bg-background text-foreground flex min-h-dvh flex-col">
        <header className="border-border border-b px-4 py-3">
          <p className="text-muted-foreground text-sm font-medium">Kilo App</p>
        </header>
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5">
          {children}
        </main>
      </div>
    </ShellProviders>
  );
}
