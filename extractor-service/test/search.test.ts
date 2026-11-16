import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadSchema, applyNormalizer, deriveValue } from '../src/search/schema';
import { extractFromText, mapLlmFields } from '../src/search/extract';
import { IndexStore } from '../src/search/store';
import { Indexer } from '../src/search/indexer';
import { iterativeSearch } from '../src/search/iterative';
import type { ExtractionResult } from '../src/types';

const SCHEMA = path.resolve(__dirname, '../../metadata-schema.json');
const schema = () => loadSchema(SCHEMA);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
  const store = new IndexStore(path.join(dir, '_index'));
  const indexer = new Indexer(store, schema, dir, { url: 'http://127.0.0.1:1' });
  const add = (jobId: string, filename: string, fullText: string) =>
    indexer.indexExtraction({ jobId, filename, fullText } as ExtractionResult);
  return { dir, store, indexer, add };
}

// 13-digit account → 16-digit zero-padded inside a UAE IBAN with bank code 026
const ACCOUNT = '1012345678901';
const IBAN = 'AE07 0260 0010 1234 5678 901';

function corpus() {
  const c = fresh();
  c.add('A', 'account_opening_form.pdf',
    `ACCOUNT OPENING FORM\nCIF No: 1234567\nAccount Number: ${ACCOUNT}\nEmirates ID 784-1985-1234567-1\nName: Ahmed Ali Al Mansoori`);
  c.add('B', 'statement_march.pdf',
    `MONTHLY STATEMENT\nAccount No. 1012 3456 7890 1\nOpening balance 10,000.00 Closing balance 12,000.00`);
  c.add('C', 'salary_certificate.pdf', `Salary transfer to IBAN ${IBAN}`);
  c.add('D', 'eid_front.jpg', `UNITED ARAB EMIRATES IDENTITY CARD 784-1985-1234567-1 Passport No: N1234567`);
  c.add('E', 'passport_scan.png', `PASSPORT Passport No N1234567 Nationality ARE`);
  c.add('F', 'other_customer.pdf', `CIF: 7654321 Account Number: 2099988877766`);
  return c;
}

test('normalisers and derivations', () => {
  assert.equal(applyNormalizer('phone_uae', '+971 50 123 4567'), '971501234567');
  assert.equal(applyNormalizer('phone_uae', '050-123-4567'), '971501234567');
  assert.equal(applyNormalizer('account', '0001012345678901'), ACCOUNT);
  assert.equal(deriveValue('uae_iban_account', applyNormalizer('alnum_upper', IBAN)), ACCOUNT);
  assert.equal(applyNormalizer('name', 'Mr. Ahmed  Ali al-Mansoori'), 'ahmed al ali mansoori');
});

test('regex extraction pulls approved identifiers and ignores noise', () => {
  const m = extractFromText(schema(), 'CIF No: 1234567 Passport copy attached. Email: A.B@Example.com');
  const keys = Object.fromEntries(m.map((x) => [x.key, x.norm]));
  assert.equal(keys.cif, '1234567');
  assert.equal(keys.email, 'a.b@example.com');
  assert.equal(keys.passport_number, undefined, '"copy" / "attached" must not become a passport number');
});

test('LLM fields map through aliases; unknown keys become candidates', () => {
  const { approved, candidates } = mapLlmFields(schema(),
    { cif_number: '1234567', branch: 'Deira' },
    { applicant_name: 'Ahmed Ali', account_number_last4: '8901', account_no: null });
  assert.deepEqual(approved.map((a) => a.key).sort(), ['account_last4', 'cif', 'customer_name']);
  assert.deepEqual(candidates, [{ key: 'branch', value: 'Deira' }]);
});

test('CIF search walks account → statement, IBAN, Emirates ID → passport', async () => {
  const { store } = corpus();
  const r = await iterativeSearch(schema(), store, { query: 'CIF documents for CIF 1234567' });
  assert.equal(r.pattern.name, 'customer');
  assert.equal(r.mode, 'metadata');
  const hop = Object.fromEntries(r.hits.map((h) => [h.jobId, h.hop]));
  assert.deepEqual(hop, { A: 0, B: 1, C: 1, D: 1, E: 2 });
  assert.ok(!('F' in hop), 'other customer must not leak in');

  const b = r.hits.find((h) => h.jobId === 'B')!;
  assert.equal(b.matchedOn[0].key, 'account_number');
  assert.equal(b.matchedOn[0].via?.jobId, 'A');
  const e = r.hits.find((h) => h.jobId === 'E')!;
  assert.equal(e.matchedOn[0].via?.filename, 'eid_front.jpg');
  assert.ok(r.entity.account_number.some((v) => v.value.replace(/\D/g, '') === ACCOUNT));
  assert.ok(r.hits[0].jobId === 'A', 'direct hit ranks first');
});

