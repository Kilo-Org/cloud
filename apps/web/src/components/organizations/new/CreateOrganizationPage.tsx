'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import * as z from 'zod';
import {
  AlertCircle,
  ArrowRight,
  ChartNoAxesCombined,
  GitBranch,
  LoaderCircle,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useCreateOrganization } from '@/app/api/organizations/hooks';
import AnimatedKiloLogo from '@/components/AnimatedKiloLogo';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CompanyDomainSchema } from '@/lib/organizations/company-domain';
import { OrganizationNameSchema } from '@/lib/organizations/organization-types';

const CreateOrganizationSchema = z.object({
  organizationName: OrganizationNameSchema,
  companyDomain: CompanyDomainSchema,
});

const DEFAULT_ERROR = "We couldn't create the organization. Check your connection and try again.";

function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return DEFAULT_ERROR;
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first: unknown = parsed[0];
      if (
        first &&
        typeof first === 'object' &&
        'message' in first &&
        typeof first.message === 'string'
      ) {
        return first.message;
      }
    }
  } catch {
    return error.message || DEFAULT_ERROR;
  }
  return error.message || DEFAULT_ERROR;
}

type CreateOrganizationPageProps = {
  initialOrganizationName?: string;
};

type FormErrors = {
  organizationName?: string;
  companyDomain?: string;
  general?: string;
};

type EnterpriseValue = {
  title: string;
  description: string;
  icon: LucideIcon;
};

const enterpriseValues: EnterpriseValue[] = [
  {
    title: 'Choose without lock-in',
    description:
      'Use an inspectable open-source harness across your workflows, with 300+ models, automated routing, BYOK, and private inference.',
    icon: GitBranch,
  },
  {
    title: 'Govern every team',
    description:
      'Apply shared identity, role-based access, model and provider controls, and audit logs from one control plane.',
    icon: ShieldCheck,
  },
  {
    title: 'Make spend visible',
    description:
      'Track adoption and usage by team, model, and provider with centralized billing and shared configuration.',
    icon: ChartNoAxesCombined,
  },
];

