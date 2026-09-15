import { describe, expect, it } from 'vitest';
import { validateSource } from '../../src/pipeline/validate.ts';
import { hasPhoneMemoryLimits } from '../../src/shared/ui/device.ts';
import { MAX_PHONE_SOURCE_PIXELS } from '../../src/shared/constants.ts';

/**
 * The phone pixel limit (decisions.md #91).
 *
 * On an iPhone 12, a 48 MP photograph took Safari's page past its 1,536 MB
 * limit and the page reloaded with nothing said. The rule refuses such a file
 * before the decode instead, with a message saying where it will work; these
 * pin the threshold, the order of the checks, and who counts as a phone.
 */

/** The first bytes of a PNG claiming these dimensions — all the check reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

const MP_48 = pngHeader(8064, 6048);
const MP_24 = pngHeader(5664, 4248);
const MP_12 = pngHeader(4032, 3024);

describe('the phone pixel limit', () => {
  it('sits between the 24 MP photograph that worked and the 48 MP one that did not', () => {
    expect(5664 * 4248).toBeLessThan(MAX_PHONE_SOURCE_PIXELS);
    expect(8064 * 6048).toBeGreaterThan(MAX_PHONE_SOURCE_PIXELS);
  });

  it('refuses a 48 MP photograph from a phone, saying where it will work', () => {
    const outcome = validateSource(7_500_000, MP_48, { phone: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('too-many-pixels-for-phone');
    expect(outcome.message).toBe(
      'This photo is 48.8 MP, too large to add from a phone. It will work if you ' +
        'add it from a laptop, or email it in (ask the site admin how).',
    );
  });

  it('accepts the 24 MP and 12 MP photographs a phone processed', () => {
    expect(validateSource(5_000_000, MP_24, { phone: true }).ok).toBe(true);
    expect(validateSource(3_000_000, MP_12, { phone: true }).ok).toBe(true);
  });

  it('leaves a laptop to process the 48 MP photograph', () => {
    expect(validateSource(7_500_000, MP_48).ok).toBe(true);
    expect(validateSource(7_500_000, MP_48, { phone: false }).ok).toBe(true);
  });

  it('still gives the general limit first, which applies everywhere', () => {
    const outcome = validateSource(9_000_000, pngHeader(9000, 6000), { phone: true });
    expect(outcome.ok === false && outcome.code).toBe('too-many-pixels');
  });
});

describe('who counts as a phone', () => {
  const agents = {
    iPhone:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    iPadMobile:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    desktopSafari:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    android:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    windowsChrome:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    firefoxMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0',
  };

  it('counts iPhones, iPads, and Android devices', () => {
    expect(hasPhoneMemoryLimits({ userAgent: agents.iPhone })).toBe(true);
    expect(hasPhoneMemoryLimits({ userAgent: agents.iPadMobile })).toBe(true);
    expect(hasPhoneMemoryLimits({ userAgent: agents.android })).toBe(true);
  });

  it('counts an iPad that reports a desktop user agent, by its touchscreen', () => {
    expect(
      hasPhoneMemoryLimits({ userAgent: agents.desktopSafari, maxTouchPoints: 5 }),
    ).toBe(true);
  });

  it('does not count a laptop, whatever its browser', () => {
    expect(
      hasPhoneMemoryLimits({ userAgent: agents.desktopSafari, maxTouchPoints: 0 }),
    ).toBe(false);
    expect(hasPhoneMemoryLimits({ userAgent: agents.windowsChrome })).toBe(false);
    expect(
      hasPhoneMemoryLimits({ userAgent: agents.firefoxMac, maxTouchPoints: 0 }),
    ).toBe(false);
  });
});
