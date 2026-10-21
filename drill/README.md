# FMH DRILL

Daily oral-exam drill for the swiss orthopaedics Facharztprüfung, Schlussprüfung 2. Teil
(klinische Fallbesprechungen, 21 Nov 2026). Runs on your Mac, saves everything on your Mac,
talks to OpenAI directly with your own key. The examiner speaks and listens live (OpenAI
Realtime over WebRTC), so a case runs like a conversation at the exam table; text stays as
fallback everywhere.

## Start

```
cd drill
python3 server.py        # or double-click start.command
```

Desktop icon: double-click `make-desktop-icon.command` once. It puts **FMH DRILL.app** on your
Desktop; that icon starts this folder's server in the background and opens the browser. If this
folder's server already runs it only opens the browser; if a server from another copy of the
drill or an old build still holds the port, it is stopped and replaced, so the icon always opens
the build in this folder (the footer shows the build stamp). Re-run it if you move the folder.

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
time plus 0–3 dynamic drill-down follow-ups, 15-minute timer. **Live by default**: as soon
as the dossier is ready the examiner greets you and asks the first question with his own voice,
listens, answers in well under a second, can be interrupted, gives findings when you ask for
them (a question to the examiner is recognised and does not use up a follow-up), opens the
next station himself and closes the case; everything said on both sides lands in the
transcript. ● LIVE in the answer box switches the call off and on (switching off hands the
spoken turns to the text examiner, switching on briefs the voice with what was said so far),
STUMM mutes the microphone, typed answers are forwarded to the live examiner, ● SPRECHEN
(record → gpt-4o-transcribe) and typing remain the text mode. ▶ next to the patient papers
and to every examiner line reads it aloud on demand; VORLESEN AN/AUS (one toggle in every
text mode: PRÜFUNG, ABFRAGE, FREI, NACHFRAGEN) makes him read his questions and answers
automatically, or not. Ends with a fixed feedback sheet from the
strong chat model: grade 1–6 per station, overall grade, what was missing, model answer
skeleton per station (≤ 70 words, the skeleton only), three sentences to memorise, and 3–5 new
drill items generated from your gaps. Every run of the same case gets a different patient
variant. Cases are kept realistic and short: 3–5 sentences of papers like a real referral, a
2–4 sentence image description, a solution of 3–5 core points per station.

