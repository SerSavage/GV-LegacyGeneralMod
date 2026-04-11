/**
 * Reads GVLegacyBotIndexing.txt and writes gv-legacy-index.txt for religion/politics safe-context.
 * Conservative: changelog bullets + Title-Case phrases + long tokens only on strong GV/faction lines.
 *
 * Usage: node scripts/extract-gv-legacy-index.mjs [path/to/GVLegacyBotIndexing.txt]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const outFile = path.join(repoRoot, 'gv-legacy-index.txt');

const inputPath =
  process.argv[2] || 'C:/Users/serje/Desktop/GVLegacyBotIndexing.txt';

const STOP = new Set(
  `a an the and or but if so as at to of in on for by is it we he she his her its you they them their this that these those was were are been be have has had do does did will would could should may might must can not no yes all any some more most much many few other such same than then too very just only also about into through over out up down off when where why how what who which while with without from each both either neither one two first last next new old long high low own way back well even still ever never always often sometimes today tomorrow yesterday week month year time day game games player players update updates change changes fixed fixes community hello thanks please share video contact being made using based like make takes taking taken give given giving got get goes going come comes coming see saw know knew think thought need wanted try tried help helped work worked look looked seem seemed keep kept put puts let lets set sets run running use feel become became show shown add added remove removed increase decreased decrease another something everything nothing anything someone everyone however although should through might still after before those these which there would could about between people another announcement changelog community`.split(
    /\s+/
  )
);

/** Only harvest tokens from lines that clearly discuss GV nations or the game by name. */
const STRONG_ANCHOR =
  /\b(gloria\s+victis|midland|midlanders|sangmar|sangarians|ismir|ismirs|azeb|azebs|azebia|nordheim|karleon|karleonian|sangmar\s+empire|empire\s+of\s+azebia|stoneholm|black\s+eye\s+games)\b/i;

const TOKEN_BLOCK = new Set(
  `states state national nationalism nationalist invasion regime sanction sanctions genocide christian muslim islam jewish judaism church bible israel iran iraq syria pakistan russia china government political politics election president congress senate border immigrant immigrants refugee refugees against`.split(
    /\s+/
  )
);

const text = fs.readFileSync(inputPath, 'utf8');
const out = new Set();

function addPhrase(p) {
  const s = p.replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length < 8 || s.length > 160) return;
  out.add(s);
}

for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*[–\-•]\s*(.+)$/);
  if (m) addPhrase(m[1].replace(/^[–\-]\s*/, '').trim());
}

for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g)) {
  addPhrase(m[1]);
}

for (const line of text.split(/\r?\n/)) {
  if (!STRONG_ANCHOR.test(line)) continue;
  const lower = line.toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9']{9,}/g) || [];
  for (const w of tokens) {
    const t = w.replace(/^'+|'+$/g, '');
    if (t.length < 10 || STOP.has(t) || TOKEN_BLOCK.has(t)) continue;
    out.add(t);
  }
}

const RELIGION_LEAK = /\b(church|mosque|synagogue|bible|quran|genocide|terrorism|terrorist)\b/i;
for (const x of [...out]) {
  if (/^\d/.test(x) || /^\d+$/.test(x)) out.delete(x);
  if (x.includes('http') || x.includes('www.') || x.includes('youtube')) out.delete(x);
  if (x.includes('@') || x.includes('discord')) out.delete(x);
  if (RELIGION_LEAK.test(x)) out.delete(x);
}

const lines = [...out].sort((a, b) => a.localeCompare(b));
const header = `# Gloria Victis legacy patch vocabulary (religion/politics safe-context only; Balkans/geopolitical/slurs still run first).
# Regenerate: node scripts/extract-gv-legacy-index.mjs path/to/GVLegacyBotIndexing.txt
# Source: ${path.basename(inputPath)}
# Terms: ${lines.length}

`;

fs.writeFileSync(outFile, header + lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${lines.length} terms → ${outFile}`);
