import { type SwitchProps } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The switch a profile form row carries.
 *
 * Both halves of the track come from the palette, and both must be named here:
 * a `trackColor` object replaces the shared `Switch`'s pair outright, so naming
 * only the off half left the on half to the platform accent — a teal that
 * belongs to no palette entry, which on the dark card sat behind the dark on
 * grip and read as off. The on track is the scheme's `primary` (olive in light,
 * the brand yellow in dark) and its grip is `primaryForeground`, the pair the
 * shared switch draws. The off track takes `switchTrack`, because the platform's
 * own off track is within 1.1:1 of the row in both themes and left one floating
 * thumb instead of a control; the shared switch picks the off grip.
 */
export function ProfileSwitch(props: SwitchProps) {
  const colors = useThemeColors();
  return <Switch {...props} trackColor={{ false: colors.switchTrack, true: colors.primary }} />;
}
