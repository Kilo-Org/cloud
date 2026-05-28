'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';

type AnimatedLogoMarkProps = {
  size?: number;
  className?: string;
};

/**
 * Just the Kilo animated mark, without the "Kilo" wordmark.
 * Use when the wordmark would duplicate adjacent text (e.g., a page title).
 */
export function AnimatedLogoMark({ size = 48, className }: AnimatedLogoMarkProps) {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status } = useSession();

  useEffect(() => {
    if (videoRef.current) {
      if (isHovered) {
        void videoRef.current.play();
      } else {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
    }
  }, [isHovered]);

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
        preload="auto"
        playsInline
        aria-hidden
      >
        <Image src="/kilo-v1.svg" alt="" width={size} height={size} aria-hidden />
      </video>
    </Link>
  );
}
