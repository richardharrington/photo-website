import type { ReactNode } from 'react';
import { Link } from '../../shared/ui/Link.tsx';
import { routes } from '../api.ts';

interface LayoutProps {
  /**
   * The timeline *is* the site, so its header renders the site name as the
   * page's h1. The other states are not the site's front page and render it as
   * a plain link instead.
   */
  isHome?: boolean;
  children: ReactNode;
}

/**
 * Page chrome: the site title, and nothing else.
 *
 * Restrained on purpose — neutral surfaces, system type, no decorative UI
 * competing with the photographs. There are no breadcrumbs because there is
 * nowhere to climb to: years, months, and days are headings on one page.
 */
export function Layout({ isHome = false, children }: LayoutProps) {
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
      </header>

      <main className="layout__main">{children}</main>
    </div>
  );
}
