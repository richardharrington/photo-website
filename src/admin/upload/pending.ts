/**
 * A file still being processed, as the shared photo grid and photo view see it.
 *
 * The point of showing a photograph before it has finished uploading is that
 * its date and caption can be typed while the machine works — a batch off a
 * camera is a batch of wrong dates, and waiting for four encodes and four PUTs
 * before the first correction can be made is most of the time it takes to
 * curate a day. So a queued file is projected into the same `PublicPhoto` the
 * library uses, and the same grid and the same lightbox render it.
 *
 * The projection is honest about what is not known yet. Before the encoders
 * have run there are no derivatives and no picture, so the tile reserves a
 * neutral rectangle; the moment the artifacts exist they are shown from
 * object URLs, still well before the upload finishes.
 *
 * The identity is the queue item's, not a photo ID: until the commit lands
 * there is no catalog record and no address, which is why these tiles open in
 * place the way the trash's do.
 */

import { RENDITIONS, RENDITION_SPECS } from '../../shared/constants.ts';
import type { Rendition } from '../../shared/constants.ts';
import type { DerivativeDescriptor } from '../../shared/catalog.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';
import type { QueueItem } from './queue.ts';

/**
 * The shape a tile takes before anything has been decoded.
 *
 * A guess, and it has to be one: the true shape is known only after the decode
 * that orientation is applied in, and the alternative to guessing is a tile
 * with no height at all, which would make the whole grid jump as each picture
 * arrives instead of just its own tile. Three by two is the commonest
 * photograph.
 */
const PLACEHOLDER_RATIO = 3 / 2;

/** A full-resolution edge for the one rendition that has no maximum. */
const PLACEHOLDER_FULL_EDGE = 3000;

const PLACEHOLDER_DERIVATIVES = Object.fromEntries(
  RENDITIONS.map((rendition) => {
    const width = RENDITION_SPECS[rendition].maxEdge ?? PLACEHOLDER_FULL_EDGE;
    return [
      rendition,
      { width, height: Math.round(width / PLACEHOLDER_RATIO), bytes: 0 },
    ];
  }),
) as Record<Rendition, DerivativeDescriptor>;

/**
 * What stands in for the picture until the encoders have produced one.
 *
 * A translucent grey rectangle rather than nothing: an `img` with no usable
 * source shows the browser's broken-image mark, which reads as a failure. At
 * 35% it settles against both the light grid and the dark photo view without
 * a second asset or a stylesheet rule.
 */
export const PENDING_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2">' +
    '<rect width="3" height="2" fill="#808080" fill-opacity="0.35"/></svg>',
)}`;

/**
 * Project one queued file into a photo.
 *
 * What the administrator typed wins over what the file said about itself, and
 * wins as a whole: `edit` is the record of a save, so a cleared date is a
 * cleared date rather than a reason to fall back to EXIF.
 */
export function pendingPhoto(item: QueueItem): PublicPhoto {
  const timestamp = item.source?.timestamp;
  return {
    id: item.id,
    caption: item.edit?.caption ?? null,
    captureDate: item.edit ? item.edit.date : (timestamp?.date ?? null),
    captureTime: item.edit ? item.edit.time : (timestamp?.time ?? null),
    // Never typed, and never displayed as a field: it is the camera's own
    // offset, and it stays whatever the file said.
    captureUtcOffset: timestamp?.utcOffset ?? null,
    originalFilename: item.file.name,
    derivatives: item.preview?.derivatives ?? PLACEHOLDER_DERIVATIVES,
  };
}
