import { AnimatedLogo } from '@/components/AnimatedLogo';
import { PageContainer } from '@/components/layouts/PageContainer';

export default function SignInUpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background h-full w-full">
      <PageContainer fullBleed>
        <div className="flex min-h-screen flex-col justify-between">
          <AnimatedLogo />
          <div>{children}</div>
          <div />
        </div>
      </PageContainer>
    </div>
  );
}
