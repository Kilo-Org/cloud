import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <h1 className="text-6xl font-bold tracking-tight">404</h1>
      <p className="text-muted-foreground mt-4 text-lg">This page could not be found.</p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center rounded-md px-4 py-2 text-sm font-medium"
        >
          Go Home
        </Link>
        <Link
          href="https://kilo.ai/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium"
        >
          Read the Docs
        </Link>
      </div>
    </div>
  );
}
