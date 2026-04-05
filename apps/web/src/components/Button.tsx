import type { LinkProps } from 'next/link';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'blue'
  | 'green'
  | 'red'
  | 'yellow'
  | 'gray'
  | 'purple'
  | 'indigo'
  | 'pink'
  | 'danger'
  | 'success'
  | 'warning'
  | 'info'
  | 'link'
  | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';
type KiloButtonStyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
};
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
};

type LinkButtonProps = LinkProps &
  KiloButtonStyleProps & { href: string } & Partial<Pick<HTMLAnchorElement, 'target'>>;

const baseStyles =
  'font-bold rounded-md focus:outline-hidden focus:ring-2 focus:ring-offset-2 bg-opacity-70 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';
const variantStyles = {
  primary: 'bg-[#2B6AD2] text-white hover:bg-[#225eb9] focus:ring-[#3b7de8]',
  secondary:
    'hover:bg-gray-700 hover:bg-opacity-90 focus:ring-gray-500 active:bg-gray-300 border border-gray-400',
  blue: 'bg-blue-700 text-white hover:bg-blue-800 focus:ring-blue-500',
  green: 'bg-green-700 text-white hover:bg-green-800 focus:ring-green-500',
  red: 'bg-red-700 text-white hover:bg-red-800 focus:ring-red-500',
  yellow: 'bg-yellow-600 text-white hover:bg-yellow-700 focus:ring-yellow-500',
  gray: 'bg-gray-700 text-white hover:bg-gray-800 focus:ring-gray-500',
  purple: 'bg-purple-700 text-white hover:bg-purple-800 focus:ring-purple-500',
  indigo: 'bg-indigo-700 text-white hover:bg-indigo-800 focus:ring-indigo-500',
  pink: 'bg-pink-700 text-white hover:bg-pink-800 focus:ring-pink-500',
  danger: 'bg-red-700 text-white hover:bg-red-800 focus:ring-red-500',
  success: 'bg-green-700 text-white hover:bg-green-800 focus:ring-green-500',
  warning: 'bg-yellow-600 text-white hover:bg-yellow-700 focus:ring-yellow-500',
  info: 'bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-400',
  link: 'text-gray-500 hover:underline focus:ring-gray-500 bg-transparent',
  outline: 'border border-gray-300 text-muted-foreground hover:bg-gray-800 focus:ring-gray-500',
};
const sizeStyles = {
  sm: 'px-3 py-1 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
  icon: 'p-2 text-sm',
};
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const buttonStyles = cn(baseStyles, variantStyles[variant], sizeStyles[size], className);
  return <button className={buttonStyles} {...props} />;
}

export function LinkButton({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: LinkButtonProps) {
  const buttonStyles = `${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`;

  return <Link className={buttonStyles} {...props} />;
}
