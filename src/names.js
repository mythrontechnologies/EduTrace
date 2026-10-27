// Name comparison for identity resolution.
//
// Comparison only: nothing here changes a stored value. Source records keep the name exactly as
// supplied (plus the existing trim/NFKC/lower-case `normalized_name`); the keys below exist only
// while two names are being compared, and every comparison reports which transformation made two
// names comparable, so a reviewer can see why.
//
// Results, from strongest to weakest:
//   exact        identical after the existing normalisation (trim, Unicode NFKC, case)
//   equivalent   identical after comparison folding: diacritics, punctuation, hyphens, word order
//                and the documented abbreviations in ABBREVIATIONS (for example "Mohd" = "Mohammed")
//   similar      not equivalent, but every word agrees or is an initial of the other ("A. Kumar" /
//                "Arun Kumar"), or at least CANDIDATE_SIMILARITY of the words match
//   different    anything else
//   missing      one or both names are empty
// Only "exact" and "equivalent" count as name agreement for automatic linking; "similar" is
// candidate evidence for a reviewer and never links records on its own.

// Abbreviations folded for comparison. Each entry is a common written short form of one given
// name; distinct names are not collapsed. Keep this list short and evidence-based.
const ABBREVIATIONS = new Map([
  ['mohd', 'mohammed'], ['md', 'mohammed'], ['mohamed', 'mohammed'], ['mohammad', 'mohammed'],
  ['muhammad', 'mohammed'], ['muhammed', 'mohammed'], ['mohamad', 'mohammed']
]);
const CANDIDATE_SIMILARITY = 0.8;

// Word-overlap similarity on the stored normalised names (unchanged from the original engine).
function similarity(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const aa = new Set(a.split(' ')); const bb = new Set(b.split(' ')); let common = 0;
  aa.forEach(x => { if (bb.has(x)) common++; }); return common / Math.max(aa.size, bb.size);
}

const stripMarks = value => value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
// Words of a normalised name with diacritics and punctuation removed (no abbreviation folding).
function plainTokens(name) {
  return stripMarks(String(name || '').toLocaleLowerCase('en-IN')).replace(/[.,'’`"()/\\_-]+/g, ' ').split(/\s+/).filter(Boolean);
}
function comparisonTokens(name) { return plainTokens(name).map(t => ABBREVIATIONS.get(t) || t); }
// A blocking key: equivalent names share it.
function nameKey(name) { return comparisonTokens(name).sort().join(' '); }

function sameWords(a, b) { return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' '); }
// Every position agrees, or one side is a single-letter initial of the other; at least one full
// word agrees. Word order is allowed to differ as long as the initials line up after sorting by
// the full words.
function initialsCompatible(a, b) {
  if (a.length !== b.length || a.length < 2) return false;
  const tryOrder = (x, y) => {
    let full = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) { full++; continue; }
      const [s, l] = x[i].length <= y[i].length ? [x[i], y[i]] : [y[i], x[i]];
      if (!(s.length === 1 && l.startsWith(s))) return false;
    }
    return full >= 1;
  };
  return tryOrder(a, b) || tryOrder([...a].reverse(), b);
}

function compareNames(a, b) {
  if (!a || !b) return { result: 'missing', similarity: 0, method: null, note: 'A name is missing on at least one record.' };
  if (a === b) return { result: 'exact', similarity: 1, method: 'normalised_exact', note: 'Identical after trimming, Unicode normalisation and case folding.' };
  const pa = plainTokens(a); const pb = plainTokens(b);
  const ca = comparisonTokens(a); const cb = comparisonTokens(b);
  if (sameWords(ca, cb)) {
    const how = [];
    if (stripMarks(a) !== a || stripMarks(b) !== b) how.push('diacritics');
    if (/[.,'’`"()/\\_-]/.test(a + b)) how.push('punctuation');
    if (!sameWords(pa, pb)) how.push('a documented abbreviation');
    if (sameWords(pa, pb) && pa.join(' ') !== pb.join(' ')) how.push('word order');
    else if (!sameWords(pa, pb) && ca.join(' ') !== cb.join(' ')) how.push('word order');
    return { result: 'equivalent', similarity: 1, method: 'comparison_folding', note: `Equivalent after folding ${how.length ? how.join(', ') : 'formatting'}. The supplied spellings differ and are kept as supplied.` };
  }
  const overlap = similarity(ca.join(' '), cb.join(' '));
  if (initialsCompatible(ca, cb)) {
    const initials = ca.filter((t, i) => t !== cb[i]).length || 1;
    return { result: 'similar', similarity: Number(((ca.length - initials * 0.5) / ca.length).toFixed(2)), method: 'initials', note: 'Every word agrees or is an initial of the other. An initial is not proof of the same name.' };
  }
  if (overlap >= CANDIDATE_SIMILARITY) return { result: 'similar', similarity: Number(overlap.toFixed(2)), method: 'word_overlap', note: `${Math.round(overlap * 100)}% of words match after folding.` };
  return { result: 'different', similarity: Number(overlap.toFixed(2)), method: 'word_overlap', note: `Only ${Math.round(overlap * 100)}% of words match after folding.` };
}

module.exports = { ABBREVIATIONS, CANDIDATE_SIMILARITY, similarity, plainTokens, comparisonTokens, nameKey, compareNames };
