'use client';

import * as z from 'zod';
import { useState, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertCircle,
  ArrowRight,
  Clock,
  TrendingUp,
  ArrowLeftRight,
  CreditCard,
  Key,
  Users,
  Filter,
  FileText,
  KeyRound,
  Star,
  Coins,
  type LucideIcon,
} from 'lucide-react';
import { OrganizationNameSchema } from '@/lib/organizations/organization-types';
import { motion, AnimatePresence } from 'motion/react';
import { useCreateOrganization } from '@/app/api/organizations/hooks';
import { SubscriptionsSeatQuantitySchema } from '@/app/payments/subscriptions/types';
import Link from 'next/link';

const CreateOrganizationSchema = z.object({
  organizationName: OrganizationNameSchema,
  seats: SubscriptionsSeatQuantitySchema,
});

type CreateOrganizationForm = z.infer<typeof CreateOrganizationSchema>;

type CreateOrganizationPageProps = {
  mockSelectedOrgName?: string; // For Storybook
};

type FeatureItem = {
  text: string;
  icon: LucideIcon;
};

const enterpriseTrialFeatures: FeatureItem[] = [
  { text: 'Usage analytics & reporting', icon: Clock },
  { text: 'AI adoption score', icon: TrendingUp },
  { text: 'Shared agent modes', icon: ArrowLeftRight },
  { text: 'Centralized billing', icon: CreditCard },
  { text: 'Shared BYOK', icon: Key },
  { text: 'Team management', icon: Users },
  { text: 'Limit models and/or providers', icon: Filter },
  { text: 'Audit logs', icon: FileText },
  { text: 'SSO, OIDC, & SCIM support', icon: KeyRound },
  { text: 'Priority support', icon: Star },
];

export function CreateOrganizationPage({ mockSelectedOrgName }: CreateOrganizationPageProps = {}) {
  const [name, setName] = useState(mockSelectedOrgName || '');
  const [companyDomain, setCompanyDomain] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    general?: string;
  }>({});
  const nameInputRef = useRef<HTMLInputElement>(null);

  const createOrganizationMutation = useCreateOrganization();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setIsSubmitting(true);

    const formData: CreateOrganizationForm = {
      organizationName: name,
      seats: 1,
    };
    const validationResult = CreateOrganizationSchema.safeParse(formData);

    if (!validationResult.success) {
      const fieldErrors: typeof errors = {};
      validationResult.error.issues.forEach(issue => {
        const field = issue.path[0] as keyof typeof errors;
        if (field && field !== 'general') {
          fieldErrors[field] = issue.message;
        }
      });
      setErrors(fieldErrors);
      setIsSubmitting(false);
      return;
    }

    try {
      const orgId = (
        await createOrganizationMutation.mutateAsync({
          name: validationResult.data.organizationName,
          autoAddCreator: true,
          plan: 'enterprise',
          company_domain: companyDomain.trim() || undefined,
        })
      ).organization.id;

      // Redirect with query param that will force users to invite a single user.
      window.location.href = `/organizations/${orgId}/welcome?firstTime=1`;
    } catch (error) {
      console.error('Failed to create organization:', error);
      setErrors({
        general:
          error instanceof Error
            ? error.message
            : 'Failed to create organization. Please try again.',
      });
      setIsSubmitting(false);
    }
  };

  const isFormValid = name.trim().length > 0;

  return (
    <div className="bg-background mx-auto h-full w-full max-w-[1200px] px-4 py-8 md:px-6 md:py-12">
      <div className="mb-10 text-center">
        <h1 className="mb-2 text-3xl font-bold lg:text-4xl">
          Create an organization and start your
          <br />
          30-day free trial for Kilo Enterprise
        </h1>
        <Link
          href="/get-started/personal"
          className="text-foreground text-lg underline underline-offset-4 hover:opacity-80"
        >
          Or continue as individual instead.
        </Link>
      </div>

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 lg:grid-cols-2">
        <Card className="border-2">
          <CardContent className="p-6 lg:p-8">
            <h3 className="mb-4 text-lg font-bold">What your Kilo Enterprise trial includes:</h3>
            <ul className="space-y-2">
              {enterpriseTrialFeatures.map((feature, index) => {
                const Icon = feature.icon;
                return (
                  <li key={index} className="flex items-start gap-2">
                    <Icon className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>{feature.text}</span>
                  </li>
                );
              })}
              <li className="flex items-start gap-2">
                <Coins className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                <span className="font-bold">
                  Pay as you go usage based pricing, no tokens included in trial
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card className="border-2">
            <CardContent className="flex min-h-[140px] items-center justify-center p-6 lg:p-8">
              <form onSubmit={handleSubmit} className="w-full space-y-4">
                <AnimatePresence>
                  {errors.general && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-2 rounded-lg bg-red-950/30 p-4 text-sm text-red-400"
                    >
                      <AlertCircle className="h-4 w-4" />
                      <span>{errors.general}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                <Input
                  ref={nameInputRef}
                  id="name"
                  name="name"
                  value={name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  placeholder="Company Name"
                  className={`h-12 text-center text-lg transition-all duration-200 focus:ring-2 ${
                    errors.name ? 'border-red-400 focus:ring-red-400/20' : 'focus:ring-blue-500/20'
                  }`}
                  autoFocus
                />
                <Input
                  id="company_domain"
                  name="company_domain"
                  value={companyDomain}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setCompanyDomain(e.target.value)
                  }
                  placeholder="Company Website (e.g. acme.com)"
                  className={`h-12 text-center text-lg transition-all duration-200 focus:ring-2 focus:ring-blue-500/20`}
                />
                <AnimatePresence>
                  {errors.name && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center justify-center gap-2 text-sm text-red-400"
                    >
                      <AlertCircle className="h-4 w-4" />
                      <span>{errors.name}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </form>
            </CardContent>
          </Card>

          <Card className="border-2">
            <CardContent className="p-6 text-center lg:p-8">
              <Button
                type="button"
                variant="primary"
                size="lg"
                className="mb-4 h-auto px-6 py-4 text-lg"
                disabled={!isFormValid || isSubmitting}
                onClick={handleSubmit}
              >
                {isSubmitting ? (
                  'Processing...'
                ) : (
                  <span className="flex items-center gap-2">
                    Start 30-day free trial for Kilo Enterprise
                    <ArrowRight className="h-5 w-5" />
                  </span>
                )}
              </Button>
              <p className="text-muted-foreground italic">
                (after the trial pricing for Kilo Teams starts at $15 per user/month, billed
                annually. You can choose your tier at the end of your trial)
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
