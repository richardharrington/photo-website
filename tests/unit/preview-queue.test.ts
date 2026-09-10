import { describe, it, expect } from 'vitest';
import { runSerially } from '../../src/pipeline/preview.ts';

/**
 * The rule this queue exists for: **one decode at a time, ever**.
 *
 * Several simultaneous large decodes are the memory risk that crashed Firefox
 * on a fourth consecutive file and that keeps the upload pipeline serial
 * (decisions.md #20, #21). The Inbox's Show all hands six of them over at
 * once, so nothing but this stops six libheif decodes running together.
 *
 * The chain is module-global and shared with `decodePreview`, which is the
 * point — a decode asked for by a row and one asked for by Show all must queue
 * behind each other, not merely behind their own kind.
 */
describe('runSerially', () => {
  /** A job that reports when it starts and finishes, and resolves on demand. */
  function job(log: string[], name: string) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      log.push(`start ${name}`);
      await gate;
      log.push(`end ${name}`);
      return name;
    };
    return { run, release: () => release() };
  }

  it('never lets two run at once, however many are handed over together', async () => {
    const log: string[] = [];
    const a = job(log, 'a');
    const b = job(log, 'b');
    const c = job(log, 'c');

    // All three asked for in the same tick, as Show all does.
    const all = Promise.all([
      runSerially(a.run),
      runSerially(b.run),
      runSerially(c.run),
    ]);

    // Only the first has begun; the other two are waiting their turn.
    await Promise.resolve();
    expect(log).toEqual(['start a']);

    a.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['start a', 'end a', 'start b']);

    b.release();
    c.release();
    expect(await all).toEqual(['a', 'b', 'c']);

    // Every start is immediately preceded by the previous end: no overlap.
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('lets the next one start after a failure, rather than wedging', async () => {
    const failing = runSerially(async () => {
      throw new Error('that file is broken');
    });
    await expect(failing).rejects.toThrow('that file is broken');

    // One rejected decode must not stop every later one for the session.
    await expect(runSerially(async () => 'after')).resolves.toBe('after');
  });

  it('runs in the order it was asked, not the order things resolve', async () => {
    const log: string[] = [];
    const slow = runSerially(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push('slow');
    });
    const quick = runSerially(async () => {
      log.push('quick');
    });

    await Promise.all([slow, quick]);
    expect(log).toEqual(['slow', 'quick']);
  });
});
