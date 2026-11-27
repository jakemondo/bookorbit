import { createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComicEpubConversionService } from './comic-epub-conversion.service';
import { KoboDeliveryService, type KoboDeliveryRecord } from './kobo-delivery.service';

async function writeCbz(path: string): Promise<void> {
  const page = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(path);
  const done = new Promise<void>((resolve) => output.on('close', resolve));
  archive.pipe(output);
  archive.append(page, { name: '01.jpg' });
  archive.append(page, { name: '02.jpg' });
  await archive.finalize();
  await done;
}

describe('KoboDeliveryService comic delivery', () => {
  let root: string;
  let comicPath: string;
  let comics: ComicEpubConversionService;
  let offered: KoboDeliveryRecord | undefined;
  let service: KoboDeliveryService;
  const kepubConversion = { acquireKepub: vi.fn() };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kobo-comic-delivery-'));
    comicPath = join(root, 'Issue 1.cbz');
    await writeCbz(comicPath);
    comics = new ComicEpubConversionService({ appDataPath: join(root, 'data') } as never);
    offered = undefined;
    const file = { id: 4, bookId: 3, absolutePath: comicPath, format: 'cbz', mediaOverlayAvailable: false, mtime: null, sizeBytes: null };
    const repository = {
      assertDevice: vi.fn().mockResolvedValue(undefined),
      findCurrent: vi.fn().mockImplementation(() => Promise.resolve(offered ?? null)),
      offer: vi.fn().mockImplementation((input: Omit<KoboDeliveryRecord, 'id'>) => {
        offered = { ...input, id: 'delivery', previousId: null, current: true, createdAt: new Date(), updatedAt: new Date() } as KoboDeliveryRecord;
        return Promise.resolve(offered);
      }),
    };
    const artifacts = {
      prepare: vi.fn().mockImplementation(() =>
        Promise.resolve({
          artifactId: 'source-rev',
          sourceRevision: 'source-rev',
          requestedVariant: null,
          actualVariant: 'original',
          format: 'cbz',
          sizeBytes: 1,
          sha256: 'source-rev',
          fileHash: 'source-hash',
          outcome: 'original',
          path: comicPath,
          release: vi.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    service = new KoboDeliveryService(
      repository as never,
      { findBook: vi.fn().mockResolvedValue({ id: 3, primaryFileId: 4 }), findPrimaryFile: vi.fn().mockResolvedValue(file) } as never,
      { assertBookAccessible: vi.fn().mockResolvedValue(undefined) } as never,
      {
        getSettings: vi
          .fn()
          .mockResolvedValue({ readAloudDelivery: null, convertToKepub: true, forceEnableHyphenation: false, kepubConversionLimitMb: 100 }),
      } as never,
      artifacts as never,
      kepubConversion as never,
      { getVersion: vi.fn() } as never,
      comics,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('offers the converted EPUB, never the archive, and never runs kepubify on it', async () => {
    const record = await service.offer(1, 2, 3);
    const converted = await comics.getEpubPath({ sourcePath: comicPath, sourceRevision: 'source-rev', format: 'cbz', bookId: 3 });

    expect(record.metadata.format).toBe('epub');
    expect(record.metadata.sizeBytes).toBe((await stat(converted)).size);
    expect(record.metadata.sha256).not.toBe('source-rev');
    expect(kepubConversion.acquireKepub).not.toHaveBeenCalled();
  });

  it('serves bytes matching the offer, even after the cached conversion is evicted', async () => {
    const record = await service.offer(1, 2, 3);
    await rm(join(root, 'data', '.comic-epub-cache'), { recursive: true, force: true });

    const artifact = await service.resolve(1, 2, record);

    expect(artifact.path).toMatch(/\.comic-epub-cache\/3\/[a-f0-9]{64}\.epub$/);
    expect(artifact.sha256).toBe(record.metadata.sha256);
    expect(artifact.format).toBe('epub');
    await artifact.release();
  });
});
