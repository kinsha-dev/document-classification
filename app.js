// ──────────────────────────────────────────
//  PDF.js worker
// ──────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ──────────────────────────────────────────
//  Default state
// ──────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { id:'cat_invoice',   name:'Invoice',     emoji:'🧾', isCustom:false },
  { id:'cat_contract',  name:'Contract',    emoji:'📋', isCustom:false },
  { id:'cat_report',    name:'Report',      emoji:'📊', isCustom:false },
  { id:'cat_receipt',   name:'Receipt',     emoji:'🧾', isCustom:false },
  { id:'cat_resume',    name:'Resume / CV', emoji:'👤', isCustom:false },
  { id:'cat_id',        name:'ID Document', emoji:'🪪', isCustom:false },
  { id:'cat_medical',   name:'Medical',     emoji:'🏥', isCustom:false },
  { id:'cat_legal',     name:'Legal',       emoji:'⚖', isCustom:false },
  { id:'cat_financial', name:'Financial',   emoji:'💰', isCustom:false },
  { id:'cat_technical', name:'Technical',   emoji:'⚙', isCustom:false },
  { id:'cat_other',     name:'Other',       emoji:'📁', isCustom:false },
];

const DEFAULT_RULES = [
  // Invoice
  {id:'r1',  categoryId:'cat_invoice',   keyword:'invoice',     weight:3},
  {id:'r2',  categoryId:'cat_invoice',   keyword:'bill',        weight:2},
  {id:'r3',  categoryId:'cat_invoice',   keyword:'payment due', weight:3},
  {id:'r4',  categoryId:'cat_invoice',   keyword:'total amount',weight:3},
  {id:'r5',  categoryId:'cat_invoice',   keyword:'subtotal',    weight:2},
  {id:'r6',  categoryId:'cat_invoice',   keyword:'vat',         weight:2},
  // Contract
  {id:'r7',  categoryId:'cat_contract',  keyword:'agreement',   weight:3},
  {id:'r8',  categoryId:'cat_contract',  keyword:'contract',    weight:3},
  {id:'r9',  categoryId:'cat_contract',  keyword:'parties',     weight:2},
  {id:'r10', categoryId:'cat_contract',  keyword:'terms and conditions', weight:3},
  {id:'r11', categoryId:'cat_contract',  keyword:'signature',   weight:2},
  {id:'r12', categoryId:'cat_contract',  keyword:'hereby agree',weight:3},
  // Report
  {id:'r13', categoryId:'cat_report',    keyword:'report',      weight:2},
  {id:'r14', categoryId:'cat_report',    keyword:'analysis',    weight:2},
  {id:'r15', categoryId:'cat_report',    keyword:'findings',    weight:3},
  {id:'r16', categoryId:'cat_report',    keyword:'conclusion',  weight:2},
  {id:'r17', categoryId:'cat_report',    keyword:'summary',     weight:2},
  // Receipt
  {id:'r18', categoryId:'cat_receipt',   keyword:'receipt',     weight:3},
  {id:'r19', categoryId:'cat_receipt',   keyword:'transaction',   weight:2},
  {id:'r20', categoryId:'cat_receipt',   keyword:'thank you for your purchase', weight:3},
  {id:'r21', categoryId:'cat_receipt',   keyword:'order number', weight:2},
  // Resume
  {id:'r22', categoryId:'cat_resume',    keyword:'resume',       weight:3},
  {id:'r23', categoryId:'cat_resume',    keyword:'curriculum vitae', weight:3},
  {id:'r24', categoryId:'cat_resume',    keyword:'work experience', weight:3},
  {id:'r25', categoryId:'cat_resume',    keyword:'education',   weight:2},
  {id:'r26', categoryId:'cat_resume',    keyword:'skills',      weight:1},
  {id:'r27', categoryId:'cat_resume',    keyword:'references',  weight:2},
  // ID
  {id:'r28', categoryId:'cat_id',        keyword:'passport',    weight:3},
  {id:'r29', categoryId:'cat_id',        keyword:'date of birth', weight:3},
  {id:'r30', categoryId:'cat_id',        keyword:'national id', weight:3},
  {id:'r31', categoryId:'cat_id',        keyword:'driver',      weight:2},
  {id:'r32', categoryId:'cat_id',        keyword:'expiry date', weight:2},
  // Medical
  {id:'r33', categoryId:'cat_medical',   keyword:'patient',     weight:3},
  {id:'r34', categoryId:'cat_medical',   keyword:'diagnosis',   weight:3},
  {id:'r35', categoryId:'cat_medical',   keyword:'prescription',weight:3},
  {id:'r36', categoryId:'cat_medical',   keyword:'doctor',      weight:2},
  {id:'r37', categoryId:'cat_medical',   keyword:'hospital',    weight:2},
  // Legal
  {id:'r38', categoryId:'cat_legal',     keyword:'court',       weight:3},
  {id:'r39', categoryId:'cat_legal',     keyword:'plaintiff',   weight:3},
  {id:'r40', categoryId:'cat_legal',     keyword:'defendant',   weight:3},
  {id:'r41', categoryId:'cat_legal',     keyword:'attorney',    weight:2},
  {id:'r42', categoryId:'cat_legal',     keyword:'judgment',    weight:3},
  // Financial
  {id:'r43', categoryId:'cat_financial', keyword:'balance',     weight:2},
  {id:'r44', categoryId:'cat_financial', keyword:'statement',   weight:2},
  {id:'r45', categoryId:'cat_financial', keyword:'debit',       weight:2},
  {id:'r46', categoryId:'cat_financial', keyword:'credit',      weight:2},
  {id:'r47', categoryId:'cat_financial', keyword:'account number', weight:3},
  // Technical
  {id:'r48', categoryId:'cat_technical', keyword:'specification',weight:3},
  {id:'r49', categoryId:'cat_technical', keyword:'requirements', weight:2},
  {id:'r50', categoryId:'cat_technical', keyword:'architecture', weight:3},
  {id:'r51', categoryId:'cat_technical', keyword:'system design',weight:3},
];

