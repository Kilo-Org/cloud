import type { JSX } from 'react';

interface KiloMarkProps {
  className?: string;
}

export const KiloMark = ({ className }: KiloMarkProps): JSX.Element => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    viewBox="0 0 100 100"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M50 0C77.6142 0 100 22.3858 100 50C100 77.6142 77.6142 100 50 100C22.3858 100 0 77.6142 0 50C0 22.3858 22.3858 0 50 0ZM71 65V35C71 31.6863 68.3137 29 65 29H35C31.6863 29 29 31.6863 29 35V65C29 68.3137 31.6863 71 35 71H65C68.3137 71 71 68.3137 71 65Z"
      fill="currentColor"
      fillRule="evenodd"
    />
  </svg>
);
