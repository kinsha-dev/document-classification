---
name: document-classification
description: Classify a single document into exactly one user-supplied category, propose a free-form subcategory, and rate confidence. Targets Google Gemma 3 (4B / 12B) served via LM Studio's OpenAI-compatible API, but works with any instruction-tuned model that LM Studio supports `response_format: { type: "json_object" }` for.
backend: lm-studio          # was "ollama" — switched to LM Studio's OpenAI-compatible API
api_base_default: http://127.0.0.1:1234/v1
note_on_model_ids: |
  LM Studio assigns each loaded model an "API Model Identifier" shown in
  the right-hand panel of the Local Server tab. That id (e.g.
  "gemma-4-e2b-it:2") is what you put in the `model` field on the wire.
  The trailing ":<n>" is the instance slot, NOT a quantization tag, and
  it can change between sessions. The extractor service auto-falls-back
  to the first loaded model if the configured id is stale.
recommended_models:
  - gemma-4-e2b-it:2         # Unsloth's Gemma 4 E2B build (vision + tool-use, ~4 GB at Q3_K_S)
  - google/gemma-3-4b-it     # solid Gemma 3 4B (the "Gemma 4" rough equivalent on Hugging Face)
  - google/gemma-3-12b-it    # higher quality, ~8 GB VRAM
  - google/gemma-2-9b-it     # solid fallback if Gemma 3/4 isn't downloaded
  - lmstudio-community/gemma-3-4b-it-GGUF   # community GGUF build of Gemma 3 4B
inference_options:
  temperature: 0.1
  max_tokens:  512        # OpenAI-style; LM Studio honours it
  top_p:       0.9
response_format: { type: "json_object" }   # OpenAI/LM Studio constraint that forces valid JSON
output_schema:
  category:    "string — verbatim from the supplied categories list"
  subcategory: "string — 1–4 word free-form label for the specific document type; \"\" if unclear"
  confidence:  "string — one of: high, medium, low"
  reason:      "string — one short sentence (≤15 words) justifying the choice"
  search_metadata: "object — approved metadata keys (from metadata-schema.json) found verbatim in the text; omit keys that are absent"
placeholders:
  categories: "newline-separated list of allowed category names, each prefixed with '- '"
  metadata_fields: "newline-separated '- key: label' list of approved search metadata keys, rendered from metadata-schema.json"
  text:       "the document text to classify (server truncates to ~2000 chars before substitution)"
---

# Document Classification — Gemma-friendly prompt

