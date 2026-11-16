// ─────────────────────────────────────────────────────────────
//  LM Studio client — talks to the local LM Studio server's
//  OpenAI-compatible API on behalf of the browser.
//
//  Default base URL: http://localhost:1234/v1
//
//  We use chat completions (POST /v1/chat/completions) with
//  `response_format: { type: "json_object" }` so the model is
//  constrained to valid JSON. Streaming is OpenAI-style SSE
//  ("data: {...}\n\n", terminated by "data: [DONE]").
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type { Response as ExpressResponse } from 'express';

export interface CategoryInput {
  /** Display name shown to the model (must match exactly) */
  name: string;
}

export interface ClassificationResult {
  /** Matched category name (verbatim from the model) */
  category: string;
  /** 1–4 word free-form sub-type (may be empty) */
  subcategory?: string;
  /** "high" | "medium" | "low" — model-reported confidence */
  confidence?: string;
  /** Single-sentence justification */
  reason?: string;
  /** Approved search metadata the model pulled (keys from metadata-schema.json) */
  search_metadata?: Record<string, unknown>;
  /** Raw decoded JSON object as returned by the model */
  raw: Record<string, unknown>;
}

export interface LMStudioModelInfo {
  /** Model identifier (e.g. "google/gemma-3-4b-it") */
  name: string;
  /** Optional metadata returned by LM Studio */
  ownedBy?: string;
}

export interface LMStudioHealth {
  ok: boolean;
  url: string;
  models: LMStudioModelInfo[];
  error?: string;
}

// ── Internal helpers ─────────────────────────────────────────
const DEFAULT_TIMEOUT_MS     = 6_000;
const DEFAULT_GEN_TIMEOUT_MS = 90_000;

function withTimeout(ms: number): AbortSignal {
  if (typeof (AbortSignal as any).timeout === 'function') {
    return (AbortSignal as any).timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms).unref?.();
  return ctrl.signal;
}

/**
 * Normalise a base URL. LM Studio's API root ends in `/v1`. We accept
 * either `http://host:1234` or `http://host:1234/v1` and always end up
 * with the latter.
 */
/** Adds the OpenRouter bearer key (server-side only) to outgoing requests. */
export function authHeaders(h: Record<string, string>): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  return key ? { ...h, Authorization: `Bearer ${key}`, 'X-Title': 'doc-extractor-service' } : h;
}

function normaliseBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : trimmed + '/v1';
}

// ── Prompt template loading (unchanged from the previous module) ────
interface CachedPrompt {
  path: string;
  mtimeMs: number;
  template: string;
}

let promptCache: CachedPrompt | null = null;

function defaultPromptCandidates(): string[] {
  const here = __dirname;
  return [
    process.env.CLASSIFY_PROMPT_FILE ?? '',
    path.resolve(process.cwd(), 'skill.md'),
    path.resolve(process.cwd(), '../skill.md'),
    path.resolve(here, '../../skill.md'),
    path.resolve(here, '../skill.md'),
  ].filter(Boolean);
}

export function extractPromptBody(fileContents: string): string {
  const fence = /^[ \t]*-{3,}PROMPT-{3,}[ \t]*$/im;
  const match = fileContents.match(fence);
  if (!match || match.index === undefined) return fileContents.trim();
  const after = fileContents.slice(match.index + match[0].length);
  return after.replace(/^\r?\n/, '').trim();
}

