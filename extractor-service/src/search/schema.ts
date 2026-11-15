// ─────────────────────────────────────────────────────────────
//  Approved metadata schema
//
//  metadata-schema.json (repo root, next to skill.md) is the single
//  source of truth for which metadata keys are searchable, how their
//  values are normalised, which regexes pull them out of raw text, and
//  which keys may be used together ("correlated") for each search
//  pattern. Nothing outside this file is ever indexed as a pivot key.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';

export type FieldKind = 'identifier' | 'contact' | 'name' | 'date' | 'text';

export type NormalizerName =
  | 'digits' | 'account' | 'alnum_upper' | 'lower' | 'phone_uae' | 'name' | 'none';

export type DeriveFn = 'last4' | 'uae_iban_account';

export interface FieldDef {
  label: string;
  kind: FieldKind;
  /** 0–1: how much a match on this key says "same entity" */
  strength: number;
  /** May values of this key be used to expand an iterative search? */
  pivot: boolean;
  normalize: NormalizerName;
  /** Regex the *normalised* value must satisfy */
  validate?: string;
  /** LLM / key_fields names that map onto this approved key */
  aliases: string[];
  /** Regexes (group 1 = value) run case-insensitively over document text */
  patterns?: string[];
  /** Extra approved values computed from this one */
  derive?: { to: string; fn: DeriveFn }[];
}

export interface SearchPattern {
  label: string;
  description?: string;
  /** Words in a free-text query that select this pattern */
  triggers?: string[];
  /** Approved keys that may be matched AND pivoted on for this pattern */
  correlatedFields: string[];
  maxHops?: number;
}

export interface SchemaSettings {
  hopDecay: number;
  maxHops: number;
  maxFanoutPerValue: number;
  nameMatchThreshold: number;
  semanticWeight: number;
  textIndexChars: number;
}

export interface MetadataSchema {
  version: number;
  settings: SchemaSettings;
  fields: Record<string, FieldDef>;
  categoryFields: Record<string, string[]>;
  searchPatterns: Record<string, SearchPattern>;
}

export interface CompiledField extends FieldDef {
  key: string;
  regexes: RegExp[];
  validator?: RegExp;
}

export interface CompiledSchema {
  path: string;
  raw: MetadataSchema;
  settings: SchemaSettings;
  fields: Map<string, CompiledField>;
  /** normalised alias → approved key */
  aliasMap: Map<string, string>;
}

const DEFAULT_SETTINGS: SchemaSettings = {
  hopDecay: 0.6,
  maxHops: 3,
  maxFanoutPerValue: 25,
  nameMatchThreshold: 0.8,
  semanticWeight: 0.35,
  textIndexChars: 8000,
};

// ── Loading ───────────────────────────────────────────────────
let cache: { path: string; mtimeMs: number; schema: CompiledSchema } | null = null;

function candidates(explicit?: string): string[] {
  if (explicit) return [explicit];
  return [
    process.env.METADATA_SCHEMA_FILE ?? '',
    path.resolve(process.cwd(), 'metadata-schema.json'),
    path.resolve(process.cwd(), '../metadata-schema.json'),
    path.resolve(__dirname, '../../../metadata-schema.json'),
    path.resolve(__dirname, '../../metadata-schema.json'),
  ].filter(Boolean);
}

