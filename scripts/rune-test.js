const fs = require('fs');
const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const bundle =
  idx.slice(idx.indexOf('const SPAM_SLUR_TERMS'), idx.indexOf('// Religion-related "goy"')) +
  idx.slice(idx.indexOf('function normalizeForMatch'), idx.indexOf('function transliterateRunesToLatin')) +
  idx.slice(idx.indexOf('function transliterateRunesToLatin'), idx.indexOf('function normalizeRunesForContextScan')) +
  idx.slice(idx.indexOf('function normalizeRunesForContextScan'), idx.indexOf('function countElderFutharkRunes')) +
  idx.slice(idx.indexOf('function countElderFutharkRunes'), idx.indexOf('function hasTriggerWord')) +
  idx.slice(idx.indexOf('function hasSpamSlur'), idx.indexOf('const RUNIC_EPIGRAPHY_PHRASE_RES'));

const msg =
  'I am ᛁ ᛋ ᛗ ᛁ ᚱ and usually sleep longer. But I am 60+ and have earned that...';

const vm = require('vm');
const ctx = { console };
vm.runInNewContext(
  `${bundle}
  const msg = ${JSON.stringify(msg)};
  console.log('runeCount', countElderFutharkRunes(msg));
  console.log('norm', normalizeRunesForContextScan(msg));
  console.log('hasSpamSlur raw', hasSpamSlur(msg));
  const norm = normalizeRunesForContextScan(msg);
  console.log('hasSpamSlur norm', hasSpamSlur(norm));
  const lower = msg.toLowerCase();
  for (const term of SPAM_SLUR_TERMS) {
    if (lower.includes(term)) console.log('SUBSTR HIT', term);
  }
  const compact = normalizeForMatch(lower.replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
  console.log('compact raw', compact);
  for (const term of SPAM_SLUR_TERMS) {
    if (term.length < 4) continue;
    const tc = normalizeForMatch(term.replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
    if (tc.length >= 4 && compact.includes(tc)) console.log('COMPACT RAW HIT', term, 'tc', tc);
  }
  const compactN = normalizeForMatch(norm.toLowerCase().replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
  console.log('compact norm', compactN);
  for (const term of SPAM_SLUR_TERMS) {
    if (term.length < 4) continue;
    const tc = normalizeForMatch(term.replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
    if (tc.length >= 4 && compactN.includes(tc)) console.log('COMPACT NORM HIT', term, 'tc', tc);
  }
`,
  ctx
);

// Regression: evasive slur still detected
const ctx2 = { console };
vm.runInNewContext(
  `${bundle}
  console.log('slur literal', hasSpamSlur('you n!gger'));
  console.log('slur compact path', hasSpamSlur('x n!gger x'));
`,
  ctx2
);