// ──────────────────────────────────────────
//  State
// ──────────────────────────────────────────
let state = { categories:[], rules:[], documents:[] };

function loadState() {
  const raw = localStorage.getItem('docclassifier_state');
  if (raw) {
    try { state = JSON.parse(raw); } catch(e) { resetDefaults(); }
  } else {
    resetDefaults();
  }
}

function resetDefaults() {
  state = {
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
    rules:      JSON.parse(JSON.stringify(DEFAULT_RULES)),
    documents:  []
  };
  saveState();
}

function saveState() {
  localStorage.setItem('docclassifier_state', JSON.stringify(state));
}

// ──────────────────────────────────────────
//  Unique ID helper
// ──────────────────────────────────────────
function uid(prefix='id') {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
}

// ──────────────────────────────────────────
//  Classifier engine
// ──────────────────────────────────────────
function classify(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const rule of state.rules) {
    if (lower.includes(rule.keyword.toLowerCase())) {
      scores[rule.categoryId] = (scores[rule.categoryId] || 0) + rule.weight;
    }
  }

  const entries = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  if (!entries.length) return { categoryId: null, confidence: 0, matchedKeywords: [] };

  const [topCatId, topScore] = entries[0];
  const maxPossible = state.rules
    .filter(r => r.categoryId === topCatId)
    .reduce((s,r) => s + r.weight, 0);

  const confidence = maxPossible > 0 ? Math.min(topScore / maxPossible, 1) : 0;

  const matchedKeywords = state.rules
    .filter(r => r.categoryId === topCatId && lower.includes(r.keyword.toLowerCase()))
    .map(r => r.keyword);

  return { categoryId: topCatId, confidence, matchedKeywords };
}

// ──────────────────────────────────────────
//  Learn from labeled document
// ──────────────────────────────────────────
const STOPWORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for','of',
  'with','by','is','was','are','were','be','been','have','has','had','do','does','did',
  'will','would','can','could','should','may','might','this','that','these','those',
  'i','you','he','she','it','we','they','me','him','her','us','them','my','your',
  'his','its','our','their','from','as','not','so','if','then','than','more','also']);

function learnFromDocument(text, categoryId) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w));

  // Frequency count
  const freq = {};
  for (const w of words) freq[w] = (freq[w]||0)+1;

  // Get existing keywords for this category
  const existingKws = new Set(
    state.rules.filter(r=>r.categoryId===categoryId).map(r=>r.keyword.toLowerCase())
  );

  // Pick top new words (freq >= 2, not already a rule)
  const newKws = Object.entries(freq)
    .filter(([w,c]) => c >= 2 && !existingKws.has(w))
    .sort((a,b) => b[1]-a[1])
    .slice(0,5)
    .map(([w]) => w);

  for (const kw of newKws) {
    state.rules.push({ id: uid('rule'), categoryId, keyword: kw, weight: 1 });
  }

  return newKws;
}

// ──────────────────────────────────────────
//  File processors
// ──────────────────────────────────────────
let currentDoc = null; // holds extracted doc data before labeling

async function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const type = file.type;

  showToast('Processing…', 'info');

  if (type === 'application/pdf' || ext === 'pdf') {
    return await processPDF(file);
  } else if (type.startsWith('image/') || ['png','jpg','jpeg','webp'].includes(ext)) {
    return await processImage(file);
  } else if (['xls','xlsx','csv'].includes(ext) || type.includes('spreadsheet') || type.includes('excel')) {
    return await processSpreadsheet(file);
  } else {
    throw new Error('Unsupported file type: ' + (type || ext));
  }
}

async function processPDF(file) {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const totalPages = pdf.numPages;

  // Extract text from first page
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  const firstPageText = tc.items.map(i => i.str).join(' ');

  // Extract text from all pages (for learning)
  let fullText = firstPageText;
  for (let p = 2; p <= Math.min(totalPages, 5); p++) {
    const pg = await pdf.getPage(p);
    const t = await pg.getTextContent();
    fullText += ' ' + t.items.map(i=>i.str).join(' ');
  }

  return {
    filename: file.name,
    fileType: 'PDF',
    mimeType: file.type,
    sizeBytes: file.size,
    pageCount: totalPages,
    firstPageText: firstPageText.slice(0, 1500),
    fullText,
    thumbnail: null
  };
}

async function processImage(file) {
  const dataUrl = await new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.readAsDataURL(file);
  });

  return {
    filename: file.name,
    fileType: 'Image',
    mimeType: file.type,
    sizeBytes: file.size,
    pageCount: 1,
    firstPageText: '[Image file — no text extracted. Please assign a label manually.]',
    fullText: '',
    thumbnail: dataUrl
  };
}

