// ─────────────────────────────────────────────────────────────
//  Semantic ranking
//
//  Always available: BM25 over a per-document "semantic summary"
//  (category, subcategory, approved metadata labels + values) plus the
//  head of the extracted text.
//
//  Optional: dense embeddings from LM Studio's /v1/embeddings when
//  EMBEDDING_MODEL is set (e.g. "text-embedding-nomic-embed-text-v1.5").
//  If the call fails the service silently stays on BM25.
// ─────────────────────────────────────────────────────────────

const STOP = new Set(
  ('a an and are as at be by for from has have in is it its of on or that the this to was were will with ' +
   'all any find show me my our document documents docs file files please get search list').split(' ')
);

export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function termFreq(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

export interface Bm25Doc { id: string; tf: Record<string, number>; len: number }

/** Returns id → score normalised to 0–1 (best doc = 1). */
export function bm25(queryTokens: string[], docs: Bm25Doc[], k1 = 1.4, b = 0.75): Map<string, number> {
  const scores = new Map<string, number>();
  if (!queryTokens.length || !docs.length) return scores;
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df: Record<string, number> = {};
  const uniq = [...new Set(queryTokens)];
  for (const q of uniq) df[q] = docs.reduce((s, d) => s + (d.tf[q] ? 1 : 0), 0);

  let max = 0;
  for (const d of docs) {
    let s = 0;
    for (const q of uniq) {
      const f = d.tf[q];
      if (!f) continue;
      const idf = Math.log(1 + (N - df[q] + 0.5) / (df[q] + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgLen));
    }
    if (s > 0) { scores.set(d.id, s); max = Math.max(max, s); }
  }
  if (max > 0) for (const [k, v] of scores) scores.set(k, v / max);
  return scores;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function normaliseBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : trimmed + '/v1';
}

/** Embed texts via LM Studio. Returns null if not configured or unavailable. */
export async function embed(url: string, model: string | undefined, texts: string[]): Promise<number[][] | null> {
  if (!model || !texts.length) return null;
  try {
    const res = await fetch(normaliseBase(url) + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const payload: any = await res.json();
    const vecs = (payload?.data ?? []).map((d: any) => d?.embedding as number[]);
    return vecs.length === texts.length && vecs.every(Array.isArray) ? vecs : null;
  } catch {
    return null;
  }
}
