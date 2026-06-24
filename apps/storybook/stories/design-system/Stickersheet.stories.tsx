import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ReactNode } from 'react';
import { ArrowRight, CheckCircle2, Clock3, LoaderCircle, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta = {
  title: 'Design System/Stickersheet',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Canonical stickersheet rendered from DESIGN.md tokens, global CSS utilities, and web UI primitives.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

function StoryCanvas({ children }: { children: ReactNode }) {
  return (
    <main className="storybook-canvas p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-10">{children}</div>
    </main>
  );
}

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-5">
      <div className="grid gap-2">
        <p className="type-eyebrow text-muted-foreground">{eyebrow}</p>
        <h2 className="type-heading">{title}</h2>
        <p className="type-body text-muted-foreground max-w-3xl">{description}</p>
      </div>
      {children}
    </section>
  );
}

function SurfaceTile({
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
      className={`border-border flex min-h-32 flex-col justify-between rounded-xl border p-4 ${className}`}
    >
      <span className="type-label text-foreground">{label}</span>
      <code className="type-code text-muted-foreground">{token}</code>
    </div>
  );
}

function TypographySample({
  label,
  className,
  sample,
}: {
  label: string;
  className: string;
  sample: string;
}) {
  return (
    <div className="border-border grid gap-2 border-t py-3 sm:grid-cols-[10rem_1fr]">
      <code className="type-code text-muted-foreground">{label}</code>
      <span className={className}>{sample}</span>
    </div>
  );
}

function StickersheetPage() {
  return (
    <StoryCanvas>
      <header className="max-w-3xl space-y-3">
        <p className="type-eyebrow text-muted-foreground">Kilo Cloud</p>
        <h1 className="type-title">Design System Stickersheet</h1>
        <p className="type-body-lg text-muted-foreground">
          Canonical Storybook reference for dark surfaces, production typography, primitive
          variants, and interaction states.
        </p>
      </header>

      <Section
        eyebrow="01"
        title="Surface Ladder"
        description="Visual checks can assert canvas, raised, and overlay surfaces without relying on unsupported light mode."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <SurfaceTile
            label="canvas"
            token="--surface-background"
            className="bg-surface-background"
          />
          <SurfaceTile label="raised" token="--surface-raised" className="bg-surface-raised" />
          <SurfaceTile label="overlay" token="--surface-overlay" className="bg-surface-overlay" />
        </div>
      </Section>

      <Section
        eyebrow="02"
        title="Typography"
        description="Storybook applies the same font variables as production: Inter for UI, Roboto Mono for code, JetBrains Mono for editor surfaces."
      >
        <div className="grid">
          <TypographySample label="type-title" className="type-title" sample="Page title" />
          <TypographySample
            label="type-heading"
            className="type-heading"
            sample="Section heading"
          />
          <TypographySample
            label="type-body-lg"
            className="type-body-lg"
            sample="Lead product copy"
          />
          <TypographySample label="type-body" className="type-body" sample="Default product copy" />
          <TypographySample label="type-label" className="type-label" sample="Control label" />
          <TypographySample label="type-code" className="type-code" sample="pnpm build-storybook" />
          <TypographySample
            label="font-jetbrains"
            className="font-jetbrains text-sm"
            sample="Terminal editor text"
          />
        </div>
      </Section>

      <Section
        eyebrow="03"
        title="Buttons"
        description="Button states come from ui/button variants. Icon-only controls include accessible labels."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Create workspace</Button>
          <Button variant="secondary">Review usage</Button>
          <Button variant="outline">Open invoice</Button>
          <Button variant="ghost">Dismiss</Button>
          <Button variant="destructive">Delete token</Button>
          <Button disabled>Disabled</Button>
          <Button disabled aria-busy="true">
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            Saving
          </Button>
          <Button size="icon" aria-label="Search repositories">
            <Search />
          </Button>
          <Button size="icon" variant="secondary" aria-label="Continue setup">
            <ArrowRight />
          </Button>
        </div>
      </Section>

      <Section
        eyebrow="04"
        title="Inputs"
        description="Inputs use visible labels, id/htmlFor association, described helper text, and strict invalid states."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sheet-email">Billing email</Label>
            <Input id="sheet-email" type="email" placeholder="billing@example.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sheet-disabled">Repository</Label>
            <Input id="sheet-disabled" value="Loading repositories..." disabled readOnly />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sheet-invalid">Invite email</Label>
            <Input id="sheet-invalid" value="billing" aria-invalid readOnly />
            <p className="type-label text-status-destructive">
              Email must include an @ symbol. Example: you@example.com
            </p>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="05"
        title="Badges"
        description="Badges carry text or icons so meaning survives color-vision differences."
      >
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="secondary-outline">Secondary outline</Badge>
          <Badge variant="new">
            <CheckCircle2 />
            Active
          </Badge>
          <Badge variant="beta">
            <Clock3 />
            Beta
          </Badge>
          <Badge variant="destructive">Action needed</Badge>
        </div>
      </Section>
    </StoryCanvas>
  );
}

export const Stickersheet: Story = {
  render: () => <StickersheetPage />,
};