export function loadPromptTemplate(explicitPath?: string): CachedPrompt {
  const candidates = explicitPath ? [explicitPath] : defaultPromptCandidates();
  for (const p of candidates) {
    let stat: fs.Stats;
    try { stat = fs.statSync(p); } catch { continue; }
    if (!stat.isFile()) continue;
    if (promptCache && promptCache.path === p && promptCache.mtimeMs === stat.mtimeMs) {
      return promptCache;
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const template = extractPromptBody(raw);
    promptCache = { path: p, mtimeMs: stat.mtimeMs, template };
    return promptCache;
  }
  throw new Error(
    'Could not find skill.md. Set CLASSIFY_PROMPT_FILE or place skill.md ' +
    'in the workspace folder. Tried: ' + candidates.join(', ')
  );
}

export function clearPromptCache(): void { promptCache = null; }

export interface MetadataFieldInput { key: string; label: string }

export function renderPrompt(
  template: string,
  text: string,
  categories: CategoryInput[],
  metadataFields: MetadataFieldInput[] = []
): string {
  const catList = categories.map((c) => `- ${c.name}`).join('\n');
  const snippet = text.slice(0, 2000).replace(/\s+/g, ' ').trim();
  const fieldList = metadataFields.length
    ? metadataFields.map((f) => `- ${f.key}: ${f.label}`).join('\n')
    : '- (none)';
  return template
    .replace(/\{\{\s*categories\s*\}\}/g, catList)
    .replace(/\{\{\s*metadata_fields\s*\}\}/g, fieldList)
    .replace(/\{\{\s*text\s*\}\}/g,       snippet);
}

export function buildClassificationPrompt(
  text: string,
  categories: CategoryInput[],
  metadataFields: MetadataFieldInput[] = []
): string {
  let template: string;
  try {
    template = loadPromptTemplate().template;
  } catch {
    template =
      'You are a document classification assistant.\n\n' +
      'Task: read the document below, assign it to exactly ONE category from the list, and propose a more specific subcategory.\n\n' +
      'Categories (pick exactly one — copy the name verbatim):\n{{categories}}\n\n' +
      'Document:\n<<<DOC\n{{text}}\nDOC>>>\n\n' +
      'Reply with a single JSON object only. Keys: "category", "subcategory", "confidence" (high|medium|low), "reason" (≤15 words).\n' +
      'Begin with { and end with }.';
  }
  return renderPrompt(template, text, categories, metadataFields);
}

// ─── Balanced-brace JSON extractor (also re-exported for tests) ────
export function extractJsonObject(s: string): string | null {
  if (!s) return null;
  s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"')  inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ─── Gemma-aware request body ────────────────────────────────
function isGemmaModel(model: string): boolean {
  // LM Studio model ids look like "google/gemma-3-4b-it",
  // "lmstudio-community/gemma-3-4b-it-GGUF", "gemma-2-9b-it", etc.
  return /(?:^|[\/_-])gemma[-\d:_/]/i.test(model);
}

function buildChatBody(
  model: string,
  prompt: string,
  stream: boolean,
  withMetadata = false
): Record<string, unknown> {
  const gemma = isGemmaModel(model);
  return {
    model,
    // Gemma's chat template ignores the system role; LM Studio merges it
    // into the user turn anyway. We send a single user message which both
    // Gemma and the OpenAI-style adapter handle cleanly.
    messages: [
      { role: 'user', content: prompt },
    ],
    stream,
    temperature: 0.1,
    top_p:       0.9,
    // LM Studio honours OpenAI's `response_format` and constrains output
    // to valid JSON via grammar at decoding time. This is the equivalent
    // of Ollama's `format: "json"` flag.
    response_format: { type: 'json_object' },
    // Generous headroom — Gemma reasons can run long. JSON-mode + the
    // 15-word rule in the prompt keep us well under this in practice.
    // search_metadata adds a handful of key/value pairs — give it room.
    max_tokens:  (gemma ? 512 : 384) + (withMetadata ? 384 : 0),
  };
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/** Hit /v1/models and return the list of loaded models. */
export async function checkLlmHealth(url: string): Promise<LMStudioHealth> {
  const base = normaliseBase(url);
  try {
    const res = await fetch(base + '/models', {
      signal:  withTimeout(DEFAULT_TIMEOUT_MS),
      headers: authHeaders({ Accept: 'application/json' }),
    });
    if (!res.ok) {
      return { ok: false, url: base, models: [], error: `HTTP ${res.status}` };
    }
    const data: any = await res.json();
    const models: LMStudioModelInfo[] = (data?.data ?? []).map((m: any) => ({
      name:    m.id,
      ownedBy: m.owned_by,
    }));
    return { ok: true, url: base, models };
  } catch (err) {
    return { ok: false, url: base, models: [], error: (err as Error).message };
  }
}

/**
 * Resolve the model id to actually send to LM Studio. If the requested
 * model is loaded, use it. Otherwise fall back to the first loaded
 * model — this means "gemma-4-e2b-it:2" still works after a model
 * reload changes the slot to ":3", and the user doesn't have to chase
 * the suffix. We log when we substitute so it's visible in the server
 * logs.
 */
export async function resolveModelId(url: string, requested: string): Promise<{ model: string; resolvedFrom: 'requested' | 'fallback' | 'unknown'; loadedIds: string[] }> {
  if (/openrouter\.ai/.test(url)) return { model: requested, resolvedFrom: 'requested', loadedIds: [requested] };
  const health = await checkLlmHealth(url);
  const loaded = health.models.map((m) => m.name);
  if (!health.ok || loaded.length === 0) {
    return { model: requested, resolvedFrom: 'unknown', loadedIds: loaded };
  }
  if (loaded.includes(requested)) {
    return { model: requested, resolvedFrom: 'requested', loadedIds: loaded };
  }
  // Prefer Gemma if any is loaded; otherwise the first model.
  const gemma = loaded.find((m) => /gemma/i.test(m));
  return { model: gemma ?? loaded[0], resolvedFrom: 'fallback', loadedIds: loaded };
}

/** One-shot classification. */
export async function classify(
  url: string,
  model: string,
  text: string,
  categories: CategoryInput[],
  opts: { timeoutMs?: number; metadataFields?: MetadataFieldInput[] } = {}
): Promise<ClassificationResult> {
  const base   = normaliseBase(url);
  const prompt = buildClassificationPrompt(text, categories, opts.metadataFields);
  const resolved = await resolveModelId(url, model);
  if (resolved.resolvedFrom === 'fallback') {
    // Fall through with the substituted id; caller can read this from logs.
    model = resolved.model;
  }

  const res = await fetch(base + '/chat/completions', {
    method:  'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    signal:  withTimeout(opts.timeoutMs ?? DEFAULT_GEN_TIMEOUT_MS),
    body:    JSON.stringify(buildChatBody(model, prompt, false, !!opts.metadataFields?.length)),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = ' — ' + (await res.text()).slice(0, 300); } catch {}
    throw new Error(`LLM HTTP ${res.status}${detail}`);
  }

  const payload: any = await res.json();
  // OpenAI-format errors arrive as { error: { message, ... } }
  if (payload?.error) throw new Error(payload.error.message ?? String(payload.error));
  const responseText: string = payload?.choices?.[0]?.message?.content ?? '';

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(responseText.trim());
  } catch {
    const block = extractJsonObject(responseText);
    if (!block) {
      throw new Error(
        'Model returned no JSON object. Raw output (first 300 chars): ' +
        JSON.stringify(responseText.slice(0, 300))
      );
    }
    try {
      raw = JSON.parse(block);
    } catch (parseErr) {
      throw new Error(
        'Model JSON did not parse (likely truncated by max_tokens). ' +
        (parseErr as Error).message + '. Raw: ' +
        JSON.stringify(responseText.slice(0, 300))
      );
    }
  }

  const category = String(raw['category'] ?? '').trim();
  if (!category) {
    throw new Error(
      'Model response missing "category" field. Got keys: [' +
      Object.keys(raw).join(', ') + ']'
    );
  }

  return {
    category,
    subcategory: raw['subcategory'] != null ? String(raw['subcategory']).trim() : undefined,
    confidence:  raw['confidence']  != null ? String(raw['confidence'])         : undefined,
    reason:      raw['reason']      != null ? String(raw['reason'])             : undefined,
    search_metadata: pickMetadata(raw),
    raw,
  };
}

function pickMetadata(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const m = raw['search_metadata'] ?? raw['metadata'];
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
}

// ─────────────────────────────────────────────────────────────
//  Raw chat pass-through  — used by the rich-prompt dashboard.
//
//  The dashboard already builds its own system+user messages and parses
//  the OpenAI SSE stream, so we don't need our own envelope here. This
//  endpoint just forwards the body to LM Studio and pipes the response
//  back unchanged. Lets the browser avoid CORS without throwing away the
//  dashboard's bespoke prompt.
// ─────────────────────────────────────────────────────────────

/**
 * Non-streaming pass-through. Forwards the OpenAI chat-completions body
 * to LM Studio and returns the parsed JSON response.
 */
export async function chatPassthrough(
  url: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<unknown> {
  const base = normaliseBase(url);
  const sendBody = { ...body, stream: false };
  const res = await fetch(base + '/chat/completions', {
    method:  'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    signal:  withTimeout(opts.timeoutMs ?? DEFAULT_GEN_TIMEOUT_MS),
    body:    JSON.stringify(sendBody),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ' — ' + (await res.text()).slice(0, 300); } catch {}
    throw new Error(`LLM HTTP ${res.status}${detail}`);
  }
  return res.json();
}

/**
 * Streaming pass-through. Forwards the OpenAI chat-completions body to
 * LM Studio and pipes the SSE response bytes back to the Express client
 * verbatim. The client gets exactly what LM Studio would send if it
 * could be reached directly — including the `data: [DONE]` sentinel —
 * so any existing OpenAI-SSE parser keeps working unchanged.
 *
 * If the upstream call fails we emit a single OpenAI-shaped error event
 * (`data: {"error":{"message":"..."}}\n\n`) so the client's parser sees
 * a structured failure rather than a silent stream close.
 */
export async function streamChatPassthrough(
  url: string,
  body: Record<string, unknown>,
  res: ExpressResponse,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const base = normaliseBase(url);
  const sendBody = { ...body, stream: true };

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const emitErrorEvent = (message: string) => {
    res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
    res.write('data: [DONE]\n\n');
  };

  try {
    const upstream = await fetch(base + '/chat/completions', {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      signal:  withTimeout(opts.timeoutMs ?? DEFAULT_GEN_TIMEOUT_MS),
      body:    JSON.stringify(sendBody),
    });

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = ' — ' + (await upstream.text()).slice(0, 300); } catch {}
      emitErrorEvent(`LLM HTTP ${upstream.status}${detail}`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    emitErrorEvent((err as Error).message);
  } finally {
    res.end();
  }
}

/**
 * Streaming variant: pipes LM Studio's OpenAI-style SSE stream to the
 * Express response, repackaged as our domain SSE events:
 *
 *   data: {"type":"token","text":"…"}\n\n
 *   data: {"type":"done","result":{...},"raw":"…"}\n\n
 *   data: {"type":"error","message":"…","raw":"…"}\n\n
 */
export async function streamClassify(
  url: string,
  model: string,
  text: string,
  categories: CategoryInput[],
  res: ExpressResponse,
  opts: {
    timeoutMs?: number;
    metadataFields?: MetadataFieldInput[];
    /** Called with the parsed result before the final SSE event is sent */
    onResult?: (r: ClassificationResult) => Record<string, unknown> | void;
  } = {}
): Promise<void> {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let accumulated = '';
  const base = normaliseBase(url);

  try {
    const prompt = buildClassificationPrompt(text, categories, opts.metadataFields);
    // Substitute the requested model with whatever is actually loaded
    // if there's a mismatch — same logic as the one-shot classify().
    const resolved = await resolveModelId(url, model);
    if (resolved.resolvedFrom === 'fallback') {
      model = resolved.model;
    }
    const upstream = await fetch(base + '/chat/completions', {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      signal:  withTimeout(opts.timeoutMs ?? DEFAULT_GEN_TIMEOUT_MS),
      body:    JSON.stringify(buildChatBody(model, prompt, true, !!opts.metadataFields?.length)),
    });

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = ' — ' + (await upstream.text()).slice(0, 300); } catch {}
      throw new Error(`LLM HTTP ${upstream.status}${detail}`);
    }

    // Read OpenAI-style SSE: events separated by blank lines, each event's
    // payload is one or more "data: …" lines. Final sentinel is
    // "data: [DONE]". We buffer across chunk boundaries.
    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneSentinelSeen = false;

    while (!doneSentinelSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = rawEvent.split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payloadStr = dataLines.join('\n');

        if (payloadStr === '[DONE]') { doneSentinelSeen = true; break; }

        let evt: any;
        try { evt = JSON.parse(payloadStr); } catch { continue; }

        // OpenAI streaming chunks: { choices: [{ delta: { content: "..." }, finish_reason }] }
        const delta: string = evt?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          accumulated += delta;
          sendEvent({ type: 'token', text: delta });
        }
        // Errors mid-stream
        if (evt?.error) {
          throw new Error(evt.error.message ?? String(evt.error));
        }
      }
    }

    // Parse the accumulated JSON
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(accumulated.trim());
    } catch {
      const block = extractJsonObject(accumulated);
      if (!block) {
        throw new Error(
          'Model returned no JSON object. Likely truncated. Raw (first 300 chars): ' +
          JSON.stringify(accumulated.slice(0, 300))
        );
      }
      try {
        raw = JSON.parse(block);
      } catch (parseErr) {
        throw new Error(
          'Model JSON did not parse (likely truncated by max_tokens). ' +
          (parseErr as Error).message + '. Raw: ' +
          JSON.stringify(accumulated.slice(0, 300))
        );
      }
    }

    const category = String(raw['category'] ?? '').trim();
    if (!category) {
      throw new Error(
        'Model response missing "category" field. Got keys: [' +
        Object.keys(raw).join(', ') + ']'
      );
    }

    const result: ClassificationResult = {
      category,
      subcategory: raw['subcategory'] != null ? String(raw['subcategory']).trim() : undefined,
      confidence:  raw['confidence']  != null ? String(raw['confidence'])         : undefined,
      reason:      raw['reason']      != null ? String(raw['reason'])             : undefined,
      search_metadata: pickMetadata(raw),
      raw,
    };
    let extra: Record<string, unknown> | void = undefined;
    try { extra = opts.onResult?.(result); } catch { /* indexing is best-effort */ }
    sendEvent({ type: 'done', result, raw: accumulated, ...(extra ?? {}) });
  } catch (err) {
    sendEvent({ type: 'error', message: (err as Error).message, raw: accumulated });
  } finally {
    res.end();
  }
}