async function processSpreadsheet(file) {
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];

  // Get data as array of rows
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const previewRows = rows.slice(0, 20);

  // Flatten to text for classification
  const flatText = previewRows.flat().filter(v => v !== '').join(' ');

  return {
    filename: file.name,
    fileType: 'Spreadsheet',
    mimeType: file.type,
    sizeBytes: file.size,
    sheetCount: wb.SheetNames.length,
    sheetNames: wb.SheetNames,
    firstSheetName: sheetName,
    rowCount: rows.length,
    firstPageText: flatText.slice(0, 1500),
    fullText: flatText,
    previewData: previewRows,
    thumbnail: null
  };
}

// ──────────────────────────────────────────
//  UI helpers
// ──────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function fileIcon(type) {
  if (type === 'PDF') return '📕';
  if (type === 'Image') return '🖼';
  if (type === 'Spreadsheet') return '📗';
  return '📄';
}

function categoryById(id) {
  return state.categories.find(c => c.id === id);
}

let selectedCategoryId = null;

function renderCatGrid() {
  const grid = document.getElementById('cat-grid');
  grid.innerHTML = '';
  for (const cat of state.categories) {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (selectedCategoryId === cat.id ? ' selected' : '');
    btn.innerHTML = `<span>${cat.emoji||'📁'}</span> ${cat.name}`;
    btn.onclick = () => selectCategory(cat.id);
    grid.appendChild(btn);
  }
}

function selectCategory(id) {
  selectedCategoryId = id;
  renderCatGrid();
  document.getElementById('label-btn').disabled = false;
}

function showPreview(doc) {
  document.getElementById('preview-panel').style.display = 'block';
  document.getElementById('no-doc-hint').style.display = 'none';
  document.getElementById('classify-panel').style.display = 'block';

  document.getElementById('file-icon').textContent = fileIcon(doc.fileType);
  document.getElementById('file-name').textContent = doc.filename;

  let metaStr = formatBytes(doc.sizeBytes) + ' · ' + doc.fileType;
  if (doc.pageCount) metaStr += ` · ${doc.pageCount} page${doc.pageCount>1?'s':''}`;
  if (doc.rowCount) metaStr += ` · ${doc.rowCount} rows`;
  document.getElementById('file-meta-info').textContent = metaStr;

  // Image preview
  const imgEl = document.getElementById('img-preview');
  if (doc.thumbnail) {
    imgEl.src = doc.thumbnail;
    imgEl.style.display = 'block';
  } else {
    imgEl.style.display = 'none';
  }

  // Build JSON for display
  const displayJson = {
    filename: doc.filename,
    fileType: doc.fileType,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: new Date().toISOString(),
    ...(doc.pageCount   ? { pageCount:  doc.pageCount }   : {}),
    ...(doc.sheetCount  ? { sheetCount: doc.sheetCount, sheetNames: doc.sheetNames } : {}),
    ...(doc.rowCount    ? { rowCount:   doc.rowCount }    : {}),
    firstPageText: doc.firstPageText.slice(0, 300) + (doc.firstPageText.length > 300 ? '…' : ''),
    classification: {
      suggestedCategory: null,
      confidence: null,
      matchedKeywords: []
    }
  };

  // Run classifier
  const result = classify(doc.fullText || doc.firstPageText);
  const suggestedCat = result.categoryId ? categoryById(result.categoryId) : null;

  displayJson.classification.suggestedCategory = suggestedCat ? suggestedCat.name : 'Unclassified';
  displayJson.classification.confidence = Math.round(result.confidence * 100) + '%';
  displayJson.classification.matchedKeywords = result.matchedKeywords;

  document.getElementById('json-output').textContent = JSON.stringify(displayJson, null, 2);

  // Suggestion bar
  if (suggestedCat) {
    document.getElementById('suggested-cat').innerHTML =
      `<strong style="color:var(--text)">${suggestedCat.emoji} ${suggestedCat.name}</strong>`;
    const confEl = document.getElementById('conf-badge');
    const pct = Math.round(result.confidence * 100);
    confEl.textContent = pct + '% confidence';
    confEl.className = 'conf-badge' + (pct >= 50 ? '' : ' conf-low');
    confEl.style.display = 'inline-block';

    const kwEl = document.getElementById('matched-kws');
    kwEl.innerHTML = result.matchedKeywords
      .slice(0,5)
      .map(k => `<span class="kw-chip">${k}</span>`)
      .join('');

    // Auto-select suggested
    selectedCategoryId = result.categoryId;
  } else {
    document.getElementById('suggested-cat').textContent = 'No match found';
    document.getElementById('conf-badge').style.display = 'none';
    document.getElementById('matched-kws').innerHTML = '';
    selectedCategoryId = null;
  }

  document.getElementById('learned-notice').style.display = 'none';
  document.getElementById('label-btn').disabled = (selectedCategoryId === null);
  document.getElementById('ai-response-box').style.display = 'none';
  document.getElementById('ai-result-bar').style.display = 'none';
  aiSuggestedCategoryId = null;
  // Stale AI result from the previous doc must NOT bleed onto the new one.
  lastAiResult = null;
  enableAiBtn(serviceCfg.connected);
  renderCatGrid();
}

