import { createWriteStream } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { ZipArchive } from 'archiver';
import sharp from 'sharp';

/** Bump whenever the produced bytes change, so cached conversions and device copies are rebuilt. */
export const COMIC_EPUB_CONVERTER_VERSION = 'comic-fl-v1';

// Comfortably above every current Kobo panel (Elipsa 2E is 1404x1872), so nothing is softened on
// device, while a 4000px scan does not cost the reader memory it cannot use.
const MAX_PAGE_WIDTH = 1600;
const MAX_PAGE_HEIGHT = 2400;
const JPEG_QUALITY = 85;
// Built from local fields so the DOS timestamp, and with it the archive digest, is the same in every time zone.
const ZIP_ENTRY_DATE = new Date(2000, 0, 1, 0, 0, 0);
const ZIP_ENTRY_MODE = 0o644;

export interface ComicPageSource {
  name: string;
  read: () => Promise<Buffer>;
}

export interface ComicEpubInput {
  title: string;
  identifier: string;
  pages: readonly ComicPageSource[];
  rightToLeft: boolean;
}

export interface ComicEpubResult {
  pageCount: number;
  skippedPages: number;
  transcodedPages: number;
}

interface BuiltPage {
  id: string;
  imageHref: string;
  imageMediaType: string;
  imagePath: string;
  width: number;
  height: number;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function preparePage(input: Buffer): Promise<{ data: Buffer; format: 'jpeg' | 'png'; width: number; height: number; transcoded: boolean }> {
  const metadata = await sharp(input, { failOn: 'error' }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error('page has no dimensions');
  const native = metadata.format === 'jpeg' || metadata.format === 'png';
  const upright = !metadata.orientation || metadata.orientation === 1;
  if (native && upright && (metadata.pages ?? 1) === 1 && width <= MAX_PAGE_WIDTH && height <= MAX_PAGE_HEIGHT) {
    return { data: input, format: metadata.format as 'jpeg' | 'png', width, height, transcoded: false };
  }
  const { data, info } = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_PAGE_WIDTH, height: MAX_PAGE_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, format: 'jpeg', width: info.width, height: info.height, transcoded: true };
}

function pageXhtml(page: BuiltPage, index: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<title>Page ${index + 1}</title>
<meta name="viewport" content="width=${page.width}, height=${page.height}"/>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body style="width:${page.width}px;height:${page.height}px">
<div class="page"><img src="../${page.imageHref}" alt="Page ${index + 1}" width="${page.width}" height="${page.height}"/></div>
</body>
</html>
`;
}

const STYLE_CSS = `@page { margin: 0; }
html, body { margin: 0; padding: 0; }
.page { margin: 0; padding: 0; width: 100%; height: 100%; }
img { display: block; width: 100%; height: 100%; margin: 0; padding: 0; object-fit: contain; }
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

function contentOpf(input: ComicEpubInput, pages: readonly BuiltPage[]): string {
  const first = pages[0];
  const manifest = pages
    .map(
      (page, index) =>
        `<item id="${page.id}" href="pages/${page.id}.xhtml" media-type="application/xhtml+xml"/>\n<item id="${page.id}-img" href="${page.imageHref}" media-type="${page.imageMediaType}"${index === 0 ? ' properties="cover-image"' : ''}/>`,
    )
    .join('\n');
  const spine = pages.map((page) => `<itemref idref="${page.id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${escapeXml(input.identifier)}</dc:identifier>
<dc:title>${escapeXml(input.title)}</dc:title>
<dc:language>en</dc:language>
<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
<meta property="rendition:layout">pre-paginated</meta>
<meta property="rendition:spread">none</meta>
<meta property="rendition:orientation">auto</meta>
<meta name="fixed-layout" content="true"/>
<meta name="book-type" content="comic"/>
<meta name="original-resolution" content="${first.width}x${first.height}"/>
<meta name="cover" content="${first.id}-img"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
${manifest}
</manifest>
<spine toc="ncx"${input.rightToLeft ? ' page-progression-direction="rtl"' : ''}>
${spine}
</spine>
</package>
`;
}

function navXhtml(input: ComicEpubInput, pages: readonly BuiltPage[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(input.title)}</title></head>
<body>
<nav epub:type="toc" id="toc"><ol><li><a href="pages/${pages[0].id}.xhtml">${escapeXml(input.title)}</a></li></ol></nav>
<nav epub:type="page-list" hidden=""><ol>
${pages.map((page, index) => `<li><a href="pages/${page.id}.xhtml">${index + 1}</a></li>`).join('\n')}
</ol></nav>
</body>
</html>
`;
}

function tocNcx(input: ComicEpubInput, pages: readonly BuiltPage[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(input.identifier)}"/></head>
<docTitle><text>${escapeXml(input.title)}</text></docTitle>
<navMap><navPoint id="start" playOrder="1"><navLabel><text>${escapeXml(input.title)}</text></navLabel><content src="pages/${pages[0].id}.xhtml"/></navPoint></navMap>
</ncx>
`;
}

/**
 * Writes the comic as a fixed-layout EPUB 3 with one page per image. The output is byte-for-byte
 * repeatable for the same pages and converter version: a Kobo delivery is checked against the
 * digest it was offered with, so a rebuild after cache eviction must match the copy on the device.
 */
export async function writeComicEpub(input: ComicEpubInput, workDir: string, outputPath: string): Promise<ComicEpubResult> {
  const imagesDir = join(workDir, 'images');
  await mkdir(imagesDir, { recursive: true });
  const pages: BuiltPage[] = [];
  let skippedPages = 0;
  let transcodedPages = 0;
  for (const source of input.pages) {
    let prepared: Awaited<ReturnType<typeof preparePage>>;
    try {
      prepared = await preparePage(await source.read());
    } catch {
      skippedPages++;
      continue;
    }
    if (prepared.transcoded) transcodedPages++;
    const id = `p${String(pages.length + 1).padStart(4, '0')}`;
    const extension = prepared.format === 'png' ? 'png' : 'jpg';
    const imagePath = join(imagesDir, `${id}.${extension}`);
    await writeFile(imagePath, prepared.data);
    pages.push({
      id,
      imageHref: `images/${id}.${extension}`,
      imageMediaType: prepared.format === 'png' ? 'image/png' : 'image/jpeg',
      imagePath,
      width: prepared.width,
      height: prepared.height,
    });
  }
  if (pages.length === 0) throw new Error('comic has no readable pages');

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(outputPath);
  let failure: Error | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error) => {
      failure ??= error;
      archive.abort();
      output.destroy();
      reject(error);
    };
    output.on('error', fail);
    archive.on('error', fail);
  });
  failed.catch(() => undefined);
  const closed = new Promise<void>((resolve) => output.on('close', resolve));
  // One entry at a time, each written before the next is read: entry order (and with it the digest)
  // stays fixed, and only one page is ever held in memory.
  const add = (data: Buffer, name: string, store = false) =>
    Promise.race([
      new Promise<void>((resolve) => {
        archive.once('entry', () => resolve());
        archive.append(data, { name, date: ZIP_ENTRY_DATE, mode: ZIP_ENTRY_MODE, store });
      }),
      failed,
    ]);
  archive.pipe(output);
  await add(Buffer.from('application/epub+zip'), 'mimetype', true);
  await add(Buffer.from(CONTAINER_XML), 'META-INF/container.xml');
  await add(Buffer.from(contentOpf(input, pages)), 'OEBPS/content.opf');
  await add(Buffer.from(navXhtml(input, pages)), 'OEBPS/nav.xhtml');
  await add(Buffer.from(tocNcx(input, pages)), 'OEBPS/toc.ncx');
  await add(Buffer.from(STYLE_CSS), 'OEBPS/style.css');
  for (const [index, page] of pages.entries()) {
    await add(Buffer.from(pageXhtml(page, index)), `OEBPS/pages/${page.id}.xhtml`);
    // Already compressed: deflating JPEG or PNG costs time for no gain.
    await add(await readFile(page.imagePath), `OEBPS/${page.imageHref}`, true);
  }
  await Promise.race([archive.finalize(), failed]);
  await Promise.race([closed, failed]);
  if (failure) throw failure;
  return { pageCount: pages.length, skippedPages, transcodedPages };
}
