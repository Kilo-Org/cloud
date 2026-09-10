import { RefreshControl as NativeRefreshControl, type RefreshControlProps } from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';

export function RefreshControl({ refreshing, ...props }: Readonly<RefreshControlProps>) {
  const { reducedMotion } = useMotionPolicy();

  return <NativeRefreshControl {...props} refreshing={reducedMotion ? false : refreshing} />;
}
