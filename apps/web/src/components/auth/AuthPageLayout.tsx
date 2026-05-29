import { AuthMarketingAside } from '@/components/auth/AuthMarketingAside';

type AuthPageLayoutProps = {
  children: React.ReactNode;
};

export function AuthPageLayout({ children }: AuthPageLayoutProps) {
  return (
    <div className="bg-background absolute top-0 left-0 min-h-screen w-full">
      <div className="from-background via-background to-background/80 flex min-h-screen items-center justify-center bg-gradient-to-br">
        {/* Left Column - Content */}
        <main
          style={{ backgroundColor: '#0a0a0a' }}
          className="flex min-h-screen w-3/5 shrink-0 flex-col items-center justify-center px-5 pt-32 pb-8"
        >
          {children}
        </main>

        {/* Right Column */}
        <AuthMarketingAside />
      </div>
    </div>
  );
}
