import type { ComponentPropsWithoutRef } from 'react';
import { useLinkProps } from './navigation.ts';

interface LinkProps extends Omit<ComponentPropsWithoutRef<'a'>, 'href'> {
  to: string;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

/**
 * An internal link. Renders a real anchor with an `href` so it can be copied,
 * middle-clicked, and opened in a new tab; the click handler keeps ordinary
 * navigation client-side.
 *
 * A caller's own `onClick` runs first and may call `preventDefault`, which the
 * navigation handler honours by leaving the click alone. That is how the
 * admin's tiles turn a modifier-click into a selection rather than a
 * navigation without needing a second element to click on.
 */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const { href, onClick: navigateOnClick } = useLinkProps(to, {
    replace: replace ?? false,
  });
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        navigateOnClick(event);
      }}
    />
  );
}
