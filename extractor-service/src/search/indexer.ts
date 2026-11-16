// ─────────────────────────────────────────────────────────────
//  Indexer — turns extraction results + classifications into
//  IndexedDocuments.
//
//  Lifecycle of one document:
//    /extract           → indexExtraction()      regex metadata only
//    classification     → applyClassification()  + LLM search_metadata,
//                                                  category, subcategory
//    "Apply Label"      → applyClassification({labeledCategory})
//  Each step re-merges and re-derives, so an account number found only
//  by regex and an IBAN found only by the LLM still link up.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types';
import { CompiledSchema, fieldsForCategory } from './schema';
import { extractFromText, mapLlmFields, mergeAndDerive, MetadataValue } from './extract';
import { IndexStore, IndexedDocument } from './store';
import { embed } from './semantic';

export interface ClassificationPayload {
  category?: string;
  subcategory?: string;
  confidence?: string;
  labeledCategory?: string;
  /** Approved metadata returned by the classifier */
  search_metadata?: Record<string, unknown>;
  /** Legacy dashboard key_fields — mapped through aliases too */
  key_fields?: Record<string, unknown>;
  /** Human-entered values; always trusted */
  manual_metadata?: Record<string, unknown>;
  /** Used only when the document was never indexed by this service */
  filename?: string;
  fullText?: string;
}

export interface EmbeddingConfig { url: string; model?: string }

function buildSummary(schema: CompiledSchema, d: Pick<IndexedDocument, 'filename' | 'category' | 'subcategory' | 'labeledCategory' | 'metadata'>): string {
  const parts: string[] = [];
  if (d.labeledCategory) parts.push(d.labeledCategory);
  if (d.category) parts.push(d.category);
  if (d.subcategory) parts.push(d.subcategory);
  parts.push(d.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' '));
  for (const m of d.metadata) {
    const f = schema.fields.get(m.key);
    parts.push(`${f?.label ?? m.key} ${m.key.replace(/_/g, ' ')} ${m.value}`);
  }
  return parts.join(' | ');
}

export class Indexer {
  constructor(
    private store: IndexStore,
    private getSchema: () => CompiledSchema,
    private outputDir: string,
    private embedding: EmbeddingConfig,
  ) {}

  private finalise(d: IndexedDocument): IndexedDocument {
    const schema = this.getSchema();
    d.metadata = mergeAndDerive(schema, d.regexMetadata, d.llmMetadata, d.manualMetadata);
    d.summary = buildSummary(schema, d);
    d.indexedAt = new Date().toISOString();
    d.vector = undefined;
    this.store.upsert(d);
    void this.embedLater(d.jobId);
    return d;
  }

  private async embedLater(jobId: string): Promise<void> {
    if (!this.embedding.model) return;
    const d = this.store.get(jobId);
    if (!d) return;
    const vecs = await embed(this.embedding.url, this.embedding.model, [d.summary + '\n' + d.textHead.slice(0, 2000)]);
    const cur = this.store.get(jobId);
    if (vecs && cur) { cur.vector = vecs[0]; this.store.upsert(cur); }
  }

  /** Embed every indexed document that has no vector yet. */
  async embedAll(): Promise<{ embedded: number; failed: number; skipped: number }> {
    if (!this.embedding.model) return { embedded: 0, failed: 0, skipped: this.store.size() };
    let embedded = 0, failed = 0, skipped = 0;
    for (const d of this.store.all()) {
      if (d.vector) { skipped++; continue; }
      await this.embedLater(d.jobId);
      if (this.store.get(d.jobId)?.vector) embedded++; else failed++;
    }
    return { embedded, failed, skipped };
  }

  indexExtraction(result: ExtractionResult): IndexedDocument {
    const schema = this.getSchema();
    // Re-uploading the same file (same name and size) replaces the old entry
    // instead of listing it twice. A previous classification carries over.
    let prev = this.store.get(result.jobId);
    for (const o of this.store.all()) {
      if (o.jobId !== result.jobId && o.filename === result.filename && o.sizeBytes === result.sizeBytes) {
        prev = prev ?? o;
        this.store.remove(o.jobId);
      }
    }
    const text = result.fullText ?? '';
    const d: IndexedDocument = {
      jobId: result.jobId,
      filename: result.filename,
      outputFile: result.outputFile,
      fileType: result.fileType,
      sizeBytes: result.sizeBytes,
      processedAt: result.processedAt,
      indexedAt: '',
      category: prev?.category,
      subcategory: prev?.subcategory,
      confidence: prev?.confidence,
      labeledCategory: prev?.labeledCategory,
      regexMetadata: extractFromText(schema, text),
      llmMetadata: prev?.llmMetadata ?? [],
      manualMetadata: prev?.manualMetadata ?? [],
      metadata: [],
      candidates: prev?.candidates ?? [],
      summary: '',
      textHead: text.slice(0, schema.settings.textIndexChars),
    };
    return this.finalise(d);
  }

