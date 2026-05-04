import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

import { extractPdfText } from './extractors/pdf';
import { extractImageText } from './extractors/image';
import {
  extractPdfViaScreenshot,
  isPdftoppmAvailable,
} from './extractors/pdf-screenshot';
import { extractSpreadsheet } from './extractors/xlsx';
import {
  checkLlmHealth,
  classify as llmClassify,
  streamClassify as llmStreamClassify,
  chatPassthrough as llmChatPassthrough,
  streamChatPassthrough as llmStreamChatPassthrough,
  loadPromptTemplate,
  clearPromptCache,
  CategoryInput,
} from './lmstudio';
import {
  ExtractionResult,
  ApiResponse,
  ServiceConfig,
  SupportedMimeType,
  FileType,
} from './types';

// ─────────────────────────────────────────────────────────────
//  MIME → FileType mapping
// ─────────────────────────────────────────────────────────────
const MIME_MAP: Record<SupportedMimeType, FileType> = {
  'application/pdf':   'pdf',
  'image/png':         'image',
  'image/jpeg':        'image',
  'image/jpg':         'image',
  'image/webp':        'image',
  'image/tiff':        'image',
  'image/bmp':         'image',
  'image/gif':         'image',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel':                                          'spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet':                    'spreadsheet',
  'text/csv':          'spreadsheet',
};

const SUPPORTED_MIMES = Object.keys(MIME_MAP) as SupportedMimeType[];

