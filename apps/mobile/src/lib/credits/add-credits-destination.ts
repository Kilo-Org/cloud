import { type ChatPlace } from '@/lib/chat/scope';
import { WEB_BASE_URL } from '@/lib/config';

/**
 * Where an Add credits action leads.
 *
 * A send draws on one balance: the person's own credit, or the organization
 * whose scope the chat is in. The purchase that settles the refusal is the one
 * of that balance, so the action carries its destination instead of one handler
 * every refusal shares — an organization chat must never lead to the in-app
 * store packs, which credit the person alone.
 *
 * The organization's own page is the destination the organization hub and the
 * Profile credits card offer for the same balance.
 */
export type AddCreditsDestination =
  /** The in-app purchase screen, which sells the person's own credit packs. */
  | { readonly kind: 'inApp'; readonly onPress: () => void }
  /** The web billing page where the organization's balance is topped up. */
  | { readonly kind: 'organization'; readonly url: string };

/** The page where an organization tops up the balance its chats spend. */
export function organizationBillingUrl(organizationId: string): string {
  return `${WEB_BASE_URL}/organizations/${organizationId}/payment-details`;
}

/**
 * The page where a person manages their own billing: payment methods, auto
 * top-up, and the purchase history the app keeps out of reach behind the App
 * Store's purchase-link rule.
 */
export function personalBillingUrl(): string {
  return `${WEB_BASE_URL}/credits`;
}

/**
 * The Add credits destination of the balance a session or chat spends.
 *
 * A surface that records the organization paying for it settles a refusal on
 * that organization's own page; a surface with none spends the person's own
 * balance and keeps the in-app purchase screen.
 */
export function addCreditsDestinationFor(
  organizationId: string | undefined,
  inApp: () => void
): AddCreditsDestination {
  return organizationId === undefined
    ? { kind: 'inApp', onPress: inApp }
    : { kind: 'organization', url: organizationBillingUrl(organizationId) };
}

/**
 * The Add credits destination of the balance a chat's place spends.
 *
 * An organization's chat draws on that organization's balance, so a refusal
 * there is settled on the organization's own page; a person's chat keeps the
 * in-app purchase screen. A place that is not resolved yet names no payer, so
 * the caller offers no destination rather than guessing the person's own.
 */
export function addCreditsDestinationOf(
  place: Pick<ChatPlace, 'org'> | null,
  inApp: () => void
): AddCreditsDestination | undefined {
  if (place === null) {
    return undefined;
  }
  return addCreditsDestinationFor(
    place.org.kind === 'organization' ? place.org.id : undefined,
    inApp
  );
}

/**
 * The Add credits element's press props for a destination. A destination the
 * platform may not open renders nothing there — the element's own decision —
 * so a call site keeps no copy about a control it does not draw.
 */
export function addCreditsProps(destination: AddCreditsDestination) {
  return destination.kind === 'inApp' ? { onPress: destination.onPress } : { url: destination.url };
}
