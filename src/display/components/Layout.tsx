import type { ReactNode } from 'react';
import { Link } from '../../shared/ui/Link.tsx';
import { routes } from '../api.ts';

interface LayoutProps {
  /**
   * The timeline *is* the site, so its header renders the site name as the
   * page's h1. The photo view's own states are not the site's front page and
   * make the name a link home instead.
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
        {isHome ? (
          <h1 className="layout__site-title">{__SITE_TITLE__}</h1>
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
