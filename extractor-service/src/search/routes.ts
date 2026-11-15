// ─────────────────────────────────────────────────────────────
//  Search & metadata-index HTTP routes
//
//  GET  /metadata/schema                 approved fields, category map, search patterns
//  GET  /metadata/fields?category=X      approved keys the classifier should pull for X
//  POST /metadata/schema/reload          re-read metadata-schema.json
//  GET  /metadata/candidates             unapproved keys the LLM keeps returning
//
//  GET  /index/stats
//  GET  /index/documents/:jobId
//  POST /index/documents/:jobId/classification   attach classifier output / label / manual values
//  DELETE /index/documents/:jobId
//  POST /index/rebuild                   re-index everything in OUTPUT_DIR
//
//  POST /search                          { query?, seeds?, seedJobId?, pattern?, maxHops?, limit?, category? }
//  GET  /search?q=…&pattern=…&maxHops=…
// ─────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import path from 'path';
import { CompiledSchema, loadSchema, clearSchemaCache } from './schema';
import { IndexStore } from './store';
import { Indexer, ClassificationPayload } from './indexer';
import { iterativeSearch, SearchRequest } from './iterative';

export interface SearchModule {
  router: Router;
  indexer: Indexer;
  store: IndexStore;
  getSchema: () => CompiledSchema;
}

type Logger = (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: object) => void;

export function createSearchModule(opts: {
  outputDir: string;
  schemaFile?: string;
  embeddingUrl: string;
  embeddingModel?: string;
  log: Logger;
}): SearchModule {
  const getSchema = () => loadSchema(opts.schemaFile || undefined);
  const schema = getSchema();
  opts.log('info', 'metadata schema loaded', {
    path: schema.path, fields: schema.fields.size, patterns: Object.keys(schema.raw.searchPatterns ?? {}),
  });

  const store = new IndexStore(path.join(opts.outputDir, '_index'));
  const embedding = { url: opts.embeddingUrl, model: opts.embeddingModel || undefined };
  const indexer = new Indexer(store, getSchema, opts.outputDir, embedding);
  opts.log('info', 'metadata index loaded', { file: store.file, documents: store.size() });

  const router = Router();
  const fail = (res: Response, status: number, err: unknown) =>
    res.status(status).json({ success: false, error: (err as Error).message ?? String(err) });

  // ── schema ──────────────────────────────────────────────
  router.get('/metadata/schema', (_req, res) => {
    try {
      const s = getSchema();
      res.json({ success: true, data: { path: s.path, ...s.raw, settings: s.settings } });
    } catch (e) { fail(res, 500, e); }
  });

  router.get('/metadata/fields', (req, res) => {
    try {
      const category = req.query['category'] ? String(req.query['category']) : null;
      res.json({ success: true, data: { category, fields: indexer.promptFields(category) } });
    } catch (e) { fail(res, 500, e); }
  });

  router.post('/metadata/schema/reload', (_req, res) => {
    try {
      clearSchemaCache();
      const s = getSchema();
      opts.log('info', 'metadata schema reloaded', { path: s.path, fields: s.fields.size });
      res.json({ success: true, data: { path: s.path, fields: s.fields.size, hint: 'POST /index/rebuild to apply new patterns to existing documents' } });
    } catch (e) { fail(res, 400, e); }
  });

  router.get('/metadata/candidates', (_req, res) => {
    res.json({ success: true, data: store.candidateSummary() });
  });

  // ── index ───────────────────────────────────────────────
  router.get('/index/stats', (_req, res) => {
    const docs = store.all();
    const byKey: Record<string, number> = {};
    for (const d of docs) for (const k of new Set(d.metadata.map((m) => m.key))) byKey[k] = (byKey[k] ?? 0) + 1;
    res.json({
      success: true,
      data: {
        documents: docs.length,
        classified: docs.filter((d) => d.category).length,
        embedded: docs.filter((d) => d.vector).length,
        embeddingModel: embedding.model ?? null,
        documentsPerKey: byKey,
        file: store.file,
      },
    });
  });

  router.get('/index/documents/:jobId', (req, res) => {
    const d = store.get(req.params.jobId);
    if (!d) { res.status(404).json({ success: false, error: 'Not indexed' }); return; }
    const { vector, ...rest } = d;
    res.json({ success: true, data: { ...rest, hasVector: !!vector } });
  });

  router.post('/index/documents/:jobId/classification', (req: Request, res: Response) => {
    try {
      const d = indexer.applyClassification(req.params.jobId, (req.body ?? {}) as ClassificationPayload);
      opts.log('info', 'index: classification applied', {
        jobId: d.jobId, category: d.category, keys: d.metadata.map((m) => m.key), candidates: d.candidates.length,
      });
      res.json({
        success: true,
        data: { jobId: d.jobId, category: d.category, subcategory: d.subcategory,
                metadata: d.metadata, candidates: d.candidates },
      });
    } catch (e) { fail(res, /Unknown jobId/.test((e as Error).message) ? 404 : 400, e); }
  });

  router.delete('/index/documents/:jobId', (req, res) => {
    res.json({ success: store.remove(req.params.jobId) });
  });

  router.post('/index/rebuild', (_req, res) => {
    try {
      const r = indexer.rebuild();
      opts.log('info', 'index rebuilt', r);
      res.json({ success: true, data: { ...r, documents: store.size() } });
    } catch (e) { fail(res, 500, e); }
  });

  // ── search ──────────────────────────────────────────────
  const runSearch = async (body: SearchRequest, res: Response) => {
    try {
      if (!body.query?.trim() && !body.seeds?.length && !body.seedJobId) {
        res.status(400).json({ success: false, error: 'Provide "query", "seeds" or "seedJobId"' });
        return;
      }
      const out = await iterativeSearch(getSchema(), store, body, embedding);
      opts.log('info', 'search', {
        query: body.query, pattern: out.pattern.name, seeds: out.seeds.length,
        hops: out.trace.length, hits: out.totalMatched, tookMs: out.tookMs,
      });
      res.json({ success: true, data: out });
    } catch (e) { fail(res, 500, e); }
  };

  router.post('/search', (req, res) => runSearch((req.body ?? {}) as SearchRequest, res));
  router.get('/search', (req, res) => runSearch({
    query: req.query['q'] ? String(req.query['q']) : undefined,
    pattern: req.query['pattern'] ? String(req.query['pattern']) : undefined,
    maxHops: req.query['maxHops'] ? parseInt(String(req.query['maxHops']), 10) : undefined,
    limit: req.query['limit'] ? parseInt(String(req.query['limit']), 10) : undefined,
    category: req.query['category'] ? String(req.query['category']) : undefined,
    seedJobId: req.query['seedJobId'] ? String(req.query['seedJobId']) : undefined,
  }, res));

  return { router, indexer, store, getSchema };
}
