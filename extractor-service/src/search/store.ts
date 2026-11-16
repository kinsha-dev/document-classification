// ─────────────────────────────────────────────────────────────
//  Metadata index store
//
//  One JSON file (<OUTPUT_DIR>/_index/metadata-index.json) holding every
//  indexed document, with in-memory inverted maps rebuilt on load:
//    (key, normValue) → jobIds      exact identifier lookups
//    normValue        → (key, jobId) "I have a number, don't know what it is"
//  The folder sits beside the extraction JSONs; GET /outputs only lists
//  *.json files at the top level, so the index never shows up there.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { MetadataValue, CandidateValue } from './extract';
import { tokenize, termFreq } from './semantic';

export interface IndexedDocument {
  jobId: string;
  filename: string;
  outputFile?: string;
  fileType?: string;
  sizeBytes?: number;
  processedAt?: string;
  indexedAt: string;

  category?: string;
  subcategory?: string;
  confidence?: string;
  /** Category a human confirmed with "Apply Label" */
  labeledCategory?: string;

  /** Per-source metadata, kept apart so a re-classification only replaces its own part */
  regexMetadata: MetadataValue[];
  llmMetadata: MetadataValue[];
  manualMetadata: MetadataValue[];
  /** Merged + derived — what search actually uses */
  metadata: MetadataValue[];
  /** LLM fields with no approved key (for schema review) */
  candidates: CandidateValue[];

  /** Text used for semantic ranking */
  summary: string;
  textHead: string;
  vector?: number[];
}

interface Persisted { version: 1; documents: IndexedDocument[] }

const pairKey = (k: string, v: string) => k + '\u0000' + v;

export class IndexStore {
  private docs = new Map<string, IndexedDocument>();
  private byPair = new Map<string, Set<string>>();
  private byValue = new Map<string, { key: string; jobId: string }[]>();
  private tfCache = new Map<string, { tf: Record<string, number>; len: number }>();
  private saveTimer: NodeJS.Timeout | null = null;
  readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'metadata-index.json');
    this.load();
  }

  // ── persistence ─────────────────────────────────────────
  load(): void {
    this.docs.clear();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Persisted;
      for (const d of raw.documents ?? []) this.docs.set(d.jobId, d);
    } catch { /* first run */ }
    this.reindexAll();
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const body: Persisted = { version: 1, documents: [...this.docs.values()] };
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.saveNow(); } catch { /* logged by caller */ } }, 250);
    this.saveTimer.unref?.();
  }

  // ── inverted maps ───────────────────────────────────────
  private reindexAll(): void {
    this.byPair.clear(); this.byValue.clear(); this.tfCache.clear();
    for (const d of this.docs.values()) this.addPostings(d);
  }

  private addPostings(d: IndexedDocument): void {
    for (const m of d.metadata) {
      const pk = pairKey(m.key, m.norm);
      if (!this.byPair.has(pk)) this.byPair.set(pk, new Set());
      this.byPair.get(pk)!.add(d.jobId);
      const list = this.byValue.get(m.norm) ?? [];
      if (!list.some((x) => x.jobId === d.jobId && x.key === m.key)) list.push({ key: m.key, jobId: d.jobId });
      this.byValue.set(m.norm, list);
    }
  }

  private removePostings(d: IndexedDocument): void {
    for (const m of d.metadata) {
      this.byPair.get(pairKey(m.key, m.norm))?.delete(d.jobId);
      const list = this.byValue.get(m.norm);
      if (list) this.byValue.set(m.norm, list.filter((x) => x.jobId !== d.jobId));
    }
    this.tfCache.delete(d.jobId);
  }

  // ── CRUD ────────────────────────────────────────────────
  upsert(d: IndexedDocument): void {
    const prev = this.docs.get(d.jobId);
    if (prev) this.removePostings(prev);
    this.docs.set(d.jobId, d);
    this.addPostings(d);
    this.scheduleSave();
  }

  remove(jobId: string): boolean {
    const prev = this.docs.get(jobId);
    if (!prev) return false;
    this.removePostings(prev);
    this.docs.delete(jobId);
    this.scheduleSave();
    return true;
  }

  get(jobId: string): IndexedDocument | undefined { return this.docs.get(jobId); }
  all(): IndexedDocument[] { return [...this.docs.values()]; }
  size(): number { return this.docs.size; }

  // ── lookups ─────────────────────────────────────────────
  lookup(key: string, norm: string): string[] {
    return [...(this.byPair.get(pairKey(key, norm)) ?? [])];
  }

  lookupAnyKey(norm: string): { key: string; jobId: string }[] {
    return this.byValue.get(norm) ?? [];
  }

  /** Every distinct normalised value stored for `key` (used for fuzzy name matching). */
  valuesFor(key: string): string[] {
    const out = new Set<string>();
    for (const pk of this.byPair.keys()) {
      const [k, v] = pk.split('\u0000');
      if (k === key && (this.byPair.get(pk)?.size ?? 0) > 0) out.add(v);
    }
    return [...out];
  }

  termStats(jobId: string): { tf: Record<string, number>; len: number } {
    let c = this.tfCache.get(jobId);
    if (!c) {
      const d = this.docs.get(jobId);
      // Summary gets double weight — it carries category + approved metadata.
      const toks = d ? [...tokenize(d.summary), ...tokenize(d.summary), ...tokenize(d.textHead)] : [];
      c = { tf: termFreq(toks), len: toks.length };
      this.tfCache.set(jobId, c);
    }
    return c;
  }

  /** Unapproved keys the LLM keeps returning — candidates for metadata-schema.json */
  candidateSummary(): { key: string; documents: number; examples: string[] }[] {
    const agg = new Map<string, { docs: Set<string>; examples: Set<string> }>();
    for (const d of this.docs.values()) {
      for (const c of d.candidates) {
        const a = agg.get(c.key) ?? { docs: new Set(), examples: new Set() };
        a.docs.add(d.jobId);
        if (a.examples.size < 3) a.examples.add(c.value.slice(0, 60));
        agg.set(c.key, a);
      }
    }
    return [...agg.entries()]
      .map(([key, a]) => ({ key, documents: a.docs.size, examples: [...a.examples] }))
      .sort((x, y) => y.documents - x.documents);
  }
}