**ABFRAGE** — graded rapid-fire quiz on classifications, terminology, concepts, numbers,
AO principles and technique. Filter by region, type, due/new/weak, keyword. The examiner
grades 0/1/2 in one sentence and shows the model answer. Wrong items come back in the same
session and sooner in later sessions (Leitner boxes: 0, 1, 3, 7, 14, 30 days).
"15 NEUE FRAGEN" creates new items for the selected region from the presentation corpus.
**KLASSIFIKATIONEN & ALGORITHMEN** sets the filter to exactly those two types (also in LAZY);
**AUS ALLEN PRÄSENTATIONEN ERNTEN** goes through every presentation once (FMH decks and your
own PPTX / PDF) and extracts every classification (all types with their consequence) and every
treatment or decision algorithm (numbered steps with the thresholds) as items of type
`klassifikation` / `algorithmus`; a rerun only processes new decks. The grader demands all
types in order, or all steps in order with their thresholds, for a 2.
Below the buttons sits the **progress heatmap**: one tile per classification / algorithm item,
grouped into the sections of the FMH oral case matrix (Trauma Schulter/Arm … Allgemein) and
coloured like a stock heatmap: grey NEU (never asked), red GESEHEN (last answer wrong), olive
TEILWEISE (1–2 right in a row), green KOMPETENT (3 right in a row, Leitner box 3+). Clicking a
tile quizzes that one item. The box under the board adds what is missing: type a name
("Sanders"), several ("Sanders, Hawkins, Vancouver"), an algorithm ("Algorithmus Lisfranc") or
just a topic ("Calcaneus"), press HINZUFÜGEN, and the examiner writes one item per classification
or algorithm (all types in order with their consequence, grounded in your decks and the original
description), files it under its case and section, and the tile appears grey.
Every item (ABFRAGE and LAZY) carries its images: before you answer, radiographs from your decks
that belong to it and your own saved images; matching schema slides stay hidden until the
verdict or reveal, or until you press FOLIEN ZEIGEN. The BILDER box is there before and after
answering: BILD SUCHEN asks the examiner, on demand only, for pages with the figure, ranked by
authority: the describing author's original publication first (Letournel & Judet, Garden,
Schatzker, Neer …), then the classification's own authority (AO Foundation / AO Surgery Reference
for AO, the society or guideline for an algorithm), reference sites last; each link is labelled
with author, year and source (cached per item); the pad takes a dropped file, a pasted screenshot (⌘V), an image URL, or a PDF (the page
in the PDF-SEITE field is rendered to an image) and stores it for this item in `userdata/files/`.
The research pad in PRÜFUNG takes PDFs the same way. After the verdict a one-line Merkhilfe is saved with the item.
Matching is strict (an eponym or the item's own deck carries it), so a wrong slide is rarer than
no slide.

**LAZY** — same items, no typing, no API cost: read (or have it read aloud with the
browser's own voice), Space reveals, 1/2/3 rates. After the reveal a NACHFRAGEN box opens under
the rating buttons: ask the examiner why, how to say it, or to quiz you on it, by text or ● LIVE;
the card and its conversation survive a reload until you rate it.

**FREI** — free prompt with the same examiner persona. Pick a case, a region, SCHWÄCHEN
DRILLEN, or nothing, and press START (its label says what it will do; with nothing picked the
examiner chooses a topic himself): a new thread begins, the examiner is briefed on exactly that
focus (a running live call is re-briefed, otherwise the call is started) and opens with the first
question. SCHWÄCHEN DRILLEN hands him your weaknesses profile and he works through it, weakest
first. Every thread (FREI and every NACHFRAGEN box) is saved in `userdata/sessions/` and listed
under GESPRÄCHE, where one click continues it. When a thread with substance ends, one small
model call distils it into the profile: what you did not know, what you had down cold, by region.
The examiner knows your presentations by name (the FMH decks and every PPTX / PDF you dumped into
MATERIAL). Ask "führ mich durch die Präsentation zur distalen Bizepssehnenruptur" and the whole
deck is attached in slide order; he walks you through it slide by slide, one per turn, with the
slide's image shown under his message (text: `[Folie N]`; live: he calls `folie_zeigen`), what
the examiner would ask about it, and a short control question before moving on. The deck's
thumbnails sit above the chat for the rest of the thread. ● LIVE turns it into a spoken conversation: the examiner answers by voice, and
whenever he is not sure of a number he looks it up in your sources through the `nachschlagen`
tool before answering. Typed and spoken turns share one thread. The same ● LIVE button sits in every NACHFRAGEN box
(after each quiz verdict and after each feedback sheet), so you can always talk to the examiner
about what he just graded.

**MATERIAL** — dump pad. Drop PDFs (any size; scanned pages are OCR'd through the vision
model), PPTX, DOCX, TXT, and the JSON export of your AAOS tracker (its notes and error log
become one source). Text is extracted in the browser, stored locally, and turned into drill
items. Everything here is also indexed as a source, see **Sources** below.
"FMH-PRÄSENTATIONEN SYNCHRONISIEREN" pulls new attachments from the FMH case matrix
(release assets of the files repo; GitHub token under ⚙); it also runs quietly at start,
at most every 6 hours. New PPTX/PDF/DOCX attachments become sources mapped to their case,
new image attachments become case images.

**STATUS** — per-region accuracy, items due, case grades, daily activity, export/import, and
the profile: SCHWÄCHEN and STÄRKEN from quiz topics (accuracy), case grades, what was missing in
feedback sheets, and what the conversations revealed, with a SCHWÄCHEN DRILLEN button into FREI.

## Exam format

The protocol follows the candidate's own notes on the Schlussprüfung 2. Teil: four unknown
patients, 15 minutes each, two experts, patient papers with imaging, the five assessment
aspects in the order above. Of these, "Besprechung klinischer Fälle mit zwei Examinatoren"
and "vier Fallbesprechungen" are confirmed by public SIWF / swiss orthopaedics pages; the
2004 edition of the Weiterbildungsprogramm gave 20–40 minutes per case, and the current
edition's table could not be opened from this environment. The 1–6 grades per station are
a training proxy, not the official scoring. Check the current Merkblatt once and adjust
`STATIONS` and the timer in `prompts.js` / `app.js` if anything differs.

## Massstab

Everything the model is told pulls toward the same target (`PRINCIPLES` in `prompts.js`):
first principles before detail. A very good answer is short, ordered and safe: danger
recognised or excluded first, structure in the expected order, the standard procedure of a
Swiss hospital with a clear decision for this patient, the one decision-relevant classification
with its consequence, the one to three thresholds that carry the decision, Aufklärung and
Nachsorge concretely. Rarities, study names, percentage lists and alternative classifications
give no bonus and replace none of that. The grade anchors, the strictness levels, the examiner's
drill-down (numbers only where they carry the decision), the dossier solution, the feedback and
the quiz grader all use this bar. `SWISS` adds the Swiss specifics an examiner expects where they
fit the case (Swissnoso prophylaxis, thromboprophylaxis practice, Aufklärung, UVG / SUVA vs. KVG,
Physiotherapie-Verordnung, Fahreignung, Hausarzt follow-up, osteoporosis work-up, tetanus,
nicotine, no routine metal removal in adults, planned removal in children).

## Sources

The examiner does not rely on general knowledge first. Every source is split into short
passages and indexed in the browser (BM25 over stemmed German/English tokens): the FMH
presentations, everything in MATERIAL (your PDFs, PPTX, DOCX, AAOS notes, synced
presentations). Each model call retrieves the passages that match its question of the
moment, so the model goes back into your material at every step rather than once per case:

- case creation: the case's own presentation in full, plus the best-matching passages for a
  set of search terms the model generates once per case (German + English, eponyms,
  classifications; cached in state.json);
- every examiner turn: the passages matching the station, your answer and the last question
  are attached to that turn only, as a "Nachschlag";
- feedback: grounded on the retrieved passages, lists the sources it used ("QUELLEN");
- quiz grading, NACHFRAGEN and FREI: the passages matching the question or message.

Hierarchy told to the model: 1. your sources; 2. textbook/guideline knowledge where they are
silent; 3. if your sources contradict current evidence, evidence wins and the contradiction
is named. The web is used only for images and for the last instance, the **fact check**:
after each case the 3–6 hard claims of the feedback (grade thresholds, classification types,
indication criteria) are checked with web search against peer-reviewed sources (Cochrane,
NEJM, Lancet, JAMA, BMJ, JBJS, BJJ, CORR, JOT, AO Surgery Reference, guidelines) and shown
as ✓ confirmed / ✗ corrected / ? unclear with the citation. In ABFRAGE, FAKTENCHECK does the
same for one item on demand; a corrected model answer of a generated item can be replaced in
one click. Toggle under ⚙.

## Content

- `data/cases.js` — the 123 cases from the FMH tracker (`fmh-oral-2026/app/study-data.ts`).
- `data/corpus.js` — slide and notes text of the 51 presentations attached to those cases
  (as of Oct 2026; newer attachments arrive through the sync in MATERIAL).
- `data/images.js` + `data/img/` — 153 images from those presentations (radiographs, CT, MRI,
  classification schemas, anatomy), labelled by kind and mapped to cases. In PRÜFUNG the
  examiner gets the radiographs of the case and builds the dossier on one of them only if it
  judges the image a clear, unlabelled match; otherwise the case runs on a text description.
  With no own image, the case opens with a research step: the examiner searches the web
  (OpenAI web_search) and lists pages that show the typical imaging; you find the picture,
  drop it, paste a screenshot (⌘V) or paste its URL. The image is stored in userdata/files,
  attached to that case for good, used to build the case, and becomes a quiz image item.
  "Weiter ohne eigenes Bild" falls back to an automatic search (Google Images with your own
  free Custom Search key, Wikimedia Commons always) with the examiner's suitability check.
  Remote images are downloaded through server.py (`/api/fetch`), since browsers cannot fetch
  cross-origin images themselves. In ABFRAGE/LAZY every image is also a drill item ("Befunden Sie das Bild"), graded
  by the vision model. Images from PPTX files you dump are extracted the same way.
- `data/bank/*.js` — 299 seed items by region. Edit freely: one line per item
  `[type, topic, question, answer]`. Items are identified by their question text, so
  changing a question resets its progress. Audited Oct 2026 against the bar above: every
  row was checked by a Swiss-examiner pass and two independent verifiers (facts / safety,
  exam completeness); 158 answers were shortened to the decision-relevant core (average
  100 → 83 words), about 20 factual errors were corrected (among them: lag-screw hole
  definitions, hip-spine impingement directions, OF-score threshold, Judet views, atlas
  classification eponym, ASIA syndrome prognoses, Mason II indication, Soong grades,
  metacarpal malrotation rule, posterior-malleolus eponym, KD-III subtypes, AO 31-A2
  subgroups, ARCO 2019 thresholds, paediatric antibiotic durations, DAIR / Willenegger-Roth
  timing, colchicine flare dosing), and 43 missing fundamentals were added (standard
  approaches with their danger structures, Aufklärung contents, standard Nachbehandlung,
  emergency first steps, UVG basics).
- `prompts.js` — the examiner protocol. Everything the model is told is here, including the
  voice addenda (`voiceExaminer`, `voiceOpen`, `voiceTurn`, `voiceTutor`) and the lookup tool.
- `voice.js` — the one WebRTC connection to the Realtime API (microphone in, examiner voice
  out, events over the data channel). `app.js` decides what the examiner is told per turn.

## Settings worth knowing

Model `auto` picks the strongest model your key can use (gpt-6 › gpt-5.x › gpt-4.1) when you
press SPEICHERN; type a model id to override. **Live-Prüfer**: on by default; the realtime
model is picked the same way (newest full `gpt-realtime`, e.g. 2.1 › 2 › 1.5 › 1, never mini),
voice (`cedar` default, `marin` the other new one), and Pausentoleranz (how long the examiner
lets you pause before he answers; semantic voice activity detection, "lang" lets you think
mid-answer, "kurz" answers fastest). Use headphones to avoid echo. The live model only runs
the conversation; the case, the grading and the feedback stay on the strong chat model. Denkaufwand (schnell / ausgewogen / gründlich:
case creation and feedback think harder than follow-ups and grading), Strenge (default hart),
Nachfragen pro Station, Prüfer-Stimme (TTS), Sprache, and a free-text instruction that is
appended to the examiner prompt ("frag mehr nach Zugängen").
