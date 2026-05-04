import pdfParse from 'pdf-parse';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { PDFMetadata, PageResult } from '../types';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────
//  Internal types from pdf-parse
// ─────────────────────────────────────────────────────────────
interface PdfParseInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Creator?: string;
  Producer?: string;
  CreationDate?: string;
  ModDate?: string;
  Keywords?: string;
}

interface PageData {
  getTextContent(): Promise<{
    items: Array<{ str: string; transform: number[] }>;
  }>;
}

// ─────────────────────────────────────────────────────────────
//  Result returned from extractPdfText
// ─────────────────────────────────────────────────────────────
export interface PdfExtractionResult {
  fullText: string;
  pageCount: number;
  pages: PageResult[];
  metadata: PDFMetadata;
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')       // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')    // at most two blank lines
    .trim();
}

// ─────────────────────────────────────────────────────────────
//  Main extractor
// ─────────────────────────────────────────────────────────────
export async function extractPdfText(
  buffer: Buffer,
  filename: string
): Promise<PdfExtractionResult> {
  // Collect per-page text during render
  const pageTexts: string[] = [];

  const options = {
    // Called once per page by pdf-parse (uses pdf.js internally)
    pagerender: async (pageData: PageData): Promise<string> => {
      const content = await pageData.getTextContent();

      // Reconstruct text respecting line breaks via transform y-coordinate
      let lastY: number | null = null;
      let pageText = '';

      for (const item of content.items) {
        const y = item.transform[5]; // PDF y-coordinate
        if (lastY !== null && Math.abs(y - lastY) > 5) {
          pageText += '\n';
        }
        pageText += item.str;
        lastY = y;
      }

      pageTexts.push(normalizeText(pageText));
      return pageText;
    },
  };

  let parsed: Awaited<ReturnType<typeof pdfParse>>;
  try {
    parsed = await pdfParse(buffer, options);
  } catch (primaryErr) {
    // ── Fallback: pdftotext (poppler-utils) ──────────────────
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn',
      msg: `pdf-parse failed for "${filename}", trying pdftotext fallback`,
      error: (primaryErr as Error).message,
    }));
    const fallbackResult = await pdfttextFallback(buffer, filename);
    if (fallbackResult) return fallbackResult;

    throw new Error(
      `Failed to parse PDF "${filename}": ${(primaryErr as Error).message} (pdftotext fallback also unavailable)`
    );
  }

  // Build per-page results (pageTexts may be shorter than numPages if some
  // pages are blank or image-only — pad them)
  const pageCount = parsed.numpages;
  const pages: PageResult[] = Array.from({ length: pageCount }, (_, i) => {
    const text = pageTexts[i] ?? '';
    return {
      pageNumber: i + 1,
      text,
      charCount: text.length,
      wordCount: countWords(text),
    };
  });

  // Full text = all pages joined
  const fullText = normalizeText(
    pages.map((p) => p.text).join('\n\n')
  );

  // Metadata
  const info: PdfParseInfo = parsed.info ?? {};
  const metadata: PDFMetadata = {
    pageCount,
    title: info.Title || undefined,
    author: info.Author || undefined,
    subject: info.Subject || undefined,
    creator: info.Creator || undefined,
    producer: info.Producer || undefined,
    creationDate: info.CreationDate || undefined,
    modDate: info.ModDate || undefined,
    keywords: info.Keywords || undefined,
  };

  return { fullText, pageCount, pages, metadata };
}

// ─────────────────────────────────────────────────────────────
//  Fallback: pdftotext (poppler-utils) when pdf-parse fails
// ─────────────────────────────────────────────────────────────
async function pdfttextFallback(
  buffer: Buffer,
  filename: string
): Promise<PdfExtractionResult | null> {
  const tmpPdf = join(tmpdir(), `pdfext_${uuidv4()}.pdf`);
  try {
    // Check pdftotext is available
    await execFileAsync('which', ['pdftotext']);
  } catch {
    return null; // pdftotext not installed
  }

  try {
    writeFileSync(tmpPdf, buffer);

    // Get full text (single pass)
    const { stdout: fullRaw } = await execFileAsync('pdftotext', [
      '-layout', tmpPdf, '-'
    ]);
    const fullText = normalizeText(fullRaw);

    // Get page count via pdfinfo
    let pageCount = 1;
    try {
      const { stdout: info } = await execFileAsync('pdfinfo', [tmpPdf]);
      const match = info.match(/Pages:\s+(\d+)/);
      if (match) pageCount = parseInt(match[1], 10);
    } catch { /* pdfinfo optional */ }

    // Extract per-page text using pdftotext -f -l page flags
    const pages: PageResult[] = [];
    for (let p = 1; p <= pageCount; p++) {
      try {
        const { stdout: pageRaw } = await execFileAsync('pdftotext', [
          '-layout', '-f', String(p), '-l', String(p), tmpPdf, '-'
        ]);
        const text = normalizeText(pageRaw);
        pages.push({
          pageNumber: p,
          text,
          charCount: text.length,
          wordCount: countWords(text),
        });
      } catch {
        pages.push({ pageNumber: p, text: '', charCount: 0, wordCount: 0 });
      }
    }

    const metadata: PDFMetadata = {
      pageCount,
      producer: 'pdftotext fallback',
    };

    return { fullText, pageCount, pages, metadata };
  } catch (err) {
    console.error(`pdftotext fallback failed for "${filename}":`, (err as Error).message);
    return null;
  } finally {
    if (existsSync(tmpPdf)) unlinkSync(tmpPdf);
  }
}
