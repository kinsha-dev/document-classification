# Document search — approved metadata + iterative pivot search

Search runs on top of the extracted text and the classifier output. Every
document is indexed with **approved search metadata** (CIF, account number,
IBAN, Emirates ID, passport, mobile, email, invoice/PO/TRN…). A search
starts from whatever identifiers are in the query, finds the documents that
carry them, then uses the *other* approved identifiers on those documents
to find more, hop by hop.

```
"CIF 1234567"
 hop 0  cif=1234567              → account_opening_form.pdf
                                   (also has account 1012345678901, EID 784-1985-…)
 hop 1  account_number=10123…    → statement_march.pdf      ← has the account number only
        account_number=10123…    → closure_form.png         ← linked via the classifier's metadata
        emirates_id=784-1985-…   → eid_front.jpg            (also has passport N1234567)
 hop 2  passport_number=N1234567 → passport_scan.png
```

## The approved set: `metadata-schema.json`

One file at the repo root (next to `skill.md`) decides what is searchable.

| Section | What it controls |
|---|---|
| `fields` | Every approved key: label, kind, `strength` (how much a match means "same entity"), `pivot` (may it expand a search), normaliser, validation regex, LLM aliases, text regexes, derivations |
| `categoryFields` | Which approved keys the classifier is asked to pull for each category (`*` = fallback) |
| `searchPatterns` | Named searches and the **correlated fields** each may match and pivot on, with trigger words and a hop limit |
| `settings` | Hop decay, default max hops, fan-out cap, fuzzy-name threshold, semantic weight |

Built-in patterns:

- **customer** — CIF ↔ account ↔ IBAN ↔ Emirates ID ↔ passport ↔ trade licence ↔ mobile ↔ email (names match but never pivot). Up to 3 hops.
- **account** — account ↔ IBAN ↔ CIF. Up to 2 hops.
- **vendor** — invoice ↔ PO ↔ TRN ↔ vendor ↔ IBAN. Up to 2 hops.

Edit the file, then `POST /metadata/schema/reload` and `POST /index/rebuild`.

Guard rails:

- Only keys in the schema are indexed as searchable. Anything else the model returns is parked as a *candidate* — `GET /metadata/candidates` lists recurring ones to review and approve.
- Values are normalised before matching (`1012 3456 7890 1` = `0001012345678901`, `+971 50…` = `050…`), and derivations link formats: a UAE IBAN yields its account number, an account number yields its last 4.
- A value shared by more than `maxFanoutPerValue` documents (a branch phone number, say) still matches but is never expanded, so one noisy value can't pull in the corpus.
- Names (`kind: name`) match fuzzily and only as seeds or evidence; they never drive expansion.

## How documents get their metadata

1. **On extraction** (`/extract`, `/extract/screenshot`, `/extract/batch`) the service runs the schema's regexes over the full text and indexes the result straight away.
2. **On classification** the classifier is asked for `search_metadata` using the approved keys for each category:
   - `skill.md` (server-side `/llm/classify`) renders the list into `{{metadata_fields}}`. Pass `jobId` and the result is indexed; pass `"includeMetadata": false` for the old category-only behaviour.
   - The dashboard's AI prompt includes the same list per category and pushes the result to `POST /index/documents/:jobId/classification`.
3. **On "Apply Label"** the confirmed category is stored too.

Regex and LLM values are merged; when both find the same value its confidence goes up. Re-classifying replaces only the LLM part.

## Ranking

`score = (1 − w) · metadata + w · semantic`

- **metadata**: noisy-OR over every match, each weighted by field strength × extraction confidence × `hopDecay^hop`.
- **semantic**: BM25 over a per-document summary (category, subcategory, approved metadata) plus the start of the text, using whatever words are left in the query after identifiers are removed (e.g. `"Ahmed Al Mansoori" statement` ranks statements first). If `EMBEDDING_MODEL` is set and LM Studio has that embedding model loaded, cosine similarity is blended in.
- With no identifiers in the query, search is semantic only.

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/search` | `{ query?, seeds?: [{key?, value}], seedJobId?, pattern?, maxHops?, limit?, category? }` |
| `GET` | `/search?q=…&pattern=…&maxHops=…` | Same, as a query string |
| `GET` | `/metadata/schema` | Approved fields, category map, patterns |
| `GET` | `/metadata/fields?category=Financial` | Keys the classifier should pull for a category |
| `POST` | `/metadata/schema/reload` | Re-read `metadata-schema.json` |
| `GET` | `/metadata/candidates` | Unapproved keys the model keeps returning |
| `GET` | `/index/stats` | Counts per key |
| `GET` | `/index/documents/:jobId` | One indexed document |
| `POST` | `/index/documents/:jobId/classification` | `{ category?, subcategory?, confidence?, labeledCategory?, search_metadata?, key_fields?, manual_metadata? }` |
| `DELETE` | `/index/documents/:jobId` | Remove from the index |
| `POST` | `/index/rebuild` | Re-index every saved extraction in `OUTPUT_DIR` |

Query syntax: identifiers in prose (`CIF 1234567`, `IBAN AE07…`), bare values
(`1012345678901` — resolved to whichever approved key holds it),
`key:value` (`account_number:1012345678901`, aliases work), and quoted names
(`"Ahmed Al Mansoori"`).

Each response includes the seeds it recognised, every hit's hop and the
evidence chain (`account_number = … via account_opening_form.pdf`), an
**entity profile** of every correlated value found, and a hop-by-hop trace.

## Dashboard

The **Search** tab in `extractor-dashboard.html` has a pattern picker, hop
limit, results with their evidence chain, the entity profile (click a value
to search from it), the search trail, and index stats with a rebuild button.
**Pivot ↪** on a result searches again from everything that document knows.
After an AI classification, the profile card shows what was indexed; click
any value to search for it.

## Storage and config

The index is one JSON file at `<OUTPUT_DIR>/_index/metadata-index.json`,
loaded into memory at startup and written shortly after each change (and on
shutdown). That suits a local service with thousands of documents; past
that, swap `IndexStore` for SQLite or a search engine — the indexer and
search code only use its lookup methods.

```
METADATA_SCHEMA_FILE=../metadata-schema.json   # optional, auto-discovered
EMBEDDING_MODEL=                               # optional LM Studio embedding model id
```

Tests: `cd extractor-service && npm test`.
