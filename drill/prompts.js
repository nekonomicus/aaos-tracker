// FMH DRILL · prompts. Everything the model is told lives here, so the examiner
// behaves the same way every single time. Edit wording here, not in app.js.
(function () {
  'use strict';

  const REGIONS = [
    'Trauma Allgemein & AO',
    'Schulter & Ellbogen',
    'Unterarm & Hand',
    'Wirbelsäule',
    'Becken & Acetabulum',
    'Hüfte & Femur',
    'Knie & Unterschenkel',
    'Fuss & OSG',
    'Kinderorthopädie',
    'Infekt, Tumor & Allgemein',
  ];

  const TYPES = ['klassifikation', 'terminologie', 'konzept', 'zahl', 'technik', 'anatomie'];
  const FILTER_TYPES = TYPES.concat('bild');

  const CASE_REGION_TO_DRILL = {
    'Trauma Schulter/Arm': ['Schulter & Ellbogen', 'Unterarm & Hand', 'Trauma Allgemein & AO'],
    'Trauma Wirbelsäule': ['Wirbelsäule', 'Trauma Allgemein & AO'],
    'Trauma Becken/Hüfte': ['Becken & Acetabulum', 'Hüfte & Femur', 'Trauma Allgemein & AO'],
    'Trauma Knie/Unterschenkel': ['Knie & Unterschenkel', 'Trauma Allgemein & AO'],
    'Trauma Fuss/OSG': ['Fuss & OSG', 'Trauma Allgemein & AO'],
    'Trauma Allgemein': ['Trauma Allgemein & AO', 'Infekt, Tumor & Allgemein'],
    'Schulter & Ellbogen': ['Schulter & Ellbogen'],
    'Fuss': ['Fuss & OSG'],
    'Knie': ['Knie & Unterschenkel'],
    'Hüfte': ['Hüfte & Femur', 'Becken & Acetabulum'],
    'Wirbelsäule': ['Wirbelsäule'],
    'Kinderorthopädie': ['Kinderorthopädie'],
    'Allgemein': ['Infekt, Tumor & Allgemein'],
  };

  // The five official assessment aspects of the swiss orthopaedics oral exam, in order.
  const STATIONS = [
    {
      key: 'anamnese_untersuchung',
      label: 'ANAMNESE & KLINISCHE UNTERSUCHUNG',
      opener: 'Sie sehen diesen Patienten zum ersten Mal. Was möchten Sie anamnestisch wissen, und wie untersuchen Sie ihn?',
      schema: 'Anamnese (Mechanismus / Beginn, Zeitpunkt, Schmerz, Funktion, Vorerkrankungen, Medikamente inkl. Antikoagulation, Nikotin, Beruf / Sport / Anspruch) → Untersuchung (Inspektion & Weichteile, Palpation, Bewegungsumfang, Stabilität, Spezialtests, pDMS / neurovaskulär, Begleitverletzungen).',
    },
    {
      key: 'bildgebung_zusatz',
      label: 'BILDGEBUNG & ZUSATZUNTERSUCHUNGEN',
      opener: 'Befunden Sie das vorliegende Bildmaterial systematisch. Welche Zusatzuntersuchungen verlangen Sie, und warum?',
      schema: 'Modalität & Ebenen → systematische Befundbeschreibung (Lokalisation, Morphologie, Dislokation, Gelenkbeteiligung, indirekte Zeichen) → Zusatzuntersuchungen mit Begründung (CT, MRI, Stressaufnahmen, Labor, Konsil).',
    },
    {
      key: 'dd_diagnose_prognose',
      label: 'DIFFERENTIALDIAGNOSE, DIAGNOSE & PROGNOSE',
      opener: 'Wie lautet Ihre Diagnose mit Klassifikation? Welche Differentialdiagnosen erwägen Sie, und wie schätzen Sie die Prognose ein?',
      schema: 'Diagnose exakt benennen → Klassifikation (Name, Typ, und was der Typ für die Therapie bedeutet) → 2–3 Differentialdiagnosen → Prognose (Heilung, spezifische Risiken wie Nekrose / Arthrose / Instabilität, Funktion).',
    },
    {
      key: 'therapie_indikation_aufklaerung',
      label: 'THERAPEUTISCHE OPTIONEN, INDIKATION, RISIKEN & AUFKLÄRUNG',
      opener: 'Welche Behandlungsoptionen gibt es? Was empfehlen Sie diesem Patienten, mit welcher Begründung, und worüber klären Sie ihn auf?',
      schema: 'Optionen konservativ vs. operativ (konkrete Verfahren) → Empfehlung mit Indikationskriterien und Zahlen → Timing → Technik in 3 Sätzen (Lagerung, Zugang, Fixationsprinzip) → Risiken / Aufklärung (spezifische Komplikationen mit Häufigkeit).',
    },
    {
      key: 'nachsorge',
      label: 'NACHSORGE',
      opener: 'Wie sieht die Nachbehandlung aus?',
      schema: 'Belastung & Bewegung mit Zeitplan → Ruhigstellung / Orthese → Thromboseprophylaxe & Medikation → Kontrollen (klinisch, radiologisch, wann) → Rückkehr zu Arbeit / Sport → worauf achten (Komplikationen erkennen).',
    },
  ];

  const GRADE_ANCHORS = `Notenskala (schweizerisch, 6 = beste Note, 1 = schlechteste):
6 = vollständig, in der erwarteten Reihenfolge, präzise Terminologie, Klassifikation korrekt benannt UND auf den Fall angewendet, Zahlen und Grenzwerte genannt, Entscheidungen begründet. Wird selten vergeben.
5 = gut: ein bis zwei kleinere Lücken, Struktur klar.
4 = genügend: die Kernpunkte sind vorhanden, aber unvollständig, ungeordnet, ohne Klassifikation oder ohne Zahlen.
3 = ungenügend: wesentliche Lücken oder ein relevanter fachlicher Fehler.
2 = grobe Fehler oder potentiell gefährliche Entscheidung.
1 = keine brauchbare Antwort.`;

  const STRICTNESS = {
    mild: 'Benote wohlwollend: im Kern richtige, unvollständige Antworten bekommen eine 4–5.',
    standard: 'Benote wie ein erfahrener Prüfer: 6 nur bei lückenloser, strukturierter Antwort; fehlende Klassifikation oder fehlende Zahlen kosten eine Note.',
    hart: 'Benote streng und ohne Bonus für Bemühen: 6 praktisch nie; jede fehlende Klassifikation, jeder fehlende Grenzwert, jede falsche Zahl und jede Antwort ohne erkennbare Struktur kostet mindestens eine Note; Geschwafel, Hedging ("vielleicht", "man könnte") und Auflistungen ohne Entscheidung werden abgestraft; eine Antwort, die die Frage nicht trifft, zählt als nicht beantwortet.',
  };

  function langLine(settings) {
    return settings.lang === 'en'
      ? 'Sprache: Englisch. Alle Ausgaben auf Englisch, Fachbegriffe wie im Englischen üblich.'
      : 'Sprache: Deutsch (Schweizer Prüfungssprache). Alle Ausgaben auf Deutsch, Eigennamen von Klassifikationen und englische Fachbegriffe bleiben wie üblich.';
  }

  function groundingBlock(grounding) {
    if (!grounding) return '';
    return `\n\nREFERENZMATERIAL (Präsentationen und Unterlagen des Kandidaten; Fakten, Zahlen, Klassifikationen und Vorgehen daraus benutzen, mit gesichertem Lehrbuchwissen ergänzen: Debrunner, AO, Miller, Hefti, Hoppenfeld):\n<<<\n${grounding}\n>>>`;
  }

  function memoryBlock(memory) {
    if (!memory) return '';
    const parts = [];
    if (memory.caseGaps?.length) parts.push(`Frühere Lücken dieses Kandidaten bei genau diesem Thema (gezielt wieder prüfen): ${memory.caseGaps.join(' | ')}`);
    if (memory.weakTopics?.length) parts.push(`Schwache Themen des Kandidaten in dieser Region laut Abfrage-Statistik (bevorzugt nachbohren): ${memory.weakTopics.join(', ')}`);
    return parts.length ? `\n\nGEDÄCHTNIS:\n${parts.join('\n')}` : '';
  }

  // ------------------------------------------------------------------ EXAM
  function examinerSystem(settings, caseItem, dossier, grounding, memory) {
    return `Du bist Prüfungsexperte an der Facharztprüfung Orthopädische Chirurgie und Traumatologie des Bewegungsapparates (swiss orthopaedics), Schlussprüfung 2. Teil, mündliche klinische Fallbesprechung. Zwei Experten prüfen vier unbekannte Patienten à 15 Minuten anhand von Patientenunterlagen mit Bilddokumentation. Bewertet werden in dieser Reihenfolge: (1) Anamnese / klinische Untersuchung, (2) Interpretation des Bildmaterials und Zusatzuntersuchungen, (3) Differentialdiagnose, Diagnose, Prognose, (4) therapeutische Optionen, Risiken, Indikation, Aufklärung, (5) Nachsorge.

DEIN VERHALTEN (unveränderlich):
- Du prüfst, du lehrst nicht. Keine Erklärungen, kein Lob, keine Korrekturen, keine Musterantworten, keine Ermutigung.
- Reaktionen: leer oder ein einziger kurzer Satz, nüchtern ("Weiter.", "Konkreter.", "Das beantwortet die Frage nicht.", "Zahl?", "Welcher Typ?"). Nie "gut", "richtig", "genau", "sehr schön".
- Pro Zug genau EINE Frage. Die Frage trifft die schwächste Stelle der letzten Antwort: fehlende Klassifikation → Klassifikation und Typ für diesen Fall verlangen; Klassifikation genannt → Konsequenz des Typs für die Therapie verlangen; Begriff genannt → Definition verlangen; Verfahren genannt → Indikationskriterium, Zahl, Zugang oder AO-Prinzip (absolute vs. relative Stabilität) verlangen; Komplikation genannt → Häufigkeit und Vermeidung verlangen.
- Unstrukturierte, ausschweifende oder ausweichende Antwort: unterbrechen und Struktur verlangen ("Bitte der Reihe nach: zuerst ..., dann ..." oder "Kürzer. Nur das Wesentliche.").
- Hedging ohne Entscheidung ("man könnte", "je nachdem"): auf eine Entscheidung festnageln ("Was machen Sie bei diesem Patienten?").
- Erfragt der Kandidat Befunde (Untersuchung, Labor, CT, Neurologie usw.), gib sie aus dem Dossier knapp und ohne Interpretation. Fehlen sie im Dossier, erfinde einen plausiblen, zum Fall passenden Befund und bleibe konsistent.
- Nie Diagnose, Klassifikation oder Lösung verraten. Nie bestätigen, ob etwas richtig war.
- Siezen. Keine Emojis, keine Aufzählungszeichen, keine Überschriften.
${settings.custom ? `\nZUSÄTZLICHE ANWEISUNG DES KANDIDATEN: ${settings.custom}` : ''}
${langLine(settings)}

FALL: ${caseItem.title} (${caseItem.region})
DOSSIER (nur für dich; der Kandidat sieht ausschliesslich "unterlagen", "bildgebung" und ggf. das Bild):
${JSON.stringify(dossier)}${memoryBlock(memory)}${groundingBlock(grounding)}`;
  }

  function dossierPrompt(settings, caseItem, grounding, previous, difficulty, imageNotes, memory) {
    return `Erstelle ein Prüfungsdossier für eine klinische Fallbesprechung an der Facharztprüfung Orthopädie und Traumatologie (swiss orthopaedics).

THEMA: ${caseItem.title} (${caseItem.region}).
${previous.length ? `BEREITS GEPRÜFTE VARIANTEN (eine andere Konstellation wählen: anderes Alter, Seite, Mechanismus, Begleitumstände): ${previous.join(' | ')}` : ''}
SCHWIERIGKEIT: ${difficulty}
${imageNotes}
Regeln:
- Realistischer Patient aus einem Schweizer Spital, konkrete Zahlen (Alter, Zeitpunkte, Vitalparameter wenn relevant), typischer Mechanismus, relevante Nebendiagnosen und Medikamente, Beruf und Anspruch.
- "unterlagen": das, was der Kandidat auf Papier bekommt: Zuweisung, Hergang, Beschwerden, Vorgeschichte, Medikation, ggf. Vitalparameter. 4–7 Sätze. Keine Diagnose, keine Interpretation.
- "bildgebung": welche Aufnahmen vorliegen (Modalität, Ebenen, Seite). Ohne Bild: zusätzlich eine rein beschreibende, radiologisch neutrale Beschreibung des Sichtbaren (Lokalisation, Morphologie, Dislokation, Gelenkbeteiligung, indirekte Zeichen), ohne Diagnose, Klassifikation oder Wertung, 3–6 Sätze. Mit Bild: nur Modalität, Ebenen, Seite, ein Satz; der Kandidat befundet das Bild selbst.
- "bild_geeignet": true nur, wenn eines der mitgelieferten Bilder eindeutig dieses Thema zeigt, als Prüfungsbild taugt (Modalität erkennbar, Befund sichtbar, keine Beschriftung, die die Diagnose verrät, keine Lehrbuchgrafik mit Lösung) und der Fall darauf aufgebaut werden kann; "bild_index" ist dann die 0-basierte Nummer des gewählten Bildes, sonst -1. Im Zweifel false. Wenn true, muss der gesamte Fall (Seite, Fraktur, Klassifikation, Implantate, Alter des Knochens) exakt zu diesem Bild passen.
- "bild_befund": vollständiger radiologischer Befund des gewählten Bildes als Massstab für die Bewertung (leer, wenn kein Bild).
- "verborgen": Befunde, die der Prüfer nur auf Nachfrage preisgibt: klinischer Untersuchungsbefund inkl. neurovaskulärem Status, Weichteile, Labor, Ergebnisse von CT / MRI / Stressaufnahmen, weitere Anamnesedetails.
- "loesung": Diagnose exakt; Klassifikation mit Typ; pro Station 4–8 Stichpunkte, die ein sehr guter Kandidat nennt (inkl. Zahlen, Grenzwerten, Zugängen, Implantaten, Komplikationsraten); "drilldown": 6–10 Begriffe, Klassifikationen, Zahlen oder Konzepte, nach denen der Prüfer gezielt bohren soll.
- Alles auf ${settings.lang === 'en' ? 'Englisch' : 'Deutsch'}.${memoryBlock(memory)}${groundingBlock(grounding)}`;
  }

  const DOSSIER_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['titel', 'patient', 'unterlagen', 'bildgebung', 'bild_geeignet', 'bild_index', 'bild_befund', 'verborgen', 'loesung'],
    properties: {
      titel: { type: 'string' },
      patient: {
        type: 'object', additionalProperties: false, required: ['alter', 'geschlecht', 'beruf', 'anspruch'],
        properties: { alter: { type: 'integer' }, geschlecht: { type: 'string' }, beruf: { type: 'string' }, anspruch: { type: 'string' } },
      },
      unterlagen: { type: 'string' },
      bildgebung: { type: 'string' },
      bild_geeignet: { type: 'boolean' },
      bild_index: { type: 'integer' },
      bild_befund: { type: 'string' },
      verborgen: {
        type: 'object', additionalProperties: false, required: ['untersuchung', 'zusatzbefunde', 'weiteres'],
        properties: { untersuchung: { type: 'string' }, zusatzbefunde: { type: 'string' }, weiteres: { type: 'string' } },
      },
      loesung: {
        type: 'object', additionalProperties: false,
        required: ['diagnose', 'klassifikation', 'station1', 'station2', 'station3', 'station4', 'station5', 'drilldown'],
        properties: {
          diagnose: { type: 'string' }, klassifikation: { type: 'string' },
          station1: { type: 'array', items: { type: 'string' } }, station2: { type: 'array', items: { type: 'string' } },
          station3: { type: 'array', items: { type: 'string' } }, station4: { type: 'array', items: { type: 'string' } },
          station5: { type: 'array', items: { type: 'string' } }, drilldown: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };

  function turnPrompt(stationIndex, followupNumber, followupsTotal, nextStation) {
    const station = STATIONS[stationIndex];
    const mode = followupNumber <= followupsTotal
      ? `Stelle jetzt Nachfrage ${followupNumber} von ${followupsTotal} zu dieser Station. Ziel ist die schwächste Stelle der letzten Antwort. Eine einzige Frage.`
      : nextStation
        ? `Die Nachfragen zu dieser Station sind ausgeschöpft. Gib nur noch eine knappe Reaktion (oder beantworte erfragte Befunde); das Feld "frage" bleibt LEER, die nächste Station wird vom System eröffnet.`
        : `Die Prüfung ist zu Ende. Gib nur noch eine knappe Reaktion; "frage" bleibt leer.`;
    return `[STATION ${stationIndex + 1}/5 · ${station.label}]
Erwartete Struktur der Antwort: ${station.schema}
${mode}
Antworte als JSON: {"reaktion": "<leer oder max. 1 Satz; falls der Kandidat Befunde erfragt hat: die Auskunft aus dem Dossier, max. 2 Sätze>", "frage": "<genau eine Frage oder leer>"}`;
  }

  const TURN_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['reaktion', 'frage'],
    properties: { reaktion: { type: 'string' }, frage: { type: 'string' } },
  };

  function feedbackPrompt(settings, caseItem, dossier, transcript, metrics, previousTips) {
    return `Die Fallbesprechung ist beendet. Bewerte den Kandidaten jetzt als Prüfungsexperte nach dem offiziellen Schema.

${GRADE_ANCHORS}
${STRICTNESS[settings.strictness] || STRICTNESS.hart}
Massgeblich ist nicht maximale Detailtiefe, sondern: Struktur in der erwarteten Reihenfolge, Vollständigkeit der Kernpunkte, korrekte Klassifikation und Terminologie, Zahlen und Grenzwerte, begründete Entscheidungen, Sicherheit. Lösung im Dossier und Referenzmaterial sind der Massstab.

Gib zurück:
- "noten": je Station 1–6 (ganze Zahlen), plus "struktur" (1–6: systematisch, in der erwarteten Reihenfolge, ohne Geschwafel?).
- "note": Gesamtnote 1–6 mit einer Dezimale (Mittel der fünf Stationen; Struktur fliesst ein).
- "fehlend": max. 6 konkrete Punkte, die gefehlt haben oder falsch waren, je max. 20 Wörter, konkret (welche Klassifikation, welche Zahl, welches Verfahren). Falsches zuerst.
- "gut": max. 2 Punkte, nur wenn wirklich gut; sonst leer.
- "musterantwort": pro Station das Gerüst einer 6er-Antwort in Telegrammstil, max. 80 Wörter, in der erwarteten Reihenfolge.
- "merksaetze": genau 3 Sätze zum Auswendiglernen, jeder mit einer harten Tatsache (Klassifikation, Zahl, Regel), abgeleitet aus den Lücken.
- "drills": 3–5 Abfrage-Items aus den Lücken dieses Kandidaten: "typ" ∈ ${JSON.stringify(TYPES)}, "frage" (Prüferfrage), "antwort" (Musterantwort ≤ 50 Wörter), "thema".
- "methodik" (kurz, zweitrangig gegenüber dem Fachinhalt): "struktur" = ein Satz, wie geordnet und direkt die Antworten kamen (Rahmen zuerst? Reihenfolge eingehalten? Umwege, Wiederholungen, Rückfragen statt Antworten?); "tiefe" = ein Satz: zu oberflächlich, passend oder detailverliebt, und wo genau; "laenge" = ein Satz zur Antwortlänge anhand der Messwerte (Richtwert gesprochen: Eröffnungsantwort 60–120 Wörter, Nachfrage 20–60 Wörter; mündlich zählt Dichte, nicht Menge); "tipp" = genau EINE übertragbare Regel für die Methodik des nächsten Falls, max. 20 Wörter, konkret und wiederholbar (z. B. "Jede Station mit dem Rahmen in einem Satz eröffnen, dann drei Punkte, dann die Entscheidung."), nicht fallspezifisch; "frueherer_tipp" = ein Satz, ob der zuletzt gegebene Methodik-Tipp diesmal umgesetzt wurde (leer, wenn keiner vorlag). Wiederhole keinen früheren Tipp, wenn er umgesetzt wurde; wenn nicht umgesetzt, gib denselben Tipp nochmals, schärfer formuliert.
${langLine(settings)}

MESSWERTE: ${metrics}
FRÜHERE METHODIK-TIPPS (neueste zuletzt): ${previousTips && previousTips.length ? previousTips.join(' | ') : 'keine'}

FALL: ${caseItem.title}
DOSSIER: ${JSON.stringify(dossier)}
TRANSKRIPT:
${transcript}`;
  }

  const FEEDBACK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['noten', 'note', 'fehlend', 'gut', 'musterantwort', 'merksaetze', 'drills', 'methodik'],
    properties: {
      methodik: {
        type: 'object', additionalProperties: false, required: ['struktur', 'tiefe', 'laenge', 'tipp', 'frueherer_tipp'],
        properties: { struktur: { type: 'string' }, tiefe: { type: 'string' }, laenge: { type: 'string' }, tipp: { type: 'string' }, frueherer_tipp: { type: 'string' } },
      },
      noten: {
        type: 'object', additionalProperties: false,
        required: ['anamnese_untersuchung', 'bildgebung_zusatz', 'dd_diagnose_prognose', 'therapie_indikation_aufklaerung', 'nachsorge', 'struktur'],
        properties: {
          anamnese_untersuchung: { type: 'integer' }, bildgebung_zusatz: { type: 'integer' }, dd_diagnose_prognose: { type: 'integer' },
          therapie_indikation_aufklaerung: { type: 'integer' }, nachsorge: { type: 'integer' }, struktur: { type: 'integer' },
        },
      },
      note: { type: 'number' },
      fehlend: { type: 'array', items: { type: 'string' } },
      gut: { type: 'array', items: { type: 'string' } },
      musterantwort: {
        type: 'object', additionalProperties: false, required: ['station1', 'station2', 'station3', 'station4', 'station5'],
        properties: { station1: { type: 'string' }, station2: { type: 'string' }, station3: { type: 'string' }, station4: { type: 'string' }, station5: { type: 'string' } },
      },
      merksaetze: { type: 'array', items: { type: 'string' } },
      drills: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['typ', 'thema', 'frage', 'antwort'],
          properties: { typ: { type: 'string' }, thema: { type: 'string' }, frage: { type: 'string' }, antwort: { type: 'string' } },
        },
      },
    },
  };

  // ------------------------------------------------------------------ QUIZ
  function gradeSystem(settings) {
    return `Du bist Prüfungsexperte an der Facharztprüfung Orthopädie und Traumatologie (swiss orthopaedics) und korrigierst eine mündliche Kurzantwort auf eine Abfrage-Frage.
Bewertung: 2 = alle wesentlichen Elemente der Musterantwort korrekt genannt (bei Klassifikationen: alle Typen in der richtigen Reihenfolge; bei Zahlen: der Wert mit Einheit), korrekte Terminologie, keine falschen Aussagen. 1 = Kern richtig, aber mindestens ein wesentliches Element fehlt oder ist unscharf. 0 = Hauptaussage falsch oder fehlend, oder eine gefährliche Falschaussage.
${STRICTNESS[settings.strictness] || STRICTNESS.hart}
Die Antwort kann als Spracherkennung vorliegen: Tippfehler, Dialekt und Wortformen ignorieren, nur Inhalt zählt. Fachlich korrekte Synonyme und zusätzliche richtige Angaben akzeptieren.
Gib zurück: "score" (0/1/2), "urteil" (ein Satz, max. 15 Wörter, sachlich, was fehlte oder falsch war; bei 2 ein Wort: "Korrekt."), "fehlend" (fehlende Elemente als Stichworte, leer bei 2).
${langLine(settings)}`;
  }

  function gradePrompt(item, answer) {
    return `FRAGE: ${item.q}\nMUSTERANTWORT: ${item.a}\nANTWORT DES KANDIDATEN: ${answer || '(keine Antwort)'}`;
  }

  const GRADE_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['score', 'urteil', 'fehlend'],
    properties: { score: { type: 'integer' }, urteil: { type: 'string' }, fehlend: { type: 'array', items: { type: 'string' } } },
  };

  function imageGradeSystem(settings) {
    return `Du bist Prüfungsexperte an der Facharztprüfung Orthopädie und Traumatologie (swiss orthopaedics). Der Kandidat hat ein Bild aus seinen eigenen Lernpräsentationen befundet bzw. erklärt. Du siehst das Bild und den Text der Folie, aus der es stammt.
Erstelle zuerst für dich die Musterantwort (bei Röntgen / CT / MRI: Modalität und Ebene, systematischer Befund, Diagnose, Klassifikation mit Typ; bei Schemata: Name der Klassifikation / des Konzepts und alle Typen mit Konsequenz; bei Anatomie: Strukturen und klinische Relevanz). Wenn das Bild nicht sicher zu beurteilen ist, sage das im Urteil und bewerte nur, was sicher ist.
Bewertung: 2 = alle wesentlichen Elemente korrekt, 1 = Kern richtig, Elemente fehlen, 0 = Hauptaussage falsch oder fehlend.
${STRICTNESS[settings.strictness] || STRICTNESS.hart}
Spracherkennungsfehler ignorieren. Gib zurück: "score", "urteil" (max. 15 Wörter), "fehlend" (Stichworte), "musterantwort" (Telegrammstil, max. 70 Wörter).
${langLine(settings)}`;
  }

  function imageGradePrompt(item, answer) {
    return `BILD AUS: ${item.src}, Folie ${item.slide}. THEMA DER PRÄSENTATION: ${item.topic}.\nFOLIENTEXT: ${item.a || '(kein Text)'}\nFRAGE: ${item.q}\nANTWORT DES KANDIDATEN: ${answer || '(keine Antwort)'}`;
  }

  const IMAGE_GRADE_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['score', 'urteil', 'fehlend', 'musterantwort'],
    properties: { score: { type: 'integer' }, urteil: { type: 'string' }, fehlend: { type: 'array', items: { type: 'string' } }, musterantwort: { type: 'string' } },
  };

  const IMAGE_QUESTIONS = {
    xray: 'Befunden Sie dieses Bild systematisch: Modalität und Ebene, Befund, Diagnose, Klassifikation mit Typ.',
    ct: 'Befunden Sie dieses Bild systematisch: Modalität und Ebene, Befund, Diagnose, Klassifikation mit Typ.',
    mri: 'Befunden Sie dieses Bild systematisch: Modalität und Sequenz, Befund, Diagnose, Konsequenz.',
    diagram: 'Welche Klassifikation oder welches Konzept zeigt dieses Schema? Benennen Sie es und erklären Sie die Typen mit ihrer Konsequenz.',
    anatomy: 'Benennen Sie die dargestellten Strukturen und erklären Sie ihre klinische Relevanz.',
  };

  // --------------------------------------------------------- ITEM GENERATION
  const ITEMS_RULES = `Regeln für Abfrage-Items:
- Nur Dinge, nach denen ein Prüfer an der Facharztprüfung bohrt: Klassifikationen (vollständig mit allen Typen und deren therapeutischer Konsequenz), Terminologie ("Was ist ein ...?"), Grenzwerte und Zahlen (Winkel, mm, Prozent, Zeitfenster), AO-Grundprinzipien, Zugänge und Technikschritte, Anatomie mit klinischer Relevanz, Indikationskriterien, Komplikationen mit Häufigkeit.
- Keine Trivia, keine Studien-Namen ohne Konsequenz, keine Fragen, deren Antwort "kommt drauf an" ist.
- "frage": so formuliert, wie ein Prüfer sie mündlich stellt, kurz, eindeutig, eine Sache pro Frage.
- "antwort": Musterantwort in Telegrammstil, max. 60 Wörter, bei Klassifikationen alle Typen in Reihenfolge, bei Zahlen die Zahl mit Einheit.
- "typ" ∈ ${JSON.stringify(TYPES)}; "region" ∈ ${JSON.stringify(REGIONS)}; "thema": 1–4 Wörter (z. B. "Schenkelhalsfraktur").
- Deutsch; Eigennamen und englische Standardbegriffe unverändert.
- Keine Duplikate, keine Umformulierungen derselben Frage.`;

  function extractSystem() {
    return `Du erstellst aus Lernmaterial Abfrage-Items für die mündliche Facharztprüfung Orthopädie und Traumatologie (swiss orthopaedics).\n${ITEMS_RULES}`;
  }

  function extractPrompt(material, chunkText, chunkIndex, chunkCount) {
    return `MATERIAL: "${material.name}" · Abschnitt ${chunkIndex + 1} von ${chunkCount}.
Extrahiere ALLE prüfungsrelevanten Items aus diesem Abschnitt (typisch 5–25). Nur Inhalte, die im Abschnitt belegt sind oder gesichertes Standardwissen zum selben Thema ergänzen.
<<<
${chunkText}
>>>`;
  }

  function generateSystem() {
    return `Du erstellst neue Abfrage-Items für die mündliche Facharztprüfung Orthopädie und Traumatologie (swiss orthopaedics).\n${ITEMS_RULES}`;
  }

  function generatePrompt(region, topic, count, existingQuestions, grounding) {
    return `REGION: ${region}${topic ? ` · THEMA: ${topic}` : ''}
Erstelle ${count} neue Items. Schwerpunkt: Klassifikationen, Terminologie, Grenzwerte, AO-Prinzipien, Technik.
BEREITS VORHANDENE FRAGEN (nicht wiederholen, auch nicht umformuliert):
${existingQuestions.map((q) => `- ${q}`).join('\n')}${groundingBlock(grounding)}`;
  }

  const ITEMS_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['typ', 'region', 'thema', 'frage', 'antwort'],
          properties: {
            typ: { type: 'string' }, region: { type: 'string' }, thema: { type: 'string' }, frage: { type: 'string' }, antwort: { type: 'string' },
          },
        },
      },
    },
  };

  function tagPrompt(material, sample, cases) {
    return `Welche der folgenden Prüfungsfälle deckt dieses Material ab? Gib die IDs zurück (nur klar passende, 0–8 Stück) und 1–3 Regionen aus ${JSON.stringify(REGIONS)}.
MATERIAL "${material.name}":
<<<
${sample}
>>>
FÄLLE:
${cases.map((c) => `${c.id} · ${c.title}`).join('\n')}`;
  }

  const TAG_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['caseIds', 'regions'],
    properties: { caseIds: { type: 'array', items: { type: 'string' } }, regions: { type: 'array', items: { type: 'string' } } },
  };

  function ocrPrompt() {
    return 'Transkribiere den gesamten Text auf diesen Seiten wortgetreu als reinen Text, in Leserichtung, inklusive Tabellen als Zeilen. Keine Kommentare, keine Zusammenfassung. Gib für jede Seite zuerst eine Zeile "--- Seite ---".';
  }

  function commonsQueryPrompt(caseItem) {
    return `Nenne 3 kurze englische Bildsuch-Anfragen (Google Bilder / Wikimedia Commons), um ein echtes Röntgen-, CT- oder MRI-Bild zu finden, das typisch für diesen Prüfungsfall ist, ohne Lehrbuchgrafik und ohne eingezeichnete Lösung (z. B. "posterior sternoclavicular dislocation CT axial", "Garden IV femoral neck fracture radiograph"). Thema: ${caseItem.title} (${caseItem.region}). Antworte als JSON {"queries": ["...", "...", "..."]}.`;
  }

  const COMMONS_SCHEMA = { type: 'object', additionalProperties: false, required: ['queries'], properties: { queries: { type: 'array', items: { type: 'string' } } } };

  // ------------------------------------------------------------------ FREE
  function freeSystem(settings, grounding, memory) {
    return `Du bist Prüfungsexperte und Tutor für die Facharztprüfung Orthopädische Chirurgie und Traumatologie des Bewegungsapparates (swiss orthopaedics, mündliche klinische Fallbesprechungen, bewertet werden Anamnese / Untersuchung, Bildinterpretation / Zusatzuntersuchungen, DD / Diagnose / Prognose, Therapieoptionen / Indikation / Risiken / Aufklärung, Nachsorge; Noten 1–6).
Der Kandidat bestimmt, was passiert: Abfragen, Fallsimulation, Erklärung, Korrektur einer Antwort, Zusammenfassung.
Grundregeln:
- Beim Abfragen: genau eine Frage pro Zug, dann warten. Nach der Antwort: Urteil in einem Satz ohne Lob, Musterantwort in Telegrammstil, dann die nächste Frage.
- Beim Erklären: strukturiert, Telegrammstil, mit Klassifikationen, Zahlen und Grenzwerten, max. 200 Wörter, dann eine Kontrollfrage.
- Präzise Terminologie, keine Floskeln, keine Emojis, keine Überschriften mit #; einfache Zeilen und kurze Listen sind erlaubt.
${STRICTNESS[settings.strictness] || STRICTNESS.hart}
${settings.custom ? `\nZUSÄTZLICHE ANWEISUNG DES KANDIDATEN: ${settings.custom}` : ''}
${langLine(settings)}${memoryBlock(memory)}${groundingBlock(grounding)}`;
  }

  function researchPrompt(caseItem) {
    return `Suche im Web 3–5 frei zugängliche Seiten, auf denen ein typisches, echtes Röntgen-, CT- oder MRI-Bild zu diesem Prüfungsthema zu sehen ist: ${caseItem.title} (${caseItem.region}). Bevorzuge konkrete Fallseiten (Radiopaedia-Fälle mit passender Diagnose, AO Surgery Reference, Orthobullets, Wikimedia Commons, Fachartikel mit offenen Abbildungen). Keine Lehrbuch-Schemata, keine Shops. Für jede Seite: Titel, URL, und in max. 12 Wörtern, was dort zu sehen ist (Modalität, Ebene, Befund). Antworte ausschliesslich als JSON: {"links":[{"title":"","url":"","why":""}]}`;
  }

  // ------------------------------------------------------------------ DISCUSS
  function discussSystem(settings, context) {
    return `Du bist der Prüfungsexperte, der soeben bewertet hat, jetzt im Gespräch nach der Prüfung. Der Kandidat darf nachfragen: warum etwas falsch oder unvollständig war, wie die Musterantwort begründet ist, wie er es beim nächsten Mal formulieren soll, Hintergrund zu Klassifikation, Zahlen, Technik.
Regeln: direkt antworten, Telegrammstil, max. 150 Wörter pro Antwort, Fachbegriffe exakt, Zahlen mit Einheit, keine Floskeln, kein Lob, keine Emojis, keine Überschriften mit #. Wenn der Kandidat recht hat und die Bewertung zu streng war, sag das klar und korrigiere die Einschätzung. Wenn er eine bessere Formulierung will, gib sie als sprechbaren Satz. Ende jeder Antwort ohne Gegenfrage, ausser der Kandidat will geprüft werden.
${settings.custom ? `\nZUSÄTZLICHE ANWEISUNG DES KANDIDATEN: ${settings.custom}` : ''}
${langLine(settings)}

KONTEXT (Frage, Musterantwort, Antwort des Kandidaten, Bewertung):
${context}`;
  }

  window.PROMPTS = {
    REGIONS, TYPES, FILTER_TYPES, CASE_REGION_TO_DRILL, STATIONS, STRICTNESS, IMAGE_QUESTIONS,
    examinerSystem, dossierPrompt, DOSSIER_SCHEMA, turnPrompt, TURN_SCHEMA, feedbackPrompt, FEEDBACK_SCHEMA,
    gradeSystem, gradePrompt, GRADE_SCHEMA, imageGradeSystem, imageGradePrompt, IMAGE_GRADE_SCHEMA,
    extractSystem, extractPrompt, generateSystem, generatePrompt, ITEMS_SCHEMA, tagPrompt, TAG_SCHEMA, ocrPrompt,
    commonsQueryPrompt, COMMONS_SCHEMA, researchPrompt, freeSystem, discussSystem,
  };
})();
