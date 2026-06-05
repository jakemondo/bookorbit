import { createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createInflateRaw } from 'zlib';
import { readFile } from 'fs/promises';

import { Injectable, Logger } from '@nestjs/common';
import { createExtractorFromData, UnrarError } from 'node-unrar-js';
import archiver from 'archiver';

import { detectComicContainerFormat } from '../../../common/comic-format-detect';
import { getSevenZip } from '../../../common/sevenzip';

// ── ZIP byte-offset helpers (mirrors cbz.service.ts) ─────────────────────────

const LFH_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DD_SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

function isImage(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTS.has(name.substring(dot).toLowerCase());
}

function isHidden(name: string): boolean {
  return name.split('/').some((p) => p.startsWith('.'));
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function mimeForImage(name: string): string {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  };
  return map[ext] ?? 'image/jpeg';
}

interface ZipEntry {
  name: string;
  dataStart: number;
  compressedSize: number;
  compression: number;
}

function resolveDataDescriptorSize(buf: Buffer, dataStart: number): number {
  let search = dataStart;
  while (search < buf.length - 16) {
    const idx = buf.indexOf(DD_SIG, search);
    if (idx === -1) break;
    const cSize = buf.readUInt32LE(idx + 8);
    if (idx === dataStart + cSize) return cSize;
    search = idx + 1;
  }
  return 0;
}

function buildZipIndex(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;

  while (pos < buf.length - 30) {
    const sigPos = buf.indexOf(LFH_SIG, pos);
    if (sigPos === -1) break;

    const flags = buf.readUInt16LE(sigPos + 6);
    const compression = buf.readUInt16LE(sigPos + 8);
    let compressedSize = buf.readUInt32LE(sigPos + 18);
    const fileNameLen = buf.readUInt16LE(sigPos + 26);
    const extraLen = buf.readUInt16LE(sigPos + 28);
    const dataStart = sigPos + 30 + fileNameLen + extraLen;
    const fileName = buf.subarray(sigPos + 30, sigPos + 30 + fileNameLen).toString('utf-8');

    if ((flags & 0x0008) !== 0 && compressedSize === 0) {
      compressedSize = resolveDataDescriptorSize(buf, dataStart);
    }

    if (!fileName.endsWith('/') && !isHidden(fileName) && isImage(fileName)) {
      if ((compression === 0 || compression === 8) && compressedSize > 0) {
        entries.push({ name: fileName, dataStart, compressedSize, compression });
      }
    }

    pos = compressedSize > 0 ? dataStart + compressedSize : sigPos + 4;
  }

  entries.sort((a, b) => naturalSort(a.name, b.name));
  return entries;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// ── Page extraction ───────────────────────────────────────────────────────────

interface Page {
  name: string;
  data: Buffer;
}

async function extractCbzPages(absolutePath: string): Promise<Page[]> {
  const buf = await readFile(absolutePath);
  const entries = buildZipIndex(buf);
  const pages: Page[] = [];

  for (const entry of entries) {
    const compressed = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let data: Buffer;
    if (entry.compression === 0) {
      data = compressed;
    } else {
      data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const inflater = createInflateRaw();
        inflater.on('data', (chunk: Buffer) => chunks.push(chunk));
        inflater.on('end', () => resolve(Buffer.concat(chunks)));
        inflater.on('error', reject);
        inflater.end(compressed);
      });
    }
    pages.push({ name: entry.name, data });
  }

  return pages;
}

async function extractCbrPages(absolutePath: string): Promise<Page[]> {
  const buf = await readFile(absolutePath);
  const ab = toArrayBuffer(buf);

  const listExtractor = await createExtractorFromData({ data: ab });
  const { fileHeaders } = listExtractor.getFileList();

  const pageNames: string[] = [];
  try {
    for (const h of fileHeaders) {
      if (!h.flags.directory && isImage(h.name) && !isHidden(h.name)) {
        pageNames.push(h.name);
      }
    }
  } catch (err) {
    if (!(err instanceof UnrarError) || pageNames.length === 0) throw err;
  }

  pageNames.sort(naturalSort);

  const pages: Page[] = [];
  for (const name of pageNames) {
    const extractor = await createExtractorFromData({ data: ab });
    const { files } = extractor.extract({ files: [name] });
    let extracted: Uint8Array | undefined;
    try {
      for (const file of files) {
        if (!file.fileHeader.flags.directory) extracted = file.extraction;
      }
    } catch (err) {
      if (!(err instanceof UnrarError)) throw err;
    }
    if (extracted) pages.push({ name, data: Buffer.from(extracted) });
  }

  return pages;
}

