'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LANDING_URL } from '@/lib/constants';

export function DelayedLinks() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 1500); // 1.5 second delay

    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`flex items-center justify-center gap-4 text-sm transition-opacity duration-500 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <Link
        href="/profile"
        className="text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
      >
        Profile
      </Link>
      <span className="text-muted-foreground">•</span>
      <Link
        href={`${LANDING_URL}/support`}
        className="text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
      >
        Support
      </Link>
    </div>
  );
}
