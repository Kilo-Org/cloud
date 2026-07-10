'use client';

import AnimatedKiloLogo from '@/components/AnimatedKiloLogo';
import styles from './AccountCreationStatus.module.css';

export function AccountCreationStatus() {
  return (
    <div className="flex flex-col items-center gap-4" role="status" aria-busy="true">
      <span className="size-12" aria-hidden="true">
        <AnimatedKiloLogo />
      </span>
      <p className={`type-body ${styles.shimmer}`}>Creating your account</p>
    </div>
  );
}
