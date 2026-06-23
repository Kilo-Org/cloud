import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ReactNode } from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta = {
  title: 'Design System/Authority Audit',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Executable audit for DESIGN.md alignment. Uses production Storybook globals and authoritative web UI primitives.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type AuditRowProps = {
  title: string;
  summary: string;
  children: ReactNode;
};

function StoryCanvas({ children }: { children: ReactNode }) {
  return (
    <main className="storybook-canvas p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">{children}</div>
    </main>
  );
}

function AuditRow({ title, summary, children }: AuditRowProps) {
  return (
    <section className="border-border grid gap-4 border-t pt-6 lg:grid-cols-[16rem_1fr]">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="new">
            <CheckCircle2 />
            Aligned
          </Badge>
        </div>
        <h3 className="type-heading">{title}</h3>
        <p className="type-body text-muted-foreground">{summary}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

function SurfaceReference({
  label,
  token,
  className,
}: {
  label: string;
  token: string;
  className: string;
}) {
  return (
    <div
      data-storybook-surface={label}
      className={`border-border flex min-h-28 min-w-48 flex-col justify-between rounded-xl border p-4 ${className}`}
    >
      <span className="type-label text-foreground">{label}</span>
      <code className="type-code text-muted-foreground">{token}</code>
    </div>
  );
}

function DriftAuditPage() {
  return (
    <StoryCanvas>
      <header className="max-w-3xl space-y-3">
        <p className="type-eyebrow text-muted-foreground">Design System</p>
        <h1 className="type-title">Storybook Authority Audit</h1>
        <p className="type-body-lg text-muted-foreground">
          Storybook now mirrors Kilo Cloud's dark-first token contract, production fonts, and
          shadcn-based web primitives.
        </p>
      </header>

      <AuditRow
        title="Production fonts"
        summary="Preview applies the same next/font variables as the web app: Inter, Roboto Mono, and JetBrains Mono."
      >
        <span className="type-body">Inter UI text</span>
        <code className="type-code">Roboto Mono code</code>
        <span className="font-jetbrains text-sm">JetBrains Mono editor text</span>
      </AuditRow>

      <AuditRow
        title="Dark canvas"
        summary="Light-mode controls are removed. Background options are limited to canonical dark surfaces."
      >
        <SurfaceReference
          label="canvas"
          token="--surface-background"
          className="bg-surface-background"
        />
        <SurfaceReference label="raised" token="--surface-raised" className="bg-surface-raised" />
        <SurfaceReference
          label="overlay"
          token="--surface-overlay"
          className="bg-surface-overlay"
        />
      </AuditRow>

      <AuditRow
        title="Primitive source"
        summary="Primitive stories import authoritative ui/* components instead of legacy wrappers or standalone HTML."
      >
        <Button>Create workspace</Button>
        <Button variant="secondary">Review usage</Button>
        <Badge variant="secondary-outline">ui/badge</Badge>
      </AuditRow>

      <AuditRow
        title="Interaction states"
        summary="Reference stories expose focus, disabled, loading, long-copy, and labeled form states for visual review."
      >
        <Button className="ring-ring ring-[3px]">Focus visible</Button>
        <Button disabled>Disabled</Button>
        <Button disabled aria-busy="true">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          Saving changes
        </Button>
        <div className="w-72 space-y-2">
          <Label htmlFor="audit-email">Billing email</Label>
          <Input id="audit-email" type="email" placeholder="billing@example.com" />
        </div>
      </AuditRow>

      <AuditRow
        title="Reduced motion"
        summary="Motion examples use motion-reduce utilities so visual checks can validate functional reduced-motion output."
      >
        <div className="storybook-motion-sample flex flex-wrap items-center gap-3">
          <Button aria-busy="true">
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            Syncing
          </Button>
          <Button variant="outline" className="transition-transform hover:-translate-y-0.5">
            Hover feedback
          </Button>
        </div>
      </AuditRow>
    </StoryCanvas>
  );
}

export const DriftAudit: Story = {
  render: () => <DriftAuditPage />,
};
