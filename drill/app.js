/* FMH DRILL · app.js
   Six modes on top of one drill bank and one case list:
   PRÜFUNG (case exam), ABFRAGE (graded quiz), LAZY (flashcards), FREI (free prompt),
   MATERIAL (dump pad → new drills), STATUS (what is weak). Progress is saved through
   server.py to ./userdata on this machine, or to localStorage when opened without the server. */
(function () {
  'use strict';

  const P = window.PROMPTS;
  const CASES = window.CASES;
  const CORPUS = window.CORPUS || {};
  const EXAM_DATE = new Date('2026-11-21T15:00:00+01:00');
  const OPENAI = 'https://api.openai.com/v1';
  const INTERVALS = [0, 1, 3, 7, 14, 30]; // days per Leitner box
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ state
  const DEFAULT_SETTINGS = {
    apiKey: '', model: 'gpt-5.1', reasoning: 'low', transcribeModel: 'gpt-4o-transcribe', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'onyx',
    examinerVoice: false, lang: 'de', strictness: 'standard', followups: 1, custom: '', dailyGoal: 30, readAloud: false, quizCount: 20,
  };
  let state = { version: 1, settings: { ...DEFAULT_SETTINGS }, items: {}, caseLog: {}, daily: {}, lastFilters: {} };
  let customBank = [];
  let materialsIndex = [];
  let serverOk = false;
  let seedBank = [];

  const Store = {
    async init() {
      try { const r = await fetch('/api/ping', { cache: 'no-store' }); serverOk = r.ok; } catch { serverOk = false; }
      if (serverOk) {
        const [s, b, m] = await Promise.all([fetch('/api/state').then((r) => r.json()), fetch('/api/bank').then((r) => r.json()), fetch('/api/materials').then((r) => r.json())]);
        if (s && s.settings) state = { ...state, ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } };
        customBank = Array.isArray(b) ? b : [];
        materialsIndex = Array.isArray(m) ? m : [];
      } else {
        try {
          const s = JSON.parse(localStorage.getItem('fmhdrill.state') || 'null');
          if (s && s.settings) state = { ...state, ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } };
          customBank = JSON.parse(localStorage.getItem('fmhdrill.bank') || '[]');
          materialsIndex = JSON.parse(localStorage.getItem('fmhdrill.materials.index') || '[]');
        } catch { /* fresh start */ }
      }
    },
    _timer: null,
    saveState() {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.flush(), 400);
    },
    async flush() {
      const body = JSON.stringify(state);
      if (serverOk) {
        try { await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body }); }
        catch { toast('Speichern fehlgeschlagen · läuft server.py noch?', true); }
      } else {
        try { localStorage.setItem('fmhdrill.state', body); } catch { toast('Browser-Speicher voll', true); }
      }
    },
    async saveBank() {
      const body = JSON.stringify(customBank);
      if (serverOk) await fetch('/api/bank', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
      else localStorage.setItem('fmhdrill.bank', body);
    },
    async putMaterial(material) {
      if (serverOk) await fetch(`/api/materials/${material.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(material) });
      else localStorage.setItem(`fmhdrill.material.${material.id}`, JSON.stringify(material));
      const summary = { ...material }; delete summary.text;
      const idx = materialsIndex.findIndex((m) => m.id === material.id);
      if (idx >= 0) materialsIndex[idx] = summary; else materialsIndex.push(summary);
      if (!serverOk) localStorage.setItem('fmhdrill.materials.index', JSON.stringify(materialsIndex));
    },
    async getMaterial(id) {
      if (serverOk) return fetch(`/api/materials/${id}`).then((r) => (r.ok ? r.json() : null));
      return JSON.parse(localStorage.getItem(`fmhdrill.material.${id}`) || 'null');
    },
    async deleteMaterial(id) {
      if (serverOk) await fetch(`/api/materials/${id}`, { method: 'DELETE' });
      else localStorage.removeItem(`fmhdrill.material.${id}`);
      materialsIndex = materialsIndex.filter((m) => m.id !== id);
      if (!serverOk) localStorage.setItem('fmhdrill.materials.index', JSON.stringify(materialsIndex));
    },
    async putSession(session) {
      if (serverOk) await fetch(`/api/sessions/${session.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session) });
      else { try { localStorage.setItem(`fmhdrill.session.${session.id}`, JSON.stringify(session)); } catch { /* too big for localStorage, grade is kept in state */ } }
    },
    async getSession(id) {
      if (serverOk) return fetch(`/api/sessions/${id}`).then((r) => (r.ok ? r.json() : null));
      return JSON.parse(localStorage.getItem(`fmhdrill.session.${id}`) || 'null');
    },
    async uploadFile(file) {
      if (!serverOk) return;
      try { await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }); } catch { /* original not kept, text is */ }
    },
  };

  // ------------------------------------------------------------------ ui helpers
  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false; el.classList.toggle('error', !!isError);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 2800);
  }
  function daysLeft() { return Math.ceil((EXAM_DATE - Date.now()) / 86400000); }
  function gradeClass(g) { if (g == null) return 'none'; return `g${Math.max(1, Math.min(6, Math.round(g)))}`; }
  function fmtGrade(g) { return g == null ? '–' : (Math.round(g * 10) / 10).toFixed(1); }
  function bump(key, n = 1) {
    const d = state.daily[today()] || (state.daily[today()] = {});
    d[key] = (d[key] || 0) + n; Store.saveState();
  }
  function requireKey() {
    if (state.settings.apiKey) return true;
    toast('Zuerst den OpenAI API-Schlüssel unter ⚙ eintragen.', true); location.hash = '#settings'; return false;
  }

  // ------------------------------------------------------------------ openai
  function isReasoningModel(model) { return /^(gpt-5|o[1-9])/i.test(model || ''); }
  function baseBody(model, extra = {}) {
    const body = { model, ...extra };
    if (isReasoningModel(model)) { if (state.settings.reasoning && state.settings.reasoning !== 'default') body.reasoning_effort = state.settings.reasoning; }
    else body.temperature = 0.3;
    return body;
  }
  async function openaiFetch(path, init) {
    const res = await fetch(`${OPENAI}${path}`, { ...init, headers: { authorization: `Bearer ${state.settings.apiKey}`, ...(init.headers || {}) } });
    if (!res.ok) {
      let message = `OpenAI ${res.status}`;
      try { const err = await res.json(); message = err.error?.message || message; } catch { /* keep status */ }
      const error = new Error(message); error.status = res.status; throw error;
    }
    return res;
  }
  async function chatJSON({ system, messages, schema, name, model }) {
    const useModel = model || state.settings.model;
    const msgs = [{ role: 'system', content: system }, ...messages];
    const attempt = async (format, body) => {
      const res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, messages: msgs, response_format: format }) });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    };
    const body = baseBody(useModel);
    try {
      return await attempt({ type: 'json_schema', json_schema: { name, strict: true, schema } }, body);
    } catch (error) {
      if (/reasoning_effort|Unsupported parameter|unsupported_parameter/i.test(error.message) && body.reasoning_effort) {
        delete body.reasoning_effort;
        return attempt({ type: 'json_schema', json_schema: { name, strict: true, schema } }, body);
      }
      if (/response_format|json_schema/i.test(error.message)) {
        msgs[0].content += '\nAntworte ausschliesslich mit gültigem JSON.';
        return attempt({ type: 'json_object' }, body);
      }
      throw error;
    }
  }
  async function chatStream({ system, messages, model, onDelta }) {
    const useModel = model || state.settings.model;
    const body = baseBody(useModel, { stream: true, messages: [{ role: 'system', content: system }, ...messages] });
    let res;
    try {
      res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      if (/reasoning_effort|Unsupported parameter/i.test(error.message) && body.reasoning_effort) {
        delete body.reasoning_effort;
        res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } else throw error;
    }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let full = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim(); if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim(); if (payload === '[DONE]') continue;
        try { const delta = JSON.parse(payload).choices?.[0]?.delta?.content; if (delta) { full += delta; onDelta(full); } } catch { /* partial line */ }
      }
    }
    return full;
  }
  async function transcribe(blob, ext) {
    const form = new FormData();
    form.append('file', blob, `antwort.${ext}`);
    form.append('model', state.settings.transcribeModel || 'gpt-4o-transcribe');
    form.append('language', state.settings.lang === 'en' ? 'en' : 'de');
    form.append('prompt', 'Mündliche Prüfungsantwort Orthopädie und Traumatologie. Fachbegriffe, Klassifikationen, Eigennamen (Garden, Pauwels, Weber, Schatzker, Letournel, AO).');
    const res = await openaiFetch('/audio/transcriptions', { method: 'POST', body: form });
    const data = await res.json();
    return (data.text || '').trim();
  }
  let currentAudio = null;
  async function speak(text) {
    if (!text || !state.settings.apiKey) return;
    try {
      const res = await openaiFetch('/audio/speech', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: state.settings.ttsModel || 'gpt-4o-mini-tts', voice: state.settings.ttsVoice || 'onyx', input: text, response_format: 'mp3', instructions: 'Nüchterner, zügiger Prüfungston. Keine Emotion.' }),
      });
      const url = URL.createObjectURL(await res.blob());
      if (currentAudio) { currentAudio.pause(); }
      currentAudio = new Audio(url); currentAudio.play().catch(() => {});
    } catch (error) { toast(`Sprachausgabe: ${error.message}`, true); }
  }
  function readAloud(text) {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = state.settings.lang === 'en' ? 'en-GB' : 'de-CH'; u.rate = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === u.lang) || voices.find((x) => x.lang.startsWith(u.lang.slice(0, 2)));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ recorder
  const Recorder = {
    rec: null, chunks: [], ext: 'webm', active: false,
    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
      this.ext = mime.startsWith('audio/mp4') ? 'mp4' : 'webm';
      this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.rec.start(250); this.active = true;
    },
    stop() {
      return new Promise((resolve) => {
        if (!this.rec) return resolve(null);
        this.rec.onstop = () => {
          this.rec.stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' });
          this.active = false; this.rec = null; resolve(blob);
        };
        this.rec.stop();
      });
    },
  };
  function wireMic(button, textarea, onDone) {
    button.addEventListener('click', async () => {
      if (!requireKey()) return;
      if (!Recorder.active) {
        try { await Recorder.start(); button.classList.add('on'); button.textContent = '■ STOP'; }
        catch (error) { toast(`Mikrofon: ${error.message}`, true); }
        return;
      }
      button.classList.remove('on'); button.textContent = '… TRANSKRIBIERE'; button.disabled = true;
      try {
        const blob = await Recorder.stop();
        const text = await transcribe(blob, Recorder.ext);
        textarea.value = (textarea.value ? `${textarea.value.trim()} ` : '') + text;
        textarea.dispatchEvent(new Event('input'));
        if (onDone) onDone(text);
      } catch (error) { toast(`Transkription: ${error.message}`, true); }
      button.disabled = false; button.textContent = '● SPRECHEN';
    });
  }

  // ------------------------------------------------------------------ bank
  function buildSeed() {
    seedBank = (window.SEED_BANK || []).map((it) => ({ ...it, id: `s-${hash(it.q)}`, source: 'seed' }));
  }
  function allItems() { return seedBank.concat(customBank); }
  function stats(id) { return state.items[id] || { box: 0, due: 0, seen: 0, right: 0, hist: [] }; }
  function schedule(id, score) {
    const s = { ...stats(id) };
    s.seen += 1; s.hist = (s.hist || []).concat(score).slice(-10); s.last = Date.now();
    if (score === 2) { s.box = Math.min(5, (s.box || 0) + 1); s.right += 1; }
    else if (score === 1) { s.box = Math.max(1, Math.min(2, s.box || 0)); }
    else { s.box = 0; }
    s.due = Date.now() + INTERVALS[s.box] * 86400000;
    state.items[id] = s; Store.saveState();
  }
  function accuracy(id) { const h = stats(id).hist || []; if (!h.length) return null; return h.reduce((a, b) => a + b, 0) / (2 * h.length); }
  function filterItems(f) {
    const q = norm(f.search || '');
    return allItems().filter((it) => {
      if (f.regions?.length && !f.regions.includes(it.region)) return false;
      if (f.types?.length && !f.types.includes(it.type)) return false;
      if (f.source === 'seed' && it.source !== 'seed') return false;
      if (f.source === 'custom' && it.source === 'seed') return false;
      if (q && !norm(`${it.topic} ${it.q} ${it.a}`).includes(q)) return false;
      const s = stats(it.id);
      if (f.only === 'due' && !(s.seen && s.due <= Date.now())) return false;
      if (f.only === 'new' && s.seen) return false;
      if (f.only === 'weak' && !(s.seen && (accuracy(it.id) ?? 1) < 0.75)) return false;
      return true;
    });
  }
  function pickSession(items, count) {
    const now = Date.now();
    const due = shuffle(items.filter((it) => { const s = stats(it.id); return s.seen && s.due <= now; }));
    const fresh = shuffle(items.filter((it) => !stats(it.id).seen));
    const rest = shuffle(items.filter((it) => { const s = stats(it.id); return s.seen && s.due > now; })).sort((a, b) => stats(a.id).box - stats(b.id).box);
    return due.concat(fresh, rest).slice(0, count);
  }
  async function addItems(rawItems, source, caseIds) {
    const known = new Set(allItems().map((it) => norm(it.q)));
    let added = 0;
    for (const raw of rawItems) {
      const q = String(raw.frage || raw.q || '').trim(); const a = String(raw.antwort || raw.a || '').trim();
      if (!q || !a || known.has(norm(q))) continue;
      known.add(norm(q));
      customBank.push({
        id: `c-${uid()}`, type: P.TYPES.includes(raw.typ) ? raw.typ : 'konzept',
        region: P.REGIONS.includes(raw.region) ? raw.region : (caseIds?.length ? (P.CASE_REGION_TO_DRILL[caseById(caseIds[0])?.region] || [])[0] || 'Infekt, Tumor & Allgemein' : 'Infekt, Tumor & Allgemein'),
        topic: raw.thema || raw.topic || '', q, a, source, caseIds: caseIds || [], createdAt: Date.now(),
      });
      added += 1;
    }
    if (added) await Store.saveBank();
    return added;
  }
  function caseById(id) { return CASES.find((c) => c.id === id); }

  // grounding text for a case: attached presentations + dumped materials tagged with it
  async function groundingForCase(caseItem, budget = 14000) {
    const parts = [];
    for (const entry of CORPUS[caseItem.id] || []) parts.push(`[${entry.name}]\n${entry.text}`);
    for (const m of materialsIndex.filter((x) => (x.caseIds || []).includes(caseItem.id))) {
      const full = await Store.getMaterial(m.id);
      if (full?.text) parts.push(`[${m.name}]\n${full.text.slice(0, 6000)}`);
    }
    const bankLines = allItems().filter((it) => (it.caseIds || []).includes(caseItem.id)).map((it) => `F: ${it.q} A: ${it.a}`);
    if (bankLines.length) parts.push(`[Abfrage-Items zum Fall]\n${bankLines.join('\n')}`);
    const text = parts.join('\n\n');
    return text.length > budget ? `${text.slice(0, budget)}\n[gekürzt]` : text;
  }
  async function groundingForRegion(region, budget = 14000) {
    const ids = CASES.filter((c) => (P.CASE_REGION_TO_DRILL[c.region] || []).includes(region)).map((c) => c.id);
    const parts = [];
    for (const id of ids) for (const entry of CORPUS[id] || []) parts.push(`[${entry.name}]\n${entry.text}`);
    const text = parts.join('\n\n');
    return text.length > budget ? text.slice(0, budget) : text;
  }

  // ------------------------------------------------------------------ router
  const view = $('#view');
  let currentCleanup = null;
  function navigate() {
    if (currentCleanup) { currentCleanup(); currentCleanup = null; }
    window.speechSynthesis?.cancel();
    const [route, arg] = location.hash.replace(/^#/, '').split('/');
    const name = route || 'exam';
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    const render = VIEWS[name] || VIEWS.exam;
    view.innerHTML = '';
    render(arg);
    window.scrollTo(0, 0);
  }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) location.hash = `#${b.dataset.view}`; });
  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------------ EXAM · matrix
  function caseSummary(caseId) {
    const log = state.caseLog[caseId] || [];
    if (!log.length) return { runs: 0, last: null, mean: null };
    return { runs: log.length, last: log[log.length - 1].grade, mean: log.reduce((a, b) => a + b.grade, 0) / log.length };
  }
  function renderMatrix() {
    const regions = []; for (const c of CASES) if (!regions.includes(c.region)) regions.push(c.region);
    const done = CASES.filter((c) => caseSummary(c.id).runs > 0).length;
    const graded = CASES.map((c) => caseSummary(c.id).mean).filter((g) => g != null);
    const mean = graded.length ? graded.reduce((a, b) => a + b, 0) / graded.length : null;
    view.innerHTML = `
      <div class="hero">
        <span class="kicker">PRÜFUNGSMODUS · KLINISCHE FALLBESPRECHUNG</span>
        <h1>Fall-Matrix</h1>
        <p>Jeder Fall: 5 Stationen in der offiziellen Reihenfolge, 15 Minuten, Note 1–6. Antworten gesprochen oder getippt. Am Ende Feedback nach festem Schema.</p>
        <div class="row" style="margin-top:18px">
          <button class="btn primary" id="btn-next">NÄCHSTER OFFENER FALL</button>
          <button class="btn" id="btn-random">ZUFALL</button>
          <button class="btn" id="btn-weak">SCHWÄCHSTER FALL</button>
          <span class="meta">${done}/${CASES.length} FÄLLE GEPRÜFT · Ø ${fmtGrade(mean)}</span>
        </div>
      </div>
      ${regions.map((region) => {
        const items = CASES.filter((c) => c.region === region);
        const regionDone = items.filter((c) => caseSummary(c.id).runs > 0).length;
        return `<section class="matrix-group">
          <div class="matrix-head"><h3>${esc(region)}</h3><span class="meta">${regionDone}/${items.length}</span></div>
          ${items.map((c) => { const s = caseSummary(c.id); return `
            <button class="case-row" data-case="${c.id}">
              <span class="id">${esc(c.id.toUpperCase())}</span>
              <span class="title">${esc(c.title)}</span>
              <span class="runs">${s.runs ? `${s.runs}×` : ''}</span>
              <span class="grade ${gradeClass(s.last)}">${fmtGrade(s.last)}</span>
            </button>`; }).join('')}
        </section>`;
      }).join('')}`;
    view.addEventListener('click', (e) => { const b = e.target.closest('.case-row'); if (b) location.hash = `#exam/${b.dataset.case}`; });
    $('#btn-next').onclick = () => { const c = CASES.find((x) => caseSummary(x.id).runs === 0) || CASES[0]; location.hash = `#exam/${c.id}`; };
    $('#btn-random').onclick = () => { location.hash = `#exam/${CASES[Math.floor(Math.random() * CASES.length)].id}`; };
    $('#btn-weak').onclick = () => {
      const graded = CASES.filter((x) => caseSummary(x.id).mean != null).sort((a, b) => caseSummary(a.id).mean - caseSummary(b.id).mean);
      location.hash = `#exam/${(graded[0] || CASES[0]).id}`;
    };
  }

  // ------------------------------------------------------------------ EXAM · session
  function renderExam(caseId) {
    if (!caseId) return renderMatrix();
    const caseItem = caseById(caseId);
    if (!caseItem) { location.hash = '#exam'; return; }
    const session = { id: `${today().replace(/-/g, '')}-${uid()}`, caseId, title: caseItem.title, startedAt: Date.now(), status: 'laufend', dossier: null, messages: [], transcript: [], station: 0, followup: 0, feedback: null };
    const previous = (state.caseLog[caseId] || []).map((l) => l.variant).filter(Boolean).slice(-6);
    const history = state.caseLog[caseId] || [];
    const difficulty = history.length === 0 ? 'Standardfall, typische Präsentation.' : (history[history.length - 1].grade >= 5 ? 'Anspruchsvoll: Begleitverletzung, relevante Komorbidität oder Komplikation im Verlauf einbauen.' : 'Standardfall, aber andere Variante.');
    let timerId = null; let busy = false;
    const followupsTotal = Math.max(0, Math.min(3, Number(state.settings.followups) || 0));

    view.innerHTML = `
      <div class="row between" style="margin-bottom:18px">
        <div><span class="kicker" style="margin-bottom:6px">FALL ${esc(caseId.toUpperCase())} · ${esc(caseItem.region)}</span><h2 style="margin:0">${esc(caseItem.title)}</h2></div>
        <div class="row"><span class="timer" id="timer">15:00</span><button class="btn ghost" id="btn-abort">ABBRECHEN</button></div>
      </div>
      <div class="station-strip" id="strip">${P.STATIONS.map(() => '<span></span>').join('')}</div>
      <div class="session">
        <div>
          <div id="dossier" class="dossier"><span class="thinking"><span class="spinner"></span> &nbsp;DER PRÜFER BEREITET DEN FALL VOR</span></div>
          <div class="transcript" id="transcript"></div>
          <div class="answer-box" id="answer-box" hidden>
            <div class="station-label" id="station-label"></div>
            <textarea class="answer" id="answer" placeholder="Antwort sprechen (● SPRECHEN) oder tippen … ⌘/Ctrl+Enter sendet"></textarea>
            <div class="answer-tools">
              <button class="btn rec" id="mic">● SPRECHEN</button>
              <span class="spacer"></span>
              <button class="btn" id="btn-ask" title="Befund erfragen, ohne dass es als Antwort zählt">NUR RÜCKFRAGE</button>
              <button class="btn primary" id="btn-send">ANTWORTEN</button>
            </div>
          </div>
        </div>
        <aside class="session-side">
          <div class="side-block"><span class="label muted">ERWARTETE STRUKTUR</span><div class="schema" id="schema"></div></div>
          <div class="side-block"><span class="label muted">DIE 5 STATIONEN</span><div class="schema">${P.STATIONS.map((s, i) => `<div id="st-${i}">${i + 1} · ${esc(s.label)}</div>`).join('')}</div></div>
          <div class="side-block schema">Prüfer-Stimme: <strong>${state.settings.examinerVoice ? 'an' : 'aus'}</strong> · Nachfragen pro Station: <strong>${followupsTotal}</strong> · Strenge: <strong>${esc(state.settings.strictness)}</strong><br>Rückfragen an den Prüfer (Befunde, Labor, CT) sind erlaubt und realistisch.</div>
        </aside>
      </div>`;

    const transcriptEl = $('#transcript'); const answerEl = $('#answer'); const sendBtn = $('#btn-send'); const askBtn = $('#btn-ask');
    wireMic($('#mic'), answerEl);
    answerEl.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });
    $('#btn-abort').onclick = () => { if (confirm('Fall abbrechen? Es wird nichts gewertet.')) location.hash = '#exam'; };

    function addMsg(role, text) {
      session.transcript.push({ role, text, t: Date.now() });
      const div = document.createElement('div'); div.className = `msg ${role}`;
      div.innerHTML = `<div class="who">${role === 'examiner' ? 'PRÜFER' : role === 'candidate' ? 'KANDIDAT' : 'SYSTEM'}</div><div class="body">${esc(text)}</div>`;
      transcriptEl.appendChild(div);
      div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (role === 'examiner' && state.settings.examinerVoice) speak(text);
    }
    function setStation(i) {
      session.station = i; session.followup = 0;
      $$('#strip span').forEach((s, j) => { s.className = j < i ? 'done' : j === i ? 'now' : ''; });
      P.STATIONS.forEach((s, j) => { $(`#st-${j}`).style.color = j === i ? 'var(--signal)' : j < i ? 'var(--faint)' : ''; });
      $('#station-label').textContent = `STATION ${i + 1}/5 · ${P.STATIONS[i].label}`;
      $('#schema').innerHTML = esc(P.STATIONS[i].schema);
    }
    function openStation(i) {
      setStation(i);
      const opener = P.STATIONS[i].opener;
      session.messages.push({ role: 'assistant', content: JSON.stringify({ reaktion: '', frage: opener }) });
      addMsg('examiner', opener);
    }
    function startTimer() {
      const end = Date.now() + 15 * 60000;
      timerId = setInterval(() => {
        const left = end - Date.now(); const el = $('#timer'); if (!el) return clearInterval(timerId);
        const abs = Math.abs(left); const m = Math.floor(abs / 60000); const s = Math.floor((abs % 60000) / 1000);
        el.textContent = `${left < 0 ? '−' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        el.classList.toggle('late', left < 0);
      }, 500);
    }
    currentCleanup = () => { clearInterval(timerId); if (Recorder.active) Recorder.stop(); if (currentAudio) currentAudio.pause(); };

    async function begin() {
      if (!requireKey()) return;
      try {
        const grounding = await groundingForCase(caseItem);
        session.dossier = await chatJSON({ system: 'Du bist Prüfungsexperte und erstellst Prüfungsdossiers. Antworte ausschliesslich mit dem verlangten JSON.', messages: [{ role: 'user', content: P.dossierPrompt(state.settings, caseItem, grounding, previous, difficulty) }], schema: P.DOSSIER_SCHEMA, name: 'dossier' });
        session.system = P.examinerSystem(state.settings, caseItem, session.dossier, grounding);
        const d = session.dossier;
        $('#dossier').innerHTML = `<span class="label muted">PATIENTENUNTERLAGEN</span><p>${esc(d.unterlagen)}</p><span class="label muted">BILDDOKUMENTATION</span><p>${esc(d.bildgebung)}</p>`;
        $('#answer-box').hidden = false;
        startTimer();
        openStation(0);
        answerEl.focus();
        Store.putSession(session);
      } catch (error) {
        $('#dossier').innerHTML = `<p class="warn">Fall konnte nicht erstellt werden: ${esc(error.message)}</p><button class="btn" onclick="location.reload()">NOCHMALS</button>`;
      }
    }

    async function send(onlyQuestion) {
      const text = answerEl.value.trim();
      if (!text || busy) return;
      busy = true; sendBtn.disabled = true; askBtn.disabled = true;
      addMsg('candidate', text); answerEl.value = '';
      session.messages.push({ role: 'user', content: text });
      const i = session.station;
      if (!onlyQuestion) session.followup += 1;
      const isLast = i === P.STATIONS.length - 1;
      const thinking = document.createElement('div'); thinking.className = 'thinking'; thinking.innerHTML = '<span class="spinner"></span>'; transcriptEl.appendChild(thinking);
      try {
        const followupNo = onlyQuestion ? Math.min(session.followup + 1, followupsTotal) : session.followup;
        const control = onlyQuestion
          ? `[STATION ${i + 1}/5 · ${P.STATIONS[i].label}] Der Kandidat hat eine Rückfrage gestellt. Beantworte sie knapp aus dem Dossier (Feld "reaktion") und wiederhole in "frage" die noch offene Frage in einem Satz.`
          : P.turnPrompt(i, followupNo, followupsTotal, !isLast);
        session.messages.push({ role: 'user', content: control });
        const turn = await chatJSON({ system: session.system, messages: session.messages, schema: P.TURN_SCHEMA, name: 'pruefer_zug' });
        session.messages.pop(); // control message is not part of the visible dialogue
        session.messages.push({ role: 'assistant', content: JSON.stringify(turn) });
        thinking.remove();
        const spoken = [turn.reaktion, turn.frage].filter(Boolean).join(' ');
        if (spoken) addMsg('examiner', spoken);
        if (!onlyQuestion && !turn.frage) {
          if (isLast) { await finish(); return; }
          openStation(i + 1);
        } else if (!onlyQuestion && session.followup > followupsTotal) {
          // model asked despite exhausted follow-ups: accept it once, then move on next turn
          session.followup = followupsTotal;
        }
        Store.putSession(session);
      } catch (error) { thinking.remove(); addMsg('system', `Fehler: ${error.message}`); answerEl.value = text; }
      busy = false; sendBtn.disabled = false; askBtn.disabled = false; answerEl.focus();
    }
    sendBtn.onclick = () => send(false);
    askBtn.onclick = () => send(true);

    async function finish() {
      clearInterval(timerId);
      $('#answer-box').hidden = true;
      const thinking = document.createElement('div'); thinking.className = 'thinking'; thinking.innerHTML = '<span class="spinner"></span> &nbsp;BEWERTUNG'; transcriptEl.appendChild(thinking);
      const transcript = session.transcript.filter((m) => m.role !== 'system').map((m) => `${m.role === 'examiner' ? 'PRÜFER' : 'KANDIDAT'}: ${m.text}`).join('\n');
      try {
        const fb = await chatJSON({ system: 'Du bist Prüfungsexperte und bewertest nach dem offiziellen Schema. Antworte ausschliesslich mit dem verlangten JSON.', messages: [{ role: 'user', content: P.feedbackPrompt(state.settings, caseItem, session.dossier, transcript) }], schema: P.FEEDBACK_SCHEMA, name: 'feedback' });
        thinking.remove();
        session.feedback = fb; session.status = 'beendet'; session.endedAt = Date.now(); session.grade = fb.note;
        (state.caseLog[caseId] = state.caseLog[caseId] || []).push({ t: Date.now(), grade: fb.note, noten: fb.noten, sessionId: session.id, variant: session.dossier.titel });
        bump('exam');
        const added = await addItems(fb.drills || [], `prüfung ${caseId}`, [caseId]);
        Store.putSession(session);
        renderFeedback(fb, added);
      } catch (error) { thinking.remove(); addMsg('system', `Bewertung fehlgeschlagen: ${error.message}`); const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'BEWERTUNG WIEDERHOLEN'; b.onclick = () => { b.remove(); finish(); }; transcriptEl.appendChild(b); }
    }
    function renderFeedback(fb, added) {
      const n = fb.noten; const keys = [['anamnese_untersuchung', 'Anamnese / Untersuchung'], ['bildgebung_zusatz', 'Bildgebung / Zusatz'], ['dd_diagnose_prognose', 'DD / Diagnose / Prognose'], ['therapie_indikation_aufklaerung', 'Therapie / Indikation / Aufklärung'], ['nachsorge', 'Nachsorge'], ['struktur', 'Struktur']];
      const div = document.createElement('div');
      div.innerHTML = `
        <hr class="sep">
        <span class="kicker">FEEDBACK</span>
        <div class="row between"><div class="big-grade ${gradeClass(fb.note)}">${fmtGrade(fb.note)}</div><div class="meta">${esc(session.dossier.loesung.diagnose)}<br>${esc(session.dossier.loesung.klassifikation)}</div></div>
        <div class="scores">${keys.map(([k, l]) => `<div class="score"><div class="v ${gradeClass(n[k])}">${n[k]}</div><div class="k">${esc(l)}</div></div>`).join('')}</div>
        <div class="grid2">
          <div><h3>Gefehlt / falsch</h3><ul class="clean">${(fb.fehlend || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
          <div><h3>Gut</h3><ul class="clean">${(fb.gut || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            <h3 style="margin-top:18px">Merksätze</h3><ul class="clean">${(fb.merksaetze || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        </div>
        <hr class="sep">
        <h3>Musterantwort-Gerüst</h3>
        <div class="muster">${P.STATIONS.map((s, i) => `<p><span class="label">${i + 1} · ${esc(s.label)}</span>${esc(fb.musterantwort[`station${i + 1}`])}</p>`).join('')}</div>
        <p class="meta">${added} NEUE ABFRAGE-ITEMS AUS DEINEN LÜCKEN GESPEICHERT</p>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="fb-again">GLEICHER FALL, NEUE VARIANTE</button><button class="btn" id="fb-next">NÄCHSTER OFFENER FALL</button><button class="btn ghost" id="fb-matrix">ZUR MATRIX</button></div>`;
      transcriptEl.appendChild(div); div.scrollIntoView({ behavior: 'smooth' });
      $('#fb-again').onclick = () => { navigate(); };
      $('#fb-next').onclick = () => { const c = CASES.find((x) => caseSummary(x.id).runs === 0) || CASES[0]; location.hash = `#exam/${c.id}`; if (c.id === caseId) navigate(); };
      $('#fb-matrix').onclick = () => { location.hash = '#exam'; };
    }
    begin();
  }

  // ------------------------------------------------------------------ filters (shared by quiz/lazy)
  function filterBar(container, key, onChange, extra = '') {
    const f = state.lastFilters[key] || (state.lastFilters[key] = { regions: [], types: [], only: 'all', source: 'all', search: '', count: state.settings.quizCount || 20 });
    const count = filterItems(f).length;
    container.innerHTML = `
      <div class="filters" id="f-regions">${P.REGIONS.map((r) => `<span class="pill clickable ${f.regions.includes(r) ? 'on' : ''}" data-r="${esc(r)}">${esc(r)}</span>`).join('')}</div>
      <div class="filters" id="f-types">${P.TYPES.map((t) => `<span class="pill clickable ${f.types.includes(t) ? 'on' : ''}" data-t="${t}">${t}</span>`).join('')}
        <span style="width:12px"></span>
        ${[['all', 'alle'], ['due', 'fällig'], ['new', 'neu'], ['weak', 'schwach']].map(([v, l]) => `<span class="pill clickable ${f.only === v ? 'on' : ''}" data-only="${v}">${l}</span>`).join('')}
        <span style="width:12px"></span>
        ${[['all', 'seed + generiert'], ['seed', 'nur seed'], ['custom', 'nur generiert']].map(([v, l]) => `<span class="pill clickable ${f.source === v ? 'on' : ''}" data-src="${v}">${l}</span>`).join('')}
      </div>
      <div class="row">
        <input type="text" id="f-search" placeholder="Thema / Stichwort (z. B. Pauwels, Schatzker, Pilon)" value="${esc(f.search)}" style="max-width:360px">
        <select id="f-count" style="width:110px">${[10, 20, 40, 80, 999].map((n) => `<option value="${n}" ${f.count == n ? 'selected' : ''}>${n === 999 ? 'alle' : n}</option>`).join('')}</select>
        <span class="meta" id="f-count-label">${count} ITEMS</span>
        ${extra}
      </div>`;
    const update = () => { $('#f-count-label').textContent = `${filterItems(f).length} ITEMS`; Store.saveState(); onChange(f); };
    container.querySelector('#f-regions').onclick = (e) => { const p = e.target.closest('.pill'); if (!p) return; const r = p.dataset.r; f.regions = f.regions.includes(r) ? f.regions.filter((x) => x !== r) : f.regions.concat(r); p.classList.toggle('on'); update(); };
    container.querySelector('#f-types').onclick = (e) => {
      const p = e.target.closest('.pill'); if (!p) return;
      if (p.dataset.t) { const t = p.dataset.t; f.types = f.types.includes(t) ? f.types.filter((x) => x !== t) : f.types.concat(t); p.classList.toggle('on'); }
      if (p.dataset.only) { f.only = p.dataset.only; container.querySelectorAll('[data-only]').forEach((x) => x.classList.toggle('on', x.dataset.only === f.only)); }
      if (p.dataset.src) { f.source = p.dataset.src; container.querySelectorAll('[data-src]').forEach((x) => x.classList.toggle('on', x.dataset.src === f.source)); }
      update();
    };
    container.querySelector('#f-search').oninput = (e) => { f.search = e.target.value; update(); };
    container.querySelector('#f-count').onchange = (e) => { f.count = Number(e.target.value); state.settings.quizCount = f.count; update(); };
    return f;
  }
  async function generateMore(f, n = 15) {
    if (!requireKey()) return 0;
    const region = f.regions[0] || P.REGIONS[Math.floor(Math.random() * P.REGIONS.length)];
    const existing = filterItems({ regions: [region], search: f.search }).map((it) => it.q).slice(-120);
    const grounding = await groundingForRegion(region, 12000);
    const out = await chatJSON({ system: P.generateSystem(), messages: [{ role: 'user', content: P.generatePrompt(region, f.search, n, existing, grounding) }], schema: P.ITEMS_SCHEMA, name: 'items' });
    return addItems(out.items || [], `generiert ${region}`, []);
  }

  // ------------------------------------------------------------------ QUIZ
  function renderQuiz() {
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px">
        <span class="kicker">ABFRAGEMODUS · KLASSIFIKATIONEN · TERMINOLOGIE · KONZEPTE</span>
        <h1>Abfrage</h1>
        <p>Der Prüfer fragt, du antwortest gesprochen oder getippt, der Prüfer korrigiert in einem Satz und zeigt die Musterantwort. Falsche Items kommen schneller wieder.</p>
      </div>
      <div id="filters"></div>
      <div class="row" style="margin-top:18px"><button class="btn primary" id="btn-start">START</button><button class="btn" id="btn-gen">15 NEUE FRAGEN GENERIEREN</button></div>
      <div id="stage" style="margin-top:28px"></div>`;
    const f = filterBar($('#filters'), 'quiz', () => {});
    $('#btn-gen').onclick = async () => {
      const b = $('#btn-gen'); b.disabled = true; b.innerHTML = '<span class="spinner"></span> GENERIERE';
      try { const n = await generateMore(f); toast(`${n} neue Items gespeichert`); $('#f-count-label').textContent = `${filterItems(f).length} ITEMS`; }
      catch (error) { toast(error.message, true); }
      b.disabled = false; b.textContent = '15 NEUE FRAGEN GENERIEREN';
    };
    $('#btn-start').onclick = () => {
      if (!requireKey()) return;
      const items = pickSession(filterItems(f), f.count);
      if (!items.length) { toast('Keine Items für diese Auswahl.', true); return; }
      runQuiz(items, $('#stage'));
      $('#filters').hidden = true; $('#btn-start').parentElement.hidden = true;
    };
  }
  function runQuiz(items, stage) {
    let i = 0; const results = []; let phase = 'ask'; let busy = false;
    const requeue = [];
    function show() {
      const item = items[i];
      if (!item) return summary();
      const s = stats(item.id);
      stage.innerHTML = `
        <div class="quiz-head"><span class="meta">${i + 1}/${items.length} · ${esc(item.region)} · ${esc(item.type)}${s.seen ? ` · BOX ${s.box}` : ' · NEU'}</span><span class="meta">${results.filter((r) => r === 2).length} ✓ · ${results.filter((r) => r === 1).length} ~ · ${results.filter((r) => r === 0).length} ✗</span></div>
        <div class="meta">${esc(item.topic)}</div>
        <div class="quiz-q">${esc(item.q)}</div>
        <textarea class="answer" id="answer" placeholder="Antwort … Enter sendet, Shift+Enter neue Zeile"></textarea>
        <div class="answer-tools"><button class="btn rec" id="mic">● SPRECHEN</button><span class="spacer"></span><button class="btn ghost" id="btn-skip">WEISS ICH NICHT</button><button class="btn primary" id="btn-send">ANTWORTEN</button></div>
        <div id="verdict"></div>`;
      const ta = $('#answer'); ta.focus();
      wireMic($('#mic'), ta, () => { if (state.settings.readAloud) {} });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (phase === 'ask') $('#btn-send').click(); else next(); } });
      $('#btn-send').onclick = () => grade(ta.value.trim());
      $('#btn-skip').onclick = () => grade('');
      phase = 'ask';
    }
    async function grade(answer) {
      if (busy) return; busy = true;
      const item = items[i];
      $('#btn-send').disabled = true; $('#btn-skip').disabled = true;
      let result;
      if (!answer) result = { score: 0, urteil: 'Keine Antwort.', fehlend: [] };
      else {
        $('#verdict').innerHTML = '<div class="thinking" style="margin-top:14px"><span class="spinner"></span></div>';
        try { result = await chatJSON({ system: P.gradeSystem(state.settings), messages: [{ role: 'user', content: P.gradePrompt(item, answer) }], schema: P.GRADE_SCHEMA, name: 'korrektur' }); }
        catch (error) { $('#verdict').innerHTML = `<p class="warn">${esc(error.message)}</p>`; $('#btn-send').disabled = false; $('#btn-skip').disabled = false; busy = false; return; }
      }
      const score = Math.max(0, Math.min(2, Number(result.score) || 0));
      results.push(score); schedule(item.id, score); bump('quiz'); if (score === 2) bump('quizRight');
      if (score === 0 && !requeue.includes(item.id) && items.length < 60) { requeue.push(item.id); items.push(item); }
      $('#verdict').innerHTML = `
        <div class="verdict s${score}">
          <span class="label ${score === 2 ? 'ok' : score === 1 ? 'signal' : 'warn'}">${score === 2 ? 'KORREKT' : score === 1 ? 'TEILWEISE' : 'FALSCH'}</span>
          <div class="model">${esc(item.a)}</div>
          <div class="judge">${esc(result.urteil || '')}${result.fehlend?.length ? ` · fehlt: ${esc(result.fehlend.join(', '))}` : ''}</div>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="btn-next">WEITER <span class="kbd">↵</span></button><button class="btn ghost small" id="btn-fix" title="Musterantwort ist falsch oder unpassend">ITEM MELDEN</button></div>
        </div>`;
      phase = 'show'; busy = false;
      $('#btn-next').onclick = next; $('#btn-next').focus();
      $('#btn-fix').onclick = () => { const s = stats(item.id); s.flag = !s.flag; state.items[item.id] = s; Store.saveState(); toast(s.flag ? 'Markiert · erscheint unter STATUS' : 'Markierung entfernt'); };
      if (state.settings.readAloud) readAloud(item.a);
    }
    function next() { i += 1; show(); }
    function summary() {
      const n = results.length; const pts = results.reduce((a, b) => a + b, 0);
      stage.innerHTML = `
        <span class="kicker">SESSION BEENDET</span>
        <div class="row" style="gap:24px"><div class="big-grade">${n ? Math.round(100 * pts / (2 * n)) : 0}%</div><div class="meta">${n} FRAGEN · ${results.filter((r) => r === 2).length} KORREKT · ${results.filter((r) => r === 1).length} TEILWEISE · ${results.filter((r) => r === 0).length} FALSCH</div></div>
        <div class="row" style="margin-top:22px"><button class="btn primary" id="again">NOCHMALS</button><button class="btn" id="to-status">STATUS</button></div>`;
      $('#again').onclick = () => navigate(); $('#to-status').onclick = () => { location.hash = '#status'; };
    }
    show();
  }

  // ------------------------------------------------------------------ LAZY
  function renderLazy() {
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px">
        <span class="kicker">LAZY MODE · KEIN TIPPEN · KEINE API</span>
        <h1>Lazy</h1>
        <p>Frage lesen (oder vorlesen lassen), Antwort im Kopf, <span class="kbd">Space</span> zeigt die Musterantwort, dann <span class="kbd">1</span> nicht gewusst · <span class="kbd">2</span> halb · <span class="kbd">3</span> gewusst.</p>
      </div>
      <div id="filters"></div>
      <div class="row" style="margin-top:18px"><button class="btn primary" id="btn-start">START</button><button class="btn ${state.settings.readAloud ? 'on' : ''}" id="btn-read">VORLESEN ${state.settings.readAloud ? 'AN' : 'AUS'}</button></div>
      <div id="stage" style="margin-top:28px"></div>`;
    const f = filterBar($('#filters'), 'lazy', () => {});
    $('#btn-read').onclick = (e) => { state.settings.readAloud = !state.settings.readAloud; Store.saveState(); e.target.classList.toggle('on'); e.target.textContent = `VORLESEN ${state.settings.readAloud ? 'AN' : 'AUS'}`; };
    $('#btn-start').onclick = () => {
      const items = pickSession(filterItems(f), f.count);
      if (!items.length) { toast('Keine Items für diese Auswahl.', true); return; }
      $('#filters').hidden = true; $('#btn-start').parentElement.hidden = true;
      runLazy(items, $('#stage'));
    };
  }
  function runLazy(items, stage) {
    let i = 0; let revealed = false; const results = [];
    function show() {
      const item = items[i]; if (!item) return summary();
      revealed = false;
      stage.innerHTML = `
        <div class="quiz-head"><span class="meta">${i + 1}/${items.length} · ${esc(item.region)} · ${esc(item.type)}</span><span class="meta">${results.filter((r) => r === 2).length} ✓ · ${results.filter((r) => r === 1).length} ~ · ${results.filter((r) => r === 0).length} ✗</span></div>
        <div class="meta">${esc(item.topic)}</div>
        <div class="quiz-q">${esc(item.q)}</div>
        <div id="a"><button class="btn" id="btn-reveal">ANTWORT ZEIGEN <span class="kbd">Space</span></button></div>`;
      $('#btn-reveal').onclick = reveal;
      if (state.settings.readAloud) readAloud(item.q);
    }
    function reveal() {
      if (revealed) return; revealed = true;
      const item = items[i];
      $('#a').innerHTML = `<div class="lazy-a">${esc(item.a)}</div>
        <div class="rate"><button class="btn danger" data-s="0">NICHT GEWUSST <span class="kbd">1</span></button><button class="btn" data-s="1">HALB <span class="kbd">2</span></button><button class="btn on" data-s="2">GEWUSST <span class="kbd">3</span></button></div>`;
      $('#a').querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => rate(Number(b.dataset.s)); });
      if (state.settings.readAloud) readAloud(item.a);
    }
    function rate(score) { const item = items[i]; results.push(score); schedule(item.id, score); bump('lazy'); i += 1; show(); }
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === ' ') { e.preventDefault(); reveal(); }
      if (revealed && ['1', '2', '3'].includes(e.key)) rate(Number(e.key) - 1);
    }
    document.addEventListener('keydown', onKey);
    currentCleanup = () => document.removeEventListener('keydown', onKey);
    function summary() {
      document.removeEventListener('keydown', onKey);
      const n = results.length; const pts = results.reduce((a, b) => a + b, 0);
      stage.innerHTML = `<span class="kicker">FERTIG</span><div class="row" style="gap:24px"><div class="big-grade">${n ? Math.round(100 * pts / (2 * n)) : 0}%</div><div class="meta">${n} KARTEN</div></div><div class="row" style="margin-top:22px"><button class="btn primary" id="again">NOCHMALS</button></div>`;
      $('#again').onclick = () => navigate();
    }
    show();
  }

  // ------------------------------------------------------------------ FREE
  function renderFree() {
    const regionOptions = ['', ...P.REGIONS].map((r) => `<option value="${esc(r)}">${r ? esc(r) : 'kein Bezug'}</option>`).join('');
    const caseOptions = ['', ...CASES.map((c) => c.id)].map((id) => `<option value="${id}">${id ? esc(`${id.toUpperCase()} · ${caseById(id).title}`) : 'kein Fall'}</option>`).join('');
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px">
        <span class="kicker">FREIER MODUS</span>
        <h1>Frei</h1>
        <p>Sag dem Prüfer, was du willst: abfragen lassen, einen Begriff erklären, eine Station simulieren, deine Antwort korrigieren.</p>
      </div>
      <div class="row" style="margin-bottom:12px"><select id="free-region" style="max-width:260px">${regionOptions}</select><select id="free-case" style="max-width:420px">${caseOptions}</select><button class="btn ghost small" id="free-reset">NEUES GESPRÄCH</button></div>
      <div class="quick" id="quick">
        <span class="pill clickable" data-q="Frag mich 10 Klassifikationen aus dieser Region ab, eine nach der anderen.">10 KLASSIFIKATIONEN</span>
        <span class="pill clickable" data-q="Frag mich 10 Begriffe ab: 'Was ist ein/eine ...?' – eine Frage pro Zug.">10 BEGRIFFE</span>
        <span class="pill clickable" data-q="Simuliere die Station 'Therapeutische Optionen, Indikation, Risiken, Aufklärung' zu diesem Fall. Stelle die Eröffnungsfrage.">STATION THERAPIE</span>
        <span class="pill clickable" data-q="Erkläre mir die wichtigsten AO-Grundprinzipien zu diesem Thema (absolute vs. relative Stabilität, Implantatwahl), dann prüfe mich.">AO-PRINZIPIEN</span>
        <span class="pill clickable" data-q="Gib mir die Zahlen und Grenzwerte dieser Region als Liste, dann frag mich 5 davon ab.">ZAHLEN & GRENZWERTE</span>
      </div>
      <div class="chat" id="chat"></div>
      <div class="answer-box">
        <textarea class="answer" id="answer" placeholder="Nachricht … ⌘/Ctrl+Enter sendet"></textarea>
        <div class="answer-tools"><button class="btn rec" id="mic">● SPRECHEN</button><span class="spacer"></span><button class="btn primary" id="btn-send">SENDEN</button></div>
      </div>`;
    const chat = $('#chat'); const ta = $('#answer'); let messages = []; let busy = false;
    wireMic($('#mic'), ta);
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#btn-send').click(); } });
    $('#quick').onclick = (e) => { const p = e.target.closest('.pill'); if (p) { ta.value = p.dataset.q; ta.focus(); } };
    $('#free-reset').onclick = () => { messages = []; chat.innerHTML = ''; };
    function add(role, text) {
      const div = document.createElement('div'); div.className = `msg ${role}`;
      div.innerHTML = `<div class="who">${role === 'examiner' ? 'PRÜFER' : 'DU'}</div><div class="body"></div>`;
      div.querySelector('.body').textContent = text; chat.appendChild(div); return div.querySelector('.body');
    }
    $('#btn-send').onclick = async () => {
      const text = ta.value.trim(); if (!text || busy || !requireKey()) return;
      busy = true; ta.value = ''; add('candidate', text); messages.push({ role: 'user', content: text });
      const body = add('examiner', ''); body.innerHTML = '<span class="spinner"></span>';
      try {
        const region = $('#free-region').value; const cid = $('#free-case').value;
        let grounding = '';
        if (cid) grounding = await groundingForCase(caseById(cid), 12000);
        else if (region) grounding = await groundingForRegion(region, 12000);
        const full = await chatStream({ system: P.freeSystem(state.settings, grounding), messages, onDelta: (t) => { body.textContent = t; } });
        body.textContent = full; messages.push({ role: 'assistant', content: full });
        if (state.settings.examinerVoice) speak(full.slice(0, 600));
      } catch (error) { body.innerHTML = `<span class="warn">${esc(error.message)}</span>`; }
      busy = false; ta.focus(); body.scrollIntoView({ block: 'nearest' });
    };
  }

  // ------------------------------------------------------------------ MATERIAL
  let pdfjsPromise = null; let jszipPromise = null;
  const PDFJS_SOURCES = [
    ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs'],
    ['https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'],
  ];
  const JSZIP_SOURCES = ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'];
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        let lastError = null;
        for (const [lib, worker] of PDFJS_SOURCES) {
          try { const mod = await import(lib); mod.GlobalWorkerOptions.workerSrc = worker; return mod; } catch (error) { lastError = error; }
        }
        pdfjsPromise = null;
        throw new Error(`pdf.js konnte nicht geladen werden (Internet?): ${lastError?.message || ''}`);
      })();
    }
    return pdfjsPromise;
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`load failed ${src}`)); document.head.appendChild(s); });
  }
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!jszipPromise) {
      jszipPromise = (async () => {
        for (const src of JSZIP_SOURCES) { try { await loadScript(src); if (window.JSZip) return window.JSZip; } catch { /* next source */ } }
        jszipPromise = null;
        throw new Error('JSZip konnte nicht geladen werden (Internet?)');
      })();
    }
    return jszipPromise;
  }
  function xmlText(xml, tag) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagNameNS('*', tag)).map((n) => n.textContent).join(' ');
  }
  async function extractPptx(file, progress) {
    const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(file);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const out = [];
    for (const [idx, name] of slides.entries()) {
      const num = name.match(/\d+/)[0];
      const xml = await zip.file(name).async('string');
      const paras = Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('*', 'p')).map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).filter((t) => t.trim());
      const notes = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
      if (notes) { const t = xmlText(await notes.async('string'), 't').trim(); if (t && !/^\d+$/.test(t)) paras.push(`[Notiz] ${t}`); }
      if (paras.length) out.push(`--- Folie ${num} ---\n${paras.join('\n')}`);
      progress(`Folie ${idx + 1}/${slides.length}`);
    }
    return out.join('\n');
  }
  async function extractDocx(file) {
    const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(file);
    const xml = await zip.file('word/document.xml').async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagNameNS('*', 'p')).map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).filter((t) => t.trim()).join('\n');
  }
  async function ocrPages(images) {
    const content = [{ type: 'text', text: P.ocrPrompt() }].concat(images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })));
    const res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody(state.settings.model, { messages: [{ role: 'user', content }] })) });
    const data = await res.json(); return data.choices?.[0]?.message?.content || '';
  }
  async function extractPdf(file, progress) {
    const pdfjs = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = []; let ocrQueue = []; let ocrCount = 0;
    const flushOcr = async () => { if (!ocrQueue.length) return; const text = await ocrPages(ocrQueue.map((q) => q.url)); out.push(`--- OCR Seiten ${ocrQueue[0].n}–${ocrQueue[ocrQueue.length - 1].n} ---\n${text}`); ocrCount += ocrQueue.length; ocrQueue = []; };
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 40) out.push(`--- Seite ${n} ---\n${text}`);
      else if (state.settings.apiKey) {
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        ocrQueue.push({ n, url: canvas.toDataURL('image/jpeg', 0.72) });
        if (ocrQueue.length >= 3) await flushOcr();
      }
      progress(`Seite ${n}/${pdf.numPages}${ocrCount ? ` · ${ocrCount} per OCR` : ''}`);
    }
    await flushOcr();
    return out.join('\n');
  }
  function chunkText(text, size = 7000) {
    const chunks = []; let i = 0;
    while (i < text.length) { let end = Math.min(text.length, i + size); const cut = text.lastIndexOf('\n', end); if (cut > i + size * 0.6) end = cut; chunks.push(text.slice(i, end)); i = end; }
    return chunks;
  }
  function renderMaterial() {
    const builtin = Object.entries(CORPUS).map(([cid, entries]) => ({ cid, entries }));
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px">
        <span class="kicker">MATERIAL · DUMP PAD</span>
        <h1>Material</h1>
        <p>PDF, PPTX, DOCX, TXT in beliebiger Grösse ablegen. Der Text wird lokal extrahiert (gescannte PDF-Seiten per OCR), gespeichert, den Fällen zugeordnet und in neue Abfrage-Items verwandelt. Die Items landen in ABFRAGE und LAZY, der Text fliesst in die Fallprüfungen ein.</p>
      </div>
      <div class="drop" id="drop">DATEIEN HIER ABLEGEN ODER KLICKEN<input type="file" id="file" multiple accept=".pdf,.pptx,.docx,.txt,.md" hidden></div>
      <div class="progress" id="progress"></div>
      <h2 style="margin-top:32px">Abgelegt</h2>
      <div class="table-wrap"><table class="table" id="mat-table"><thead><tr><th>Datei</th><th>Zeichen</th><th>Fälle</th><th>Items</th><th></th></tr></thead><tbody></tbody></table></div>
      <h2 style="margin-top:32px">Eingebaut: Präsentationen aus dem Fall-Tracker</h2>
      <p class="meta">${builtin.reduce((a, b) => a + b.entries.length, 0)} PRÄSENTATIONEN · ${builtin.length} FÄLLE · ${seedBank.length} SEED-ITEMS</p>
      <div class="table-wrap"><table class="table"><tbody>${builtin.map(({ cid, entries }) => `<tr><td class="num" style="text-align:left">${esc(cid.toUpperCase())}</td><td>${esc(caseById(cid)?.title || '')}</td><td class="muted">${entries.map((e) => esc(e.name)).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`;
    const drop = $('#drop'); const input = $('#file'); const progress = $('#progress');
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(Array.from(e.dataTransfer.files)); };
    input.onchange = () => { handleFiles(Array.from(input.files)); input.value = ''; };
    function table() {
      $('#mat-table tbody').innerHTML = materialsIndex.length ? materialsIndex.map((m) => {
        const items = customBank.filter((it) => it.source === `material ${m.id}`).length;
        return `<tr data-id="${m.id}"><td>${esc(m.name)}<br><span class="meta">${esc(m.status || '')}</span></td><td class="num">${(m.chars || 0).toLocaleString('de-CH')}</td><td class="muted">${(m.caseIds || []).map((id) => esc(id.toUpperCase())).join(', ') || '–'}</td><td class="num">${items}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn small" data-act="gen">ITEMS GENERIEREN</button> <button class="btn small ghost danger" data-act="del">LÖSCHEN</button></td></tr>`;
      }).join('') : '<tr><td colspan="5" class="muted">Noch nichts abgelegt.</td></tr>';
    }
    table();
    $('#mat-table').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return; const id = b.closest('tr').dataset.id;
      if (b.dataset.act === 'del') { if (confirm('Material und seine generierten Items löschen?')) { await Store.deleteMaterial(id); customBank = customBank.filter((it) => it.source !== `material ${id}`); await Store.saveBank(); table(); } }
      if (b.dataset.act === 'gen') { b.disabled = true; await generateFromMaterial(id, (t) => { progress.textContent = t; }); b.disabled = false; table(); }
    };
    async function handleFiles(files) {
      for (const file of files) {
        const id = `m${uid()}`; const ext = file.name.toLowerCase().split('.').pop();
        progress.textContent = `${file.name} · lese …`;
        try {
          let text = '';
          const report = (t) => { progress.textContent = `${file.name} · ${t}`; };
          if (ext === 'pdf') text = await extractPdf(file, report);
          else if (ext === 'pptx') text = await extractPptx(file, report);
          else if (ext === 'docx') text = await extractDocx(file);
          else text = await file.text();
          text = text.replace(/[ \t]+/g, ' ').trim();
          if (!text) throw new Error('kein Text gefunden');
          const material = { id, name: file.name, kind: ext, chars: text.length, addedAt: Date.now(), caseIds: [], regions: [], status: 'extrahiert', text };
          Store.uploadFile(file);
          if (state.settings.apiKey) {
            report('ordne Fällen zu …');
            try { const tags = await chatJSON({ system: 'Du ordnest Lernmaterial Prüfungsfällen zu. Antworte nur mit JSON.', messages: [{ role: 'user', content: P.tagPrompt(material, text.slice(0, 5000), CASES) }], schema: P.TAG_SCHEMA, name: 'zuordnung' }); material.caseIds = (tags.caseIds || []).filter((x) => caseById(x)); material.regions = (tags.regions || []).filter((r) => P.REGIONS.includes(r)); } catch { /* tagging is optional */ }
          }
          await Store.putMaterial(material);
          table();
          progress.textContent = `${file.name} · gespeichert (${text.length.toLocaleString('de-CH')} Zeichen)`;
          if (state.settings.apiKey) await generateFromMaterial(id, (t) => { progress.textContent = t; });
          table();
        } catch (error) { progress.textContent = `${file.name} · Fehler: ${error.message}`; toast(error.message, true); }
      }
    }
  }
  async function generateFromMaterial(id, report) {
    if (!requireKey()) return 0;
    const material = await Store.getMaterial(id); if (!material?.text) return 0;
    const chunks = chunkText(material.text); let total = 0;
    for (const [i, chunk] of chunks.entries()) {
      report(`${material.name} · Items aus Abschnitt ${i + 1}/${chunks.length} … (${total} bisher)`);
      try {
        const out = await chatJSON({ system: P.extractSystem(), messages: [{ role: 'user', content: P.extractPrompt(material, chunk, i, chunks.length) }], schema: P.ITEMS_SCHEMA, name: 'items' });
        const items = (out.items || []).map((it) => ({ ...it, region: material.regions?.length && !P.REGIONS.includes(it.region) ? material.regions[0] : it.region }));
        total += await addItems(items, `material ${id}`, material.caseIds || []);
      } catch (error) { report(`${material.name} · Abschnitt ${i + 1}: ${error.message}`); await sleep(1500); }
    }
    material.status = `${total} Items generiert · ${new Date().toLocaleDateString('de-CH')}`;
    delete material.items;
    await Store.putMaterial(material);
    report(`${material.name} · ${total} neue Items`);
    return total;
  }

  // ------------------------------------------------------------------ STATUS
  function renderStatus() {
    const items = allItems();
    const regionRows = P.REGIONS.map((r) => {
      const its = items.filter((it) => it.region === r);
      const seen = its.filter((it) => stats(it.id).seen);
      const acc = seen.length ? seen.reduce((a, it) => a + (accuracy(it.id) ?? 0), 0) / seen.length : null;
      const due = its.filter((it) => { const s = stats(it.id); return s.seen && s.due <= Date.now(); }).length;
      const cases = CASES.filter((c) => (P.CASE_REGION_TO_DRILL[c.region] || [])[0] === r);
      const grades = cases.map((c) => caseSummary(c.id).mean).filter((g) => g != null);
      const mean = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;
      return { r, total: its.length, seen: seen.length, acc, due, exams: grades.length, cases: cases.length, mean };
    });
    const weakItems = items.filter((it) => stats(it.id).seen).map((it) => ({ it, acc: accuracy(it.id) })).sort((a, b) => a.acc - b.acc).slice(0, 15);
    const flagged = items.filter((it) => stats(it.id).flag);
    const days = []; for (let i = 13; i >= 0; i -= 1) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push({ d, ...(state.daily[d] || {}) }); }
    const max = Math.max(1, ...days.map((d) => (d.quiz || 0) + (d.lazy || 0) + (d.exam || 0) * 10));
    const t = state.daily[today()] || {}; const todayN = (t.quiz || 0) + (t.lazy || 0) + (t.exam || 0) * 10;
    const examsTotal = Object.values(state.caseLog).reduce((a, l) => a + l.length, 0);
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px"><span class="kicker">STATUS · T−${daysLeft()} TAGE</span><h1>Status</h1></div>
      <div class="grid3">
        <div class="stat"><div class="v ${todayN >= state.settings.dailyGoal ? 'ok' : ''}">${todayN}<span class="muted" style="font-size:14px">/${state.settings.dailyGoal}</span></div><div class="k">heute (Fragen + 10 × Fälle)</div></div>
        <div class="stat"><div class="v">${items.filter((it) => { const s = stats(it.id); return s.seen && s.due <= Date.now(); }).length}</div><div class="k">Items fällig</div></div>
        <div class="stat"><div class="v">${examsTotal}</div><div class="k">Fallprüfungen · ${CASES.filter((c) => caseSummary(c.id).runs).length}/${CASES.length} Fälle</div></div>
      </div>
      <div class="days" title="letzte 14 Tage">${days.map((d) => `<span title="${d.d}: ${d.quiz || 0} Abfrage · ${d.lazy || 0} Lazy · ${d.exam || 0} Fälle"><i style="height:${Math.round(100 * ((d.quiz || 0) + (d.lazy || 0) + (d.exam || 0) * 10) / max)}%"></i></span>`).join('')}</div>
      <hr class="sep">
      <h2>Nach Region</h2>
      <div class="table-wrap"><table class="table"><thead><tr><th>Region</th><th class="num">Items</th><th class="num">gesehen</th><th class="num">Trefferquote</th><th class="num">fällig</th><th class="num">Fälle geprüft</th><th class="num">Ø Note</th></tr></thead>
      <tbody>${regionRows.map((x) => `<tr><td>${esc(x.r)}<div class="bar"><span style="width:${x.total ? Math.round(100 * x.seen / x.total) : 0}%"></span></div></td><td class="num">${x.total}</td><td class="num">${x.seen}</td><td class="num ${x.acc == null ? 'faint' : x.acc < 0.6 ? 'warn' : x.acc < 0.8 ? 'signal' : 'ok'}">${x.acc == null ? '–' : `${Math.round(x.acc * 100)}%`}</td><td class="num">${x.due}</td><td class="num">${x.exams}/${x.cases}</td><td class="num ${gradeClass(x.mean)}">${fmtGrade(x.mean)}</td></tr>`).join('')}</tbody></table></div>
      <hr class="sep">
      <div class="grid2">
        <div><h2>Schwächste Items</h2>${weakItems.length ? `<ul class="clean">${weakItems.map(({ it, acc }) => `<li><span class="num ${acc < 0.5 ? 'warn' : 'signal'}">${Math.round(acc * 100)}%</span> &nbsp;${esc(it.q)}</li>`).join('')}</ul>` : '<p class="muted">Noch keine Daten.</p>'}</div>
        <div><h2>Schwächste Fälle</h2>${(() => { const g = CASES.filter((c) => caseSummary(c.id).mean != null).sort((a, b) => caseSummary(a.id).mean - caseSummary(b.id).mean).slice(0, 12); return g.length ? `<ul class="clean">${g.map((c) => `<li><span class="num ${gradeClass(caseSummary(c.id).mean)}">${fmtGrade(caseSummary(c.id).mean)}</span> &nbsp;<a href="#exam/${c.id}">${esc(c.title)}</a></li>`).join('')}</ul>` : '<p class="muted">Noch keine Fallprüfung.</p>'; })()}</div>
      </div>
      ${flagged.length ? `<hr class="sep"><h2>Gemeldete Items</h2><ul class="clean">${flagged.map((it) => `<li>${esc(it.q)} <span class="muted">→ ${esc(it.a)}</span> <button class="btn small ghost" data-unflag="${it.id}">OK</button></li>`).join('')}</ul>` : ''}
      <hr class="sep">
      <div class="row"><button class="btn" id="btn-export">EXPORT JSON</button><button class="btn" id="btn-import">IMPORT JSON</button><input type="file" id="import-file" accept=".json" hidden><span class="meta">${serverOk ? 'GESPEICHERT IN userdata/ (SERVER)' : 'GESPEICHERT IM BROWSER (localStorage) · server.py starten für Dateien auf dem Mac'}</span></div>`;
    view.onclick = (e) => { const b = e.target.closest('[data-unflag]'); if (b) { const s = stats(b.dataset.unflag); s.flag = false; state.items[b.dataset.unflag] = s; Store.saveState(); b.closest('li').remove(); } };
    $('#btn-export').onclick = async () => {
      const materials = []; for (const m of materialsIndex) { const full = await Store.getMaterial(m.id); if (full) materials.push(full); }
      const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), state, customBank, materials })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fmh-drill-${today()}.json`; a.click();
    };
    $('#btn-import').onclick = () => $('#import-file').click();
    $('#import-file').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.state) { state = { ...state, ...data.state, settings: { ...state.settings, ...data.state.settings, apiKey: state.settings.apiKey || data.state.settings?.apiKey || '' } }; }
        if (Array.isArray(data.customBank)) { const known = new Set(customBank.map((it) => it.id)); for (const it of data.customBank) if (!known.has(it.id)) customBank.push(it); }
        for (const m of data.materials || []) await Store.putMaterial(m);
        await Store.flush(); await Store.saveBank(); toast('Import fertig'); navigate();
      } catch (error) { toast(`Import: ${error.message}`, true); }
    };
  }

  // ------------------------------------------------------------------ SETTINGS
  function renderSettings() {
    const s = state.settings;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
    view.innerHTML = `
      <div class="hero" style="padding-bottom:20px"><span class="kicker">EINSTELLUNGEN</span><h1>Setup</h1><p>Der Schlüssel bleibt auf diesem Rechner (${serverOk ? 'drill/userdata/state.json' : 'Browser-Speicher'}). Aufrufe gehen direkt an api.openai.com.</p></div>
      <div class="grid2">
        <div>
          <div class="field"><span class="label">OpenAI API-Schlüssel</span><input type="password" id="s-key" value="${esc(s.apiKey)}" placeholder="sk-…"><span class="hint">platform.openai.com → API keys. Nichts davon landet im Repo.</span></div>
          <div class="field"><span class="label">Modell (Prüfer, Korrektur, Items)</span><input type="text" id="s-model" value="${esc(s.model)}" list="models"><datalist id="models"></datalist><span class="hint">Empfohlen: gpt-5.1 (oder gpt-5, gpt-4.1). <button class="btn small ghost" id="s-load-models">VERFÜGBARE MODELLE LADEN</button></span></div>
          <div class="field"><span class="label">Denkaufwand (nur gpt-5 / o-Modelle)</span><select id="s-reasoning">${opt([['none', 'none (schnellste, nur gpt-5.1+)'], ['minimal', 'minimal'], ['low', 'low (empfohlen)'], ['medium', 'medium'], ['default', 'Standard des Modells']], s.reasoning)}</select></div>
          <div class="field"><span class="label">Transkription</span><input type="text" id="s-stt" value="${esc(s.transcribeModel)}"><span class="hint">gpt-4o-transcribe, gpt-4o-mini-transcribe oder whisper-1</span></div>
          <div class="field"><span class="label">Prüfer-Stimme</span><div class="row"><input type="text" id="s-tts" value="${esc(s.ttsModel)}" style="max-width:220px"><select id="s-voice" style="max-width:140px">${opt([['onyx', 'onyx'], ['alloy', 'alloy'], ['ash', 'ash'], ['echo', 'echo'], ['fable', 'fable'], ['nova', 'nova'], ['sage', 'sage'], ['shimmer', 'shimmer']], s.ttsVoice)}</select></div>
            <label class="check"><input type="checkbox" id="s-voice-on" ${s.examinerVoice ? 'checked' : ''}> Prüfer liest seine Fragen vor (Prüfung & Frei)</label></div>
        </div>
        <div>
          <div class="field"><span class="label">Prüfungssprache</span><select id="s-lang">${opt([['de', 'Deutsch'], ['en', 'English']], s.lang)}</select></div>
          <div class="field"><span class="label">Strenge</span><select id="s-strict">${opt([['mild', 'mild'], ['standard', 'standard'], ['hart', 'hart']], s.strictness)}</select></div>
          <div class="field"><span class="label">Nachfragen pro Station (Prüfung)</span><select id="s-followups">${opt([['0', '0 · nur die 5 Eröffnungsfragen'], ['1', '1 · 10 Fragen pro Fall'], ['2', '2 · 15 Fragen pro Fall'], ['3', '3 · 20 Fragen pro Fall']], String(s.followups))}</select></div>
          <div class="field"><span class="label">Tagesziel (Fragen + 10 × Fälle)</span><input type="number" id="s-goal" value="${s.dailyGoal}" min="5" max="500"></div>
          <div class="field"><span class="label">Zusätzliche Anweisung an den Prüfer</span><textarea id="s-custom" placeholder="z. B. 'Frag besonders nach Zugängen und Implantaten.' oder 'Benutze Schweizer Begriffe.'">${esc(s.custom)}</textarea></div>
        </div>
      </div>
      <div class="row"><button class="btn primary" id="s-save">SPEICHERN</button><button class="btn" id="s-test">VERBINDUNG TESTEN</button><span class="meta" id="s-msg"></span></div>`;
    const read = () => {
      s.apiKey = $('#s-key').value.trim(); s.model = $('#s-model').value.trim() || 'gpt-5.1'; s.reasoning = $('#s-reasoning').value; s.transcribeModel = $('#s-stt').value.trim() || 'gpt-4o-transcribe';
      s.ttsModel = $('#s-tts').value.trim() || 'gpt-4o-mini-tts'; s.ttsVoice = $('#s-voice').value; s.examinerVoice = $('#s-voice-on').checked; s.lang = $('#s-lang').value; s.strictness = $('#s-strict').value;
      s.followups = Number($('#s-followups').value); s.dailyGoal = Number($('#s-goal').value) || 30; s.custom = $('#s-custom').value.trim();
    };
    $('#s-save').onclick = async () => { read(); await Store.flush(); toast('Gespeichert'); footer(); };
    $('#s-load-models').onclick = async (e) => {
      e.preventDefault(); read(); if (!s.apiKey) return toast('Zuerst Schlüssel eintragen', true);
      try { const res = await openaiFetch('/models', {}); const data = await res.json(); const ids = data.data.map((m) => m.id).filter((id) => /^(gpt|o[1-9])/.test(id)).sort(); $('#models').innerHTML = ids.map((id) => `<option value="${id}">`).join(''); $('#s-msg').textContent = `${ids.length} MODELLE GELADEN · TIPPE IM FELD`; }
      catch (error) { toast(error.message, true); }
    };
    $('#s-test').onclick = async () => {
      read(); await Store.flush(); $('#s-msg').innerHTML = '<span class="spinner"></span>';
      try { const out = await chatJSON({ system: 'Antworte mit JSON.', messages: [{ role: 'user', content: 'Gib {"ok": true, "modell": "<dein Modellname>"} zurück.' }], schema: { type: 'object', additionalProperties: false, required: ['ok', 'modell'], properties: { ok: { type: 'boolean' }, modell: { type: 'string' } } }, name: 'ping' }); $('#s-msg').textContent = `OK · ${out.modell || s.model}`; footer(); }
      catch (error) { $('#s-msg').textContent = ''; toast(error.message, true); }
    };
  }

  // ------------------------------------------------------------------ boot
  function footer() {
    $('#storage-note').textContent = serverOk ? 'USERDATA/ AUF DIESEM RECHNER' : 'BROWSER-SPEICHER · server.py starten für Dateien';
    $('#model-note').textContent = state.settings.apiKey ? `${state.settings.model.toUpperCase()} · ${state.settings.lang.toUpperCase()} · ${state.settings.strictness.toUpperCase()}` : 'KEIN API-SCHLÜSSEL · ⚙';
    $('#countdown').textContent = `PRÜFUNG 21 NOV 2026 · T−${daysLeft()}`;
  }
  const VIEWS = { exam: renderExam, quiz: renderQuiz, lazy: renderLazy, free: renderFree, material: renderMaterial, status: renderStatus, settings: renderSettings };
  (async () => {
    buildSeed();
    await Store.init();
    footer();
    if (!state.settings.apiKey && !location.hash) location.hash = '#settings';
    navigate();
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
  })();
})();