function labelDocument() {
  if (!currentDoc || !selectedCategoryId) return;

  const cat = categoryById(selectedCategoryId);
  if (!cat) return;

  // Learn new keywords
  let learnedKws = [];
  if (currentDoc.fullText && currentDoc.fullText.length > 100) {
    learnedKws = learnFromDocument(currentDoc.fullText, selectedCategoryId);
  }

  // Pull AI annotations (subcategory / confidence / reason) onto the
  // record when the human accepted the AI's category. If the human
  // overrode the AI we still keep the AI metadata for audit, but we
  // don't claim the subcategory belongs to the chosen category.
  const aiMatchedHumanChoice =
    aiSuggestedCategoryId === selectedCategoryId && lastAiResult;
  const aiMeta = lastAiResult ? {
    aiCategory:    lastAiResult.category    || null,
    aiSubcategory: lastAiResult.subcategory || '',
    aiConfidence:  lastAiResult.confidence  || null,
    aiReason:      lastAiResult.reason      || null,
    aiModel:       serviceCfg.model,
  } : null;

  // Save document record
  const docRecord = {
    id: uid('doc'),
    filename: currentDoc.filename,
    fileType: currentDoc.fileType,
    sizeBytes: currentDoc.sizeBytes,
    labeledAt: new Date().toISOString(),
    categoryId: selectedCategoryId,
    categoryName: cat.name,
    categoryEmoji: cat.emoji || '📁',
    // Subcategory only counts when the AI's chosen category matches the
    // human's final pick — otherwise the subcategory belonged to a
    // different category and would be misleading on this record.
    subcategory: aiMatchedHumanChoice ? (lastAiResult.subcategory || '') : '',
    firstPageText: currentDoc.firstPageText.slice(0,500),
    learnedKeywords: learnedKws,
    ai: aiMeta,
  };

  state.documents.unshift(docRecord);
  saveState();

  // Update JSON display to show final label
  try {
    const current = JSON.parse(document.getElementById('json-output').textContent);
    current.classification.assignedCategory = cat.name;
    if (docRecord.subcategory) current.classification.subcategory = docRecord.subcategory;
    current.classification.labeledBy = aiMatchedHumanChoice ? 'ai+human' : 'human';
    current.classification.ollamaModel = serviceCfg.model;
    current.classification.learnedKeywords = learnedKws;
    if (aiMeta) current.classification.ai = aiMeta;
    document.getElementById('json-output').textContent = JSON.stringify(current, null, 2);
  } catch(e) {}

  // Show learned notice
  const notice = document.getElementById('learned-notice');
  if (learnedKws.length) {
    notice.textContent = `✨ Learned ${learnedKws.length} new keyword(s) for "${cat.name}": ${learnedKws.join(', ')}`;
    notice.style.display = 'block';
  } else {
    notice.style.display = 'none';
  }

  showToast(`✅ Labeled as "${cat.name}"`, 'success');
  renderCatGrid();

  // Refresh other tabs
  renderHistory();
  renderRulesSidebar();
  renderStats();
}

