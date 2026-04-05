import Svg, { Circle, Path } from 'react-native-svg';

import { type BrandIconProps } from './types';

export function OnePasswordIcon({ size = 20 }: BrandIconProps) {
  return (
    <Svg viewBox="0 0 1024 1024" width={size} height={size}>
      <Circle cx="512" cy="512" r="512" fill="#198CFF" />
      <Circle cx="512" cy="512" r="264" fill="#F2F2F2" />
      <Path
        d="M468 320h88a20 20 0 0120 20v180.7a20.3 20.3 0 01-4.7 12.9l-10.5 12.5a20 20 0 000 25.8l10.5 12.5a20.3 20.3 0 014.7 12.9V684a20 20 0 01-20 20h-88a20 20 0 01-20-20V503.3a20.3 20.3 0 014.7-12.9l10.5-12.5a20 20 0 000-25.8l-10.5-12.5a20.3 20.3 0 01-4.7-12.9V340a20 20 0 0120-20z"
        fill="#0A2B4C"
      />
    </Svg>
  );
}
