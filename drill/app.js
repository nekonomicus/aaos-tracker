/* FMH DRILL · app.js
   Six modes on one drill bank and one case list: PRÜFUNG (case exam), ABFRAGE (graded quiz),
   LAZY (flashcards), FREI (free prompt), MATERIAL (dump pad → new drills), STATUS.
   Progress is saved through server.py to ./userdata on this machine, or to localStorage
   when opened without the server. */
(function () {
  'use strict';

  const P = window.PROMPTS;
  const CASES = window.CASES;
  const CORPUS = window.CORPUS || {};
  const IMAGES = window.IMAGES || [];
  const BUILD = '2026-10-18 LIVE'; // shown in the footer, so a stale tab or an old checkout is obvious
  const EXAM_DATE = new Date('2026-11-21T15:00:00+01:00');
  const OPENAI = 'https://api.openai.com/v1';
  const INTERVALS = [0, 1, 3, 7, 14, 30]; // days per Leitner box
  const MODEL_PREFERENCE = ['gpt-6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1'];
  const MODEL_EXCLUDE = /mini|nano|codex|realtime|audio|transcribe|tts|search|pro|chat|preview|instruct|image/i;
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
    apiKey: '', model: 'auto', resolvedModel: '', effort: 'ausgewogen', transcribeModel: 'gpt-4o-transcribe', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'onyx',
    examinerVoice: false, lang: 'de', strictness: 'hart', followups: 1, custom: '', dailyGoal: 30, readAloud: false, quizCount: 20, images: true, webImages: true, googleKey: '', googleCx: '',
    factCheck: true, githubToken: '', fmhRepo: 'nekonomicus/fmh-oral-files',
    live: true, realtimeModel: 'auto', resolvedRealtimeModel: '', realtimeVoice: 'cedar', eagerness: 'low',
  };
  let state = { version: 2, settings: { ...DEFAULT_SETTINGS }, items: {}, caseLog: {}, daily: {}, lastFilters: {} };
  let customBank = [];
  let materialsIndex = [];
  let serverOk = false;
  let seedBank = [];
  let imageBank = [];

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
    saveState() { clearTimeout(this._timer); this._timer = setTimeout(() => this.flush(), 400); },
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
    async getSession(id) {
      if (serverOk) return fetch(`/api/sessions/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return JSON.parse(localStorage.getItem(`fmhdrill.session.${id}`) || 'null');
    },
    async listSessions() {
      if (serverOk) return fetch('/api/sessions').then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const out = [];
      for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (k && k.startsWith('fmhdrill.session.')) { try { const x = JSON.parse(localStorage.getItem(k)); if (x) { const { messages, dossier, discussion, ...rest } = x; out.push(rest); } } catch { /* skip */ } } }
      return out;
    },
    async putSession(session) {
      if (serverOk) await fetch(`/api/sessions/${session.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session) });
      else { try { localStorage.setItem(`fmhdrill.session.${session.id}`, JSON.stringify(session)); } catch { /* grade is kept in state */ } }
    },
    async uploadFile(file, name) {
      if (!serverOk) return null;
      try { const r = await fetch(`/api/files?name=${encodeURIComponent(name || file.name)}`, { method: 'POST', body: file }); const d = await r.json(); return d.stored ? `userdata/files/${d.stored}` : null; } catch { return null; }
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
  function bump(key, n = 1) { const d = state.daily[today()] || (state.daily[today()] = {}); d[key] = (d[key] || 0) + n; Store.saveState(); }
  function requireKey() {
    if (state.settings.apiKey) return true;
    toast('Zuerst den OpenAI API-Schlüssel unter ⚙ eintragen.', true); location.hash = '#settings'; return false;
  }
  const lightbox = $('#lightbox');
  lightbox.onclick = () => { lightbox.hidden = true; };
  document.addEventListener('click', (e) => { const img = e.target.closest('img[data-zoom]'); if (img) { lightbox.querySelector('img').src = img.src; lightbox.hidden = false; } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lightbox.hidden) lightbox.hidden = true; });

  // ------------------------------------------------------------------ openai
  function activeModel() {
    const s = state.settings;
    if (s.model && s.model !== 'auto') return s.model;
    return s.resolvedModel || 'gpt-5.1';
  }
  function isReasoningModel(model) { return /^(gpt-[5-9]|o[1-9])/i.test(model || ''); }
  function effortFor(heavy) {
    const map = { schnell: ['low', 'low'], ausgewogen: ['low', 'medium'], gründlich: ['medium', 'high'] };
    const pair = map[state.settings.effort] || map.ausgewogen;
    return heavy ? pair[1] : pair[0];
  }
  function baseBody(model, heavy, extra = {}) {
    const body = { model, ...extra };
    if (isReasoningModel(model)) body.reasoning_effort = effortFor(heavy);
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
  function withImages(messages, images) {
    if (!images?.length) return messages;
    const msgs = messages.slice(); const last = { ...msgs[msgs.length - 1] };
    last.content = [{ type: 'text', text: last.content }].concat(images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })));
    msgs[msgs.length - 1] = last; return msgs;
  }
  async function chatJSON({ system, messages, schema, name, heavy = false, images = null }) {
    const model = activeModel();
    const msgs = [{ role: 'system', content: system }, ...withImages(messages, images)];
    const attempt = async (format, body) => {
      const res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, messages: msgs, response_format: format }) });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    };
    const body = baseBody(model, heavy);
    try {
      return await attempt({ type: 'json_schema', json_schema: { name, strict: true, schema } }, body);
    } catch (error) {
      if (/reasoning_effort|temperature|Unsupported parameter|unsupported_parameter|Unsupported value|unsupported_value/i.test(error.message) && (body.reasoning_effort || body.temperature !== undefined)) {
        delete body.reasoning_effort; delete body.temperature;
        return attempt({ type: 'json_schema', json_schema: { name, strict: true, schema } }, body);
      }
      if (/response_format|json_schema/i.test(error.message)) {
        msgs[0].content += '\nAntworte ausschliesslich mit gültigem JSON.';
        return attempt({ type: 'json_object' }, body);
      }
      throw error;
    }
  }
  async function chatStream({ system, messages, onDelta }) {
    const model = activeModel();
    const body = baseBody(model, false, { stream: true, messages: [{ role: 'system', content: system }, ...messages] });
    let res;
    try {
      res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      if (/reasoning_effort|temperature|Unsupported parameter|Unsupported value|unsupported_value/i.test(error.message) && (body.reasoning_effort || body.temperature !== undefined)) {
        delete body.reasoning_effort; delete body.temperature;
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
  async function resolveModel() {
    const res = await openaiFetch('/models', {}); const data = await res.json();
    const ids = data.data.map((m) => m.id);
    if (state.settings.model === 'auto') {
      state.settings.resolvedModel = '';
      for (const prefix of MODEL_PREFERENCE) {
        const hits = ids.filter((id) => (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`)) && !MODEL_EXCLUDE.test(id.slice(prefix.length)));
        if (hits.length) { state.settings.resolvedModel = hits.includes(prefix) ? prefix : hits.sort((a, b) => a.length - b.length)[0]; break; }
      }
      if (!state.settings.resolvedModel) state.settings.resolvedModel = 'gpt-5.1';
    }
    state.settings.resolvedRealtimeModel = pickRealtime(ids) || state.settings.resolvedRealtimeModel;
    return ids;
  }
  // newest full gpt-realtime of this key (2.1 › 2 › 1.5 › 1); never mini, whisper or dated duplicates
  function pickRealtime(ids) {
    const list = ids.map((id) => { const m = id.match(/^gpt-realtime(?:-(\d+(?:\.\d+)?))?(-\d{4}-\d{2}-\d{2})?$/); return m ? { id, v: Number(m[1] || 1), dated: m[2] ? 1 : 0 } : null; }).filter(Boolean);
    list.sort((a, b) => b.v - a.v || a.dated - b.dated || a.id.length - b.id.length);
    return list[0]?.id || '';
  }
  function realtimeModel() { const s = state.settings; return s.realtimeModel && s.realtimeModel !== 'auto' ? s.realtimeModel : (s.resolvedRealtimeModel || 'gpt-realtime'); }
  // session config of the live examiner, shared by PRÜFUNG and the live chat (FREI, NACHFRAGEN)
  function voiceSession({ instructions, tools = [], createResponse = false, maxTokens = 'inf', eagerness = null }) {
    const s = state.settings; const model = realtimeModel();
    const session = {
      type: 'realtime', model, instructions, output_modalities: ['audio'],
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: s.transcribeModel || 'gpt-4o-transcribe', language: s.lang === 'en' ? 'en' : 'de' }, // no prompt: it gets echoed as the transcript on short or noisy utterances
          turn_detection: { type: 'semantic_vad', eagerness: eagerness || s.eagerness || 'low', create_response: !!createResponse, interrupt_response: true },
        },
        output: { voice: s.realtimeVoice || 'cedar', speed: 1 },
      },
      max_output_tokens: maxTokens, truncation: 'auto',
    };
    if (tools.length) { session.tools = tools; session.tool_choice = 'auto'; }
    if (/^gpt-realtime-(?!\d{4}-)(?:[2-9]|\d{2})/.test(model)) session.reasoning = { effort: 'minimal' }; // reasoning models (2, 2.1 …), not the dated v1 snapshot: answer, don't ponder
    return session;
  }
  // read anything aloud on demand: the examiner's TTS voice with a key, the browser voice without
  const say = (text) => { if (!text) return; if (state.settings.apiKey) speak(text); else readAloud(text); };
  const sayHtml = (text) => `<button class="say" type="button" data-say="${esc(text)}" title="Vorlesen">▶</button>`;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-say]'); if (b) { e.preventDefault(); say(b.dataset.say); } });
  // VORLESEN AN/AUS: the examiner reads his lines automatically (text modes); one setting, a toggle in every mode
  function readToggle(id) {
    const b = document.createElement('button'); b.className = 'btn small ghost read-toggle'; b.type = 'button'; b.title = 'Prüfer liest seine Fragen und Antworten automatisch vor'; if (id) b.id = id;
    const paint = () => { b.textContent = `VORLESEN ${state.settings.examinerVoice ? 'AN' : 'AUS'}`; b.classList.toggle('on', !!state.settings.examinerVoice); };
    b.onclick = () => { state.settings.examinerVoice = !state.settings.examinerVoice; Store.saveState(); paint(); if (!state.settings.examinerVoice) { if (currentAudio) currentAudio.pause(); window.speechSynthesis?.cancel(); } };
    paint(); return b;
  }
  function looksLikeQuestion(t) { const x = String(t || '').trim(); if (!x) return false; const words = x.split(/\s+/).length; return words <= 30 && (/\?\s*$/.test(x) || /^(wie|was|welche[rsn]?|gibt es|ist|sind|hat|haben|kann ich|darf ich|könnte ich|zeigt|wo|wann|liegt|besteht|how|what|which|is|are|does|do|can i|may i)\b/i.test(x)); }
  function mentions(said, text) { if (!said || !text) return false; const a = norm(said); const words = [...new Set(norm(text).split(' ').filter((w) => w.length > 3))]; const hit = words.filter((w) => a.includes(w)).length; return words.length > 0 && hit >= Math.ceil(words.length * 0.6); }
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
      if (currentAudio) currentAudio.pause();
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
  const proxied = (url) => (serverOk && /^https?:/.test(url) ? `/api/fetch?url=${encodeURIComponent(url)}` : url);
  async function toDataUrl(src, maxSide = 1400) {
    const blob = await fetch(src).then((r) => { if (!r.ok) throw new Error(`Bild ${r.status}`); return r.blob(); });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
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
  function wireMic(button, textarea) {
    button.addEventListener('click', async () => {
      if (!requireKey()) return;
      if (!Recorder.active) {
        try { await Recorder.start(); button.classList.add('on'); button.textContent = '■ STOP'; }
        catch (error) { toast(`Mikrofon: ${error.message}`, true); }
        return;
      }
      button.classList.remove('on'); button.textContent = '…'; button.disabled = true;
      try {
        const blob = await Recorder.stop();
        const text = await transcribe(blob, Recorder.ext);
        textarea.value = (textarea.value ? `${textarea.value.trim()} ` : '') + text;
        textarea.dispatchEvent(new Event('input'));
      } catch (error) { toast(`Transkription: ${error.message}`, true); }
      button.disabled = false; button.textContent = '● SPRECHEN';
    });
  }

  // ------------------------------------------------------------------ bank
  function caseById(id) { return CASES.find((c) => c.id === id); }
  function regionOfCase(caseItem) { return (P.CASE_REGION_TO_DRILL[caseItem?.region] || [])[0] || 'Infekt, Tumor & Allgemein'; }
  function buildSeed() {
    seedBank = (window.SEED_BANK || []).map((it) => ({ ...it, id: `s-${hash(it.q)}`, source: 'seed' }));
    imageBank = IMAGES.map((img) => {
      const c = caseById(img.cases[0]);
      return { id: `img-${img.file.replace(/\W/g, '')}`, type: 'bild', kind: img.kind, region: regionOfCase(c), topic: c?.title || img.src, q: P.IMAGE_QUESTIONS[img.kind] || P.IMAGE_QUESTIONS.diagram, a: img.text || '', img: `data/img/${img.file}`, src: img.src, slide: img.slide, caseIds: img.cases, source: 'bild' };
    });
  }
  function userImages(caseId) { return ((state.caseImages || {})[caseId] || []); }
  function ownImages(caseItem) {
    return IMAGES.filter((i) => i.cases.includes(caseItem.id) && ['xray', 'ct', 'mri'].includes(i.kind)).map((i) => ({ src: `data/img/${i.file}`, credit: `${i.src} · Folie ${i.slide}`, note: i.text ? i.text.slice(0, 200) : '' }))
      .concat(userImages(caseItem.id).map((u) => ({ src: u.src, credit: u.credit, note: u.note || '' })));
  }
  function userImageItems() {
    const out = [];
    for (const [caseId, list] of Object.entries(state.caseImages || {})) for (const [k, u] of list.entries()) {
      const c = caseById(caseId);
      out.push({ id: `img-user-${caseId}-${k}`, type: 'bild', kind: 'xray', region: regionOfCase(c), topic: c?.title || caseId, q: P.IMAGE_QUESTIONS.xray, a: u.note || '', img: u.src, src: u.credit, slide: 0, caseIds: [caseId], source: 'bild' });
    }
    return out;
  }
  function allItems() { return seedBank.concat(customBank, state.settings.images ? imageBank.concat(userImageItems()) : []); }
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
  function filterItems(f, opts = {}) {
    const q = norm(f.search || '');
    return allItems().filter((it) => {
      if (opts.noImages && it.type === 'bild') return false;
      if (opts.lazy && it.type === 'bild' && it.a.length < 20) return false;
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
        region: P.REGIONS.includes(raw.region) ? raw.region : regionOfCase(caseById(caseIds?.[0])),
        topic: raw.thema || raw.topic || '', q, a, source, caseIds: caseIds || [], createdAt: Date.now(),
      });
      added += 1;
    }
    if (added) await Store.saveBank();
    return added;
  }

  // ------------------------------------------------------------- retrieval
  // Every source the examiner may use is split into short passages and indexed in the
  // browser: the FMH presentations (CORPUS), everything dumped into MATERIAL (PDFs, PPTX,
  // DOCX, TXT, the AAOS tracker export, synced presentations). Each model call retrieves
  // the passages that match its question of the moment, so the model goes back into the
  // sources at every step instead of relying on the case tagging alone.
  const STOP = new Set('der die das und oder ein eine einer eines einem einen ist sind war wird werden mit bei von vom zum zur für auf aus nach über unter durch den dem des als auch nicht nur noch dann wenn wie was wer wo dass sich ich sie er es wir ihr man kann können soll sollte muss müssen hat haben the and for with from this that are was were has have into onto which what when where patient patienten jahre jahr alt alte alter rechts links beidseits sowie bzw ggf etc'.split(' '));
  const Index = {
    chunks: [], df: new Map(), avg: 1, built: null, materialText: new Map(),
    tokens(text) {
      const out = [];
      for (const raw of norm(text).split(' ')) {
        if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
        // crude phonetic normalisation so German and English medical terms meet: Fraktur/fracture,
        // Klassifikation/classification, Myelopathie/myelopathy; then a 7-letter stem
        const w = raw.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss').replace(/ph/g, 'f').replace(/[kz]/g, 'c').replace(/y/g, 'i').replace(/th/g, 't');
        out.push(w.length > 7 ? w.slice(0, 7) : w);
      }
      return out;
    },
    split(text, size = 900) {
      const paras = String(text || '').split(/\n{2,}|\n(?=[A-ZÄÖÜ0-9][^\n]{0,60}\n)/).map((s) => s.trim()).filter(Boolean);
      const out = []; let cur = '';
      for (const para of paras) {
        if (cur && cur.length + para.length > size) { out.push(cur); cur = para.length > size * 1.6 ? '' : para; if (!cur) for (let i = 0; i < para.length; i += size) out.push(para.slice(i, i + size)); continue; }
        cur = cur ? `${cur}\n${para}` : para;
      }
      if (cur) out.push(cur);
      return out;
    },
    add(src, name, text, meta = {}) {
      for (const [i, t] of this.split(text).entries()) {
        const toks = this.tokens(t); const tf = new Map();
        for (const tok of toks) tf.set(tok, (tf.get(tok) || 0) + 1);
        this.chunks.push({ src, name, i, text: t, tf, len: toks.length, ...meta });
      }
    },
    async build() {
      this.chunks = []; this.df = new Map();
      for (const [cid, entries] of Object.entries(CORPUS)) for (const e of entries) this.add(`corpus:${cid}:${e.name}`, e.name, e.text, { caseId: cid, kind: 'präsentation' });
      await Promise.all(materialsIndex.map(async (m) => {
        if (!this.materialText.has(m.id)) { const full = await Store.getMaterial(m.id).catch(() => null); this.materialText.set(m.id, full?.text || ''); }
        this.add(`material:${m.id}`, m.name, this.materialText.get(m.id), { materialId: m.id, caseId: m.caseIds?.[0] || null, kind: m.kind === 'aaos' ? 'aaos' : m.kind === 'fmh' ? 'präsentation' : 'material' });
      }));
      for (const c of this.chunks) for (const tok of c.tf.keys()) this.df.set(tok, (this.df.get(tok) || 0) + 1);
      this.avg = this.chunks.reduce((a, c) => a + c.len, 0) / Math.max(1, this.chunks.length);
    },
    ready() { if (!this.built) this.built = this.build(); return this.built; },
    async rebuild() { this.built = null; return this.ready(); },
    forget(materialId) { this.materialText.delete(materialId); },
    async search(query, { k = 8, exclude = null, boost = null } = {}) {
      await this.ready();
      const q = this.tokens(query); if (!q.length || !this.chunks.length) return [];
      const N = this.chunks.length; const qtf = new Map(); for (const t of q) qtf.set(t, (qtf.get(t) || 0) + 1);
      const scored = [];
      for (const c of this.chunks) {
        if (exclude && exclude(c)) continue;
        let s = 0;
        for (const [t, qn] of qtf) {
          const f = c.tf.get(t); if (!f) continue;
          const idf = Math.log(1 + (N - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5));
          s += idf * Math.min(qn, 2) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.len / this.avg));
        }
        if (s > 0) scored.push([boost ? s * boost(c) : s, c]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      return scored.slice(0, k).map(([score, c]) => ({ ...c, score }));
    },
  };
  function sourceLabel(c) { return `${c.name} · Abschnitt ${c.i + 1}`; }
  function renderChunks(chunks, budget) {
    const parts = []; let used = 0;
    for (const c of chunks) {
      const block = `[Quelle: ${sourceLabel(c)}]\n${c.text}`;
      if (used + block.length > budget) { if (!parts.length) parts.push(block.slice(0, budget)); break; }
      parts.push(block); used += block.length + 2;
    }
    return parts.join('\n\n');
  }
  // search terms per case, generated once by the model (German + English, eponyms, classifications) and kept
  async function caseTerms(caseItem) {
    const cached = (state.caseTerms || {})[caseItem.id];
    if (cached?.terms?.length) return cached.terms;
    let terms = [];
    if (state.settings.apiKey) {
      try { const out = await chatJSON({ system: 'Du hilfst bei der Volltextsuche in orthopädischen Lernunterlagen. Antworte nur mit JSON.', messages: [{ role: 'user', content: P.caseTermsPrompt(caseItem) }], schema: P.TERMS_SCHEMA, name: 'suchbegriffe' }); terms = (out.terms || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 30); } catch { terms = []; }
    }
    if (terms.length) { (state.caseTerms = state.caseTerms || {})[caseItem.id] = { terms, t: Date.now() }; Store.saveState(); }
    return terms.length ? terms : norm(caseItem.title).split(' ').filter((w) => w.length > 3);
  }
  async function lookup(query, budget = 3500, opts = {}) {
    const hits = await Index.search(query, { k: opts.k || 6, exclude: opts.exclude, boost: opts.boost });
    return renderChunks(hits, budget);
  }

  // grounding and memory
  async function groundingForCase(caseItem, budget = 16000, extraQuery = '') {
    const parts = [];
    const own = (CORPUS[caseItem.id] || []).map((entry) => `[Quelle: ${entry.name} · Präsentation zu diesem Fall]\n${entry.text}`).join('\n\n');
    const ownBudget = Math.floor(budget * 0.4);
    if (own) parts.push(own.length > ownBudget ? `${own.slice(0, ownBudget)}\n[gekürzt]` : own);
    const terms = await caseTerms(caseItem);
    const query = `${caseItem.title} ${terms.join(' ')} ${extraQuery}`;
    const retrieved = await lookup(query, budget - parts.join('').length - 1200, { k: 14, exclude: (c) => c.src.startsWith(`corpus:${caseItem.id}:`), boost: (c) => (c.caseId === caseItem.id ? 1.5 : c.kind === 'aaos' ? 1.15 : 1) });
    if (retrieved) parts.push(retrieved);
    const region = regionOfCase(caseItem);
    const words = norm(caseItem.title).split(' ').filter((w) => w.length > 4);
    const bankLines = allItems().filter((it) => it.type !== 'bild' && ((it.caseIds || []).includes(caseItem.id) || (it.region === region && words.some((w) => norm(it.topic).includes(w))))).slice(0, 30).map((it) => `F: ${it.q} A: ${it.a}`);
    if (bankLines.length) parts.push(`[Quelle: Abfrage-Items des Kandidaten zum Thema]\n${bankLines.join('\n')}`);
    const text = parts.join('\n\n');
    return text.length > budget ? `${text.slice(0, budget)}\n[gekürzt]` : text;
  }
  async function groundingForRegion(region, budget = 14000, topic = '') {
    const cases = CASES.filter((c) => (P.CASE_REGION_TO_DRILL[c.region] || []).includes(region));
    const sample = shuffle(cases).slice(0, 12);
    const query = `${region} ${topic} ${sample.map((c) => c.title).join(' ')}`;
    const hits = await Index.search(query, { k: 40, boost: (c) => (c.caseId && cases.some((x) => x.id === c.caseId) ? 1.4 : 1) });
    return renderChunks(shuffle(hits.slice(0, 24)), budget); // rotate the passages so repeated generation sees different material
  }
  function memoryFor(caseItem, region) {
    const caseGaps = caseItem ? (state.caseLog[caseItem.id] || []).flatMap((l) => l.fehlend || []).slice(-8) : [];
    const r = region || (caseItem ? regionOfCase(caseItem) : null);
    const weakTopics = r ? [...new Set(allItems().filter((it) => it.region === r && stats(it.id).seen && (accuracy(it.id) ?? 1) < 0.6).sort((a, b) => (accuracy(a.id) ?? 0) - (accuracy(b.id) ?? 0)).map((it) => it.topic).filter(Boolean))].slice(0, 6) : [];
    return { caseGaps, weakTopics };
  }

  // ------------------------------------------------------------- profile
  // Strengths and weaknesses from everything the app has seen: quiz / lazy results per topic, case grades
  // and what was missing in the feedback, and what the conversations themselves revealed (distillThread).
  function profileSummary() {
    const byTopic = {};
    for (const it of allItems()) {
      const st = stats(it.id); if (!st.seen) continue;
      const key = it.topic || it.region; const h = st.hist || [];
      const t = byTopic[key] || (byTopic[key] = { n: 0, pts: 0, region: it.region });
      t.n += h.length; t.pts += h.reduce((a, b) => a + b, 0);
    }
    const topics = Object.entries(byTopic).map(([t, v]) => ({ t, acc: v.n ? v.pts / (2 * v.n) : 0, n: v.n, region: v.region }));
    const weakTopics = topics.filter((x) => x.n >= 2 && x.acc < 0.6).sort((a, b) => a.acc - b.acc).slice(0, 12);
    const strongTopics = topics.filter((x) => x.n >= 3 && x.acc >= 0.9).sort((a, b) => b.n - a.n).slice(0, 12);
    const cases = CASES.map((c) => ({ c, s: caseSummary(c.id) })).filter((x) => x.s.mean != null);
    const weakCases = cases.filter((x) => x.s.mean < 4.5).sort((a, b) => a.s.mean - b.s.mean).slice(0, 8);
    const strongCases = cases.filter((x) => x.s.mean >= 5).sort((a, b) => b.s.mean - a.s.mean).slice(0, 8);
    const fehlend = Object.values(state.caseLog).flat().flatMap((l) => l.fehlend || []).slice(-30);
    const log = (state.profile?.log || []).slice(-25);
    return { weakTopics, strongTopics, weakCases, strongCases, fehlend, threadWeak: log.flatMap((e) => e.schwaechen || []), threadStrong: log.flatMap((e) => e.staerken || []) };
  }
  // the weaknesses as a compact German list for the examiner (SCHWÄCHEN DRILLEN), optionally one region only
  function weaknessText(region) {
    const pf = profileSummary(); const lines = [];
    for (const x of pf.weakTopics.filter((x) => !region || x.region === region)) lines.push(`- ${x.t} (${x.region}): ${Math.round(x.acc * 100)} % richtig in ${x.n} Abfragen`);
    for (const x of pf.weakCases.filter((x) => !region || regionOfCase(x.c) === region)) { const last = (state.caseLog[x.c.id] || []).slice(-1)[0]; lines.push(`- Fall ${x.c.title}: Note ${fmtGrade(x.s.mean)}${last?.fehlend?.length ? `, gefehlt: ${last.fehlend.slice(0, 3).join('; ')}` : ''}`); }
    for (const x of pf.threadWeak.filter((x) => !region || x.region === region).slice(-10)) lines.push(`- ${x.thema}${x.region ? ` (${x.region})` : ''}: ${x.befund}`);
    return lines.slice(0, 25).join('\n');
  }
  // one small model call per finished conversation with substance (FREI thread or NACHFRAGEN), once per thread
  function distillThread(holder) {
    if (!holder || holder.profiled || !state.settings.apiKey) return;
    const msgs = (holder.discussion || holder.messages || []).filter((m) => m && m.content);
    if (msgs.length < 4) return;
    holder.profiled = true;
    const title = holder.title || holder.threadTitle || 'Gespräch';
    chatJSON({ system: 'Du bist Prüfungsexperte und fasst ein Übungsgespräch für ein Stärken-Schwächen-Profil zusammen. Antworte nur mit JSON.', messages: [{ role: 'user', content: P.profilePrompt(title, msgs) }], schema: P.PROFILE_SCHEMA, name: 'profil' })
      .then((out) => {
        const entry = { t: Date.now(), title, schwaechen: (out.schwaechen || []).slice(0, 4), staerken: (out.staerken || []).slice(0, 3) };
        if (!entry.schwaechen.length && !entry.staerken.length) return;
        (state.profile = state.profile || {}).log = (state.profile.log || []).concat(entry).slice(-150); Store.saveState();
      })
      .catch(() => { holder.profiled = false; });
  }

  // ------------------------------------------------------------------ decks
  // The candidate's presentations as whole decks (slides in order, with their images), so the examiner can
  // be asked to walk through one: the FMH presentations in the corpus plus every PPTX / PDF dumped into MATERIAL.
  function decks() {
    const out = new Map();
    for (const [cid, entries] of Object.entries(CORPUS)) for (const e of entries) {
      const d = out.get(e.name) || { name: e.name, caseIds: [], text: e.text, images: IMAGES.filter((i) => i.src === e.name).map((i) => ({ src: `data/img/${i.file}`, slide: i.slide, kind: i.kind })) };
      if (!d.caseIds.includes(cid)) d.caseIds.push(cid); out.set(e.name, d);
    }
    for (const m of materialsIndex) if (m.kind === 'fmh' || /\.(pptx|pdf|docx)$/i.test(m.name)) out.set(m.name, { name: m.name, caseIds: m.caseIds || [], materialId: m.id, text: null, images: (m.images || []).map((i) => ({ src: i.src, slide: i.slide, kind: 'xray' })) });
    return [...out.values()].map((d) => ({ ...d, slides: d.text ? (d.text.match(/--- (?:Folie|Seite) \d+ ---/g) || []).length : 0, title: d.caseIds.map((id) => caseById(id)?.title).filter(Boolean).join(' / ') }));
  }
  async function deckText(d) { if (d.text != null) return d.text; const m = await Store.getMaterial(d.materialId).catch(() => null); d.text = m?.text || ''; return d.text; }
  const deckSlides = (d) => [...new Set(d.images.map((i) => i.slide))].sort((a, b) => a - b);
  function deckList() { return decks().map((d) => `- «${d.name}»${d.title ? ` (${d.title})` : ''}${d.slides ? ` · ${d.slides} Folien` : ''}${d.images.length ? ` · Bilder auf Folie ${deckSlides(d).join(', ')}` : ''}`).join('\n'); }
  function deckByName(name) { const n = norm(name || ''); if (!n) return null; const all = decks(); return all.find((d) => norm(d.name) === n) || all.find((d) => norm(d.name).includes(n) || n.includes(norm(d.name))) || null; }
  // which decks a message is about: tokens of the file name or of the case title; "die Präsentation" alone → the selected case's decks
  function detectDecks(text, sel) {
    const all = decks(); const msg = Index.tokens(text); if (!msg.length) return [];
    const scored = all.map((d) => { const hay = Index.tokens(`${d.name.replace(/[-_.]+/g, ' ')} ${d.title}`); const hit = msg.filter((t) => t.length >= 4 && hay.some((h) => h.startsWith(t) || t.startsWith(h))).length; return { d, hit }; }).filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit);
    const wants = /pr[äa]sentation|folie|slides?|deck|durchgeh|durchf[üu]hr|walk|vortrag/i.test(text);
    let picked = scored.filter((x) => x.hit >= 2 || (wants && x.hit >= 1)).slice(0, 3).map((x) => x.d);
    if (!picked.length && wants && sel?.c) picked = all.filter((d) => d.caseIds.includes(sel.c.id));
    return picked;
  }
  function slideText(d, n) { const m = (d.text || '').split(/(?=--- (?:Folie|Seite) \d+ ---)/).find((part) => part.startsWith(`--- Folie ${n} ---`) || part.startsWith(`--- Seite ${n} ---`)); return m ? m.replace(/^--- [^\n]*---\n?/, '').trim() : ''; }
  async function deckBlock(list) {
    const parts = []; let budget = 45000;
    for (const d of list) {
      let t = await deckText(d); if (!t) continue; if (t.length > 20000) t = `${t.slice(0, 20000)}\n[gekürzt]`; if (t.length > budget) break; budget -= t.length;
      parts.push(`PRÄSENTATION «${d.name}»${d.title ? ` (${d.title})` : ''}, vollständig in Folienreihenfolge${d.images.length ? `; Bilder vorhanden auf Folie ${deckSlides(d).join(', ')}` : ''}:\n<<<\n${t}\n>>>`);
    }
    return parts.join('\n\n');
  }
  // slide images under an examiner message: every [Folie N] in the text, from the attached decks
  function slideFigures(nums, list, label = true) {
    const wrap = document.createElement('div'); wrap.className = 'slides';
    for (const n of nums) {
      const d = list.find((x) => x.images.some((i) => i.slide === n)) || list[0]; if (!d) continue;
      const imgs = d.images.filter((i) => i.slide === n);
      if (!imgs.length) { if (label) { const tag = document.createElement('span'); tag.className = 'pill'; tag.textContent = `FOLIE ${n} · ${d.name} · kein Bild`; wrap.appendChild(tag); } continue; }
      for (const i of imgs) { const f = document.createElement('figure'); f.innerHTML = `<img data-zoom alt=""><figcaption>FOLIE ${n} · ${esc(d.name)}</figcaption>`; f.querySelector('img').src = i.src; wrap.appendChild(f); }
    }
    return wrap.childElementCount ? wrap : null;
  }
  function renderSlideRefs(body, text, list) {
    if (!list?.length) return;
    const nums = [...new Set([...String(text).matchAll(/\[Folie\s+(\d+)\]/gi)].map((m) => Number(m[1])))];
    if (!nums.length) return;
    const fig = slideFigures(nums, list); if (fig) body.after(fig);
  }

  // images for a case: own slides first, Wikimedia Commons as fallback
  async function imageCandidates(caseItem) {
    const out = []; out.note = '';
    if (!state.settings.images) { out.note = 'Bilder in den Einstellungen ausgeschaltet'; return out; }
    const own = shuffle(ownImages(caseItem));
    for (const img of own.slice(0, 3)) {
      try { out.push({ src: img.src, url: await toDataUrl(img.src), credit: img.credit, note: img.note }); } catch { /* skip */ }
    }
    if (!out.length) out.note = own.length ? 'eigene Bilder nicht ladbar' : 'keine eigenen Bilder zu diesem Fall';
    if (!out.length && state.settings.webImages) {
      let found = 0; const sources = [];
      const addWeb = async (url, credit, note) => {
        found += 1;
        try { out.push({ src: proxied(url), url: await toDataUrl(proxied(url), 1200), credit, note: (note || '').replace(/<[^>]+>/g, '').slice(0, 200) }); } catch { /* not loadable */ }
      };
      try {
        const q = await chatJSON({ system: 'Antworte nur mit JSON.', messages: [{ role: 'user', content: P.commonsQueryPrompt(caseItem) }], schema: P.COMMONS_SCHEMA, name: 'commons' });
        const queries = (q.queries || []).slice(0, 3);
        if (state.settings.googleKey && state.settings.googleCx) {
          sources.push('Google');
          for (const query of queries) {
            const api = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(state.settings.googleKey)}&cx=${encodeURIComponent(state.settings.googleCx)}&searchType=image&num=8&imgSize=large&safe=off&q=${encodeURIComponent(query)}`;
            const data = await fetch(api).then((r) => r.json()).catch(() => null);
            if (data?.error) { out.note += ` · Google: ${data.error.message}`; break; }
            for (const item of data?.items || []) {
              if (!/\.(jpe?g|png|webp)(\?|$)/i.test(item.link) && !/image\/(jpeg|png|webp)/.test(item.mime || '')) continue;
              if ((item.image?.width || 0) < 400) continue;
              await addWeb(item.link, `${item.displayLink} · ${item.title}`, item.snippet);
              if (out.length >= 5) break;
            }
            if (out.length >= 5) break;
          }
        }
        if (out.length < 3) {
          sources.push('Commons');
          for (const query of queries) {
            const api = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1200&format=json&origin=*`;
            const data = await fetch(api).then((r) => r.json()).catch(() => null);
            for (const page of Object.values(data?.query?.pages || {})) {
              const info = page.imageinfo?.[0]; if (!info || !/image\/(jpeg|png)/.test(info.mime) || info.width < 400) continue;
              await addWeb(info.thumburl || info.url, `Wikimedia Commons · ${page.title.replace(/^File:/, '')}`, info.extmetadata?.ImageDescription?.value);
              if (out.length >= 5) break;
            }
            if (out.length >= 5) break;
          }
        }
        out.note += found ? ` · ${sources.join(' + ')}: ${found} Treffer, ${out.length} ladbar` : ` · ${sources.join(' + ')}: keine Treffer`;
      } catch (error) { out.note += ` · Websuche fehlgeschlagen (${error.message})`; }
    } else if (!out.length) out.note += ' · Websuche ausgeschaltet';
    return out;
  }

  // ------------------------------------------------------------- live chat
  // Talk to the examiner wherever there is a chat box (FREI, NACHFRAGEN after every verdict and
  // feedback): same transport as the live exam, the model answers by itself after each utterance,
  // and it can look passages up in the candidate's sources through the "nachschlagen" tool.
  const LOOKUP_HANDLER = { ...P.LOOKUP_TOOL, run: async (args) => (await lookup(args.frage || '', 3500, { k: 5 }).catch(() => '')) || 'Keine passenden Passagen in den Unterlagen.' };
  function attachLive(tools, { system, add, onTurn, history, greeting, extraTools = [] }) {
    if (!tools || !window.RealtimeVoice) return null;
    const handlers = [LOOKUP_HANDLER, ...extraTools];
    const toolDefs = handlers.map(({ run, ...def }) => def);
    const wrap = document.createElement('span'); wrap.className = 'live-wrap';
    wrap.innerHTML = '<button class="btn small live-toggle" type="button" title="Mit dem Prüfer sprechen (OpenAI Realtime)">● LIVE</button><button class="btn small ghost" type="button" hidden>STUMM</button><span class="live-status"></span>';
    tools.insertBefore(wrap, tools.querySelector('.spacer'));
    const [toggle, mute] = wrap.querySelectorAll('button'); const status = wrap.querySelector('.live-status');
    let voice = null; let connecting = false; const users = new Map(); let ex = null; let exText = '';
    const render = (st = {}) => {
      const on = !!voice; toggle.textContent = on ? 'LIVE AUS' : '● LIVE'; toggle.classList.toggle('on', on); toggle.disabled = connecting;
      mute.hidden = !on; mute.textContent = st.muted ? 'MIKRO AN' : 'STUMM';
      status.textContent = connecting ? 'VERBINDE …' : !on ? '' : st.muted ? 'STUMM' : st.speaking ? 'PRÜFER SPRICHT' : st.listening ? 'HÖRT ZU' : st.responding ? '…' : 'BEREIT';
      status.className = `live-status${st.speaking ? ' speaking' : st.listening ? ' listening' : ''}`;
    };
    const stop = () => { if (voice) { voice.close(); voice = null; } connecting = false; render({}); };
    const onEvent = async (e) => {
      switch (e.type) {
        case 'conversation.item.added': case 'conversation.item.created': {
          const it = e.item; if (!it || it.type !== 'message' || it.role !== 'user' || users.has(it.id) || !(it.content || []).some((c) => c.type === 'input_audio')) break;
          const entry = { role: 'user', content: '' }; onTurn(entry, true); // history slot in speaking order; the text follows with the transcript
          users.set(it.id, { el: add('candidate', '…'), text: '', entry }); break;
        }
        case 'conversation.item.input_audio_transcription.delta': { const u = users.get(e.item_id); if (u) { u.text += e.delta || ''; u.el.textContent = u.text; } break; }
        case 'conversation.item.input_audio_transcription.completed': {
          const u = users.get(e.item_id); if (!u) break; users.delete(e.item_id);
          const text = (e.transcript || u.text || '').trim();
          if (!text) { u.el.closest('.msg')?.remove(); u.entry.content = ''; onTurn(u.entry, false); break; } // noise, nothing said
          u.entry.content = text; u.el.textContent = text; onTurn(u.entry, false); break;
        }
        case 'conversation.item.input_audio_transcription.failed': { const u = users.get(e.item_id); if (!u) break; users.delete(e.item_id); u.entry.content = '(Transkription fehlgeschlagen)'; u.el.textContent = u.entry.content; onTurn(u.entry, false); break; }
        case 'response.created': ex = null; exText = ''; break;
        case 'response.output_audio_transcript.delta': case 'response.audio_transcript.delta': { if (!ex) ex = add('examiner', ''); exText += e.delta || ''; ex.textContent = exText; break; }
        case 'response.output_audio_transcript.done': case 'response.audio_transcript.done': { if (ex) { exText = (e.transcript || exText).trim(); ex.textContent = exText; } break; }
        case 'response.done': { if (exText.trim()) onTurn({ role: 'assistant', content: exText.trim() }, true); ex = null; exText = ''; break; }
        case 'response.output_item.done': {
          const it = e.item; if (it?.type !== 'function_call' || !voice) break;
          const tool = handlers.find((h) => h.name === it.name); if (!tool) { voice.toolResult(it.call_id, 'Unbekanntes Werkzeug.'); voice.respond(); break; }
          let args = {}; try { args = JSON.parse(it.arguments || '{}'); } catch { args = {}; }
          let out = ''; try { out = await tool.run(args); } catch (error) { out = `Fehler: ${error.message}`; }
          voice.toolResult(it.call_id, String(out || '')); voice.respond();
          break;
        }
        case 'error': if (e.error?.message && !/active response/i.test(e.error.message)) toast(`Live: ${e.error.message}`, true); break;
        case 'fmh.disconnected': stop(); toast('Live-Verbindung unterbrochen', true); break;
        default: break;
      }
      return undefined;
    };
    // connect and brief the examiner; `note` replaces the standard greeting (e.g. a new focus)
    const start = async (note) => {
      if (voice || !requireKey() || connecting) return;
      connecting = true; render({});
      try {
        if (state.settings.realtimeModel === 'auto' && !state.settings.resolvedRealtimeModel) await resolveModel().catch(() => {});
        const instructions = `${await system()}\n\n${P.voiceTutor(state.settings)}`;
        const eagerness = state.settings.eagerness === 'low' ? 'medium' : state.settings.eagerness; // conversation: a bit quicker than the exam
        const v = new RealtimeVoice({ apiKey: state.settings.apiKey, session: voiceSession({ instructions, tools: toolDefs, createResponse: true, eagerness }), onEvent, onState: render });
        await v.connect(); voice = v;
        const past = (history ? history() : []).filter((m) => m.content).slice(-12);
        if (past.length) v.addText('system', `BISHERIGES GESPRÄCH (Text):\n${past.map((m) => `${m.role === 'assistant' ? 'PRÜFER' : 'KANDIDAT'}: ${m.content}`).join('\n').slice(-6000)}`);
        const hello = note || greeting; if (hello) { v.addText('system', `[SYSTEM] ${hello}`); v.respond(); }
      } catch (error) { voice = null; toast(`Live: ${error.message}`, true); }
      connecting = false; render(voice ? voice.state : {});
    };
    // new briefing for a running call (topic changed): fresh instructions, one spoken acknowledgement
    const rebrief = async (note) => {
      if (!voice) return false;
      voice.update({ instructions: `${await system()}\n\n${P.voiceTutor(state.settings)}` });
      voice.addText('system', `[SYSTEM] ${note}`); voice.respond();
      return true;
    };
    toggle.onclick = () => (voice ? stop() : start());
    mute.onclick = () => { if (voice) voice.mute(!voice.state.muted); };
    render({});
    const prev = currentCleanup; currentCleanup = () => { stop(); if (prev) prev(); };
    return { stop, start, rebrief, on: () => !!voice };
  }

  // chat about a verdict or a feedback sheet; messages are kept in `holder.discussion`
  function discussion(container, contextText, holder, onChange, sourceQuery = '', opts = {}) {
    holder.discussion = holder.discussion || [];
    holder.threadId = holder.threadId || `n${uid()}`;
    holder.threadTitle = holder.threadTitle || (contextText.split('\n').find((l) => /^(FRAGE|FALL): /.test(l)) || 'Nachfrage').replace(/^(FRAGE|FALL): /, '').slice(0, 80);
    const persist = () => { const n = holder.discussion.filter((m) => m.content).length; if (!n) return; if (!holder.threadStart) holder.threadStart = Date.now(); Store.putSession({ id: holder.threadId, kind: 'nachfrage', title: holder.threadTitle, startedAt: holder.threadStart, updatedAt: Date.now(), n, messages: holder.discussion, context: contextText.slice(0, 3000) }); };
    container.innerHTML = `<details class="plain discuss" ${holder.discussion.length || opts.open ? 'open' : ''}><summary>NACHFRAGEN</summary>
      <div class="chat small" id="d-chat"></div>
      <textarea class="answer" id="d-input" style="min-height:70px" placeholder="Warum? Wie formuliere ich das besser? … ⌘/Ctrl+Enter sendet"></textarea>
      <div class="answer-tools"><button class="btn rec small" id="d-mic">● SPRECHEN</button><span class="spacer"></span><button class="btn small primary" id="d-send">SENDEN</button></div></details>`;
    const chat = container.querySelector('#d-chat'); const ta = container.querySelector('#d-input'); let busy = false;
    const add = (role, text) => { const div = document.createElement('div'); div.className = `msg ${role}`; div.innerHTML = `<div class="who">${role === 'examiner' ? 'PRÜFER <button class="say" type="button" title="Vorlesen">▶</button>' : 'DU'}</div><div class="body"></div>`; const body = div.querySelector('.body'); body.textContent = text; const b = div.querySelector('.say'); if (b) b.onclick = () => say(body.textContent); chat.appendChild(div); return body; };
    for (const m of holder.discussion) add(m.role === 'assistant' ? 'examiner' : 'candidate', m.content);
    wireMic(container.querySelector('#d-mic'), ta);
    container.querySelector('#d-mic').after(readToggle());
    const liveChat = attachLive(container.querySelector('.answer-tools'), {
      add,
      system: async () => { const passages = await lookup(sourceQuery, 4000, { k: 5 }).catch(() => ''); return P.discussSystem(state.settings, contextText) + (passages ? `\n\nAUSZÜGE AUS DEN UNTERLAGEN DES KANDIDATEN (Massstab):\n<<<\n${passages}\n>>>` : ''); },
      onTurn: (entry, fresh) => { if (fresh) holder.discussion.push(entry); persist(); if (onChange) onChange(); },
      history: () => holder.discussion,
      greeting: opts.greeting || 'Sage in einem Satz, dass der Kandidat jetzt zur Bewertung nachfragen kann.',
    });
    { const prevC = currentCleanup; currentCleanup = () => { distillThread(holder); if (prevC) prevC(); }; }
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); container.querySelector('#d-send').click(); } });
    container.querySelector('#d-send').onclick = async () => {
      const text = ta.value.trim(); if (!text || busy || !requireKey()) return;
      busy = true; ta.value = ''; add('candidate', text); holder.discussion.push({ role: 'user', content: text });
      const body = add('examiner', ''); body.innerHTML = '<span class="spinner"></span>';
      try {
        const passages = await lookup(`${sourceQuery} ${text}`, 4000, { k: 5 }).catch(() => '');
        const full = await chatStream({ system: P.discussSystem(state.settings, contextText) + (passages ? `\n\nAUSZÜGE AUS DEN UNTERLAGEN DES KANDIDATEN (Massstab; mit [Quelle: …] zitieren):\n<<<\n${passages}\n>>>` : ''), messages: holder.discussion.filter((m) => m.content), onDelta: (t) => { body.textContent = t; } });
        body.textContent = full; holder.discussion.push({ role: 'assistant', content: full }); persist();
        if (state.settings.examinerVoice) speak(full.slice(0, 600));
        if (onChange) onChange();
      } catch (error) { body.innerHTML = `<span class="warn">${esc(error.message)}</span>`; holder.discussion.pop(); }
      busy = false; ta.focus(); body.scrollIntoView({ block: 'nearest' });
    };
    return liveChat;
  }
  function latestTip() { const log = state.methodLog || []; return log.length ? log[log.length - 1].tipp : ''; }
  function answerMetrics(session) {
    const answers = session.transcript.filter((m) => m.role === 'candidate').map((m) => m.text.trim().split(/\s+/).filter(Boolean).length);
    if (!answers.length) return 'keine Antworten';
    const openers = answers.filter((_, i) => i % Math.max(1, Math.round(answers.length / 5)) === 0);
    const total = answers.reduce((a, b) => a + b, 0);
    const minutes = Math.round(((session.endedAt || Date.now()) - session.startedAt) / 60000);
    return `${answers.length} Antworten, insgesamt ${total} Wörter, Ø ${Math.round(total / answers.length)} Wörter pro Antwort (min ${Math.min(...answers)}, max ${Math.max(...answers)}), Eröffnungsantworten Ø ${Math.round(openers.reduce((a, b) => a + b, 0) / openers.length)} Wörter, Dauer ${minutes} min von 15.`;
  }

  // web research for a case: pages that show the typical imaging (OpenAI web_search tool)
  // one web-search call through the Responses API; returns the JSON object in the answer plus the citations
  async function webSearchJSON(input, effort = 'low') {
    const body = { model: activeModel(), tools: [{ type: 'web_search' }], input };
    if (isReasoningModel(activeModel())) body.reasoning = { effort };
    let res;
    try { res = await openaiFetch('/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (error) {
      if (/web_search|tool/i.test(error.message)) { body.tools = [{ type: 'web_search_preview' }]; res = await openaiFetch('/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
      else throw error;
    }
    const data = await res.json();
    const text = (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n') || data.output_text || '';
    const match = text.match(/\{[\s\S]*\}/);
    let json = null;
    try { json = match ? JSON.parse(match[0]) : null; } catch { json = null; }
    const cites = (data.output || []).flatMap((o) => o.content || []).flatMap((c) => c.annotations || []).filter((a) => a.type === 'url_citation').map((a) => ({ title: a.title || a.url, url: a.url }));
    return { json, cites, text };
  }
  // real-time fact check of hard claims against peer-reviewed sources; the last instance after the candidate's own sources
  async function factCheck(claims, context) {
    const list = (claims || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
    if (!list.length) return [];
    const { json, cites } = await webSearchJSON(P.factCheckPrompt(list, context), 'medium');
    const befunde = Array.isArray(json?.befunde) ? json.befunde : [];
    return befunde.map((b, i) => ({
      aussage: String(b.aussage || list[i] || ''), status: /korrig/i.test(b.status) ? 'korrigiert' : /best/i.test(b.status) ? 'bestätigt' : 'unklar',
      korrektur: String(b.korrektur || ''), quelle: String(b.quelle || ''), url: /^https?:/.test(b.url || '') ? b.url : (cites[i]?.url || ''),
    })).filter((b) => b.aussage);
  }
  function factBlock(befunde, title = 'FAKTENCHECK · S-TIER-LITERATUR') {
    if (!befunde) return '';
    const icon = { bestätigt: '✓', korrigiert: '✗', unklar: '?' };
    return `<div class="fact"><span class="label muted">${esc(title)}</span>${befunde.length ? `<ul class="clean">${befunde.map((b) => `<li class="fact-${b.status}"><span class="fact-icon">${icon[b.status]}</span> ${esc(b.aussage)}${b.korrektur && b.status !== 'bestätigt' ? `<br><strong>${esc(b.korrektur)}</strong>` : ''}${b.quelle || b.url ? `<br><span class="meta">${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.quelle || b.url)}</a>` : esc(b.quelle)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="meta">Keine prüfbaren Behauptungen.</p>'}</div>`;
  }
  async function researchLinks(caseItem, mode) {
    const { json, cites } = await webSearchJSON(P.researchPrompt(caseItem, mode));
    let links = Array.isArray(json?.links) ? json.links : [];
    if (!links.length) links = cites.map((a) => ({ title: a.title, url: a.url, why: '' }));
    const seen = new Set();
    return links.filter((l) => l.url && /^https?:/.test(l.url) && !seen.has(l.url) && seen.add(l.url)).slice(0, 6);
  }
  async function storeCaseImage(caseId, blob, credit, note) {
    const src = await Store.uploadFile(blob, `case-${caseId}-${Date.now()}.jpg`);
    if (!src) throw new Error('Speichern nur mit laufendem server.py möglich');
    (state.caseImages = state.caseImages || {})[caseId] = userImages(caseId).concat({ src, credit, note: note || '', t: Date.now() });
    clearTimeout(Store._timer); await Store.flush();
    return { src, credit, note: note || '' };
  }
  async function blobToJpeg(blob, maxSide = 1600) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
  }

  // ------------------------------------------------------------- item media
  // Images for a quiz / lazy item: slides of its own deck or case decks whose text names the item (rare tokens
  // such as eponyms carry the match, generic words do not), plus the candidate's own saved images. With none,
  // a web search lists pages with the figure, and a pad saves a dropped / pasted / linked image to the item.
  let imgIdx = null;
  function imageIndex() {
    if (imgIdx && Date.now() - imgIdx.t < 60000) return imgIdx;
    const GEN = new Set(['pptx', 'fractur', 'fx', 'incl']);
    const pool = IMAGES.map((im) => ({ src: `data/img/${im.file}`, caption: `FOLIE ${im.slide} · ${im.src}`, kind: im.kind, deck: im.src, cases: im.cases || [], toks: new Set(Index.tokens(im.text || '')), dtoks: new Set(Index.tokens(im.src.replace(/\.(pptx|pdf)$/i, '').replace(/[-_.]+/g, ' ')).filter((t) => !GEN.has(t))) }));
    for (const m of materialsIndex) for (const im of m.images || []) pool.push({ src: im.src, caption: `FOLIE ${im.slide} · ${m.name}`, kind: 'xray', deck: m.name, cases: m.caseIds || [], toks: new Set(Index.tokens(im.text || '')), dtoks: new Set(Index.tokens(m.name.replace(/\.[a-z]+$/i, '').replace(/[-_.]+/g, ' ')).filter((t) => !GEN.has(t))) });
    const dfImg = new Map(); for (const x of pool) for (const t of x.toks) dfImg.set(t, (dfImg.get(t) || 0) + 1);
    const dfBank = new Map(); for (const it of allItems()) if (it.type !== 'bild') for (const t of new Set(Index.tokens(`${it.topic || ''} ${it.q}`))) dfBank.set(t, (dfBank.get(t) || 0) + 1);
    imgIdx = { t: Date.now(), pool, dfImg, dfBank };
    return imgIdx;
  }
  function itemImages(item) {
    const own = ((state.itemImages || {})[item.id] || []).map((u) => ({ src: u.src, caption: u.credit || 'eigenes Bild', kind: 'own' }));
    if (item.type === 'bild') return own;
    const { pool, dfImg, dfBank } = imageIndex();
    const q = [...new Set(Index.tokens(`${item.topic || ''} ${item.q}`))].filter((t) => t.length >= 4);
    const deckName = /^ernte (.+)$/.exec(item.source || '')?.[1] || null;
    const rare = (t) => (dfImg.get(t) || 0) <= 3 && (dfBank.get(t) || 0) <= 3;
    const mid = (t) => (dfImg.get(t) || 0) <= 12 && (dfBank.get(t) || 0) <= 8;
    const scored = [];
    for (const img of pool) {
      let sc = 0; let n = 0; let hasRare = false;
      for (const t of q) {
        const inText = img.toks.has(t); const inDeck = img.dtoks.has(t); if (!inText && !inDeck) continue;
        n += 1;
        if ((inDeck && (dfBank.get(t) || 0) <= 3) || rare(t)) { sc += 2.5; hasRare = true; } else if (mid(t)) sc += 1; else sc += 0.25;
      }
      const linked = (deckName && img.deck === deckName) || (item.caseIds || []).some((c) => img.cases.includes(c));
      const ok = linked ? sc >= 1 : ((hasRare && n >= 2) || sc >= 5);
      if (ok) scored.push({ img, sc: sc + (linked ? 1 : 0) });
    }
    scored.sort((a, b) => b.sc - a.sc);
    const seen = new Set(); const picked = [];
    for (const { img } of scored) { if (seen.has(img.src)) continue; seen.add(img.src); picked.push(img); if (picked.length >= 4) break; }
    return own.concat(picked);
  }
  let padPaste = null;
  function mountMedia(container, item, reveal) {
    if (!container || !item || item.type === 'bild') return;
    const imgs = itemImages(item);
    const gallery = (list) => (list.length ? `<div class="media">${list.map((i) => `<figure><img src="${esc(i.src)}" data-zoom alt=""><figcaption>${esc(i.caption)}</figcaption></figure>`).join('')}</div>` : '');
    if (!reveal) { container.innerHTML = gallery(imgs.filter((i) => ['xray', 'ct', 'mri'].includes(i.kind))); return; } // before the answer: radiographs only, never the schema
    const note = (state.itemNotes || {})[item.id] || '';
    const auto = item.type === 'klassifikation' || item.type === 'algorithmus';
    container.innerHTML = `${gallery(imgs)}
      <div class="row" style="margin-top:10px"><input type="text" id="item-note" placeholder="Merkhilfe zu diesem Item · wird gespeichert" value="${esc(note)}" style="max-width:560px"></div>
      <details class="plain" id="item-pad" ${imgs.length ? '' : 'open'}><summary>${imgs.length ? 'BILD HINZUFÜGEN' : 'KEIN BILD IN DEINEN PRÄSENTATIONEN · SUCHEN UND ABLEGEN'}</summary>
        <div id="item-links" class="schema" style="margin:8px 0"></div>
        <div class="drop small" id="item-drop">BILD HIER ABLEGEN · ⌘V EINFÜGEN · KLICKEN<input type="file" accept="image/*" hidden></div>
        <div class="row" style="margin-top:6px"><input type="text" id="item-url" placeholder="oder Bild-URL einfügen" style="max-width:380px"><button class="btn small" id="item-url-go">ÜBERNEHMEN</button><button class="btn small ghost" id="item-search">BILD SUCHEN</button><span class="img-credit" id="item-status"></span></div>
      </details>`;
    const noteEl = container.querySelector('#item-note');
    noteEl.onchange = () => { (state.itemNotes = state.itemNotes || {})[item.id] = noteEl.value.trim(); Store.saveState(); };
    const status = (t, bad) => { const el = container.querySelector('#item-status'); if (el) { el.textContent = t; el.classList.toggle('warn', !!bad); } };
    const useBlob = async (blob, credit) => {
      try {
        status('Bild wird gespeichert …');
        const jpeg = await blobToJpeg(blob);
        const src = await Store.uploadFile(jpeg, `item-${item.id}-${Date.now()}.jpg`);
        if (!src) throw new Error('Speichern nur mit laufendem server.py möglich');
        (state.itemImages = state.itemImages || {})[item.id] = ((state.itemImages[item.id]) || []).concat({ src, credit, t: Date.now() });
        clearTimeout(Store._timer); await Store.flush();
        mountMedia(container, item, true); toast('Bild gespeichert');
      } catch (error) { status(error.message, true); }
    };
    const fromUrl = async (url) => { try { status('Bild wird geladen …'); const blob = await fetch(proxied(url)).then((r) => { if (!r.ok) throw new Error(`Bild nicht ladbar (${r.status})`); return r.blob(); }); await useBlob(blob, new URL(url).hostname.replace(/^www\./, '')); } catch (error) { status(error.message, true); } };
    const drop = container.querySelector('#item-drop'); const input = drop.querySelector('input');
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/')); if (f) useBlob(f, `eigenes Bild · ${f.name}`); else { const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); if (/^https?:/.test(url)) fromUrl(url.trim()); } };
    input.onchange = () => { const f = input.files[0]; if (f) useBlob(f, `eigenes Bild · ${f.name}`); input.value = ''; };
    container.querySelector('#item-url-go').onclick = () => { const u = container.querySelector('#item-url').value.trim(); if (/^https?:/.test(u)) fromUrl(u); else status('Keine gültige URL', true); };
    if (padPaste) document.removeEventListener('paste', padPaste);
    padPaste = (e) => {
      if (!container.isConnected) { document.removeEventListener('paste', padPaste); padPaste = null; return; }
      if (e.target && ['TEXTAREA', 'INPUT'].includes(e.target.tagName)) return;
      const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); useBlob(f, 'eigenes Bild · Screenshot'); }
    };
    document.addEventListener('paste', padPaste);
    // pages with the figure: automatic for classifications / algorithms without an image, otherwise on BILD SUCHEN; cached per item
    const linksEl = container.querySelector('#item-links');
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const showLinks = (links) => { linksEl.innerHTML = links.length ? `<span class="label muted">SEITEN MIT PASSENDEM BILD</span><ul class="clean" style="margin-top:6px">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a> <span class="faint">${esc(host(l.url))}${l.why ? ` · ${esc(l.why)}` : ''}</span></li>`).join('')}</ul>` : '<span class="muted">Websuche ohne Ergebnis. Radiopaedia, AO Surgery Reference oder Orthobullets manuell durchsuchen.</span>'; };
    const search = async () => {
      const cached = (state.itemLinks || {})[item.id]; if (cached?.links) { showLinks(cached.links); return; }
      if (!state.settings.apiKey) return;
      linksEl.innerHTML = '<span class="spinner"></span> <span class="thinking">PRÜFER SUCHT PASSENDE SEITEN</span>';
      try { const links = await researchLinks({ title: `${item.topic ? `${item.topic}: ` : ''}${item.q}`, region: item.region }, 'item'); (state.itemLinks = state.itemLinks || {})[item.id] = { links, t: Date.now() }; Store.saveState(); if (container.isConnected) showLinks(links); }
      catch (error) { if (container.isConnected) linksEl.innerHTML = `<span class="muted">Websuche nicht verfügbar (${esc(error.message)})</span>`; }
    };
    container.querySelector('#item-search').onclick = search;
    if ((state.itemLinks || {})[item.id]?.links) showLinks(state.itemLinks[item.id].links);
    else if (!imgs.length && auto) search();
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
  const hero = (kicker, title) => `<div class="hero"><span class="kicker">${kicker}</span><h1>${title}</h1></div>`;

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
      ${hero(`PRÜFUNG · ${done}/${CASES.length} FÄLLE · Ø ${fmtGrade(mean)}`, 'Fall-Matrix')}
      <div class="row" style="margin:-8px 0 26px">
        ${state.activeExam ? `<button class="btn primary" id="btn-resume">LAUFENDEN FALL FORTSETZEN · ${esc(caseById(state.activeExam.caseId)?.title || '')}</button>` : ''}
        <button class="btn ${state.activeExam ? '' : 'primary'}" id="btn-next">NÄCHSTER OFFENER FALL</button>
        <button class="btn" id="btn-random">ZUFALL</button>
        <button class="btn" id="btn-weak">SCHWÄCHSTER FALL</button>
      </div>
      ${regions.map((region) => {
        const items = CASES.filter((c) => c.region === region);
        const regionDone = items.filter((c) => caseSummary(c.id).runs > 0).length;
        return `<section class="matrix-group">
          <div class="matrix-head"><h3>${esc(region)}</h3><span class="meta">${regionDone}/${items.length}</span></div>
          ${items.map((c) => { const s = caseSummary(c.id); const hasImg = ownImages(c).length > 0; return `
            <button class="case-row" data-case="${c.id}">
              <span class="id">${esc(c.id.toUpperCase())}</span>
              <span class="title">${esc(c.title)}${hasImg ? ' <span class="faint" title="Bilder vorhanden">▣</span>' : ''}</span>
              <span class="runs">${s.runs ? `${s.runs}×` : ''}</span>
              <span class="grade ${gradeClass(s.last)}">${fmtGrade(s.last)}</span>
            </button>`; }).join('')}
        </section>`;
      }).join('')}`;
    view.addEventListener('click', (e) => { const b = e.target.closest('.case-row'); if (b) location.hash = `#exam/${b.dataset.case}`; });
    if ($('#btn-resume')) $('#btn-resume').onclick = () => { location.hash = `#exam/${state.activeExam.caseId}`; };
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
    const resumeId = state.activeExam?.caseId === caseId ? state.activeExam.id : null;
    if (resumeId) { Store.getSession(resumeId).then((saved) => { if (saved && saved.status === 'laufend' && saved.dossier) runExam(caseItem, saved); else { state.activeExam = null; Store.saveState(); runExam(caseItem, null); } }); return; }
    runExam(caseItem, null);
  }
  function runExam(caseItem, saved) {
    const caseId = caseItem.id;
    const session = saved || { id: `${today().replace(/-/g, '')}-${uid()}`, caseId, title: caseItem.title, startedAt: Date.now(), status: 'laufend', dossier: null, image: null, messages: [], transcript: [], station: 0, followup: 0, feedback: null };
    const history = state.caseLog[caseId] || [];
    const previous = history.map((l) => l.variant).filter(Boolean).slice(-6);
    const difficulty = history.length === 0 ? 'Standardfall, typische Präsentation.' : (history[history.length - 1].grade >= 5 ? 'Anspruchsvoll: Begleitverletzung, relevante Komorbidität oder Komplikation im Verlauf einbauen.' : 'Standardfall, aber andere Variante.');
    let timerId = null; let busy = false;
    const followupsTotal = Math.max(0, Math.min(3, Number(state.settings.followups) || 0));

    view.innerHTML = `
      <div class="row between" style="margin-bottom:18px">
        <div><span class="kicker" style="margin-bottom:6px">${esc(caseId.toUpperCase())} · ${esc(caseItem.region)}</span><h2 style="margin:0">${esc(caseItem.title)}</h2></div>
        <div class="row"><span class="timer" id="timer">15:00</span><button class="btn ghost" id="btn-abort">ABBRECHEN</button></div>
      </div>
      <div class="station-strip" id="strip">${P.STATIONS.map(() => '<span></span>').join('')}</div>
      <div class="session">
        <div>
          <div id="dossier" class="dossier"><span class="thinking"><span class="spinner"></span> &nbsp;DER PRÜFER BEREITET DEN FALL VOR</span></div>
          <div class="transcript" id="transcript"></div>
          <div class="answer-box" id="answer-box" hidden>
            <div class="station-label" id="station-label"></div>
            <textarea class="answer" id="answer" placeholder="Antwort sprechen oder tippen · ⌘/Ctrl+Enter sendet"></textarea>
            <div class="answer-tools">
              <button class="btn rec" id="mic">● SPRECHEN</button>
              <button class="btn small live-toggle" id="live-toggle" title="Prüfer spricht und hört zu (OpenAI Realtime)">● LIVE</button>
              <button class="btn small ghost" id="live-mute" hidden>STUMM</button>
              <span class="live-status" id="live-status"></span>
              <span class="spacer"></span>
              <button class="btn ghost" id="btn-ask" title="Befund erfragen, zählt nicht als Antwort">RÜCKFRAGE</button>
              <button class="btn primary" id="btn-send">ANTWORTEN</button>
            </div>
          </div>
        </div>
        <aside class="session-side">
          <div class="side-block"><span class="label muted">ERWARTETE STRUKTUR</span><div class="schema" id="schema"></div></div>
          <div class="side-block"><div class="schema">${P.STATIONS.map((s, i) => `<div id="st-${i}">${i + 1} · ${esc(s.label)}</div>`).join('')}</div></div>
          ${latestTip() ? `<div class="side-block"><span class="label muted">FOKUS · METHODIK</span><div class="schema"><strong>${esc(latestTip())}</strong></div></div>` : ''}
        </aside>
      </div>`;

    const transcriptEl = $('#transcript'); const answerEl = $('#answer'); const sendBtn = $('#btn-send'); const askBtn = $('#btn-ask');
    wireMic($('#mic'), answerEl);
    $('#live-status').after(readToggle('read-toggle'));
    answerEl.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });
    $('#btn-abort').onclick = () => { if (confirm('Fall abbrechen? Es wird nichts gewertet.')) { live.stop(true); state.activeExam = null; session.status = 'abgebrochen'; Store.putSession(session); Store.saveState(); location.hash = '#exam'; } };
    $('#live-toggle').onclick = () => { if (live.on) live.stop(false); else if (session.dossier) live.start(true); else toast('Der Fall wird noch vorbereitet.'); };
    $('#live-mute').onclick = () => { if (live.voice) live.voice.mute(!live.voice.state.muted); };
    function showDossier(dossier, image) {
      $('#dossier').innerHTML = `<span class="label muted">PATIENTENUNTERLAGEN ${sayHtml(dossier.unterlagen)}</span><p>${esc(dossier.unterlagen)}</p><span class="label muted">BILDDOKUMENTATION</span>${image ? `<div class="case-images"><img src="${esc(image.src)}" data-zoom alt=""></div><div class="img-credit">${esc(image.credit)}</div>` : ''}<p>${esc(dossier.bildgebung)}</p>${!image && session.imageNote ? `<div class="img-credit">Textbeschreibung statt Bild · ${esc(session.imageNote)}</div>` : ''}`;
    }
    async function resume() {
      session.system = session.system || P.examinerSystem(state.settings, caseItem, session.dossier, await groundingForCase(caseItem), memoryFor(caseItem));
      showDossier(session.dossier, session.image);
      for (const m of session.transcript) addMsg(m.role, m.text, true);
      $('#answer-box').hidden = false;
      const stationNow = session.station; const followupNow = session.followup;
      setStation(stationNow); session.followup = followupNow;
      startTimer(); answerEl.focus();
      toast('Fall fortgesetzt');
      if (state.settings.live) live.start(true);
    }

    function addMsg(role, text, replay = false) {
      if (!replay) session.transcript.push({ role, text, t: Date.now() });
      const div = document.createElement('div'); div.className = `msg ${role}`;
      div.innerHTML = `<div class="who">${role === 'examiner' ? 'PRÜFER <button class="say" type="button" title="Vorlesen">▶</button>' : role === 'candidate' ? 'KANDIDAT' : 'SYSTEM'}</div><div class="body">${esc(text)}</div>`;
      const body = div.querySelector('.body');
      const btn = div.querySelector('.say'); if (btn) btn.onclick = () => say(body.textContent);
      transcriptEl.appendChild(div);
      div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (role === 'examiner' && state.settings.examinerVoice && !replay && !live.on) speak(text);
      return body;
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
      const opener = P.opener(i, state.settings);
      session.messages.push({ role: 'assistant', content: JSON.stringify({ reaktion: '', frage: opener }) });
      addMsg('examiner', opener);
    }
    function startTimer() {
      const end = session.startedAt + 15 * 60000;
      timerId = setInterval(() => {
        const left = end - Date.now(); const el = $('#timer'); if (!el) return clearInterval(timerId);
        const abs = Math.abs(left); const m = Math.floor(abs / 60000); const s = Math.floor((abs % 60000) / 1000);
        el.textContent = `${left < 0 ? '−' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        el.classList.toggle('late', left < 0);
      }, 500);
    }
    // Live examiner: the Realtime model speaks and listens over WebRTC. The exam protocol (stations,
    // follow-ups, Rückfragen) is still driven here: every candidate turn gets one short control note
    // before the examiner answers, the transcript is captured from both sides, and the grading at the
    // end runs on the strong chat model exactly as in text mode.
    const live = {
      voice: null, on: false, connecting: false, pending: null, current: null, queued: [], users: new Map(), ex: null, exEntry: null,
      async start(resumed) {
        if (this.on || this.connecting || !window.RealtimeVoice || !state.settings.apiKey) return false;
        this.connecting = true; this.render({});
        try {
          if (state.settings.realtimeModel === 'auto' && !state.settings.resolvedRealtimeModel) await resolveModel().catch(() => {});
          const instructions = `${session.system}\n\n${P.voiceExaminer(state.settings)}`;
          this.voice = new RealtimeVoice({ apiKey: state.settings.apiKey, session: voiceSession({ instructions, maxTokens: 700 }), onEvent: (e) => this.onEvent(e), onState: (st) => this.render(st) });
          await this.voice.connect();
        } catch (error) {
          this.connecting = false; this.voice = null; this.render({});
          toast(`Live-Prüfer nicht verbunden (${error.message}) · weiter per Text / ● SPRECHEN`, true);
          return false;
        }
        this.connecting = false; this.on = true; this.users.clear(); this.pending = null; this.current = null; this.queued = []; this.render(this.voice.state);
        setStation(session.station);
        const spoken = session.transcript.filter((m) => m.role !== 'system');
        if (resumed && spoken.length) this.voice.addText('system', `BISHERIGER VERLAUF DIESER PRÜFUNG (die aktuelle Station beginnt mit ihrer Eröffnungsfrage neu):\n${spoken.map((m) => `${m.role === 'examiner' ? 'PRÜFER' : 'KANDIDAT'}: ${m.text}`).join('\n').slice(-6000)}`);
        this.voice.addText('system', P.voiceOpen(session.station, resumed && spoken.length > 0, state.settings));
        this.voice.respond();
        return true;
      },
      stop(final) {
        if (this.voice) { this.voice.close(); this.voice = null; }
        const was = this.on; this.on = false; this.connecting = false; this.pending = null; this.current = null; this.queued = []; this.render({});
        // back to text mode: the chat model gets the spoken turns as its history
        if (was && !final && session.status === 'laufend') session.messages = session.transcript.filter((m) => m.role !== 'system').map((m) => (m.role === 'examiner' ? { role: 'assistant', content: JSON.stringify({ reaktion: '', frage: m.text }) } : { role: 'user', content: m.text.replace(/^Rückfrage: /, '') }));
      },
      render(st = {}) {
        const t = $('#live-toggle'); if (!t) return;
        t.textContent = this.on ? 'LIVE AUS' : '● LIVE'; t.classList.toggle('on', this.on); t.disabled = this.connecting;
        const mic = $('#mic'); if (mic) mic.hidden = this.on || this.connecting;
        const rt = $('#read-toggle'); if (rt) rt.hidden = this.on || this.connecting; // live: the examiner speaks anyway, LIVE AUS is the off switch
        const m = $('#live-mute'); if (m) { m.hidden = !this.on; m.textContent = st.muted ? 'MIKRO AN' : 'STUMM'; }
        const el = $('#live-status'); if (!el) return;
        el.textContent = this.connecting ? 'VERBINDE …' : !this.on ? '' : st.muted ? 'STUMM' : st.speaking ? 'PRÜFER SPRICHT' : st.listening ? 'HÖRT ZU' : st.responding ? '…' : 'BEREIT';
        el.className = `live-status${st.speaking ? ' speaking' : st.listening ? ' listening' : ''}`;
      },
      // A candidate turn: spoken (text arrives with the transcript) or typed. Rückfragen (questions to the examiner)
      // do not count as answers. A turn can be uncounted exactly once, by the transcript or by the examiner's own
      // reaction (he stayed on the station), so the order in which those two arrive does not matter.
      show(u) { u.entry.text = (u.question ? 'Rückfrage: ' : '') + (u.text || '…'); u.el.textContent = u.entry.text; },
      uncount(u) { if (u.counted) { u.counted = false; session.followup = Math.max(0, session.followup - 1); } u.question = true; this.show(u); },
      newTurn(text, question) { const el = addMsg('candidate', ''); const u = { el, entry: session.transcript[session.transcript.length - 1], text, question: !!question, counted: false, done: false }; this.show(u); return u; },
      go(pending) { if (pending === 'finish') { Store.putSession(session); finish(); return true; } setStation(session.station + 1); return false; },
      async turn(u) {
        if (this.current || this.voice?.state.responding) { this.queued.push(u); return; } // one turn at a time; the next runs after response.done
        this.current = u;
        const i = session.station; const isLast = i === P.STATIONS.length - 1;
        if (!u.question) { session.followup += 1; u.counted = true; }
        const exhausted = u.counted && session.followup > followupsTotal;
        const lastQ = [...session.transcript].reverse().find((m) => m.role === 'examiner')?.text || '';
        const passages = await lookup(`${caseItem.title} ${P.STATIONS[i].label} ${lastQ} ${u.text || ''}`, 2500, { k: 3 }).catch(() => '');
        const control = u.question
          ? `[SYSTEM · STATION ${i + 1}/5] Der Kandidat hat eine Rückfrage gestellt: in einem Satz aus dem Dossier beantworten, dann die offene Frage wiederholen.`
          : P.voiceTurn(i, Math.min(session.followup, followupsTotal), followupsTotal, exhausted, isLast, passages, state.settings);
        this.pending = exhausted ? (isLast ? 'finish' : 'next') : null;
        if (!this.voice) { this.current = null; return; }
        this.voice.addText('system', control); this.voice.respond();
        Store.putSession(session);
      },
      typed(text, onlyQuestion) { const u = this.newTurn(text, onlyQuestion); if (this.voice) this.voice.addText('user', text); this.turn(u); },
      onEvent(e) {
        switch (e.type) {
          case 'conversation.item.added': case 'conversation.item.created': {
            const it = e.item; if (!it || it.type !== 'message' || it.role !== 'user' || this.users.has(it.id)) break;
            if (!(it.content || []).some((c) => c.type === 'input_audio')) break;
            const u = this.newTurn('', false); this.users.set(it.id, u); this.turn(u);
            break;
          }
          case 'conversation.item.input_audio_transcription.delta': { const u = this.users.get(e.item_id); if (u) { u.text += e.delta || ''; this.show(u); } break; }
          case 'conversation.item.input_audio_transcription.completed': {
            const u = this.users.get(e.item_id); if (!u) break; this.users.delete(e.item_id);
            u.text = (e.transcript || u.text || '').trim();
            if (!u.text) { u.text = '(unverständlich)'; if (!u.done) this.uncount(u); this.show(u); Store.putSession(session); break; } // noise: not an answer
            const question = looksLikeQuestion(u.text);
            if (u.decide) { const d = u.decide; u.decide = null; if (question) this.uncount(u); else { this.show(u); if (this.go(d)) return; } } // examiner answered before the transcript: decide now
            else if (!u.done && question) this.uncount(u); else this.show(u);
            Store.putSession(session); break;
          }
          case 'conversation.item.input_audio_transcription.failed': { const u = this.users.get(e.item_id); if (u) { this.users.delete(e.item_id); u.text = '(Transkription fehlgeschlagen)'; this.show(u); } break; }
          case 'response.created': this.ex = null; this.exEntry = null; break;
          case 'response.output_audio_transcript.delta': case 'response.audio_transcript.delta': {
            if (!this.ex) { this.ex = addMsg('examiner', ''); this.exEntry = session.transcript[session.transcript.length - 1]; }
            this.exEntry.text += e.delta || ''; this.ex.textContent = this.exEntry.text; break;
          }
          case 'response.output_audio_transcript.done': case 'response.audio_transcript.done': { if (this.exEntry) { this.exEntry.text = (e.transcript || this.exEntry.text).trim(); this.ex.textContent = this.exEntry.text; } break; }
          case 'response.done': {
            const said = this.exEntry?.text || ''; this.ex = null; this.exEntry = null;
            const u = this.current; const pending = this.pending; this.current = null; this.pending = null;
            if (u) u.done = true;
            if (pending && u) {
              const status = e.response?.status;
              const cue = pending === 'finish' ? /beendet|vielen dank|concluded|thank you/i.test(said) : mentions(said, P.opener(session.station + 1, state.settings));
              if (cue) { if (this.go(pending)) return; }
              else if (status === 'cancelled' || status === 'failed') { /* interrupted before the cue: the next turn re-issues it */ }
              else if (u.question || (u.text && looksLikeQuestion(u.text))) this.uncount(u); // Rückfrage: the examiner stayed on the station
              else if (u.text) { if (this.go(pending)) return; } // a real answer and the cue was given: trust the cue even if he paraphrased it
              else u.decide = pending; // transcript not in yet: decide when it arrives
            }
            Store.putSession(session);
            const next = this.queued.shift(); if (next) this.turn(next);
            break;
          }
          case 'error': if (e.error?.message && !/active response/i.test(e.error.message)) toast(`Live: ${e.error.message}`, true); break;
          case 'fmh.disconnected': this.stop(false); toast('Live-Verbindung unterbrochen · ● LIVE verbindet neu', true); break;
          default: break;
        }
      },
    };
    currentCleanup = () => { clearInterval(timerId); live.stop(true); if (Recorder.active) Recorder.stop(); if (currentAudio) currentAudio.pause(); };

    async function begin() {
      if (!requireKey()) return;
      if (state.settings.images && !ownImages(caseItem).length && serverOk) return researchPanel();
      return start(null);
    }
    // No own image: let the candidate research one (links from a web search), drop or paste it, or go on without.
    function researchPanel() {
      $('#dossier').innerHTML = `
        <span class="label muted">BILDDOKUMENTATION · KEIN EIGENES BILD ZU DIESEM FALL</span>
        <p class="muted" style="margin:8px 0 12px">Recherchiere das typische Bild selbst, dann hier ablegen (Datei, Screenshot per ⌘V, oder Bild-URL). Es bleibt diesem Fall zugeordnet.</p>
        <div id="links" class="schema"><span class="spinner"></span> &nbsp;<span class="thinking">PRÜFER SUCHT PASSENDE SEITEN</span></div>
        <div class="drop" id="img-drop" style="margin:14px 0 10px;padding:22px">BILD HIER ABLEGEN · ⌘V EINFÜGEN · KLICKEN<input type="file" id="img-file" accept="image/*" hidden></div>
        <div class="row"><input type="text" id="img-url" placeholder="oder Bild-URL einfügen" style="max-width:420px"><button class="btn small" id="img-url-go">ÜBERNEHMEN</button><span class="spacer"></span><button class="btn ghost" id="img-skip">WEITER OHNE EIGENES BILD</button></div>
        <div class="img-credit" id="img-status"></div>`;
      const status = (t, bad) => { const el = $('#img-status'); if (el) { el.textContent = t; el.classList.toggle('warn', !!bad); } };
      const useBlob = async (blob, credit, note) => {
        try {
          status('Bild wird gespeichert …');
          const jpeg = await blobToJpeg(blob);
          const img = await storeCaseImage(caseId, jpeg, credit, note);
          imageBank = imageBank.filter((it) => !it.id.startsWith('img-user-')); // rebuilt lazily by allItems()
          start(img);
        } catch (error) { status(error.message, true); }
      };
      const drop = $('#img-drop'); const input = $('#img-file');
      drop.onclick = () => input.click();
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/')); if (f) useBlob(f, `eigene Recherche · ${f.name}`); else { const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); if (/^https?:/.test(url)) fromUrl(url.trim()); } };
      input.onchange = () => { const f = input.files[0]; if (f) useBlob(f, `eigene Recherche · ${f.name}`); input.value = ''; };
      const onPaste = (e) => { const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); useBlob(f, 'eigene Recherche · Screenshot'); } };
      document.addEventListener('paste', onPaste);
      const prevCleanup = currentCleanup; currentCleanup = () => { document.removeEventListener('paste', onPaste); if (prevCleanup) prevCleanup(); };
      async function fromUrl(url) {
        try { status('Bild wird geladen …'); const blob = await fetch(proxied(url)).then((r) => { if (!r.ok) throw new Error(`Bild nicht ladbar (${r.status})`); return r.blob(); }); await useBlob(blob, `eigene Recherche · ${new URL(url).hostname}`, url); }
        catch (error) { status(error.message, true); }
      }
      $('#img-url-go').onclick = () => { const u = $('#img-url').value.trim(); if (/^https?:/.test(u)) fromUrl(u); else status('Keine gültige URL', true); };
      $('#img-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#img-url-go').click(); });
      $('#img-skip').onclick = () => { document.removeEventListener('paste', onPaste); start(null); };
      researchLinks(caseItem).then((links) => {
        const el = $('#links'); if (!el) return;
        el.innerHTML = links.length
          ? `<span class="label muted">SEITEN MIT PASSENDEM BILD</span><ul class="clean" style="margin-top:6px">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a> <span class="faint">${esc(new URL(l.url).hostname.replace(/^www\./, ''))}${l.why ? ` · ${esc(l.why)}` : ''}</span></li>`).join('')}</ul>`
          : '<span class="muted">Websuche ohne Ergebnis. Radiopaedia, AO Surgery Reference oder Orthobullets manuell durchsuchen.</span>';
      }).catch((error) => { const el = $('#links'); if (el) el.innerHTML = `<span class="muted">Websuche nicht verfügbar (${esc(error.message)}). Radiopaedia, AO Surgery Reference oder Orthobullets manuell durchsuchen.</span>`; });
    }
    async function start(dropped) {
      $('#dossier').innerHTML = '<span class="thinking"><span class="spinner"></span> &nbsp;DER PRÜFER BEREITET DEN FALL VOR</span>';
      try {
        const [grounding, auto] = await Promise.all([groundingForCase(caseItem), dropped ? Promise.resolve([]) : imageCandidates(caseItem)]);
        let candidates = auto;
        if (dropped) { try { candidates = [{ src: dropped.src, url: await toDataUrl(dropped.src), credit: dropped.credit, note: dropped.note }]; candidates.note = ''; } catch { candidates = []; candidates.note = 'eigenes Bild nicht ladbar'; } }
        const memory = memoryFor(caseItem);
        const imageNotes = dropped && candidates.length
          ? `BILDER: 1 Bild ist angehängt, das der Kandidat selbst für dieses Thema recherchiert hat (${candidates[0].credit}${candidates[0].note ? ` · ${candidates[0].note}` : ''}). Baue den Fall darauf auf: "bild_geeignet" = true, "bild_index" = 0, Seite, Fraktur und Klassifikation exakt passend zum Bild; nur wenn es eindeutig kein medizinisches Bild oder ein anderes Thema ist: false.`
          : candidates.length
          ? `BILDER: ${candidates.length} Kandidatenbild(er) sind angehängt (0-basiert nummeriert, in Reihenfolge). Herkunft: ${candidates.map((c, i) => `[${i}] ${c.credit}${c.note ? ` · Folientext: ${c.note}` : ''}`).join(' | ')}. Wähle höchstens eines und nur, wenn du sicher bist.`
          : 'BILDER: keine Bilder verfügbar; "bild_geeignet" = false, "bild_index" = -1, "bild_befund" leer.';
        const dossier = await chatJSON({ system: 'Du bist Prüfungsexperte und erstellst Prüfungsdossiers. Antworte ausschliesslich mit dem verlangten JSON.', messages: [{ role: 'user', content: P.dossierPrompt(state.settings, caseItem, grounding, previous, difficulty, imageNotes, memory) }], schema: P.DOSSIER_SCHEMA, name: 'dossier', heavy: true, images: candidates.map((c) => c.url) });
        const chosen = dossier.bild_geeignet && candidates[dossier.bild_index] ? candidates[dossier.bild_index] : null;
        if (!chosen) { dossier.bild_geeignet = false; dossier.bild_index = -1; }
        session.dossier = dossier; session.image = chosen ? { src: chosen.src, credit: chosen.credit } : null;
        session.imageNote = chosen ? '' : (candidates.length ? `${candidates.length} Kandidatenbild(er) vom Prüfer als nicht eindeutig verworfen` : candidates.note || 'kein Bild');
        session.system = P.examinerSystem(state.settings, caseItem, dossier, grounding, memory);
        showDossier(dossier, session.image);
        $('#answer-box').hidden = false;
        startTimer();
        state.activeExam = { id: session.id, caseId }; clearTimeout(Store._timer); Store.flush();
        Store.putSession(session);
        if (!(state.settings.live && await live.start(false))) openStation(0);
        answerEl.focus();
      } catch (error) {
        $('#dossier').innerHTML = `<p class="warn">Fall konnte nicht erstellt werden: ${esc(error.message)}</p><button class="btn" onclick="location.reload()">NOCHMALS</button>`;
      }
    }

    async function send(onlyQuestion) {
      const text = answerEl.value.trim();
      if (busy) return;
      if (!text) { toast(onlyQuestion ? 'Rückfrage zuerst eintippen oder sprechen, dann RÜCKFRAGE drücken.' : 'Antwort eintippen oder sprechen.'); answerEl.focus(); return; }
      if (live.on) { answerEl.value = ''; live.typed(text, onlyQuestion); return; }
      busy = true; sendBtn.disabled = true; askBtn.disabled = true;
      addMsg('candidate', onlyQuestion ? `Rückfrage: ${text}` : text); answerEl.value = '';
      session.messages.push({ role: 'user', content: text });
      const i = session.station;
      if (!onlyQuestion) session.followup += 1;
      const isLast = i === P.STATIONS.length - 1;
      const thinking = document.createElement('div'); thinking.className = 'thinking'; thinking.innerHTML = '<span class="spinner"></span>'; transcriptEl.appendChild(thinking);
      try {
        const followupNo = onlyQuestion ? Math.min(session.followup + 1, followupsTotal) : session.followup;
        let control = onlyQuestion
          ? `[STATION ${i + 1}/5 · ${P.STATIONS[i].label}] Der Kandidat hat eine Rückfrage gestellt. Beantworte sie knapp aus dem Dossier (Feld "reaktion") und wiederhole in "frage" die noch offene Frage in einem Satz.`
          : P.turnPrompt(i, followupNo, followupsTotal, !isLast);
        // go back into the sources for this very answer: passages matching the station, the answer and the last question
        const lastQ = [...session.transcript].reverse().find((m) => m.role === 'examiner')?.text || '';
        const passages = await lookup(`${caseItem.title} ${P.STATIONS[i].label} ${lastQ} ${text}`, 3500, { k: 4 }).catch(() => '');
        if (passages) control += `\n\nNACHSCHLAG AUS DEN UNTERLAGEN DES KANDIDATEN zu dieser Antwort (nur für dich: daran die Antwort messen und die nächste Frage danach richten; nichts davon verraten):\n<<<\n${passages}\n>>>`;
        session.messages.push({ role: 'user', content: control });
        const turn = await chatJSON({ system: session.system, messages: session.messages, schema: P.TURN_SCHEMA, name: 'pruefer_zug' });
        session.messages.pop();
        session.messages.push({ role: 'assistant', content: JSON.stringify(turn) });
        thinking.remove();
        const spoken = [turn.reaktion, turn.frage].filter(Boolean).join(' ');
        if (spoken) addMsg('examiner', spoken);
        if (!onlyQuestion && !turn.frage) {
          if (isLast) { await finish(); return; }
          openStation(i + 1);
        } else if (!onlyQuestion && session.followup > followupsTotal) {
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
      live.stop(true);
      $('#answer-box').hidden = true;
      const thinking = document.createElement('div'); thinking.className = 'thinking'; thinking.innerHTML = '<span class="spinner"></span> &nbsp;BEWERTUNG'; transcriptEl.appendChild(thinking);
      const transcript = session.transcript.filter((m) => m.role !== 'system').map((m) => `${m.role === 'examiner' ? 'PRÜFER' : 'KANDIDAT'}: ${m.text}`).join('\n');
      const metrics = answerMetrics(session);
      const previousTips = (state.methodLog || []).slice(-4).map((m) => m.tipp);
      try {
        const examinerQs = session.transcript.filter((m) => m.role === 'examiner').map((m) => m.text).join(' ');
        const grounding = await groundingForCase(caseItem, 16000, `${session.dossier.loesung.diagnose} ${session.dossier.loesung.klassifikation} ${examinerQs}`.slice(0, 1500));
        const fb = await chatJSON({ system: 'Du bist Prüfungsexperte und bewertest nach dem offiziellen Schema. Antworte ausschliesslich mit dem verlangten JSON.', messages: [{ role: 'user', content: P.feedbackPrompt(state.settings, caseItem, session.dossier, transcript, metrics, previousTips, grounding) }], schema: P.FEEDBACK_SCHEMA, name: 'feedback', heavy: true });
        thinking.remove();
        session.feedback = fb; session.status = 'beendet'; session.endedAt = Date.now(); session.grade = fb.note;
        (state.caseLog[caseId] = state.caseLog[caseId] || []).push({ t: Date.now(), grade: fb.note, noten: fb.noten, sessionId: session.id, variant: session.dossier.titel, fehlend: (fb.fehlend || []).slice(0, 6) });
        if (fb.methodik?.tipp) (state.methodLog = state.methodLog || []).push({ t: Date.now(), caseId, tipp: fb.methodik.tipp, struktur: fb.noten?.struktur });
        state.activeExam = null; bump('exam');
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
        ${session.dossier.bild_befund ? `<p class="meta" style="margin-bottom:14px">BILDBEFUND · ${esc(session.dossier.bild_befund)}</p>` : ''}
        ${fb.methodik ? `<div class="methodik"><span class="label muted">METHODIK</span><div class="schema">${esc(fb.methodik.struktur)} ${esc(fb.methodik.tiefe)} ${esc(fb.methodik.laenge)}${fb.methodik.frueherer_tipp ? ` ${esc(fb.methodik.frueherer_tipp)}` : ''}</div><div class="tipp">${esc(fb.methodik.tipp)}</div></div>` : ''}
        <div class="grid2">
          <div><h3>Gefehlt / falsch</h3><ul class="clean">${(fb.fehlend || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
          <div>${fb.gut?.length ? `<h3>Gut</h3><ul class="clean">${fb.gut.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
            <h3 style="margin-top:${fb.gut?.length ? 18 : 0}px">Merksätze</h3><ul class="clean">${(fb.merksaetze || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        </div>
        <hr class="sep">
        <h3>Musterantwort-Gerüst</h3>
        <div class="muster">${P.STATIONS.map((s, i) => `<p><span class="label">${i + 1} · ${esc(s.label)}</span>${esc(fb.musterantwort[`station${i + 1}`])}</p>`).join('')}</div>
        <p class="meta">${added} NEUE ABFRAGE-ITEMS AUS DEINEN LÜCKEN</p>
        ${fb.quellen?.length ? `<p class="meta">QUELLEN · ${fb.quellen.map((q) => esc(q)).join(' · ')}</p>` : '<p class="meta">QUELLEN · keine passenden Auszüge in deinen Unterlagen gefunden</p>'}
        <div id="fb-fact">${session.factcheck ? factBlock(session.factcheck) : ''}</div>
        <div id="fb-discuss" style="margin:18px 0"></div>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="fb-again">GLEICHER FALL, NEUE VARIANTE</button><button class="btn" id="fb-next">NÄCHSTER OFFENER FALL</button><button class="btn ghost" id="fb-matrix">MATRIX</button></div>`;
      transcriptEl.appendChild(div); div.scrollIntoView({ behavior: 'smooth' });
      const transcript = session.transcript.filter((m) => m.role !== 'system').map((m) => `${m.role === 'examiner' ? 'PRÜFER' : 'KANDIDAT'}: ${m.text}`).join('\n');
      discussion($('#fb-discuss'), `FALL: ${caseItem.title}\nLÖSUNG: ${JSON.stringify(session.dossier.loesung)}\nBILDBEFUND: ${session.dossier.bild_befund || '-'}\nTRANSKRIPT:\n${transcript}\nBEWERTUNG: ${JSON.stringify(fb)}${session.factcheck ? `\nFAKTENCHECK: ${JSON.stringify(session.factcheck)}` : ''}`, session, () => Store.putSession(session), caseItem.title);
      if (!session.factcheck && state.settings.factCheck !== false && fb.pruefpunkte?.length) {
        const holder = $('#fb-fact'); holder.innerHTML = '<div class="fact"><span class="label muted">FAKTENCHECK · S-TIER-LITERATUR</span><div class="thinking"><span class="spinner"></span> &nbsp;PRÜFE GEGEN DIE LITERATUR</div></div>';
        factCheck(fb.pruefpunkte, `Prüfungsfall ${caseItem.title}; Diagnose ${session.dossier.loesung.diagnose}; ${session.dossier.loesung.klassifikation}. Behauptungen stammen aus der Musterantwort des Prüfers und aus den Unterlagen des Kandidaten.`)
          .then((befunde) => { session.factcheck = befunde; Store.putSession(session); if (holder.isConnected) holder.innerHTML = factBlock(befunde); })
          .catch((error) => { if (holder.isConnected) holder.innerHTML = `<div class="fact"><span class="label muted">FAKTENCHECK</span><p class="meta">nicht möglich · ${esc(error.message)}</p></div>`; });
      }
      $('#fb-again').onclick = () => { navigate(); };
      $('#fb-next').onclick = () => { const c = CASES.find((x) => caseSummary(x.id).runs === 0) || CASES[0]; location.hash = `#exam/${c.id}`; if (c.id === caseId) navigate(); };
      $('#fb-matrix').onclick = () => { location.hash = '#exam'; };
    }
    if (saved) resume(); else begin();
  }

  // ------------------------------------------------------------------ filters (shared by quiz/lazy)
  function filterBar(container, key, opts) {
    const f = state.lastFilters[key] || (state.lastFilters[key] = { regions: [], types: [], only: 'all', source: 'all', search: '', count: state.settings.quizCount || 20 });
    const count = () => filterItems(f, opts).length;
    container.innerHTML = `
      <div class="filters" id="f-regions">${P.REGIONS.map((r) => `<span class="pill clickable ${f.regions.includes(r) ? 'on' : ''}" data-r="${esc(r)}">${esc(r)}</span>`).join('')}</div>
      <div class="row">
        <input type="text" id="f-search" placeholder="Stichwort" value="${esc(f.search)}" style="max-width:260px">
        <select id="f-count" style="width:100px">${[10, 20, 40, 80, 999].map((n) => `<option value="${n}" ${f.count == n ? 'selected' : ''}>${n === 999 ? 'alle' : n}</option>`).join('')}</select>
        <span class="meta" id="f-count-label">${count()} ITEMS</span>
      </div>
      <details class="plain more-filters" ${f.types.length || f.only !== 'all' || f.source !== 'all' ? 'open' : ''}><summary>FILTER</summary>
        <div class="filters" id="f-types" style="margin-top:8px">${P.FILTER_TYPES.map((t) => `<span class="pill clickable ${f.types.includes(t) ? 'on' : ''}" data-t="${t}">${t}</span>`).join('')}
          <span style="width:12px"></span>
          ${[['all', 'alle'], ['due', 'fällig'], ['new', 'neu'], ['weak', 'schwach']].map(([v, l]) => `<span class="pill clickable ${f.only === v ? 'on' : ''}" data-only="${v}">${l}</span>`).join('')}
          <span style="width:12px"></span>
          ${[['all', 'seed + generiert'], ['seed', 'nur seed'], ['custom', 'nur generiert']].map(([v, l]) => `<span class="pill clickable ${f.source === v ? 'on' : ''}" data-src="${v}">${l}</span>`).join('')}
        </div>
      </details>`;
    const update = () => { $('#f-count-label').textContent = `${count()} ITEMS`; Store.saveState(); };
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
  // every classification and every decision algorithm from every presentation, once per deck (new decks only on a rerun)
  async function harvestDecks(report = () => {}) {
    if (!requireKey()) return 0;
    const done = state.harvested || (state.harvested = {});
    const list = decks().filter((d) => !done[d.name]);
    if (!list.length) { report('Alle Präsentationen sind schon geerntet.'); return 0; }
    let total = 0;
    for (const [i, d] of list.entries()) {
      report(`${d.name} · ${i + 1}/${list.length} … (${total} Items bisher)`);
      try {
        const text = await deckText(d);
        if (text) {
          const out = await chatJSON({ system: P.extractSystem(), messages: [{ role: 'user', content: P.harvestPrompt(d.name, d.title, text.slice(0, 24000)) }], schema: P.ITEMS_SCHEMA, name: 'items', heavy: true });
          total += await addItems((out.items || []).filter((it) => it.typ === 'klassifikation' || it.typ === 'algorithmus'), `ernte ${d.name}`, d.caseIds);
        }
        done[d.name] = Date.now(); Store.saveState();
      } catch (error) { report(`${d.name}: ${error.message}`); await sleep(1500); }
    }
    clearTimeout(Store._timer); await Store.flush();
    report(`Ernte fertig · ${total} neue Items aus ${list.length} Präsentationen`);
    return total;
  }
  function presetClassAlgo(f, key, container, opts) { f.types = ['klassifikation', 'algorithmus']; f.only = 'all'; Store.saveState(); filterBar(container, key, opts); }
  async function generateMore(f, n = 15) {
    if (!requireKey()) return 0;
    const region = f.regions[0] || P.REGIONS[Math.floor(Math.random() * P.REGIONS.length)];
    const existing = filterItems({ regions: [region], search: f.search }, { noImages: true }).map((it) => it.q).slice(-120);
    const grounding = await groundingForRegion(region, 12000, f.search || '');
    const out = await chatJSON({ system: P.generateSystem(), messages: [{ role: 'user', content: P.generatePrompt(region, f.search, n, existing, grounding) }], schema: P.ITEMS_SCHEMA, name: 'items', heavy: true });
    return addItems(out.items || [], `generiert ${region}`, []);
  }

  // ------------------------------------------------------------------ QUIZ
  // A quiz or lazy session lives in state.sessions[key] until it is finished or discarded,
  // so a refresh or a detour to another view never loses it.
  function savedSession(key) { const sess = (state.sessions || {})[key]; return sess && sess.i < sess.ids.length ? sess : null; }
  function saveSession(key, sess) { (state.sessions = state.sessions || {})[key] = sess; clearTimeout(Store._timer); Store.flush(); }
  function clearSession(key) { if (state.sessions) delete state.sessions[key]; clearTimeout(Store._timer); Store.flush(); }
  function itemsById(ids) { const map = new Map(allItems().map((it) => [it.id, it])); return ids.map((id) => map.get(id)).filter(Boolean); }
  function resumeBar(key, onResume) {
    const sess = savedSession(key); if (!sess) return '';
    return `<div class="row resume" style="margin-bottom:18px"><button class="btn primary" id="btn-resume">FORTSETZEN · ${sess.i}/${sess.ids.length}</button><button class="btn ghost" id="btn-discard">VERWERFEN</button><span class="meta">SESSION VOM ${new Date(sess.startedAt).toLocaleDateString('de-CH')}</span></div>`;
  }
  function wireResume(key, run) {
    const sess = savedSession(key); if (!sess) return;
    $('#btn-resume').onclick = () => { $('#filters').hidden = true; $('#btn-start').parentElement.hidden = true; $('.resume').hidden = true; run(sess); };
    $('#btn-discard').onclick = () => { clearSession(key); navigate(); };
  }
  function renderQuiz() {
    view.innerHTML = `${hero('ABFRAGE', 'Abfrage')}${resumeBar('quiz')}<div id="filters"></div><div class="row" style="margin-top:18px"><button class="btn primary" id="btn-start">START</button><button class="btn" id="btn-preset" title="Filter auf Klassifikationen und Algorithmen">KLASSIFIKATIONEN & ALGORITHMEN</button><button class="btn ghost" id="btn-gen">15 NEUE FRAGEN</button><button class="btn ghost" id="btn-harvest" title="Geht einmal durch jede Präsentation und holt jede Klassifikation und jeden Algorithmus als Item">AUS ALLEN PRÄSENTATIONEN ERNTEN</button><span class="meta" id="harvest-msg"></span></div><div id="stage" style="margin-top:28px"></div>`;
    const f = filterBar($('#filters'), 'quiz', {});
    $('#btn-preset').onclick = () => { presetClassAlgo(f, 'quiz', $('#filters'), {}); toast('Nur Klassifikationen & Algorithmen'); };
    $('#btn-harvest').onclick = async () => {
      const b = $('#btn-harvest'); b.disabled = true; const msg = $('#harvest-msg');
      try { const n = await harvestDecks((t) => { if (msg) msg.textContent = t; }); toast(`${n} neue Items`); if ($('#f-count-label')) $('#f-count-label').textContent = `${filterItems(f).length} ITEMS`; }
      catch (error) { toast(error.message, true); }
      b.disabled = false;
    };
    wireResume('quiz', (sess) => runQuiz(sess, $('#stage')));
    $('#btn-gen').onclick = async () => {
      const b = $('#btn-gen'); b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
      try { const n = await generateMore(f); toast(`${n} neue Items`); $('#f-count-label').textContent = `${filterItems(f).length} ITEMS`; }
      catch (error) { toast(error.message, true); }
      b.disabled = false; b.textContent = '15 NEUE FRAGEN';
    };
    $('#btn-start').onclick = () => {
      if (!requireKey()) return;
      const items = pickSession(filterItems(f), f.count);
      if (!items.length) { toast('Keine Items für diese Auswahl.', true); return; }
      $('#filters').hidden = true; $('#btn-start').parentElement.hidden = true; if ($('.resume')) $('.resume').hidden = true;
      const sess = { ids: items.map((it) => it.id), i: 0, results: [], requeue: [], startedAt: Date.now(), verdict: null };
      saveSession('quiz', sess);
      runQuiz(sess, $('#stage'));
    };
  }
  function runQuiz(sess, stage) {
    let busy = false; let liveChat = null;
    const save = () => saveSession('quiz', sess);
    const counts = () => `${sess.results.filter((r) => r === 2).length} ✓ · ${sess.results.filter((r) => r === 1).length} ~ · ${sess.results.filter((r) => r === 0).length} ✗`;
    function show() {
      if (liveChat) { liveChat.stop(); liveChat = null; }
      const item = itemsById([sess.ids[sess.i]])[0];
      if (sess.i >= sess.ids.length) return summary();
      if (!item) { sess.i += 1; save(); return show(); }
      const s = stats(item.id);
      stage.innerHTML = `
        <div class="quiz-head"><span class="meta">${sess.i + 1}/${sess.ids.length} · ${esc(item.region)}${s.seen ? ` · BOX ${s.box}` : ''}</span><span class="meta">${counts()}</span></div>
        <div class="meta">${esc(item.topic)}</div>
        <div class="quiz-q">${esc(item.q)} ${sayHtml(item.q)}</div>
        ${item.img ? `<div class="quiz-img"><img src="${esc(item.img)}" data-zoom alt=""></div>` : ''}
        <div id="q-media"></div>
        <div id="ask"><textarea class="answer" id="answer" placeholder="Antwort · Enter sendet, Shift+Enter neue Zeile"></textarea>
        <div class="answer-tools"><button class="btn rec" id="mic">● SPRECHEN</button><span class="spacer"></span><button class="btn ghost" id="btn-skip">WEISS ICH NICHT</button><button class="btn primary" id="btn-send">ANTWORTEN</button></div></div>
        <div id="verdict"></div>`;
      const ta = $('#answer');
      wireMic($('#mic'), ta);
      $('#mic').after(readToggle());
      if (!sess.verdict) mountMedia($('#q-media'), item, false);
      if (!sess.verdict && state.settings.examinerVoice) say(item.q);
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sess.verdict) $('#btn-send').click(); } });
      $('#btn-send').onclick = () => grade(item, ta.value.trim());
      $('#btn-skip').onclick = () => grade(item, '');
      if (sess.verdict) showVerdict(item); else ta.focus();
    }
    async function grade(item, answer) {
      if (busy) return; busy = true;
      $('#btn-send').disabled = true; $('#btn-skip').disabled = true;
      let result; let modelAnswer = item.a;
      $('#verdict').innerHTML = '<div class="thinking" style="margin-top:14px"><span class="spinner"></span></div>';
      try {
        if (item.type === 'bild') {
          const url = await toDataUrl(item.img);
          result = await chatJSON({ system: P.imageGradeSystem(state.settings), messages: [{ role: 'user', content: P.imageGradePrompt(item, answer) }], schema: P.IMAGE_GRADE_SCHEMA, name: 'bildkorrektur', images: [url] });
          modelAnswer = result.musterantwort || item.a;
        } else if (!answer) result = { score: 0, urteil: 'Keine Antwort.', fehlend: [] };
        else { const passages = await lookup(`${item.topic || ''} ${item.q} ${item.a}`, 2500, { k: 3 }).catch(() => ''); result = await chatJSON({ system: P.gradeSystem(state.settings), messages: [{ role: 'user', content: P.gradePrompt(item, answer, passages) }], schema: P.GRADE_SCHEMA, name: 'korrektur' }); }
      } catch (error) { $('#verdict').innerHTML = `<p class="warn">${esc(error.message)}</p>`; $('#btn-send').disabled = false; $('#btn-skip').disabled = false; busy = false; return; }
      const score = Math.max(0, Math.min(2, Number(result.score) || 0));
      sess.results.push(score); schedule(item.id, score); bump('quiz'); if (score === 2) bump('quizRight');
      if (score === 0 && !sess.requeue.includes(item.id) && sess.ids.length < 60) { sess.requeue.push(item.id); sess.ids.push(item.id); }
      sess.verdict = { score, modelAnswer, urteil: result.urteil || '', fehlend: result.fehlend || [], answer, discussion: [] };
      save(); busy = false;
      showVerdict(item);
    }
    function showVerdict(item) {
      const v = sess.verdict; const score = v.score;
      $('#ask').hidden = true;
      $('#verdict').innerHTML = `
        <div class="verdict s${score}">
          <span class="label ${score === 2 ? 'ok' : score === 1 ? 'signal' : 'warn'}">${score === 2 ? 'KORREKT' : score === 1 ? 'TEILWEISE' : 'FALSCH'}</span>
          ${v.answer ? `<div class="judge" style="margin:0 0 10px">DU: ${esc(v.answer)}</div>` : ''}
          <div class="model">${esc(v.modelAnswer)} ${sayHtml(v.modelAnswer)}</div>
          <div class="judge">${esc(v.urteil)}${v.fehlend?.length ? ` · fehlt: ${esc(v.fehlend.join(', '))}` : ''}</div>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="btn-next">WEITER <span class="kbd">↵</span></button><button class="btn ghost small" id="btn-fact" title="Musterantwort gegen die Literatur prüfen">FAKTENCHECK</button><button class="btn ghost small" id="btn-fix" title="Musterantwort falsch oder unpassend">MELDEN</button></div>
          <div id="q-fact">${v.factcheck ? factBlock(v.factcheck) : ''}</div>
          <div id="q-discuss" style="margin-top:14px"></div>
        </div>`;
      $('#btn-next').onclick = next; $('#btn-next').focus();
      mountMedia($('#q-media'), item, true);
      $('#btn-fact').onclick = async () => {
        if (!requireKey()) return; const b = $('#btn-fact'); b.disabled = true; const holder = $('#q-fact');
        holder.innerHTML = '<div class="fact"><div class="thinking"><span class="spinner"></span> &nbsp;PRÜFE GEGEN DIE LITERATUR</div></div>';
        try {
          const befunde = await factCheck([`${item.q} → ${v.modelAnswer}`], `Abfrage-Item (${item.region}${item.topic ? ` · ${item.topic}` : ''}) aus den Unterlagen des Kandidaten.`);
          v.factcheck = befunde; save(); holder.innerHTML = factBlock(befunde);
          const fix = befunde.find((x) => x.status === 'korrigiert' && x.korrektur);
          if (fix && item.id.startsWith('c-')) { const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = 'MUSTERANTWORT KORRIGIEREN'; btn.onclick = async () => { const it = customBank.find((x) => x.id === item.id); if (it) { it.a = fix.korrektur; it.corrected = fix.quelle || fix.url || 'Faktencheck'; await Store.saveBank(); toast('Musterantwort ersetzt'); btn.remove(); } }; holder.querySelector('.fact').appendChild(btn); }
        } catch (error) { holder.innerHTML = `<p class="warn">${esc(error.message)}</p>`; }
        b.disabled = false;
      };
      $('#btn-fix').onclick = () => { const s = stats(item.id); s.flag = !s.flag; state.items[item.id] = s; Store.saveState(); toast(s.flag ? 'Markiert · unter STATUS' : 'Markierung entfernt'); };
      liveChat = discussion($('#q-discuss'), `FRAGE: ${item.q}\nMUSTERANTWORT: ${v.modelAnswer}\nANTWORT DES KANDIDATEN: ${v.answer || '(keine)'}\nBEWERTUNG: ${score}/2 · ${v.urteil}${v.fehlend?.length ? ` · fehlt: ${v.fehlend.join(', ')}` : ''}`, v, save, `${item.topic || ''} ${item.q}`);
      if (state.settings.examinerVoice) say(v.modelAnswer);
    }
    function onKey(e) { if (sess.verdict && e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') { e.preventDefault(); next(); } }
    document.addEventListener('keydown', onKey);
    currentCleanup = () => document.removeEventListener('keydown', onKey);
    function next() { distillThread(sess.verdict); sess.i += 1; sess.verdict = null; save(); show(); }
    function summary() {
      document.removeEventListener('keydown', onKey);
      const n = sess.results.length; const pts = sess.results.reduce((a, b) => a + b, 0);
      clearSession('quiz');
      stage.innerHTML = `<span class="kicker">FERTIG</span><div class="row" style="gap:24px"><div class="big-grade">${n ? Math.round(100 * pts / (2 * n)) : 0}%</div><div class="meta">${n} FRAGEN · ${counts()}</div></div><div class="row" style="margin-top:22px"><button class="btn primary" id="again">NOCHMALS</button><button class="btn ghost" id="to-status">STATUS</button></div>`;
      $('#again').onclick = () => navigate(); $('#to-status').onclick = () => { location.hash = '#status'; };
    }
    show();
  }

  // ------------------------------------------------------------------ LAZY
  function renderLazy() {
    view.innerHTML = `${hero('LAZY · <span class="kbd">Space</span> ZEIGT · <span class="kbd">1</span> <span class="kbd">2</span> <span class="kbd">3</span> BEWERTEN', 'Lazy')}${resumeBar('lazy')}<div id="filters"></div><div class="row" style="margin-top:18px"><button class="btn primary" id="btn-start">START</button><button class="btn" id="btn-preset" title="Filter auf Klassifikationen und Algorithmen">KLASSIFIKATIONEN & ALGORITHMEN</button><button class="btn ghost ${state.settings.readAloud ? 'on' : ''}" id="btn-read">VORLESEN ${state.settings.readAloud ? 'AN' : 'AUS'}</button></div><div id="stage" style="margin-top:28px"></div>`;
    const f = filterBar($('#filters'), 'lazy', { lazy: true });
    $('#btn-preset').onclick = () => { presetClassAlgo(f, 'lazy', $('#filters'), { lazy: true }); toast('Nur Klassifikationen & Algorithmen'); };
    wireResume('lazy', (sess) => runLazy(sess, $('#stage')));
    $('#btn-read').onclick = (e) => { state.settings.readAloud = !state.settings.readAloud; Store.saveState(); e.target.classList.toggle('on'); e.target.textContent = `VORLESEN ${state.settings.readAloud ? 'AN' : 'AUS'}`; };
    $('#btn-start').onclick = () => {
      const items = pickSession(filterItems(f, { lazy: true }), f.count);
      if (!items.length) { toast('Keine Items für diese Auswahl.', true); return; }
      $('#filters').hidden = true; $('#btn-start').parentElement.hidden = true; if ($('.resume')) $('.resume').hidden = true;
      const sess = { ids: items.map((it) => it.id), i: 0, results: [], startedAt: Date.now() };
      saveSession('lazy', sess);
      runLazy(sess, $('#stage'));
    };
  }
  function runLazy(sess, stage) {
    let revealed = false; let liveChat = null;
    const save = () => saveSession('lazy', sess);
    const counts = () => `${sess.results.filter((r) => r === 2).length} ✓ · ${sess.results.filter((r) => r === 1).length} ~ · ${sess.results.filter((r) => r === 0).length} ✗`;
    function current() { return itemsById([sess.ids[sess.i]])[0]; }
    function show() {
      if (liveChat) { liveChat.stop(); liveChat = null; }
      if (sess.i >= sess.ids.length) return summary();
      const item = current(); if (!item) { sess.i += 1; save(); return show(); }
      revealed = false;
      stage.innerHTML = `
        <div class="quiz-head"><span class="meta">${sess.i + 1}/${sess.ids.length} · ${esc(item.region)}</span><span class="meta">${counts()}</span></div>
        <div class="meta">${esc(item.topic)}</div>
        <div class="quiz-q">${esc(item.q)} ${sayHtml(item.q)}</div>
        ${item.img ? `<div class="quiz-img"><img src="${esc(item.img)}" data-zoom alt=""></div>` : ''}
        <div id="q-media"></div>
        <div id="a"><button class="btn" id="btn-reveal">ANTWORT <span class="kbd">Space</span></button></div>`;
      $('#btn-reveal').onclick = reveal;
      mountMedia($('#q-media'), item, false);
      if (sess.talk && sess.talk.id === item.id) { reveal(); return; } // the card was open (and maybe discussed) before a reload
      if (state.settings.readAloud) readAloud(item.q);
    }
    function reveal() {
      if (revealed) return; revealed = true;
      const item = current();
      $('#a').innerHTML = `<div class="lazy-a">${esc(item.a)}</div>
        <div class="rate"><button class="btn danger" data-s="0">NICHT GEWUSST <span class="kbd">1</span></button><button class="btn" data-s="1">HALB <span class="kbd">2</span></button><button class="btn on" data-s="2">GEWUSST <span class="kbd">3</span></button></div>
        <div id="lazy-discuss" style="margin-top:16px"></div>`;
      $('#a').querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => rate(Number(b.dataset.s)); });
      // talk to the examiner about this card: why, how to say it, what hangs together with it
      if (!sess.talk || sess.talk.id !== item.id) sess.talk = { id: item.id, discussion: [] };
      mountMedia($('#q-media'), item, true);
      liveChat = discussion($('#lazy-discuss'), `LAZY-KARTE (nicht bewertet; der Kandidat hat die Antwort gelesen und will sie verstehen oder üben)\nFRAGE: ${item.q}\nMUSTERANTWORT: ${item.a}`, sess.talk, save, `${item.topic || ''} ${item.q}`, { open: true, greeting: 'Sage in einem Satz, dass der Kandidat jetzt zu dieser Karte nachfragen oder sich abfragen lassen kann.' });
      save();
      if (state.settings.readAloud) readAloud(item.a);
    }
    function rate(score) { const item = current(); sess.results.push(score); schedule(item.id, score); bump('lazy'); sess.i += 1; distillThread(sess.talk); sess.talk = null; save(); show(); }
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || !lightbox.hidden) return;
      if (e.key === ' ') { e.preventDefault(); reveal(); }
      if (revealed && ['1', '2', '3'].includes(e.key)) rate(Number(e.key) - 1);
    }
    document.addEventListener('keydown', onKey);
    currentCleanup = () => document.removeEventListener('keydown', onKey);
    function summary() {
      document.removeEventListener('keydown', onKey);
      const n = sess.results.length; const pts = sess.results.reduce((a, b) => a + b, 0);
      clearSession('lazy');
      stage.innerHTML = `<span class="kicker">FERTIG</span><div class="row" style="gap:24px"><div class="big-grade">${n ? Math.round(100 * pts / (2 * n)) : 0}%</div><div class="meta">${n} KARTEN</div></div><div class="row" style="margin-top:22px"><button class="btn primary" id="again">NOCHMALS</button></div>`;
      $('#again').onclick = () => navigate();
    }
    show();
  }

  // ------------------------------------------------------------------ FREE
  // Every conversation is a thread, saved in userdata/sessions (kind "frei") and reopenable under GESPRÄCHE;
  // a thread with substance is distilled into the strengths / weaknesses profile when it ends. Focus: a case,
  // a region, the candidate's weaknesses (SCHWÄCHEN DRILLEN), or nothing at all: then the examiner picks.
  function renderFree(arg) {
    const regionOptions = ['', ...P.REGIONS].map((r) => `<option value="${esc(r)}">${r ? esc(r) : 'Region'}</option>`).join('');
    const caseOptions = ['', ...CASES.map((c) => c.id)].map((id) => `<option value="${id}">${id ? esc(`${id.toUpperCase()} · ${caseById(id).title}`) : 'Fall'}</option>`).join('');
    view.innerHTML = `
      ${hero('FREI', 'Frei')}
      <div class="row" style="margin-bottom:10px"><select id="free-region" style="max-width:240px">${regionOptions}</select><select id="free-case" style="max-width:400px">${caseOptions}</select><span class="pill clickable" id="free-weak" title="Der Prüfer fragt deine schwächsten Themen ab, der Reihe nach">SCHWÄCHEN DRILLEN</span></div>
      <div class="row" style="margin-bottom:14px"><button class="btn primary big" id="free-start">START</button><button class="btn ghost small" id="free-reset" title="Neues Gespräch, gleicher Fokus">NEU</button><span class="meta" id="free-hint"></span></div>
      <div class="quick" id="quick">
        <span class="pill clickable" data-q="Frag mich 10 Klassifikationen aus dieser Region ab, eine nach der anderen: ich nenne alle Typen mit Konsequenz, du korrigierst.">10 KLASSIFIKATIONEN</span>
        <span class="pill clickable" data-q="Frag mich die Therapie- und Entscheidungsalgorithmen dieser Region ab, einen pro Zug: ich sage die Schritte mit Grenzwerten, du korrigierst.">ALGORITHMEN</span>
        <span class="pill clickable" data-q="Frag mich 10 Begriffe ab: 'Was ist ein/eine ...?' – eine Frage pro Zug.">10 BEGRIFFE</span>
        <span class="pill clickable" data-q="Simuliere die Station 'Therapeutische Optionen, Indikation, Risiken, Aufklärung' zu diesem Fall. Stelle die Eröffnungsfrage.">STATION THERAPIE</span>
        <span class="pill clickable" data-q="Erkläre mir die wichtigsten AO-Grundprinzipien zu diesem Thema (absolute vs. relative Stabilität, Implantatwahl), dann prüfe mich.">AO-PRINZIPIEN</span>
        <span class="pill clickable" data-q="Gib mir die Zahlen und Grenzwerte dieser Region als Liste, dann frag mich 5 davon ab.">ZAHLEN</span>
      </div>
      <details class="plain" id="free-threads" style="margin:0 0 14px"><summary>GESPRÄCHE</summary><ul class="clean" id="free-thread-list" style="margin-top:8px"></ul></details>
      <div id="deck-strip"></div>
      <div class="chat" id="chat"></div>
      <div class="answer-box">
        <textarea class="answer" id="answer" placeholder="Nachricht · ⌘/Ctrl+Enter sendet"></textarea>
        <div class="answer-tools"><button class="btn rec" id="mic">● SPRECHEN</button><span class="spacer"></span><button class="btn primary" id="btn-send">SENDEN</button></div>
      </div>`;
    const chat = $('#chat'); const ta = $('#answer'); let busy = false; let weak = arg === 'weak';
    const weakPill = $('#free-weak');
    const newThread = () => ({ id: `f${uid()}`, kind: 'frei', title: '', focus: null, context: '', decks: [], startedAt: Date.now(), updatedAt: Date.now(), n: 0, messages: [], profiled: false });
    const threadDecks = () => (thread.decks || []).map((n) => deckByName(n)).filter(Boolean);
    function paintDecks() {
      const list = threadDecks(); const el = $('#deck-strip'); if (!el) return;
      el.innerHTML = list.length ? list.map((d) => `<div class="deck"><span class="label muted">PRÄSENTATION · ${esc(d.name)}${d.title ? ` · ${esc(d.title)}` : ''}${d.slides ? ` · ${d.slides} FOLIEN` : ''}</span><div class="thumbs">${d.images.map((i) => `<figure><img src="${esc(i.src)}" data-zoom alt=""><figcaption>FOLIE ${i.slide}</figcaption></figure>`).join('')}</div></div>`).join('') : '';
    }
    function attachDecks(list) { const names = [...new Set([...(thread.decks || []), ...list.map((d) => d.name)])].slice(0, 3); const changed = names.length !== (thread.decks || []).length; thread.decks = names; if (changed) { paintDecks(); saveThread(); } }
    function showSlide(n, name) {
      const list = threadDecks(); const d = (name && deckByName(name)) || list.find((x) => x.images.some((i) => i.slide === n)) || list[0];
      if (!d) return 'Keine Präsentation geladen: zuerst praesentation_laden.';
      const fig = slideFigures([n], [d], false);
      const div = document.createElement('div'); div.className = 'msg examiner'; div.innerHTML = `<div class="who">FOLIE ${n} · ${esc(d.name)}</div>`;
      if (fig) div.appendChild(fig); else { const b = document.createElement('div'); b.className = 'body faint'; b.textContent = `Folie ${n} hat kein Bild.`; div.appendChild(b); }
      chat.appendChild(div); div.scrollIntoView({ block: 'nearest' });
      const txt = slideText(d, n);
      return `${fig ? `Folie ${n} angezeigt (Bild).` : `Folie ${n} hat kein Bild.`}${txt ? ` Folientext: ${txt.slice(0, 1200)}` : ''}`;
    }
    let thread = newThread(); let saveTimer = null;
    const selection = () => { const region = $('#free-region').value; const cid = $('#free-case').value; return { region, cid, c: cid ? caseById(cid) : null, weak }; };
    const focusLabel = (sel) => (sel.weak ? `Schwächen${sel.region ? ` · ${sel.region}` : ''}` : sel.c ? `Fall ${sel.c.id.toUpperCase()} · ${sel.c.title} (${sel.c.region})` : sel.region ? `Region ${sel.region}` : '');
    function paintStart() {
      const label = focusLabel(selection());
      $('#free-start').textContent = label ? `START · ${label.toUpperCase().slice(0, 44)}` : 'START · FREI';
      $('#free-hint').textContent = label ? '' : 'Kein Thema gewählt: der Prüfer sucht selbst eines aus.';
      weakPill.classList.toggle('on', weak);
    }
    $('#free-region').onchange = paintStart;
    $('#free-case').onchange = () => { if ($('#free-case').value) weak = false; paintStart(); };
    weakPill.onclick = () => { weak = !weak; if (weak) $('#free-case').value = ''; paintStart(); };
    paintStart();
    wireMic($('#mic'), ta);
    $('#mic').after(readToggle());
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#btn-send').click(); } });
    $('#quick').onclick = (e) => { const pl = e.target.closest('.pill'); if (pl) { ta.value = pl.dataset.q; ta.focus(); } };
    function saveThread() {
      thread.n = thread.messages.filter((m) => m.content).length; if (!thread.n) return;
      const sel = selection(); thread.focus = { region: sel.region, cid: sel.cid, weak: sel.weak }; thread.title = thread.title || focusLabel(sel) || 'Frei'; thread.updatedAt = Date.now();
      clearTimeout(saveTimer); saveTimer = setTimeout(() => { Store.putSession(thread); listThreads(); }, 600);
    }
    function startThread() { const old = thread; thread = newThread(); chat.innerHTML = ''; paintDecks(); distillThread(old); }
    // what the candidate picked: told to the examiner explicitly and used to anchor the retrieval
    async function freeContext(text, live = false) {
      const sel = selection(); const label = focusLabel(sel);
      let focus = ''; let plan = ''; let grounding = '';
      if (sel.weak) {
        const w = weaknessText(sel.region || null);
        focus = `das gezielte Abfragen seiner Schwächen${sel.region ? ` in der Region ${sel.region}` : ''}`;
        plan = w
          ? `SCHWÄCHENPROFIL des Kandidaten (aus Abfragen, Fallprüfungen und früheren Gesprächen), schwächste zuerst:\n${w}`
          : 'Noch kein Schwächenprofil vorhanden: finde Schwächen durch Abfragen quer durch die Regionen.';
        grounding = sel.region ? await groundingForRegion(sel.region, 9000, w.slice(0, 300)) : await lookup(`${w.slice(0, 800)} ${text}`, 9000, { k: 10 }).catch(() => '');
      } else {
        if (sel.c) { focus = `den ${label}`; grounding = await groundingForCase(sel.c, 12000, text); }
        else if (sel.region) { focus = `die ${label}`; grounding = await groundingForRegion(sel.region, 9000, text); }
        const anchor = sel.c ? sel.c.title : sel.region;
        const passages = await lookup(`${anchor || ''} ${text}`, anchor ? 4000 : 9000, { k: 8, boost: sel.c ? (x) => (x.caseId === sel.c.id ? 1.6 : 1) : null }).catch(() => '');
        if (passages) grounding = `${passages}${grounding ? `\n\n${grounding}` : ''}`;
      }
      if (thread.context) plan = `${plan ? `${plan}\n` : ''}KONTEXT DIESES GESPRÄCHS (woraus es entstand):\n${thread.context}`;
      // presentations: the examiner knows which exist; one the message names (or "die Präsentation" of the chosen case) is attached whole
      const found = detectDecks(text, sel); if (found.length) attachDecks(found);
      const attached = threadDecks();
      const deckPart = attached.length ? `${await deckBlock(attached)}\n${live ? P.WALKTHROUGH_LIVE : P.WALKTHROUGH}` : (live ? P.WALKTHROUGH_LIVE : P.WALKTHROUGH);
      plan = `${plan ? `${plan}\n\n` : ''}UNTERLAGEN DES KANDIDATEN · PRÄSENTATIONEN:\n${deckList()}\n\n${deckPart}`;
      return { system: P.freeSystem(state.settings, grounding, memoryFor(sel.c, sel.region || null), focus, plan), label, sel };
    }
    function add(role, text) {
      const div = document.createElement('div'); div.className = `msg ${role}`;
      div.innerHTML = `<div class="who">${role === 'examiner' ? 'PRÜFER <button class="say" type="button" title="Vorlesen">▶</button>' : 'DU'}</div><div class="body"></div>`;
      const body = div.querySelector('.body'); body.textContent = text;
      const b = div.querySelector('.say'); if (b) b.onclick = () => say(body.textContent);
      chat.appendChild(div); return body;
    }
    const liveFree = attachLive($('.answer-tools'), {
      add,
      system: async () => (await freeContext('', true)).system,
      onTurn: (entry, fresh) => { if (fresh) thread.messages.push(entry); saveThread(); },
      history: () => thread.messages,
      greeting: 'Begrüsse den Kandidaten in einem kurzen Satz, nenne den Fokus und stelle sofort die erste Prüferfrage dazu.',
      extraTools: [
        { ...P.DECK_TOOLS[0], run: async (args) => { const d = deckByName(args.name); if (!d) return `Nicht gefunden. Verfügbare Präsentationen:\n${deckList()}`; attachDecks([d]); return (await deckBlock([d])) || 'Kein Text in dieser Präsentation.'; } },
        { ...P.DECK_TOOLS[1], run: async (args) => showSlide(Number(args.nummer) || 1, args.name) },
      ],
    });
    // START: new thread, examiner briefed on the chosen focus and begins (re-briefs a running call, connects otherwise)
    $('#free-start').onclick = async () => {
      if (!requireKey()) return;
      const b = $('#free-start'); b.disabled = true;
      try {
        startThread();
        const { label, sel } = await freeContext('');
        const note = sel.weak
          ? `Neuer Fokus: ${label}. Sage in einem Satz, dass du jetzt die Schwächen abfragst, und stelle sofort die erste Frage zum schwächsten Punkt.`
          : label ? `Neuer Fokus: ${label}. Sage das in einem Satz und stelle sofort die erste Prüferfrage dazu.`
            : 'Kein Fokus gewählt: wähle selbst ein prüfungsrelevantes Thema, nenne es in einem Satz und stelle sofort die erste Prüferfrage.';
        if (liveFree && liveFree.on()) await liveFree.rebrief(note);
        else if (liveFree) await liveFree.start(note);
        else add('examiner', label ? `Fokus: ${label}. Schreiben Sie los, oder sagen Sie "Fall" oder "Abfrage".` : 'Schreiben Sie los, oder sagen Sie "Fall" oder "Abfrage".');
      } catch (error) { toast(error.message, true); }
      b.disabled = false; paintStart(); ta.focus();
    };
    $('#free-reset').onclick = () => { startThread(); paintStart(); ta.focus(); };
    $('#btn-send').onclick = async () => {
      const text = ta.value.trim(); if (!text || busy || !requireKey()) return;
      busy = true; ta.value = ''; add('candidate', text); thread.messages.push({ role: 'user', content: text }); saveThread();
      const body = add('examiner', ''); body.innerHTML = '<span class="spinner"></span>';
      try {
        const { system } = await freeContext(text);
        const full = await chatStream({ system, messages: thread.messages.filter((m) => m.content), onDelta: (t) => { body.textContent = t; } });
        body.textContent = full; thread.messages.push({ role: 'assistant', content: full }); saveThread();
        renderSlideRefs(body, full, threadDecks());
        if (state.settings.examinerVoice) speak(full.slice(0, 600));
      } catch (error) { body.innerHTML = `<span class="warn">${esc(error.message)}</span>`; }
      busy = false; ta.focus(); body.scrollIntoView({ block: 'nearest' });
    };
    // earlier conversations (FREI and NACHFRAGEN), newest first; click to continue one
    async function listThreads() {
      const el = $('#free-thread-list'); if (!el) return;
      const all = await Store.listSessions();
      const threads = all.filter((x) => x && (x.kind === 'frei' || x.kind === 'nachfrage') && x.n).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 25);
      const sum = $('#free-threads summary'); if (sum) sum.textContent = `GESPRÄCHE · ${threads.length}`;
      el.innerHTML = threads.length
        ? threads.map((t) => `<li><a href="#" data-thread="${esc(t.id)}">${esc(t.title || 'Frei')}</a> <span class="faint">· ${new Date(t.updatedAt || t.startedAt).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${t.n} Nachrichten${t.kind === 'nachfrage' ? ' · Nachfrage' : ''}</span></li>`).join('')
        : '<li class="muted">Noch keine.</li>';
    }
    $('#free-thread-list').onclick = async (e) => {
      const a = e.target.closest('[data-thread]'); if (!a) return; e.preventDefault();
      const full = await Store.getSession(a.dataset.thread); if (!full) { toast('Gespräch nicht gefunden', true); return; }
      distillThread(thread);
      thread = { ...full, kind: full.kind || 'frei', messages: full.messages || full.discussion || [], context: full.context || '', decks: full.decks || [], n: 0 };
      chat.innerHTML = ''; for (const m of thread.messages) if (m.content) { const b = add(m.role === 'assistant' ? 'examiner' : 'candidate', m.content); if (m.role === 'assistant') renderSlideRefs(b, m.content, threadDecks()); }
      paintDecks();
      if (thread.focus) { $('#free-region').value = thread.focus.region || ''; $('#free-case').value = thread.focus.cid || ''; weak = !!thread.focus.weak; }
      paintStart();
      if (liveFree && liveFree.on()) { liveFree.stop(); await liveFree.start('Das frühere Gespräch wird fortgesetzt: knüpfe in einem Satz daran an und stelle die nächste Frage.'); }
      toast('Gespräch geladen'); ta.focus();
    };
    listThreads();
    const prevCleanup = currentCleanup; currentCleanup = () => { clearTimeout(saveTimer); if (thread.n) Store.putSession(thread); distillThread(thread); if (prevCleanup) prevCleanup(); };
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
        for (const src of JSZIP_SOURCES) { try { await loadScript(src); if (window.JSZip) return window.JSZip; } catch { /* next */ } }
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
  async function extractPptx(file, progress, images) {
    const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(file);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const out = []; const seen = new Set();
    for (const [idx, name] of slides.entries()) {
      const num = name.match(/\d+/)[0];
      const xml = await zip.file(name).async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const paras = Array.from(doc.getElementsByTagNameNS('*', 'p')).map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).filter((t) => t.trim());
      const notes = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
      if (notes) { const t = xmlText(await notes.async('string'), 't').trim(); if (t && !/^\d+$/.test(t)) paras.push(`[Notiz] ${t}`); }
      if (paras.length) out.push(`--- Folie ${num} ---\n${paras.join('\n')}`);
      if (images && serverOk) {
        const relFile = zip.file(`ppt/slides/_rels/slide${num}.xml.rels`);
        if (relFile) {
          const rels = new DOMParser().parseFromString(await relFile.async('string'), 'application/xml');
          for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
            if (!/image/.test(rel.getAttribute('Type') || '')) continue;
            const target = `ppt/${rel.getAttribute('Target').replace(/^\.\.\//, '')}`;
            if (seen.has(target) || !zip.file(target)) continue; seen.add(target);
            try {
              const blob = await zip.file(target).async('blob');
              const bmp = await createImageBitmap(blob);
              if (Math.min(bmp.width, bmp.height) < 300 || bmp.width * bmp.height < 160000) continue;
              const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
              const canvas = document.createElement('canvas'); canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
              canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
              const jpeg = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
              const stored = await Store.uploadFile(jpeg, `img-${file.name.replace(/\.pptx$/i, '')}-s${num}.jpg`);
              if (stored) images.push({ src: stored, slide: Number(num), text: paras.join(' ').slice(0, 300) });
            } catch { /* unsupported image format (emf, wmf) */ }
          }
        }
      }
      progress(`Folie ${idx + 1}/${slides.length}${images?.length ? ` · ${images.length} Bilder` : ''}`);
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
    const res = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody(activeModel(), false, { messages: [{ role: 'user', content }] })) });
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
  function materialImageItems() {
    const out = [];
    for (const m of materialsIndex) for (const [k, img] of (m.images || []).entries()) {
      const c = caseById(m.caseIds?.[0]);
      out.push({ id: `img-${m.id}-${k}`, type: 'bild', kind: 'xray', region: m.regions?.[0] || regionOfCase(c), topic: c?.title || m.name, q: P.IMAGE_QUESTIONS.xray, a: img.text || '', img: img.src, src: m.name, slide: img.slide, caseIds: m.caseIds || [], source: 'bild' });
    }
    return out;
  }
  function renderMaterial() {
    const builtin = Object.entries(CORPUS).map(([cid, entries]) => ({ cid, entries }));
    view.innerHTML = `
      ${hero('MATERIAL', 'Material')}
      <div class="drop" id="drop">PDF · PPTX · DOCX · TXT · AAOS-TRACKER-EXPORT (JSON) HIER ABLEGEN<input type="file" id="file" multiple accept=".pdf,.pptx,.docx,.txt,.md,.json" hidden></div>
      <div class="row" style="margin-top:10px"><button class="btn small" id="btn-sync" ${serverOk ? '' : 'disabled title="nur mit laufendem server.py"'}>FMH-PRÄSENTATIONEN SYNCHRONISIEREN</button><span class="meta">holt neue Anhänge aus der FMH-Fallmatrix (${esc(state.settings.fmhRepo)}) · GitHub-Token unter ⚙${state.lastFmhSync ? ` · zuletzt ${new Date(state.lastFmhSync).toLocaleString('de-CH')}` : ''}</span></div>
      <div class="progress" id="progress"></div>
      <div class="table-wrap" style="margin-top:28px"><table class="table" id="mat-table"><thead><tr><th>Datei</th><th class="num">Zeichen</th><th>Fälle</th><th class="num">Items</th><th></th></tr></thead><tbody></tbody></table></div>
      <details class="plain" style="margin-top:28px"><summary>EINGEBAUT · ${builtin.reduce((a, b) => a + b.entries.length, 0)} PRÄSENTATIONEN · ${IMAGES.length} BILDER · ${seedBank.length} SEED-ITEMS</summary>
      <div class="table-wrap"><table class="table"><tbody>${builtin.map(({ cid, entries }) => `<tr><td class="num" style="text-align:left">${esc(cid.toUpperCase())}</td><td>${esc(caseById(cid)?.title || '')}</td><td class="muted">${entries.map((e) => esc(e.name)).join(' · ')}</td></tr>`).join('')}</tbody></table></div></details>`;
    const drop = $('#drop'); const input = $('#file'); const progress = $('#progress');
    $('#btn-sync').onclick = async () => { const b = $('#btn-sync'); b.disabled = true; try { await syncFmh((t) => { progress.textContent = t; }); table(); } catch (error) { progress.textContent = `Sync: ${error.message}`; toast(error.message, true); } b.disabled = false; };
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(Array.from(e.dataTransfer.files)); };
    input.onchange = () => { handleFiles(Array.from(input.files)); input.value = ''; };
    function table() {
      $('#mat-table tbody').innerHTML = materialsIndex.length ? materialsIndex.map((m) => {
        const items = customBank.filter((it) => it.source === `material ${m.id}`).length;
        return `<tr data-id="${m.id}"><td>${esc(m.name)}<br><span class="meta">${m.kind === 'fmh' ? 'FMH-MATRIX · ' : m.kind === 'aaos' ? 'AAOS TRACKER · ' : ''}${esc(m.status || '')}${m.images?.length ? ` · ${m.images.length} BILDER` : ''}</span></td><td class="num">${(m.chars || 0).toLocaleString('de-CH')}</td><td class="muted">${(m.caseIds || []).map((id) => esc(id.toUpperCase())).join(', ') || '–'}</td><td class="num">${items}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn small ghost" data-act="gen">ITEMS</button> <button class="btn small ghost danger" data-act="del">LÖSCHEN</button></td></tr>`;
      }).join('') : '<tr><td colspan="5" class="muted">Noch nichts abgelegt.</td></tr>';
    }
    table();
    $('#mat-table').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return; const id = b.closest('tr').dataset.id;
      if (b.dataset.act === 'del') { if (confirm('Material und seine generierten Items löschen?')) { await Store.deleteMaterial(id); Index.forget(id); Index.rebuild(); customBank = customBank.filter((it) => it.source !== `material ${id}`); await Store.saveBank(); imageBank = imageBank.filter((it) => !it.id.startsWith(`img-${id}-`)); table(); } }
      if (b.dataset.act === 'gen') { b.disabled = true; await generateFromMaterial(id, (t) => { progress.textContent = t; }); b.disabled = false; table(); }
    };
    async function handleFiles(files) {
      for (const file of files) {
        const id = `m${uid()}`; const ext = file.name.toLowerCase().split('.').pop();
        progress.textContent = `${file.name} · lese …`;
        try {
          let text = ''; const images = []; let kind = ext;
          const report = (t) => { progress.textContent = `${file.name} · ${t}`; };
          if (ext === 'json') { const parsed = JSON.parse(await file.text()); if (!parsed.chapters && !parsed.daily && !parsed.notes && !parsed.errorBank) throw new Error('kein AAOS-Tracker-Export'); text = aaosText(parsed); kind = 'aaos'; for (const old of materialsIndex.filter((m) => m.kind === 'aaos')) { await Store.deleteMaterial(old.id); Index.forget(old.id); customBank = customBank.filter((it) => it.source !== `material ${old.id}`); } }
          else if (ext === 'pdf') text = await extractPdf(file, report);
          else if (ext === 'pptx') text = await extractPptx(file, report, state.settings.images ? images : null);
          else if (ext === 'docx') text = await extractDocx(file);
          else text = await file.text();
          text = text.replace(/[ \t]+/g, ' ').trim();
          if (!text && !images.length) throw new Error('kein Text gefunden');
          const material = { id, name: kind === 'aaos' ? `AAOS Tracker · ${file.name}` : file.name, kind, chars: text.length, addedAt: Date.now(), caseIds: [], regions: [], status: 'extrahiert', images, text };
          Store.uploadFile(file);
          if (state.settings.apiKey && text && kind !== 'aaos') {
            report('ordne Fällen zu …');
            try { const tags = await chatJSON({ system: 'Du ordnest Lernmaterial Prüfungsfällen zu. Antworte nur mit JSON.', messages: [{ role: 'user', content: P.tagPrompt(material, text.slice(0, 5000), CASES) }], schema: P.TAG_SCHEMA, name: 'zuordnung' }); material.caseIds = (tags.caseIds || []).filter((x) => caseById(x)); material.regions = (tags.regions || []).filter((r) => P.REGIONS.includes(r)); } catch { /* optional */ }
          }
          await Store.putMaterial(material);
          Index.materialText.set(id, text); Index.rebuild();
          imageBank = imageBank.filter((it) => !it.id.startsWith(`img-${id}-`)).concat(materialImageItems().filter((it) => it.id.startsWith(`img-${id}-`)));
          table();
          progress.textContent = `${file.name} · gespeichert (${text.length.toLocaleString('de-CH')} Zeichen${images.length ? `, ${images.length} Bilder` : ''})`;
          if (state.settings.apiKey && text) await generateFromMaterial(id, (t) => { progress.textContent = t; });
          table();
        } catch (error) { progress.textContent = `${file.name} · Fehler: ${error.message}`; toast(error.message, true); }
      }
    }
  }
  // the AAOS tracker export (STATUS → EXPORT JSON in the tracker): notes and error log become one source
  function aaosText(data) {
    const parts = ['AAOS COR4 / ResStudy TRACKER · EIGENE NOTIZEN UND FEHLERLOG DES KANDIDATEN'];
    for (const [key, note] of Object.entries(data.notes || {})) if (String(note || '').trim()) parts.push(`NOTIZ ${key}\n${String(note).trim()}`);
    for (const e of data.errorBank || []) {
      const lines = [`FEHLERLOG ${e.date || ''} · ${e.source || ''} ${e.id || ''} · ${e.type || ''}`.replace(/\s+/g, ' ').trim()];
      if (e.question) lines.push(`Frage: ${e.question}`);
      if (Array.isArray(e.choices) && e.choices.length) lines.push(`Optionen: ${e.choices.join(' | ')}`);
      if (e.answer) lines.push(`Antwort: ${e.answer}`);
      if (e.discussion) lines.push(`Diskussion: ${e.discussion}`);
      if (lines.length === 1 && e.raw) lines.push(String(e.raw));
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }
  // new attachments from the FMH case matrix (release assets <caseId>.<player>.<stamp>.<name> in the files repo)
  async function gh(pathOrAsset, asBlob) {
    const token = state.settings.githubToken.trim(); if (!token) throw new Error('GitHub-Token fehlt (⚙)');
    const q = asBlob ? `asset=${encodeURIComponent(pathOrAsset)}` : `path=${encodeURIComponent(pathOrAsset)}`;
    const r = await fetch(`/api/gh?repo=${encodeURIComponent(state.settings.fmhRepo)}&${q}`, { headers: { 'x-github-token': token }, cache: 'no-store' });
    if (!r.ok) { let msg = `GitHub ${r.status}`; try { msg = (await r.json()).error || msg; } catch { /* keep */ } throw new Error(msg); }
    return asBlob ? r.blob() : r.json();
  }
  async function syncFmh(report = () => {}) {
    if (!serverOk) throw new Error('nur mit laufendem server.py');
    report('FMH-Matrix · lese Anhangliste …');
    const release = await gh('/releases/tags/attachments');
    const assets = [];
    for (let page = 1; page <= 20; page += 1) { const chunk = await gh(`/releases/${release.id}/assets?per_page=100&page=${page}`); assets.push(...chunk); if (chunk.length < 100) break; }
    const known = new Set(materialsIndex.map((m) => m.fmhAsset).filter(Boolean).concat(state.fmhSeen || []));
    const builtin = new Set(Object.entries(CORPUS).flatMap(([cid, es]) => es.map((e) => `${cid}/${e.name}`)).concat(IMAGES.map((im) => `${im.cases[0]}/${im.src}`)));
    const fresh = assets.filter((a) => { const [cid, player, stamp, ...rest] = a.name.split('.'); return cid && player && stamp && rest.length && !known.has(a.id) && !builtin.has(`${cid}/${rest.join('.')}`); });
    let added = 0;
    for (const a of fresh) {
      const [cid, , , ...rest] = a.name.split('.'); const name = rest.join('.'); const ext = name.toLowerCase().split('.').pop(); const c = caseById(cid);
      report(`${name} · lade (${(a.size / 1048576).toFixed(1)} MB) …`);
      try {
        const blob = await gh(String(a.id), true); const file = new File([blob], name, { type: a.content_type || '' });
        let text = ''; const images = [];
        if (/^(jpe?g|png|webp|heic)$/.test(ext)) { if (c) await storeCaseImage(cid, await blobToJpeg(blob).catch(() => blob), `FMH-Matrix · ${name}`, ''); added += 1; (state.fmhSeen = state.fmhSeen || []).push(a.id); continue; }
        if (ext === 'pdf') text = await extractPdf(file, (t) => report(`${name} · ${t}`));
        else if (ext === 'pptx') text = await extractPptx(file, (t) => report(`${name} · ${t}`), state.settings.images ? images : null);
        else if (ext === 'docx') text = await extractDocx(file);
        else if (/^(txt|md)$/.test(ext)) text = await file.text();
        else { report(`${name} · Format übersprungen`); continue; }
        text = text.replace(/[ \t]+/g, ' ').trim();
        if (!text && !images.length) { report(`${name} · kein Text`); continue; }
        const material = { id: `m${uid()}`, name, kind: 'fmh', fmhAsset: a.id, chars: text.length, addedAt: Date.now(), caseIds: c ? [cid] : [], regions: c ? [regionOfCase(c)] : [], status: 'aus FMH-Matrix', images, text };
        await Store.putMaterial(material); Index.materialText.set(material.id, text);
        imageBank = imageBank.concat(materialImageItems().filter((it) => it.id.startsWith(`img-${material.id}-`)));
        added += 1;
        if (state.settings.apiKey && text) await generateFromMaterial(material.id, report);
      } catch (error) { report(`${name} · Fehler: ${error.message}`); await sleep(800); }
    }
    state.lastFmhSync = Date.now(); clearTimeout(Store._timer); await Store.flush();
    if (added) Index.rebuild();
    report(`FMH-Matrix · ${assets.length} Anhänge, ${added} neu übernommen`);
    return added;
  }
  async function generateFromMaterial(id, report) {
    if (!requireKey()) return 0;
    const material = await Store.getMaterial(id); if (!material?.text) return 0;
    const chunks = chunkText(material.text); let total = 0;
    for (const [i, chunk] of chunks.entries()) {
      report(`${material.name} · Items aus Abschnitt ${i + 1}/${chunks.length} … (${total} bisher)`);
      try {
        const out = await chatJSON({ system: P.extractSystem(), messages: [{ role: 'user', content: P.extractPrompt(material, chunk, i, chunks.length) }], schema: P.ITEMS_SCHEMA, name: 'items', heavy: true });
        const items = (out.items || []).map((it) => ({ ...it, region: material.regions?.length && !P.REGIONS.includes(it.region) ? material.regions[0] : it.region }));
        total += await addItems(items, `material ${id}`, material.caseIds || []);
      } catch (error) { report(`${material.name} · Abschnitt ${i + 1}: ${error.message}`); await sleep(1500); }
    }
    material.status = `${total} Items · ${new Date().toLocaleDateString('de-CH')}`;
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
      const cases = CASES.filter((c) => regionOfCase(c) === r);
      const grades = cases.map((c) => caseSummary(c.id).mean).filter((g) => g != null);
      const mean = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;
      return { r, total: its.length, seen: seen.length, acc, due, exams: grades.length, cases: cases.length, mean };
    });
    const flagged = items.filter((it) => stats(it.id).flag);
    const days = []; for (let i = 13; i >= 0; i -= 1) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push({ d, ...(state.daily[d] || {}) }); }
    const load = (d) => (d.quiz || 0) + (d.lazy || 0) + (d.exam || 0) * 10;
    const max = Math.max(1, ...days.map(load));
    const todayN = load(state.daily[today()] || {});
    const examsTotal = Object.values(state.caseLog).reduce((a, l) => a + l.length, 0);
    view.innerHTML = `
      ${hero(`STATUS · T−${daysLeft()}`, 'Status')}
      <div class="grid3">
        <div class="stat"><div class="v ${todayN >= state.settings.dailyGoal ? 'ok' : ''}">${todayN}<span class="muted" style="font-size:14px">/${state.settings.dailyGoal}</span></div><div class="k">heute · Fragen + 10 × Fälle</div></div>
        <div class="stat"><div class="v">${items.filter((it) => { const s = stats(it.id); return s.seen && s.due <= Date.now(); }).length}</div><div class="k">fällig</div></div>
        <div class="stat"><div class="v">${examsTotal}</div><div class="k">Fallprüfungen · ${CASES.filter((c) => caseSummary(c.id).runs).length}/${CASES.length} Fälle</div></div>
      </div>
      <div class="days">${days.map((d) => `<span title="${d.d}: ${d.quiz || 0} Abfrage · ${d.lazy || 0} Lazy · ${d.exam || 0} Fälle"><i style="height:${Math.round(100 * load(d) / max)}%"></i></span>`).join('')}</div>
      <hr class="sep">
      <div class="table-wrap"><table class="table"><thead><tr><th>Region</th><th class="num">Items</th><th class="num">gesehen</th><th class="num">Treffer</th><th class="num">fällig</th><th class="num">Fälle</th><th class="num">Ø</th></tr></thead>
      <tbody>${regionRows.map((x) => `<tr><td>${esc(x.r)}<div class="bar"><span style="width:${x.total ? Math.round(100 * x.seen / x.total) : 0}%"></span></div></td><td class="num">${x.total}</td><td class="num">${x.seen}</td><td class="num ${x.acc == null ? 'faint' : x.acc < 0.6 ? 'warn' : x.acc < 0.8 ? 'signal' : 'ok'}">${x.acc == null ? '–' : `${Math.round(x.acc * 100)}%`}</td><td class="num">${x.due}</td><td class="num">${x.exams}/${x.cases}</td><td class="num ${gradeClass(x.mean)}">${fmtGrade(x.mean)}</td></tr>`).join('')}</tbody></table></div>
      <hr class="sep">
      ${(() => {
        const pf = profileSummary();
        const li = (cls, num, text, sub) => `<li><span class="num ${cls}">${num}</span> &nbsp;${text}${sub ? ` <span class="faint">· ${esc(sub)}</span>` : ''}</li>`;
        const weak = [...pf.weakTopics.map((x) => li('warn', `${Math.round(x.acc * 100)}%`, esc(x.t), x.region)), ...pf.weakCases.map((x) => li(gradeClass(x.s.mean), fmtGrade(x.s.mean), `<a href="#exam/${x.c.id}">${esc(x.c.title)}</a>`, 'Fallprüfung')), ...pf.threadWeak.slice(-8).map((x) => li('warn', '✗', esc(x.thema), `${x.befund}${x.region ? ` · ${x.region}` : ''}`))];
        const strong = [...pf.strongTopics.map((x) => li('ok', `${Math.round(x.acc * 100)}%`, esc(x.t), x.region)), ...pf.strongCases.map((x) => li('ok', fmtGrade(x.s.mean), esc(x.c.title), 'Fallprüfung')), ...pf.threadStrong.slice(-6).map((x) => li('ok', '✓', esc(x.thema), `${x.befund}${x.region ? ` · ${x.region}` : ''}`))];
        return `<div class="row between"><h3 style="margin:0">Profil · Schwächen und Stärken</h3><a class="btn small primary" href="#free/weak">SCHWÄCHEN DRILLEN</a></div>
      <div class="grid2" style="margin-top:12px">
        <div><span class="label muted">SCHWÄCHEN</span>${weak.length ? `<ul class="clean" style="margin-top:8px">${weak.join('')}</ul>` : '<p class="muted" style="margin-top:8px">Noch keine Daten: Abfragen, Fälle und Gespräche füllen das Profil.</p>'}</div>
        <div><span class="label muted">STÄRKEN</span>${strong.length ? `<ul class="clean" style="margin-top:8px">${strong.join('')}</ul>` : '<p class="muted" style="margin-top:8px">Noch keine.</p>'}</div>
      </div>
      ${pf.fehlend.length ? `<p class="meta" style="margin-top:12px">ZULETZT GEFEHLT IN FALLPRÜFUNGEN · ${pf.fehlend.slice(-8).map((x) => esc(x)).join(' · ')}</p>` : ''}`;
      })()}
      ${(state.methodLog || []).length ? `<hr class="sep"><h3>Methodik</h3><ul class="clean">${(state.methodLog || []).slice(-6).reverse().map((m) => `<li><span class="num ${gradeClass(m.struktur)}">${m.struktur ?? '–'}</span> &nbsp;${esc(m.tipp)} <span class="faint">· ${esc(caseById(m.caseId)?.title || m.caseId)}</span></li>`).join('')}</ul>` : ''}
      ${flagged.length ? `<hr class="sep"><h3>Gemeldete Items</h3><ul class="clean">${flagged.map((it) => `<li>${esc(it.q)} <span class="muted">→ ${esc(it.a)}</span> <button class="btn small ghost" data-unflag="${it.id}">OK</button></li>`).join('')}</ul>` : ''}
      <hr class="sep">
      <div class="row"><button class="btn ghost" id="btn-export">EXPORT</button><button class="btn ghost" id="btn-import">IMPORT</button><input type="file" id="import-file" accept=".json" hidden><span class="meta">${serverOk ? 'USERDATA/ AUF DIESEM RECHNER' : 'BROWSER-SPEICHER · server.py starten für Dateien auf dem Mac'}</span></div>`;
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
        if (data.state) state = { ...state, ...data.state, settings: { ...state.settings, ...data.state.settings, apiKey: state.settings.apiKey || data.state.settings?.apiKey || '' } };
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
      ${hero('EINSTELLUNGEN', 'Setup')}
      <div class="grid2">
        <div>
          <div class="field"><span class="label">OpenAI API-Schlüssel</span><input type="password" id="s-key" value="${esc(s.apiKey)}" placeholder="sk-…"><span class="hint">Bleibt auf diesem Rechner (${serverOk ? 'drill/userdata/state.json' : 'Browser-Speicher'}).</span></div>
          <div class="field"><span class="label">Modell</span><input type="text" id="s-model" value="${esc(s.model)}" list="models"><datalist id="models"></datalist><span class="hint">"auto" wählt das stärkste verfügbare Modell deines Schlüssels (gpt-6 › gpt-5.x › gpt-4.1)${s.resolvedModel ? ` · aktuell ${esc(s.resolvedModel)}` : ''}.</span></div>
          <div class="field"><span class="label">Denkaufwand</span><select id="s-effort">${opt([['schnell', 'schnell'], ['ausgewogen', 'ausgewogen · Fall und Feedback gründlicher'], ['gründlich', 'gründlich · langsamer, teurer']], s.effort)}</select></div>
          <div class="field"><span class="label">Transkription</span><input type="text" id="s-stt" value="${esc(s.transcribeModel)}"></div>
          <div class="field"><span class="label">Prüfer-Stimme</span><div class="row"><input type="text" id="s-tts" value="${esc(s.ttsModel)}" style="max-width:220px"><select id="s-voice" style="max-width:140px">${opt([['onyx', 'onyx'], ['alloy', 'alloy'], ['ash', 'ash'], ['echo', 'echo'], ['fable', 'fable'], ['nova', 'nova'], ['sage', 'sage'], ['shimmer', 'shimmer']], s.ttsVoice)}</select></div>
            <label class="check"><input type="checkbox" id="s-voice-on" ${s.examinerVoice ? 'checked' : ''}> Prüfer liest seine Fragen und Antworten vor (Textmodus; in jedem Modus per VORLESEN umschaltbar; ▶ liest jederzeit auf Wunsch)</label></div>
          <div class="field"><span class="label">Live-Prüfer · Gespräch in Echtzeit</span>
            <label class="check"><input type="checkbox" id="s-live" ${s.live ? 'checked' : ''}> Prüfung startet live: der Prüfer spricht und hört zu (OpenAI Realtime, WebRTC)</label>
            <div class="row"><input type="text" id="s-rt" value="${esc(s.realtimeModel)}" placeholder="auto" style="max-width:200px"><select id="s-rtvoice" style="max-width:130px">${opt([['cedar', 'cedar'], ['marin', 'marin'], ['ash', 'ash'], ['ballad', 'ballad'], ['coral', 'coral'], ['echo', 'echo'], ['sage', 'sage'], ['verse', 'verse'], ['alloy', 'alloy'], ['shimmer', 'shimmer']], s.realtimeVoice)}</select><select id="s-eager" style="max-width:230px">${opt([['low', 'Pausen lang · ausreden lassen'], ['medium', 'Pausen mittel'], ['high', 'Pausen kurz · schnell']], s.eagerness)}</select></div>
            <span class="hint">"auto" nimmt das neuste gpt-realtime deines Schlüssels${s.resolvedRealtimeModel ? ` · aktuell ${esc(s.resolvedRealtimeModel)}` : ''}. ● LIVE gibt es auch in FREI und bei NACHFRAGEN. Kopfhörer vermeiden Echo. Fall, Bewertung und Feedback laufen weiter über ${esc(activeModel())}.</span></div>
        </div>
        <div>
          <div class="field"><span class="label">Sprache</span><select id="s-lang">${opt([['de', 'Deutsch'], ['en', 'English']], s.lang)}</select></div>
          <div class="field"><span class="label">Strenge</span><select id="s-strict">${opt([['mild', 'mild'], ['standard', 'standard'], ['hart', 'hart']], s.strictness)}</select></div>
          <div class="field"><span class="label">Nachfragen pro Station</span><select id="s-followups">${opt([['0', '0 · nur Eröffnungsfragen'], ['1', '1 · 10 Fragen pro Fall'], ['2', '2 · 15 Fragen'], ['3', '3 · 20 Fragen']], String(s.followups))}</select></div>
          <div class="field"><span class="label">Bilder</span>
            <label class="check"><input type="checkbox" id="s-images" ${s.images ? 'checked' : ''}> Bilder aus den Präsentationen in Prüfung und Abfrage</label>
            <label class="check"><input type="checkbox" id="s-web" ${s.webImages ? 'checked' : ''}> Websuche (Google Bilder, Wikimedia Commons), wenn kein eigenes Bild passt</label>
            <div class="row" style="margin-top:6px"><input type="password" id="s-gkey" value="${esc(s.googleKey)}" placeholder="Google API-Key (optional)" style="max-width:260px"><input type="text" id="s-gcx" value="${esc(s.googleCx)}" placeholder="Suchmaschinen-ID (cx)" style="max-width:220px"></div>
            <span class="hint">Google Bildsuche: programmablesearchengine.google.com → neue Suchmaschine, «Gesamtes Web» und Bildsuche an → ID kopieren; API-Key unter console.cloud.google.com (Custom Search JSON API, 100 Anfragen/Tag gratis). Ohne Key nur Commons.</span></div>
          <div class="field"><span class="label">Quellen</span>
            <label class="check"><input type="checkbox" id="s-fact" ${s.factCheck !== false ? 'checked' : ''}> Faktencheck nach jedem Fall: Kernaussagen gegen begutachtete Literatur prüfen (Websuche)</label>
            <div class="row" style="margin-top:6px"><input type="password" id="s-gh" value="${esc(s.githubToken)}" placeholder="GitHub-Token (fine-grained, Contents: read)" style="max-width:300px"><input type="text" id="s-ghrepo" value="${esc(s.fmhRepo)}" placeholder="owner/repo" style="max-width:220px"></div>
            <span class="hint">Für neue Präsentationen aus der FMH-Fallmatrix: github.com → Settings → Developer settings → Fine-grained token, nur dieses Repo, Permission «Contents: Read-only». Sync läuft beim Start (alle 6 h) und unter MATERIAL.</span></div>
          <div class="field"><span class="label">Tagesziel</span><input type="number" id="s-goal" value="${s.dailyGoal}" min="5" max="500" style="max-width:120px"></div>
          <div class="field"><span class="label">Zusätzliche Anweisung an den Prüfer</span><textarea id="s-custom" placeholder="z. B. Frag besonders nach Zugängen und Implantaten.">${esc(s.custom)}</textarea></div>
        </div>
      </div>
      <div class="row"><button class="btn primary" id="s-save">SPEICHERN</button><button class="btn" id="s-test">VERBINDUNG TESTEN</button><span class="meta" id="s-msg"></span></div>`;
    const read = () => {
      s.apiKey = $('#s-key').value.trim(); s.model = $('#s-model').value.trim() || 'auto'; s.effort = $('#s-effort').value; s.transcribeModel = $('#s-stt').value.trim() || 'gpt-4o-transcribe';
      s.ttsModel = $('#s-tts').value.trim() || 'gpt-4o-mini-tts'; s.ttsVoice = $('#s-voice').value; s.examinerVoice = $('#s-voice-on').checked; s.lang = $('#s-lang').value; s.strictness = $('#s-strict').value;
      s.followups = Number($('#s-followups').value); s.dailyGoal = Number($('#s-goal').value) || 30; s.custom = $('#s-custom').value.trim(); s.images = $('#s-images').checked; s.webImages = $('#s-web').checked; s.googleKey = $('#s-gkey').value.trim(); s.googleCx = $('#s-gcx').value.trim();
      s.live = $('#s-live').checked; s.realtimeModel = $('#s-rt').value.trim() || 'auto'; s.realtimeVoice = $('#s-rtvoice').value; s.eagerness = $('#s-eager').value;
      s.factCheck = $('#s-fact').checked; s.githubToken = $('#s-gh').value.trim(); s.fmhRepo = /^[\w.-]+\/[\w.-]+$/.test($('#s-ghrepo').value.trim()) ? $('#s-ghrepo').value.trim() : 'nekonomicus/fmh-oral-files';
    };
    $('#s-save').onclick = async () => {
      read();
      if (s.apiKey) { try { const ids = await resolveModel(); $('#models').innerHTML = ids.filter((id) => /^(gpt|o[1-9])/.test(id)).sort().map((id) => `<option value="${id}">`).join(''); } catch (error) { toast(error.message, true); } }
      await Store.flush(); toast(`Gespeichert · ${activeModel()}${state.settings.live ? ` · live ${realtimeModel()}` : ''}`); footer();
    };
    $('#s-test').onclick = async () => {
      read(); await Store.flush(); $('#s-msg').innerHTML = '<span class="spinner"></span>';
      try {
        if (s.model === 'auto' && !s.resolvedModel) await resolveModel();
        const out = await chatJSON({ system: 'Antworte mit JSON.', messages: [{ role: 'user', content: 'Gib {"ok": true, "modell": "<dein Modellname>"} zurück.' }], schema: { type: 'object', additionalProperties: false, required: ['ok', 'modell'], properties: { ok: { type: 'boolean' }, modell: { type: 'string' } } }, name: 'ping' });
        $('#s-msg').textContent = `OK · ${activeModel()}${out.modell && out.modell !== activeModel() ? ` (${out.modell})` : ''}`; await Store.flush(); footer();
      } catch (error) { $('#s-msg').textContent = ''; toast(error.message, true); }
    };
  }

  // ------------------------------------------------------------------ boot
  function footer() {
    $('#storage-note').textContent = `BUILD ${BUILD} · ${serverOk ? 'USERDATA/ AUF DIESEM RECHNER' : 'BROWSER-SPEICHER · server.py starten für Dateien'}`;
    $('#model-note').textContent = state.settings.apiKey ? `${activeModel().toUpperCase()}${state.settings.live ? ` · LIVE ${realtimeModel().toUpperCase()}` : ''} · ${state.settings.strictness.toUpperCase()}` : 'KEIN API-SCHLÜSSEL · ⚙';
    $('#countdown').textContent = `21 NOV 2026 · T−${daysLeft()}`;
  }
  const VIEWS = { exam: renderExam, quiz: renderQuiz, lazy: renderLazy, free: renderFree, material: renderMaterial, status: renderStatus, settings: renderSettings };
  (async () => {
    buildSeed();
    await Store.init();
    imageBank = imageBank.concat(materialImageItems());
    footer();
    Index.ready();
    if (serverOk && state.settings.githubToken && Date.now() - (state.lastFmhSync || 0) > 6 * 3600 * 1000) syncFmh().then((n) => { if (n) toast(`${n} neue Anhänge aus der FMH-Matrix übernommen`); }).catch(() => {});
    if (!state.settings.apiKey && !location.hash) location.hash = '#settings';
    navigate();
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
  })();
})();
