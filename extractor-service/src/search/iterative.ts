// ─────────────────────────────────────────────────────────────
//  Iterative (pivot) search
//
//  Example — "CIF 1234567":
//    hop 0  cif=1234567            → account_opening_form.pdf
//           that doc also carries account_number=1012345678901,
//           iban=AE07026000101234567890 1, emirates_id=784…
//    hop 1  account_number=1012…   → statement_march.pdf   (has the account
//                                                          number ONLY)
//           emirates_id=784…       → eid_front.jpg
//    hop 2  passport_number from eid_front.jpg → passport_scan.png
//
//  Only keys in the selected search pattern's `correlatedFields` are
//  followed, and only those marked `pivot: true` in the schema are used
//  to expand. Values that hit more than `maxFanoutPerValue` documents
//  (a shared branch phone number, say) are matched but never expanded,
//  so one noisy value can't drag in the whole corpus.
// ─────────────────────────────────────────────────────────────

import { CompiledSchema, SearchPattern, normaliseName, normaliseValue, resolveAlias, applyNormalizer } from './schema';
import { extractFromText, mergeAndDerive } from './extract';
import { IndexStore, IndexedDocument } from './store';
import { bm25, cosine, embed, tokenize } from './semantic';

export interface SearchSeed { key?: string; value: string }

export interface SearchRequest {
  /** Free text: identifiers are pulled out as seeds, the rest ranks semantically */
  query?: string;
  /** Explicit seeds; `key` may be any approved key or alias, or omitted */
  seeds?: SearchSeed[];
  /** Start from everything an already-found document knows */
  seedJobId?: string;
  /** Search pattern name from metadata-schema.json; auto-picked from the query if omitted */
  pattern?: string;
  maxHops?: number;
  limit?: number;
  /** Only return documents in this category (classifier or human label) */
  category?: string;
  /** Rank by meaning only: skip identifier extraction and pivoting, use the whole query as text */
  semanticOnly?: boolean;
}

export interface Via { jobId: string; filename: string; key: string }

export interface MatchEvidence {
  key: string;
  value: string;
  hop: number;
  /** null = came straight from the query */
  via: Via | null;
  similarity?: number;
}

export interface SearchHit {
  jobId: string;
  filename: string;
  /** Basename of the saved extraction JSON — fetch via GET /outputs/:file */
  outputFile?: string;
  category?: string;
  subcategory?: string;
  labeledCategory?: string;
  hop: number;
  score: number;
  metadataScore: number;
  semanticScore: number;
  matchedOn: MatchEvidence[];
  metadata: { key: string; value: string; sources: string[] }[];
}

export interface TraceProbe {
  key: string;
  value: string;
  via: Via | null;
  matched: number;
  newDocuments: number;
  note?: string;
}

export interface SearchResponse {
  pattern: { name: string; label: string; correlatedFields: string[] };
  seeds: { key: string; value: string; detectedBy: string }[];
  residualQuery: string;
  mode: 'metadata' | 'semantic';
  /** Everything learned about the entity being searched for */
  entity: Record<string, { value: string; documents: number }[]>;
  hits: SearchHit[];
  trace: { hop: number; probes: TraceProbe[] }[];
  totalMatched: number;
  tookMs: number;
}

interface Probe { key: string; norm: string; value: string; hop: number; via: Via | null }

const SYNTAX = /\b([a-z_]+)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi;

function pickPattern(schema: CompiledSchema, req: SearchRequest): string {
  const pats = schema.raw.searchPatterns ?? {};
  if (req.pattern && pats[req.pattern]) return req.pattern;
  const q = ` ${(req.query ?? '').toLowerCase()} `;
  let best: string | null = null, bestHits = 0;
  for (const [name, p] of Object.entries(pats)) {
    const hits = (p.triggers ?? []).filter((t) => q.includes(t.toLowerCase())).length;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best ?? Object.keys(pats)[0];
}

function nameSimilarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // Containment rather than Jaccard so "Ahmed Mansoori" matches "Ahmed Ali Al Mansoori" well.
  return inter / Math.min(A.size, B.size) * (0.7 + 0.3 * inter / Math.max(A.size, B.size));
}

