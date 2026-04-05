'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

export function AnimatedLogo() {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status } = useSession();

  useEffect(() => {
    if (videoRef.current) {
      if (isHovered) {
        void videoRef.current.play();
      } else {
        videoRef.current.pause();
        videoRef.current.currentTime = 0; // Reset to first frame
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
      className="flex cursor-pointer items-center transition-opacity hover:opacity-80"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <video
        ref={videoRef}
        src="/kilo-anim.mp4"
        width={48}
        height={48}
        className="mr-2"
        muted
        loop
        preload="auto"
        playsInline
      >
        {/* Fallback image for browsers that don't support video */}
        <Image src="/kilo-v1.svg" alt="Kilo Code Logo" width={48} height={48} className="mr-2" />
      </video>
      <h1 className="text-3xl leading-[0.8] font-bold tracking-tighter">Kilo</h1>
    </Link>
  );
}
