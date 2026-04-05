import { Card, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageLayout } from '@/components/PageLayout';
import Link from 'next/link';

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

export default function InstallPage() {
  return (
    <PageLayout title="Install">
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative flex flex-col justify-between overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-32 w-32 translate-x-8 -translate-y-8 rounded-full blur-2xl transition-all" />
          <CardHeader className="relative flex-1">
            <div className="bg-brand-primary/10 text-brand-primary mb-4 flex h-12 w-12 items-center justify-center rounded-lg">
              <CodeIcon className="h-6 w-6" />
            </div>
            <CardTitle className="text-xl">IDE Extension</CardTitle>
            <CardDescription className="text-muted-foreground mt-2">
              Seamlessly integrate Kilo Code into VS Code, JetBrains IDEs, and more for an enhanced
              coding experience.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
              asChild
            >
              <Link href="https://kilo.ai/install" target="_blank" rel="noopener noreferrer">
                Install Extension
              </Link>
            </Button>
          </CardFooter>
        </Card>

        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative flex flex-col justify-between overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-32 w-32 translate-x-8 -translate-y-8 rounded-full blur-2xl transition-all" />
          <CardHeader className="relative flex-1">
            <div className="bg-brand-primary/10 text-brand-primary mb-4 flex h-12 w-12 items-center justify-center rounded-lg">
              <TerminalIcon className="h-6 w-6" />
            </div>
            <CardTitle className="text-xl">Command Line Tool</CardTitle>
            <CardDescription className="text-muted-foreground mt-2">
              Build and automate directly from your terminal with the powerful Kilo CLI.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
              asChild
            >
              <Link href="https://kilo.ai/install#cli" target="_blank" rel="noopener noreferrer">
                Install CLI
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageLayout>
  );
}
