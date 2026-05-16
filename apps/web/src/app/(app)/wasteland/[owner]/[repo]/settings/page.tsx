import { SettingsClient } from './SettingsClient';

/**
 * Wasteland settings page (owner/repo tree). Auth and feature-flag gating
 * are enforced by the parent layout; the resolved `wastelandId` is
 * provided through `WastelandRepoProvider` and read inside the client.
 */
export default function WastelandRepoSettingsPage() {
  return <SettingsClient />;
}
