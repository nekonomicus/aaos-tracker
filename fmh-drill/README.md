# Oral Drill

Active-recall drill for the FMH orthopaedics oral exam (20/21 Nov 2026). Static site, no build step.

## How a card works

1. Read the question and answer **from memory** — type it, dictate it (Deutsch/English), or say it out loud.
   Checking with an empty box asks you to confirm you actually said it.
2. The answer key appears as a checklist of atomic points. Tick what you really produced
   (points that match words in your typed answer are pre-ticked; untick if generous).
3. The share of points sets the suggested grade — strict mode: ≥ 90 % Good, ≥ 60 % Hard, else Again.
   Accept with ↵ or pick another grade (A / H / G / E).

Viva cards are case chains: each answer unlocks the next, harder examiner question; the grade uses all steps.

## Scheduling

[FSRS-6](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm), the current open-source
state of the art for spaced repetition, with its published default parameters. `fsrs.js` reproduces
`ts-fsrs` 5.x memory updates to within 1e-6. Learning steps 1 m / 10 m, relearning 10 m, target recall 90 %
(adjustable), intervals capped so every card comes back before the exam date. New cards are interleaved
across decks; due cards are served weakest-first.

## Content

`cards/*.js` — hand-written from the uploaded decks in the tracker's attachment store, plus standard
examiner questions on the same topics (marked `src: 'Core'`). Each card: `id`, `deck` (see `decks.js`),
`kind`, `q`, `a` (answer points) or `steps` (viva), optional `note`, `src`. Keep ids stable — progress is keyed on them.

## Progress

Stored in the browser (`localStorage`). Settings → Export / Import moves it between devices.

## Deploy

Render static site, publish directory `fmh-drill`, no build command needed.
