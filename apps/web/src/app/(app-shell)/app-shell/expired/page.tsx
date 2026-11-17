import { ShellOutcome } from '../components/shell-outcome';

export const metadata = {
  title: 'Return to the Kilo App',
  robots: { index: false, follow: false },
};

/**
 * A hand-off that cannot be opened. The URL that got here carries no usable
 * credential, so there is nothing to sign in to and nowhere to go but back.
 */
export default function AppShellExpiredPage() {
  return (
    <ShellOutcome
      kind="failure"
      title="Start again from the Kilo App"
      description="This link has expired or was already used. Close this window and start the step again from the Kilo App."
    />
  );
}
