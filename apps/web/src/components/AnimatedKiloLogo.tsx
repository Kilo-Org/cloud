'use client';

import dynamic from 'next/dynamic';
import { useReducedMotion } from 'motion/react';
import KiloLogo from '@/components/KiloLogo';

const DotLottieReact = dynamic(
  () => import('@lottiefiles/dotlottie-react').then(module => module.DotLottieReact),
  { ssr: false }
);

export default function AnimatedKiloLogo() {
  const reduceMotion = useReducedMotion();

  if (reduceMotion === true) {
    return <KiloLogo />;
  }

  return <DotLottieReact src="/lottie/YellowKiloLogo.lottie" loop autoplay />;
}
