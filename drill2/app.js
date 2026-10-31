/* FMH MUSTS · app.js
   One matrix (the 118 cases + 5 reserve), one chat with dictation, one coach that knows the matrix,
   the candidate's own notes and the progress table. Progress is saved through server.py to ./userdata,
   or to localStorage when index.html is opened directly. */
(function () {
  'use strict';

  const P = window.PROMPTS;
  const CASES = window.CASES;
  const NOTES = window.NOTES || {};
  const EXAM_DATE = new Date('2026-11-21T08:00:00+01:00');
  const OPENAI = 'https://api.openai.com/v1';
  const MODEL_PREFERENCE = ['gpt-6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1'];
  const MODEL_EXCLUDE = /mini|nano|codex|realtime|audio|transcribe|tts|search|pro|chat|preview|instruct|image|research|computer/i;
  const EFFORTS = ['xhigh', 'high', 'medium', 'low'];
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const caseById = (id) => CASES.find((c) => c.id === id);

  // ------------------------------------------------------------------ state
  const DEFAULT_SETTINGS = { apiKey: '', model: 'auto', resolvedModel: '', effort: 'high', transcribeModel: 'auto', resolvedTranscribe: '' };
  let state = { version: 1, settings: { ...DEFAULT_SETTINGS }, progress: {}, notes: {}, threads: [], current: '' };
  let serverOk = false;

  const Store = {
    async init() {
      try { const r = await fetch('/api/ping', { cache: 'no-store' }); serverOk = r.ok; } catch { serverOk = false; }
      let saved = null;
      if (serverOk) { try { saved = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()); } catch { saved = null; } }
      else { try { saved = JSON.parse(localStorage.getItem('fmhmusts.state') || 'null'); } catch { saved = null; } }
      if (saved && saved.settings) state = { ...state, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
      if (state.settings.importedKey) { delete state.settings.importedKey; toast('API-Schlüssel aus dem alten Drill übernommen'); this.save(); }
    },
    _timer: null,
    save() { clearTimeout(this._timer); this._timer = setTimeout(() => this.flush(), 400); },
    async flush() {
      clearTimeout(this._timer);
      const body = JSON.stringify(state);
      if (serverOk) { try { await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body }); } catch (e) { toast(`Speichern fehlgeschlagen: ${e.message}`, true); } }
      else { try { localStorage.setItem('fmhmusts.state', body); } catch { /* storage full or blocked */ } }
    },
  };

  const noteFor = (id) => (state.notes[id] !== undefined ? state.notes[id] : (NOTES[id] || ''));
  const progressFor = (id) => state.progress[id];
  function setProgress(id, stufe, ergebnis, luecken) {
    const p = state.progress[id] || { must: null, excel: null, n: 0, luecken: '', t: 0 };
    if (ergebnis === null) { delete state.progress[id]; } else {
      p[stufe] = ergebnis; p.n = (p.n || 0) + 1; p.t = Date.now();
      if (luecken !== undefined) p.luecken = String(luecken || '').trim();
      state.progress[id] = p;
    }
    Store.save(); renderMatrix(); renderStats();
  }
  function statusOf(p) {
    if (!p) return '';
    if (p.must === 'fehlt' || p.must === 'teilweise') return 'fehlt';
    if (p.excel === 'ok') return 'excel';
    if (p.must === 'ok') return 'must';
    if (p.excel === 'fehlt' || p.excel === 'teilweise') return 'fehlt';
    return '';
  }

  // ------------------------------------------------------------------ ui helpers
  async function log(kind, text) {
    const line = `${kind}: ${String(text || '').slice(0, 2000)}`;
    console.log(`[FMH MUSTS] ${line}`);
    if (serverOk) { try { await fetch('/api/log', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: line }); } catch { /* server gone */ } }
  }
  window.addEventListener('error', (e) => log('js', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('promise', e.reason?.message || String(e.reason)));
  let toastTimer = null;
  function toast(text, bad = false) {
    const el = $('#toast'); el.textContent = text; el.classList.toggle('bad', bad); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3000);
  }
  function markdown(src) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = []; let list = null; let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (ul || ol) { flushPara(); const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; } list.items.push((ul || ol)[1]); continue; }
      if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
      flushList(); para.push(line.trim());
    }
    flushPara(); flushList();
    return out.join('');
  }

  // ------------------------------------------------------------------ openai
  function activeModel() { const s = state.settings; return s.model && s.model !== 'auto' ? s.model : (s.resolvedModel || 'gpt-5.1'); }
  function isReasoningModel(model) { return /^(gpt-[5-9]|o[1-9])/i.test(model || ''); }
  function transcribeModel() { const s = state.settings; return s.transcribeModel && s.transcribeModel !== 'auto' ? s.transcribeModel : (s.resolvedTranscribe || 'gpt-4o-transcribe'); }
  function requireKey() { if (state.settings.apiKey) return true; toast('Zuerst den OpenAI-Schlüssel unter ⚙ eintragen', true); openSettings(); return false; }
  async function openaiFetch(path, init) {
    const res = await fetch(`${OPENAI}${path}`, { ...init, headers: { authorization: `Bearer ${state.settings.apiKey}`, ...(init.headers || {}) } });
    if (!res.ok) {
      let message = `OpenAI ${res.status}`;
      try { const err = await res.json(); message = err.error?.message || message; } catch { /* keep status */ }
      const error = new Error(message); error.status = res.status; throw error;
    }
    return res;
  }
  async function resolveModels() {
    const data = await openaiFetch('/models', {}).then((r) => r.json());
    const ids = data.data.map((m) => m.id);
    let chat = '';
    for (const prefix of MODEL_PREFERENCE) {
      const hits = ids.filter((id) => (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`)) && !MODEL_EXCLUDE.test(id.slice(prefix.length)));
      if (hits.length) { chat = hits.includes(prefix) ? prefix : hits.sort((a, b) => a.length - b.length)[0]; break; }
    }
    state.settings.resolvedModel = chat || 'gpt-5.1';
    const version = (id) => { const m = id.match(/^gpt-(\d+(?:\.\d+)?)(o)?/); return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : 0; };
    const stt = ids.filter((id) => /transcribe/.test(id) && !/mini|diarize|realtime/.test(id)).sort((a, b) => version(b) - version(a) || a.length - b.length)[0];
    state.settings.resolvedTranscribe = stt || (ids.includes('whisper-1') ? 'whisper-1' : 'gpt-4o-transcribe');
    Store.save();
    return ids;
  }
  // Responses API (function tools + reasoning effort are only allowed there for the gpt-6 models).
  // Unsupported reasoning efforts step down (xhigh → high → none) and the call is retried.
  async function postResponses(body) {
    for (;;) {
      try { return await openaiFetch('/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
      catch (error) {
        if (body.reasoning && /reasoning|Unsupported value|unsupported_value|Unsupported parameter|unsupported_parameter|Invalid value/i.test(error.message)) {
          const cur = body.reasoning.effort; const i = EFFORTS.indexOf(cur);
          if (i >= 0 && i < EFFORTS.indexOf('high')) { body.reasoning = { effort: 'high' }; if (state.settings.effort !== 'high') { state.settings.effort = 'high'; Store.save(); toast(`${body.model} kann kein ${cur} · weiter mit high`); } }
          else delete body.reasoning;
          log('fallback', `reasoning ${cur} → ${body.reasoning ? body.reasoning.effort : 'ohne'} · ${error.message}`);
          continue;
        }
        throw error;
      }
    }
  }
  let streamingOff = false;
  const itemsOf = (data) => {
    const text = (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    const calls = (data.output || []).filter((o) => o.type === 'function_call').map((o) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments || '{}' }));
    return { id: data.id, content: text, calls };
  };
  // one response: streamed when the account allows it, otherwise in one piece
  async function complete(body, onDelta, signal) {
    if (streamingOff) body.stream = false;
    let res;
    try { res = await postResponses(body); }
    catch (error) {
      if (body.stream && /stream/i.test(error.message)) { streamingOff = true; body.stream = false; log('fallback', `ohne Streaming · ${error.message}`); res = await postResponses(body); }
      else throw error;
    }
    if (!body.stream) { const out = itemsOf(await res.json()); if (out.content) onDelta(out.content); return out; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let full = ''; let id = ''; const calls = new Map();
    for (;;) {
      if (signal?.aborted) { reader.cancel(); throw new DOMException('abgebrochen', 'AbortError'); }
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim(); if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        switch (ev.type) {
          case 'response.created': id = ev.response?.id || id; break;
          case 'response.output_text.delta': full += ev.delta || ''; onDelta(full); break;
          case 'response.output_item.added': if (ev.item?.type === 'function_call') calls.set(ev.item.id, { call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || '' }); break;
          case 'response.function_call_arguments.delta': { const c = calls.get(ev.item_id); if (c) c.arguments += ev.delta || ''; break; }
          case 'response.function_call_arguments.done': { const c = calls.get(ev.item_id); if (c) c.arguments = ev.arguments || c.arguments; break; }
          case 'response.output_item.done': if (ev.item?.type === 'function_call') calls.set(ev.item.id, { call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || '{}' }); break;
          case 'response.completed': { const out = itemsOf(ev.response || {}); id = out.id || id; if (!full && out.content) { full = out.content; onDelta(full); } break; }
          case 'response.failed': case 'response.incomplete': throw new Error(ev.response?.error?.message || ev.response?.incomplete_details?.reason || 'Antwort abgebrochen');
          case 'error': throw new Error(ev.error?.message || ev.message || 'Stream-Fehler');
          default: break;
        }
      }
    }
    return { id, content: full, calls: [...calls.values()] };
  }
  const RESPONSE_TOOLS = P.TOOLS.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false }));
  async function chatStream({ system, messages, onDelta, onTool, signal }) {
    const model = activeModel();
    const body = { model, stream: true, store: true, instructions: system, input: messages.map((m) => ({ role: m.role, content: m.content })), tools: RESPONSE_TOOLS, tool_choice: 'auto' };
    if (isReasoningModel(model)) body.reasoning = { effort: state.settings.effort || 'high' };
    let content = '';
    for (let round = 0; round < 6; round += 1) {
      const out = await complete(body, onDelta, signal);
      content = out.content;
      const list = out.calls.filter((c) => c.call_id && c.name);
      if (!list.length) return content;
      // the tool results continue the same response chain; reasoning state stays on the server
      body.previous_response_id = out.id;
      body.input = list.map((c) => {
        let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
        const result = c.name === 'fortschritt' ? onTool(args) : 'Unbekanntes Werkzeug.';
        return { type: 'function_call_output', call_id: c.call_id, output: String(result) };
      });
    }
    return content;
  }
  async function transcribe(blob, ext) {
    const form = new FormData();
    form.append('file', blob, `antwort.${ext}`);
    form.append('model', transcribeModel());
    form.append('language', 'de');
    form.append('prompt', P.TRANSCRIBE_HINT);
    const data = await openaiFetch('/audio/transcriptions', { method: 'POST', body: form }).then((r) => r.json());
    return (data.text || '').trim();
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
        catch (error) { toast(`Mikrofon: ${error.message}`, true); log('mic', error.message); }
        return;
      }
      button.classList.remove('on'); button.textContent = '…'; button.disabled = true;
      try {
        const blob = await Recorder.stop();
        const text = await transcribe(blob, Recorder.ext);
        textarea.value = (textarea.value ? `${textarea.value.trim()} ` : '') + text;
        autosize(textarea); textarea.focus();
      } catch (error) { toast(`Transkription: ${error.message}`, true); log('transcribe', `${transcribeModel()} · ${error.message}`); }
      button.disabled = false; button.textContent = '● SPRECHEN';
    });
  }

  // ------------------------------------------------------------------ matrix
  function renderMatrix() {
    const regions = [];
    for (const c of CASES) { let r = regions.find((x) => x.name === c.region); if (!r) { r = { name: c.region, cases: [] }; regions.push(r); } r.cases.push(c); }
    const legend = '<div class="legend"><span><i></i>offen</span><span><i class="fehlt"></i>Lücken</span><span><i class="must"></i>Must ok</span><span><i class="excel"></i>Excel ok</span></div>';
    $('#matrix').innerHTML = legend + regions.map((r) => {
      const ok = r.cases.filter((c) => ['must', 'excel'].includes(statusOf(progressFor(c.id)))).length;
      return `<div class="region"><div class="region-h"><span>${esc(r.name)}${r.cases[0].matrix ? '' : ' · Reserve'}</span><span>${ok}/${r.cases.length}</span></div><div class="tiles">${r.cases.map((c) => {
        const st = statusOf(progressFor(c.id));
        return `<button class="tile ${st}${noteFor(c.id).trim() ? ' note' : ''}" data-id="${c.id}" title="${esc(c.title)}"><span>${esc(c.title)}</span></button>`;
      }).join('')}</div></div>`;
    }).join('');
  }
  function renderStats() {
    const matrix = CASES.filter((c) => c.matrix);
    const must = matrix.filter((c) => ['must', 'excel'].includes(statusOf(progressFor(c.id)))).length;
    const excel = matrix.filter((c) => statusOf(progressFor(c.id)) === 'excel').length;
    const gaps = matrix.filter((c) => statusOf(progressFor(c.id)) === 'fehlt').length;
    $('#stats').innerHTML = `<span>MUST <b>${must}</b>/118</span><span>EXCEL <b>${excel}</b>/118</span><span>LÜCKEN <b>${gaps}</b></span><span>OFFEN <b>${118 - must - gaps}</b></span>`;
  }
  function renderCountdown() {
    const days = Math.ceil((EXAM_DATE - Date.now()) / 86400000);
    $('#countdown').textContent = days > 0 ? `${days} Tage bis 21.11.` : 'Prüfung';
  }

  // ------------------------------------------------------------------ case modal
  function openCase(id) {
    const c = caseById(id); if (!c) return;
    const p = progressFor(id) || {};
    const box = $('#case-box'); const modal = $('#case-modal');
    const lvl = (stufe) => ['ok', 'teilweise', 'fehlt'].map((v) => `<button class="btn small ${p[stufe] === v ? `sel-${v}` : ''}" data-set="${stufe}:${v}">${v.toUpperCase()}</button>`).join('');
    box.innerHTML = `
      <div class="row between"><h2>${esc(c.title)}</h2><button class="btn ghost" data-close>✕</button></div>
      <div class="meta">${esc(c.region)}${p.n ? ` · ${p.n}× geprüft` : ''}</div>
      <div class="status-row"><span class="label">MUST</span><div class="row">${lvl('must')}</div><span class="label">EXCEL</span><div class="row">${lvl('excel')}</div></div>
      ${p.luecken ? `<div class="gaps"><span class="label">Letzte Lücken</span><br>${esc(p.luecken)}</div>` : ''}
      <div class="field"><span class="label">Meine Notiz (Must-knows)</span><textarea id="case-note">${esc(noteFor(id))}</textarea></div>
      <div class="row between">
        <div class="row"><button class="btn primary" data-ask="must">MUST ABFRAGEN</button><button class="btn" data-ask="excel">EXCEL ABFRAGEN</button><button class="btn" data-ask="list">LISTE ZEIGEN</button></div>
        <button class="btn ghost" data-reset>ZURÜCKSETZEN</button>
      </div>`;
    const saveNote = () => { const v = $('#case-note').value; if (v.trim() === (NOTES[id] || '').trim()) delete state.notes[id]; else state.notes[id] = v; Store.save(); renderMatrix(); };
    const close = () => { saveNote(); modal.hidden = true; };
    box.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.close !== undefined) return close();
      if (b.dataset.reset !== undefined) { setProgress(id, null, null); return openCase(id); }
      if (b.dataset.set) { const [stufe, v] = b.dataset.set.split(':'); setProgress(id, stufe, v); return openCase(id); }
      if (b.dataset.ask) {
        const ask = { must: [`Prüfe mich auf die Must-knows von «${c.title}» (${c.id}).`, `${c.title} · MUST`], excel: [`Prüfe mich auf Excel-Niveau zu «${c.title}» (${c.id}): die schweren Fragen.`, `${c.title} · EXCEL`], list: [`Zeig mir die Must-knows und danach die Excel-Punkte zu «${c.title}» (${c.id}), kompakt.`, `${c.title} · Liste`] }[b.dataset.ask];
        close(); send(ask[0], ask[1]);
      }
    };
    modal.onclick = (e) => { if (e.target === modal) close(); };
    modal.hidden = false;
  }

  // ------------------------------------------------------------------ settings
  function openSettings() {
    const s = state.settings; const box = $('#settings-box'); const modal = $('#settings-modal');
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
    box.innerHTML = `
      <div class="row between"><h2>Einstellungen</h2><button class="btn ghost" data-close>✕</button></div>
      <div class="field"><span class="label">OpenAI API-Schlüssel</span><input type="password" id="s-key" value="${esc(s.apiKey)}" placeholder="sk-…" autocomplete="off"></div>
      <div class="field"><span class="label">Modell</span><input type="text" id="s-model" value="${esc(s.model)}" list="models"><datalist id="models"></datalist></div>
      <div class="field"><span class="label">Denkaufwand</span><select id="s-effort">${opt([['xhigh', 'xhigh'], ['high', 'high'], ['medium', 'medium'], ['low', 'low']], s.effort)}</select></div>
      <div class="field"><span class="label">Transkription</span><input type="text" id="s-stt" value="${esc(s.transcribeModel)}"></div>
      <div class="row between">
        <div class="row"><button class="btn primary" data-save>SPEICHERN</button><button class="btn" data-test>VERBINDUNG TESTEN</button></div>
        <div class="row"><button class="btn ghost" data-export>EXPORT</button><button class="btn ghost" data-import>IMPORT</button><input type="file" id="s-file" accept="application/json" hidden></div>
      </div>
      <div class="meta" id="s-result" style="margin-top:10px"></div>`;
    const read = () => { s.apiKey = $('#s-key').value.trim(); s.model = $('#s-model').value.trim() || 'auto'; s.effort = $('#s-effort').value; s.transcribeModel = $('#s-stt').value.trim() || 'auto'; };
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.close !== undefined) { modal.hidden = true; return; }
      if (b.dataset.save !== undefined) { read(); await Store.flush(); if (s.apiKey) { try { await resolveModels(); } catch (error) { toast(`Modelle: ${error.message}`, true); log('models', error.message); } } modal.hidden = true; toast('Gespeichert'); return; }
      if (b.dataset.test !== undefined) {
        read(); const out = $('#s-result'); out.textContent = 'Prüft …';
        try { const ids = await resolveModels(); $('#models').innerHTML = ids.filter((id) => /^(gpt|o\d)/.test(id)).sort().map((id) => `<option value="${id}">`).join(''); out.textContent = `OK · Chat ${activeModel()} (${s.effort}) · Transkription ${transcribeModel()} · ${ids.length} Modelle sichtbar`; await Store.flush(); }
        catch (error) { out.textContent = `Fehler: ${error.message}`; log('models', error.message); }
        return;
      }
      if (b.dataset.export !== undefined) {
        const blob = new Blob([JSON.stringify({ ...state, settings: { ...state.settings, apiKey: '' } }, null, 1)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fmh-musts-${new Date().toISOString().slice(0, 10)}.json`; a.click();
        return;
      }
      if (b.dataset.import !== undefined) { $('#s-file').click(); }
    };
    $('#s-file').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.progress) throw new Error('kein Fortschritt in der Datei');
        state.progress = { ...state.progress, ...data.progress }; state.notes = { ...state.notes, ...(data.notes || {}) };
        if (Array.isArray(data.threads)) { const ids = new Set(state.threads.map((t) => t.id)); state.threads = state.threads.concat(data.threads.filter((t) => !ids.has(t.id))); }
        await Store.flush(); renderMatrix(); renderStats(); renderThreads(); toast('Importiert');
      } catch (error) { toast(`Import: ${error.message}`, true); }
    };
    modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
    modal.hidden = false;
  }

  // ------------------------------------------------------------------ chat
  let busy = false; let abort = null;
  function currentThread() {
    let t = state.threads.find((x) => x.id === state.current);
    if (!t) { t = { id: uid(), title: '', t: Date.now(), messages: [] }; state.threads.push(t); state.current = t.id; }
    return t;
  }
  function newThread() {
    const cur = state.threads.find((x) => x.id === state.current);
    if (cur && !cur.messages.length) return;
    const t = { id: uid(), title: '', t: Date.now(), messages: [] };
    state.threads.push(t); state.current = t.id;
    if (state.threads.length > 40) state.threads = state.threads.filter((x) => x.messages.length).slice(-40).concat(t.messages.length ? [] : [t]).filter((x, i, a) => a.indexOf(x) === i);
    Store.save(); renderThreads(); renderMessages();
  }
  function renderThreads() {
    const sel = $('#threads');
    const list = state.threads.filter((t) => t.messages.length || t.id === state.current).slice().sort((a, b) => b.t - a.t);
    sel.innerHTML = list.map((t) => `<option value="${t.id}" ${t.id === state.current ? 'selected' : ''}>${esc(t.title || 'Neues Gespräch')} · ${new Date(t.t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })}</option>`).join('');
  }
  function messageEl(m) {
    const div = document.createElement('div');
    if (m.role === 'user') { div.className = 'msg user'; div.textContent = m.label || m.content; return div; }
    div.className = 'msg coach'; div.innerHTML = markdown(m.content);
    if (m.events?.length) {
      const tags = document.createElement('div');
      tags.innerHTML = m.events.map((ev) => { const c = caseById(ev.case_id); return `<span class="tag ${esc(ev.ergebnis)}">${esc(c?.title || ev.case_id)} · ${esc(ev.stufe)} ${esc(ev.ergebnis)}</span>`; }).join('');
      div.appendChild(tags);
    }
    return div;
  }
  function renderMessages() {
    const t = currentThread(); const box = $('#messages'); box.innerHTML = '';
    if (!t.messages.length) {
      box.innerHTML = '<div class="welcome"><h1>Was dürfen Sie nicht verpassen?</h1></div>';
      return;
    }
    for (const m of t.messages) box.appendChild(messageEl(m));
    box.scrollTop = box.scrollHeight;
  }
  async function send(text, label) {
    const content = String(text || '').trim();
    if (!content || busy || !requireKey()) return;
    const t = currentThread(); const box = $('#messages');
    if (!t.messages.length) { box.innerHTML = ''; t.title = (label || content).slice(0, 48); }
    const userMsg = { role: 'user', content, t: Date.now() }; if (label) userMsg.label = label;
    t.messages.push(userMsg); t.t = Date.now();
    box.appendChild(messageEl(userMsg)); Store.save(); renderThreads();
    const el = document.createElement('div'); el.className = 'msg coach'; el.innerHTML = '<span class="spinner"></span>'; box.appendChild(el); box.scrollTop = box.scrollHeight;
    busy = true; abort = new AbortController(); $('#btn-send').textContent = 'STOPP';
    log('chat', `${activeModel()} · ${state.settings.effort} · ${content.slice(0, 80)}`);
    const events = [];
    const stick = () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight; };
    try {
      const system = P.system({ cases: CASES, notesFor: noteFor, progressFor, runtime: { model: activeModel(), effort: isReasoningModel(activeModel()) ? state.settings.effort : 'n/a' } });
      const history = t.messages.slice(-40).map((m) => ({ role: m.role, content: m.content }));
      const full = await chatStream({
        system, messages: history, signal: abort.signal,
        onDelta: (txt) => { el.innerHTML = markdown(txt); stick(); },
        onTool: (args) => {
          const c = caseById(String(args.case_id || '').trim());
          if (!c) return `Unbekannte case_id «${args.case_id}». Gültig sind die IDs der Matrix.`;
          const stufe = args.stufe === 'excel' ? 'excel' : 'must'; const erg = ['ok', 'teilweise', 'fehlt'].includes(args.ergebnis) ? args.ergebnis : 'teilweise';
          setProgress(c.id, stufe, erg, args.luecken);
          events.push({ case_id: c.id, stufe, ergebnis: erg });
          return `Eingetragen: ${c.title} · ${stufe} ${erg}.`;
        },
      });
      const msg = { role: 'assistant', content: full || '(keine Antwort)', t: Date.now(), events };
      t.messages.push(msg); el.replaceWith(messageEl(msg));
    } catch (error) {
      if (error.name === 'AbortError') { el.remove(); t.messages.pop(); }
      else { el.className = 'msg error'; el.textContent = `Fehler: ${error.message}`; log('chat-error', `${activeModel()} · ${error.status || ''} ${error.message}`); }
    }
    busy = false; abort = null; $('#btn-send').textContent = 'SENDEN'; Store.save(); renderThreads(); stick();
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(220, ta.scrollHeight)}px`; }

  // ------------------------------------------------------------------ init
  async function init() {
    await Store.init();
    renderMatrix(); renderStats(); renderCountdown(); renderThreads(); renderMessages();
    const input = $('#input');
    $('#matrix').addEventListener('click', (e) => { const b = e.target.closest('.tile'); if (b) openCase(b.dataset.id); });
    $('#btn-settings').onclick = openSettings;
    $('#btn-new').onclick = newThread;
    $('#threads').onchange = (e) => { state.current = e.target.value; Store.save(); renderMessages(); };
    const CHIPS = {
      open: ['Prüfe mich auf die Must-knows von 5 zufälligen Fällen der Matrix, die ich noch nie gemacht habe. Nenne die fünf Fälle, dann die erste Frage.', '5 offene Fälle'],
      weak: ['Prüfe mich auf die Must-knows der Fälle, bei denen ich FEHLT oder TEILWEISE habe, die schlechtesten zuerst. Gibt es keine, nimm nie geprüfte Fälle.', 'Schwächen drillen'],
      set: ['Erstelle ein Fragenset mit 10 MUST-Fragen quer durch die Matrix, bevorzugt zu offenen Fällen, ohne Antworten.', 'Fragenset'],
      excel: ['Jetzt die Excel-Punkte zum zuletzt geprüften Fall: stell mir die schweren Fragen, eine nach der anderen.', 'Excel dazu'],
    };
    $('#chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || !CHIPS[b.dataset.chip]) return; send(...CHIPS[b.dataset.chip]); });
    $('#btn-send').onclick = () => { if (busy) { abort?.abort(); return; } const v = input.value; input.value = ''; autosize(input); send(v); };
    input.addEventListener('input', () => autosize(input));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#btn-send').click(); } });
    wireMic($('#btn-mic'), input);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#case-modal').hidden = true; $('#settings-modal').hidden = true; } });
    window.addEventListener('beforeunload', () => Store.flush());
    if (!state.settings.apiKey) openSettings();
    else if (!state.settings.resolvedModel) resolveModels().catch((error) => { toast(`Modelle: ${error.message}`, true); log('models', error.message); });
    log('start', `${serverOk ? 'server' : 'localStorage'} · key ${state.settings.apiKey ? 'vorhanden' : 'fehlt'} · modell ${activeModel()} · ${navigator.userAgent}`);
    input.focus();
  }
  init();
})();