// ─────────────────────────────────────────────────────────────
//  Logger (minimal, structured)
// ─────────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: object) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ─── Request-body summariser ─────────────────────────────────
//
// For request logging we want to see WHAT the caller sent without
// flooding the log with multi-KB prompts or raw OCR text. Strings get
// truncated to 200 chars (with original length tagged), Buffers show
// their byte count, large arrays show their length, and we don't
// recurse past depth 3.
const PREVIEW_CHARS = 200;
function summariseValue(v: unknown, depth = 0): unknown {
  if (v == null)               return v;
  if (typeof v === 'string')   return v.length > PREVIEW_CHARS
    ? v.slice(0, PREVIEW_CHARS) + `…(${v.length} chars)`
    : v;
  if (typeof v === 'number')   return v;
  if (typeof v === 'boolean')  return v;
  if (Buffer.isBuffer(v))      return `<Buffer ${v.length}B>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    if (depth >= 3)     return `<Array ${v.length}>`;
    if (v.length > 5)   return [...v.slice(0, 5).map((x) => summariseValue(x, depth + 1)), `…+${v.length - 5} more`];
    return v.map((x) => summariseValue(x, depth + 1));
  }
  if (typeof v === 'object') {
    if (depth >= 3) return '<obj>';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = summariseValue((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return v;
}

// Headers we actually care about for debugging — keep the noise out.
const LOGGED_HEADERS = [
  'content-type', 'content-length', 'origin', 'user-agent',
  'x-llm-url', 'x-llm-model',
  'x-lmstudio-url', 'x-lmstudio-model',
  'x-ollama-url', 'x-ollama-model',
];

// ─────────────────────────────────────────────────────────────
//  Word count helper
// ─────────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────
//  Build the Express app
// ─────────────────────────────────────────────────────────────
export function createServer(config: ServiceConfig): express.Application {
  const app = express();

  // Pre-load the prompt template at boot so misconfiguration surfaces
  // immediately rather than on the first classify request. We log the
  // resolved path (or warn if we'll be using the inline fallback).
  try {
    const explicit = config.classifyPromptFile || undefined;
    if (explicit) process.env.CLASSIFY_PROMPT_FILE = explicit;
    const cached = loadPromptTemplate(explicit);
    log('info', 'classification prompt loaded', {
      path: cached.path,
      bytes: cached.template.length,
    });
  } catch (err) {
    log('warn', 'classification prompt not found — using inline fallback', {
      error: (err as Error).message,
    });
  }

  // ── Middleware ──────────────────────────────────────────────
  app.use(cors());
  app.use(express.json());

  // Request logger — captures method/url/query, interesting headers, and
  // a summary of the JSON body. Multipart uploads have an empty req.body
  // here (multer parses later in the per-route handler) so we just note
  // the content-type and content-length for those.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    const headers: Record<string, string> = {};
    for (const h of LOGGED_HEADERS) {
      const v = req.header(h);
      if (v) headers[h] = v;
    }

    const hasJsonBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;

    log('info', 'incoming request', {
      method:  req.method,
      url:     req.url,
      path:    req.path,
      ...(Object.keys(req.query).length ? { query:   req.query }                : {}),
      ...(Object.keys(headers).length    ? { headers }                          : {}),
      ...(hasJsonBody                    ? { body:    summariseValue(req.body) }: {}),
    });

    res.on('finish', () => {
      log('info', 'request complete', {
        method:     req.method,
        url:        req.url,
        status:     res.statusCode,
        durationMs: Date.now() - start,
      });
    });

    next();
  });

  // ── Multer (memory storage — keep file in RAM) ──────────────
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeBytes },
    fileFilter: (_req, file, cb) => {
      if (SUPPORTED_MIMES.includes(file.mimetype as SupportedMimeType)) {
        cb(null, true);
      } else {
        cb(
          new Error(
            `Unsupported file type: ${file.mimetype}. ` +
            `Accepted: ${SUPPORTED_MIMES.join(', ')}`
          )
        );
      }
    },
  });

  // ── Helper: write result JSON to output dir ─────────────────
  function writeOutput(result: ExtractionResult): string {
    const safeBase = path.basename(result.filename, path.extname(result.filename))
      .replace(/[^a-z0-9_-]/gi, '_')
      .slice(0, 60);
    const outName = `${safeBase}_${result.jobId.slice(0, 8)}.json`;
    const outPath = path.join(config.outputDir, outName);

    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
    return outPath;
  }

  // ──────────────────────────────────────────────────────────────
  //  GET /health
  // ──────────────────────────────────────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    const pdftoppm = await isPdftoppmAvailable();
    res.json({
      status: 'ok',
      service: 'doc-extractor',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      supportedTypes: SUPPORTED_MIMES,
      outputDir: config.outputDir,
      capabilities: {
        pdfParse:       true,
        pdfTextFallback: true,
        screenshotOcr:  pdftoppm,
        imageOcr:       true,
      },
    });
  });

  // ──────────────────────────────────────────────────────────────
  //  GET /outputs  — list saved extraction results
  // ──────────────────────────────────────────────────────────────
  app.get('/outputs', (_req: Request, res: Response) => {
    try {
      fs.mkdirSync(config.outputDir, { recursive: true });
      const files = fs.readdirSync(config.outputDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const fullPath = path.join(config.outputDir, f);
          const stat = fs.statSync(fullPath);
          return {
            file: f,
            path: fullPath,
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const response: ApiResponse<typeof files> = { success: true, data: files };
      res.json(response);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // ──────────────────────────────────────────────────────────────
  //  GET /outputs/:filename  — retrieve a saved result
  // ──────────────────────────────────────────────────────────────
  app.get('/outputs/:filename', (req: Request, res: Response) => {
    const safe = path.basename(req.params.filename);
    const filePath = path.join(config.outputDir, safe);

    if (!filePath.startsWith(path.resolve(config.outputDir))) {
      res.status(400).json({ success: false, error: 'Invalid path' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.sendFile(path.resolve(filePath));
  });

  // ──────────────────────────────────────────────────────────────
  //  POST /extract  — main extraction endpoint
  //
  //  Request:  multipart/form-data, field name = "file"
  //  Response: ExtractionResult JSON
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/extract',
    upload.single('file'),
    async (req: Request, res: Response): Promise<void> => {
      const startMs = Date.now();

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded. Send a multipart/form-data POST with field name "file".',
        } satisfies ApiResponse);
        return;
      }

      const { originalname, mimetype, buffer, size } = req.file;
      const jobId = uuidv4();
      const fileType = MIME_MAP[mimetype as SupportedMimeType];

      log('info', 'processing file', { jobId, filename: originalname, mimeType: mimetype, sizeBytes: size });

      // ── Detect mode ─────────────────────────────────────────
      // ?mode=screenshot  OR  multipart field screenshotOcr=true
      const useScreenshot =
        req.query['mode'] === 'screenshot' ||
        req.body?.screenshotOcr === 'true' ||
        req.body?.screenshotOcr === true;

      const dpi = parseInt(String(req.query['dpi'] || req.body?.dpi || '200'), 10);
      const includeThumbnails =
        req.query['thumbnails'] === 'true' || req.body?.includeThumbnails === 'true';

      try {
        let result: ExtractionResult;

        // ── PDF : Screenshot-OCR mode ─────────────────────────
        if (fileType === 'pdf' && useScreenshot) {
          log('info', 'screenshot-ocr mode', { jobId, dpi, includeThumbnails });

          const extracted = await extractPdfViaScreenshot(buffer, originalname, {
            dpi,
            lang: config.tesseractLang,
            includeThumbnails,
          });

          const partial: Omit<ExtractionResult, 'outputFile'> = {
            jobId,
            filename: originalname,
            fileType: 'pdf',
            mimeType: mimetype,
            sizeBytes: size,
            processedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            fullText:    extracted.fullText,
            charCount:   extracted.fullText.length,
            wordCount:   countWords(extracted.fullText),
            pageCount:   extracted.pageCount,
            pages:       extracted.pages,
            extractionMethod: 'screenshot-ocr',
            avgOcrConfidence: extracted.avgConfidence,
            renderDpi:   extracted.dpi,
          };

          const outputFile = writeOutput({ ...partial, outputFile: '' });
          result = { ...partial, outputFile, durationMs: Date.now() - startMs };
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

        // ── PDF : Text-stream mode (default) ─────────────────
        } else if (fileType === 'pdf') {
          const extracted = await extractPdfText(buffer, originalname);

          const partial: Omit<ExtractionResult, 'outputFile'> = {
            jobId,
            filename: originalname,
            fileType: 'pdf',
            mimeType: mimetype,
            sizeBytes: size,
            processedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            fullText: extracted.fullText,
            charCount: extracted.fullText.length,
            wordCount: countWords(extracted.fullText),
            pageCount: extracted.pageCount,
            pages: extracted.pages,
            metadata: extracted.metadata,
            extractionMethod: 'pdf-parse',
          };

          const outputFile = writeOutput({ ...partial, outputFile: '' });
          result = { ...partial, outputFile, durationMs: Date.now() - startMs };
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

        // ── Spreadsheet (XLSX / XLS / CSV) ───────────────────
        } else if (fileType === 'spreadsheet') {
          const extracted = extractSpreadsheet(buffer, originalname);

          const partial: Omit<ExtractionResult, 'outputFile'> = {
            jobId,
            filename: originalname,
            fileType: 'spreadsheet',
            mimeType: mimetype,
            sizeBytes: size,
            processedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            fullText:   extracted.fullText,
            charCount:  extracted.charCount,
            wordCount:  extracted.wordCount,
            sheetCount: extracted.sheetCount,
            sheets:     extracted.sheets,
            extractionMethod: 'xlsx' as any,
          };

          const outputFile = writeOutput({ ...partial, outputFile: '' });
          result = { ...partial, outputFile, durationMs: Date.now() - startMs };
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

        // ── Image ────────────────────────────────────────────
        } else {
          const extracted = await extractImageText(
            buffer,
            mimetype,
            originalname,
            config.tesseractLang
          );

          const partial: Omit<ExtractionResult, 'outputFile'> = {
            jobId,
            filename: originalname,
            fileType: 'image',
            mimeType: mimetype,
            sizeBytes: size,
            processedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            fullText: extracted.fullText,
            charCount: extracted.fullText.length,
            wordCount: countWords(extracted.fullText),
            ocrConfidence: extracted.ocrConfidence,
            ocrLines: extracted.ocrLines,
          };

          const outputFile = writeOutput({ ...partial, outputFile: '' });
          result = { ...partial, outputFile, durationMs: Date.now() - startMs };
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
        }

        log('info', 'extraction complete', {
          jobId,
          durationMs: result.durationMs,
          charCount: result.charCount,
          wordCount: result.wordCount,
          outputFile: result.outputFile,
        });

        const response: ApiResponse<ExtractionResult> = { success: true, data: result };
        res.status(200).json(response);

      } catch (err) {
        const message = (err as Error).message;
        log('error', 'extraction failed', { jobId, error: message });
        res.status(422).json({
          success: false,
          error: 'Extraction failed',
          details: message,
        } satisfies ApiResponse);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  //  POST /extract/screenshot  — dedicated screenshot-OCR endpoint
  //
  //  Query params:
  //    dpi          = 150 | 200 | 300 (default 200)
  //    thumbnails   = true | false     (default false)
  //    lang         = eng | fra | ...  (default eng)
  //    maxPages     = N                (0 = all pages)
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/extract/screenshot',
    upload.single('file'),
    async (req: Request, res: Response): Promise<void> => {
      const startMs = Date.now();

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded. Send multipart/form-data with field "file".',
        } satisfies ApiResponse);
        return;
      }

      const { originalname, mimetype, buffer, size } = req.file;

      // Only accept PDFs on this route
      if (mimetype !== 'application/pdf') {
        res.status(400).json({
          success: false,
          error: `Screenshot-OCR only supports PDFs. Got: ${mimetype}`,
        } satisfies ApiResponse);
        return;
      }

      const jobId            = uuidv4();
      const dpi              = Math.min(600, Math.max(72, parseInt(String(req.query['dpi'] || '200'), 10)));
      const includeThumbnails = req.query['thumbnails'] === 'true';
      const lang             = String(req.query['lang'] || config.tesseractLang);
      const maxPages         = parseInt(String(req.query['maxPages'] || '0'), 10);

      log('info', 'screenshot-ocr job started', { jobId, filename: originalname, dpi, lang, includeThumbnails });

      try {
        const extracted = await extractPdfViaScreenshot(buffer, originalname, {
          dpi,
          lang,
          includeThumbnails,
          maxPages,
        });

        const result: ExtractionResult = {
          jobId,
          filename:         originalname,
          fileType:         'pdf',
          mimeType:         mimetype,
          sizeBytes:        size,
          processedAt:      new Date().toISOString(),
          durationMs:       Date.now() - startMs,
          fullText:         extracted.fullText,
          charCount:        extracted.fullText.length,
          wordCount:        countWords(extracted.fullText),
          pageCount:        extracted.pageCount,
          pages:            extracted.pages,
          extractionMethod: 'screenshot-ocr',
          avgOcrConfidence: extracted.avgConfidence,
          renderDpi:        extracted.dpi,
          outputFile:       '',
        };

        result.outputFile = writeOutput(result);
        result.durationMs = Date.now() - startMs;
        fs.writeFileSync(result.outputFile, JSON.stringify(result, null, 2), 'utf-8');

        log('info', 'screenshot-ocr complete', {
          jobId,
          pages:       extracted.pageCount,
          avgConf:     extracted.avgConfidence,
          durationMs:  result.durationMs,
          outputFile:  result.outputFile,
        });

        res.json({ success: true, data: result } satisfies ApiResponse<ExtractionResult>);

      } catch (err) {
        const message = (err as Error).message;
        log('error', 'screenshot-ocr failed', { jobId, error: message });
        res.status(422).json({
          success: false, error: 'Screenshot OCR failed', details: message,
        } satisfies ApiResponse);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  //  POST /extract/batch  — process multiple files at once
  //
  //  Request:  multipart/form-data, field name = "files" (multiple)
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/extract/batch',
    upload.array('files', 20),
    async (req: Request, res: Response): Promise<void> => {
      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No files uploaded. Send multipart/form-data with field name "files".',
        } satisfies ApiResponse);
        return;
      }

      const jobs = req.files.map(async (file) => {
        const startMs = Date.now();
        const jobId = uuidv4();
        const fileType = MIME_MAP[file.mimetype as SupportedMimeType];

        try {
          if (fileType === 'pdf') {
            const extracted = await extractPdfText(file.buffer, file.originalname);
            const result: ExtractionResult = {
              jobId,
              filename: file.originalname,
              fileType: 'pdf',
              mimeType: file.mimetype,
              sizeBytes: file.size,
              processedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              fullText: extracted.fullText,
              charCount: extracted.fullText.length,
              wordCount: countWords(extracted.fullText),
              pageCount: extracted.pageCount,
              pages: extracted.pages,
              metadata: extracted.metadata,
              outputFile: '',
            };
            result.outputFile = writeOutput(result);
            return { success: true, data: result };
          } else {
            const extracted = await extractImageText(
              file.buffer, file.mimetype, file.originalname, config.tesseractLang
            );
            const result: ExtractionResult = {
              jobId,
              filename: file.originalname,
              fileType: 'image',
              mimeType: file.mimetype,
              sizeBytes: file.size,
              processedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              fullText: extracted.fullText,
              charCount: extracted.fullText.length,
              wordCount: countWords(extracted.fullText),
              ocrConfidence: extracted.ocrConfidence,
              ocrLines: extracted.ocrLines,
              outputFile: '',
            };
            result.outputFile = writeOutput(result);
            return { success: true, data: result };
          }
        } catch (err) {
          return {
            success: false,
            filename: file.originalname,
            error: (err as Error).message,
          };
        }
      });

      const results = await Promise.allSettled(jobs);
      const responses = results.map((r) =>
        r.status === 'fulfilled' ? r.value : { success: false, error: String(r.reason) }
      );

      res.json({ success: true, data: { count: responses.length, results: responses } });
    }
  );

  // ──────────────────────────────────────────────────────────────
  //  LLM proxy routes (LM Studio backend)
  //  Browser hits these instead of LM Studio directly — same-origin
  //  to the extractor service, so the browser never needs LM Studio's
  //  CORS to be permissive.
  //
  //  Aliases /ollama/* → /llm/* are kept so older clients keep working
  //  during the transition. They can be removed once you confirm
  //  nothing else hits them.
  // ──────────────────────────────────────────────────────────────
  function pickLlmUrl(req: Request): string {
    const override =
      (req.header('x-llm-url') || '').trim() ||
      (req.header('x-lmstudio-url') || '').trim();
    return override || config.lmstudioUrl;
  }

  function pickLlmModel(req: Request, body: any): string {
    return (
      (body?.model as string | undefined)?.trim() ||
      (req.header('x-llm-model') || '').trim() ||
      (req.header('x-lmstudio-model') || '').trim() ||
      config.lmstudioModel
    );
  }

  // GET /llm/health  — is LM Studio reachable, what models are loaded?
  const handleHealth = async (req: Request, res: Response) => {
    const url = pickLlmUrl(req);
    const health = await checkLlmHealth(url);
    res.status(health.ok ? 200 : 502).json({
      success: health.ok,
      data: health,
      ...(health.ok ? {} : { error: health.error ?? 'LM Studio unreachable' }),
    } satisfies ApiResponse);
  };
  app.get('/llm/health',    handleHealth);
  app.get('/ollama/health', handleHealth); // legacy alias

  // GET /llm/models  — convenience wrapper that just returns the list
  const handleModels = async (req: Request, res: Response) => {
    const url = pickLlmUrl(req);
    const health = await checkLlmHealth(url);
    if (!health.ok) {
      res.status(502).json({
        success: false,
        error: health.error ?? 'LM Studio unreachable',
      } satisfies ApiResponse);
      return;
    }
    res.json({
      success: true,
      data: { url: health.url, models: health.models },
    } satisfies ApiResponse);
  };
  app.get('/llm/models',    handleModels);
  app.get('/ollama/models', handleModels); // legacy alias

  // POST /llm/classify  — one-shot classification, JSON in / JSON out.
  // Body: { text: string, categories: [{name}], model?: string }
  const handleClassify = async (req: Request, res: Response): Promise<void> => {
    const startMs = Date.now();
    try {
      const { text, categories } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ success: false, error: 'Missing or empty "text" field' } satisfies ApiResponse);
        return;
      }
      if (!Array.isArray(categories) || categories.length === 0) {
        res.status(400).json({ success: false, error: 'Missing or empty "categories" array' } satisfies ApiResponse);
        return;
      }
      const cats: CategoryInput[] = categories.map((c: any) => ({ name: String(c?.name ?? '').trim() }))
                                              .filter((c) => c.name);
      if (cats.length === 0) {
        res.status(400).json({ success: false, error: 'No category names found in "categories"' } satisfies ApiResponse);
        return;
      }

      const url   = pickLlmUrl(req);
      const model = pickLlmModel(req, req.body);

      log('info', 'llm classify', {
        model,
        upstream:      url,
        categoryCount: cats.length,
        categories:    cats.map((c) => c.name),
        textLen:       text.length,
        textPreview:   text.slice(0, 200),
      });

      const result = await llmClassify(url, model, text, cats);

      log('info', 'llm classify complete', {
        model,
        category: result.category,
        durationMs: Date.now() - startMs,
      });

      res.json({
        success: true,
        data: { ...result, model, durationMs: Date.now() - startMs },
      } satisfies ApiResponse);
    } catch (err) {
      const message = (err as Error).message;
      log('error', 'llm classify failed', { error: message });
      res.status(502).json({
        success: false,
        error: 'Classification failed',
        details: message,
      } satisfies ApiResponse);
    }
  };
  app.post('/llm/classify',    handleClassify);
  app.post('/ollama/classify', handleClassify); // legacy alias

  // POST /llm/reload-prompt  — re-read skill.md from disk without a restart.
  // Useful while iterating on the prompt template.
  const handleReloadPrompt = (_req: Request, res: Response) => {
    clearPromptCache();
    try {
      const explicit = config.classifyPromptFile || undefined;
      const cached = loadPromptTemplate(explicit);
      log('info', 'classification prompt reloaded', { path: cached.path, bytes: cached.template.length });
      res.json({ success: true, data: { path: cached.path, bytes: cached.template.length } } satisfies ApiResponse);
    } catch (err) {
      const message = (err as Error).message;
      log('error', 'prompt reload failed', { error: message });
      res.status(500).json({ success: false, error: message } satisfies ApiResponse);
    }
  };
  app.post('/llm/reload-prompt',    handleReloadPrompt);
  app.post('/ollama/reload-prompt', handleReloadPrompt); // legacy alias

  // POST /llm/classify/stream  — same body as /llm/classify but
  // emits Server-Sent Events so the browser can render tokens as they
  // arrive. Final event is { type: "done", result: ClassificationResult }.
  const handleClassifyStream = async (req: Request, res: Response): Promise<void> => {
    const { text, categories } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ success: false, error: 'Missing or empty "text" field' } satisfies ApiResponse);
      return;
    }
    if (!Array.isArray(categories) || categories.length === 0) {
      res.status(400).json({ success: false, error: 'Missing or empty "categories" array' } satisfies ApiResponse);
      return;
    }
    const cats: CategoryInput[] = categories.map((c: any) => ({ name: String(c?.name ?? '').trim() }))
                                            .filter((c) => c.name);
    if (cats.length === 0) {
      res.status(400).json({ success: false, error: 'No category names found in "categories"' } satisfies ApiResponse);
      return;
    }

    const url   = pickLlmUrl(req);
    const model = pickLlmModel(req, req.body);

    log('info', 'llm classify stream', {
      model,
      upstream:      url,
      categoryCount: cats.length,
      categories:    cats.map((c) => c.name),
      textLen:       text.length,
      textPreview:   text.slice(0, 200),
    });

    // Hand the live response off to llmStreamClassify; it owns res from
    // here on (writes SSE events and calls res.end()).
    await llmStreamClassify(url, model, text, cats, res);
  };
  app.post('/llm/classify/stream',    handleClassifyStream);
  app.post('/ollama/classify/stream', handleClassifyStream); // legacy alias

  // ──────────────────────────────────────────────────────────────
  //  POST /llm/chat  /  /llm/chat/stream
  //  Raw OpenAI chat-completions pass-through. Used by the rich-prompt
  //  dashboard, which builds its own system+user messages and parses
  //  the OpenAI SSE stream itself. The browser hits the extractor
  //  service (CORS-friendly) and the service forwards to LM Studio.
  // ──────────────────────────────────────────────────────────────
  const validateChatBody = (body: any): string | null => {
    if (!body || typeof body !== 'object') return 'Body must be a JSON object';
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return 'Body requires a non-empty "messages" array';
    }
    return null;
  };

  // Build a compact preview of an OpenAI messages array for logging.
  const summariseMessages = (messages: any[]): unknown =>
    messages.map((m: any) => ({
      role:    m?.role,
      length:  typeof m?.content === 'string' ? m.content.length : null,
      preview: typeof m?.content === 'string'
        ? (m.content.length > 200 ? m.content.slice(0, 200) + `…(${m.content.length} chars)` : m.content)
        : `<${typeof m?.content}>`,
    }));

  app.post('/llm/chat', async (req: Request, res: Response): Promise<void> => {
    const err = validateChatBody(req.body);
    if (err) {
      res.status(400).json({ success: false, error: err } satisfies ApiResponse);
      return;
    }
    const url   = pickLlmUrl(req);
    const model = pickLlmModel(req, req.body);
    log('info', 'llm chat (passthrough)', {
      model,
      upstream:        url,
      messageCount:    req.body.messages.length,
      messages:        summariseMessages(req.body.messages),
      temperature:     req.body.temperature,
      max_tokens:      req.body.max_tokens,
      response_format: req.body.response_format,
    });
    try {
      const out = await llmChatPassthrough(url, { ...req.body, model });
      res.json({ success: true, data: out } satisfies ApiResponse);
    } catch (e) {
      const message = (e as Error).message;
      log('error', 'llm chat failed', { error: message });
      res.status(502).json({ success: false, error: 'Chat failed', details: message } satisfies ApiResponse);
    }
  });

  app.post('/llm/chat/stream', async (req: Request, res: Response): Promise<void> => {
    const err = validateChatBody(req.body);
    if (err) {
      res.status(400).json({ success: false, error: err } satisfies ApiResponse);
      return;
    }
    const url   = pickLlmUrl(req);
    const model = pickLlmModel(req, req.body);
    log('info', 'llm chat stream (passthrough)', {
      model,
      upstream:        url,
      messageCount:    req.body.messages.length,
      messages:        summariseMessages(req.body.messages),
      temperature:     req.body.temperature,
      max_tokens:      req.body.max_tokens,
      response_format: req.body.response_format,
    });
    // streamChatPassthrough owns res from here on (writes SSE + ends).
    await llmStreamChatPassthrough(url, { ...req.body, model }, res);
  });

  // ── Multer error handler ────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.message.includes('File too large') ? 413 : 400;
    log('warn', 'request error', { error: err.message });
    res.status(status).json({ success: false, error: err.message } satisfies ApiResponse);
  });

  return app;
}
