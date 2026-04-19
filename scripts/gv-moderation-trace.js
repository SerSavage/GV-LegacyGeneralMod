/**
 * Trace which gv-general rule matches the Mace Windu / hold-delete flow (predicates from index.js).
 * Usage: node scripts/gv-moderation-trace.js "message text" [authorDiscordUserId]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function slice(a, b) {
  const i = idx.indexOf(a);
  const j = idx.indexOf(b, i + 1);
  if (i < 0 || j < 0) throw new Error(`Slice not found:\n  start: ${a.slice(0, 80)}\n  end: ${b.slice(0, 80)}`);
  return idx.slice(i, j);
}

function stripOuterQuotesForGeneral(text) {
  if (text == null || typeof text !== 'string') return text;
  const t = text.trim();
  if (t.length < 2) return text;
  const pairs = [
    ['"', '"'],
    ['\u201c', '\u201d'],
    ['\u201e', '\u201c'],
    ['\u00ab', '\u00bb'],
  ];
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length).trim();
      return inner.length > 0 ? inner : text;
    }
  }
  return text;
}

// stripDiacritics + stripOuterQuotes, then jump to escapeRegex…normalizeForMatch (skip ~600 lines of unrelated code).
const util =
  slice('function stripDiacritics(text)', 'const IMAGE_EXTENSIONS')
  + slice(
    'function escapeRegex(s)',
    '\n/**\n * Unicode Runic block (U+16A0–U+16F8) → Latin transliteration',
  );

// Includes buildOffTopicPhrases, OFF_TOPIC_EXTRA_PHRASES, OFF_TOPIC_PHRASES (stops before video reply block)
const offTopicBuild = slice('function buildOffTopicPhrases()', '// Video reply: default is Streamable link');

const offTopicCheck = slice('// Exception: "mad men"', '// Broad racial/religious stereotype');

const stereotype = slice('function hasStereotypeRaceReligionRedirect(text)', '// Psychiatric / disability slurs');

const medicalBlock = slice('const MEDICAL_PSYCH_INSULT_SUBSTRINGS', 'console.log(`Medical/psychiatric insult substrings:');

const harassment = slice('function editDistance(a, b)', '// Real-world geopolitical keywords');

const danger = slice('function hasGameDangerLoreContext(text)', '// If message contains any safe-context word');

const bundle = [util, offTopicBuild, offTopicCheck, stereotype, medicalBlock, harassment, danger].join('\n');

const rawMsg = process.argv[2] || 'Damn bro, how fast have you gotten an deleting messages';
const authorId = process.argv[3] || '999999999999999999';

let gvModerationText = String(rawMsg);
const stripped = stripOuterQuotesForGeneral(gvModerationText.trim());
gvModerationText = stripped || gvModerationText;

const ctx = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  DELUSION_STRICT_USER_ID: String(process.env.DELUSION_STRICT_USER_ID || '188328879180480512'),
};
vm.createContext(ctx);
vm.runInContext(bundle, ctx);

const {
  hasOffTopicPhrase,
  hasStereotypeRaceReligionRedirect,
  hasMedicalPsychiatricInsult,
  hasHarassmentRaceBaitEvasion,
  hasDangerFramingTargetPlayersOrHumans,
} = ctx;

console.log('gvModerationText:', JSON.stringify(gvModerationText));
console.log('authorId:', authorId);
console.log('DELUSION_STRICT_USER_ID:', ctx.DELUSION_STRICT_USER_ID);
console.log('--- Mace-Windu-style paths (first match wins in bot order) ---');
console.log('hasHarassmentRaceBaitEvasion (your author id):', hasHarassmentRaceBaitEvasion(gvModerationText, authorId));
console.log('hasHarassmentRaceBaitEvasion (strict id):', hasHarassmentRaceBaitEvasion(gvModerationText, ctx.DELUSION_STRICT_USER_ID));
console.log('hasStereotypeRaceReligionRedirect:', hasStereotypeRaceReligionRedirect(gvModerationText));
console.log('hasMedicalPsychiatricInsult:', hasMedicalPsychiatricInsult(gvModerationText));
console.log('hasDangerFramingTargetPlayersOrHumans:', hasDangerFramingTargetPlayersOrHumans(gvModerationText));
console.log('hasOffTopicPhrase:', hasOffTopicPhrase(gvModerationText));
