'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import BigLoader from '@/components/BigLoader';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';

const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 90_000;
const REDIRECT_SECONDS = 5;

type ActivationStep = 'payment' | 'credits' | 'hosting' | 'done';

function StepIcon({ status }: { status: 'done' | 'active' | 'pending' }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'active':
      return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;
    case 'pending':
      return <Circle className="text-muted-foreground h-5 w-5" />;
  }
}

function stepStatus(step: ActivationStep, current: ActivationStep): 'done' | 'active' | 'pending' {
  const order: ActivationStep[] = ['payment', 'credits', 'hosting', 'done'];
  const stepIndex = order.indexOf(step);
  const currentIndex = order.indexOf(current);
  if (stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return 'active';
  return 'pending';
}

export function KiloPassAwardingCreditsClient() {
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [didTimeout, setDidTimeout] = useState(false);
  const [redirectSecondsRemaining, setRedirectSecondsRemaining] = useState<number | null>(null);

  const clawHostingPlan = searchParams.get('clawHostingPlan');
  const clawInstanceId = searchParams.get('clawInstanceId');
  const isClawAutoActivation = !!clawHostingPlan;

  const [activationStep, setActivationStep] = useState<ActivationStep>('payment');
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);

  const enrollWithCredits = useMutation(
    trpc.kiloclaw.enrollWithCredits.mutationOptions({
      onSuccess: () => {
        setActivationStep('done');
      },
      onError: error => {
        setEnrollmentError(error.message);
      },
    })
  );

  // Track whether we've already triggered enrollment to prevent double-fire
  const enrollmentTriggered = useRef(false);

  useEffect(() => {
    const timerId = setTimeout(() => {
      setDidTimeout(true);
    }, TIMEOUT_MS);

    return () => {
      clearTimeout(timerId);
    };
  }, []);

  const query = useQuery({
    ...trpc.kiloPass.getCheckoutReturnState.queryOptions(),
    refetchInterval: query => {
      const data = query.state.data;
      if (didTimeout) return false;
      if (data?.creditsAwarded === true) return false;
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: true,
    retry: false,
  });

  const isReady = query.data?.creditsAwarded === true;
  const hasSubscription = query.data?.subscription != null;

  // For KiloClaw auto-activation: advance step when credits are awarded, then enroll
  useEffect(() => {
    if (!isClawAutoActivation || !isReady) return;
    if (activationStep === 'payment') {
      setActivationStep('credits');
    }
  }, [isClawAutoActivation, isReady, activationStep]);

  useEffect(() => {
    if (!isClawAutoActivation || activationStep !== 'credits') return;

    // Credits awarded — trigger enrollment
    setActivationStep('hosting');
    if (
      !enrollmentTriggered.current &&
      (clawHostingPlan === 'standard' || clawHostingPlan === 'commit')
    ) {
      enrollmentTriggered.current = true;
      enrollWithCredits.mutate({
        plan: clawHostingPlan,
        ...(clawInstanceId ? { instanceId: clawInstanceId } : {}),
      });
    }
  }, [
    isClawAutoActivation,
    activationStep,
    clawHostingPlan,
    clawInstanceId,
    enrollWithCredits.mutate,
  ]);

  // Standard (non-KiloClaw) flow: redirect to /profile when ready
  useEffect(() => {
    if (isClawAutoActivation) return;
    if (!isReady) return;

    setRedirectSecondsRemaining(REDIRECT_SECONDS);

    const intervalId = setInterval(() => {
      setRedirectSecondsRemaining(previous => {
        if (previous == null) return previous;
        if (previous <= 0) return 0;
        return previous - 1;
      });
    }, 1000);

    const timeoutId = setTimeout(() => {
      router.replace('/profile');
    }, REDIRECT_SECONDS * 1000);

    return () => {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
  }, [isClawAutoActivation, isReady, router]);

  // KiloClaw flow: redirect to /claw when activation is done
  useEffect(() => {
    if (!isClawAutoActivation || activationStep !== 'done') return;

    setRedirectSecondsRemaining(REDIRECT_SECONDS);

    const intervalId = setInterval(() => {
      setRedirectSecondsRemaining(previous => {
        if (previous == null) return previous;
        if (previous <= 0) return 0;
        return previous - 1;
      });
    }, 1000);

    const timeoutId = setTimeout(() => {
      router.replace('/claw');
    }, REDIRECT_SECONDS * 1000);

    return () => {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
  }, [isClawAutoActivation, activationStep, router]);

  const fallbackDestination = isClawAutoActivation ? '/claw' : '/profile';
  const fallbackLabel = isClawAutoActivation ? 'Go to KiloClaw' : 'Go to profile';

  if (query.isError) {
    return (
      <PageContainer>
        <div className="flex min-h-[70vh] items-center justify-center">
          <Card className="w-full max-w-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Something went wrong
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="text-muted-foreground text-sm">
                We couldn't confirm your subscription status. This is usually temporary.
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.replace(fallbackDestination)}
                >
                  {fallbackLabel}
                </Button>
              </div>

              <div className="text-muted-foreground text-sm">
                If this keeps happening, contact support at{' '}
                <a href="https://kilo.ai/support" className="text-primary underline">
                  https://kilo.ai/support
                </a>
                .
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  if (didTimeout && !isReady) {
    return (
      <PageContainer>
        <div className="flex min-h-[70vh] items-center justify-center">
          <Card className="w-full max-w-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Still processing
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="text-muted-foreground text-sm">
                We haven't finished awarding your credits yet. Your payment may still be processing
                on Stripe.
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.replace(fallbackDestination)}
                >
                  {fallbackLabel}
                </Button>
              </div>

              <div className="text-muted-foreground text-sm">
                If your credits don't show up, contact support at{' '}
                <a href="https://kilo.ai/support" className="text-primary underline">
                  https://kilo.ai/support
                </a>
                .
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  // KiloClaw auto-activation: show progress steps
  if (isClawAutoActivation) {
    // Enrollment error: show fallback with manual activation option
    if (enrollmentError) {
      return (
        <PageContainer>
          <div className="flex min-h-[70vh] items-center justify-center">
            <Card className="w-full max-w-xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" />
                  Hosting activation failed
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="text-muted-foreground text-sm">
                  Your credits were added successfully, but we couldn't activate hosting
                  automatically: {enrollmentError}
                </div>
                <div className="text-muted-foreground text-sm">
                  You can activate hosting manually from the KiloClaw dashboard.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => router.replace('/claw')}>
                    Go to KiloClaw
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </PageContainer>
      );
    }

    // Activation complete
    if (activationStep === 'done') {
      const secondsToShow = redirectSecondsRemaining ?? REDIRECT_SECONDS;
      return (
        <PageContainer>
          <div className="flex min-h-[70vh] items-center justify-center">
            <Card className="w-full max-w-xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                  Hosting activated
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <ActivationSteps current="done" />
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" onClick={() => router.replace('/claw')}>
                    Continue to KiloClaw
                  </Button>
                  <div className="text-muted-foreground text-sm">
                    Redirecting in {secondsToShow} seconds.
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </PageContainer>
      );
    }

    // In-progress activation steps
    return (
      <PageContainer>
        <div className="flex min-h-[70vh] items-center justify-center">
          <Card className="w-full max-w-xl">
            <CardHeader>
              <CardTitle>Setting up your hosting</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ActivationSteps current={activationStep} />
              <div className="text-muted-foreground text-sm">
                This can take a few seconds while we finalize your setup.
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  // Standard (non-KiloClaw) flow: credits awarded
  if (isReady) {
    const secondsToShow = redirectSecondsRemaining ?? REDIRECT_SECONDS;

    return (
      <PageContainer>
        <div className="flex min-h-[70vh] items-center justify-center">
          <Card className="w-full max-w-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5" />
                Credits awarded
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="text-muted-foreground text-sm">
                Your Kilo Pass is active and your credits are ready.
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={() => router.replace('/profile')}>
                  Continue to profile
                </Button>
                <div className="text-muted-foreground text-sm">
                  Redirecting to profile in {secondsToShow} seconds.
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  const loaderTitle = hasSubscription ? 'Awarding your credits' : 'Finalizing your subscription';
  const loaderDescription = hasSubscription
    ? 'This can take a few seconds while we confirm payment and issue credits.'
    : 'This can take a few seconds while Stripe confirms your checkout.';

  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-center gap-6">
        <BigLoader title={loaderTitle} />
        <div className="text-muted-foreground max-w-xl text-center text-sm">
          {loaderDescription}
        </div>
      </div>
    </PageContainer>
  );
}

const ACTIVATION_STEPS = [
  { key: 'payment', label: 'Payment received' },
  { key: 'credits', label: 'Credits added to balance' },
  { key: 'hosting', label: 'Activating hosting...' },
  { key: 'done', label: 'Hosting activated!' },
] as const;

function ActivationSteps({ current }: { current: ActivationStep }) {
  return (
    <div className="space-y-3">
      {ACTIVATION_STEPS.map(({ key, label }) => {
        const status = stepStatus(key, current);
        return (
          <div key={key} className="flex items-center gap-3">
            <StepIcon status={status} />
            <span
              className={
                status === 'pending' ? 'text-muted-foreground text-sm' : 'text-foreground text-sm'
              }
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