This file is the source of truth for the classification prompt used by
`extractor-service` when calling Ollama. The service reads everything below
the `---PROMPT---` fence at startup and substitutes `{{categories}}` and
`{{text}}` per request. Edit the prompt, restart the service (or hit
`POST /ollama/reload-prompt` if you've added that route), and you're done —
no recompile required.

## Why a separate prompt for Gemma

Gemma models (especially the 4B variant that's practical to run on a laptop)
behave differently from larger Qwen / Llama instruct models, so the prompt
is written defensively:

- **No system role.** Gemma's chat template ignores anything in `system`;
  LM Studio merges it into the user turn anyway. The prompt is written as
  one self-contained user message and the service sends it that way.
- **Echo-prone.** Small Gemmas like to repeat their instructions or wrap
  output in markdown fences. The prompt below is short, has zero markdown
  inside the instructions block, and ends with the literal string the model
  is expected to start its reply with (`{`).
- **Looser JSON discipline.** Even with `response_format:{type:"json_object"}`
  Gemma sometimes emits trailing prose. The server's parser already
  tolerates that (balanced-brace extraction + markdown-fence stripping in
  `lmstudio.ts`), but the prompt also instructs the model explicitly:
  *no explanation, no markdown*.
- **Sensitive to delimiters.** Triple-quotes (`"""`) confuse Gemma when the
  document itself contains quotes. We use a custom `<<<DOC … DOC>>>` fence
  instead so the model can't get fooled by quoted content inside the doc.
- **Short context preferred.** Gemma 4B handles ~8K tokens but quality
  degrades fast past 2–3K. The server already truncates `{{text}}` to 2000
  chars, which keeps us comfortably inside the safe zone.

## Recommended LM Studio settings

Set in `extractor-service/.env`:

    LMSTUDIO_URL=http://localhost:1234/v1
    LMSTUDIO_MODEL=google/gemma-3-4b-it
    CLASSIFY_PROMPT_FILE=../skill.md

Then in LM Studio: **Discover** → search `gemma-3-4b-it` → Download.
**Local Server** → load Gemma 3 4B → **Start Server**.

The service always sends `response_format: { type: "json_object" }`,
`temperature: 0.1`, and `max_tokens: 512` for Gemma. Override per request
via the `model` field in the POST body or the `x-llm-model` /
`x-lmstudio-model` header.

## Output schema (what the model must return)

A single JSON object, one line, no extra text around it:

    {"category":    "<one of the listed category names, verbatim>",
     "subcategory": "<1–4 word specific document type within that category, e.g. 'Bank Statement', 'Tax Invoice'; '' if unclear>",
     "confidence":  "<high | medium | low>",
     "reason":      "<one short sentence>"}

The server validates that `category` is non-empty before responding to the
browser. It does NOT enforce that `category` matches the supplied list — the
front-end does fuzzy matching (case-insensitive, substring) so the model has
some slack on punctuation/whitespace. `subcategory`, `confidence`, and
`reason` are passed through verbatim and surfaced in the UI.

## Search metadata

The classifier also pulls **approved search metadata** — the identifiers
listed in `metadata-schema.json` (CIF, account number, IBAN, Emirates ID,
passport, mobile, email, invoice/PO/TRN…). The server renders that list
into `{{metadata_fields}}` and indexes whatever comes back under
`search_metadata`, alongside regex matches over the full text. Only
approved keys are searchable; anything else the model returns is parked
as a candidate (`GET /metadata/candidates`) until someone approves it in
the schema. Send `"includeMetadata": false` to `/llm/classify` to get the
old category-only prompt behaviour.

## Tweaks restored from the original prompt

The first iteration of this prompt dropped a few cues that were doing
quiet work in the original front-end version. Restored here:

1. **Persona framing.** Small instruct models (Gemma especially) follow
   instructions noticeably more reliably when the role is stated up front.
2. **Concrete JSON example.** Describing the schema in prose is fine for
   GPT-4-tier models; Gemma 1B–4B is far more reliable when it can pattern-
   match against a literal example object. We include one — clearly marked
   *shape only*.
3. **Evidence guidance.** The original implicitly told the model to look for
   substantive matches (entities, key phrases, structure). Without it, small
   models latch onto isolated keywords and overconfidently classify based on
   one stopword-adjacent hit. Calling this out explicitly buys real quality.
4. **Calibrated confidence.** "high" is reserved for clear matches; short,
   garbled, or genuinely ambiguous text gets "low". Without this, Gemma
   reports "high" on almost everything.
5. **Anchor characters.** Restating "begin with `{` and end with `}`"
   bookends the response and makes the parser's life easier when `format:
   "json"` is honoured imperfectly.

---PROMPT---
You are a document classification assistant.

Task: read the document below, assign it to exactly ONE category from the list, and propose a more specific subcategory.

Categories (pick exactly one — copy the name verbatim, including spaces and punctuation):
{{categories}}

Document:
<<<DOC
{{text}}
DOC>>>

Output schema (single JSON object, one line, nothing else):
- "category"    : one of the categories above, verbatim
- "subcategory" : a 1–4 word free-form label for the specific document type within that category (e.g. "Tax Invoice", "Bank Statement", "Lease Agreement", "Discharge Summary"). Use "" if unclear.
- "confidence"  : "high" | "medium" | "low" — only "high" if the text clearly matches the chosen category
- "reason"      : one short sentence explaining the choice
- "search_metadata" : an object with any of the approved keys below whose value appears in the document, copied exactly as printed

Approved search metadata keys (use these key names only):
{{metadata_fields}}

JSON shape (these are placeholders — fill them in based on this document, do not copy the placeholder text):
{"category": "<one of the categories above>", "subcategory": "<1–4 word specific document type>", "confidence": "<high|medium|low>", "reason": "<one short sentence, max 15 words>", "search_metadata": {"<approved key>": "<value as printed>"}}

Rules:
- "category" MUST match one of the listed categories exactly.
- Base the decision on substantive evidence (named entities, key phrases, document structure) — not on isolated stopword-adjacent keywords.
- Keep "reason" to one sentence, 15 words or fewer. Do not pad it.
- In "search_metadata", include only keys from the approved list and only values that are actually printed in the document. Never guess or invent a number. Use {} if none are present.
- If the text is too short, garbled, or genuinely ambiguous, use "low" confidence and pick the closest fit.
- No preamble, no commentary, no markdown, no code fences.
- Begin your reply with the character { and end it with the character }.
