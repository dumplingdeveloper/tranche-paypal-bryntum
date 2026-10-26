// Tranche caption helpers (new code for this repo, MIT like the app; see video/LICENSES.md).
// Captions follow the spoken sentence: one sentence per caption, split further only at clause punctuation
// (, ; : —) when a sentence is too long, and only at a word boundary when a single clause is still too long.

export const CAPTION_MAX_CHARS = 84;

function packWords(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const parts = Math.ceil(text.length / maxChars);
  const per = Math.ceil(words.length / parts);
  const out = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(' '));
  return out;
}

// Fewest captions first, then the most balanced ones: among clause groupings that fit, pick the one whose longest
// caption is shortest (so "…never change it," / "and our scheduler, not the model, …" beats a greedy fill).
function splitSentence(sentence, maxChars) {
  if (sentence.length <= maxChars) return [sentence];
  const clauses = sentence.split(/(?<=[,;:—])\s+/).filter(Boolean);
  const best = new Array(clauses.length + 1);
  best[clauses.length] = { parts: [], longest: 0 };
  for (let i = clauses.length - 1; i >= 0; i--) {
    let choice = null;
    for (let j = i + 1; j <= clauses.length; j++) {
      const chunk = clauses.slice(i, j).join(' ');
      if (chunk.length > maxChars && j > i + 1) break;
      const head = chunk.length > maxChars ? packWords(chunk, maxChars) : [chunk];
      const rest = best[j];
      const cand = { parts: [...head, ...rest.parts], longest: Math.max(rest.longest, ...head.map((p) => p.length)) };
      if (!choice || cand.parts.length < choice.parts.length
        || (cand.parts.length === choice.parts.length && cand.longest < choice.longest)) choice = cand;
    }
    best[i] = choice;
  }
  return best[0].parts;
}

export function splitCaptionAtClauses(text, maxChars = CAPTION_MAX_CHARS) {
  const sentences = String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  // A very short sentence ("Changed my mind?") rides with the next one when both fit together.
  const merged = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.length < 24 && i + 1 < sentences.length && `${s} ${sentences[i + 1]}`.length <= maxChars) { merged.push(`${s} ${sentences[i + 1]}`); i++; }
    else merged.push(s);
  }
  const out = merged.flatMap((s) => splitSentence(s, maxChars));
  return out.length ? out : [''];
}

// Narrator lines carry no speaker label; other voices keep theirs ("Owner: …").
export function captionLabel(event) {
  const role = String(event.role || event.voice || '').toLowerCase();
  if (role === 'narrator') return '';
  if (role === 'owner') return 'Owner';
  if (role === 'host') return 'Host';
  return 'Assistant';
}
