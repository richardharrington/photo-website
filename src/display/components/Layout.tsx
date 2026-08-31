import type { ReactNode } from 'react';
import { Link } from '../../shared/ui/Link.tsx';
import { routes } from '../api.ts';

export interface Crumb {
  label: string;
  href: string;
}

interface LayoutProps {
  /** Ancestors of the current page, nearest last. The page's own title is
   * rendered as a heading rather than as a final crumb. */
  crumbs?: readonly Crumb[];
  title?: string;
  subtitle?: string;
  /**
   * On the home page the site name *is* the page heading, so the header
   * renders it as the h1 and no separate title is shown. Elsewhere the header
   * is a link home and the page supplies its own heading.
   */
  isHome?: boolean;
  children: ReactNode;
}

/**
 * Page chrome: the site title, a breadcrumb trail, and the page heading.
 *
 * Restrained on purpose — neutral surfaces, system type, no decorative UI
 * competing with the photographs.
 */
export function Layout({
  crumbs = [],
  title,
  subtitle,
  isHome = false,
  children,
}: LayoutProps) {
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

      <main className="layout__main">
        {crumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="breadcrumbs">
            <ol>
              {crumbs.map((crumb) => (
                <li key={crumb.href}>
                  <Link to={crumb.href}>{crumb.label}</Link>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        {title ? <h1 className="layout__title">{title}</h1> : null}
        {subtitle ? <p className="layout__subtitle">{subtitle}</p> : null}

        {children}
      </main>
    </div>
  );
}

export interface GroupEntry {
  key: string;
  href: string;
  label: string;
  count: number;
}

function photoCount(count: number): string {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`;
}

/**
 * A year, month, or day index.
 *
 * Counts only: photos appear in their day grid and are never lifted onto an
 * index page as representative thumbnails.
 */
export function GroupList({ entries }: { entries: readonly GroupEntry[] }) {
  return (
    <ul className="group-list">
      {entries.map((entry) => (
        <li key={entry.key}>
          <Link to={entry.href} className="group-list__link">
            <span className="group-list__label">{entry.label}</span>
            <span className="group-list__count">{photoCount(entry.count)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
