import AnimatedKiloLogo from '@/components/AnimatedKiloLogo';
import { PageContainer } from '@/components/layouts/PageContainer';
import styles from './AccountCreationScreen.module.css';

export function AccountCreationScreen() {
  return (
    <PageContainer className="min-h-screen">
      <main className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-4" role="status" aria-busy="true">
          <span className="text-brand-primary size-12" aria-hidden="true">
            <AnimatedKiloLogo />
          </span>
          <p className={`type-body ${styles.shimmer}`}>Creating your account</p>
        </div>
      </main>
    </PageContainer>
  );
}
