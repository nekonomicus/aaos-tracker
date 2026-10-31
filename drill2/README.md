# FMH MUSTS

The simple drill for the swiss orthopaedics oral exam (Schlussprüfung 2. Teil, 21 Nov 2026).
One matrix, one chat, one goal: in none of the 118 cases miss the points you cannot miss.

## Start

```
cd drill2
python3 server.py        # or double-click start.command
```

Opens http://127.0.0.1:8766. First time: paste the OpenAI key under ⚙ and press SPEICHERN
(if the old drill in `../drill` has a key saved, it is taken over automatically). Everything is saved
in `drill2/userdata/` (git-ignored); opening `index.html` directly also works (then it lives in the
browser's localStorage). Needs macOS `python3`, a browser, internet for api.openai.com.

## What it is

**Matrix** (left): the 118 cases of the FMH case matrix in their regions, plus the 5 general reserve
cases. Tile colours: grey = never drilled, red = gaps (MUST or EXCEL fehlt/teilweise), olive = MUST ok,
green = MUST and EXCEL ok. A yellow dot = you have a note on this case. The header counts MUST ok,
EXCEL ok, gaps and open cases out of 118.

Click a tile: set the MUST / EXCEL state by hand, read the last recorded gaps, write or edit your own
ultra-short note (the must-knows of this case), and start a drill on it directly (MUST ABFRAGEN,
EXCEL ABFRAGEN, LISTE ZEIGEN).

**Chat** (right): one coach, text or dictation (● SPRECHEN records, STOP transcribes with the newest
`gpt-…-transcribe` of your key and puts the text into the box; no live voice). Ask for what you want in
your own words:

- "Prüf mich auf 5 Kinderthemen" → picks 5 paediatric cases (undone ones first), asks one question
  at a time, grades, shows the full checklist with ✓ ✗ !, records the result on the matrix.
- "Fragenset zu Beckenringfrakturen, 10 Fragen" → a numbered set without answers.
- "Teste mich hart auf die Hüfte" / "jetzt die Excel-Punkte dazu" → EXCEL level.
- "Was fehlt mir noch" / "die Fälle mit Lücken" / "die ich noch nie gemacht habe" → uses the progress table.
- "Zeig mir die Must-knows zu Lisfranc" → the list directly, MUST first, EXCEL after.

The chips above the box are just shortcuts for these. NEU starts a new conversation; the dropdown
reopens earlier ones.

## Two levels

The coach always separates **MUST** (cannot-miss: danger recognised, exact diagnosis and the one
decision-relevant classification with its consequence, the one to three thresholds that carry the
decision, the Swiss standard treatment with a clear decision, named complications, Aufklärung and
Nachsorge, Swiss specifics) from **EXCEL** (what separates a 6 from a 4: technique and approach
details, rare variants, numbers beyond the thresholds, alternatives, evidence, revision strategy).
Without a level named, MUST applies; "hart", "schwer", "Excel", "Details" mean EXCEL.

After each graded answer the coach calls the `fortschritt` tool (case, level, ok / teilweise / fehlt,
gaps), which updates the matrix at once. The whole progress table is handed to the coach on every
turn, so "drill my weaknesses" works.

## Memory

Three layers, all handed to the coach on every message and saved in `userdata/state.json`:

- **Note per case**: your ultra-short summary, the basis for the questions on that case. Paste it into the
  chat ("hier meine Zusammenfassung zu Lisfranc: …") and the coach stores it on the case; or press NOTIZ
  next to the input to open the pad of the case being drilled (or pick one), or click the tile.
- **Rules**: say how you want to be taught ("halte die Fragen kurz", "frag immer zuerst nach der
  Gefahr", "auf Englisch") and the coach memorises it as a rule for all future conversations.
- **Chat distillate**: when you start a new conversation (NEU) or switch to another, the finished one is
  distilled into up to four lines (gaps per case, what you had down cold, wishes you expressed).

The whole memory is editable under ⚙ (one line per entry; delete lines to forget).

## Your notes

`data/notes.js` holds your own ultra-short summaries per case id. Where a note exists, it is the
authoritative must-know list for that case: the coach tests those points first and marks anything it
adds as its own. Notes typed in the app override the file locally. Paste new summaries into
`data/notes.js` (or the tile) and they are live on the next message.

## Model

"auto" picks the strongest chat model your key can use (gpt-6 › gpt-5.x › gpt-4.1; never mini, nano
or the slow pro models). Reasoning effort defaults to high; xhigh is tried if you choose it and the
model refuses it, the setting falls back to high. The coach has no web search and no documents: the
matrix, your notes and your progress are all it knows beyond the model itself. Calls go through the
Responses API (the gpt-6 models accept function tools with reasoning only there).

## Files

`index.html`, `styles.css`, `app.js` (UI, OpenAI calls, dictation, progress), `prompts.js` (everything
the coach is told), `data/cases.js` (generated from `nekonomicus/fmh-oral-2026`, `app/study-data.ts`),
`data/notes.js` (your summaries), `server.py` (static files + `userdata/state.json`, daily backups).

## When something does not work

The browser reports every error to the server: it appears in the terminal where `server.py` runs and
in `drill2/userdata/log.txt` (model used, each chat call, API errors, microphone and transcription
errors). Paste those lines when asking for help.
