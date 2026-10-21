// Seed drill bank. Each region file calls S(region, rows) with rows of
// [type, topic, question, model answer, caseIds?]. Types: klassifikation, algorithmus,
// terminologie, konzept, zahl, technik, anatomie. Items get a stable id from the question
// text; the optional caseIds tie an item to cases of the oral matrix (section, deck images).
window.SEED_BANK = [];
window.S = function seed(region, rows) {
  for (const [type, topic, q, a, caseIds] of rows) window.SEED_BANK.push(caseIds && caseIds.length ? { region, type, topic, q, a, caseIds } : { region, type, topic, q, a });
};
