'use client';

import { DotLottieReact } from '@lottiefiles/dotlottie-react';

type AnimatedKiloLogoProps = {
  loop?: boolean;
};

export default function AnimatedKiloLogo({ loop = true }: AnimatedKiloLogoProps) {
  return <DotLottieReact src="/lottie/YellowKiloLogo.lottie" loop={loop} autoplay />;
}
