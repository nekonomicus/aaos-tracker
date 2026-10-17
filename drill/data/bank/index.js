// Seed drill bank. Each region file calls S(region, rows) with rows of
// [type, topic, question, model answer]. Types: klassifikation, terminologie,
// konzept, zahl, technik, anatomie. Items get a stable id from the question text.
window.SEED_BANK = [];
window.S = function seed(region, rows) {
  for (const [type, topic, q, a] of rows) window.SEED_BANK.push({ region, type, topic, q, a });
};
