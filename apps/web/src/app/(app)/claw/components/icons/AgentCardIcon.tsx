// The real Agentcard brand mark, taken from agentcard.sh
// (public/landing/home/agentcard-logo-new.svg): a filled card with a chip
// grid. The website asset uses a white gradient (for dark backgrounds); here
// we fill with currentColor so the mark inherits the surrounding text color
// and works in both light and dark themes. viewBox preserves the logo's
// natural 39:28 aspect ratio.
export function AgentCardIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 39 28"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.925 0H36.075C38.025 0 39 0.982456 39 2.94737V25.0526C39 27.0175 38.025 28 36.075 28H2.925C0.975 28 0 27.0175 0 25.0526V2.94737C0 0.982456 0.975 0 2.925 0ZM9.2625 6.14035H29.7375V6.87719H9.2625V6.14035ZM9.2625 21.1228H29.7375V21.8596H9.2625V21.1228ZM9.2625 6.87719H9.99375V21.1228H9.2625V6.87719ZM29.0062 6.87719H29.7375V21.1228H29.0062V6.87719ZM9.99375 14.4912H29.0062V15.2281H9.99375V14.4912ZM19.0125 6.87719H19.7437V14.4912H19.0125V6.87719Z"
        fill="currentColor"
      />
    </svg>
  );
}