export function normaliseKeyName(k: string): string {
  return String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function compileSchema(raw: MetadataSchema, sourcePath = '<inline>'): CompiledSchema {
  const fields = new Map<string, CompiledField>();
  const aliasMap = new Map<string, string>();

  for (const [key, def] of Object.entries(raw.fields ?? {})) {
    const regexes = (def.patterns ?? []).map((p) => {
      try { return new RegExp(p, 'gi'); }
      catch (e) { throw new Error(`metadata-schema: bad pattern for "${key}": ${(e as Error).message}`); }
    });
    const compiled: CompiledField = {
      ...def,
      key,
      aliases: def.aliases ?? [],
      strength: def.strength ?? 0.5,
      pivot: def.pivot ?? false,
      normalize: def.normalize ?? 'none',
      regexes,
      validator: def.validate ? new RegExp(def.validate) : undefined,
    };
    fields.set(key, compiled);
    aliasMap.set(normaliseKeyName(key), key);
    for (const a of compiled.aliases) aliasMap.set(normaliseKeyName(a), key);
  }

  for (const [name, pat] of Object.entries(raw.searchPatterns ?? {})) {
    for (const f of pat.correlatedFields) {
      if (!fields.has(f)) throw new Error(`metadata-schema: search pattern "${name}" references unknown field "${f}"`);
    }
  }

  return {
    path: sourcePath,
    raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    fields,
    aliasMap,
  };
}

export function loadSchema(explicit?: string): CompiledSchema {
  const tried = candidates(explicit);
  for (const p of tried) {
    let stat: fs.Stats;
    try { stat = fs.statSync(p); } catch { continue; }
    if (!stat.isFile()) continue;
    if (cache && cache.path === p && cache.mtimeMs === stat.mtimeMs) return cache.schema;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as MetadataSchema;
    const schema = compileSchema(raw, p);
    cache = { path: p, mtimeMs: stat.mtimeMs, schema };
    return schema;
  }
  throw new Error('Could not find metadata-schema.json. Set METADATA_SCHEMA_FILE. Tried: ' + tried.join(', '));
}

export function clearSchemaCache(): void { cache = null; }

// ── Lookups ───────────────────────────────────────────────────
export function resolveAlias(schema: CompiledSchema, key: string): string | null {
  return schema.aliasMap.get(normaliseKeyName(key)) ?? null;
}

/** Approved keys the classifier should pull for a category (falls back to "*"). */
export function fieldsForCategory(schema: CompiledSchema, category?: string | null): string[] {
  const cf = schema.raw.categoryFields ?? {};
  if (category) {
    const hit = Object.keys(cf).find((k) => k.toLowerCase() === category.trim().toLowerCase());
    if (hit) return cf[hit];
  }
  return cf['*'] ?? [...schema.fields.keys()];
}

// ── Normalisation ─────────────────────────────────────────────
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sheikh', 'shaikh', 'm/s', 'ms.', 'mr.']);

export function normaliseName(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z؀-ۿ\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !HONORIFICS.has(t))
    .sort()
    .join(' ');
}

export function applyNormalizer(n: NormalizerName, raw: string): string {
  const v = String(raw ?? '').trim();
  switch (n) {
    case 'digits':      return v.replace(/\D/g, '');
    case 'account':     return v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    case 'alnum_upper': return v.replace(/[^a-z0-9]/gi, '').toUpperCase();
    case 'lower':       return v.toLowerCase();
    case 'name':        return normaliseName(v);
    case 'phone_uae': {
      let d = v.replace(/\D/g, '');
      if (d.startsWith('00')) d = d.slice(2);
      if (d.startsWith('0'))  d = '971' + d.slice(1);
      if (/^5\d{8}$/.test(d)) d = '971' + d;
      return d;
    }
    default: return v;
  }
}

/** Normalise + validate. Returns null when the value isn't a usable key. */
export function normaliseValue(schema: CompiledSchema, key: string, raw: unknown): string | null {
  const f = schema.fields.get(key);
  if (!f || raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(null|none|n\/?a|unknown|-+)$/i.test(s)) return null;
  const norm = applyNormalizer(f.normalize, s);
  if (!norm) return null;
  if (f.validator && !f.validator.test(norm)) return null;
  return norm;
}

export function deriveValue(fn: DeriveFn, norm: string): string | null {
  switch (fn) {
    case 'last4':
      return norm.length >= 4 ? norm.slice(-4) : null;
    case 'uae_iban_account':
      // AE kk bbb aaaaaaaaaaaaaaaa — 23 chars, last 16 are the account number (zero-padded)
      if (/^AE\d{21}$/.test(norm)) return norm.slice(7).replace(/^0+(?=\d)/, '');
      return null;
    default:
      return null;
  }
}
