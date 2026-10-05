(() => {
  'use strict';

  const { schedule, recall, dayIndex, startOfDay, STATE, DAY, MIN } = window.FSRS;
  const DECKS = window.DECKS || [];
  const CARDS = window.CARDS || [];
  const DECK = Object.fromEntries(DECKS.map((d) => [d.key, d]));
  const BY_ID = new Map(CARDS.map((c) => [c.id, c]));
  const REGIONS = [...new Set(DECKS.map((d) => d.region))];
  const KIND_LABEL = {
    classification: 'Classification', algorithm: 'Algorithm', anatomy: 'Anatomy', approach: 'Approach',
    numbers: 'Numbers', diagnostics: 'Diagnostics', management: 'Management', complications: 'Complications',
    aftercare: 'Aftercare', viva: 'Viva case',
  };
  const GRADES = [
    { g: 1, label: 'Again', key: 'a' },
    { g: 2, label: 'Hard', key: 'h' },
    { g: 3, label: 'Good', key: 'g' },
    { g: 4, label: 'Easy', key: 'e' },
  ];
  const SEC_PER_CARD = 50;
  const MATURE_DAYS = 21;

  // ───────────────────────── storage ─────────────────────────
  const STORE = 'fmh-drill/v1';
  const DEFAULTS = { exam: '2026-11-20', rr: 0.9, newPerDay: 20, sessionSize: 30, strict: '0.9', lang: 'de-CH', theme: 'auto', scope: [] };
  const normalize = (d) => ({
    v: 1,
    mem: d && typeof d.mem === 'object' && d.mem ? d.mem : {},
    log: d && Array.isArray(d.log) ? d.log : [],
    flags: d && typeof d.flags === 'object' && d.flags ? d.flags : {},
    settings: Object.assign({}, DEFAULTS, d && d.settings),
  });
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* private mode or corrupt: start fresh */ }
    return normalize(null);
  }
  let db = load();
  let saveFailed = false;
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(db)); saveFailed = false; }
    catch (e) { if (!saveFailed) toast('Progress could not be saved in this browser — export a backup.'); saveFailed = true; }
  }
  // Log rows: [timestamp, cardId, grade, scorePct, msToAnswer, stateBefore]
  const L = { T: 0, ID: 1, G: 2, P: 3, MS: 4, ST: 5 };

  // ───────────────────────── helpers ─────────────────────────
  const $ = (sel, el = document) => el.querySelector(sel);
  const view = $('#view');
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const now = () => Date.now();
  const today = () => dayIndex(now());
  const pct = (x) => `${Math.round(x * 100)}%`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const fmtDate = (ms, opts) => new Date(ms).toLocaleDateString('en-GB', opts || { day: 'numeric', month: 'short' });
  const dayMs = (idx) => startOfDay(idx) + 8 * 3600000; // a moment safely inside that study day
  const fmtMins = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
  function fmtIvl(ms) {
    const m = ms / MIN;
    if (m < 60) return `${Math.max(1, Math.round(m))}m`;
    const d = ms / DAY;
    if (d < 1) return `${Math.round(m / 60)}h`;
    if (d < 45) return `${Math.round(d)}d`;
    return `${(d / 30).toFixed(1)}mo`;
  }
  function examDayIdx() {
    const t = Date.parse(`${db.settings.exam}T12:00:00`);
    return Number.isFinite(t) ? dayIndex(t) : null;
  }
  function daysToExam() {
    const e = examDayIdx();
    return e == null ? null : e - today();
  }
  function schedOpts() {
    const left = daysToExam();
    // Cap intervals so every card comes back at least once before the exam.
    const maxIvl = left == null || left < 0 ? 36500 : Math.max(1, left - 1);
    return { rr: Number(db.settings.rr) || 0.9, maxIvl };
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const deckOf = (c) => DECK[c.deck] || { title: c.deck, region: '' };
  const inScope = (c) => !db.settings.scope.length || db.settings.scope.includes(deckOf(c).region);
  const pointCount = (c) => (c.kind === 'viva' ? c.steps.reduce((n, s) => n + s.a.length, 0) : c.a.length);

  // ───────────────────────── stats ─────────────────────────
  function introducedToday() {
    const t0 = startOfDay(today());
    let n = 0;
    for (let i = db.log.length - 1; i >= 0 && db.log[i][L.T] >= t0; i--) if (db.log[i][L.ST] === STATE.New) n++;
    return n;
  }
  const newLeft = () => Math.max(0, (Number(db.settings.newPerDay) || 0) - introducedToday());
  const isSeen = (id) => !!db.mem[id];
  const LEARN_AHEAD = 20 * MIN; // learning-step cards this close to due count as ready (as in Anki)
  const isDue = (id, t) => {
    const m = db.mem[id];
    if (!m) return false;
    const learning = m.st === STATE.Learning || m.st === STATE.Relearning;
    return m.due <= (learning ? t + LEARN_AHEAD : t);
  };
  function cardRecall(id, t) { return isSeen(id) ? recall(db.mem[id], t) : 0; }
  function reviewsOnDay(idx) {
    const a = startOfDay(idx), b = startOfDay(idx + 1);
    return db.log.filter((r) => r[L.T] >= a && r[L.T] < b).length;
  }
  function streak() {
    const days = new Set(db.log.map((r) => dayIndex(r[L.T])));
    let d = today();
    if (!days.has(d)) d -= 1;
    let n = 0;
    while (days.has(d)) { n++; d--; }
    return n;
  }
  /** True retention: share of reviews of graduated cards (not learning steps) answered Hard/Good/Easy. */
  function trueRetention(sinceMs) {
    let pass = 0, n = 0;
    for (const r of db.log) {
      if (r[L.T] < sinceMs || r[L.ST] !== STATE.Review) continue;
      n++;
      if (r[L.G] > 1) pass++;
    }
    return n ? { rate: pass / n, n } : null;
  }
  function cardState(id) {
    const m = db.mem[id];
    if (!m) return 'new';
    if (m.st === STATE.Learning || m.st === STATE.Relearning) return 'learn';
    return m.s >= MATURE_DAYS ? 'mature' : 'young';
  }
  function deckStats(key, t) {
    const cards = CARDS.filter((c) => c.deck === key);
    let seen = 0, due = 0, mature = 0, lapses = 0, rsum = 0;
    for (const c of cards) {
      const m = db.mem[c.id];
      if (!m) continue;
      seen++;
      if (isDue(c.id, t)) due++;
      if (m.st === STATE.Review && m.s >= MATURE_DAYS) mature++;
      lapses += m.lapses || 0;
      rsum += recall(m, t);
    }
    return { total: cards.length, seen, due, mature, lapses, unseen: cards.length - seen, recall: cards.length ? rsum / cards.length : 0 };
  }

  // ───────────────────────── session building ─────────────────────────
  /** New cards in teaching order: within a deck, basics before viva cases; decks interleaved round-robin. */
  function newCardOrder(pool) {
    const byDeck = new Map();
    for (const c of pool) {
      if (!byDeck.has(c.deck)) byDeck.set(c.deck, []);
      byDeck.get(c.deck).push(c);
    }
    for (const list of byDeck.values()) list.sort((a, b) => (a.kind === 'viva') - (b.kind === 'viva'));
    const lists = DECKS.map((d) => byDeck.get(d.key)).filter(Boolean);
    const out = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  }
  function interleave(reviews, fresh) {
    const out = [];
    let r = 0, n = 0;
    while (r < reviews.length || n < fresh.length) {
      for (let k = 0; k < 3 && r < reviews.length; k++) out.push(reviews[r++]);
      if (n < fresh.length) out.push(fresh[n++]);
    }
    return out;
  }
  function buildQueue(mode, opts = {}) {
    const t = now();
    const size = Math.max(5, Number(db.settings.sessionSize) || 30);
    const pool = CARDS.filter((c) => (opts.deck ? c.deck === opts.deck : opts.ids ? opts.ids.includes(c.id) : inScope(c)));
    const byWeakness = (a, b) => cardRecall(a.id, t) - cardRecall(b.id, t);
    if (mode === 'ids') return pool.sort(byWeakness).map((c) => c.id);
    if (mode === 'weak') return pool.filter((c) => isSeen(c.id)).sort(byWeakness).slice(0, size).map((c) => c.id);
    if (mode === 'viva') {
      const v = pool.filter((c) => c.kind === 'viva');
      const due = v.filter((c) => isDue(c.id, t)).sort(byWeakness);
      const fresh = v.filter((c) => !isSeen(c.id));
      const rest = v.filter((c) => isSeen(c.id) && !isDue(c.id, t)).sort(byWeakness);
      return [...due, ...shuffle(fresh), ...rest].slice(0, Math.min(size, 12)).map((c) => c.id);
    }
    if (mode === 'sweep') {
      // Every card not reviewed in the last 7 days, least recently reviewed first; unseen cards last.
      const cut = t - 7 * DAY;
      const stale = pool.filter((c) => isSeen(c.id) && db.mem[c.id].last < cut).sort((a, b) => db.mem[a.id].last - db.mem[b.id].last);
      return stale.slice(0, size).map((c) => c.id);
    }
    // Default: due reviews (weakest first) interleaved with today's new cards.
    const due = pool.filter((c) => isDue(c.id, t)).sort(byWeakness);
    const fresh = newCardOrder(pool.filter((c) => !isSeen(c.id))).slice(0, newLeft());
    return interleave(due, fresh).slice(0, size).map((c) => c.id);
  }
  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  }

  let S = null; // active session
  function startSession(mode, opts = {}) {
    const queue = buildQueue(mode, opts);
    if (!queue.length) {
      toast(mode === 'weak' ? 'Nothing reviewed yet in this scope.' : mode === 'sweep' ? 'Everything was reviewed this week.' : 'Nothing due right now.');
      return;
    }
    S = { mode, opts, queue, learning: [], results: [], shown: 0, planned: queue.length, started: now(), cur: null, lastId: null };
    nextCard();
    if (route().name === 'study') render(); else location.hash = '#/study';
  }
  function nextCard() {
    const t = now();
    S.learning.sort((a, b) => a.due - b.due);
    let id = null;
    const readyIdx = S.learning.findIndex((l) => l.due <= t && (l.id !== S.lastId || (S.queue.length === 0 && S.learning.length === 1)));
    if (readyIdx >= 0) id = S.learning.splice(readyIdx, 1)[0].id;
    else if (S.queue.length) id = S.queue.shift();
    else if (S.learning.length) id = S.learning.shift().id; // learn ahead rather than idling
    if (!id) { S.cur = null; return; }
    S.lastId = id;
    S.shown++;
    S.cur = { id, step: 0, phase: 'answer', answers: [], ticks: [], auto: [], t0: now(), tReveal: null, armed: false, rand: Math.random() };
  }

  // ───────────────────────── answer matching ─────────────────────────
  const STOP = new Set(('the and for with from that this into than then are was were has have had not but its their them they you your our out per via der die das und oder mit von bei den dem des ein eine einer eines ist sind auf aus für fur wenn nach zur zum über uber unter nicht auch noch als wie bis sowie oder nur bzw usw ' +
    'all any can may use used also more most less only each other both when where which what how who why does such than very within without after before during over under about').split(' '));
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  const stem = (w) => (/^\d/.test(w) ? w.replace(',', '.') : w.length > 6 ? w.slice(0, 6) : w);
  function keyTokens(text) {
    const words = norm(text).match(/[a-z]+|\d+(?:[.,]\d+)?/g) || [];
    return [...new Set(words.filter((w) => /^\d/.test(w) || (w.length >= 3 && !STOP.has(w))).map(stem))];
  }
  function autoTicks(points, answer) {
    if (!answer || answer.trim().length < 3) return points.map(() => false);
    const have = new Set(keyTokens(answer));
    return points.map((p) => {
      const k = keyTokens(p);
      if (!k.length) return false;
      const hit = k.filter((w) => have.has(w)).length;
      return hit / k.length >= 0.6 && hit >= Math.min(2, k.length);
    });
  }
  function suggestGrade(ratio) {
    const strict = db.settings.strict === '0.8' ? { good: 0.8, hard: 0.5 } : { good: 0.9, hard: 0.6 };
    if (ratio >= strict.good) return 3;
    if (ratio >= strict.hard) return 2;
    return 1;
  }

  // ───────────────────────── dictation ─────────────────────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  function stopDictation() {
    if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } }
    rec = null;
    const b = $('#mic');
    if (b) b.setAttribute('aria-pressed', 'false');
  }
  function toggleDictation(ta, btn) {
    if (rec) { stopDictation(); return; }
    rec = new SR();
    rec.lang = db.settings.lang || 'de-CH';
    rec.continuous = true;
    rec.interimResults = true;
    const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    let finalText = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript + ' ';
        else interim += ev.results[i][0].transcript;
      }
      ta.value = base + finalText + interim;
      ta.dispatchEvent(new Event('input'));
    };
    rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Microphone permission denied.'); stopDictation(); };
    rec.onend = () => { if (rec) stopDictation(); };
    try { rec.start(); btn.setAttribute('aria-pressed', 'true'); }
    catch (e) { rec = null; toast('Dictation is not available here.'); }
  }

  // ───────────────────────── router ─────────────────────────
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [name, arg] = h.split('/');
    return { name: name || 'home', arg: arg ? decodeURIComponent(arg) : '' };
  }
  let timerH = null;
  function render() {
    clearInterval(timerH);
    stopDictation();
    hideTip();
    const r = route();
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === r.name || (r.name === 'deck' && a.dataset.nav === 'decks');
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!CARDS.length) { view.innerHTML = `<div class="wrap narrow empty-state">No cards loaded.</div>`; return; }
    if (r.name === 'study') { if (S && S.cur) renderStudy(); else if (S) renderSummary(); else { location.hash = '#/'; } return; }
    if (r.name === 'decks') renderDecks();
    else if (r.name === 'deck') renderDeck(r.arg);
    else if (r.name === 'progress') renderProgress();
    else renderHome();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);

  // ───────────────────────── home ─────────────────────────
  function renderHome() {
    const t = now();
    const scoped = CARDS.filter(inScope);
    const due = scoped.filter((c) => isDue(c.id, t)).length;
    const fresh = Math.min(newLeft(), scoped.filter((c) => !isSeen(c.id)).length);
    const ready = Math.min(due + fresh, Number(db.settings.sessionSize) || 30);
    const left = daysToExam();
    const seen = CARDS.filter((c) => isSeen(c.id)).length;
    const ret = trueRetention(t - 30 * DAY);
    const todayN = reviewsOnDay(today());
    const st = streak();
    const vivas = scoped.filter((c) => c.kind === 'viva').length;
    const weakN = scoped.filter((c) => isSeen(c.id)).length;
    const stale = scoped.filter((c) => isSeen(c.id) && db.mem[c.id].last < t - 7 * DAY).length;
    const scope = db.settings.scope;
    const regionCount = (rg) => CARDS.filter((c) => deckOf(c).region === rg).length;
    const dateLine = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    const resume = S && S.cur ? `<div class="row" style="margin-bottom:24px"><a class="btn" href="#/study">Resume session · ${S.results.length} done</a></div>` : '';
    view.innerHTML = `
      <div class="wrap">
        ${resume}
        <p class="eyebrow">${esc(dateLine)}</p>
        <section class="hero">
          <div>
            <div class="hero-figure num">${due + fresh}</div>
            <div class="hero-label">${due + fresh === 0 ? 'Nothing due. Drill your weakest cards or add more new ones in settings.' : `${plural(due, 'review')} due · ${fresh} new · about ${fmtMins(ready * SEC_PER_CARD)} for the next session`}</div>
          </div>
          <div class="hero-side">
            ${left != null && left >= 0 ? `<div class="countdown"><strong>${left}</strong> ${left === 1 ? 'day' : 'days'} to the exam</div><div class="muted" style="font-size:13px">${esc(fmtDate(Date.parse(db.settings.exam + 'T12:00:00'), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }))}</div>` : ''}
          </div>
        </section>
        <div class="start">
          <button class="btn primary" id="go" ${due + fresh ? '' : 'disabled'}>Start session <span class="kbd">↵</span></button>
          <span class="muted" style="font-size:14px">Answer from memory first, then mark what you actually said.</span>
        </div>

        <section class="section" aria-labelledby="scope-h">
          <div class="section-head"><h2 id="scope-h">Scope</h2><span class="muted">${scope.length ? `${scoped.length} of ${CARDS.length} cards` : `All ${CARDS.length} cards, interleaved`}</span></div>
          <div class="chips" role="group" aria-label="Regions">
            <button class="chip" data-scope="" aria-pressed="${!scope.length}">All</button>
            ${REGIONS.map((rg) => `<button class="chip" data-scope="${esc(rg)}" aria-pressed="${scope.includes(rg)}">${esc(rg)} <span class="count">${regionCount(rg)}</span></button>`).join('')}
          </div>
        </section>

        <section class="section" aria-labelledby="modes-h">
          <div class="section-head"><h2 id="modes-h">Other drills</h2></div>
          <div class="modes">
            <button class="mode" data-mode="weak"><h3>Weakest first</h3><p>The cards you are most likely to have forgotten right now, due or not.</p><div class="mode-count">${weakN ? plural(weakN, 'card') + ' seen' : 'Nothing seen yet'}</div></button>
            <button class="mode" data-mode="viva"><h3>Viva cases</h3><p>Examiner-style case chains: each answer unlocks the next, harder question.</p><div class="mode-count">${plural(vivas, 'case')}</div></button>
            <button class="mode" data-mode="sweep"><h3>Exam sweep</h3><p>Everything you have not seen for a week, oldest first. For the final stretch.</p><div class="mode-count">${stale} stale</div></button>
          </div>
        </section>

        <section class="section" aria-label="Summary">
          <div class="tiles">
            <div class="tile"><div class="tile-label">Learned</div><div class="tile-value">${seen}</div><div class="tile-sub">of ${CARDS.length} cards</div></div>
            <div class="tile"><div class="tile-label">Recall, 30 days</div><div class="tile-value">${ret ? pct(ret.rate) : '—'}</div><div class="tile-sub">${ret ? `${ret.n} reviews of learned cards` : 'after first reviews'}</div></div>
            <div class="tile"><div class="tile-label">Today</div><div class="tile-value">${todayN}</div><div class="tile-sub">${todayN === 1 ? 'review' : 'reviews'}</div></div>
            <div class="tile"><div class="tile-label">Streak</div><div class="tile-value">${st}</div><div class="tile-sub">${st === 1 ? 'day' : 'days'}</div></div>
          </div>
        </section>
      </div>`;
    $('#go').addEventListener('click', () => startSession('due'));
    view.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
      const rg = b.dataset.scope;
      if (!rg) db.settings.scope = [];
      else {
        const s = new Set(db.settings.scope);
        s.has(rg) ? s.delete(rg) : s.add(rg);
        db.settings.scope = [...s];
        if (db.settings.scope.length === REGIONS.length) db.settings.scope = [];
      }
      save();
      renderHome();
    }));
    view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => startSession(b.dataset.mode)));
  }

  // ───────────────────────── decks ─────────────────────────
  function renderDecks() {
    const t = now();
    view.innerHTML = `
      <div class="wrap">
        <h1>Decks</h1>
        <p class="lede">One deck per uploaded presentation. The bar is the average chance you would recall a card right now; unseen cards count as zero.</p>
        ${REGIONS.map((rg) => `
          <section class="region" aria-label="${esc(rg)}">
            <h2>${esc(rg)}</h2>
            ${DECKS.filter((d) => d.region === rg).map((d) => {
              const s = deckStats(d.key, t);
              if (!s.total) return '';
              return `<a class="deck-row" href="#/deck/${encodeURIComponent(d.key)}">
                <div><div class="deck-name">${esc(d.title)}</div><div class="deck-meta">${s.total} cards · ${s.unseen} new${s.mature ? ` · ${s.mature} mature` : ''}</div></div>
                <div class="meter-cell"><div class="meter" role="img" aria-label="${pct(s.recall)} average recall"><span style="width:${(s.recall * 100).toFixed(1)}%"></span></div><div class="meter-label">${pct(s.recall)} recall</div></div>
                <div class="deck-due">${s.due ? `<strong>${s.due}</strong> due` : '—'}</div>
                <div class="chev" aria-hidden="true">›</div>
              </a>`;
            }).join('')}
          </section>`).join('')}
      </div>`;
  }

  function renderDeck(key) {
    const d = DECK[key];
    if (!d) { location.hash = '#/decks'; return; }
    const t = now();
    const s = deckStats(key, t);
    const cards = CARDS.filter((c) => c.deck === key);
    const fresh = Math.min(newLeft(), s.unseen);
    view.innerHTML = `
      <div class="wrap narrow">
        <p class="eyebrow"><a href="#/decks" class="linkish">Decks</a> · ${esc(d.region)}</p>
        <h1>${esc(d.title)}</h1>
        <p class="lede">${s.total} cards from ${esc(d.src)}. ${s.seen} learned, ${s.due} due, ${pct(s.recall)} average recall.</p>
        <div class="start">
          <button class="btn primary" id="deck-go" ${s.due + fresh ? '' : 'disabled'}>Study this deck${s.due + fresh ? ` · ${s.due + fresh}` : ''}</button>
          <button class="btn" id="deck-weak" ${s.seen ? '' : 'disabled'}>Weakest first</button>
          ${cards.some((c) => c.kind === 'viva') ? '<button class="btn" id="deck-viva">Viva cases</button>' : ''}
        </div>
        <section class="browse" aria-labelledby="browse-h">
          <div class="section-head"><h2 id="browse-h">All cards</h2><span class="muted">Reading is passive — drill first, browse after.</span></div>
          <div>
            ${cards.map((c) => {
              const m = db.mem[c.id];
              const status = !m ? 'new' : m.st === STATE.Review ? `${pct(recall(m, t))} · next ${fmtDate(m.due)}` : 'learning';
              const body = c.kind === 'viva'
                ? `<p class="muted" style="margin:0 0 6px">${esc(c.q)}</p>${c.steps.map((st) => `<div class="ci-step"><div class="ci-step-q">${esc(st.q)}</div><ol>${st.a.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></div>`).join('')}`
                : `<ol>${c.a.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>`;
              return `<details class="card-item"><summary><span class="ci-q">${esc(c.kind === 'viva' ? 'Case: ' + c.q : c.q)}</span><span class="ci-meta">${esc(KIND_LABEL[c.kind] || c.kind)} · ${esc(status)}${db.flags[c.id] ? ' · flagged' : ''}</span></summary>
                <div class="ci-body">${body}${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}<p class="src">${esc(c.src)}</p></div></details>`;
            }).join('')}
          </div>
        </section>
      </div>`;
    $('#deck-go').addEventListener('click', () => startSession('due', { deck: key }));
    $('#deck-weak').addEventListener('click', () => startSession('weak', { deck: key }));
    const v = $('#deck-viva');
    if (v) v.addEventListener('click', () => startSession('viva', { deck: key }));
  }

  // ───────────────────────── study ─────────────────────────
  function previewIntervals(id) {
    const t = now();
    const o = Object.assign(schedOpts(), { rand: S.cur.rand });
    return GRADES.map(({ g }) => {
      const next = schedule(db.mem[id], g, t, o);
      return fmtIvl(next.due - t);
    });
  }
  function currentStepData(c, step) {
    return c.kind === 'viva' ? c.steps[step] : { q: c.q, a: c.a };
  }

  function renderStudy() {
    const cur = S.cur;
    const c = BY_ID.get(cur.id);
    const d = deckOf(c);
    const m = db.mem[c.id];
    const isViva = c.kind === 'viva';
    const stepData = currentStepData(c, cur.step);
    const done = S.results.length;
    const total = done + 1 + S.queue.length + S.learning.length;
    const progress = done / total;
    const tags = [
      `<span class="tag">${esc(d.region)} · ${esc(d.title)}</span>`,
      `<span class="tag">${esc(KIND_LABEL[c.kind] || c.kind)}</span>`,
      !m ? '<span class="tag new">New</span>' : '',
      m && m.st === STATE.Relearning ? '<span class="tag lapse">Relearning</span>' : '',
      m && m.lapses ? `<span class="tag">${plural(m.lapses, 'lapse')}</span>` : '',
    ].join('');

    const doneSteps = isViva ? cur.answers.map((a, i) => `<div class="done-step"><span>${esc(c.steps[i].q)}</span><strong class="num">${a.got}/${a.of}</strong></div>`).join('') : '';
    const questionBlock = isViva
      ? `<p class="stem">${esc(c.q)}</p>${doneSteps ? `<div class="done-steps">${doneSteps}</div>` : ''}<p class="step-label">Question ${cur.step + 1} of ${c.steps.length}</p><h1 class="question">${esc(stepData.q)}</h1>`
      : `<h1 class="question">${esc(c.q)}</h1>`;

    view.innerHTML = `
      <div class="study">
        <div class="study-top">
          <div class="progress-line" aria-hidden="true"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
          <span class="study-count">${done + 1} / ${total}</span>
          <button class="end-btn" id="end">End</button>
        </div>
        <div class="meta">${tags}</div>
        ${questionBlock}
        <div id="phase"></div>
      </div>`;
    $('#end').addEventListener('click', () => { S.queue = []; S.learning = []; S.cur = null; render(); });
    if (cur.phase === 'answer') renderAnswerPhase(c, stepData); else renderRevealPhase(c, stepData);
  }

  function renderAnswerPhase(c, stepData) {
    const cur = S.cur;
    const ph = $('#phase');
    ph.innerHTML = `
      <div class="answer-box">
        <textarea id="ans" aria-label="Your answer" placeholder="Answer from memory, as you would to the examiner…" autocomplete="off" autocapitalize="sentences" spellcheck="false"></textarea>
        <div class="answer-tools">
          <span class="timer" id="timer">0:00</span>
          ${SR ? `<button type="button" class="mic" id="mic" aria-pressed="false" title="Dictate (${esc(db.settings.lang)})"><span class="rec" aria-hidden="true"></span>Dictate</button>` : ''}
        </div>
      </div>
      <div class="answer-actions">
        <button class="linkish" id="dunno">I don't know</button>
        <div class="row">
          <span class="hint hide-sm"><kbd>⌘</kbd> <kbd>↵</kbd></span>
          <button class="btn primary" id="check">Check answer</button>
        </div>
      </div>
      <p class="hint" id="nudge" hidden>Nothing written. Say your full answer out loud first, then check — recall, don't recognise.</p>`;
    const ta = $('#ans');
    const draft = cur.draft || '';
    ta.value = draft;
    ta.addEventListener('input', () => { cur.draft = ta.value; });
    const timer = $('#timer');
    const tick = () => {
      const s = Math.floor((now() - cur.t0) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    timerH = setInterval(tick, 1000);
    if (window.matchMedia('(hover: hover)').matches) ta.focus();
    const mic = $('#mic');
    if (mic) mic.addEventListener('click', () => toggleDictation(ta, mic));
    const check = (forceEmpty) => {
      const text = ta.value.trim();
      if (!text && !forceEmpty && !cur.armed) {
        cur.armed = true;
        $('#nudge').hidden = false;
        $('#check').textContent = 'I said it — check';
        return;
      }
      stopDictation();
      cur.lastAnswer = forceEmpty === 'dunno' ? '' : text;
      cur.dunno = forceEmpty === 'dunno';
      cur.tReveal = cur.tReveal || now();
      cur.phase = 'reveal';
      cur.ticks = cur.dunno ? stepData.a.map(() => false) : autoTicks(stepData.a, text);
      cur.auto = cur.ticks.slice();
      cur.draft = '';
      clearInterval(timerH);
      renderStudy();
    };
    $('#check').addEventListener('click', () => check(false));
    $('#dunno').addEventListener('click', () => check('dunno'));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); check(false); }
    });
  }

  function renderRevealPhase(c, stepData) {
    const cur = S.cur;
    const isViva = c.kind === 'viva';
    const lastStep = !isViva || cur.step === c.steps.length - 1;
    const ph = $('#phase');
    const got = () => cur.ticks.filter(Boolean).length;
    const scoreAll = () => {
      const prev = cur.answers.reduce((s, a) => [s[0] + a.got, s[1] + a.of], [0, 0]);
      return { got: prev[0] + got(), of: prev[1] + stepData.a.length };
    };
    const ivls = lastStep ? previewIntervals(c.id) : null;
    ph.innerHTML = `
      <div class="reveal">
        <div class="yours ${cur.lastAnswer ? '' : 'empty'}">${cur.lastAnswer ? esc(cur.lastAnswer) : cur.dunno ? 'Marked as not known.' : 'Answered out loud.'}</div>
        <div class="key-head"><h3>Answer key — tick what you produced</h3><span class="score" id="score"></span></div>
        <ul class="points">
          ${stepData.a.map((p, i) => `<li class="point ${cur.ticks[i] ? '' : 'miss'}"><label>
              <input type="checkbox" data-i="${i}" ${cur.ticks[i] ? 'checked' : ''}>
              <span class="pt-text">${esc(p)}${cur.auto[i] ? '<span class="auto" title="Matched words in your answer">in your answer</span>' : ''}</span>
              <span class="pt-k hide-sm">${i < 9 ? i + 1 : i === 9 ? 0 : ''}</span></label></li>`).join('')}
        </ul>
        ${lastStep && c.note ? `<p class="note"><b>Pearl.</b> ${esc(c.note)}</p>` : ''}
        ${lastStep ? `<p class="src">${esc(deckOf(c).src)} · ${esc(c.src)} · <button class="linkish" id="flag">${db.flags[c.id] ? 'Unflag card' : 'Flag card for review'}</button></p>` : ''}
        ${lastStep ? `
          <div class="grades" role="group" aria-label="Grade your recall">
            <div class="grades-inner">
              ${GRADES.map((gr, i) => `<button class="grade" data-g="${gr.g}"><span>${gr.label}</span><small>${ivls[i]}</small></button>`).join('')}
            </div>
            <div class="grade-hint hide-sm"><kbd>1</kbd>–<kbd>0</kbd> tick points · <kbd>↵</kbd> accept suggestion · <kbd>A</kbd> <kbd>H</kbd> <kbd>G</kbd> <kbd>E</kbd> grade</div>
          </div>` : `
          <div class="next-step row end"><span class="hint hide-sm"><kbd>↵</kbd></span><button class="btn primary" id="next-q">Next question</button></div>`}
      </div>`;
    const updateScore = () => {
      const sc = scoreAll();
      const ratio = sc.of ? sc.got / sc.of : 0;
      $('#score').innerHTML = `<strong>${got()}</strong> / ${stepData.a.length}${isViva && cur.step ? ` · case ${sc.got}/${sc.of}` : ''}`;
      if (lastStep) {
        const sug = suggestGrade(ratio);
        ph.querySelectorAll('.grade').forEach((b) => b.classList.toggle('suggested', Number(b.dataset.g) === sug));
      }
    };
    ph.querySelectorAll('.point input').forEach((inp) => inp.addEventListener('change', () => {
      cur.ticks[Number(inp.dataset.i)] = inp.checked;
      inp.closest('.point').classList.toggle('miss', !inp.checked);
      updateScore();
    }));
    updateScore();
    if (lastStep) {
      ph.querySelectorAll('.grade').forEach((b) => b.addEventListener('click', () => grade(Number(b.dataset.g))));
      $('#flag').addEventListener('click', (e) => {
        if (db.flags[c.id]) delete db.flags[c.id]; else db.flags[c.id] = now();
        save();
        e.target.textContent = db.flags[c.id] ? 'Unflag card' : 'Flag card for review';
        toast(db.flags[c.id] ? 'Flagged — listed under Progress.' : 'Flag removed.');
      });
    } else {
      $('#next-q').addEventListener('click', advanceStep);
    }
    // Keep focus off the grade buttons so Enter always takes the *current* suggestion after re-ticking.
    view.focus({ preventScroll: true });
  }

  function advanceStep() {
    const cur = S.cur;
    const c = BY_ID.get(cur.id);
    const stepData = currentStepData(c, cur.step);
    cur.answers.push({ got: cur.ticks.filter(Boolean).length, of: stepData.a.length });
    cur.step++;
    cur.phase = 'answer';
    cur.ticks = [];
    cur.auto = [];
    cur.armed = false;
    cur.lastAnswer = '';
    renderStudy();
  }

  function grade(g) {
    const cur = S.cur;
    const c = BY_ID.get(cur.id);
    const stepData = currentStepData(c, cur.step);
    const prev = cur.answers.reduce((s, a) => [s[0] + a.got, s[1] + a.of], [0, 0]);
    const got = prev[0] + cur.ticks.filter(Boolean).length;
    const of = prev[1] + stepData.a.length;
    const t = now();
    const before = db.mem[c.id];
    const stBefore = before ? before.st : STATE.New;
    const next = schedule(before, g, t, Object.assign(schedOpts(), { rand: cur.rand }));
    db.mem[c.id] = next;
    db.log.push([t, c.id, g, Math.round((got / Math.max(1, of)) * 100), (cur.tReveal || t) - cur.t0, stBefore]);
    save();
    S.results.push({ id: c.id, g, got, of });
    if ((next.st === STATE.Learning || next.st === STATE.Relearning) && next.due - t < DAY) S.learning.push({ id: c.id, due: next.due });
    nextCard();
    render();
  }

  // ───────────────────────── summary ─────────────────────────
  function renderSummary() {
    const res = S.results;
    if (!res.length) { S = null; location.hash = '#/'; return; }
    const got = res.reduce((n, r) => n + r.got, 0);
    const of = res.reduce((n, r) => n + r.of, 0);
    const cards = new Set(res.map((r) => r.id)).size;
    const passFirst = new Map();
    for (const r of res) if (!passFirst.has(r.id)) passFirst.set(r.id, r);
    const firstTry = [...passFirst.values()];
    const passed = firstTry.filter((r) => r.g > 1).length;
    const weak = firstTry.filter((r) => r.got / r.of < 0.9).sort((a, b) => a.got / a.of - b.got / b.of).slice(0, 8);
    const mins = (now() - S.started) / 1000;
    const mode = S.mode, opts = S.opts;
    view.innerHTML = `
      <div class="wrap narrow summary">
        <p class="eyebrow">Session complete</p>
        <div class="hero-figure num">${pct(of ? got / of : 0)}</div>
        <div class="hero-label">of key points produced · ${plural(cards, 'card')} · ${passed} passed first time · ${fmtMins(mins)}</div>
        <div class="start">
          <button class="btn primary" id="again">Keep going</button>
          <a class="btn" href="#/">Done</a>
        </div>
        ${weak.length ? `
        <section class="section" aria-labelledby="weak-h">
          <div class="section-head"><h2 id="weak-h">Gaps from this session</h2><span class="muted">These come back sooner.</span></div>
          <ul class="weak-list">${weak.map((r) => `<li><span>${esc(BY_ID.get(r.id).q)}</span><span class="pct">${r.got}/${r.of}</span></li>`).join('')}</ul>
        </section>` : ''}
      </div>`;
    $('#again').addEventListener('click', () => {
      const q = buildQueue(mode === 'ids' ? 'weak' : mode, opts);
      if (!q.length && mode === 'due') startSession('weak', opts); else startSession(mode === 'ids' ? 'weak' : mode, opts);
    });
    S = null;
  }

  // ───────────────────────── progress ─────────────────────────
  function renderProgress() {
    const t = now();
    const td = today();
    const seen = CARDS.filter((c) => isSeen(c.id));
    const ret = trueRetention(t - 30 * DAY);
    const totalMs = db.log.reduce((n, r) => n + Math.min(r[L.MS] || 0, 10 * MIN), 0);
    const counts = { new: 0, learn: 0, young: 0, mature: 0 };
    for (const c of CARDS) counts[cardState(c.id)]++;
    const examIdx = examDayIdx();
    const fEnd = examIdx != null && examIdx > td ? examIdx : td + 30;
    const forecast = [];
    for (let i = td; i <= Math.min(fEnd, td + 60); i++) forecast.push({ idx: i, n: 0 });
    for (const c of CARDS) {
      const m = db.mem[c.id];
      if (!m) continue;
      const di = Math.max(td, dayIndex(m.due));
      const slot = forecast[di - td];
      if (slot) slot.n++;
    }
    const fMax = Math.max(1, ...forecast.map((f) => f.n));
    const tick = niceStep(fMax);
    const fTop = Math.ceil(fMax / tick) * tick;
    const leeches = seen.filter((c) => (db.mem[c.id].lapses || 0) >= 2 || db.mem[c.id].d >= 8)
      .sort((a, b) => (db.mem[b.id].lapses - db.mem[a.id].lapses) || (db.mem[b.id].d - db.mem[a.id].d)).slice(0, 12);
    const flagged = CARDS.filter((c) => db.flags[c.id]);

    // Heatmap: 16 weeks back to the exam (or 4 weeks ahead), Monday-first columns.
    const startIdx = td - 7 * 15 - ((new Date(dayMs(td)).getDay() + 6) % 7);
    const endIdx = Math.max(td, examIdx != null && examIdx > td && examIdx - td < 70 ? examIdx : td + 7);
    const perDay = new Map();
    for (const r of db.log) { const k = dayIndex(r[L.T]); perDay.set(k, (perDay.get(k) || 0) + 1); }
    const lvl = (n) => (n === 0 ? 0 : n < 10 ? 1 : n < 25 ? 2 : n < 50 ? 3 : n < 100 ? 4 : 5);
    const cells = [];
    for (let i = startIdx; i <= endIdx + ((7 - ((new Date(dayMs(endIdx)).getDay() + 6) % 7) - 1)); i++) {
      const n = perDay.get(i) || 0;
      const future = i > td;
      const cls = [future ? 'future' : '', i === examIdx ? 'exam' : ''].join(' ').trim();
      const label = `${fmtDate(dayMs(i), { weekday: 'short', day: 'numeric', month: 'short' })}${i === examIdx ? ' · exam' : ''}`;
      cells.push(`<i tabindex="0" ${cls ? `class="${cls}"` : ''} data-l="${future ? 0 : lvl(n)}" data-tip="${esc(future ? (i === examIdx ? 'Exam day' : 'Upcoming') : `${n} ${n === 1 ? 'review' : 'reviews'}`)}" data-sub="${esc(label)}"></i>`);
    }
    const stTotal = CARDS.length || 1;
    const states = [
      ['new', 'New', counts.new, 'var(--st-new)'],
      ['learn', 'Learning', counts.learn, 'var(--st-learn)'],
      ['young', 'Young (stability < 21 d)', counts.young, 'var(--st-young)'],
      ['mature', 'Mature', counts.mature, 'var(--st-mature)'],
    ];

    view.innerHTML = `
      <div class="wrap">
        <h1>Progress</h1>
        <p class="lede">Scheduling uses FSRS-6: each card has a modelled stability and difficulty, and comes back when your predicted recall drops to ${pct(Number(db.settings.rr) || 0.9)}.</p>
        <section class="section" aria-label="Totals">
          <div class="tiles">
            <div class="tile"><div class="tile-label">Learned</div><div class="tile-value">${seen.length}</div><div class="tile-sub">of ${CARDS.length} cards</div></div>
            <div class="tile"><div class="tile-label">Recall, 30 days</div><div class="tile-value">${ret ? pct(ret.rate) : '—'}</div><div class="tile-sub">${ret ? `${ret.n} graduated reviews` : 'no graduated reviews yet'}</div></div>
            <div class="tile"><div class="tile-label">Reviews</div><div class="tile-value">${db.log.length}</div><div class="tile-sub">all time</div></div>
            <div class="tile"><div class="tile-label">Time recalling</div><div class="tile-value">${fmtMins(totalMs / 1000)}</div><div class="tile-sub">question to reveal</div></div>
          </div>
        </section>

        <div class="charts section">
          <section aria-labelledby="heat-h">
            <div class="chart-title" id="heat-h">Reviews per day</div>
            <div class="chart-sub">Last 16 weeks${examIdx != null && examIdx > td ? ' and the run-up to the exam (outlined square)' : ''}</div>
            <div class="heat-wrap"><div class="heat" role="img" aria-label="Calendar of reviews per day">${cells.join('')}</div></div>
            <div class="heat-legend"><span>Fewer</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i style="background:var(--heat-${l})"></i>`).join('')}<span>100+</span></div>
          </section>

          <section aria-labelledby="fc-h">
            <div class="chart-title" id="fc-h">Due per day${examIdx != null && examIdx > td ? ' until the exam' : ''}</div>
            <div class="chart-sub">Learned cards only; overdue cards count today. New cards come on top.</div>
            <div class="cols" role="img" aria-label="Forecast of due cards per day">
              ${[tick, tick * 2, tick * 3].filter((v) => v <= fTop).map((v) => `<div class="grid-y" style="bottom:${(v / fTop) * 100}%"><b>${v}</b></div>`).join('')}
              ${forecast.map((f) => `<div class="c ${f.idx === examIdx ? 'exam' : ''}" tabindex="0" data-tip="${f.n} due" data-sub="${esc(fmtDate(dayMs(f.idx), { weekday: 'short', day: 'numeric', month: 'short' }))}${f.idx === examIdx ? ' · exam' : ''}"><span style="height:${(f.n / fTop) * 100}%"></span></div>`).join('')}
            </div>
            <div class="cols-axis"><span>Today</span><span>${esc(fmtDate(dayMs(forecast[forecast.length - 1].idx)))}</span></div>
            <details style="margin-top:10px"><summary class="linkish" style="list-style:none">Show as table</summary>
              <div class="table-wrap"><table class="table" style="margin-top:8px"><thead><tr><th>Day</th><th class="num">Due</th></tr></thead><tbody>
              ${forecast.filter((f) => f.n).map((f) => `<tr><td>${esc(fmtDate(dayMs(f.idx), { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td class="num">${f.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Nothing scheduled yet</td></tr>'}
              </tbody></table></div></details>
          </section>

          <section aria-labelledby="st-h">
            <div class="chart-title" id="st-h">Card maturity</div>
            <div class="chart-sub">Mature = stability of 21 days or more: you would very likely still know it in three weeks.</div>
            <div class="stack" role="img" aria-label="${states.map((s) => `${s[1]} ${s[2]}`).join(', ')}">
              ${states.filter((s) => s[2]).map((s) => `<span tabindex="0" style="flex:${s[2] / stTotal};background:${s[3]}" data-tip="${s[2]} cards" data-sub="${esc(s[1])}"></span>`).join('')}
            </div>
            <div class="legend">${states.map((s) => `<span><span class="sw" style="background:${s[3]}"></span>${esc(s[1])} <span class="num">${s[2]}</span></span>`).join('')}</div>
          </section>

          <section aria-labelledby="dk-h">
            <div class="chart-title" id="dk-h">By deck</div>
            <div class="table-wrap"><table class="table" style="margin-top:12px">
              <thead><tr><th>Deck</th><th class="num">Learned</th><th class="num">Mature</th><th>Recall now</th><th class="num">Lapses</th><th class="num">Due</th></tr></thead>
              <tbody>${DECKS.map((d) => {
                const s = deckStats(d.key, t);
                if (!s.total) return '';
                return `<tr><td><a href="#/deck/${encodeURIComponent(d.key)}" class="linkish" style="color:var(--ink)">${esc(d.title)}</a></td><td class="num">${s.seen}/${s.total}</td><td class="num">${s.mature}</td>
                  <td><div class="meter" role="img" aria-label="${pct(s.recall)}"><span style="width:${(s.recall * 100).toFixed(1)}%"></span></div><div class="meter-label">${pct(s.recall)}</div></td>
                  <td class="num">${s.lapses}</td><td class="num">${s.due}</td></tr>`;
              }).join('')}</tbody></table></div>
          </section>

          <section aria-labelledby="lc-h">
            <div class="section-head" style="margin-bottom:8px"><div><div class="chart-title" id="lc-h">Hardest cards</div><div class="chart-sub">Forgotten twice or more, or rated hard repeatedly.</div></div>
              ${leeches.length ? '<button class="btn small" id="drill-leeches">Drill these</button>' : ''}</div>
            ${leeches.length ? `<ul class="weak-list">${leeches.map((c) => `<li><span>${esc(c.q)}</span><span class="pct">${plural(db.mem[c.id].lapses || 0, 'lapse')}</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}
          </section>

          ${flagged.length ? `<section aria-labelledby="fl-h">
            <div class="section-head" style="margin-bottom:8px"><div class="chart-title" id="fl-h">Flagged cards</div><button class="btn small" id="drill-flags">Drill these</button></div>
            <ul class="weak-list">${flagged.map((c) => `<li><span>${esc(c.q)}</span><span class="pct">${esc(deckOf(c).title)}</span></li>`).join('')}</ul>
          </section>` : ''}
        </div>
      </div>`;
    bindTips(view);
    const dl = $('#drill-leeches');
    if (dl) dl.addEventListener('click', () => startSession('ids', { ids: leeches.map((c) => c.id) }));
    const df = $('#drill-flags');
    if (df) df.addEventListener('click', () => startSession('ids', { ids: flagged.map((c) => c.id) }));
  }
  function niceStep(max) {
    const raw = max / 3;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  }

  // Tooltips: one floating element; value first, label second. Works on hover and keyboard focus.
  const tip = $('#tip');
  function showTip(el) {
    tip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = el.dataset.tip;
    tip.append(strong, document.createTextNode(el.dataset.sub || ''));
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8}px`;
  }
  function hideTip() { tip.hidden = true; }
  function bindTips(root) {
    root.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('pointerenter', () => showTip(el));
      el.addEventListener('pointerleave', hideTip);
      el.addEventListener('focus', () => showTip(el));
      el.addEventListener('blur', hideTip);
    });
  }
  window.addEventListener('scroll', hideTip, { passive: true });

  // ───────────────────────── keyboard ─────────────────────────
  document.addEventListener('keydown', (e) => {
    if ($('#settings').open) return;
    const inField = /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);
    const r = route();
    if (r.name === 'home' && e.key === 'Enter' && !inField && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') {
      const go = $('#go');
      if (go && !go.disabled) { e.preventDefault(); go.click(); }
      return;
    }
    if (r.name !== 'study' || !S || !S.cur || S.cur.phase !== 'reveal' || inField || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (/^[0-9]$/.test(k)) {
      const i = k === '0' ? 9 : Number(k) - 1;
      const box = view.querySelector(`.point input[data-i="${i}"]`);
      if (box) { e.preventDefault(); box.checked = !box.checked; box.dispatchEvent(new Event('change')); }
      return;
    }
    const gr = GRADES.find((x) => x.key === k);
    if (gr && view.querySelector('.grade')) { e.preventDefault(); grade(gr.g); return; }
    if (e.key === 'Enter') {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return; // let the focused control act
      const sug = view.querySelector('.grade.suggested');
      const nq = $('#next-q');
      if (sug) { e.preventDefault(); sug.click(); } else if (nq) { e.preventDefault(); nq.click(); }
    }
  });

  // ───────────────────────── settings ─────────────────────────
  const dlg = $('#settings');
  const form = dlg.querySelector('form');
  function applyTheme() {
    const th = db.settings.theme;
    if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
    else delete document.documentElement.dataset.theme;
  }
  $('#open-settings').addEventListener('click', () => {
    const s = db.settings;
    form.exam.value = s.exam;
    form.rr.value = s.rr;
    form.rrOut.value = pct(s.rr);
    form.newPerDay.value = s.newPerDay;
    form.sessionSize.value = s.sessionSize;
    form.strict.value = s.strict;
    form.lang.value = s.lang;
    form.theme.value = s.theme;
    dlg.showModal();
  });
  form.addEventListener('input', () => {
    const s = db.settings;
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.exam.value)) s.exam = form.exam.value;
    s.rr = Math.min(0.97, Math.max(0.8, Number(form.rr.value) || 0.9));
    form.rrOut.value = pct(s.rr);
    s.newPerDay = Math.max(0, Math.min(200, Math.round(Number(form.newPerDay.value) || 0)));
    s.sessionSize = Math.max(5, Math.min(500, Math.round(Number(form.sessionSize.value) || 30)));
    s.strict = form.strict.value;
    s.lang = form.lang.value;
    s.theme = form.theme.value;
    applyTheme();
    save();
  });
  dlg.addEventListener('close', () => { if (route().name !== 'study') render(); });
  $('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `oral-drill-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $('#import').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data.mem !== 'object' || !Array.isArray(data.log)) throw new Error('bad file');
      if (!confirm(`Replace progress in this browser with the backup (${data.log.length} reviews)?`)) return;
      db = normalize(data);
      save();
      applyTheme();
      dlg.close();
      toast('Progress imported.');
    } catch (err) {
      toast('That file is not an Oral Drill backup.');
    } finally { e.target.value = ''; }
  });
  $('#reset').addEventListener('click', () => {
    if (!confirm('Delete all progress in this browser? Export a backup first if unsure.')) return;
    db = normalize({ settings: db.settings });
    save();
    dlg.close();
    toast('Progress reset.');
  });

  applyTheme();
  if (route().name === 'study') location.hash = '#/';
  render();
})();
