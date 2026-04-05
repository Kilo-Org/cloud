import { Card, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageLayout } from '@/components/PageLayout';
import Link from 'next/link';

function BookIcon({ className }: { className?: string }) {
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
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
    </svg>
  );
}

function VideoIcon({ className }: { className?: string }) {
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
      <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14v-4z" />
      <rect x="3" y="6" width="12" height="12" rx="2" ry="2" />
    </svg>
  );
}

export default function LearnPage() {
  return (
    <PageLayout title="Learn">
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative flex flex-col justify-between overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-32 w-32 translate-x-8 -translate-y-8 rounded-full blur-2xl transition-all" />
          <CardHeader className="relative flex-1">
            <div className="bg-brand-primary/10 text-brand-primary mb-4 flex h-12 w-12 items-center justify-center rounded-lg">
              <BookIcon className="h-6 w-6" />
            </div>
            <CardTitle className="text-xl">Documentation</CardTitle>
            <CardDescription className="text-muted-foreground mt-2">
              Comprehensive guides and reference materials to help you master Kilo Code.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
              asChild
            >
              <Link href="https://kilo.ai/docs" target="_blank" rel="noopener noreferrer">
                View Documentation
              </Link>
            </Button>
          </CardFooter>
        </Card>

        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative flex flex-col justify-between overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-32 w-32 translate-x-8 -translate-y-8 rounded-full blur-2xl transition-all" />
          <CardHeader className="relative flex-1">
            <div className="bg-brand-primary/10 text-brand-primary mb-4 flex h-12 w-12 items-center justify-center rounded-lg">
              <VideoIcon className="h-6 w-6" />
            </div>
            <CardTitle className="text-xl">Live Q&A Sessions</CardTitle>
            <CardDescription className="text-muted-foreground mt-2">
              Join our weekly product onboarding and Q&A sessions with the Kilo team. Get your
              questions answered live.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
              asChild
            >
              <Link
                href="https://kilo.codes/weekly-product-onboarding-session"
                target="_blank"
                rel="noopener noreferrer"
              >
                Register Now
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageLayout>
  );
}
