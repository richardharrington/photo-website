/**
 * The opaque-path routing decision, as a pure function.
 *
 * Separated from the Netlify plumbing in `gate.ts` so the security-critical
 * part — what is reachable, and as which access mode — can be tested directly
 * without an edge runtime.
 */

export type AccessMode = 'display' | 'admin';

export interface GateConfig {
  /** Secret path segment for the viewer, without slashes. */
  displayPath: string;
  /** Secret path segment for the admin app, without slashes. */
  adminPath: string;
}

export type RouteDecision =
  /** Serve robots.txt. The only thing reachable outside a secret path. */
  | { kind: 'robots' }
  /** Plain 404 revealing nothing about what routes exist. */
  | { kind: 'not-found' }
  /** A built static asset; let Netlify serve it from the publish directory. */
  | { kind: 'asset'; mode: AccessMode }
  /** An app route; rewrite to that app's index.html for client-side routing. */
  | { kind: 'app'; mode: AccessMode; indexPath: string }
  /** An API call; rewrite to the mode's function with the prefix stripped. */
  | { kind: 'api'; mode: AccessMode; functionPath: string; subPath: string };

const NOT_FOUND: RouteDecision = { kind: 'not-found' };

/**
 * Length-independent, content-independent string comparison.
 *
 * A timing side channel on a path prefix, across the internet and through a
 * CDN, is not a realistic way to recover a 128-bit secret. This is here
 * because it costs almost nothing and removes the question entirely.
 */
export function secureEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function configIsUsable(config: GateConfig): boolean {
  const { displayPath, adminPath } = config;
  if (displayPath === '' || adminPath === '') return false;
  if (displayPath.includes('/') || adminPath.includes('/')) return false;
  // Identical paths would make the display URL an admin URL. Fail closed.
  if (displayPath === adminPath) return false;
  return true;
}

/** A request for a built file rather than a client-side route. */
function looksLikeAsset(rest: string): boolean {
  const lastSegment = rest.slice(rest.lastIndexOf('/') + 1);
  return /\.[a-z0-9]{1,10}$/i.test(lastSegment);
}

/**
 * Decide what to do with a request path.
 *
 * `pathname` is expected to come from a parsed `URL`, which has already
 * resolved `.` and `..` segments, so a traversal cannot smuggle a path past
 * the prefix check.
 */
export function routeRequest(pathname: string, config: GateConfig): RouteDecision {
  if (pathname === '/robots.txt') return { kind: 'robots' };

  // A misconfigured gate serves nothing rather than serving everything.
  if (!configIsUsable(config)) return NOT_FOUND;

  const withoutLeadingSlash = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const slash = withoutLeadingSlash.indexOf('/');
  const segment =
    slash === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash);
  const rest = slash === -1 ? '' : withoutLeadingSlash.slice(slash);

  // Both comparisons always run, so the work done does not depend on which
  // path (if either) matched.
  const isDisplay = secureEquals(segment, config.displayPath);
  const isAdmin = secureEquals(segment, config.adminPath);
  if (!isDisplay && !isAdmin) return NOT_FOUND;

  const mode: AccessMode = isAdmin ? 'admin' : 'display';
  const base = `/${segment}`;

  if (rest === '' || rest === '/') {
    return { kind: 'app', mode, indexPath: `${base}/index.html` };
  }

  if (rest === '/api' || rest.startsWith('/api/')) {
    return {
      kind: 'api',
      mode,
      functionPath: `/.netlify/functions/${mode}`,
      subPath: rest.slice('/api'.length) || '/',
    };
  }

  if (looksLikeAsset(rest)) return { kind: 'asset', mode };

  return { kind: 'app', mode, indexPath: `${base}/index.html` };
}
