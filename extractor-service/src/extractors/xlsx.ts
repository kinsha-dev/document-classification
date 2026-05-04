/**
 * Spreadsheet Extractor (XLSX / XLS / CSV)
 *
 * Uses SheetJS to read all sheets, extract cell text, detect headers,
 * and produce a flat fullText representation suitable for classification.
 */

import * as XLSX from 'xlsx';

// ─────────────────────────────────────────────────────────────
//  Public interfaces
// ─────────────────────────────────────────────────────────────
export interface SheetInfo {
  /** Sheet / tab name */
  name: string;
  /** Number of data rows (excluding empty trailing rows) */
  rowCount: number;
  /** Number of columns used */
  colCount: number;
  /** First non-empty row treated as column headers */
  headers: string[];
  /** All cell values flattened to a single string (tab-separated within rows) */
  text: string;
  /** Character count of this sheet's text */
  charCount: number;
  /** Word count of this sheet's text */
  wordCount: number;
}

export interface SpreadsheetExtractionResult {
  fullText:   string;
  sheetCount: number;
  sheets:     SheetInfo[];
  charCount:  number;
  wordCount:  number;
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function parseRange(ref: string | undefined): { rows: number; cols: number } {
  if (!ref) return { rows: 0, cols: 0 };
  try {
    const r = XLSX.utils.decode_range(ref);
    return {
      rows: r.e.r - r.s.r + 1,
      cols: r.e.c - r.s.c + 1,
    };
  } catch {
    return { rows: 0, cols: 0 };
  }
}

// ─────────────────────────────────────────────────────────────
//  Main extractor
// ─────────────────────────────────────────────────────────────
export function extractSpreadsheet(
  buffer:   Buffer,
  filename: string,
): SpreadsheetExtractionResult {

  // Detect CSV by extension — SheetJS handles both transparently
  const isCsv = /\.csv$/i.test(filename);
  const readType = isCsv ? 'string' : 'buffer';

  const workbook = XLSX.read(
    isCsv ? buffer.toString('utf8') : buffer,
    {
      type:      readType as any,
      cellDates: true,
      cellText:  true,    // preserve formatted text (dates, currencies)
      raw:       false,
    }
  );

  const sheets: SheetInfo[] = [];
  const allText: string[]   = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const { rows, cols } = parseRange(sheet['!ref']);

    // sheet_to_json with header:1 gives raw row arrays
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header:  1,
      defval:  '',
      raw:     false,
    });

    // Remove entirely empty rows from the bottom
    while (rawRows.length > 0) {
      const last = rawRows[rawRows.length - 1] as unknown[];
      if (last.every(c => String(c || '').trim() === '')) rawRows.pop();
      else break;
    }

    // First non-empty row = headers
    const headers: string[] = rawRows.length > 0
      ? (rawRows[0] as unknown[])
          .map(h => String(h || '').trim())
          .filter(Boolean)
      : [];

    // Build human-readable text per row
    const rowLines = rawRows.map(row =>
      (row as unknown[])
        .map(c => String(c || '').trim())
        .filter(Boolean)
        .join('\t')
    ).filter(Boolean);

    const sheetText = rowLines.join('\n');

    sheets.push({
      name:      sheetName,
      rowCount:  rawRows.length,
      colCount:  cols,
      headers,
      text:      sheetText,
      charCount: sheetText.length,
      wordCount: countWords(sheetText),
    });

    // Prefix each sheet section so classifier can see sheet names
    allText.push(`[Sheet: ${sheetName}]\n${sheetText}`);
  }

  const fullText  = allText.join('\n\n').trim();
  const charCount = fullText.length;
  const wordCount = countWords(fullText);

  return { fullText, sheetCount: sheets.length, sheets, charCount, wordCount };
}
