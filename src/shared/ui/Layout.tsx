import type { ReactNode } from 'react';
import { Link } from './Link.tsx';
import { routes } from './api.ts';

interface LayoutProps {
  /**
   * The timeline *is* the site, so its header renders the site name as the
   * page's h1. The other states are not the site's front page and render it as
   * a plain link instead.
   */
  isHome?: boolean;
  /**
   * Rendered in the header after the site title.
   *
   * The viewer passes nothing — its header is the site's name and nothing
   * else. The admin fills it with Trash and Export catalog, which is the whole
   * difference between the two headers.
   */
  nav?: ReactNode;
  children: ReactNode;
}

/**
 * Page chrome: the site title, and whatever nav the app adds beside it.
 *
 * Restrained on purpose — neutral surfaces, system type, no decorative UI
 * competing with the photographs. There are no breadcrumbs because there is
 * nowhere to climb to: years, months, and days are headings on one page.
 */
export function Layout({ isHome = false, nav, children }: LayoutProps) {
  return (
    <div className="layout">
      <header className="layout__header">
        {/* A link even on the timeline, where it is the heading as well: the
            URL follows the section being read, so the site's own name is the
            way back to the plain address and the top of the library. */}
        {isHome ? (
          <h1 className="layout__site-title">
            <Link to={routes.home()} className="layout__site-link">
              {__SITE_TITLE__}
            </Link>
          </h1>
        ) : (
          <Link to={routes.home()} className="layout__site-title">
            {__SITE_TITLE__}
          </Link>
        )}

        {nav ? <nav className="layout__nav">{nav}</nav> : null}
      </header>

      <main className="layout__main">{children}</main>
    </div>
  );
}
