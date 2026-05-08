import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button as LegacyButton } from '@/components/Button';
import { Button } from '@/components/ui/button';

const meta: Meta = {
  title: 'Design Proposal/Drift Audit',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Row-by-row drift between the proposed stickersheet and the current Kilo Cloud app. Reference document, not a designed page — each row lists the proposal, the current reality, and the migration decision.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type Status = 'drift' | 'partial' | 'aligned';

function StatusLabel({ status }: { status: Status }) {
  const label = status === 'drift' ? 'Drifted' : status === 'partial' ? 'Partial' : 'Aligned';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--muted-foreground)',
      }}
    >
      {label}
    </span>
  );
}

function Row({
  area,
  status,
  decision,
  proposal,
  actual,
}: {
  area: string;
  status: Status;
  decision: string;
  proposal: ReactNode;
  actual: ReactNode;
}) {
  return (
    <section
      style={{
        padding: '24px 0',
        borderTop: '1px solid var(--border, rgba(255,255,255,0.1))',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {area}
        </h3>
        <StatusLabel status={status} />
      </header>
      <p
        style={{
          margin: '0 0 16px',
          maxWidth: '72ch',
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--muted-foreground)',
        }}
      >
        {decision}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--muted-foreground)',
              marginBottom: 8,
            }}
          >
            Proposal (stickersheet)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            {proposal}
          </div>
        </div>
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--muted-foreground)',
              marginBottom: 8,
            }}
          >
            Current app
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            {actual}
          </div>
        </div>
      </div>
    </section>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          display: 'inline-block',
          width: 24,
          height: 24,
          borderRadius: 4,
          background: color,
          border: '1px solid var(--border, rgba(255,255,255,0.1))',
        }}
      />
      <code
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          color: 'var(--muted-foreground)',
        }}
      >
        {label}
      </code>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: 'var(--muted-foreground)', lineHeight: 1.55 }}>
      {children}
    </span>
  );
}

function DriftAuditPage() {
  return (
    <div
      style={{
        padding: 24,
        minHeight: '100vh',
        boxSizing: 'border-box',
        display: 'block',
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--muted-foreground)',
          }}
        >
          Design Proposal
        </p>
        <h1
          style={{
            margin: '8px 0 0',
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.015em',
            lineHeight: 1.2,
          }}
        >
          Stickersheet Drift Audit
        </h1>
        <p
          style={{
            margin: '12px 0 0',
            maxWidth: '72ch',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--muted-foreground)',
          }}
        >
          The stickersheet proposal differs from the current app in several meaningful ways. Each
          row lists the proposal, the current reality, and the migration decision.
        </p>
      </header>

      <Row
        area="Primary action color"
        status="drift"
        decision="Primary CTAs should use the Kilo yellow-green primary token. Migrate --primary and ui/button 'primary' away from hardcoded blue; keep blue for inline links and legacy drift only."
        proposal={
          <>
            <Swatch color="#EDFF00" label="#EDFF00" />
            <Note>brand yellow-green, used once per surface as the CTA</Note>
          </>
        }
        actual={
          <>
            <Swatch color="oklch(0.922 0 0)" label="--primary" />
            <Swatch color="#2B6AD2" label="ui/button primary" />
            <Note>
              --primary token is still near-white; button &quot;primary&quot; variant is still
              hardcoded blue
            </Note>
          </>
        }
      />

      <Row
        area="Button variant inventory"
        status="drift"
        decision="Consolidate to primary / secondary / ghost / destructive / link. Deprecate legacy Button color variants."
        proposal={
          <>
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </>
        }
        actual={
          <>
            <LegacyButton>primary</LegacyButton>
            <LegacyButton variant="secondary">secondary</LegacyButton>
            <LegacyButton variant="blue">blue</LegacyButton>
            <LegacyButton variant="green">green</LegacyButton>
            <LegacyButton variant="yellow">yellow</LegacyButton>
            <LegacyButton variant="purple">purple</LegacyButton>
            <LegacyButton variant="danger">danger</LegacyButton>
            <LegacyButton variant="outline">outline</LegacyButton>
          </>
        }
      />

      <Row
        area="Font stack"
        status="partial"
        decision="design.md says Roboto Mono. Stickersheet has been updated to match. App loads Roboto Mono via next/font but Tailwind font-mono utility was mis-wired to a non-existent --font-geist-mono — a separate fix."
        proposal={<Note>Inter · Roboto Mono</Note>}
        actual={<Note>Inter · Roboto Mono · JetBrains Mono (loaded as .font-jetbrains only)</Note>}
      />

      <Row
        area="Status badge pattern"
        status="partial"
        decision="Standardize on bg-{color}-500/20 + ring-{color}-500/20 + text-{color}-400 and migrate inconsistent /10, /30, or solid borders."
        proposal={
          <span
            style={{
              display: 'inline-flex',
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(59,130,246,0.2)',
              color: '#60A5FA',
              fontSize: 12,
              fontWeight: 500,
              boxShadow: 'inset 0 0 0 1px rgba(59,130,246,0.2)',
            }}
          >
            Cloud
          </span>
        }
        actual={
          <>
            <Badge variant="beta">beta (/10)</Badge>
            <Badge variant="new">new (/10)</Badge>
            <span
              style={{
                display: 'inline-flex',
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid rgba(59,130,246,0.3)',
                background: 'rgba(59,130,246,0.1)',
                color: '#60A5FA',
                fontSize: 12,
              }}
            >
              mixed /10 + /30
            </span>
          </>
        }
      />

      <Row
        area="Alert / feedback variants"
        status="drift"
        decision="Align Alert and Banner tones with the proposed translucent /20 feedback system and remove colored button backgrounds inside banners."
        proposal={
          <Note>
            Alert · Notice · Warning · Destructive on translucent /20 surfaces, no colored button
            fills
          </Note>
        }
        actual={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <Alert variant="notice">
              <AlertTitle>Notice</AlertTitle>
              <AlertDescription>bg-blue-950 / text-blue-200 — solid, not /20</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>bg-yellow-950/30 / text-yellow-400 — mixed alpha</AlertDescription>
            </Alert>
          </div>
        }
      />

      <Row
        area="Topbar / sidebar chrome"
        status="partial"
        decision="Stickersheet examples are aspirational. Prefer real AppTopbar / AppSidebar components in Storybook; treat stickersheet chrome as structure only."
        proposal={
          <Note>
            56px topbar with sidebar toggle + breadcrumb. 256px sidebar with eyebrow section
            headers.
          </Note>
        }
        actual={
          <Note>
            AppTopbar renders sidebar toggle + title/breadcrumb + extras only. Sidebar is
            Personal/Organization-aware and driven by feature flags and KiloClaw/Cloud groups.
          </Note>
        }
      />

      <Row
        area="Blue as link-only"
        status="drift"
        decision="Blue is a legacy inline-link role only. App blue button backgrounds in SuggestionCard, SeatsSubscribeCard, KiloClawSubscribeCard, WelcomeContent, and multiple banners should migrate to primary or secondary variants as those surfaces are updated."
        proposal={
          <span style={{ fontSize: 13, color: '#60A5FA' }}>
            Inline link only — never a button background.
          </span>
        }
        actual={
          <>
            <span
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                background: '#2563EB',
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              Blue button
            </span>
            <span
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                background: '#2B6AD2',
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              ui/button primary
            </span>
            <Note>in production flows</Note>
          </>
        }
      />
    </div>
  );
}

export const DriftAudit: Story = {
  render: () => <DriftAuditPage />,
};