// ──────────────────────────────────────────
//  Add category
// ──────────────────────────────────────────
function addCategory() {
  const input = document.getElementById('new-cat-input');
  const name = input.value.trim();
  if (!name) return;
  if (state.categories.find(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast('Category already exists', 'error'); return;
  }
  const newCat = {
    id: uid('cat'),
    name,
    emoji: '📁',
    isCustom: true
  };
  state.categories.push(newCat);
  saveState();
  input.value = '';
  renderCatGrid();
  renderRulesSidebar();
  showToast(`Category "${name}" added`, 'success');
}

// ──────────────────────────────────────────
//  History tab
// ──────────────────────────────────────────
let historyFilter = 'all';

function renderHistory() {
  const docs = historyFilter === 'all'
    ? state.documents
    : state.documents.filter(d => d.categoryId === historyFilter);

  const count = state.documents.length;
  document.getElementById('history-count').textContent =
    count + ' document' + (count !== 1 ? 's' : '') + (historyFilter !== 'all' ? ` (filtered: ${docs.length})` : '');

  // Filters
  const filterRow = document.getElementById('history-filters');
  const used = [...new Set(state.documents.map(d => d.categoryId))];
  const cats = state.categories.filter(c => used.includes(c.id));

  filterRow.innerHTML = `<button class="filter-btn ${historyFilter==='all'?'active':''}" onclick="setHistFilter('all')">All</button>`;
  for (const c of cats) {
    filterRow.innerHTML += `<button class="filter-btn ${historyFilter===c.id?'active':''}" onclick="setHistFilter('${c.id}')">${c.emoji} ${c.name}</button>`;
  }

  const wrap = document.getElementById('history-table-wrap');

  if (!docs.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">🗂</div><p>${
      historyFilter !== 'all' ? 'No documents in this category.' : 'No labeled documents yet.'
    }</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Type</th>
          <th>Category</th>
          <th>Keywords Learned</th>
          <th>Labeled At</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${docs.map(doc => `
          <tr>
            <td>
              <span style="font-size:18px;margin-right:8px;">${fileIcon(doc.fileType)}</span>
              <span class="doc-name">${escHtml(doc.filename)}</span>
            </td>
            <td><span class="doc-type">${doc.fileType}</span></td>
            <td>
              <span class="badge" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);">
                ${doc.categoryEmoji||'📁'} ${escHtml(doc.categoryName)}
              </span>
              ${doc.subcategory ? `<div style="margin-top:4px;font-size:11px;color:var(--muted);">› ${escHtml(doc.subcategory)}</div>` : ''}
            </td>
            <td>
              ${(doc.learnedKeywords||[]).length
                ? (doc.learnedKeywords||[]).slice(0,3).map(k=>`<span class="kw-chip">${escHtml(k)}</span>`).join('')
                : '<span style="color:var(--muted);font-size:12px;">—</span>'}
            </td>
            <td style="color:var(--muted);font-size:12px;">${new Date(doc.labeledAt).toLocaleString()}</td>
            <td>
              <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" onclick="deleteDoc('${doc.id}')">✕</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function setHistFilter(id) {
  historyFilter = id;
  renderHistory();
}

function deleteDoc(id) {
  state.documents = state.documents.filter(d => d.id !== id);
  saveState();
  renderHistory();
  renderStats();
  showToast('Document removed', 'info');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ──────────────────────────────────────────
//  Rules tab
// ──────────────────────────────────────────
let selectedRulesCat = null;

function renderRulesSidebar() {
  const side = document.getElementById('cat-list-side');
  side.innerHTML = '';
  for (const cat of state.categories) {
    const ruleCount = state.rules.filter(r => r.categoryId === cat.id).length;
    const item = document.createElement('div');
    item.className = 'cat-list-item' + (selectedRulesCat === cat.id ? ' active' : '');
    item.innerHTML = `
      <span class="name">
        <span>${cat.emoji||'📁'}</span> ${escHtml(cat.name)}
      </span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="count">${ruleCount}</span>
        ${cat.isCustom ? `<button class="delete-cat-btn" onclick="event.stopPropagation();deleteCategory('${cat.id}')" title="Delete category">✕</button>` : ''}
      </div>`;
    item.onclick = () => { selectedRulesCat = cat.id; renderRulesSidebar(); renderRulesDetail(); };
    side.appendChild(item);
  }
  if (selectedRulesCat) renderRulesDetail();
}

function renderRulesDetail() {
  const panel = document.getElementById('rules-detail-panel');
  if (!selectedRulesCat) {
    panel.innerHTML = '<div class="card-title">Select a category to manage its rules</div>';
    return;
  }
  const cat = categoryById(selectedRulesCat);
  if (!cat) return;
  const rules = state.rules.filter(r => r.categoryId === selectedRulesCat);

  panel.innerHTML = `
    <div class="card-title">${cat.emoji||'📁'} ${escHtml(cat.name)} — Keywords</div>
    <p style="color:var(--muted);font-size:12px;margin-bottom:12px;">
      ${rules.length} keyword rule${rules.length!==1?'s':''} · Higher weight = stronger match signal
    </p>
    <div id="rule-chips">
      ${rules.length
        ? rules.map(r => `
            <span class="rule-chip">
              ${escHtml(r.keyword)}
              <span class="rule-weight">×${r.weight}</span>
              <button onclick="deleteRule('${r.id}')" title="Remove">✕</button>
            </span>`).join('')
        : '<p style="color:var(--muted);font-size:13px;">No keywords yet. Add some below.</p>'}
    </div>
    <div class="add-rule-row">
      <input type="text" id="new-rule-kw" placeholder="Keyword or phrase…" maxlength="60" />
      <select class="weight-select" id="new-rule-weight">
        <option value="1">Weight 1 (Weak)</option>
        <option value="2" selected>Weight 2</option>
        <option value="3">Weight 3 (Strong)</option>
      </select>
      <button class="btn btn-primary" onclick="addRule()">+ Add</button>
    </div>`;
}

function addRule() {
  const kw = document.getElementById('new-rule-kw').value.trim();
  const w  = parseInt(document.getElementById('new-rule-weight').value);
  if (!kw || !selectedRulesCat) return;

  const exists = state.rules.find(r => r.categoryId === selectedRulesCat &&
    r.keyword.toLowerCase() === kw.toLowerCase());
  if (exists) { showToast('Keyword already exists for this category', 'error'); return; }

  state.rules.push({ id: uid('rule'), categoryId: selectedRulesCat, keyword: kw, weight: w });
  saveState();
  renderRulesDetail();
  renderRulesSidebar();
  document.getElementById('new-rule-kw').value = '';
  showToast(`Rule "${kw}" added`, 'success');
}

function deleteRule(id) {
  state.rules = state.rules.filter(r => r.id !== id);
  saveState();
  renderRulesDetail();
  renderRulesSidebar();
}

function deleteCategory(id) {
  if (!confirm('Delete this category and all its rules?')) return;
  state.categories = state.categories.filter(c => c.id !== id);
  state.rules       = state.rules.filter(r => r.categoryId !== id);
  if (selectedRulesCat === id) selectedRulesCat = null;
  saveState();
  renderRulesSidebar();
  renderCatGrid();
  showToast('Category deleted', 'info');
}

// ──────────────────────────────────────────
//  Import / Export
// ──────────────────────────────────────────
function renderStats() {
  const row = document.getElementById('stats-row');
  row.innerHTML = `
    <div class="stat-box"><div class="num">${state.documents.length}</div><div class="lbl">Documents</div></div>
    <div class="stat-box"><div class="num">${state.categories.length}</div><div class="lbl">Categories</div></div>
    <div class="stat-box"><div class="num">${state.rules.length}</div><div class="lbl">Rules</div></div>
    <div class="stat-box"><div class="num">${state.categories.filter(c=>c.isCustom).length}</div><div class="lbl">Custom Cats</div></div>
  `;
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'classifier_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  showToast('Exported successfully', 'success');
}

function importJSON(data) {
  try {
    const imported = JSON.parse(data);
    let catAdded = 0, ruleAdded = 0, docAdded = 0;

    if (imported.categories) {
      for (const c of imported.categories) {
        if (!state.categories.find(x => x.id === c.id)) {
          state.categories.push(c); catAdded++;
        }
      }
    }
    if (imported.rules) {
      for (const r of imported.rules) {
        if (!state.rules.find(x => x.id === r.id)) {
          state.rules.push(r); ruleAdded++;
        }
      }
    }
    if (imported.documents) {
      for (const d of imported.documents) {
        if (!state.documents.find(x => x.id === d.id)) {
          state.documents.push(d); docAdded++;
        }
      }
    }
    saveState();
    renderAll();
    showToast(`Imported: +${catAdded} cats, +${ruleAdded} rules, +${docAdded} docs`, 'success');
  } catch(e) {
    showToast('Import failed: invalid JSON', 'error');
  }
}

function clearAll() {
  if (!confirm('Clear ALL data and restore defaults? This cannot be undone.')) return;
  resetDefaults();
  renderAll();
  showToast('Reset to defaults', 'info');
}

// ──────────────────────────────────────────
//  Toast
// ──────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type='info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ──────────────────────────────────────────
//  Tab switching
// ──────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');

  if (name === 'history') renderHistory();
  if (name === 'rules')   renderRulesSidebar();
  if (name === 'io')      renderStats();
}

// ──────────────────────────────────────────
//  Render all
// ──────────────────────────────────────────
function renderAll() {
  renderCatGrid();
  renderHistory();
  renderRulesSidebar();
  renderStats();
}

// ──────────────────────────────────────────
//  Event listeners
// ──────────────────────────────────────────
function setupEvents() {
  const dz = document.getElementById('drop-zone');
  const fi = document.getElementById('file-input');

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', async e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) await handleFile(f);
  });

  fi.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) { await handleFile(f); fi.value = ''; }
  });

  // Import area
  const ia = document.getElementById('import-area');
  const ii = document.getElementById('import-input');

  ia.addEventListener('dragover', e => { e.preventDefault(); ia.classList.add('dragover'); });
  ia.addEventListener('dragleave', () => ia.classList.remove('dragover'));
  ia.addEventListener('drop', async e => {
    e.preventDefault();
    ia.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) { const text = await f.text(); importJSON(text); }
  });
  ii.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) { const text = await f.text(); importJSON(text); ii.value = ''; }
  });

  // Enter key on inputs
  document.getElementById('new-cat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addCategory();
  });
}

async function handleFile(file) {
  try {
    const doc = await processFile(file);
    currentDoc = doc;
    selectedCategoryId = null;
    showPreview(doc);
    showToast('File loaded', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    console.error(e);
  }
}

// ──────────────────────────────────────────
//  Service / LLM Integration  (LM Studio backend)
//
//  The browser only talks to the doc-extractor-service (default
//  http://localhost:3100). The service proxies classification
//  requests to LM Studio (default http://localhost:1234/v1) using
//  the OpenAI-compatible chat-completions API. This keeps CORS
//  out of the picture and lets the server own model + prompt.
// ──────────────────────────────────────────
let serviceCfg = {
  // Migrate any old localStorage values from previous Ollama-era setup.
  url:   localStorage.getItem('service_url')
       || (function migrate() {
            const legacy = localStorage.getItem('ollama_url');
            // Anything still pointing at Ollama's 11434 is stale; reset.
            if (legacy && !legacy.includes(':11434')) return legacy;
            return 'http://localhost:3100';
          })(),
  // Default model id matches what LM Studio shows in its right-hand
  // "API Model Identifier" field (e.g. "gemma-4-e2b-it:2"). The trailing
  // ":<n>" suffix is LM Studio's instance slot, not a quantization tag,
  // so we keep ':' in valid ids. We just discard old Ollama-format tags
  // like "qwen2.5:1.5b" / "gemma3:4b" by checking for an Ollama-style
  // "name:size" pattern (single ':' followed by a size like 4b/9b/etc).
  model: (function migrateModel() {
    const stored =
      localStorage.getItem('llm_model') ||
      localStorage.getItem('ollama_model');
    if (stored && !/^[\w.\-]+:\d+(\.\d+)?b$/i.test(stored)) return stored;
    return 'gemma-4-e2b-it:2';
  })(),
  connected: false,
};
let aiSuggestedCategoryId = null;

// Backwards-compat alias so any leftover HTML or console probing that
// still references ollamaCfg keeps working.
const ollamaCfg = serviceCfg;

function saveOllamaSettings() {
  serviceCfg.url   = document.getElementById('ollama-url').value.trim().replace(/\/+$/,'');
  serviceCfg.model = document.getElementById('ollama-model').value.trim();
  localStorage.setItem('service_url', serviceCfg.url);
  localStorage.setItem('llm_model',   serviceCfg.model);
  // update badge in AI panel
  const badge = document.getElementById('ai-model-badge');
  if (badge) badge.textContent = serviceCfg.model;
}

async function testOllamaConnection() {
  setConnStatus('spin', 'Connecting…');
  setAiStatus('thinking', 'Checking service…');
  const corsWarn = document.getElementById('cors-warning');
  if (corsWarn) corsWarn.style.display = 'none';

  try {
    const res = await fetch(serviceCfg.url + '/llm/health', {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = ' — ' + (await res.text()).slice(0, 200); } catch {}
      throw new Error('HTTP ' + res.status + detail);
    }
    const payload = await res.json();
    if (!payload?.success) throw new Error(payload?.error || 'Service reports Ollama unreachable');

    const data = payload.data || {};
    const models = (data.models || []).map(m => m.name);
    serviceCfg.connected = true;
    setConnStatus('green', 'Connected ✓');
    updateNavDot(true);

    const mlEl = document.getElementById('ollama-models-list');
    if (mlEl) {
      if (models.length) {
        mlEl.innerHTML = 'Loaded models: ' +
          models.map(m => `<span class="kw-chip" style="cursor:pointer;" onclick="useModel('${m}')">${m}</span>`).join(' ');
      } else {
        mlEl.textContent = 'No models loaded — open LM Studio, load ' + serviceCfg.model + ', start the local server.';
      }
    }

    if (models.length && !models.includes(serviceCfg.model)) {
      // Auto-switch to a loaded model. Prefer Gemma; fall back to the first
      // loaded id. The server's resolveModelId does the same on the back
      // end, but updating the UI keeps the choice visible to the user.
      const previous = serviceCfg.model;
      const picked   = models.find(m => /gemma/i.test(m)) || models[0];
      useModel(picked);
      setAiStatus('done', 'LM Studio ready · ' + picked + '  (auto-switched from "' + previous + '")');
      showToast(`✅ Auto-switched to loaded model: ${picked}`, 'success');
    } else {
      setAiStatus('done', 'LM Studio ready · ' + serviceCfg.model);
      showToast('✅ Connected to extractor service', 'success');
    }

    if (currentDoc) enableAiBtn(true);

  } catch(e) {
    serviceCfg.connected = false;
    setConnStatus('red', 'Cannot reach service');
    updateNavDot(false);
    const mlEl = document.getElementById('ollama-models-list');
    if (mlEl) mlEl.textContent = '';

    const isNetwork = e instanceof TypeError && (
      e.message.includes('Failed to fetch') ||
      e.message.includes('NetworkError')
    );

    const hint = isNetwork
      ? 'Cannot reach extractor service. Start it with: cd extractor-service && npm run dev'
      : e.name === 'TimeoutError'
        ? 'Timeout — extractor service or LM Studio not responding'
        : 'Service error: ' + e.message;

    setAiStatus('error', hint);
    showToast(hint, 'error');
  }
}

function useModel(name) {
  serviceCfg.model = name;
  localStorage.setItem('llm_model', name);
  const modelEl = document.getElementById('ollama-model');
  if (modelEl) modelEl.value = name;
  const badge = document.getElementById('ai-model-badge');
  if (badge) badge.textContent = name;
  showToast('Model set to ' + name, 'info');
}

function pickModel(btn, modelName) {
  // Update pill highlight
  document.querySelectorAll('.model-pill').forEach(p => p.classList.remove('active-pill'));
  btn.classList.add('active-pill');
  // Update the "load this in LM Studio" hint
  const pullCmd = document.getElementById('pull-cmd');
  if (pullCmd) pullCmd.textContent = 'Load in LM Studio: ' + modelName;
  // Set as current model
  useModel(modelName);
}

function copyCmd(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {
    // Fallback for non-HTTPS
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓ Copied'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

function setConnStatus(state, label) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  dot.className = 'dot' + (state === 'green' ? ' green' : state === 'red' ? ' red' : state === 'spin' ? ' spin-dot' : '');
  if (lbl) lbl.textContent = label;
}

function updateNavDot(ok) {
  const d = document.getElementById('nav-dot');
  if (d) d.className = 'dot' + (ok ? ' green' : '');
}

function setAiStatus(type, msg) {
  const el = document.getElementById('ai-status');
  if (!el) return;
  el.className = 'ai-status ' + type;
  if (type === 'thinking') {
    el.innerHTML = `<span class="spinner"></span> ${msg}`;
  } else if (type === 'done') {
    el.innerHTML = `<span style="color:var(--green)">✓</span> ${msg}`;
  } else if (type === 'error') {
    el.innerHTML = `<span style="color:var(--red)">✕</span> ${msg}`;
  } else {
    el.textContent = msg;
  }
}

function enableAiBtn(on) {
  const btn = document.getElementById('ai-classify-btn');
  if (btn) btn.disabled = !on;
}

// ──────────────────────────────────────────
//  Run a classification via the extractor service
//  POST {service}/llm/classify/stream
//  Body: { text, categories: [{name}], model }
//  Server-Sent Events:
//    {type:"token", text:"…"}
//    {type:"done",  result:{category,confidence,reason,raw}}
//    {type:"error", message:"…"}
// ──────────────────────────────────────────
async function classifyWithOllama() {
  if (!currentDoc) return;
  if (!serviceCfg.connected) {
    showToast('Test connection first in Import/Export → Settings', 'error'); return;
  }

  const btn = document.getElementById('ai-classify-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running';

  const box = document.getElementById('ai-response-box');
  box.style.display = 'block';
  box.textContent = '';

  document.getElementById('ai-result-bar').style.display = 'none';
  setAiStatus('thinking', 'Sending to ' + serviceCfg.model + '…');

  let finalResult = null;

  try {
    const res = await fetch(serviceCfg.url + '/llm/classify/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:       currentDoc.fullText || currentDoc.firstPageText,
        categories: state.categories.map(c => ({ name: c.name })),
        model:      serviceCfg.model,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = ' — ' + (await res.text()).slice(0, 300); } catch {}
      throw new Error('Service HTTP ' + res.status + detail);
    }

    // Parse SSE: lines like  "data: {...}\n\n"
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on the SSE event delimiter (blank line)
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // An event can contain one or more "data: …" lines
        const dataLines = rawEvent.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart());
        if (!dataLines.length) continue;

        let evt;
        try { evt = JSON.parse(dataLines.join('\n')); }
        catch { continue; }

        if (evt.type === 'token' && typeof evt.text === 'string') {
          box.textContent += evt.text;
          box.scrollTop = box.scrollHeight;
        } else if (evt.type === 'done') {
          finalResult = evt.result;
        } else if (evt.type === 'error') {
          // The server attaches the accumulated model output to the error
          // event. Drop it into the response box so the user can see what
          // the model actually returned (truncated JSON / prose / etc).
          if (evt.raw && !box.textContent.trim()) {
            box.textContent = evt.raw;
          }
          throw new Error(evt.message || 'Server reported error');
        }
      }
    }

    if (finalResult) {
      applyClassificationResult(finalResult);
      setAiStatus('done', 'Done · ' + serviceCfg.model);
    } else {
      throw new Error('Stream ended without a final result');
    }

  } catch(e) {
    setAiStatus('error', 'Error: ' + e.message);
    if (!box.textContent.trim()) {
      box.textContent = 'Error: ' + e.message;
    }
    showToast('AI error: ' + e.message, 'error');
    console.warn('classify failed', e);
  }

  btn.disabled = false;
  btn.innerHTML = '<span>▶ Run</span>';
}

// ──────────────────────────────────────────
//  Latest AI classification, kept in module scope so labelDocument()
//  can persist subcategory / reason / confidence onto the document
//  record at save time.
// ──────────────────────────────────────────
let lastAiResult = null;

// ──────────────────────────────────────────
//  Render a successful classification onto the UI.
//  `result` shape: { category, subcategory?, confidence?, reason?, raw }
// ──────────────────────────────────────────
function applyClassificationResult(result) {
  lastAiResult = result || null;
  const catName = (result?.category || '').trim();
  const subcat  = (result?.subcategory || '').trim();

  if (!catName) {
    aiSuggestedCategoryId = null;
    document.getElementById('ai-result-bar').style.display = 'none';
    showToast('AI response received — no category', 'info');
    return;
  }

  const matched =
    state.categories.find(c => c.name.toLowerCase() === catName.toLowerCase()) ||
    state.categories.find(c => catName.toLowerCase().includes(c.name.toLowerCase()));

  if (matched) {
    aiSuggestedCategoryId = matched.id;
    const bar = document.getElementById('ai-result-bar');
    bar.style.display = 'flex';

    // Build the display label: "💰 Financial › Bank Statement  (high confidence)"
    let label = (matched.emoji || '📁') + ' ' + matched.name;
    if (subcat) label += '  ›  ' + subcat;
    if (result.confidence) label += '   (' + result.confidence + ' confidence)';
    document.getElementById('ai-result-cat').textContent = label;

    const toastMsg = subcat
      ? '🤖 AI suggests: ' + matched.name + ' › ' + subcat
      : '🤖 AI suggests: ' + matched.name;
    showToast(toastMsg, 'success');
  } else {
    aiSuggestedCategoryId = null;
    document.getElementById('ai-result-bar').style.display = 'none';
    showToast('AI response received — category "' + catName + '" not in list', 'info');
  }
}

function applyAiSuggestion() {
  if (!aiSuggestedCategoryId) return;
  selectCategory(aiSuggestedCategoryId);
  showToast('AI suggestion applied — click Apply Label to save', 'info');
  document.getElementById('ai-result-bar').style.display = 'none';
}

// ──────────────────────────────────────────
//  Init
// ──────────────────────────────────────────
loadState();
setupEvents();
renderCatGrid();
renderStats();

// Restore service settings inputs
(function initServiceUI() {
  const urlEl   = document.getElementById('ollama-url');
  const modelEl = document.getElementById('ollama-model');
  if (urlEl)   urlEl.value   = serviceCfg.url;
  if (modelEl) modelEl.value = serviceCfg.model;

  // sync pull-cmd pill
  document.querySelectorAll('.model-pill').forEach(p => {
    const m = p.onclick?.toString().match(/'([^']+)'/)?.[1];
    if (m === serviceCfg.model) p.classList.add('active-pill');
    else p.classList.remove('active-pill');
  });
  const pullCmd = document.getElementById('pull-cmd');
  if (pullCmd) pullCmd.textContent = 'Load in LM Studio: ' + serviceCfg.model;
  const badge = document.getElementById('ai-model-badge');
  if (badge) badge.textContent = serviceCfg.model;

  // Auto-test on load (silent)
  fetch(serviceCfg.url + '/llm/health', { signal: AbortSignal.timeout(3000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(payload => {
      if (!payload?.success) throw new Error(payload?.error || 'service reports Ollama unreachable');
      serviceCfg.connected = true;
      setConnStatus('green', 'Connected');
      updateNavDot(true);
      const models = (payload.data?.models || []).map(m => m.name);
      // If the configured model isn't loaded, silently switch to whatever
      // is. Same logic as testOllamaConnection — keeps page-load happy.
      if (models.length && !models.includes(serviceCfg.model)) {
        const picked = models.find(m => /gemma/i.test(m)) || models[0];
        useModel(picked);
      }
      setAiStatus('done', 'LM Studio ready · ' + serviceCfg.model);
      const ml = document.getElementById('ollama-models-list');
      if (ml) ml.textContent = 'Loaded: ' + (models.length ? models.join(', ') : 'none');
      if (currentDoc) enableAiBtn(true);
    })
    .catch(() => {
      setAiStatus('', 'LM Studio not connected — configure in Import/Export → Settings');
    });
}());
