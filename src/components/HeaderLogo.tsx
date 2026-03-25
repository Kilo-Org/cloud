'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import AnimatedKiloLogo from '@/components/AnimatedKiloLogo';
import KiloLogo from '@/components/KiloLogo';

type HeaderLogoProps = {
  className?: string;
  href?: string;
};

export default function HeaderLogo({ className, href }: HeaderLogoProps) {
  const pathname = usePathname();
  const [isHovered, setIsHovered] = useState(false);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (pathname === href) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const logoContent = (
    <>
      <motion.div
        className="relative flex size-12 flex-none items-center justify-center overflow-hidden font-bold"
        aria-hidden="true"
        animate={{ rotate: isHovered ? 90 : 0 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        style={{ transformStyle: 'preserve-3d' }}
      >
        <AnimatePresence>
          <motion.div
            key="animated"
            initial={{ opacity: isHovered ? 1 : 0 }}
            animate={{
              opacity: isHovered ? 1 : 0,
              rotate: isHovered ? +270 : 0,
            }}
            exit={{ opacity: isHovered ? 1 : 0 }}
            transition={{ duration: 0.2 }}
            className="absolute top-0 left-0 size-12"
            // style={{ transform: 'rotateY(360deg)' }}
          >
            <AnimatedKiloLogo />
          </motion.div>
          <motion.div
            key="static"
            initial={{ opacity: isHovered ? 0 : 1 }}
            animate={{ opacity: isHovered ? 0 : 1 }}
            exit={{ opacity: isHovered ? 0 : 1 }}
            transition={{ duration: 0.2 }}
            className="absolute top-0 left-0 size-12"
          >
            <KiloLogo />
          </motion.div>
        </AnimatePresence>
      </motion.div>
      <span className="text-3xl font-bold whitespace-nowrap">Kilo</span>
    </>
  );

  return (
    <motion.div
      className="mt-px"
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      whileHover={{
        transition: { duration: 0.2 },
      }}
      whileTap={{ y: -6 }}
    >
      {href ? (
        <Link
          href={href}
          onClick={handleClick}
          className={cn(
            'text-foreground group/logo ring-foreground/15 pointer-events-auto flex w-56 items-center gap-4 self-start pr-4 whitespace-nowrap backdrop-blur-xl outline-none ring-inset',
            'hover:text-yellow-200 hover:ring-yellow-200/40',
            'focus:text-brand-primary focus:ring-brand-primary focus:ring-3',
            className
          )}
          aria-label="Kilo Homepage"
        >
          {logoContent}
        </Link>
      ) : (
        <div className="flex w-56 items-center gap-4 self-start pr-4">{logoContent}</div>
      )}
    </motion.div>
  );
}