  /** Locate a saved extraction JSON for a jobId (files are named <base>_<jobId[0:8]>.json). */
  findOutput(jobId: string): ExtractionResult | null {
    try {
      const short = jobId.slice(0, 8);
      for (const f of fs.readdirSync(this.outputDir)) {
        if (!f.endsWith('.json') || !f.includes(short)) continue;
        const parsed = JSON.parse(fs.readFileSync(path.join(this.outputDir, f), 'utf-8')) as ExtractionResult;
        if (parsed.jobId === jobId) return parsed;
      }
    } catch { /* no output dir yet */ }
    return null;
  }

  applyClassification(jobId: string, p: ClassificationPayload): IndexedDocument {
    const schema = this.getSchema();
    let d = this.store.get(jobId);
    if (!d) {
      const saved = this.findOutput(jobId);
      if (saved) d = this.indexExtraction(saved);
      else if (p.filename || p.fullText) {
        d = this.indexExtraction({
          jobId, filename: p.filename ?? jobId, fullText: p.fullText ?? '',
        } as ExtractionResult);
      } else {
        throw new Error(`Unknown jobId ${jobId} — extract it first, or send filename + fullText`);
      }
    }

    if (p.category !== undefined)        d.category = p.category || undefined;
    if (p.subcategory !== undefined)     d.subcategory = p.subcategory || undefined;
    if (p.confidence !== undefined)      d.confidence = p.confidence || undefined;
    if (p.labeledCategory !== undefined) d.labeledCategory = p.labeledCategory || undefined;

    if (p.search_metadata || p.key_fields) {
      const { approved, candidates } = mapLlmFields(schema, p.search_metadata, p.key_fields);
      d.llmMetadata = approved;
      d.candidates = candidates;
    }
    if (p.manual_metadata) {
      const { approved } = mapLlmFields(schema, p.manual_metadata);
      d.manualMetadata = approved.map((m): MetadataValue => ({ ...m, sources: ['manual'], confidence: 1 }));
    }
    return this.finalise(d);
  }

  /** Re-index every saved extraction in OUTPUT_DIR (keeps prior classifications). */
  rebuild(): { indexed: number; skipped: number } {
    let indexed = 0, skipped = 0;
    const fromFiles = new Set<string>();
    let files: string[] = [];
    try { files = fs.readdirSync(this.outputDir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
    // Oldest first, so when the same file was extracted several times the newest run wins.
    const mtime = (f: string) => { try { return fs.statSync(path.join(this.outputDir, f)).mtimeMs; } catch { return 0; } };
    files.sort((a, b) => mtime(a) - mtime(b));
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.outputDir, f), 'utf-8')) as ExtractionResult;
        if (!r.jobId || typeof r.fullText !== 'string') { skipped++; continue; }
        this.indexExtraction({ ...r, outputFile: r.outputFile || path.join(this.outputDir, f) });
        fromFiles.add(r.jobId);
        indexed++;
      } catch { skipped++; }
    }
    // Documents that only exist in the index (no output file) are re-finalised under the current schema.
    for (const d of this.store.all()) {
      if (fromFiles.has(d.jobId)) continue;
      const schema = this.getSchema();
      d.regexMetadata = extractFromText(schema, d.textHead);
      this.finalise(d);
    }
    this.store.saveNow();
    return { indexed, skipped };
  }

  /** Approved keys to request from the classifier for a category. */
  promptFields(category?: string | null): { key: string; label: string; kind: string }[] {
    const schema = this.getSchema();
    const keys = category ? fieldsForCategory(schema, category)
      : [...new Set(Object.values(schema.raw.categoryFields ?? {}).flat())];
    return keys
      .map((k) => schema.fields.get(k))
      .filter((f): f is NonNullable<typeof f> => !!f)
      .map((f) => ({ key: f.key, label: f.label, kind: f.kind }));
  }
}
