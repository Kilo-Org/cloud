import { ProfileScreen } from '@/components/profile-screen';
import { useTranslation } from 'react-i18next';

export default function ProfileRoute() {
  const { i18n } = useTranslation();
  // Remount the screen when the applied language changes. The language round
  // trip through an RTL language forces two native reloads, and a tab scene can
  // come back stale across one (frozen before the new language painted) until
  // the user leaves and re-enters the tab. `useTranslation` re-renders this
  // route on every applied language, and the key gives each scene a fresh
  // mount without waiting for a navigation edge.
  return <ProfileScreen key={i18n.language} />;
}