async function extractCb7Pages(absolutePath: string): Promise<Page[]> {
  const sz = await getSevenZip();
  const buf = await readFile(absolutePath);
  const archPath = `/comic_conv_${Date.now()}`;
  const outDir = `${archPath}_out`;

  const fd = sz.FS.open(archPath, 'w+');
  sz.FS.write(fd, buf, 0, buf.length);
  sz.FS.close(fd);

  try {
    sz.FS.mkdir(outDir);
  } catch {
    /* exists */
  }
  sz.callMain(['e', archPath, `-o${outDir}`, '-y']);

  const files = sz.FS.readdir(outDir) as string[];
  const pageNames = files.filter((f) => f !== '.' && f !== '..' && isImage(f) && !isHidden(f)).sort(naturalSort);

  const pages: Page[] = [];
  for (const name of pageNames) {
    const data = sz.FS.readFile(`${outDir}/${name}`) as Uint8Array;
    pages.push({ name, data: Buffer.from(data) });
  }

  // Cleanup WASM VFS
  try {
    sz.FS.unlink(archPath);
  } catch {
    /* ok */
  }
  for (const name of pageNames) {
    try {
      sz.FS.unlink(`${outDir}/${name}`);
    } catch {
      /* ok */
    }
  }
  try {
    sz.FS.rmdir(outDir);
  } catch {
    /* ok */
  }

  return pages;
}

// ── EPUB builder ──────────────────────────────────────────────────────────────

function buildEpubContainer(): string {
  return `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function buildOpf(title: string, pages: Page[]): string {
  const manifestItems = pages
    .map((p, i) => {
      const ext = p.name.substring(p.name.lastIndexOf('.')).toLowerCase();
      const id = `img${i}`;
      const href = `images/${id}${ext}`;
      const mime = mimeForImage(p.name);
      return `    <item id="${id}" href="${href}" media-type="${mime}"/>
    <item id="page${i}" href="pages/page${i}.xhtml" media-type="application/xhtml+xml"/>`;
    })
    .join('\n');

  const spineItems = pages.map((_, i) => `    <itemref idref="page${i}"/>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:identifier id="uid">bookorbit-comic-${Date.now()}</dc:identifier>
    <dc:language>en</dc:language>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">landscape</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;
}

function buildNcx(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="bookorbit-comic"/></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap><navPoint id="np1" playOrder="1"><navLabel><text>Start</text></navLabel><content src="pages/page0.xhtml"/></navPoint></navMap>
</ncx>`;
}

function buildPageXhtml(imageId: string, ext: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <style>body{margin:0;padding:0;}img{max-width:100%;max-height:100%;display:block;margin:auto;}</style>
</head>
<body>
  <img src="../images/${imageId}${ext}" alt=""/>
</body>
</html>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function buildEpub(outputPath: string, title: string, pages: Page[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { store: true });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    archive.append('application/epub+zip', { name: 'mimetype', store: true } as any);
    archive.append(buildEpubContainer(), { name: 'META-INF/container.xml' });
    archive.append(buildOpf(title, pages), { name: 'OEBPS/content.opf' });
    archive.append(buildNcx(title), { name: 'OEBPS/toc.ncx' });

    pages.forEach((page, i) => {
      const ext = page.name.substring(page.name.lastIndexOf('.')).toLowerCase();
      const id = `img${i}`;
      archive.append(page.data, { name: `OEBPS/images/${id}${ext}` });
      archive.append(buildPageXhtml(id, ext), { name: `OEBPS/pages/page${i}.xhtml` });
    });

    void archive.finalize();
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ComicEpubConverterService {
  private readonly logger = new Logger(ComicEpubConverterService.name);

  async convertToEpub(absolutePath: string, format: string, bookId: number, title: string, cacheDir: string): Promise<string> {
    const cachedPath = join(cacheDir, String(bookId), `${bookId}.epub`);

    try {
      await stat(cachedPath);
      return cachedPath;
    } catch {
      // Cache miss — convert
    }

    this.logger.log(`Converting comic ${bookId} (${format}) to EPUB for Kobo`);

    const fmt = await detectComicContainerFormat(absolutePath, format as any);

    let pages: Page[];
    if (fmt === 'cbz') {
      pages = await extractCbzPages(absolutePath);
    } else if (fmt === 'cbr') {
      pages = await extractCbrPages(absolutePath);
    } else {
      pages = await extractCb7Pages(absolutePath);
    }

    if (pages.length === 0) {
      throw new Error(`No pages found in comic ${bookId}`);
    }

    await mkdir(join(cacheDir, String(bookId)), { recursive: true });
    await buildEpub(cachedPath, title, pages);

    this.logger.log(`Comic ${bookId} converted to EPUB (${pages.length} pages)`);
    return cachedPath;
  }
}
