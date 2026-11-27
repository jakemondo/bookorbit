import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import * as unzipper from 'unzipper';

import { ComicEpubConversionService, isComicFormat, readsRightToLeft } from './comic-epub-conversion.service';

async function image(width: number, height: number, format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .toFormat(format)
    .toBuffer();
}

async function writeCbz(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(path);
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const [name, data] of Object.entries(entries)) archive.append(typeof data === 'string' ? Buffer.from(data) : data, { name });
  await archive.finalize();
  await done;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

describe('ComicEpubConversionService', () => {
  let root: string;
  let comicPath: string;
  let service: ComicEpubConversionService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'comic-epub-test-'));
    comicPath = join(root, 'Saga 001.cbz');
    service = new ComicEpubConversionService({ appDataPath: join(root, 'data') } as never);
    await writeCbz(comicPath, {
      'Saga/page10.jpg': await image(800, 1200, 'jpeg'),
      'Saga/page2.webp': await image(800, 1200, 'webp'),
      'Saga/page1.png': await image(3200, 4800, 'png'),
      'Saga/broken.jpg': Buffer.from('not an image'),
      '__MACOSX/._page1.png': Buffer.from('resource fork'),
      'ComicInfo.xml': '<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds a fixed-layout EPUB with one page per readable image in reading order', async () => {
    const { path, release } = await service.acquireEpub({ sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId: 3 });
    const zip = await unzipper.Open.file(path);

    expect(zip.files[0].path).toBe('mimetype');
    expect(zip.files[0].compressionMethod).toBe(0);
    const opf = (await zip.files.find((file) => file.path === 'OEBPS/content.opf')!.buffer()).toString();
    expect(opf).toContain('<meta property="rendition:layout">pre-paginated</meta>');
    expect(opf).toContain('page-progression-direction="rtl"');
    expect(opf).toContain('<dc:title>Saga 001</dc:title>');

    const images = zip.files.filter((file) => file.path.startsWith('OEBPS/images/')).map((file) => file.path);
    expect(images).toEqual(['OEBPS/images/p0001.jpg', 'OEBPS/images/p0002.jpg', 'OEBPS/images/p0003.jpg']);
    const spine = [...opf.matchAll(/<itemref idref="(p\d+)"\/>/g)].map((match) => match[1]);
    expect(spine).toEqual(['p0001', 'p0002', 'p0003']);

    // page1.png was oversized and is scaled into the page bounds; page2.webp is not a Kobo format.
    const first = await sharp(await zip.files.find((file) => file.path === 'OEBPS/images/p0001.jpg')!.buffer()).metadata();
    expect([first.format, first.width, first.height]).toEqual(['jpeg', 1600, 2400]);
    const firstPage = (await zip.files.find((file) => file.path === 'OEBPS/pages/p0001.xhtml')!.buffer()).toString();
    expect(firstPage).toContain('content="width=1600, height=2400"');
    const second = await sharp(await zip.files.find((file) => file.path === 'OEBPS/images/p0002.jpg')!.buffer()).metadata();
    expect(second.format).toBe('jpeg');
    await release();
  });

  it('rebuilds identical bytes after the cached copy is evicted', async () => {
    const input = { sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId: 3 };
    const first = await service.acquireEpub(input);
    const digest = await sha256(first.path);
    await first.release();
    await rm(first.path);

    const rebuilt = await service.acquireEpub(input);
    expect(rebuilt.path).toBe(first.path);
    expect(await sha256(rebuilt.path)).toBe(digest);
    await rebuilt.release();
  });

  it('produces the same bytes on every build, including builds running side by side', async () => {
    const paths = await Promise.all(
      [3, 4, 5, 6, 7, 8].map((bookId) => service.getEpubPath({ sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId })),
    );
    const digests = new Set(await Promise.all(paths.map(sha256)));
    expect(digests.size).toBe(1);
  });

  it('reuses the cached conversion for the same revision and converts again for a new one', async () => {
    const first = await service.getEpubPath({ sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId: 3 });
    const { mtimeMs } = await stat(first);
    expect(await service.getEpubPath({ sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId: 3 })).toBe(first);
    expect((await stat(first)).mtimeMs).toBe(mtimeMs);
    expect(await service.getEpubPath({ sourcePath: comicPath, sourceRevision: 'rev-2', format: 'cbz', bookId: 3 })).not.toBe(first);
  });

  it('shares one conversion between concurrent requests', async () => {
    const input = { sourcePath: comicPath, sourceRevision: 'rev-1', format: 'cbz', bookId: 3 };
    const [a, b] = await Promise.all([service.getEpubPath(input), service.getEpubPath(input)]);
    expect(a).toBe(b);
  });

  it('refuses an archive with no readable pages', async () => {
    const empty = join(root, 'empty.cbz');
    await writeCbz(empty, { 'notes.txt': 'nothing here' });
    await expect(service.getEpubPath({ sourcePath: empty, sourceRevision: 'rev-e', format: 'cbz', bookId: 4 })).rejects.toMatchObject({
      response: { code: 'COMIC_CONVERSION_FAILED' },
    });
  });

  it('recognises comic formats and the manga reading direction', () => {
    expect(['cbz', 'CBR', 'cb7'].every(isComicFormat)).toBe(true);
    expect([null, 'epub', 'pdf'].some(isComicFormat)).toBe(false);
    expect(readsRightToLeft('<Manga>Yes</Manga>')).toBe(false);
    expect(readsRightToLeft(null)).toBe(false);
  });
});
