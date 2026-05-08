import Link from 'next/link';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { getPrototypeCatalogState } from '@/lib/prototypes';

export default function PrototypesHomePage() {
  const { entries: prototypes, diagnostics } = getPrototypeCatalogState();

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 md:px-8 md:py-12">
        <header className="space-y-3 border-b pb-8">
          <p className="text-muted-foreground text-xs uppercase tracking-[0.18em]">
            Kilo Code prototypes
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-3">
              <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
                Product-flow previews
              </h1>
              <p className="text-muted-foreground max-w-2xl text-sm">
                Review full-page Kilo Code UI explorations outside the production web router.
                Storybook stays focused on individual component states.
              </p>
            </div>
            <div className="bg-card text-card-foreground rounded-xl border px-4 py-3">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">Available</p>
              <p className="font-mono text-2xl font-semibold tabular-nums">{prototypes.length}</p>
            </div>
          </div>
        </header>

        {diagnostics.length > 0 && (
          <section className="bg-card text-card-foreground rounded-xl border p-6">
            <div className="flex items-start gap-3">
              <FlaskConical className="text-muted-foreground mt-0.5 size-4" aria-hidden />
              <div className="space-y-2">
                <h2 className="font-semibold">Prototype metadata needs attention</h2>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  {diagnostics.map(diagnostic => (
                    <li key={`${diagnostic.slug}-${diagnostic.code}`}>
                      <code className="font-mono">{diagnostic.slug}</code>: {diagnostic.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {prototypes.length === 0 ? (
          <section className="bg-card text-card-foreground rounded-xl border p-6">
            <div className="flex items-start gap-3">
              <FlaskConical className="text-muted-foreground mt-0.5 size-4" aria-hidden />
              <div className="space-y-2">
                <h2 className="font-semibold">No prototypes discovered yet</h2>
                <p className="text-muted-foreground text-sm">
                  Add a route folder with a <code className="font-mono">page.tsx</code> file under{' '}
                  <code className="font-mono">apps/prototypes/src/app</code>.
                </p>
              </div>
            </div>
          </section>
        ) : (
          <section className="grid gap-4 md:grid-cols-2">
            {prototypes.map(prototype => (
              <Link
                key={prototype.slug}
                href={prototype.href}
                className="bg-card text-card-foreground hover:bg-accent/60 focus-visible:ring-ring group rounded-xl border p-6 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="flex h-full flex-col gap-5">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {prototype.tags.map(tag => (
                        <span
                          key={tag}
                          className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                      {prototype.metadataState !== 'provided' && (
                        <span className="border-border text-muted-foreground rounded-full border px-2.5 py-1 text-xs">
                          {prototype.metadataState === 'invalid'
                            ? 'Metadata invalid — using fallback'
                            : 'Metadata fallback'}
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-lg font-semibold tracking-tight">{prototype.title}</h2>
                      <p className="text-muted-foreground text-sm">{prototype.description}</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground group-hover:text-foreground mt-auto inline-flex items-center gap-2 text-sm font-medium">
                    Open prototype
                    <ArrowRight className="size-4" aria-hidden />
                  </div>
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
