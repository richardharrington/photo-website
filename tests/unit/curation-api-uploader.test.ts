import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOADER_HEADER } from '../../src/shared/uploader.ts';
import type { Uploader } from '../../src/shared/ui/uploader.ts';

/**
 * The curation client carries the family's token and remembers what it
 * committed, once and only once the family app configures an uploader
 * (family-own-trash.md 6.3). The admin never configures one.
 */

const TOKEN = 'ab'.repeat(32);
const PHOTO = 'c'.repeat(32);

function fakeUploader(): Uploader & { remembered: string[] } {
  const remembered: string[] = [];
  return {
    token: TOKEN,
    persistent: true,
    remembered,
    addedHere: (id) => remembered.includes(id),
    remember: (id) => void remembered.push(id),
  };
}

/** A fresh module each time: the configured uploader is module state. */
async function client() {
  vi.resetModules();
  return import('../../src/shared/ui/curation-api.ts');
}

function replyWith(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sentHeaders = (fetchMock: ReturnType<typeof replyWith>) =>
  fetchMock.mock.calls[0]![1].headers as Record<string, string>;

const commitBody = {
  photoId: PHOTO,
  contentHash: 'e'.repeat(64),
  originalFilename: 'new.jpg',
  sourceMimeType: 'image/jpeg',
  captureDate: null,
  captureTime: null,
  captureUtcOffset: null,
  timestampSource: 'none',
  caption: null,
  batchSeq: 1,
  selectionIndex: 0,
  derivatives: {} as never,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the curation client', () => {
  it('sends no uploader token until one is configured', async () => {
    const { curationApi } = await client();
    const fetchMock = replyWith({ count: 0 });

    await curationApi.trashCount();
    expect(sentHeaders(fetchMock)).not.toHaveProperty(UPLOADER_HEADER);
  });

  it('sends the token on every request once configured, GET and POST alike', async () => {
    const { configureUploader, curationApi } = await client();
    configureUploader(fakeUploader());

    let fetchMock = replyWith({ count: 0 });
    await curationApi.trashCount();
    expect(sentHeaders(fetchMock)[UPLOADER_HEADER]).toBe(TOKEN);

    fetchMock = replyWith({ restored: [], count: 0 });
    await curationApi.restore([PHOTO]);
    expect(sentHeaders(fetchMock)[UPLOADER_HEADER]).toBe(TOKEN);
    expect(sentHeaders(fetchMock)['content-type']).toBe('application/json');
  });

  it('remembers a photograph it created', async () => {
    const { configureUploader, curationApi } = await client();
    const uploader = fakeUploader();
    configureUploader(uploader);
    replyWith({ status: 'created', photo: { id: PHOTO } });

    await curationApi.commit(commitBody);
    expect(uploader.remembered).toEqual([PHOTO]);
  });

  it('remembers nothing for a duplicate, which is somebody else’s photograph', async () => {
    const { configureUploader, curationApi } = await client();
    const uploader = fakeUploader();
    configureUploader(uploader);
    replyWith({
      status: 'duplicate',
      existingId: 'd'.repeat(32),
      existingTrashed: false,
    });

    await curationApi.commit(commitBody);
    expect(uploader.remembered).toEqual([]);
  });
});
