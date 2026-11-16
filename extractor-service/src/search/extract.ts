// ─────────────────────────────────────────────────────────────
//  Metadata extraction
//
//  Two sources feed the index for every document:
//    1. regex  — the schema's patterns run over the extracted text.
//                Deterministic and good at identifiers even when a
//                small model misses them.
//    2. llm    — whatever the classifier returned in `search_metadata`
//                / `key_fields`, mapped onto approved keys via aliases.
//  Values that don't map to an approved key are kept separately as
//  candidates so they can be reviewed and added to the schema.
// ─────────────────────────────────────────────────────────────

import {
  CompiledSchema,
  deriveValue,
  normaliseValue,
  resolveAlias,
  normaliseKeyName,
} from './schema';

export type MetadataSource = 'regex' | 'llm' | 'derived' | 'manual';

export interface MetadataValue {
  key: string;
  value: string;
  norm: string;
  sources: MetadataSource[];
  /** 0–1 extraction confidence */
  confidence: number;
}

export interface CandidateValue {
  key: string;
  value: string;
}

const SOURCE_CONFIDENCE: Record<MetadataSource, number> = {
  regex: 0.85, llm: 0.7, derived: 0.8, manual: 1,
};

function add(out: Map<string, MetadataValue>, key: string, value: string, norm: string, source: MetadataSource) {
  const id = key + '\u0000' + norm;
  const existing = out.get(id);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    // Two independent sources agreeing → near-certain
    existing.confidence = Math.min(1, Math.max(existing.confidence, SOURCE_CONFIDENCE[source]) +
      (existing.sources.length > 1 ? 0.15 : 0));
    return;
  }
  out.set(id, { key, value, norm, sources: [source], confidence: SOURCE_CONFIDENCE[source] });
}

/** Run every approved field's regexes over the text. */
export function extractFromText(schema: CompiledSchema, text: string, onlyKeys?: string[]): MetadataValue[] {
  const out = new Map<string, MetadataValue>();
  if (!text) return [];
  const limit = text.slice(0, 200_000);
  for (const f of schema.fields.values()) {
    if (onlyKeys && !onlyKeys.includes(f.key)) continue;
    for (const re of f.regexes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(limit)) && guard++ < 200) {
        const raw = (m[1] ?? m[0]).trim();
        const norm = normaliseValue(schema, f.key, raw);
        if (norm) add(out, f.key, raw, norm, 'regex');
        // A rejected capture ("Passport Passport No N123…") may have swallowed the
        // real label — retry from just after where this match started.
        else re.lastIndex = m.index + 1;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return [...out.values()];
}

function flattenLeaves(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(flattenLeaves);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(flattenLeaves);
  const s = String(v).trim();
  return s ? [s] : [];
}

/** Map LLM-supplied fields (search_metadata ∪ key_fields) onto approved keys. */
export function mapLlmFields(
  schema: CompiledSchema,
  ...objects: (Record<string, unknown> | null | undefined)[]
): { approved: MetadataValue[]; candidates: CandidateValue[] } {
  const out = new Map<string, MetadataValue>();
  const candidates: CandidateValue[] = [];
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [rawKey, rawVal] of Object.entries(obj)) {
      const key = resolveAlias(schema, rawKey);
      const leaves = flattenLeaves(rawVal);
      if (!key) {
        for (const v of leaves) {
          if (!/^(null|none|n\/?a)$/i.test(v)) candidates.push({ key: normaliseKeyName(rawKey), value: v });
        }
        continue;
      }
      for (const v of leaves) {
        const norm = normaliseValue(schema, key, v);
        if (norm) add(out, key, v, norm, 'llm');
      }
    }
  }
  return { approved: [...out.values()], candidates };
}

/** Merge lists, then add derived values (IBAN → account number, account → last4…). */
export function mergeAndDerive(schema: CompiledSchema, ...lists: MetadataValue[][]): MetadataValue[] {
  const out = new Map<string, MetadataValue>();
  for (const list of lists) {
    for (const mv of list) {
      for (const s of mv.sources) add(out, mv.key, mv.value, mv.norm, s);
      const merged = out.get(mv.key + '\u0000' + mv.norm)!;
      merged.confidence = Math.max(merged.confidence, mv.confidence);
    }
  }
  // Derivations can chain (IBAN → account → last4), so iterate to a fixpoint.
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    for (const mv of [...out.values()]) {
      const f = schema.fields.get(mv.key);
      for (const d of f?.derive ?? []) {
        const dv = deriveValue(d.fn, mv.norm);
        if (!dv) continue;
        const norm = normaliseValue(schema, d.to, dv);
        if (!norm) continue;
        const id = d.to + '\u0000' + norm;
        if (!out.has(id)) { added = true; }
        add(out, d.to, dv, norm, 'derived');
      }
    }
    if (!added) break;
  }
  return [...out.values()];
}
