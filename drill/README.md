# FMH DRILL

Daily oral-exam drill for the swiss orthopaedics Facharztprüfung, Schlussprüfung 2. Teil
(klinische Fallbesprechungen, 21 Nov 2026). Runs on your Mac, saves everything on your Mac,
talks to OpenAI directly with your own key.

## Start

```
cd drill
python3 server.py        # or double-click start.command
```

Opens http://127.0.0.1:8765. First time: paste the OpenAI key under ⚙, press SPEICHERN,
then VERBINDUNG TESTEN. The key and all progress live in `drill/userdata/` (git-ignored):

| file | content |
| --- | --- |
| `userdata/state.json` | settings, drill progress (Leitner boxes), case grades, daily log |
| `userdata/backups/` | one copy of state.json per day, last 30 |
| `userdata/bank.json` | drill items generated from your materials and from exam gaps |
| `userdata/materials/` | text extracted from dumped PDFs / PPTX / DOCX |
| `userdata/files/` | the original uploaded files |
| `userdata/sessions/` | full exam transcripts with feedback |

Opening `index.html` directly without the server also works (progress then lives in the
browser's localStorage; STATUS → EXPORT JSON to back it up).

Needs: macOS `python3` (Xcode Command Line Tools), a browser (Chrome or Safari), internet
for api.openai.com and for the PDF/PPTX parsers loaded from cdnjs.

## Modes

**PRÜFUNG** — the case matrix (all 123 cases of the FMH tracker, grouped by region). Each
run mirrors the real exam: patient papers and image description, then the five official
stations in fixed order (Anamnese/Untersuchung → Bildgebung/Zusatz → DD/Diagnose/Prognose →
Therapie/Indikation/Aufklärung → Nachsorge), each with the same opening question every
time plus 0–3 dynamic drill-down follow-ups, 15-minute timer, answers spoken (● SPRECHEN,
transcribed with gpt-4o-transcribe) or typed, questions to the examiner allowed (NUR
RÜCKFRAGE). Ends with a fixed feedback sheet: grade 1–6 per station, overall grade, what was
missing, model answer skeleton per station, three sentences to memorise, and 3–5 new drill
items generated from your gaps. Every run of the same case gets a different patient variant.

**ABFRAGE** — graded rapid-fire quiz on classifications, terminology, concepts, numbers,
AO principles and technique. Filter by region, type, due/new/weak, keyword. The examiner
grades 0/1/2 in one sentence and shows the model answer. Wrong items come back in the same
session and sooner in later sessions (Leitner boxes: 0, 1, 3, 7, 14, 30 days).
"15 NEUE FRAGEN GENERIEREN" creates new items for the selected region from the
presentation corpus.

**LAZY** — same items, no typing, no API cost: read (or have it read aloud with the
browser's own voice), Space reveals, 1/2/3 rates.

**FREI** — free prompt with the same examiner persona, grounded on a region or a case.

**MATERIAL** — dump pad. Drop PDFs (any size; scanned pages are OCR'd through the vision
model), PPTX, DOCX, TXT. Text is extracted in the browser, stored locally, mapped to the
cases it covers, and turned into drill items. Materials also feed the examiner when you run
a case they are mapped to.

**STATUS** — per-region accuracy, items due, case grades, weakest items and cases, daily
activity, export/import.

## Content

- `data/cases.js` — the 123 cases from the FMH tracker (`fmh-oral-2026/app/study-data.ts`).
- `data/corpus.js` — slide and notes text of the 51 presentations attached to those cases.
- `data/bank/*.js` — 256 hand-written seed items by region. Edit freely: one line per
  item `[type, topic, question, answer]`. Items are identified by their question text, so
  changing a question resets its progress.
- `prompts.js` — the examiner protocol. Everything the model is told is here.

## Settings worth knowing

Model (default `gpt-5.1`; VERFÜGBARE MODELLE LADEN lists what your key can use),
Denkaufwand (reasoning effort, `low` is the sweet spot), Strenge (mild / standard / hart),
Nachfragen pro Station, Prüfer-Stimme (TTS), Sprache, and a free-text instruction that is
appended to the examiner prompt ("frag mehr nach Zugängen").
