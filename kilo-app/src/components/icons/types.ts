import type React from 'react';

export type BrandIconProps = Readonly<{
  size?: number;
  color?: string;
}>;

export type BrandIconComponent = React.ComponentType<BrandIconProps>;