test('maxHops bounds the walk', async () => {
  const { store } = corpus();
  const r = await iterativeSearch(schema(), store, { seeds: [{ key: 'cif', value: '1234567' }], maxHops: 1 });
  assert.deepEqual(r.hits.map((h) => h.jobId).sort(), ['A', 'B', 'C', 'D']);
});

test('a bare number is resolved to whichever approved key holds it', async () => {
  const { store } = corpus();
  const r = await iterativeSearch(schema(), store, { query: ACCOUNT, pattern: 'account' });
  assert.equal(r.seeds[0].key, 'account_number');
  assert.ok(r.hits.some((h) => h.jobId === 'A') && r.hits.some((h) => h.jobId === 'C'));
  // account pattern does not follow emirates_id/passport
  assert.ok(!r.hits.some((h) => h.jobId === 'E'));
});

test('IBAN in the query also searches the derived account number', async () => {
  const { store } = corpus();
  const r = await iterativeSearch(schema(), store, { query: `IBAN ${IBAN}`, maxHops: 0 });
  assert.deepEqual(r.hits.map((h) => h.jobId).sort(), ['A', 'B', 'C']);
});

test('classification metadata links a doc regex alone could not', async () => {
  const c = corpus();
  c.add('G', 'closure_form.png', 'COMBINED ACCOUNT CLOSURE FORM garbled ocr text');
  let r = await iterativeSearch(schema(), c.store, { query: 'CIF 1234567' });
  assert.ok(!r.hits.some((h) => h.jobId === 'G'));
  c.indexer.applyClassification('G', {
    category: 'Financial', subcategory: 'Account Closure Form',
    search_metadata: { account_number: ACCOUNT },
  });
  r = await iterativeSearch(schema(), c.store, { query: 'CIF 1234567' });
  const g = r.hits.find((h) => h.jobId === 'G')!;
  assert.equal(g.hop, 1);
  assert.equal(g.subcategory, 'Account Closure Form');
});

test('hub values match but are not expanded', async () => {
  const c = fresh();
  c.add('seed', 'seed.pdf', 'CIF 1111111 Mobile 050 999 0000');
  for (let i = 0; i < 30; i++) c.add('n' + i, `n${i}.pdf`, `Branch contact 050 999 0000 CIF ${2000000 + i}`);
  c.add('far', 'far.pdf', 'CIF 2000005 Account Number 5555555555');
  const r = await iterativeSearch(schema(), c.store, { query: 'CIF 1111111' });
  assert.ok(!r.hits.some((h) => h.jobId === 'far'));
  const probe = r.trace[1].probes.find((p) => p.key === 'mobile')!;
  assert.match(probe.note ?? '', /shared value/);
});

test('fuzzy name seed + semantic re-rank', async () => {
  const c = corpus();
  c.indexer.applyClassification('A', { category: 'Financial', search_metadata: { customer_name: 'Ahmed Ali Al Mansoori' } });
  const r = await iterativeSearch(schema(), c.store, { query: 'customer "Ahmed Al Mansoori" statement' });
  assert.equal(r.seeds[0].key, 'customer_name');
  assert.equal(r.residualQuery, 'statement');
  assert.equal(r.hits[0].jobId, 'B', 'semantic term "statement" lifts the statement to the top');
});

test('pure semantic search when no identifier is present', async () => {
  const { store } = corpus();
  const r = await iterativeSearch(schema(), store, { query: 'monthly statement closing balance' });
  assert.equal(r.mode, 'semantic');
  assert.equal(r.hits[0].jobId, 'B');
});

test('index persists and reloads', () => {
  const c = corpus();
  c.store.saveNow();
  const again = new IndexStore(path.dirname(c.store.file));
  assert.equal(again.size(), 6);
  assert.deepEqual(again.lookup('account_number', ACCOUNT).sort(), ['A', 'B', 'C']);
});
