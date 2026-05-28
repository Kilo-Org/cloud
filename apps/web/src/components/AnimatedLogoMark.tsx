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
 * Renders the static SVG by default and overlays the video only while
 * hovering (and only when the user hasn't opted out of motion). Video
 * uses `preload="none"` so the file isn't fetched until first hover.
 */
export function AnimatedLogoMark({ size = 48, className }: AnimatedLogoMarkProps) {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status } = useSession();
  const reduceMotion = useReducedMotion();
  const animationsAllowed = reduceMotion !== true;
  const showVideo = isHovered && animationsAllowed;

  useEffect(() => {
    if (!videoRef.current) return;
    if (showVideo) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [showVideo]);

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
      <span className="relative inline-block" style={{ width: size, height: size }} aria-hidden>
        <Image src="/kilo-v1.svg" alt="" width={size} height={size} priority />
        <video
          ref={videoRef}
          src="/kilo-anim.mp4"
          width={size}
          height={size}
          muted
          loop
          preload="none"
          playsInline
          className={cn(
            'absolute inset-0 transition-opacity duration-150',
            showVideo ? 'opacity-100' : 'opacity-0'
          )}
        />
      </span>
    </Link>
  );
}
