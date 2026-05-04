// ─────────────────────────────────────────────────────────────
//  Types for the Document Extractor Service
// ─────────────────────────────────────────────────────────────

export type FileType = 'pdf' | 'image' | 'spreadsheet';

export type SupportedMimeType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/jpg'
  | 'image/webp'
  | 'image/tiff'
  | 'image/bmp'
  | 'image/gif'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.ms-excel'
  | 'application/vnd.oasis.opendocument.spreadsheet'
  | 'text/csv';

// ── Per-sheet result (spreadsheet only) ──────────────────────
export interface SheetInfo {
  /** Tab / sheet name */
  name: string;
  /** Data row count (empty trailing rows excluded) */
  rowCount: number;
  /** Column count in used range */
  colCount: number;
  /** Values from the first non-empty row (treated as headers) */
  headers: string[];
  /** All cell values flattened — tab-separated within rows, newline between rows */
  text: string;
  charCount: number;
  wordCount: number;
}

// ── Per-page result (PDF only) ────────────────────────────────
export interface PageResult {
  pageNumber: number;
  text: string;
  charCount: number;
  wordCount: number;
  /** Only set in screenshot-ocr mode */
  ocrConfidence?: number;
  /** Only set in screenshot-ocr mode when includeThumbnails=true */
  thumbnailDataUrl?: string;
  /** Rendered image size — only in screenshot-ocr mode */
  imageDimensions?: { width: number; height: number };
}

// ── Extraction method ─────────────────────────────────────────
export type ExtractionMethod =
  | 'pdf-parse'           // primary pdf-parse library
  | 'pdftotext-fallback'  // poppler pdftotext CLI fallback
  | 'screenshot-ocr'      // pdftoppm → Tesseract OCR pipeline
  | 'tesseract';          // direct image OCR

// ── PDF metadata pulled from the document ────────────────────
export interface PDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  keywords?: string;
  pageCount: number;
}

// ── OCR word-level detail (image only) ───────────────────────
export interface OCRWord {
  text: string;
  confidence: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

export interface OCRLine {
  text: string;
  confidence: number;
  words: OCRWord[];
}

// ── Core extraction result ────────────────────────────────────
export interface ExtractionResult {
  /** Unique job ID */
  jobId: string;

  /** Original filename as uploaded */
  filename: string;

  /** Detected file type */
  fileType: FileType;

  /** MIME type */
  mimeType: string;

  /** File size in bytes */
  sizeBytes: number;

  /** ISO timestamp when processing completed */
  processedAt: string;

  /** Processing duration in milliseconds */
  durationMs: number;

  /** Full concatenated text from all pages / OCR */
  fullText: string;

  /** Total character count */
  charCount: number;

  /** Total word count */
  wordCount: number;

  // PDF-specific fields
  pageCount?: number;
  pages?: PageResult[];
  metadata?: PDFMetadata;

  // Image-specific fields
  ocrConfidence?: number;    // 0–100 average confidence (image direct OCR)
  ocrLines?: OCRLine[];      // line-level detail (image direct OCR)

  // Screenshot-OCR fields (PDF rendered as images)
  /** How the text was extracted */
  extractionMethod?: ExtractionMethod;
  /** Average OCR confidence across all pages (screenshot-ocr mode) */
  avgOcrConfidence?: number;
  /** DPI used when rendering pages (screenshot-ocr mode) */
  renderDpi?: number;

  // Spreadsheet-specific fields
  sheetCount?: number;
  sheets?: SheetInfo[];

  /** Path to the written JSON output file */
  outputFile: string;
}

// ── API response envelope ─────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
}

// ── Upload request from multer ────────────────────────────────
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

// ── Service config loaded from env ───────────────────────────
export interface ServiceConfig {
  port: number;
  host: string;
  maxFileSizeBytes: number;
  outputDir: string;
  tesseractLang: string;
  logLevel: string;
  /**
   * Base URL of the local LM Studio server.
   * Default LM Studio binds to http://localhost:1234 ; the service auto-
   * appends /v1 if the user omits it.
   */
  lmstudioUrl: string;
  /**
   * Default LM Studio model id, as displayed in LM Studio's "Local Server"
   * tab. Examples: "google/gemma-3-4b-it", "lmstudio-community/gemma-3-4b-it-GGUF".
   */
  lmstudioModel: string;
  /**
   * Absolute path to the classification prompt (skill.md). If empty, the
   * service auto-discovers it relative to cwd / source dir.
   */
  classifyPromptFile: string;
}
