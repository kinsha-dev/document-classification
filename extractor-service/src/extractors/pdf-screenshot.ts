/**
 * PDF Screenshot Extractor
 *
 * Pipeline:
 *   1. Write PDF buffer to a temp file
 *   2. pdftoppm renders each page to a high-DPI PNG
 *   3. Tesseract.js OCR runs on every page image in parallel
 *   4. Screenshots (base64) are optionally included in the response
 *   5. Temp files are always cleaned up
 *
 * This approach works for ALL PDFs — including scanned documents,
 * image-only PDFs, and layouts that confuse text-stream parsers.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  writeFileSync, readFileSync, unlinkSync,
  existsSync, mkdirSync, readdirSync, rmdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { extractImageText } from './image';
import { PageResult } from '../types';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────
//  Extended page result (screenshot-specific fields)
// ─────────────────────────────────────────────────────────────
export interface ScreenshotPageResult extends PageResult {
  /** Tesseract average confidence for this page (0–100) */
  ocrConfidence: number;
  /** PNG as base64 data URL — only set when includeThumbnails = true */
  thumbnailDataUrl?: string;
  /** Width × height of the rendered page image */
  imageDimensions?: { width: number; height: number };
}

// ─────────────────────────────────────────────────────────────
//  Result returned from extractPdfViaScreenshot
// ─────────────────────────────────────────────────────────────
export interface PdfScreenshotResult {
  fullText:      string;
  pageCount:     number;
  pages:         ScreenshotPageResult[];
  /** Average OCR confidence across all pages */
  avgConfidence: number;
  /** Rendering DPI used */
  dpi:           number;
  /** Always 'screenshot-ocr' — lets callers distinguish from text-stream extraction */
  method:        'screenshot-ocr';
}

// ─────────────────────────────────────────────────────────────
//  Options
// ─────────────────────────────────────────────────────────────
export interface ScreenshotOptions {
  /** Rendering resolution in DPI (default 200) */
  dpi?: number;
  /** Tesseract language string, e.g. 'eng' or 'eng+fra' (default 'eng') */
  lang?: string;
  /** Whether to embed page screenshots as base64 data URLs in the response */
  includeThumbnails?: boolean;
  /** Max pages to process (0 = all) */
  maxPages?: number;
}

// ─────────────────────────────────────────────────────────────
//  Check pdftoppm is available
// ─────────────────────────────────────────────────────────────
let _pdftoppmAvailable: boolean | null = null;
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (_pdftoppmAvailable !== null) return _pdftoppmAvailable;
  try {
    await execFileAsync('which', ['pdftoppm']);
    _pdftoppmAvailable = true;
  } catch {
    _pdftoppmAvailable = false;
  }
  return _pdftoppmAvailable;
}

// ─────────────────────────────────────────────────────────────
//  Word count
// ─────────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────
//  Get image dimensions from PNG header
// ─────────────────────────────────────────────────────────────
function getPngDimensions(buf: Buffer): { width: number; height: number } | undefined {
  // PNG signature: 8 bytes, then IHDR chunk: 4 (len) + 4 (type) + 4 (w) + 4 (h)
  if (buf.length < 24) return undefined;
  try {
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────
//  Main extractor
// ─────────────────────────────────────────────────────────────
export async function extractPdfViaScreenshot(
  buffer:   Buffer,
  filename: string,
  options:  ScreenshotOptions = {}
): Promise<PdfScreenshotResult> {
  const {
    dpi              = 200,
    lang             = 'eng',
    includeThumbnails = false,
    maxPages         = 0,
  } = options;

  if (!(await isPdftoppmAvailable())) {
    throw new Error(
      'pdftoppm not found — install poppler-utils:\n' +
      '  macOS:  brew install poppler\n' +
      '  Ubuntu: sudo apt-get install poppler-utils\n' +
      '  Then restart the extractor service.'
    );
  }

  // ── Temp workspace ───────────────────────────────────────────
  const jobId  = uuidv4();
  const tmpDir = join(tmpdir(), `pdfscr_${jobId}`);
  const tmpPdf = join(tmpdir(), `pdfscr_${jobId}.pdf`);

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpPdf, buffer);

  try {
    // ── 1. Render all pages to PNG ──────────────────────────────
    const prefix  = join(tmpDir, 'page');
    const ppArgs  = ['-r', String(dpi), '-png', tmpPdf, prefix];

    // Optionally limit pages
    if (maxPages > 0) {
      ppArgs.splice(0, 0, '-l', String(maxPages)); // insert -l N before -r
    }

    await execFileAsync('pdftoppm', ppArgs);

    // ── 2. Discover rendered page files (natural sort) ──────────
    let pageFiles = readdirSync(tmpDir)
      .filter(f => f.match(/^page-\d+\.png$/))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      })
      .map(f => join(tmpDir, f));

    if (maxPages > 0) pageFiles = pageFiles.slice(0, maxPages);

    const pageCount = pageFiles.length;
    if (pageCount === 0) {
      throw new Error(`pdftoppm produced no pages for "${filename}"`);
    }

    // ── 3. OCR every page in parallel ──────────────────────────
    const pageResults = await Promise.all(
      pageFiles.map(async (imgPath, idx): Promise<ScreenshotPageResult> => {
        const imgBuf = readFileSync(imgPath);

        // Run Tesseract OCR
        const ocr = await extractImageText(
          imgBuf,
          'image/png',
          `${filename}_page${idx + 1}.png`,
          lang
        );

        const dims = getPngDimensions(imgBuf);

        const result: ScreenshotPageResult = {
          pageNumber:    idx + 1,
          text:          ocr.fullText,
          charCount:     ocr.fullText.length,
          wordCount:     countWords(ocr.fullText),
          ocrConfidence: ocr.ocrConfidence,
          imageDimensions: dims,
        };

        if (includeThumbnails) {
          result.thumbnailDataUrl = `data:image/png;base64,${imgBuf.toString('base64')}`;
        }

        return result;
      })
    );

    // ── 4. Combine ──────────────────────────────────────────────
    const fullText = pageResults
      .map(p => p.text)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const avgConfidence =
      pageResults.reduce((sum, p) => sum + p.ocrConfidence, 0) / pageCount;

    return {
      fullText,
      pageCount,
      pages: pageResults,
      avgConfidence: Math.round(avgConfidence * 10) / 10,
      dpi,
      method: 'screenshot-ocr',
    };

  } finally {
    // ── Always clean up temp files ──────────────────────────────
    try { if (existsSync(tmpPdf)) unlinkSync(tmpPdf); } catch {}
    try {
      readdirSync(tmpDir).forEach(f => unlinkSync(join(tmpDir, f)));
      rmdirSync(tmpDir);
    } catch {}
  }
}
