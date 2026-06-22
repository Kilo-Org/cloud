export const KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION =
  'A monthly subscription that adds credits to your Kilo balance for running AI coding sessions in Kilo App — Cloud Agents, remote sessions, and KiloClaw chats.';

export function formatKiloPassTierDescription(webMonthlyPriceUsd: number): string {
  return `$${webMonthlyPriceUsd} paid credits added monthly for Kilo App usage.`;
}
