import { ShellOutcome } from '../components/shell-outcome';

export const metadata = {
  title: 'Return to the Kilo App',
  robots: { index: false, follow: false },
};

/**
 * A hand-off or shell session whose account the web session path refuses: a
 * blocked account or a blocklisted email domain. It is terminal like
 * `/app-shell/expired` — no retry, no sign-in, and no link out of the shell.
 */
export default function AppShellAccountUnavailablePage() {
  return (
    <ShellOutcome
      kind="failure"
      title="Account unavailable"
      description="This Kilo account cannot use the in-app browser. Close this window and contact support from the Kilo website."
    />
  );
}
