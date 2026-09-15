/**
 * Whether this browser is a phone or tablet, for the one rule that depends on
 * it: the lower pixel limit a phone's page can process (`MAX_PHONE_SOURCE_PIXELS`,
 * decisions.md #91).
 *
 * A user-agent test, deliberately narrow. There is no standard way to ask a
 * page how much memory it may use — Safari exposes neither
 * `navigator.deviceMemory` nor the memory API — and the limit that killed the
 * page belongs to the device, not to the browser engine. iPadOS reports a
 * desktop Safari user agent by default, so a Mac-looking agent with a
 * touchscreen is counted as a tablet: no Mac has one.
 */

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

export function hasPhoneMemoryLimits(nav: NavigatorLike): boolean {
  if (/iPhone|iPad|iPod|Android/i.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

/** The running browser's answer. */
export function isPhoneBrowser(): boolean {
  return typeof navigator !== 'undefined' && hasPhoneMemoryLimits(navigator);
}