/** Pull seeds out of the request; return them plus whatever text is left over. */
function resolveSeeds(schema: CompiledSchema, store: IndexStore, req: SearchRequest, allowed: Set<string>, pattern?: SearchPattern) {
  const seeds: { key: string; norm: string; value: string; detectedBy: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string, norm: string, value: string, detectedBy: string) => {
    const id = key + '|' + norm;
    if (seen.has(id)) return;
    seen.add(id);
    seeds.push({ key, norm, value, detectedBy });
  };

  // 1. explicit seeds
  for (const s of req.seeds ?? []) {
    const key = s.key ? resolveAlias(schema, s.key) : null;
    if (key) {
      const norm = normaliseValue(schema, key, s.value);
      if (norm) push(key, norm, s.value, 'explicit');
    } else {
      for (const g of guessKeys(schema, store, s.value, allowed)) push(g.key, g.norm, s.value, 'value lookup');
    }
  }

  // 2. a document to start from
  if (req.seedJobId) {
    const d = store.get(req.seedJobId);
    for (const m of d?.metadata ?? []) {
      const f = schema.fields.get(m.key);
      if (f && allowed.has(m.key)) push(m.key, m.norm, m.value, `from ${d!.filename}`);
    }
  }

  let residual = req.query ?? '';

  // 3. key:value syntax
  residual = residual.replace(SYNTAX, (whole, k: string, v: string) => {
    const key = resolveAlias(schema, k);
    const val = v.replace(/^["']|["']$/g, '');
    if (!key) return whole;
    const norm = normaliseValue(schema, key, val);
    if (!norm) return whole;
    push(key, norm, val, 'key:value');
    return ' ';
  });

  // 4. labelled identifiers in prose ("CIF 1234567", "IBAN AE07…")
  for (const m of extractFromText(schema, residual)) {
    if (!allowed.has(m.key)) continue;
    push(m.key, m.norm, m.value, 'pattern');
    residual = residual.split(m.value).join(' ');
  }

  // 5. bare tokens that look like identifiers ("1234567", "784-1985-…")
  const tokens = residual.match(/[A-Za-z0-9@._+\-]{4,}/g) ?? [];
  for (const t of tokens) {
    if (!/\d/.test(t) && !t.includes('@')) continue;
    const guesses = guessKeys(schema, store, t, allowed);
    for (const g of guesses) push(g.key, g.norm, t, 'value lookup');
    if (guesses.length) residual = residual.split(t).join(' ');
  }

  // 6. quoted or leftover words that match a known name
  const quoted = [...residual.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const triggerWords = new Set(
    Object.values(schema.raw.searchPatterns ?? {}).flatMap((p) => p.triggers ?? []).flatMap((t) => t.toLowerCase().split(/\s+/))
  );
  const leftoverWords = tokenize(residual).filter((w) => !/\d/.test(w) && !triggerWords.has(w));
  const nameCandidates = [...quoted, leftoverWords.join(' ')].filter((s) => s.trim().split(/\s+/).length >= 2);
  for (const f of schema.fields.values()) {
    if (f.kind !== 'name' || !allowed.has(f.key)) continue;
    for (const cand of nameCandidates) {
      const qn = normaliseName(cand);
      if (!qn) continue;
      const best = store.valuesFor(f.key)
        .map((v) => ({ v, sim: nameSimilarity(qn, v) }))
        .filter((x) => x.sim >= schema.settings.nameMatchThreshold)
        .sort((a, b) => b.sim - a.sim)[0];
      if (best) {
        push(f.key, qn, cand, 'name match');
        for (const w of qn.split(' ')) residual = residual.replace(new RegExp(`\\b${w}\\b`, 'ig'), ' ');
      }
    }
  }

  // 7. derived seeds (an IBAN in the query also searches its account number)
  const derived = mergeAndDerive(schema, seeds.map((x) => ({
    key: x.key, value: x.value, norm: x.norm, sources: ['manual' as const], confidence: 1,
  })));
  for (const d of derived) {
    if (d.sources.includes('derived') && allowed.has(d.key)) push(d.key, d.norm, d.value, 'derived');
  }

  // The words that picked the pattern ("cif", "customer") have done their job.
  for (const t of pattern?.triggers ?? []) residual = residual.replace(new RegExp(`\\b${t}\\b`, 'ig'), ' ');

  return { seeds, residual: residual.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim() };
}

/** "I have a value, which approved key could it be?" — only keys that actually hold it in the index. */
function guessKeys(schema: CompiledSchema, store: IndexStore, raw: string, allowed: Set<string>) {
  const out: { key: string; norm: string }[] = [];
  for (const f of schema.fields.values()) {
    if (!allowed.has(f.key) || f.kind === 'name') continue;
    const norm = normaliseValue(schema, f.key, raw);
    if (norm && store.lookup(f.key, norm).length) out.push({ key: f.key, norm });
  }
  if (!out.length) {
    // Value isn't indexed under any key yet; still accept it if it's unambiguously shaped
    // (e.g. a 784… Emirates ID), so the trace shows what was tried.
    for (const f of schema.fields.values()) {
      if (!allowed.has(f.key) || f.kind === 'name' || !f.validator) continue;
      const norm = applyNormalizer(f.normalize, raw);
      if (f.validator.test(norm) && f.strength >= 0.9 && /[^0-9]|^784/.test(norm)) out.push({ key: f.key, norm });
    }
  }
  return out;
}

export async function iterativeSearch(
  schema: CompiledSchema,
  store: IndexStore,
  req: SearchRequest,
  embedding?: { url: string; model?: string },
): Promise<SearchResponse> {
  const t0 = Date.now();
  const s = schema.settings;
  const patternName = pickPattern(schema, req);
  const pattern = schema.raw.searchPatterns[patternName];
  const allowed = new Set(pattern?.correlatedFields ?? [...schema.fields.keys()]);
  const maxHops = Math.max(0, Math.min(6, req.maxHops ?? pattern?.maxHops ?? s.maxHops));
  const limit = Math.max(1, Math.min(500, req.limit ?? 50));

  const resolved = req.semanticOnly
    ? { seeds: [] as ReturnType<typeof resolveSeeds>['seeds'], residual: req.query ?? '' }
    : resolveSeeds(schema, store, req, allowed, pattern);
  const { seeds, residual } = resolved;

  const hits = new Map<string, SearchHit & { _contribs: number[] }>();
  const visited = new Set<string>();
  const trace: SearchResponse['trace'] = [];

  let frontier: Probe[] = seeds.map((x) => ({ key: x.key, norm: x.norm, value: x.value, hop: 0, via: null }));
  for (const p of frontier) visited.add(p.key + '|' + p.norm);

  // If we started from a document, it is itself hop 0.
  if (!req.semanticOnly && req.seedJobId && store.get(req.seedJobId)) {
    const d = store.get(req.seedJobId)!;
    hits.set(d.jobId, newHit(d, 0, [1]));
  }

  for (let hop = 0; frontier.length && hop <= maxHops; hop++) {
    const probes: TraceProbe[] = [];
    const next: Probe[] = [];

    for (const probe of frontier) {
      const field = schema.fields.get(probe.key)!;
      let matches: { jobId: string; sim: number }[];
      if (field.kind === 'name') {
        matches = store.valuesFor(probe.key)
          .map((v) => ({ v, sim: nameSimilarity(probe.norm, v) }))
          .filter((x) => x.sim >= s.nameMatchThreshold)
          .flatMap((x) => store.lookup(probe.key, x.v).map((jobId) => ({ jobId, sim: x.sim })));
      } else {
        matches = store.lookup(probe.key, probe.norm).map((jobId) => ({ jobId, sim: 1 }));
      }

      const isHub = matches.length > s.maxFanoutPerValue;
      let newDocs = 0;

      for (const m of matches) {
        const d = store.get(m.jobId);
        if (!d) continue;
        // A value pivoted out of a document trivially matches that document again — not evidence.
        if (probe.via?.jobId === d.jobId) continue;
        const md = d.metadata.find((x) => x.key === probe.key && (field.kind === 'name' || x.norm === probe.norm));
        const contrib = field.strength * Math.pow(s.hopDecay, probe.hop) * m.sim * (md?.confidence ?? 0.7);
        let hit = hits.get(d.jobId);
        const isNew = !hit;
        if (!hit) { hit = newHit(d, probe.hop, []); hits.set(d.jobId, hit); newDocs++; }
        hit._contribs.push(contrib);
        hit.matchedOn.push({
          key: probe.key, value: md?.value ?? probe.value, hop: probe.hop, via: probe.via,
          ...(m.sim < 1 ? { similarity: +m.sim.toFixed(2) } : {}),
        });

        // Expand from newly reached documents, unless this value is a hub.
        if (isNew && !isHub && probe.hop < maxHops) {
          for (const mv of d.metadata) {
            const f = schema.fields.get(mv.key);
            if (!f?.pivot || !allowed.has(mv.key)) continue;
            const id = mv.key + '|' + mv.norm;
            if (visited.has(id)) continue;
            visited.add(id);
            next.push({ key: mv.key, norm: mv.norm, value: mv.value, hop: probe.hop + 1,
                        via: { jobId: d.jobId, filename: d.filename, key: mv.key } });
          }
        }
      }

      probes.push({
        key: probe.key, value: probe.value, via: probe.via, matched: matches.length, newDocuments: newDocs,
        ...(isHub ? { note: `matched ${matches.length} documents — treated as a shared value, not expanded` } : {}),
        ...(!matches.length ? { note: 'no indexed document carries this value' } : {}),
      });
    }

    trace.push({ hop, probes });
    frontier = next;
  }

  const mode: SearchResponse['mode'] = !req.semanticOnly && (seeds.length || req.seedJobId) ? 'metadata' : 'semantic';

  // ── Semantic ranking over the residual text ──────────────
  const universe: IndexedDocument[] = mode === 'semantic'
    ? store.all()
    : [...hits.keys()].map((id) => store.get(id)!).filter(Boolean);
  const qTokens = tokenize(residual);
  let sem = new Map<string, number>();
  if (qTokens.length && universe.length) {
    sem = bm25(qTokens, universe.map((d) => ({ id: d.jobId, ...store.termStats(d.jobId) })));
    const vec = embedding?.model ? (await embed(embedding.url, embedding.model, [residual]))?.[0] : undefined;
    if (vec) {
      for (const d of universe) {
        if (!d.vector) continue;
        const c = Math.max(0, cosine(vec, d.vector));
        sem.set(d.jobId, 0.5 * (sem.get(d.jobId) ?? 0) + 0.5 * c);
      }
    }
  }

  if (mode === 'semantic') {
    for (const d of universe) {
      const sc = sem.get(d.jobId) ?? 0;
      if (sc > 0.05) hits.set(d.jobId, newHit(d, 0, []));
    }
  }

  const catFilter = req.category?.trim().toLowerCase();
  const results: SearchHit[] = [...hits.values()]
    .filter((h) => !catFilter ||
      [h.category, h.labeledCategory, h.subcategory].some((c) => c?.toLowerCase() === catFilter))
    .map((h) => {
      const metadataScore = h._contribs.length ? 1 - h._contribs.reduce((p, c) => p * (1 - Math.min(0.999, c)), 1) : 0;
      const semanticScore = sem.get(h.jobId) ?? 0;
      const w = mode === 'semantic' ? 1 : qTokens.length ? s.semanticWeight : 0;
      const score = (1 - w) * metadataScore + w * semanticScore;
      const { _contribs, ...rest } = h;
      return { ...rest, metadataScore: +metadataScore.toFixed(4), semanticScore: +semanticScore.toFixed(4), score: +score.toFixed(4) };
    })
    .sort((a, b) => b.score - a.score || a.hop - b.hop);

  // ── Entity profile: every correlated value seen across reached documents ──
  const entity: SearchResponse['entity'] = {};
  if (mode === 'metadata') {
    const agg = new Map<string, Map<string, { value: string; docs: Set<string> }>>();
    for (const h of results) {
      const d = store.get(h.jobId)!;
      for (const m of d.metadata) {
        if (!allowed.has(m.key)) continue;
        const byNorm = agg.get(m.key) ?? new Map();
        const e = byNorm.get(m.norm) ?? { value: m.value, docs: new Set<string>() };
        e.docs.add(d.jobId);
        byNorm.set(m.norm, e);
        agg.set(m.key, byNorm);
      }
    }
    for (const key of pattern?.correlatedFields ?? []) {
      const byNorm = agg.get(key);
      if (byNorm) entity[key] = [...byNorm.values()]
        .map((e) => ({ value: e.value, documents: e.docs.size }))
        .sort((a, b) => b.documents - a.documents);
    }
  }

  return {
    pattern: { name: patternName, label: pattern?.label ?? patternName, correlatedFields: [...allowed] },
    seeds: seeds.map(({ key, value, detectedBy }) => ({ key, value, detectedBy })),
    residualQuery: tokenize(residual).join(' '),
    mode,
    entity,
    hits: results.slice(0, limit),
    trace,
    totalMatched: results.length,
    tookMs: Date.now() - t0,
  };
}

function newHit(d: IndexedDocument, hop: number, contribs: number[]): SearchHit & { _contribs: number[] } {
  return {
    jobId: d.jobId,
    filename: d.filename,
    outputFile: d.outputFile ? d.outputFile.split(/[\\/]/).pop() : undefined,
    category: d.category,
    subcategory: d.subcategory,
    labeledCategory: d.labeledCategory,
    hop,
    score: 0, metadataScore: 0, semanticScore: 0,
    matchedOn: [],
    metadata: d.metadata.map((m) => ({ key: m.key, value: m.value, sources: m.sources })),
    _contribs: contribs,
  };
}
