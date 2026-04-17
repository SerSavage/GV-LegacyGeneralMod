const fs = require('fs');
const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const stripBundle = idx.slice(
  idx.indexOf('function stripOuterQuotesForGeneral'),
  idx.indexOf('const IMAGE_EXTENSIONS')
);

const bundle =
  stripBundle +
  idx.slice(idx.indexOf('const SPAM_SLUR_TERMS'), idx.indexOf('// Religion-related "goy"')) +
  idx.slice(idx.indexOf('function normalizeForMatch'), idx.indexOf('function transliterateRunesToLatin')) +
  idx.slice(idx.indexOf('function transliterateRunesToLatin'), idx.indexOf('function normalizeRunesForContextScan')) +
  idx.slice(idx.indexOf('function normalizeRunesForContextScan'), idx.indexOf('function countElderFutharkRunes')) +
  idx.slice(idx.indexOf('function countElderFutharkRunes'), idx.indexOf('function hasTriggerWord')) +
  idx.slice(idx.indexOf('function hasSpamSlur'), idx.indexOf('const RUNIC_EPIGRAPHY_PHRASE_RES')) +
  idx.slice(idx.indexOf('function isRunicInscriptionAllowed'), idx.indexOf('function hasRunicEpigraphySafeContext'));

const variants = [
  'I am ᛁ ᛋ ᛗ ᛁ ᚱ and usually sleep longer. But I am 60+ and have earned that...',
  '"I am ᛁ ᛋ ᛗ ᛁ ᚱ and usually sleep longer. But I am 60+ and have earned that..."',
  '\u201cI am ᛁ ᛋ ᛗ ᛁ ᚱ and usually sleep longer. But I am 60+ and have earned that...\u201d',
];

const vm = require('vm');

for (let i = 0; i < variants.length; i++) {
  const msg = variants[i];
  vm.runInNewContext(
    `${bundle}
    const raw = ${JSON.stringify(msg)};
    const gvModerationText = stripOuterQuotesForGeneral(raw.trim()) || raw;
    console.log('\\n--- variant', ${i});
    console.log('gvModerationText first char', gvModerationText.charCodeAt(0));
    console.log('runeCount', countElderFutharkRunes(gvModerationText));
    console.log('hasSpamSlur', hasSpamSlur(gvModerationText));
    console.log('isRunicInscriptionAllowed', isRunicInscriptionAllowed(gvModerationText));
    `,
    { console }
  );
}
