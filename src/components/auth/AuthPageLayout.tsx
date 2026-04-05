import { AnimatedLogo } from '@/components/AnimatedLogo';
import { AuthMarketingAside } from '@/components/auth/AuthMarketingAside';

type AuthPageLayoutProps = {
  children: React.ReactNode;
};

export function AuthPageLayout({ children }: AuthPageLayoutProps) {
  return (
    <div className="bg-background absolute top-0 left-0 min-h-screen w-full">
      <div className="absolute top-0 left-0 p-8">
        <AnimatedLogo />
      </div>
      <div className="from-background via-background to-background/80 flex min-h-screen items-center justify-center bg-gradient-to-br">
        {/* Left Column - Content */}
        <main className="border-default bg-sidebar flex min-h-screen flex-1 flex-shrink-0 basis-1/6 flex-col items-center justify-center border-r px-5 pt-32 pb-8 shadow-lg">
          {children}
        </main>

        {/* Right Column */}
        <AuthMarketingAside />
      </div>
    </div>
  );
}
