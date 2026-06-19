import Link from 'next/link';
import { ArrowLeft, CheckCircle2, FileText, GitBranch, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SetPageTitle } from '@/components/SetPageTitle';

type ReviewMdGuideContentProps = {
  backHref?: string;
  backLabel?: string;
};

const setupSteps = [
  'Create REVIEW.md at the repository root.',
  'Commit it to the base branch used by pull requests or merge requests.',
  'Open Code Reviewer settings and enable Use REVIEW.md.',
  'Save the configuration and run a review.',
];

const guidanceItems = [
  'Repository invariants and business rules that reviewers must preserve.',
  'Severity calibration, including what Kilo should not flag.',
  'Testing and verification expectations for changed code.',
  'Security and performance concerns specific to the codebase.',
  'Preferred review summary and comment style.',
];

const limits = [
  'Hard safety, tooling, platform, and read-only constraints still apply.',
  'Custom instructions and focus areas are still applied around repository guidance.',
  '@ imports are not expanded. Keep the guidance directly in REVIEW.md.',
  'Content is truncated after 10,000 characters.',
  'Do not include secrets, credentials, tokens, or private operational data.',
];

const exampleReviewMd = `# REVIEW.md

## What matters in this repository
- Preserve tenant isolation for every database query.
- Treat billing, auth, and deletion flows as high-risk changes.
- Prefer small, explicit fixes over broad refactors.

## Severity calibration
- Critical: data loss, privilege escalation, token exposure, billing errors.
- Warning: missing validation, unsafe defaults, untested edge cases.
- Do not flag formatting-only differences when tooling already enforces them.

## Verification expectations
- New business rules need tests that assert the observable result.
- Database changes need migration coverage and rollback-aware review.
- UI changes should preserve keyboard and screen reader behavior.
`;

export function ReviewMdGuideContent({
  backHref = '/code-reviews',
  backLabel = 'Back to Code Reviewer',
}: ReviewMdGuideContentProps) {
  return (
    <>
      <SetPageTitle title="REVIEW.md guide" />

      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="w-fit px-0" asChild>
          <Link href={backHref}>
            <ArrowLeft className="size-4" />
            {backLabel}
          </Link>
        </Button>

        <div className="space-y-3">
          <Badge variant="secondary-outline" className="w-fit">
            <FileText className="size-3" />
            Code Reviewer guidance
          </Badge>
          <div className="max-w-3xl space-y-3">
            <h1 className="text-3xl font-bold tracking-tight">
              Use REVIEW.md for repository review guidance
            </h1>
            <p className="text-muted-foreground text-base">
              Add a root REVIEW.md file so Kilo applies repository-specific standards during
              automated reviews. This keeps review policy with the codebase and gives teams a single
              place to document what matters.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <CheckCircle2 className="text-muted-foreground size-5" />
                Set it up
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {setupSteps.map((step, index) => (
                  <li key={step} className="flex gap-3 text-sm">
                    <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <GitBranch className="text-muted-foreground size-5" />
                How Kilo uses it
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                Kilo reads REVIEW.md from the pull request or merge request base branch, not from
                the feature branch. This prevents an unreviewed change from rewriting the review
                policy that evaluates it.
              </p>
              <p>
                REVIEW.md works for GitHub and GitLab. If the file is disabled, missing, empty, or
                unreadable, Kilo falls back to built-in review guidance.
              </p>
              <p>
                When REVIEW.md is used, Kilo adds a footer to the review summary. The footer notes
                that guidance came from the base branch and indicates whether the file was
                truncated.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Example REVIEW.md</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted/40 overflow-x-auto rounded-lg border p-4 text-sm">
                <code>{exampleReviewMd}</code>
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">What to include</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm text-muted-foreground">
                {guidanceItems.map(item => (
                  <li key={item} className="flex gap-2">
                    <span className="bg-primary mt-2 size-1.5 shrink-0 rounded-full" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <ShieldCheck className="text-muted-foreground size-5" />
                Limits and precedence
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm text-muted-foreground">
                {limits.map(limit => (
                  <li key={limit} className="flex gap-2">
                    <span className="bg-muted-foreground mt-2 size-1.5 shrink-0 rounded-full" />
                    <span>{limit}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
