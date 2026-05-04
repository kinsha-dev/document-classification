import Tesseract, { Page, Word, Line } from 'tesseract.js';
import { OCRLine, OCRWord } from '../types';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────
//  Result returned from extractImageText
// ─────────────────────────────────────────────────────────────
export interface ImageExtractionResult {
  fullText: string;
  ocrConfidence: number;
  ocrLines: OCRLine[];
}

// ─────────────────────────────────────────────────────────────
//  Map Tesseract word → our OCRWord type
// ─────────────────────────────────────────────────────────────
function mapWord(word: Word): OCRWord {
  return {
    text: word.text,
    confidence: Math.round(word.confidence * 10) / 10,
    bbox: {
      x0: word.bbox.x0,
      y0: word.bbox.y0,
      x1: word.bbox.x1,
      y1: word.bbox.y1,
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  Map Tesseract line → our OCRLine type
// ─────────────────────────────────────────────────────────────
function mapLine(line: Line): OCRLine {
  return {
    text: line.text.replace(/\n$/, ''),
    confidence: Math.round(line.confidence * 10) / 10,
    words: line.words.map(mapWord),
  };
}

// ─────────────────────────────────────────────────────────────
//  Compute average confidence across all words
// ─────────────────────────────────────────────────────────────
function averageConfidence(page: Page): number {
  const words = page.lines.flatMap((l) => l.words);
  if (!words.length) return 0;
  const sum = words.reduce((acc, w) => acc + w.confidence, 0);
  return Math.round((sum / words.length) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
//  Main OCR extractor
// ─────────────────────────────────────────────────────────────
export async function extractImageText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  lang = 'eng'
): Promise<ImageExtractionResult> {
  // Write buffer to a temp file — Tesseract.js works best with file paths
  const ext = mimeType.split('/')[1] ?? 'png';
  const tmpPath = path.join(os.tmpdir(), `docextract_${uuidv4()}.${ext}`);

  try {
    fs.writeFileSync(tmpPath, buffer);

    // Create a worker for this job
    const worker = await Tesseract.createWorker(lang, 1, {
      // Suppress verbose Tesseract logs
      logger: () => undefined,
    });

    let result: Tesseract.RecognizeResult;
    try {
      result = await worker.recognize(tmpPath);
    } finally {
      await worker.terminate();
    }

    const { data } = result;

    // Build line-level detail (filter out empty lines)
    const ocrLines: OCRLine[] = data.lines
      .map(mapLine)
      .filter((l) => l.text.trim().length > 0);

    const fullText = data.text.trim();
    const ocrConfidence = averageConfidence(data);

    return { fullText, ocrConfidence, ocrLines };
  } catch (err) {
    throw new Error(
      `OCR failed for "${filename}": ${(err as Error).message}`
    );
  } finally {
    // Clean up temp file
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
}
