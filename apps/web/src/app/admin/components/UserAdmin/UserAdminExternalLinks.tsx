import { Card, CardContent } from '@/components/ui/card';
import { SquareArrowOutUpRight } from 'lucide-react';
import type { UserDetailProps } from '@/types/admin';
import { createHash } from 'crypto';

function getGravatarUrl(email: string, size: number = 80): string {
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

export function UserAdminExternalLinks({
  stripe_customer_id,
  google_user_email,
  google_user_name,
}: UserDetailProps) {
  const gravatarUrl = getGravatarUrl(google_user_email);

  return (
    <Card className="h-fit">
      <CardContent className="flex flex-wrap items-center gap-3 pt-5">
        <a
          href={`https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}customers/${stripe_customer_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-purple-950 px-3 py-2 text-sm font-medium text-purple-200 transition-colors hover:bg-purple-900"
        >
          Stripe
          <SquareArrowOutUpRight size={14} />
        </a>
        <a
          href={`https://haveibeenpwned.com/account/${encodeURIComponent(google_user_email)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-orange-950 px-3 py-2 text-sm font-medium text-orange-200 transition-colors hover:bg-orange-900"
          title="Check if this email has been exposed in any data breaches"
        >
          HIBP
          <SquareArrowOutUpRight size={14} />
        </a>
        <div className="flex items-center gap-2">
          <img
            src={gravatarUrl}
            alt={`Gravatar for ${google_user_name}`}
            className="border-border h-8 w-8 rounded-full border"
          />
          <span className="text-muted-foreground text-xs">Gravatar</span>
        </div>
      </CardContent>
    </Card>
  );
}
