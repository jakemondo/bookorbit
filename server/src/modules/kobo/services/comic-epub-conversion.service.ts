import { createHash } from 'crypto';
import { lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, stat } from 'fs/promises';
import { basename, extname, join } from 'path';

import { BadRequestException, Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createExtractorFromFile } from 'node-unrar-js';

import { storageConfig } from '../../../config/config';
import { compareArchiveEntryNames } from '../../../common/archive-entry-sort';
import { extractCbzZipEntry, readCbzZipIndex } from '../../../common/cbz-zip-reader';
import { detectComicContainerFormat, type ComicContainerFormat } from '../../../common/comic-format-detect';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { cb7PagePath, extractCb7ToDisk, removeCb7Extraction } from '../../reader/cbz/cb7-disk-extraction';
import { COMIC_EPUB_CONVERTER_VERSION, writeComicEpub, type ComicPageSource } from './comic-epub-builder';

export const COMIC_FORMATS: readonly ComicContainerFormat[] = ['cbz', 'cbr', 'cb7'];

export function isComicFormat(format: string | null | undefined): format is ComicContainerFormat {
  return format != null && (COMIC_FORMATS as readonly string[]).includes(format.toLowerCase());
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff']);
const MAX_CONCURRENT_CONVERSIONS = 2;
const MAX_WAITING_CONVERSIONS = 32;
const CACHE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 1000;
const CACHE_ENTRY_PATTERN = /^[a-f0-9]{64}\.epub$/;

function isPageName(name: string): boolean {
  return !name.endsWith('/') && !name.split(/[\\/]/).some((part) => part.startsWith('.')) && IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

function isComicInfoName(name: string): boolean {
  return basename(name.replace(/\\/g, '/')).toLowerCase() === 'comicinfo.xml';
}

/** Reads the right-to-left flag ComicRack and Komga write for manga. */
export function readsRightToLeft(comicInfo: string | null): boolean {
  return /<Manga>\s*YesAndRightToLeft\s*<\/Manga>/i.test(comicInfo ?? '');
}

interface OpenedComic {
  pages: ComicPageSource[];
  comicInfo: string | null;
  dispose: () => Promise<void>;
}

export interface ComicEpubConversionInput {
  sourcePath: string;
  sourceRevision: string;
  format: string;
  bookId: number;
}

@Injectable()
export class ComicEpubConversionService {
  private readonly logger = new Logger(ComicEpubConversionService.name);
  private readonly appDataPath: string;
  private readonly cachePath: string;
  private readonly conversions = new Map<string, Promise<string>>();
  private readonly leases = new Map<string, number>();
  private readonly waiters: (() => void)[] = [];
  private publication: Promise<void> = Promise.resolve();
  private active = 0;

  constructor(@Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>) {
    this.appDataPath = storage.appDataPath;
    this.cachePath = join(storage.appDataPath, '.comic-epub-cache');
  }

  /** The fixed-layout EPUB for this exact comic revision, built once and leased while it is read. */
  async acquireEpub(input: ComicEpubConversionInput): Promise<{ path: string; release: () => Promise<void> }> {
    return this.lease(await this.getEpubPath(input));
  }

  private titleOf(input: ComicEpubConversionInput): string {
    return basename(input.sourcePath, extname(input.sourcePath));
  }

  // The title is written into the package, so a renamed file is a different conversion.
  private cacheKey(input: ComicEpubConversionInput): string {
    return createHash('sha256')
      .update(`${input.sourceRevision}:${COMIC_EPUB_CONVERTER_VERSION}:${this.titleOf(input)}`)
      .digest('hex');
  }

  async getEpubPath(input: ComicEpubConversionInput): Promise<string> {
    const cacheDir = join(this.cachePath, String(input.bookId));
    const cachedPath = join(cacheDir, `${this.cacheKey(input)}.epub`);
    const pending = this.conversions.get(cachedPath);
    if (pending) return pending;
    try {
      if ((await lstat(cacheDir)).isSymbolicLink() || (await lstat(cachedPath)).isSymbolicLink())
        throw new BadRequestException({ code: 'UNSAFE_DELIVERY_CACHE' });
      return cachedPath;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
    }
    const concurrent = this.conversions.get(cachedPath);
    if (concurrent) return concurrent;
    const conversion = this.convertToCache(input, cacheDir, cachedPath);
    this.conversions.set(cachedPath, conversion);
    try {
      return await conversion;
    } finally {
      this.conversions.delete(cachedPath);
    }
  }

  private lease(path: string): { path: string; release: () => Promise<void> } {
    this.leases.set(path, (this.leases.get(path) ?? 0) + 1);
    let released = false;
    return {
      path,
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        const count = (this.leases.get(path) ?? 1) - 1;
        if (count) this.leases.set(path, count);
        else this.leases.delete(path);
        return Promise.resolve();
      },
    };
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < MAX_CONCURRENT_CONVERSIONS) {
      this.active++;
      return;
    }
    if (this.waiters.length >= MAX_WAITING_CONVERSIONS) throw new BadRequestException({ code: 'DELIVERY_BUSY' });
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new BadRequestException({ code: 'DELIVERY_BUSY' }));
      }, 120_000);
      this.waiters.push(grant);
    });
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private async convertToCache(input: ComicEpubConversionInput, cacheDir: string, cachedPath: string): Promise<string> {
    await this.acquireSlot();
    const startedAt = Date.now();
    let comic: OpenedComic | undefined;
    let tempDir: string | undefined;
    try {
      await mkdir(cacheDir, { recursive: true });
      if (
        (await realpath(this.cachePath)) !== join(await realpath(this.appDataPath), '.comic-epub-cache') ||
        (await lstat(cacheDir)).isSymbolicLink()
      )
        throw new BadRequestException({ code: 'UNSAFE_DELIVERY_CACHE' });
      tempDir = await mkdtemp(join(cacheDir, '.conversion-'));
      const format = await detectComicContainerFormat(input.sourcePath, input.format.toLowerCase() as ComicContainerFormat);
      comic = await this.openComic(input.sourcePath, format, join(tempDir, 'source'));
      const outputPath = join(tempDir, 'book.epub');
      const result = await writeComicEpub(
        {
          title: this.titleOf(input),
          identifier: `urn:bookorbit:comic:${input.sourceRevision}`,
          pages: comic.pages,
          rightToLeft: readsRightToLeft(comic.comicInfo),
        },
        join(tempDir, 'build'),
        outputPath,
      );
      const size = (await stat(outputPath)).size;
      const publication = this.publication.then(async () => {
        await this.evict(cachedPath, size);
        await rename(outputPath, cachedPath);
      });
      this.publication = publication.catch(() => {});
      await publication;
      this.logger.log(
        `[kobo.comic_epub] [end] bookId=${input.bookId} format=${format} durationMs=${Date.now() - startedAt} pages=${result.pageCount} skipped=${result.skippedPages} transcoded=${result.transcodedPages} sizeBytes=${size} - comic converted to fixed-layout EPUB`,
      );
      return cachedPath;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(
        `[kobo.comic_epub] [fail] bookId=${input.bookId} durationMs=${Date.now() - startedAt} errorClass=${error.constructor.name} error="${sanitizeLogValue(error.message)}" - comic conversion failed`,
      );
      if (err instanceof BadRequestException || err instanceof UnprocessableEntityException) throw err;
      throw new UnprocessableEntityException({ code: 'COMIC_CONVERSION_FAILED', message: error.message });
    } finally {
      await comic?.dispose().catch(() => undefined);
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      this.releaseSlot();
    }
  }

  private async openComic(path: string, format: ComicContainerFormat, workDir: string): Promise<OpenedComic> {
    if (format === 'cbz') return this.openCbz(path);
    if (format === 'cbr') return this.openCbr(path, workDir);
    return this.openCb7(path);
  }

  private async openCbz(path: string): Promise<OpenedComic> {
    const index = await readCbzZipIndex(path);
    if (!index) throw new UnprocessableEntityException('CBZ archive is unreadable');
    const comicInfoEntry = index.entries.find((entry) => isComicInfoName(entry.name));
    const comicInfo = comicInfoEntry ? ((await extractCbzZipEntry(path, comicInfoEntry))?.toString('utf8') ?? null) : null;
    const pages = index.entries
      .filter((entry) => isPageName(entry.name) && entry.compressedSize > 0 && (entry.compression === 0 || entry.compression === 8))
      .sort((a, b) => compareArchiveEntryNames(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        read: async () => {
          const data = await extractCbzZipEntry(path, entry);
          if (!data) throw new Error(`page ${entry.name} is unreadable`);
          return data;
        },
      }));
    return { pages, comicInfo, dispose: () => Promise.resolve() };
  }

  private async openCbr(path: string, workDir: string): Promise<OpenedComic> {
    await mkdir(workDir, { recursive: true });
    const listing = await createExtractorFromFile({ filepath: path });
    const names = [...listing.getFileList().fileHeaders]
      .filter((header) => !header.flags.directory && (isPageName(header.name) || isComicInfoName(header.name)))
      .map((header) => header.name);
    // Every entry lands under a generated name, so nothing in the archive picks a path on disk.
    const targets = new Map(names.map((name, index) => [name, `${index}${extname(name).toLowerCase()}`]));
    const extractor = await createExtractorFromFile({
      filepath: path,
      targetPath: workDir,
      filenameTransform: (name: string) => targets.get(name) ?? `skip-${createHash('sha1').update(name).digest('hex')}`,
    });
    const { files } = extractor.extract({ files: (header) => targets.has(header.name) });
    // The extractor is lazy: entries are only written to disk as the iterator is consumed.
    for (const file of files) void file;
    const comicInfoName = names.find(isComicInfoName);
    const comicInfo = comicInfoName ? await readFile(join(workDir, targets.get(comicInfoName)!), 'utf8').catch(() => null) : null;
    const pages = names
      .filter(isPageName)
      .sort(compareArchiveEntryNames)
      .map((name) => ({ name, read: () => readFile(join(workDir, targets.get(name)!)) }));
    return { pages, comicInfo, dispose: () => Promise.resolve() };
  }

  private async openCb7(path: string): Promise<OpenedComic> {
    const extracted = await extractCb7ToDisk(path);
    try {
      const comicInfo = await readFile(cb7PagePath(extracted.dir, 'ComicInfo.xml'), 'utf8').catch(() => null);
      const pages = extracted.pages.filter(isPageName).map((name) => ({ name, read: () => readFile(cb7PagePath(extracted.dir, name)) }));
      return { pages, comicInfo, dispose: () => removeCb7Extraction(extracted.dir) };
    } catch (error) {
      await removeCb7Extraction(extracted.dir);
      throw error;
    }
  }

  private async evict(publishingPath: string, requiredBytes: number): Promise<void> {
    let total = requiredBytes;
    let count = 1;
    const candidates: { path: string; size: number; mtime: number }[] = [];
    for await (const directory of await opendir(this.cachePath)) {
      if (!directory.isDirectory() || !/^[1-9]\d*$/.test(directory.name)) continue;
      const bookDirectory = join(this.cachePath, directory.name);
      for await (const entry of await opendir(bookDirectory)) {
        const path = join(bookDirectory, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('.conversion-')) {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > 20 * 60_000) await rm(path, { recursive: true, force: true });
          continue;
        }
        if (!entry.isFile() || !CACHE_ENTRY_PATTERN.test(entry.name)) continue;
        const info = await stat(path);
        total += info.size;
        count++;
        if (path === publishingPath || this.leases.has(path) || this.conversions.has(path)) continue;
        candidates.push({ path, size: info.size, mtime: info.mtimeMs });
      }
    }
    for (const candidate of candidates.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= CACHE_BUDGET_BYTES && count <= CACHE_MAX_ENTRIES) return;
      if (this.leases.has(candidate.path) || this.conversions.has(candidate.path)) continue;
      await rm(candidate.path, { force: true });
      total -= candidate.size;
      count--;
    }
    if (total > CACHE_BUDGET_BYTES || count > CACHE_MAX_ENTRIES) throw new BadRequestException({ code: 'DELIVERY_CACHE_FULL' });
  }
}
