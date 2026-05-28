'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

type AnimatedLogoMarkProps = {
  size?: number;
  className?: string;
};

/**
 * Just the Kilo animated mark, without the "Kilo" wordmark.
 * Use when the wordmark would duplicate adjacent text (e.g., a page title).
 *
 * - Plays the animation on hover only on devices that haven't opted out
 *   of motion via `prefers-reduced-motion`.
 * - Uses `preload="none"` so the video file isn't fetched until a user
 *   actually triggers playback. The mark is mounted in several auth
 *   flow states; eager preload would hammer the network on every mount.
 */
export function AnimatedLogoMark({ size = 48, className }: AnimatedLogoMarkProps) {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status } = useSession();
  const reduceMotion = useReducedMotion();
  const animationsAllowed = reduceMotion !== true;

  useEffect(() => {
    if (!videoRef.current) return;
    if (isHovered && animationsAllowed) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [isHovered, animationsAllowed]);

  const href = useMemo(() => {
    if (status === 'authenticated') {
      return 'https://kilo.ai/profile';
    }
    return 'https://kilo.ai';
  }, [status]);

  return (
    <Link
      href={href}
      aria-label="Kilo Code"
      className={cn(
        'inline-flex cursor-pointer items-center transition-opacity hover:opacity-80',
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <video
        ref={videoRef}
        src="/kilo-anim.mp4"
        width={size}
        height={size}
        muted
        loop
        preload="none"
        playsInline
        aria-hidden
      >
        <Image src="/kilo-v1.svg" alt="" width={size} height={size} aria-hidden />
      </video>
    </Link>
  );
}