export function CreateOrganizationPage({
  initialOrganizationName = '',
}: CreateOrganizationPageProps = {}) {
  const [organizationName, setOrganizationName] = useState(initialOrganizationName);
  const [companyDomain, setCompanyDomain] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const organizationNameInputRef = useRef<HTMLInputElement>(null);
  const companyDomainInputRef = useRef<HTMLInputElement>(null);
  const createOrganizationMutation = useCreateOrganization();

  const validateOrganizationName = () => {
    const result = OrganizationNameSchema.safeParse(organizationName);
    setErrors(current => ({
      ...current,
      organizationName: result.success ? undefined : result.error.issues[0]?.message,
    }));
  };

  const validateCompanyDomain = () => {
    const result = CompanyDomainSchema.safeParse(companyDomain);
    setErrors(current => ({
      ...current,
      companyDomain: result.success ? undefined : result.error.issues[0]?.message,
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createOrganizationMutation.isPending) return;

    const validationResult = CreateOrganizationSchema.safeParse({
      organizationName,
      companyDomain,
    });

    if (!validationResult.success) {
      const fieldErrors: FormErrors = {};
      for (const issue of validationResult.error.issues) {
        if (issue.path[0] === 'organizationName' && !fieldErrors.organizationName) {
          fieldErrors.organizationName = issue.message;
        }
        if (issue.path[0] === 'companyDomain' && !fieldErrors.companyDomain) {
          fieldErrors.companyDomain = issue.message;
        }
      }
      setErrors(fieldErrors);

      if (fieldErrors.organizationName) {
        organizationNameInputRef.current?.focus();
      } else if (fieldErrors.companyDomain) {
        companyDomainInputRef.current?.focus();
      }
      return;
    }

    setErrors({});

    try {
      const result = await createOrganizationMutation.mutateAsync({
        name: validationResult.data.organizationName,
        autoAddCreator: true,
        company_domain: validationResult.data.companyDomain ?? undefined,
      });

      window.location.href = `/organizations/${result.organization.id}/welcome?firstTime=1`;
    } catch (error) {
      console.error('Failed to create organization:', error);
      setErrors({ general: extractErrorMessage(error) });
    }
  };

  const isSubmitting = createOrganizationMutation.isPending;

  return (
    <PageContainer className="min-h-svh justify-center gap-8 py-8 md:gap-10 md:py-12">
      <div className="flex items-center gap-3 self-center">
        <div className="size-14" aria-hidden="true">
          <AnimatedKiloLogo loop={false} />
        </div>
        <span className="font-jetbrains text-3xl font-bold">Kilo</span>
      </div>

      <header className="flex max-w-3xl flex-col gap-3 border-b border-border pb-8">
        <p className="type-eyebrow text-muted-foreground">Kilo Enterprise</p>
        <h1 className="type-title text-balance">Agentic engineering, on your terms</h1>
        <p className="type-body-lg text-muted-foreground max-w-[65ch] text-pretty">
          Give every engineering team the interfaces and models that fit their work, while leaders
          keep shared security, visibility, and spend controls.
        </p>
        <Link
          href="/get-started/personal"
          className="type-body text-link hover:text-link-hover focus-visible:ring-ring/50 w-fit rounded-sm underline underline-offset-4 focus-visible:ring-[3px] focus-visible:outline-none"
        >
          Continue with an individual account
        </Link>
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)] lg:gap-12">
        <section
          className="order-2 min-w-0 lg:order-1 lg:self-center"
          aria-labelledby="enterprise-value-title"
        >
          <div className="flex flex-col gap-3">
            <p className="type-eyebrow text-muted-foreground">Built for enterprise engineering</p>
            <h2 id="enterprise-value-title" className="type-heading text-balance">
              Choice where it matters. Control where it counts.
            </h2>
            <p className="type-body text-muted-foreground max-w-[65ch] text-pretty">
              Standardize how agentic work is managed without forcing every team onto one tool,
              model, or provider.
            </p>
          </div>

          <ul className="mt-6 divide-y divide-border border-y border-border">
            {enterpriseValues.map(value => {
              const Icon = value.icon;
              return (
                <li key={value.title} className="grid grid-cols-[auto_1fr] gap-4 py-5">
                  <div className="bg-surface-raised text-brand-primary flex size-9 items-center justify-center rounded-md border border-border">
                    <Icon className="size-4" aria-hidden="true" />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="type-body font-medium text-foreground">{value.title}</h3>
                    <p className="type-body text-muted-foreground text-pretty">
                      {value.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <Card className="order-1 min-w-0 lg:order-2">
          <CardHeader>
            <p className="type-eyebrow text-muted-foreground">14-day Enterprise trial</p>
            <h2 className="type-heading">Set up your organization</h2>
            <p className="type-body text-muted-foreground text-pretty">
              No credit card required. You can invite your team after creating the organization.
            </p>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-6"
              onSubmit={handleSubmit}
              noValidate
              aria-busy={isSubmitting}
            >
              {errors.general ? (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{errors.general}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-col gap-2">
                <Label htmlFor="organization-name">Organization name</Label>
                <Input
                  ref={organizationNameInputRef}
                  id="organization-name"
                  name="organizationName"
                  value={organizationName}
                  onChange={event => setOrganizationName(event.target.value)}
                  onBlur={validateOrganizationName}
                  autoComplete="organization"
                  maxLength={100}
                  required
                  disabled={isSubmitting}
                  aria-invalid={errors.organizationName ? true : undefined}
                  aria-describedby={errors.organizationName ? 'organization-name-error' : undefined}
                  placeholder="Acme Engineering"
                />
                {errors.organizationName ? (
                  <p id="organization-name-error" className="type-label text-status-destructive">
                    {errors.organizationName}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="company-domain">
                  Company website
                  <span className="type-label text-muted-foreground font-normal">Optional</span>
                </Label>
                <Input
                  ref={companyDomainInputRef}
                  id="company-domain"
                  name="companyDomain"
                  value={companyDomain}
                  onChange={event => setCompanyDomain(event.target.value)}
                  onBlur={validateCompanyDomain}
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={isSubmitting}
                  aria-invalid={errors.companyDomain ? true : undefined}
                  aria-describedby={
                    errors.companyDomain
                      ? 'company-domain-help company-domain-error'
                      : 'company-domain-help'
                  }
                  placeholder="acme.com"
                />
                <p id="company-domain-help" className="type-label text-muted-foreground">
                  Enter a domain such as acme.com.
                </p>
                {errors.companyDomain ? (
                  <p id="company-domain-error" className="type-label text-status-destructive">
                    {errors.companyDomain}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-4 border-y border-border py-4">
                <dl className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <dt className="type-label text-muted-foreground">Enterprise access</dt>
                    <dd className="type-body font-medium tabular-nums">14 days</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="type-label text-muted-foreground">Credit card</dt>
                    <dd className="type-body font-medium">Not required</dd>
                  </div>
                  <div className="col-span-2 flex flex-col gap-1">
                    <dt className="type-label text-muted-foreground">Model inference</dt>
                    <dd className="type-body font-medium">BYOK or pay as you go</dd>
                  </div>
                </dl>
                <p className="type-label text-muted-foreground text-pretty">
                  AI model usage is not included in the trial and is billed separately.
                </p>
              </div>

              <Button type="submit" variant="primary" size="lg" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                    Creating organization...
                  </>
                ) : (
                  <>
                    Create organization
                    <ArrowRight aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
