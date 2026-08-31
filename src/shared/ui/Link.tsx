import type { ReactNode } from 'react';
import { useLinkProps } from './navigation.ts';

interface LinkProps {
  to: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}

/**
 * An internal link. Renders a real anchor with an `href` so it can be copied,
 * middle-clicked, and opened in a new tab; the click handler keeps ordinary
 * navigation client-side.
 */
export function Link({ to, className, children, ...rest }: LinkProps) {
  const props = useLinkProps(to);
  return (
    <a {...props} className={className} aria-label={rest['aria-label']}>
      {children}
    </a>
  );
}
