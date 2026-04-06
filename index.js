const { Client, GatewayIntentBits, Options, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dns = require('dns');
const Parser = require('rss-parser');

// --- Config (env or defaults for local) ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;
// Some hosts prefer IPv6 first; Discord gateway can stall there.
// Force IPv4-first DNS resolution for more reliable gateway connects.
try {
  dns.setDefaultResultOrder('ipv4first');
  console.log('DNS result order: ipv4first');
} catch (e) {
  console.warn('Could not set DNS result order:', e?.message || e);
}

// --- Channel IDs ---
// Trigger channel = gv-general (bot listens here for slurs, off-topic, religion/politics, Soon).
const TRIGGER_CHANNEL_ID = String(process.env.TRIGGER_CHANNEL_ID || '1166738417539887218');
const GV_GENERAL_CHANNEL_ID = String(process.env.GV_GENERAL_CHANNEL_ID || TRIGGER_CHANNEL_ID); // trigger channel (slurs, Soon, etc.) and Chronicus meme target
// Admin-only channel: we skip gv-general triggers for messages here; welcomes are only from guildMemberAdd (not from Carl-bot log)
const ADMIN_JOIN_CHANNEL_ID = String(process.env.ADMIN_JOIN_CHANNEL_ID || '1166746316999757864');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
// Message to send when a word is detected
// #off-topic — Chronicus + “please move here” education (gv-general warning still points here)
const REDIRECT_CHANNEL_ID = String(process.env.REDIRECT_CHANNEL_ID || '1168446788810842172');
// Bot-moved gv-general posts land here so #off-topic chat flow stays clean; message body still tells users to use off-topic
const MOVED_BY_BOT_CHANNEL_ID = String(process.env.MOVED_BY_BOT_CHANNEL_ID || '1485211311070511225');
// Severe CSAM/grooming-related text in gv-general → same hold channel + TMFIAR + mandatory ✅ from author (no Savage/unban bypass).
const CSAM_GROOMING_WORDS_FILE = process.env.CSAM_GROOMING_WORDS_FILE || path.join(process.cwd(), 'assets', 'csam-grooming-triggers.txt');
const CSAM_ACK_EMOJI = '✅';
const CSAM_ACK_COLLECTOR_MS = 7 * 24 * 60 * 60 * 1000; // wait up to 7 days for first ✅ from author
// User whose image/GIF posts in off-topic get moved to gv-general (delete in off-topic, re-post there with no message). Set in Render only — do not commit.
const OFFTOPIC_TO_GENERAL_USER_ID = process.env.OFFTOPIC_TO_GENERAL_USER_ID || '';
// User ID whose media (GIFs, images, videos, tenor.com links) with religious/political content in the message text get moved to #off-topic
const MEDIA_RELIGION_OFFTOPIC_USER_ID = process.env.MEDIA_RELIGION_OFFTOPIC_USER_ID || '1107129004642799616';
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp)$/i;
const IMAGE_CONTENT_TYPES = /^image\//;
const VIDEO_CONTENT_TYPES = /^video\//;
// Folder for downloading off-topic attachments before forwarding to gv-general (Discord URLs break after original message is deleted). Default: assets/memes
const FORWARDED_MEDIA_DIR = process.env.FORWARDED_MEDIA_DIR || path.join(process.cwd(), 'assets', 'memes');
const FORWARDED_MEDIA_EXTENSIONS = /\.(jpe?g|png|gif|webp|mp4|webm|mov|mp3|wav|m4a|ogg)$/i;
// Block specific Tenor/embed/attachment IDs in gv-general → same hold flow as off-topic (see desktop list)
const BLOCKED_MEDIA_IDS = (process.env.BLOCKED_MEDIA_IDS || '1749001747706566')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// RSS feed → Discord announcement channel (e.g. Gloria Victis news). If the site has no RSS, use a converter like https://rss.app/ with the news page URL.
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '1482341063674036284';
const RSS_FEED_URL = process.env.RSS_FEED_URL || 'https://rss.app/feeds/570E40bRtM0TKZJF.xml'; // Gloria Victis | gamigo news (override with env if needed)
const RSS_POLL_INTERVAL_MS = Math.max(60000, parseInt(process.env.RSS_POLL_INTERVAL_MS, 10) || 15 * 60 * 1000); // default 15 min
const RSS_SEEN_FILE = path.join(process.cwd(), 'rss-seen.json');
const NEW_ARRIVALS_CHANNEL_ID = String(process.env.NEW_ARRIVALS_CHANNEL_ID || '1166775627089719436'); // #new-arrivals: welcome video + user tag (join or first role)
// Channel IDs for welcome message links (Welcome + server-roles). Override with env if needed.
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1166746745582125096';   // #Welcome
const SERVER_ROLES_CHANNEL_ID = process.env.SERVER_ROLES_CHANNEL_ID || '1252706362899562647'; // #server-roles
// Emperor Miaow: when someone asks where Miaow is, reply with role ping + random image. Only triggered when the message author has Miðland role.
const EMPEROR_MIAOW_ROLE_ID = process.env.EMPEROR_MIAOW_ROLE_ID || '1279896690517737515'; // Emperor of Miðland (pinged in reply)
const MIAOW_TRIGGER_ROLE_ID = process.env.MIAOW_TRIGGER_ROLE_ID || '1167525339103248384'; // Miðland – only this role can trigger the "Where is Miaow?" reply
const EMPEROR_MIAOW_DIR = path.join(process.cwd(), 'EmperorMiaow');
const MIAOW_IMAGE_NAMES = ['MiaowMIA.png', 'miaow_1.png', 'miaow_2.png', 'miaow_3.png', 'miaow_4.png', 'miaow_5.png', 'miaow_6.png', 'miaow_7.png', 'miaow_8.png', 'miaow_9.png'];
function getRandomMiaowImage() {
  const existing = MIAOW_IMAGE_NAMES.map(name => path.join(EMPEROR_MIAOW_DIR, name)).filter(p => fs.existsSync(p));
  return existing.length ? existing[Math.floor(Math.random() * existing.length)] : null;
}
// Don't welcome users whose Discord account is too new (bot/alt filter). Set WELCOME_MIN_ACCOUNT_AGE_DAYS (e.g. 7 or 730 for 2 years).
const WELCOME_MIN_ACCOUNT_AGE_DAYS = Math.max(0, parseInt(process.env.WELCOME_MIN_ACCOUNT_AGE_DAYS, 10) || 7);
const WELCOME_MIN_ACCOUNT_AGE_MS = WELCOME_MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;
function shouldWelcomeAccountAge(user) {
  if (!user?.createdAt) return true; // no timestamp → allow
  const ageMs = Date.now() - new Date(user.createdAt).getTime();
  return ageMs >= WELCOME_MIN_ACCOUNT_AGE_MS;
}
// Role IDs that count as "nation/faction" choice — welcome only when new user picks one of these for the first time
const WELCOME_ROLE_IDS = new Set(['1167525339103248384', '1167525255577870396', '1167525387413229628', '1167524888941187272']); // nation roles + veteran
// Welcome videos when user joins or gets their role — prefer local files in repo (assets/), else Streamable URLs from env
const WELCOME_VIDEO_PATHS = [
  path.join(process.cwd(), 'assets', 'WelcomeToGV.mp4'),
  path.join(process.cwd(), 'assets', 'WelcomeKnights.mp4'),
  path.join(process.cwd(), 'assets', 'KnightOfGV.mp4'),
];
const NEW_ARRIVAL_VIDEO_URLS = (process.env.NEW_ARRIVAL_VIDEO_URLS || process.env.NEW_ARRIVAL_VIDEO_URL || 'https://streamable.com/vxi8bu,https://streamable.com/63lazw')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);
let lastWelcomeVideoPath = null; // avoid playing the same welcome video twice in a row
function getRandomWelcomeVideoPath() {
  const existing = WELCOME_VIDEO_PATHS.filter(p => fs.existsSync(p));
  if (existing.length === 0) return null;
  const pool = existing.length > 1 && lastWelcomeVideoPath
    ? existing.filter(p => p !== lastWelcomeVideoPath)
    : existing;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastWelcomeVideoPath = chosen;
  return chosen;
}
function getRandomWelcomeVideoUrl() {
  return NEW_ARRIVAL_VIDEO_URLS[Math.floor(Math.random() * NEW_ARRIVAL_VIDEO_URLS.length)] || 'https://streamable.com/vxi8bu';
}
const WELCOME_TEXT_BASE = (userMention) => `Welcome, ${userMention}!\n\nCheck out **Welcome** <#${WELCOME_CHANNEL_ID}> and **server-roles** <#${SERVER_ROLES_CHANNEL_ID}> to pick roles.`;
/** Returns { content, files? } for channel.send. Uses repo video file if present, else Streamable URL in content. */
function getWelcomeMessagePayload(userMention) {
  const videoPath = getRandomWelcomeVideoPath();
  if (videoPath) {
    return {
      content: WELCOME_TEXT_BASE(userMention),
      files: [{ attachment: videoPath, name: path.basename(videoPath) }],
    };
  }
  const videoUrl = getRandomWelcomeVideoUrl();
  return { content: `Welcome, ${userMention}!\n${videoUrl}\n\nCheck out **Welcome** <#${WELCOME_CHANNEL_ID}> and **server-roles** <#${SERVER_ROLES_CHANNEL_ID}> to pick roles.` };
}
const REDIRECT_MESSAGE = `Please move to <#${REDIRECT_CHANNEL_ID}> instead.`;
// Replace Israel flag with Palestine flag token in user messages (delete + repost flow)
const ISRAEL_FLAG_UNICODE = '\u{1F1EE}\u{1F1F1}'; // 🇮🇱
const FLAG_IL_TEXT_RE = /:flag_il:/gi;
const FLAG_IL_CUSTOM_RE = /<a?:flag_il:\d+>/gi;
const FLAG_IL_CUSTOM_TEST_RE = /<a?:flag_il:\d+>/i;
const FLAG_PS_REPLACEMENT = ':flag_ps:';
function hasIsraelFlagToken(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return text.includes(ISRAEL_FLAG_UNICODE) || lower.includes(':flag_il:') || FLAG_IL_CUSTOM_TEST_RE.test(text);
}
function replaceIsraelFlagWithPalestine(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .split(ISRAEL_FLAG_UNICODE).join(FLAG_PS_REPLACEMENT)
    .replace(FLAG_IL_TEXT_RE, FLAG_PS_REPLACEMENT)
    .replace(FLAG_IL_CUSTOM_RE, FLAG_PS_REPLACEMENT);
}
// Soon-only memes (gv-general :soon: + image reply). Off-topic / Chronicus uses everything else under assets/memes.
const MEMES_DIR = path.join(process.cwd(), 'assets', 'memes');
const SOON_MEME_BASENAMES = new Set([
  'IMG_5346.png',
  'letmein.jpg',
  'soon_rdt.jpg',
  'file_000000006138720aa48dcc9d3d67b177.png',
  'file_000000003ff87246a4a7611f400bbdd8.png',
]);
function listChronicusMemePathsFromAssets() {
  try {
    if (!fs.existsSync(MEMES_DIR)) return [];
    const exts = /\.(png|jpe?g|gif|webp)$/i;
    return fs.readdirSync(MEMES_DIR)
      .filter((name) => exts.test(name) && !SOON_MEME_BASENAMES.has(name))
      .map((name) => path.join(MEMES_DIR, name));
  } catch {
    return [];
  }
}
const CHRONICUS_MEME_PATHS = listChronicusMemePathsFromAssets();
console.log(`Chronicus/off-topic memes (assets/memes, excluding Soon set): ${CHRONICUS_MEME_PATHS.length}`);
function getRandomChronicusMeme() {
  const existing = CHRONICUS_MEME_PATHS.filter((p) => fs.existsSync(p));
  return existing.length ? existing[Math.floor(Math.random() * existing.length)] : null;
}
/** Chronicus body — channel link is also on the line above (see deleteInGeneralAndForwardMovedHold). */
function getChronicusAnnouncementText() {
  return `**Chronicus Generalium**\n\n***A long-lasting condition marked by the inability to locate the Off-Topic scrolls and a mystical attraction to gv-general.***`;
}

// Images for Soon trigger only — exactly these repo files (random pick), attached with :soon: reaction
const SOON_MEME_PATHS = [...SOON_MEME_BASENAMES].map((name) => path.join(MEMES_DIR, name));
function getRandomSoonMeme() {
  const existing = SOON_MEME_PATHS.filter((p) => fs.existsSync(p));
  return existing.length ? existing[Math.floor(Math.random() * existing.length)] : null;
}

// "Soon" reaction: when someone asks about game/servers/ETA, bot reacts with this custom emoji (gv-general only)
// Only short triggers: "gæm?" and "gæm when?"; rest are multi-word phrases (substring match)
const SOON_EMOJI = '<:Soon:1480665289715617842>';
// Generic meme: moderation / official server + guild-scale consequence + monkey/primate emoji trope (no real names).
// Default pool randomizes Discord :monkey: 🐒, :monkey_face: 🐵, :gorilla: 🦍. Override with MONKEY_TROPE_EMOJIS=comma,separated or legacy MONKEY_TROPE_EMOJI single value.
const MONKEY_TROPE_EMOJIS = (() => {
  const raw = process.env.MONKEY_TROPE_EMOJIS || process.env.MONKEY_TROPE_EMOJI;
  if (raw) {
    const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return ['🐒', '🐵', '🦍'];
})();
const MONKEY_TROPE_UNICODE_RE = /[\u{1F435}\u{1F648}\u{1F649}\u{1F64A}\u{1F412}]/u;
function hasMonkeyModerationTrope(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  // "Official GV Discord" etc. — must not require contiguous "official discord"
  const officialDiscordLoose = /\bofficial\b/.test(lower) && /\bdiscord\b/.test(lower);

  // Same meme without naming monkey: official Discord + emotes/reactions framed as conflict (siege weapons, bans, etc.)
  const emoteModerationMeme =
    officialDiscordLoose
    && /\b(emote|emotes|emoji|reaction|reacts?|sticker)\b/.test(lower)
    && (
      /\b(siege|weapon|weapons|weaponized)\b/.test(lower)
      || lower.includes('peaceful until')
      || /\b(ban|banned|warn|warning|moderat|threat)\b/.test(lower)
      || /\bguild\b/.test(lower)
    );
  if (emoteModerationMeme) return true;

  const primateStrong =
    MONKEY_TROPE_UNICODE_RE.test(text)
    || lower.includes(':monkey:')
    || /<a?:monkey:\d+>/i.test(text)
    || lower.includes('monkey emoji')
    || lower.includes('monkey emote')
    || lower.includes('monkey reaction')
    || lower.includes('monkey sticker')
    || lower.includes('primate sticker')
    || /\b(monkey|primates?)\s+(emoji|emote|reaction|sticker)\b/i.test(lower)
    || /\b(emoji|emote|reaction|sticker)s?\b.*\b(monkey|primates?)\b/i.test(lower)
    || (/\bone\s+(emoji|emote|reaction|sticker|monkey|primates?)\b/i.test(lower) && (/\b(monkey|primates?)\b/i.test(lower) || MONKEY_TROPE_UNICODE_RE.test(text)));
  if (!primateStrong) return false;
  const escalation =
    lower.includes('official discord')
    || officialDiscordLoose
    || lower.includes('official server')
    || /\bmoderat/.test(lower)
    || /\bthreat/.test(lower)
    || lower.includes('whole guild')
    || lower.includes('entire guild')
    || lower.includes('guild wide')
    || lower.includes('guild-wide')
    || lower.includes('guild extinction')
    || lower.includes('delete your guild')
    || lower.includes('collateral')
    || /\bcoalition\b/.test(lower)
    || /\bclan deletion\b/.test(lower)
    || (/\bguild\b/.test(lower) && /\b(ban|banned|banning|warn|warning|sanction)\b/.test(lower))
    || (/\b(ban|banned|threat)\b/.test(lower) && /\bguild\b/.test(lower));
  return escalation;
}

/**
 * Guild / nation / war stories: monkey noises as comms, language workarounds, or “you know you’re winning” memes.
 * Kept separate from moderation trope to avoid weakening those signals.
 */
function hasMonkeyNoisesCultureTrope(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  // Core: “monkey noise(s)”, “monkey sound(s)”, close primate variants
  if (/\bmonkey\s+noise(s)?\b/.test(lower)) return true;
  if (/\bmonkey\s+sounds?\b/.test(lower)) return true;
  if (/\bape\s+noise(s)?\b/.test(lower)) return true;
  if (/\bgorilla\s+noise(s)?\b/.test(lower)) return true;

  // Verbs + monkey + noise (incl. “start hearing people making monkey noises”)
  if (/\b(making|made|make|doing|do|hearing|heard|hear|starts?\s+hearing|started\s+hearing)\s+[^.\n]{0,100}\bmonkey\s+noise(s)?\b/.test(lower)) return true;
  if (/\bpeople\s+(making|doing)\s+monkey\b/.test(lower)) return true;

  // Louder / progressive monkey comms (“progressively louder monkey noises to indicate pushes”)
  if (/\bprogressively\s+(louder\s+)?monkey\b/.test(lower)) return true;
  if (/\blouder\s+monkey\s+noise(s)?\b/.test(lower)) return true;
  if (/\bmonkey\s+noise(s)?\b[^.]{0,140}\b(push|pushes|signal|raid|siege|objective|timing|coordination|callout|callouts|nation|guild|war|fight|fighting|winning|losing|spanish|english|barrier|language|communicat|vc|comms?)\b/.test(lower)) return true;
  if (/\b(push|pushes|signal|raid|callout|coordination|communicat|nation|guild|spanish|english|language\s+barrier|half\s+our\s+nation)[^.]{0,140}\bmonkey\s+noise(s)?\b/.test(lower)) return true;

  // “Monkey” as strat / meta / comms language
  if (/\bmonkey\s+(strat|tactics?|meta|comms?|callouts?|vc\s+language)\b/.test(lower)) return true;
  if (/\bmonkey\s+(as|for)\s+(the\s+)?(comm|communication|coordination|signal|language)\b/.test(lower)) return true;
  if (/\bcommunicat(e|ing|ion)?\s+(via|with|using)\s+monkey\b/.test(lower)) return true;
  if (/\b(spoke|speak|speaking|talk|talking)\s+(in\s+)?monkey\b/.test(lower)) return true;

  // Meme vocalizations when clearly gaming / primate adjacent (not plain “ook” spam)
  if (/\b(ooh\s+ooh|oo\s+oo|ook\s+ook)\b/.test(lower)) {
    if (/\b(ah\s+ah|monkey|gorilla|ape|push|war|raid|nation|guild|fight|fighting|winning)\b/.test(lower)) return true;
  }
  if (/\buga\s+buga\b/.test(lower) && /\b(nation|guild|war|push|raid|fight|vc)\b/.test(lower)) return true;

  // Phrase bag: common paraphrases (substring, gv-general context)
  const noiseCulturePhrases = [
    'return to monkey', 'returned to monkey', 'devolved to monkey', 'monkey hours',
    'went monkey mode', 'full monkey', 'monkey only', 'only monkey noises',
    'coordination was monkey', 'comms were monkey', 'comms was monkey', 'shotcaller monkey',
    'language barrier', // only with monkey (checked below)
  ];
  for (const p of noiseCulturePhrases) {
    if (lower.includes(p) && /\b(monkey|gorilla|ape|ooh\s+ooh|noise)\b/.test(lower)) return true;
  }

  return false;
}

function buildSoonTriggerPhrases() {
  const phrases = new Set();
  const add = (p) => { if (p && p.length > 0) phrases.add(p.toLowerCase()); };

  // Short triggers: gæm variants + When game
  add('gæm?');
  add('gæm when?');
  add('when gæm?');
  add('gæm');
  add('when gæm');
  add('when game?');
  add('when game');

  // Multi-word phrases: "when can we play", "is the game up", "when is the game up", etc.
  [
    'when can we play', 'when can i play', 'is the game up', 'when is the game up', 'is the game open', 'when is the game open',
    'when does the game open', 'when will the game open', 'when does it open', 'when will it open',
    'are servers open', 'when do servers open', 'when will servers open', 'is server up', 'are servers up',
    'are the servers up', 'servers up currently', 'are the servers up currently', 'servers up right now',
    // Server-up punctuation variants (?, !, ?!, !?, .) so "servers up?" etc. match
    'are the servers up?', 'are the servers up!', 'are the servers up?!', 'are the servers up!?', 'are the servers up.',
    'servers up currently?', 'servers up currently!', 'servers up currently?!', 'servers up currently!?',
    'are the servers up currently?', 'are the servers up currently!', 'are the servers up currently?!',
    'servers up right now?', 'servers up right now!', 'servers up right now?!', 'servers up right now!?',
    'servers up?', 'servers up!', 'servers up?!', 'is server up?', 'is server up!', 'are servers up?', 'are servers up!',
    // More server/game-up phrasings
    'servers online', 'are the servers online', 'is the server online', 'are servers online', 'server online',
    'server status', 'servers status', 'what\'s the server status', 'whats the server status', 'server status?',
    'are servers live', 'servers live yet', 'is the server live', 'is server live', 'game up', 'game up yet',
    'is the game up yet', 'is the game up?', 'can we play now', 'can i play now', 'play now', 'play yet',
    'is it up', 'is it up yet', 'is it up?', 'up yet', 'back up yet', 'servers back up', 'server back up',
    'are servers back', 'is the server back', 'servers back yet', 'server back yet', 'maintenance over yet',
    'anyone know if servers are up', 'anyone know if the servers are up', 'check if servers are up',
    'know if servers are up', 'servers running', 'is the server running', 'are servers running',
    'game running', 'is the game running', 'can we get on', 'can i get on', 'get on the game',
    'when can we get on', 'when can i get on', 'is the server working', 'server working',
    'dumb question but are the servers', 'stupid question but are the servers', 'quick question are the servers',
    'when can we play the game', 'when can i play the game', 'can we play', 'can i play', 'can we play yet', 'can i play yet',
    'ready to play', 'when can we get in', 'can we get in', 'can i get in', 'when can we get in the game',
    'get in the game', 'join the game', 'when can we join',
    'any eta', "what's the eta", 'whats the eta', 'got an eta', 'have an eta',
    "when's it out", 'when is it out', "when's the release", 'when is the release', 'release the game',
    "when's the game coming", 'when is the game coming', 'game coming out', 'when coming out',
    'any news on the game', 'any word on the game', 'any update on the game', "when's the update", 'when is the update',
    'maintenance over', 'maintenance done', 'servers back', 'server back', 'is it back up',
    'game live', 'is it live', 'are we live', 'when is the game live', "when's the game live",
    'is the game ready', 'when can we start', 'when can i start', 'when will we be able to play',
    'when can we access', 'when can i access', 'access the game',
    'is server working', 'are servers working', 'game working',
    "when's the beta", 'when is the beta', 'when early access', 'early access yet',
    'when closed beta', 'when stress test', 'when beta test',
    "when's downtime over", 'maintenance when', 'when maintenance', 'when patch out', 'when update',
    'when hotfix', 'when fix', 'is it back', 'are we back',
    'when can we hop on', 'hop on the game',
    "when's it dropping", 'when is it dropping', 'game drop when',
    "when's launch", 'when is launch', "when's launch date", 'when release date', "when's the release date",
    'any info on the game', 'any info on servers', 'can we play today',
    'game tomorrow', 'servers tomorrow', 'when tomorrow', 'game this week', 'servers this week',
    'release this week', 'game this weekend', 'play this weekend', 'game next week', 'servers next week',
    'waiting for game', 'waiting for servers', 'waiting to play', 'when can we stop waiting',
    'still no game', 'still no servers', 'no game yet', 'no servers yet', 'game not out', 'servers not up',
    'not open yet', 'not up yet', 'not live yet', 'game delayed', 'release delayed', "when's the delay",
    'game postponed', 'release postponed', 'game pushed back',
    'how soon until', 'how long until', 'how long until we can play', 'how long until servers', 'how long until game',
    'how much longer until', 'should be soon', 'supposed to be soon', 'was supposed to open',
    'was supposed to be up', 'should be up', 'should be open', 'should be live', 'must be soon',
    // How to join / Steam / access – "how do I join", "Steam not letting me", "can't get in"
    'how to join', 'how do i join', 'how can i join', 'how do we join', 'how can we join',
    'tell me how to join', 'anyone know how to join', 'how to get in', 'how do i get in', 'how can i get in',
    'join the game', 'cant join', "can't join", 'cannot join', 'cant get in', "can't get in", 'cannot get in',
    'steam not letting', 'steam not letting me', 'steam wont let', "steam won't let", 'steam is not letting',
    'go to steam', 'go tho steam', 'tried to go to steam', 'through steam', 'via steam',
    'it not letting me', 'its not letting me', "it's not letting me", 'not letting me', 'wont let me', "won't let me",
    'steam not working', 'steam doesnt work', "steam doesn't work", 'cant get in the game', "can't get in the game",
    'how to play', 'how do i play', 'how can i play', 'where do i download', 'where to download', 'how to download',
    // Community testing / playtest duration (e.g. "estimated end date for this community testing phase")
    'community testing', 'community test', 'testing phase', 'test phase', 'playtest', 'play test', 'playtest phase',
    'estimated end date', 'end date for', 'specific duration', 'how long will this', 'how long is the test',
    'how long is testing', 'when does testing end', 'when will testing end', 'when does the test end',
    'duration of the', 'length of the test', 'testing last', 'test last until',
  ].forEach(add);

  return [...phrases];
}
const SOON_TRIGGER_PHRASES = buildSoonTriggerPhrases();
console.log(`Soon trigger phrases: ${SOON_TRIGGER_PHRASES.length}`);

// Multi-word game-related phrases only: when these trigger Soon, we also post a Soon meme image. Short triggers (gæm?, tomorrow) get :soon: reaction only, no image.
const SOON_IMAGE_PHRASES = [
  'when can we play', 'when can i play', 'is the game up', 'when is the game up', 'is the game open', 'when is the game open',
  'when does the game open', 'when will the game open', 'when does it open', 'when will it open',
  'are servers open', 'when do servers open', 'when will servers open', 'is server up', 'are servers up',
  'are the servers up', 'servers up currently', 'are the servers up currently', 'servers up right now',
  'are the servers up?', 'are the servers up!', 'are the servers up?!', 'servers up currently?', 'servers up currently?!',
  'servers up right now?', 'servers up right now?!', 'servers up?', 'servers up!', 'is server up?', 'are servers up?',
  'servers online', 'are the servers online', 'is the server online', 'server status', 'are servers live',
  'servers live yet', 'game up yet', 'is the game up yet', 'can we play now', 'can i play now', 'is it up', 'is it up yet',
  'servers back up', 'server back up', 'are servers back', 'servers back yet', 'anyone know if servers are up',
  'check if servers are up', 'servers running', 'is the server running', 'dumb question but are the servers',
  'when can we play the game', 'when can i play the game', 'can we play', 'can i play', 'can we play yet', 'can i play yet',
  'ready to play', 'when can we get in', 'can we get in', 'can i get in', 'when can we get in the game',
  'get in the game', 'join the game', 'when can we join',
  'any eta', "what's the eta", 'whats the eta', 'got an eta', 'have an eta',
  "when's it out", 'when is it out', "when's the release", 'when is the release', 'release the game',
  "when's the game coming", 'when is the game coming', 'game coming out', 'when coming out',
  'any news on the game', 'any word on the game', 'any update on the game', "when's the update", 'when is the update',
  'maintenance over', 'maintenance done', 'servers back', 'server back', 'is it back up',
  'game live', 'is it live', 'are we live', 'when is the game live', "when's the game live",
  'is the game ready', 'when can we start', 'when can i start', 'when will we be able to play',
  'when can we access', 'when can i access', 'access the game',
  'is server working', 'are servers working', 'game working',
  "when's the beta", 'when is the beta', 'when early access', 'early access yet',
  'when closed beta', 'when stress test', 'when beta test',
  "when's downtime over", 'maintenance when', 'when maintenance', 'when patch out', 'when update',
  'when hotfix', 'when fix', 'is it back', 'are we back',
  'when can we hop on', 'hop on the game',
  "when's it dropping", 'when is it dropping', 'game drop when',
  "when's launch", 'when is launch', "when's launch date", 'when release date', "when's the release date",
  'any info on the game', 'any info on servers', 'can we play today',
  'game tomorrow', 'servers tomorrow', 'when tomorrow', 'game this week', 'servers this week',
  'release this week', 'game this weekend', 'play this weekend', 'game next week', 'servers next week',
  'waiting for game', 'waiting for servers', 'waiting to play', 'when can we stop waiting',
  'still no game', 'still no servers', 'no game yet', 'no servers yet', 'game not out', 'servers not up',
  'not open yet', 'not up yet', 'not live yet', 'game delayed', 'release delayed', "when's the delay",
  'game postponed', 'release postponed', 'game pushed back',
  'how soon until', 'how long until', 'how long until we can play', 'how long until servers', 'how long until game',
  'how much longer until', 'should be soon', 'supposed to be soon', 'was supposed to open',
  'was supposed to be up', 'should be up', 'should be open', 'should be live', 'must be soon',
  // How to join / Steam / access – also get Soon meme image
  'how to join', 'how do i join', 'how can i join', 'how do we join', 'how can we join',
  'tell me how to join', 'anyone know how to join', 'how to get in', 'how do i get in', 'how can i get in',
  'cant join', "can't join", 'cannot join', 'cant get in', "can't get in", 'cannot get in',
  'steam not letting', 'steam not letting me', 'steam wont let', "steam won't let", 'steam is not letting',
  'go to steam', 'go tho steam', 'tried to go to steam', 'through steam', 'via steam',
  'it not letting me', 'its not letting me', "it's not letting me", 'not letting me', 'wont let me', "won't let me",
  'steam not working', 'steam doesnt work', "steam doesn't work", 'cant get in the game', "can't get in the game",
  'how to play', 'how do i play', 'how can i play', 'where do i download', 'where to download', 'how to download',
  'community testing', 'community test', 'testing phase', 'test phase', 'playtest', 'play test', 'playtest phase',
  'estimated end date', 'end date for', 'specific duration', 'how long will this', 'how long is the test',
  'how long is testing', 'when does testing end', 'when will testing end', 'when does the test end',
  'duration of the', 'length of the test', 'testing last', 'test last until',
];
function hasSoonTriggerWithImage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  return SOON_IMAGE_PHRASES.some(phrase => lower.includes(phrase));
}

// Multiple GIFs – one is picked at random when replying
const TENOR_GIFS = [
  'https://tenor.com/view/person-of-interest-hersh-i-think-we\'re-getting-off-topic-gif-13873963244115564618',
  'https://tenor.com/view/all-right-lets-go-sgt-bull-wheatley-them-lets-move-come-on-gif-21089700',
  'https://tenor.com/view/history-of-the-world-move-move-along-go-away-move-it-along-gif-12125287933846122147',
  'https://tenor.com/view/take-your-time-cat-nile-pile-manicure-bored-gif-1146754972652164095',
  'https://tenor.com/view/get-over-it-gary-marshall-borders-sistas-s6e12-move-on-gif-1883620024651432269',
  'https://tenor.com/view/i-travel-a-lot-trent-arant-ttthefineprinttt-i-take-many-trips-i-get-around-often-gif-7707912145335338163',
  'https://tenor.com/view/you-better-move-girl-tracy-jordan-30rock-hurry-move-it-gif-19248847',
  'https://tenor.com/view/days-of-our-lives-dool-gabi-hernandez-dimera-move-on-already-camila-banus-gif-19360973',
];
// GIF for off-topic phrases (body/gender/race vulgar) – Mace Windu "it's settled then"
const OFF_TOPIC_GIF = 'https://tenor.com/view/mace-windu-gif-24903892';

// Reference: which media goes with which trigger (all in gv-general → delete + repost to MOVED_BY_BOT_CHANNEL; Chronicus in gv-general → #off-topic unless noted)
// • Slurs (first time)  → random TENOR_GIF  | Slurs (repeated in 1h) → VIDEO_URL (TMFIAR streamable.com/e/mwfkm2)
// • Off-topic phrases   → OFF_TOPIC_GIF (Mace Windu only)
// • Religion/politics  → random TENOR_GIF
// • Soon (Gæm?, ETA?)  → SOON_EMOJI reaction only (no delete/forward)
// • New member welcome → random from NEW_ARRIVAL_VIDEO_URLS in #new-arrivals (channel NEW_ARRIVALS_CHANNEL_ID), user mentioned by ID

// Safe-context terms: if message contains any of these (game/community/lore), we do NOT trigger religion/politics filter.
// Built from in-code list + Gloria Victis Wiki (https://gloriavictis.fandom.com/wiki/Gloria_Victis_Wiki) + optional safe-context.txt
const SAFE_CONTEXT_BASE = [
  'nations', 'guilds', 'greenleafs', 'greenleaves', 'enemy', 'helping', 'players', 'emotes', 'monke',
  'downvote', 'upvote', 'voted', 'voting', 'sub',
  'grayward', 'gv',
  'interest', 'hobbies', 'share', 'experience', 'personal',
  'another round', 'round in',
  'emperor', 'represent',
  'jc', 'jarnclan', 'jarn',
  'destiny',
  'savage', // common in usernames (e.g. Ser-UNBAN-THE-COMMUNITY-Savage) and casual use – don't trigger religion/politics
  'dipshit', // mod-style scolding (e.g. "for him dipshit") – don't trigger
  'good', // common word (agreement/approval); if in words.txt would trigger on single "Good" – skip
  'mad men', 'mad man', 'lunatics', 'lunatic', // idiom/quote (e.g. "nation filled with mad men and lunatics") – skip off-topic and religion/politics
  // Gloria Victis Wiki – game/lore so "war", "empire", "worship" etc. don't trigger
  'state of war', 'gloria victis', 'black eye games',
  'midland', 'midlanders', 'azebia', 'azebs', 'nordheim', 'ismirs', 'sangmar', 'sangarians',
  'empire of azebia', 'azebian', 'midlandic', 'sangmar empire',
  'forefather', 'greatfather', 'khagan', 'zenith',
  'crafting', 'economy', 'bosses', 'recipes', 'resources', 'shields', 'glory', 'reputation',
  'guild', 'siege', 'territory', 'non-targeting', 'loot', 'medieval', 'mmorpg',
  // Store/platform + game discussion so real-world politics triggers don't fire on game-related posts.
  'steam', 'mortal online',
  'geliand', 'hillead', 'infidels', 'island', 'fashion', 'chests', 'titles', 'interfaces', 'map',
  'log in', 'login', 'log in.', 'can\'t log in', 'cant log in', // game/server – avoid triggering on "I can't log in"
  'in-game', 'ingame', // "genocide a nation in-game" = game talk, don't trigger
  // Ping, matchmaking, game balance – allow in gv-general (e.g. "match between ping 30 and 110", "remove the marker", "unplayable")
  'ping', 'marker', 'unplayable', 'match', 'matchmaking', 'latency', 'ms',
  // In-game PvP / character combat – not IRL violence (e.g. "Meow Army", "it's going to be a bloodbath" = in-game)
  'bloodbath', 'meow army',
  // Nation choice / faction traits – game context (e.g. "Soon you'll be choosing a nation", "some are more military")
  'choosing a nation', 'choosing a faction', 'more military', 'nation choice', 'pick a nation',
  // Player region / server zone shorthand (not IRL politics)
  'north america', 'south america', 'southeast asia', 'south east asia', 'latin america', 'oceania',
];
function loadSafeContextWords() {
  const fromFile = loadWordsFromFile(process.env.SAFE_CONTEXT_FILE || 'safe-context.txt')
    .filter(w => !w.startsWith('#'));
  const all = [...new Set([...SAFE_CONTEXT_BASE.map(w => w.toLowerCase()), ...fromFile])];
  return new Set(all);
}
const SAFE_CONTEXT_WORDS = loadSafeContextWords();
console.log(`Safe-context terms: ${SAFE_CONTEXT_WORDS.size} (GV Wiki + safe-context.txt)`);

// Spam/slur terms – if message contains any of these, bot replies with the video (no safe-context bypass).
// Includes common evasive spellings users type to avoid filters.
const SPAM_SLUR_TERMS = [
  'nigger', 'nigga', 'niggas', 'niggers', 'nigers', 'nigas', 'niga', 'nigra', 'nigrah', 'niggar', 'niggur', 'nigguh', 'niggr', 'niger', 'nigor', 'nigar',
  'n1gga', 'n1gger', 'n1ga', 'n1gas', 'n1ggas', 'n1ggers', 'ni99a', 'ni99er', 'n!gga', 'n!gger', 'n!ga', 'n!gg@', 'nigg@', 'nigg3r', 'n1gg3r', 'nigg4', 'n1gg4',
  'niqqa', 'niqqer', 'n1qqa', 'n1qqer', 'n!qqa', 'n!qqer',
  'mein fuhrer', 'mein fuher', 'mein furer', 'fuhrer', 'fuher', 'furer', 'master race', 'masterrace',
  'kike', 'kikes', 'k1ke', 'k!ke', 'kyke', 'kik3', 'k1k3',
  // Extended "fuck you…" insults – spam trigger (video + redirect)
  'fuck you, you useless piece of shit', 'fuck you, you absolute waste of oxygen', 'fuck you, you miserable excuse for a human',
  'fuck you, you walking pile of garbage', 'fuck you, you pathetic sack of nothing', 'fuck you, you brainless waste',
  'fuck you, you failure in human form', "fuck you and every decision you've ever made", 'fuck you and your entire existence',
  'fuck you and whatever dumb shit you believe in', 'fuck you and the mess you call a life', 'fuck you, you worthless fuck',
  'fuck you, you dumb bastard', 'fuck you, you spineless idiot', 'fuck you, you incompetent mess', 'fuck you, you absolute trainwreck',
  'fuck you, choke on it', 'fuck you, stay down', 'fuck you, get lost forever', 'fuck you, disappear',
  'fuck you into oblivion and back again', 'fuck you until the universe forgets you exist', "fuck you into a hole you can't crawl out of",
  'fuck you straight into hell', 'fuck you into dust',
].map(w => w.toLowerCase());

// Religion-related "goy" terms – same as religion/politics: redirect to #off-topic with random GIF (no safe-context bypass)
const GOY_TERMS = [
  'goy', 'goyim', 'goyish', 'goys', 'goyische', 'goyishe', 'goyisher', 'goyem', 'goi', 'goim', 'g0y', 'g0yim',
].map(w => w.toLowerCase());

// Off-topic phrases – vulgar/objectifying by body, gender, race, nationality. Medical/psychiatric slurs: hasMedicalPsychiatricInsult (before safe-context). Bot replies with GIF + redirect (no safe-context bypass)
function buildOffTopicPhrases() {
  const body = ['fat', 'skinny', 'thick', 'curvy', 'chubby', 'bbw', 'petite'];
  const person = ['chick', 'chicks', 'guy', 'guys', 'girl', 'girls', 'dude', 'dudes', 'man', 'men', 'woman', 'women', 'boy', 'boys', 'babe', 'babes'];
  const raceNat = ['black', 'white', 'asian', 'latina', 'latino', 'mexican', 'indian', 'russian', 'french', 'british', 'italian', 'spanish', 'korean', 'japanese', 'chinese', 'arab', 'persian', 'irish', 'german', 'brazilian', 'colombian', 'thai', 'vietnamese', 'filipina', 'filipino', 'puerto rican', 'dominican', 'cuban', 'egyptian', 'turkish', 'polish', 'dutch', 'swedish', 'blonde', 'brunette', 'redhead'];
  const phrases = new Set();

  const add = (p) => { if (p && p.length > 1) phrases.add(p.toLowerCase()); };

  // "fuck a [body] [person]", "fuck [body] [person]", "[body] [person]"
  for (const b of body) {
    for (const p of person) {
      add(`fuck a ${b} ${p}`);
      add(`fuck ${b} ${p}`);
      add(`${b} ${p}`);
    }
    add(`fuck a ${b}`);
    add(`fuck ${b}`);
  }
  // "fuck a [race/nat] [person]", "fuck [race/nat] [person]", "[race/nat] [person]" (vulgar objectifying)
  for (const r of raceNat) {
    for (const p of person) {
      add(`fuck a ${r} ${p}`);
      add(`fuck ${r} ${p}`);
      add(`${r} ${p}`);
    }
    add(`fuck a ${r}`);
    add(`fuck ${r}`);
  }
  // "lets fuck a ...", "let's fuck a ..."
  add('lets fuck a');
  add('let\'s fuck a');
  add('lets fuck');
  add('let\'s fuck');
  // common standalone vulgar off-topic
  add('fuck a fat');
  add('fuck fat');
  add('fuck a skinny');
  add('fuck a thick');
  add('fuck a black');
  add('fuck a white');
  add('fuck an asian');
  add('fuck a latina');
  add('fuck a latino');
  add('inbreed');
  add('inbred');
  add('fuck your siblings');
  // "fuck you bloody" and extended vulgar "fuck you…" insults – off-topic trigger; plain "fuck you" is not in the list
  add('fuck you bloody');
  add('fuck you, you useless piece of shit');
  add('fuck you, you absolute waste of oxygen');
  add('fuck you, you miserable excuse for a human');
  add('fuck you, you walking pile of garbage');
  add('fuck you, you pathetic sack of nothing');
  add('fuck you, you brainless waste');
  add('fuck you, you failure in human form');
  add('fuck you and every decision you\'ve ever made');
  add('fuck you and your entire existence');
  add('fuck you and whatever dumb shit you believe in');
  add('fuck you and the mess you call a life');
  add('fuck you, you worthless fuck');
  add('fuck you, you dumb bastard');
  add('fuck you, you spineless idiot');
  add('fuck you, you incompetent mess');
  add('fuck you, you absolute trainwreck');
  add('fuck you, choke on it');
  add('fuck you, stay down');
  add('fuck you, get lost forever');
  add('fuck you, disappear');
  add('fuck you into oblivion and back again');
  add('fuck you until the universe forgets you exist');
  add('fuck you into a hole you can\'t crawl out of');
  add('fuck you straight into hell');
  add('fuck you into dust');

  return [...phrases];
}
const OFF_TOPIC_PHRASES = buildOffTopicPhrases();
console.log(`Off-topic phrases: ${OFF_TOPIC_PHRASES.length} + ${OFF_TOPIC_EXTRA_PHRASES.length} extra (body/gender/race/nationality + desktop).`);

// Video reply: default is Streamable link so the bot always has access. Override with VIDEO_URL or VIDEO_PATH (local file).
const DEFAULT_VIDEO_URL = 'https://streamable.com/e/mwfkm2';
const VIDEO_URL = process.env.VIDEO_URL !== undefined && process.env.VIDEO_URL !== '' ? process.env.VIDEO_URL : DEFAULT_VIDEO_URL;
const VIDEO_PATH = process.env.VIDEO_PATH || (() => {
  const inRepo = 'assets/TMFIAR.mp4';
  if (fs.existsSync(inRepo)) return inRepo;
  if (process.platform === 'win32') return 'C:\\Users\\serje\\Downloads\\TMFIAR.mp4';
  return inRepo;
})();
// "Poor … Savage" reply in gv-general (override path on Render; bundle mp4 in assets for deploy)
const POOR_SAVAGE_VIDEO_PATH = process.env.POOR_SAVAGE_VIDEO_PATH || path.join(process.cwd(), 'assets', 'The_Way_We_Raid_Gloria_Victis.mp4');

/** e.g. "Poor unban Savage", "Poor little Savage" — requires at least one character between Poor and Savage */
function hasPoorSomethingSavageTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const m = text.match(/\bpoor\s+(.+?)\s+\bsavage\b/is);
  if (!m) return false;
  const mid = m[1].replace(/\s+/g, ' ').trim();
  return mid.length >= 1 && mid.length <= 400;
}

// Load trigger words from one or more files (comma-separated; multiple lines merged)
function loadWordsFromFile(path) {
  if (!fs.existsSync(path)) return [];
  const content = fs.readFileSync(path, 'utf8');
  return content
    .split(/\r?\n/)
    .flatMap(line => line.split(',').map(w => w.trim().toLowerCase()).filter(Boolean));
}

function loadWords() {
  const mainPath = process.env.WORDS_FILE || 'words.txt';
  const variantPath = process.env.WORDS_VARIANTS_FILE || 'words-variants.txt';
  const words = loadWordsFromFile(mainPath);
  if (words.length === 0 && !fs.existsSync(mainPath)) {
    console.error('words.txt not found. Set WORDS_FILE or add words.txt');
  }
  const variants = loadWordsFromFile(variantPath);
  const all = [...new Set([...words, ...variants])];
  return new Set(all);
}

const triggerWords = loadWords();
console.log(`Loaded ${triggerWords.size} trigger words (including synonyms, abbrevs, leet).`);

// Strip emojis and Discord custom emoji text so we only match real words (e.g. 🙏 doesn't count as "pray")
function stripEmojis(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/:[\w]+:/g, ' ') // Discord custom emoji like :pray:
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, ' ') // common emoji ranges
    .replace(/\s+/g, ' ')
    .trim();
}

// Escape special regex characters in a string so it can be used in RegExp
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize text so prolonged/leetspeak still matches trigger words:
// - Collapse 2+ repeated letters (goooood → god, reeee → re)
// - Replace common number-for-letter (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b)
function normalizeForMatch(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.toLowerCase();
  t = t.replace(/(.)\1+/g, '$1');  // collapse repeated chars
  t = t.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a')
       .replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/9/g, 'g');
  return t;
}

// Check if message text contains any trigger word as a whole word (case-insensitive).
// Also checks normalized form so "goooood", "g0d", "pol1t1cs" match "god", "politics".
function hasTriggerWord(text) {
  const cleaned = stripEmojis(text);
  if (!cleaned) return false;
  const normalized = normalizeForMatch(cleaned);
  for (const word of triggerWords) {
    const re = new RegExp('\\b' + escapeRegex(word) + '\\b', 'i');
    if (re.test(cleaned)) return true;
    // Match normalized message against normalized trigger (e.g. "g0d" in list vs "god" in msg, or "god" in list vs "gooood" in msg)
    const wordNorm = normalizeForMatch(word);
    const reNorm = new RegExp('\\b' + escapeRegex(wordNorm) + '\\b', 'i');
    if (reNorm.test(normalized)) return true;
  }
  return false;
}

// Check if message contains any spam/slur term (case-insensitive)
function hasSpamSlur(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return SPAM_SLUR_TERMS.some(term => lower.includes(term));
}

// Exception: "mad men" / "lunatics" in idiom/quote context (e.g. "nation filled with mad men and lunatics") — don't trigger off-topic
const OFF_TOPIC_SAFE_PHRASES = ['mad men', 'mad man', 'lunatics', 'lunatic', 'gamigo', 'trove'];

// Extra phrases (meme slang / desktop list) → same off-topic redirect as OFF_TOPIC_PHRASES
const OFF_TOPIC_EXTRA_PHRASES = ['copium', 'afrocentrism', 'afrocentric'].map((p) => p.toLowerCase());

// Check if message contains any off-topic phrase (case-insensitive substring)
function hasOffTopicPhrase(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  if (OFF_TOPIC_SAFE_PHRASES.some(safe => lower.includes(safe))) return false;
  if (OFF_TOPIC_EXTRA_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return OFF_TOPIC_PHRASES.some(phrase => lower.includes(phrase));
}

// Broad racial/religious stereotype generalizations (same redirect as vulgar off-topic). Runs before safe-context so it is not bypassed.
function hasStereotypeRaceReligionRedirect(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const group = /\b(muslim|muslims|islam|jew|jews|jewish|mexican|mexicans|arab|arabs|black people|whites|white people|asian|asians|indian|indians|hindu|hindus|christian|christians|catholic|catholics|protestant|mormon|mormons|latino|latinos|hispanic|illegal aliens?|immigrants?)\b/i;

  if (lower.includes('south of the border') && /\b(mexican|mexico|latino|hispanic|illegal|border)\b/.test(lower)) return true;
  if (/\bisn'?t everyone\b/.test(lower) && group.test(text)) return true;
  if (/\baren'?t (all|everyone|most people)\b/.test(lower) && group.test(text)) return true;
  if (/\bwhy (do|are) (all|most|every)\b/.test(lower) && group.test(text)) return true;
  if (/\b(all|most) (muslims|jews|christians|mexicans|blacks|whites|asians|arabs|hindus|immigrants)\s+(are|like|so|always|just)\b/i.test(lower)) return true;
  if (/\bdo (all|most) (muslims|jews|christians|hindus|mormons)\b/i.test(lower)) return true;
  if (/\b(is|are) (all|most) (muslims|jews|christians|hindus|mexicans)\b/i.test(lower)) return true;
  // Racialized “brown people” bait / UK meme patterns (desktop list)
  if (lower.includes('soft spot for brown people')) return true;
  if (lower.includes('brown spot for') && lower.includes('brown people')) return true;
  if (lower.includes('many such cases') && (/\buk\b/i.test(lower) || lower.includes('united kingdom'))) return true;
  return false;
}

// Psychiatric / disability slurs and using clinical terms as insults — gv-general → off-topic (no safe-context bypass).
// Not applied to idiom-only "lunatic(s)" here; OFF_TOPIC_SAFE_PHRASES still shields that phrase from *other* off-topic lists.
const MEDICAL_PSYCH_INSULT_SUBSTRINGS = [
  'schizo', 'schizophren', 'schizoaffective',
  'psychopath', 'psychotic', 'psychosis', 'sociopath',
  'retard', 'retarded', 'libtard', 'conservatard', // leetspeak variants partly caught by normalizeForMatch in check below
  'autist', 'autistic', 'asperger', 'aspie', 'tism',
  'manic', 'maniac',
  'delusional', 'delusion',
  'mentally ill', 'mental illness', 'mental patient',
  'nutcase', 'nutjob', 'nut job', 'nuthouse', 'nutters', 'nutter',
  'spastic', 'spaz',
  'mongoloid',
  'down syndrome', 'downs syndrome',
  'cripple', 'crippled',
  'psych ward', 'psych hospital', 'loony', 'loonies',
  'neurotic',
  'dementia', 'alzheimer',
  'special needs', 'short bus',
  'feeble minded', 'feeble-minded',
  'window licker',
  'munchausen',
  'hysteric', 'hysteria',
  'psych eval',
  'dissociat', // dissociative, dissociating as insult
  'narcissistic personality',
  'borderline personality',
].map(s => s.toLowerCase());

function hasMedicalPsychiatricInsult(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const normalized = normalizeForMatch(lower);

  // Many users use "retarded" as a casual "broken/buggy" adjective for game issues.
  // If the post is clearly game/platform context, don't treat "retarded"/"retard" as a medical slur.
  const looksGameLikeForRetard =
    /\b(steam|mortal online|gloria victis|in[- ]game|ingame|mmorpg|looting?|loot)\b/.test(lower)
    || /\bbug(s)?\b/.test(lower);

  for (const sub of MEDICAL_PSYCH_INSULT_SUBSTRINGS) {
    if (lower.includes(sub)) {
      if ((sub === 'retard' || sub === 'retarded') && looksGameLikeForRetard) return false;
      return true;
    }
    const subNorm = normalizeForMatch(sub);
    if (subNorm.length >= 3 && normalized.includes(subNorm)) {
      if ((sub === 'retard' || sub === 'retarded') && looksGameLikeForRetard) return false;
      return true;
    }
  }
  return false;
}
console.log(`Medical/psychiatric insult substrings: ${MEDICAL_PSYCH_INSULT_SUBSTRINGS.length} (some "retarded" uses ignored in game context).`);

// Real-world geopolitical keywords (POLITICAL_EXTRA-style + close variants). Runs BEFORE safe-context so "guilds + NATO" still → #off-topic (random GIF, same as religion/politics).
const GEOPOLITICAL_HARD_SUBSTRINGS = [
  'nato', 'sanctions', 'sanctioned', 'sanction ',
  'invasion', 'invade',
  'regime',
  'geopolitical', 'embargo', 'embargoes',
  'intervention', 'annexation', 'insurgency',
  'war crime', 'war crimes',
].map(s => s.toLowerCase());

/** UN / U.N. without matching Spanish article "un" alone */
const GEOPOLITICAL_UN_RE = /\b(?:the\s+)?u\.?\s*n\.?\b|\bunited\s+nations\b|\bun\s+security\b|\bun\s+general\b|\bun\s+council\b|\bun\s+vote\b|\bun\s+resolution\b|\bun\s+peacekeeping\b/i;

function hasGeopoliticalHardRedirect(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const s of GEOPOLITICAL_HARD_SUBSTRINGS) {
    if (lower.includes(s.trim())) return true;
  }
  // "sanction" at word start / after space (sanctioning, sanctions already caught)
  if (/\bsanction/i.test(text)) return true;
  if (/\bstates\b/.test(lower)) return true;
  if (GEOPOLITICAL_UN_RE.test(text)) return true;
  return false;
}

// Check if message contains any goy-related term (religion filter)
function hasGoyTerm(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return GOY_TERMS.some(term => lower.includes(term));
}

// Tenor GIF IDs that are allowed in gv-general even if the URL slug contains trigger words (e.g. trump-kittens = cats, not politics)
const SAFE_TENOR_GIF_IDS = new Set(['5449274500905931814']); // trump-kittens us-army special-ops (kittens/cats content)
function messageContainsSafeTenorLink(content) {
  if (!content || typeof content !== 'string') return false;
  if (!content.includes('tenor.com')) return false;
  for (const id of SAFE_TENOR_GIF_IDS) {
    if (content.includes(id)) return true;
  }
  return false;
}

// Political countries and leaders – count as trigger words for religion/politics filter (e.g. "Pakistan Iran Israel are states")
const POLITICAL_COUNTRIES = new Set([
  'pakistan', 'iran', 'israel', 'india', 'china', 'russia', 'usa', 'ukraine', 'taiwan', 'gaza', 'palestine',
  'afghanistan', 'syria', 'iraq', 'north korea', 'south korea', 'saudi', 'yemen', 'lebanon', 'jordan', 'egypt',
  'turkey', 'israeli', 'iranian', 'pakistani', 'russian', 'chinese', 'american', 'british', 'french', 'german',
].map(w => w.toLowerCase()));
const POLITICAL_LEADERS = new Set([
  'netanyahu', 'modi', 'xi', 'jinping', 'putin', 'zelensky', 'zelenskyy', 'trump', 'biden', 'obama',
  'musk', 'kim jong', 'mcconnell', 'pelosi', 'schumer', 'johnson', 'sunak', 'macron', 'scholz',
  'rishi', 'boris', 'merkel', 'trudeau', 'erdogan', 'mbs', 'bin salman', 'khamenei', 'rouhani',
].map(w => w.toLowerCase()));
// Note: 'eu' omitted — EU/NA/SEA/AU etc. are allowlisted as region shorthands in REGION_OR_SERVER_ZONE_WORDS
const POLITICAL_EXTRA_WORDS = new Set(['states', 'nato', 'un', 'sanctions', 'invasion', 'regime']);
// Single-word religion/identity terms so posting e.g. "church", "muslims", "jews" triggers (even if not in words.txt)
const RELIGION_SINGLE_WORDS = new Set([
  'church', 'christ', 'jesus', 'god', 'allah', 'prayer', 'pray', 'mosque', 'bible', 'quran', 'holy', 'religious', 'religion',
  'muslim', 'muslims', 'islam', 'islamic', 'jew', 'jews', 'jewish', 'judaism', 'christian', 'christians',
].map(w => w.toLowerCase()));

// Far-left / far-right and polarized ideological terms – views not generally discussed in gv-general (forward to off-topic)
// Ref: far-left (communism, Marxism, anarchism, revolutionary socialism, anti-capitalism); far-right (fascism, Nazism, supremacism, ethnonationalism, nativism)
const IDEOLOGICAL_TERMS = new Set([
  'communism', 'communist', 'marxism', 'marxist', 'marx', 'anarchism', 'anarchist', 'socialism', 'socialist',
  'anti-capitalism', 'anticapitalism', 'anti-capitalist', 'neoliberalism', 'neoliberal', 'revolution', 'revolutionary',
  'proletariat', 'bourgeoisie', 'capitalism', 'capitalist', 'leftist', 'leftism', 'tankie', 'tankies',
  'fascism', 'fascist', 'fascists', 'nazism', 'nazi', 'nazis', 'neo-nazi', 'neo-nazis', 'neonazi', 'neonazis',
  'supremacist', 'supremacism', 'white supremacy', 'white supremacist', 'ethnonationalism', 'nativism', 'nativist',
  'xenophobia', 'xenophobic', 'authoritarianism', 'authoritarian', 'ultranationalism', 'reactionary',
  'redpilled', 'redpill', 'bluepilled', 'bluepill', 'blackpilled', 'blackpill', 'libtard',
  // 'based' / 'woke' omitted — common slang; false positives on "woke up the cat", etc.
  'antifa', 'boogaloo', 'white privilege', 'race-baiting', 'big lie', 'conspiracy theorist', 'freethinker',
  'gerrymandering', 'globalist', 'globalism', 'illiberal', 'illiberalism', 'identity politics',
  'cultural marxism', 'cultural marxist', 'critical theory', 'postmodern', 'postmodernism',
].map(w => w.toLowerCase()));
// Multi-word ideological phrases (message contains these → count as trigger context)
const IDEOLOGICAL_PHRASES = [
  'far left', 'far right', 'far-left', 'far-right', 'extreme left', 'extreme right', 'alt right', 'alt-left',
  'white privilege', 'cultural marxism', 'identity politics', 'critical race', 'great replacement',
  'red pill', 'blue pill', 'black pill',
].map(p => p.toLowerCase());

function isPoliticalOrReligionTerm(word) {
  if (!word) return false;
  const w = word.toLowerCase();
  if (REGION_OR_SERVER_ZONE_WORDS.has(w)) return false;
  if (POLITICAL_EXTRA_WORDS.has(w)) return true;
  if (POLITICAL_COUNTRIES.has(w)) return true;
  if (IDEOLOGICAL_TERMS.has(w)) return true;
  if (RELIGION_SINGLE_WORDS.has(w)) return true;
  for (const leader of POLITICAL_LEADERS) {
    // Short leader names (e.g. "xi") must match as whole word only — avoids YouTube IDs like "XXI" or "v=...xi..." false positives
    if (leader.length <= 3) {
      const re = new RegExp('(^|[^a-z0-9])' + leader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
      if (re.test(w)) return true;
      continue;
    }
    if (w.includes(leader)) return true;
    // Only match word-as-substring-of-leader when word is at least 3 chars (avoid "i", "in", "an" matching "putin", "bin salman", etc.)
    if (w.length >= 3 && leader.includes(w)) return true;
  }
  return false;
}

// Languages / demonyms that also appear in politics filter — safe when clearly "speak/write/learn …" (not geopolitics)
const LANGUAGE_LEXICON_EXTRA = [
  'english', 'korean', 'japanese', 'spanish', 'italian', 'portuguese', 'arabic', 'hindi', 'urdu', 'latin', 'greek',
  'norwegian', 'danish', 'finnish', 'swedish', 'dutch', 'polish', 'czech', 'slovak', 'hungarian', 'romanian', 'bulgarian',
  'serbian', 'croatian', 'bosnian', 'slovenian', 'albanian', 'macedonian', 'lithuanian', 'latvian', 'estonian', 'icelandic',
  'welsh', 'scottish', 'gaelic', 'catalan', 'basque', 'galician', 'maltese', 'hebrew', 'farsi', 'mandarin', 'cantonese',
  'hokkien', 'shanghainese', 'vietnamese', 'thai', 'khmer', 'lao', 'burmese', 'tagalog', 'malay', 'indonesian', 'swahili',
  'zulu', 'afrikaans', 'punjabi', 'bengali', 'tamil', 'telugu', 'marathi', 'gujarati', 'nepali', 'sinhala', 'sinhalese',
  'kurdish', 'pashto', 'mongolian', 'quechua', 'esperanto', 'ukrainian', 'belarusian', 'georgian', 'armenian', 'azerbaijani',
  'kazakh', 'uzbek', 'tajik', 'turkmen', 'tibetan', 'dzongkha', 'persian', 'palestinian', 'somali', 'amharic', 'yoruba',
  'igbo', 'hausa', 'xhosa', 'maori', 'samoan', 'tongan', 'hawaiian', 'inuktitut', 'greenlandic', 'faroese',
  // demonyms often used as "I speak X"
  'mexican', 'brazilian', 'colombian', 'filipino', 'filipina', 'egyptian', 'turkish', 'russian', 'chinese', 'irish',
  'american', 'british', 'french', 'german', 'italian', 'spanish', 'japanese', 'korean', 'indian', 'pakistani',
  'bangladeshi', 'sri lankan', 'nigerian', 'kenyan', 'ethiopian', 'moroccan', 'algerian', 'tunisian', 'libyan',
  'cuban', 'venezuelan', 'peruvian', 'argentinian', 'chilean', 'ecuadorian', 'guatemalan', 'honduran', 'nicaraguan',
  'costa rican', 'panamanian', 'dominican', 'jamaican', 'haitian', 'puerto rican', 'canadian', 'australian', 'new zealander',
  'austrian', 'swiss', 'belgian', 'luxembourgish', 'liechtenstein', 'moldovan', 'slovakian', 'montenegrin', 'kosovar',
].map(w => w.toLowerCase());
const ALL_LANGUAGE_LEXICON = new Set([...POLITICAL_COUNTRIES, ...LANGUAGE_LEXICON_EXTRA]);
const LANGUAGE_VERB_PREFIXES = [
  'speak', 'speaks', 'speaking', 'spoken',
  'write', 'writes', 'writing', 'wrote', 'written',
  'read', 'reads', 'reading',
  'learn', 'learning', 'learned', 'learnt',
  'study', 'studying', 'studied',
  'practice', 'practices', 'practicing', 'practising', 'practiced', 'practised',
  'translate', 'translating', 'translated',
  'understand', 'understands', 'understanding', 'understood',
  'talk', 'talks', 'talking', 'talked',
  'type', 'types', 'typing', 'typed',
];
const LANGUAGE_IN_VERB_RE = /\b(write|read|speak|talk|say|said|saying|text|message|typed|typing|posted|post|chat|chats|chatting|communicate|communicates|communicating)\b/i;

function hasLanguageLearningContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const lang of ALL_LANGUAGE_LEXICON) {
    if (!lang || lang.length < 2) continue;
    for (const v of LANGUAGE_VERB_PREFIXES) {
      if (lower.includes(`${v} ${lang}`)) return true;
      if (lower.includes(`${v} in ${lang}`)) return true;
    }
    if (
      lower.includes(`fluent in ${lang}`)
      || lower.includes(`bilingual in ${lang}`)
      || lower.includes(`trilingual in ${lang}`)
      || lower.includes(`multilingual in ${lang}`)
    ) {
      return true;
    }
    if (
      lower.includes(`${lang} speaker`)
      || lower.includes(`${lang} native`)
      || lower.includes(`native ${lang}`)
      || lower.includes(`${lang}-speaking`)
    ) {
      return true;
    }
    // "posted in french", "message in german" — language of communication
    if (lower.includes(` in ${lang}`) && LANGUAGE_IN_VERB_RE.test(lower)) return true;
  }
  // Meme / juxtaposition: "cat french speak german" (two language demonyms + speak)
  if (/\b(french|german|spanish|italian|english|russian|polish|swedish|norwegian|danish|dutch|japanese|korean|chinese|arabic|portuguese)\b.*\b(speak|speaks|speaking)\b.*\b(french|german|spanish|italian|english|russian|polish|swedish|norwegian|danish|dutch|japanese|korean|chinese|arabic|portuguese)\b/.test(lower)) {
    return true;
  }
  return false;
}

// If message contains any safe-context word (game/community talk), don't trigger
function hasSafeContext(text) {
  if (!text || typeof text !== 'string') return false;
  if (hasLanguageLearningContext(text)) return true;
  const lower = text.toLowerCase();
  for (const word of SAFE_CONTEXT_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

function messageContainsIdeologicalPhrase(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return IDEOLOGICAL_PHRASES.some(p => lower.includes(p));
}

// Obvious religion/politics phrases – trigger even if 80% word ratio isn't met
const RELIGION_POLITICS_PHRASES = [
  'go to church', 'go to the church', 'become a christ', 'motherfucking christ', 'holy motherfucking',
  'pakistan iran', 'iran israel', 'pakistan israel', 'are states', 'israel are', 'iran are', 'pakistan are',
  'killing muslims', 'killing jews', 'kill muslims', 'kill jews', 'killing christians', 'muslims is based', 'jews is based',
  // Geopolitical / middle east / current events – redirect to off-topic
  'middle east', 'middleeast', 'geopolitical', 'geopolitical climate', 'current events', 'current events in the middle east',
  'current events in middle east', 'current events occurring', 'events in the middle east', 'events in middle east',
  'what do you think about religion', 'thoughts on religion', 'questions about religion', 'opinions on religion',
  'what about religion', 'discuss religion', 'religion and politics', 'politics and religion',
  // Single-word ideological (nazi/fascist etc.) – trigger even when only one word in message (no 80% ratio needed)
  'nazi', 'nazis', 'nazism', 'neo-nazi', 'fascist', 'fascism',
  // Real-world genocide / AI harm (not in-game "kill a nation") – redirect to off-topic
  'genocide plan', 'genocide',
  // Directed threats / "wage war against you" – redirect to off-topic (in-game "wage war" often has siege/guild/nations = safe-context)
  'wage war against you', 'wage war against',
].map(p => p.toLowerCase());
function messageContainsReligionPoliticsPhrase(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return RELIGION_POLITICS_PHRASES.some(p => lower.includes(p));
}

// Combined: should we treat message as religion/politics (ratio, ideological phrase, or obvious religion/politics phrase)
function shouldTriggerReligionPolitics(text) {
  if (!text || typeof text !== 'string') return false;
  return isMostlyReligionPolitics(text) || messageContainsIdeologicalPhrase(text) || messageContainsReligionPoliticsPhrase(text);
}

// Religion/politics: trigger if ≥80% of words are filter words. Min 1 word so single-word posts (e.g. "Pakistan", "church") trigger
const RELIGION_POLITICS_RATIO = Math.min(1, Math.max(0.5, parseFloat(process.env.RELIGION_POLITICS_RATIO) || 0.8));
const RELIGION_POLITICS_MIN_WORDS = Math.max(1, parseInt(process.env.RELIGION_POLITICS_MIN_WORDS, 10) || 1);

function tokenizeWords(text) {
  if (!text || typeof text !== 'string') return [];
  return stripEmojis(text)
    .split(/\s+/)
    .map(w => w.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, '').toLowerCase())
    .filter(w => w.length > 0);
}

// gv-general: allow region / ping-bucket shorthands (not geopolitical discussion)
const REGION_OR_SERVER_ZONE_WORDS = new Set([
  'na', 'eu', 'asia', 'sea', 'au', 'oce', 'oceania', 'apac', 'emea', 'latam', 'americas', 'gcc', 'mena', 'cis',
  'kr', 'jp', 'cn', 'tw', 'hk', 'sg', 'ph', 'th', 'vn', 'id', 'my', 'nz',
].map(w => w.toLowerCase()));
// Never count these as religion/politics trigger words (common words / game terms that match leaders or lists by substring)
const TRIGGER_WORD_IGNORE = new Set([...['good', 'goods', 'mod', 'mods'].map(w => w.toLowerCase()), ...REGION_OR_SERVER_ZONE_WORDS]);
function wordMatchesTriggerWord(word) {
  if (!word) return false;
  if (TRIGGER_WORD_IGNORE.has(word.toLowerCase())) return false;
  if (isPoliticalOrReligionTerm(word)) return true;
  const normalized = normalizeForMatch(word);
  for (const tw of triggerWords) {
    const re = new RegExp('^' + escapeRegex(tw) + '$', 'i');
    if (re.test(word)) return true;
    const wordNorm = normalizeForMatch(tw);
    const reNorm = new RegExp('^' + escapeRegex(wordNorm) + '$', 'i');
    if (reNorm.test(normalized)) return true;
  }
  return false;
}

function wordContainsGoy(word) {
  if (!word) return false;
  const lower = word.toLowerCase();
  return GOY_TERMS.some(term => lower.includes(term));
}

/** Returns true if message is mostly (≥80%) trigger words, or has ≥2 trigger words (catches e.g. "killing Muslims is based"). */
function isMostlyReligionPolitics(text) {
  const words = tokenizeWords(text);
  if (words.length < RELIGION_POLITICS_MIN_WORDS) return false;
  let triggerCount = 0;
  for (const w of words) {
    if (wordMatchesTriggerWord(w) || wordContainsGoy(w)) triggerCount++;
  }
  const ratio = triggerCount / words.length;
  const minTriggerWords = Math.max(2, parseInt(process.env.RELIGION_POLITICS_MIN_TRIGGER_WORDS, 10) || 2);
  return ratio >= RELIGION_POLITICS_RATIO || (triggerCount >= minTriggerWords && words.length >= 2);
}

// Check if message is asking about game/servers/ETA (triggers "Soon" emoji reaction)
// Single-word phrases use word-boundary so "game" doesn't trigger on "games" / "windows games" / compatibility questions
// "tomorrow" / "tomorrow..." trigger only when the whole message is just that (no other words)
function hasSoonTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  // Standalone-only: "tomorrow", "tomorrow...", "tomorrow?" etc. — not inside other sentences
  if (/^tomorrow[.?\s]*$/.test(lower)) return true;
  return SOON_TRIGGER_PHRASES.some(phrase => {
    if (phrase.includes(' ')) return lower.includes(phrase);
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b', 'i').test(lower);
  });
}

// "Where is Miaow?" / "Miaow is missing?" – reply with Emperor role ping + random image (base phrases + ? ! !? variants)
const MIAOW_WHERE_BASES = [
  'where is miaow', "where's miaow", 'miaow is missing', 'miaow missing',
  'where did miaow', 'where has miaow', 'wheres miaow', 'where miaow',
  'is miaow missing', 'is miaow here', 'miaow where', 'anyone seen miaow',
  'where did miaow go', 'miaow gone', 'what happened to miaow',
];
const MIAOW_WHERE_PHRASES = [
  ...MIAOW_WHERE_BASES,
  ...MIAOW_WHERE_BASES.map(b => b + '?'),
  ...MIAOW_WHERE_BASES.map(b => b + '!'),
  ...MIAOW_WHERE_BASES.map(b => b + '!?'),
].map(p => p.toLowerCase());
function hasMiaowWhereTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  if (!lower.includes('miaow')) return false;
  return MIAOW_WHERE_PHRASES.some(phrase => lower.includes(phrase));
}

// Get video attachment or URL for spam reply (returns { files } or { content } for message.reply). Prefer local file when present so Discord embeds inline.
function getSpamVideoPayload() {
  const path = VIDEO_PATH;
  if (path && fs.existsSync(path)) {
    return { files: [{ attachment: path, name: 'TMFIAR.mp4' }] };
  }
  if (VIDEO_URL) return { content: VIDEO_URL };
  return { content: '(Video not configured: set VIDEO_PATH or VIDEO_URL, or add assets/TMFIAR.mp4)' };
}

function loadCsamGroomingTriggerLines() {
  try {
    const fp = CSAM_GROOMING_WORDS_FILE;
    if (!fs.existsSync(fp)) {
      console.warn(`[csam-triggers] File not found: ${fp}`);
      return [];
    }
    const raw = fs.readFileSync(fp, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => {
        const i = l.indexOf('#');
        const line = (i >= 0 ? l.slice(0, i) : l).trim().toLowerCase();
        return line;
      })
      .filter(Boolean);
  } catch (e) {
    console.error('[csam-triggers] Load failed:', e.message);
    return [];
  }
}
const csamGroomingTriggers = loadCsamGroomingTriggerLines();
console.log(`[csam-triggers] Loaded ${csamGroomingTriggers.length} lines from ${CSAM_GROOMING_WORDS_FILE}`);

/** Phrases (space/hyphen) use substring + normalized match; single tokens use word boundaries to cut false positives. */
function hasCsamGroomingTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const cleaned = stripEmojis(text);
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  const normalized = normalizeForMatch(lower);
  for (const term of csamGroomingTriggers) {
    if (!term) continue;
    if (term.includes(' ') || term.includes('-')) {
      const tn = normalizeForMatch(term);
      if (lower.includes(term) || normalized.includes(tn)) return true;
      continue;
    }
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    if (re.test(lower)) return true;
    const tn = normalizeForMatch(term);
    if (tn !== term) {
      const reN = new RegExp(`\\b${escapeRegex(tn)}\\b`, 'i');
      if (reN.test(normalized)) return true;
    }
  }
  return false;
}

function getMessageTextForCsamScan(message) {
  let t = message.content ? String(message.content) : '';
  if (message.attachments?.size) {
    for (const a of message.attachments.values()) {
      if (a.name) t += ` ${a.name}`;
    }
  }
  return t.trim();
}

/** Delete in gv-general, post to hold with TMFIAR + tag author; edit post when they react ✅ (no Chronicus meme). */
async function deleteInGeneralAndForwardCsamAck(message) {
  try {
    await message.delete();
  } catch (err) {
    console.error('[csam-hold] Could not delete message in gv-general:', err.message);
  }
  let holdChannel;
  try {
    holdChannel = await message.client.channels.fetch(MOVED_BY_BOT_CHANNEL_ID);
  } catch (e) {
    console.error('[csam-hold] Hold channel fetch failed:', e.message);
    return;
  }
  if (!holdChannel?.isTextBased()) return;
  const raw = message.content ? String(message.content).trim() : '';
  const movedText = raw ? raw.slice(0, 1200) + (raw.length > 1200 ? '…' : '') : '(no text)';
  const mention = message.author.toString();
  const videoPayload = getSpamVideoPayload();
  const instruction = `**React with ${CSAM_ACK_EMOJI} once** on this message so we know you saw this. Your post was removed from <#${TRIGGER_CHANNEL_ID}>.\nIf discussion belongs elsewhere, use <#${REDIRECT_CHANNEL_ID}>.`;
  const lines = [
    `${mention} — **Policy hold** (automated move from <#${TRIGGER_CHANNEL_ID}>):`,
    movedText,
    instruction,
  ];
  let content = lines.join('\n\n');
  if (videoPayload.content && !videoPayload.files?.length) {
    content += `\n\n${videoPayload.content}`;
  }
  if (content.length > 2000) content = `${content.slice(0, 1997)}…`;
  const files = videoPayload.files?.length ? videoPayload.files : undefined;
  let sent;
  try {
    sent = await holdChannel.send({
      content,
      files,
      allowedMentions: { users: [message.author.id] },
    });
  } catch (err) {
    console.error('[csam-hold] Send to hold channel failed:', err);
    return;
  }
  const ackFilter = (reaction, user) =>
    user.id === message.author.id && !user.bot && reaction.emoji.name === CSAM_ACK_EMOJI;
  const collector = sent.createReactionCollector({ filter: ackFilter, max: 1, time: CSAM_ACK_COLLECTOR_MS });
  collector.on('collect', async () => {
    try {
      const append = `\n\n— ${mention} acknowledged ${CSAM_ACK_EMOJI}.`;
      const base = sent.content || '';
      const next = base + append;
      if (next.length <= 2000) {
        await sent.edit({ content: next });
      } else {
        await sent.reply({
          content: `— ${mention} acknowledged ${CSAM_ACK_EMOJI}.`,
          allowedMentions: { users: [message.author.id] },
        });
      }
    } catch (e) {
      if (DEBUG) console.warn('[csam-hold] Ack edit failed:', e.message);
    }
  });
}

// Download a URL to a local file (for off-topic → gv-general so we upload fresh files instead of reusing Discord URLs that break after delete)
async function downloadUrlToFile(url, filePath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'DiscordBot (GV-LegacyGeneralMod)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// Exclude specific users from message deletion and meme/GIF reply (e.g. admin with "Savage"/"unban" in name). They still get :soon: etc.; we just never delete their msg or post Chronicus/GIF.
function isExcludedFromDeleteAndMeme(message) {
  const name = [
    message.author?.username,
    message.author?.globalName,
    message.member?.displayName,
  ].filter(Boolean).join(' ').toLowerCase();
  return /savage|unban/.test(name);
}

/** True if message text/embeds/attachments reference a blocked Tenor/GIF id (substring match). */
function messageHasBlockedMediaId(message) {
  if (!BLOCKED_MEDIA_IDS.length) return false;
  const parts = [];
  if (message.content) parts.push(message.content);
  for (const e of message.embeds || []) {
    if (e.url) parts.push(e.url);
    if (e.thumbnail?.url) parts.push(e.thumbnail.url);
    if (e.image?.url) parts.push(e.image.url);
    if (e.video?.url) parts.push(e.video.url);
  }
  for (const a of message.attachments?.values() || []) {
    if (a.name) parts.push(a.name);
    if (a.url) parts.push(a.url);
  }
  const blob = parts.join(' ');
  return BLOCKED_MEDIA_IDS.some((id) => blob.includes(id));
}

// gv-general only: watch one user — same text 3+ times, or 11+ messages in rolling window, or paste-wall → redirect;
// DM (French) when ≥10 strikes in 5 min OR ≥50 strikes in 1 h; if DM fails, ping in #miaow (French).
// Also: ≥10 posts in 5 min in gv-general → delete each + repost to SPAM_WATCH_MIAOW_CHANNEL_ID (volume flush).
const SPAM_WATCH_USER_ID = String(process.env.SPAM_WATCH_USER_ID || '1409669933801144453');
const SPAM_WATCH_MIAOW_CHANNEL_ID = String(process.env.SPAM_WATCH_MIAOW_CHANNEL_ID || '1168970870287503412');
const SPAM_WATCH_GV_VOLUME_WINDOW_MS = Math.max(60_000, parseInt(process.env.SPAM_WATCH_GV_VOLUME_WINDOW_MS || String(5 * 60 * 1000), 10));
const SPAM_WATCH_GV_VOLUME_THRESHOLD = Math.max(2, parseInt(process.env.SPAM_WATCH_GV_VOLUME_THRESHOLD || '10', 10));
const SPAM_WATCH_STRIKES_FILE = path.join(process.cwd(), 'spam-watch-strikes.json');
const SPAM_WATCH_VOLUME_WINDOW_MS = Math.max(60_000, parseInt(process.env.SPAM_WATCH_VOLUME_WINDOW_MS || String(60 * 60 * 1000), 10)); // default 1h
const SPAM_WATCH_CONTENT_COUNT_MAX_KEYS = 120;
const SPAM_WATCH_DM_WINDOW_5MIN_MS = Math.max(60_000, parseInt(process.env.SPAM_WATCH_DM_WINDOW_5MIN_MS || String(5 * 60 * 1000), 10));
const SPAM_WATCH_DM_WINDOW_1H_MS = Math.max(5 * 60_000, parseInt(process.env.SPAM_WATCH_DM_WINDOW_1H_MS || String(60 * 60 * 1000), 10));
const SPAM_WATCH_DM_THRESHOLD_5MIN = Math.max(1, parseInt(process.env.SPAM_WATCH_DM_THRESHOLD_5MIN || '10', 10));
const SPAM_WATCH_DM_THRESHOLD_1H = Math.max(1, parseInt(process.env.SPAM_WATCH_DM_THRESHOLD_1H || '50', 10));

function normalizeSpamContent(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Same block repeated 3+ times in one message (with or without spaces between copies). */
function looksLikeInMessageRepeatSpam(text) {
  const raw = String(text || '');
  if (raw.length < 36) return false;
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (compact.length >= 30 && /(.{12,100})(\1){2,}/.test(compact)) return true;
  const spaced = normalizeSpamContent(raw);
  if (spaced.length >= 30 && /(.{15,80})(\1){2,}/.test(spaced)) return true;
  return false;
}

function loadSpamWatchState() {
  try {
    if (fs.existsSync(SPAM_WATCH_STRIKES_FILE)) {
      const data = JSON.parse(fs.readFileSync(SPAM_WATCH_STRIKES_FILE, 'utf8'));
      if (data && (Array.isArray(data.strikeTimes) || typeof data.strikes === 'number')) {
        return {
          strikeTimes: Array.isArray(data.strikeTimes) ? data.strikeTimes : [],
          contentCounts: data.contentCounts && typeof data.contentCounts === 'object' ? data.contentCounts : {},
          recentMessageTimes: Array.isArray(data.recentMessageTimes) ? data.recentMessageTimes : [],
          gvVolumeRecent: Array.isArray(data.gvVolumeRecent) ? data.gvVolumeRecent : [],
        };
      }
    }
  } catch (e) {
    console.warn('spam-watch load failed:', e.message);
  }
  return { strikeTimes: [], contentCounts: {}, recentMessageTimes: [], gvVolumeRecent: [] };
}

function saveSpamWatchState(state) {
  try {
    fs.writeFileSync(SPAM_WATCH_STRIKES_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('spam-watch save failed:', e.message);
  }
}

function spamContentKey(norm) {
  const s = norm.slice(0, 500);
  return s.length < norm.length ? `${s}…` : s;
}

function pruneSpamContentCounts(counts) {
  const keys = Object.keys(counts);
  if (keys.length <= SPAM_WATCH_CONTENT_COUNT_MAX_KEYS) return counts;
  const sorted = [...keys].sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
  const next = { ...counts };
  for (let i = 0; i < keys.length - SPAM_WATCH_CONTENT_COUNT_MAX_KEYS; i++) {
    delete next[sorted[i]];
  }
  return next;
}

async function sendSpamWatchMiaowDmFallback(client) {
  const french = [
    `<@${SPAM_WATCH_USER_ID}> — je n’ai pas pu t’envoyer de message privé (DM fermés ou bloqués).`,
    `Merci de continuer ce genre de messages ici : <#${SPAM_WATCH_MIAOW_CHANNEL_ID}> — pas dans <#${TRIGGER_CHANNEL_ID}>.`,
    `Le salon **miaow** est fait pour ça ; gv-general n’est pas un mur de spam.`,
  ].join('\n');
  try {
    const ch = await client.channels.fetch(SPAM_WATCH_MIAOW_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ content: french });
  } catch (e) {
    console.error('spam-watch miaow fallback channel failed:', e.message);
  }
}

/** Download attachments, post to #miaow, then delete from gv-general (Discord CDN URLs expire after delete). */
async function deleteAndRepostSpamWatchToMiaow(message) {
  const dest = await message.client.channels.fetch(SPAM_WATCH_MIAOW_CHANNEL_ID).catch(() => null);
  if (!dest?.isTextBased()) return;
  const raw = message.content ? String(message.content).trim() : '';
  const text = raw ? raw.slice(0, 1900) + (raw.length > 1900 ? '…' : '') : '(no text)';
  const files = [];
  if (message.attachments?.size) {
    const dir = FORWARDED_MEDIA_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let idx = 0;
    for (const att of message.attachments.values()) {
      const ext = path.extname(att.name || '') || '.bin';
      const safeName = (att.name || `file${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const localPath = path.join(dir, `swvol_${message.id}_${idx}_${safeName}`);
      try {
        await downloadUrlToFile(att.url, localPath);
        files.push({ attachment: localPath, name: safeName });
      } catch (e) {
        if (DEBUG) console.warn('[spam-watch-volume] attachment download failed:', e.message);
      }
      idx++;
    }
  }
  const content = [`${message.author} — moved from <#${TRIGGER_CHANNEL_ID}> (${SPAM_WATCH_GV_VOLUME_THRESHOLD}+ posts / ${Math.round(SPAM_WATCH_GV_VOLUME_WINDOW_MS / 60000)} min):`, text].join('\n\n');
  try {
    await dest.send({
      content,
      files: files.length ? files : undefined,
      allowedMentions: { users: [message.author.id] },
    });
  } catch (e) {
    console.error('[spam-watch-volume] send failed:', e.message);
    return;
  }
  try {
    await message.delete();
  } catch (e) {
    console.error('[spam-watch-volume] delete failed:', e.message);
  }
}

/**
 * Track all gv-general messages from spam-watch user; when count ≥ threshold in rolling window, move oldest batch to #miaow.
 * @returns {Promise<boolean>} true if this turn flushed (caller should return)
 */
async function handleSpamWatchVolumeFlush(message) {
  if (String(message.author.id) !== SPAM_WATCH_USER_ID) return false;
  const state = loadSpamWatchState();
  const now = Date.now();
  state.gvVolumeRecent = (state.gvVolumeRecent || []).filter((e) => now - e.ts < SPAM_WATCH_GV_VOLUME_WINDOW_MS);
  state.gvVolumeRecent.push({ id: message.id, ts: now });
  if (state.gvVolumeRecent.length < SPAM_WATCH_GV_VOLUME_THRESHOLD) {
    saveSpamWatchState(state);
    return false;
  }
  state.gvVolumeRecent.sort((a, b) => a.ts - b.ts);
  const batch = state.gvVolumeRecent.splice(0, SPAM_WATCH_GV_VOLUME_THRESHOLD);
  saveSpamWatchState(state);

  const channel = message.channel;
  for (const { id } of batch) {
    const m = id === message.id ? message : await channel.messages.fetch(id).catch(() => null);
    if (m) await deleteAndRepostSpamWatchToMiaow(m);
  }
  if (DEBUG) {
    console.log(`[spam-watch-volume] Flushed ${batch.length} message(s) to <#${SPAM_WATCH_MIAOW_CHANNEL_ID}>`);
  }
  return true;
}

/** @returns {Promise<boolean>} true if handled (caller should return) */
async function handleSpamWatchUser(message) {
  if (String(message.author.id) !== SPAM_WATCH_USER_ID) return false;
  const norm = normalizeSpamContent(message.content);
  if (!norm) return false;

  const now = Date.now();
  const state = loadSpamWatchState();
  state.recentMessageTimes = (state.recentMessageTimes || []).filter((t) => now - t < SPAM_WATCH_VOLUME_WINDOW_MS);
  state.recentMessageTimes.push(now);

  const key = spamContentKey(norm);
  state.contentCounts = pruneSpamContentCounts(state.contentCounts || {});
  state.contentCounts[key] = (state.contentCounts[key] || 0) + 1;

  const sameTextSpam = state.contentCounts[key] >= 3;
  const volumeSpam = state.recentMessageTimes.length > 10;
  const wallSpam = looksLikeInMessageRepeatSpam(message.content);
  const isSpam = sameTextSpam || volumeSpam || wallSpam;

  if (!isSpam) {
    saveSpamWatchState(state);
    return false;
  }

  state.strikeTimes = (state.strikeTimes || []).filter((t) => now - t < SPAM_WATCH_DM_WINDOW_1H_MS);
  const before5 = state.strikeTimes.filter((t) => now - t <= SPAM_WATCH_DM_WINDOW_5MIN_MS).length;
  const before1h = state.strikeTimes.length;
  state.strikeTimes.push(now);
  const after5 = state.strikeTimes.filter((t) => now - t <= SPAM_WATCH_DM_WINDOW_5MIN_MS).length;
  const after1h = state.strikeTimes.length;

  const crossDm5 = before5 < SPAM_WATCH_DM_THRESHOLD_5MIN && after5 >= SPAM_WATCH_DM_THRESHOLD_5MIN;
  const crossDm1h = before1h < SPAM_WATCH_DM_THRESHOLD_1H && after1h >= SPAM_WATCH_DM_THRESHOLD_1H;
  const shouldTryDm = crossDm5 || crossDm1h;

  saveSpamWatchState(state);

  const why = [];
  if (sameTextSpam) why.push('même texte ≥3×');
  if (volumeSpam) why.push(`>10 messages en ${Math.round(SPAM_WATCH_VOLUME_WINDOW_MS / 60000)} min`);
  if (wallSpam) why.push('copier-coller répété');

  try {
    await message.reply({
      content: [
        `${message.author} — Merci de ne pas spammer <#${TRIGGER_CHANNEL_ID}>.`,
        `Va plutôt sur <#${SPAM_WATCH_MIAOW_CHANNEL_ID}> (ou <#${REDIRECT_CHANNEL_ID}>).`,
        `(${why.join(' · ')})`,
      ].join('\n'),
    });
  } catch (e) {
    console.error('spam-watch reply failed:', e.message);
  }

  if (shouldTryDm) {
    const dmBody = crossDm5
      ? [
          `Tu as atteint **${SPAM_WATCH_DM_THRESHOLD_5MIN}** réponses spam en moins de **5 minutes** depuis <#${TRIGGER_CHANNEL_ID}>.`,
          `Passe sur <#${SPAM_WATCH_MIAOW_CHANNEL_ID}> ou <#${REDIRECT_CHANNEL_ID}>.`,
        ].join('\n')
      : [
          `Tu as atteint **${SPAM_WATCH_DM_THRESHOLD_1H}** réponses spam en **1 heure** depuis <#${TRIGGER_CHANNEL_ID}>.`,
          `Passe sur <#${SPAM_WATCH_MIAOW_CHANNEL_ID}> ou <#${REDIRECT_CHANNEL_ID}>.`,
        ].join('\n');
    try {
      await message.author.send({ content: dmBody });
    } catch (e) {
      if (DEBUG) console.warn('[spam-watch] DM failed:', e.message);
      await sendSpamWatchMiaowDmFallback(message.client);
    }
  }

  if (DEBUG) {
    console.log(
      `[spam-watch] strikes 5min=${after5} 1h=${after1h} for ${message.author.tag} same=${sameTextSpam} vol=${volumeSpam} wall=${wallSpam}`,
    );
  }
  return true;
}

// Delete message in gv-general, repost to MOVED_BY_BOT_CHANNEL (hold/archive), still tell user to continue in #off-topic; then Chronicus in gv-general links off-topic
// gifOrVideoPayload: string (GIF/video URL) OR { content?: string, files?: Array } so video can be sent as attachment for proper Discord embed
async function deleteInGeneralAndForwardMovedHold(message, gifOrVideoPayload) {
  try {
    await message.delete();
  } catch (err) {
    console.error('Could not delete message in gv-general (need Manage Messages):', err.message);
  }
  try {
    const channel = await message.client.channels.fetch(MOVED_BY_BOT_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    const raw = message.content ? String(message.content).trim() : '';
    const movedText = raw ? raw.slice(0, 1500) + (raw.length > 1500 ? '…' : '') : '(no text)';
    const isPayload = gifOrVideoPayload && typeof gifOrVideoPayload === 'object' && !Array.isArray(gifOrVideoPayload);
    const hasFiles = isPayload && gifOrVideoPayload.files?.length;
    const gifOrUrl = hasFiles ? (gifOrVideoPayload.content || '') : (isPayload ? (gifOrVideoPayload.content || '') : String(gifOrVideoPayload || ''));
    // Hold channel = where the post lands; redirect line still points to #off-topic for real discussion
    const lines = [
      `${message.author.toString()} — moved from <#${TRIGGER_CHANNEL_ID}> by bot:`,
      movedText,
      `Please continue in <#${REDIRECT_CHANNEL_ID}> instead.`,
    ];
    if (gifOrUrl) lines.push(gifOrUrl);
    const content = lines.join('\n\n');
    if (hasFiles) {
      await channel.send({ content, files: gifOrVideoPayload.files });
    } else {
      await channel.send({ content });
    }
  } catch (err) {
    console.error('Forward to moved-by-bot hold channel failed:', err);
  }
  try {
    const generalChannel = await message.client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (generalChannel?.isTextBased()) {
      const chronicusContent = `${message.author.toString()}\n\n<#${REDIRECT_CHANNEL_ID}>\n\n${getChronicusAnnouncementText()}`;
      const memePath = getRandomChronicusMeme();
      const payload = memePath
        ? { content: chronicusContent, files: [{ attachment: memePath, name: path.basename(memePath) }] }
        : { content: chronicusContent };
      await generalChannel.send(payload);
    }
  } catch (err) {
    console.error('Chronicus Generalium post failed:', err.message);
  }
}

// Welcome ONCE ever per UserID (persisted) — no second welcome on rejoin, role change, or role remove/re-add
const WELCOME_ONCE_EVER_FILE = path.join(process.cwd(), 'welcome-once-ever.json');
function loadWelcomeOnceEver() {
  try {
    if (fs.existsSync(WELCOME_ONCE_EVER_FILE)) {
      const data = JSON.parse(fs.readFileSync(WELCOME_ONCE_EVER_FILE, 'utf8'));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch (e) {
    console.warn('Welcome-once-ever load failed:', e.message);
  }
  return new Set();
}
function saveWelcomeOnceEver(set) {
  try {
    fs.writeFileSync(WELCOME_ONCE_EVER_FILE, JSON.stringify([...set], null, 0), 'utf8');
  } catch (e) {
    console.error('Welcome-once-ever save failed:', e.message);
  }
}
const welcomedOnceEver = loadWelcomeOnceEver();
// Track users we've already welcomed for picking a nation role (first-time only)
const welcomedForNationRoleByUser = new Set();
// User IDs we've already welcomed via guildMemberAdd (clear on leave so we re-welcome if they rejoin)
const welcomedUserIds = new Set();
// When the bot became ready — we only welcome users who joined *after* this (no scan/trigger for earlier joins)
let botReadyAt = 0;
function recordAdminWelcome(userId) {
  welcomedUserIds.add(userId);
  welcomedOnceEver.add(userId);
  saveWelcomeOnceEver(welcomedOnceEver);
}

// Slur reply tracking: first offense = GIF, repeated/spam = video. Entries reset after SLUR_TRACK_TTL_MS.
const SLUR_TRACK_TTL_MS = 60 * 60 * 1000; // 1 hour
const slurReplyByUser = new Map(); // userId -> { count: number, lastTs: number }
function isRepeatedSlurOffender(userId) {
  const now = Date.now();
  const entry = slurReplyByUser.get(userId);
  if (!entry) return false;
  if (now - entry.lastTs > SLUR_TRACK_TTL_MS) {
    slurReplyByUser.delete(userId);
    return false;
  }
  return entry.count >= 1; // already replied at least once in window → treat as repeated
}
function recordSlurReply(userId) {
  const now = Date.now();
  const entry = slurReplyByUser.get(userId) || { count: 0, lastTs: 0 };
  if (now - entry.lastTs > SLUR_TRACK_TTL_MS) entry.count = 0;
  entry.count++;
  entry.lastTs = now;
  slurReplyByUser.set(userId, entry);
}

// --- RSS feed: seen item IDs (persisted so we don't repost after restart) ---
function loadRssSeen() {
  try {
    if (fs.existsSync(RSS_SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(RSS_SEEN_FILE, 'utf8'));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch (e) {
    if (DEBUG) console.warn('RSS seen file load failed:', e.message);
  }
  return new Set();
}
function saveRssSeen(seen) {
  try {
    fs.writeFileSync(RSS_SEEN_FILE, JSON.stringify([...seen].slice(-500)), 'utf8'); // keep last 500
  } catch (e) {
    if (DEBUG) console.warn('RSS seen file save failed:', e.message);
  }
}
const rssSeen = loadRssSeen();
const rssParser = new Parser({ timeout: 15000 });
const RSS_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/',
};

// --- Discord bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for guildMemberAdd (enable "Server Members Intent" in Discord Developer Portal)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions, // CSAM hold: detect author's ✅ on bot message
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  // Prevent OOM on Render by limiting per-guild member caching.
  // discord.js can otherwise cache the full guild member list on connect.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    GuildMemberManager: {
      // Render free tier can OOM if the bot caches too many members.
      // Keep this very low; can override with GUILD_MEMBER_CACHE_MAX_SIZE if needed.
      maxSize: Math.max(1, parseInt(process.env.GUILD_MEMBER_CACHE_MAX_SIZE || '5', 10)),
      keepOverLimit: (member) => member.id === member.client.user.id, // always keep the bot's own member
    },
  }),
});

client.once('ready', () => {
  botReadyAt = Date.now();
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Trigger channel (gv-general): ${TRIGGER_CHANNEL_ID} — ensure Message Content Intent is ON in Developer Portal`);
  console.log(`Moved-from-general posts → <#${MOVED_BY_BOT_CHANNEL_ID}>; Chronicus still points to <#${REDIRECT_CHANNEL_ID}> (off-topic)`);
  console.log(`CSAM/grooming triggers: ${csamGroomingTriggers.length} lines → hold + TMFIAR + ${CSAM_ACK_EMOJI} ack (${CSAM_GROOMING_WORDS_FILE})`);
  console.log(`Welcomes in #new-arrivals (guildMemberAdd + first role); admin channel ignored for welcome`);
  console.log(`Welcome skip: accounts younger than ${WELCOME_MIN_ACCOUNT_AGE_DAYS} days (set WELCOME_MIN_ACCOUNT_AGE_DAYS=730 for 2 years)`);

  // RSS feed → announcement channel: Gloria Victis news only, from today forward (no old items)
  if (RSS_FEED_URL && ANNOUNCEMENT_CHANNEL_ID) {
    const startOfTodayUtc = () => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    };
    const isGloriaVictisItem = (item) => {
      const t = (item.title || '').toLowerCase();
      const l = (item.link || '').toLowerCase();
      return t.includes('gloria victis') || l.includes('gloria-victis');
    };
    const isFromTodayOrLater = (item) => {
      const pub = item.pubDate;
      if (!pub) return false;
      const ts = pub instanceof Date ? pub.getTime() : new Date(pub).getTime();
      return !Number.isNaN(ts) && ts >= startOfTodayUtc();
    };
    const runRssPoll = async () => {
      try {
        const res = await fetch(RSS_FEED_URL, { headers: RSS_FETCH_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          const host = (() => { try { return new URL(RSS_FEED_URL).host; } catch { return 'feed'; } })();
          throw new Error(`Status code ${res.status} from ${host} (feed server blocks request; Discord channel is fine)`);
        }
        const xml = await res.text();
        const feed = await rssParser.parseString(xml);
        const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
        if (!channel?.isTextBased()) return;
        let posted = 0;
        for (const item of feed.items || []) {
          if (!isGloriaVictisItem(item)) continue;
          if (!isFromTodayOrLater(item)) continue;
          const id = item.guid || item.link || item.title;
          if (!id || rssSeen.has(id)) continue;
          rssSeen.add(id);
          const title = item.title || 'News';
          const link = item.link || '';
          const snippet = (item.contentSnippet || item.content || '').slice(0, 300);
          const content = link ? `${title}\n${link}${snippet ? `\n${snippet}` : ''}` : title;
          await channel.send({ content: content.slice(0, 2000) });
          posted++;
          saveRssSeen(rssSeen);
        }
        if (DEBUG && posted > 0) console.log(`[rss] Posted ${posted} Gloria Victis item(s) to announcement channel`);
      } catch (err) {
        console.error('RSS poll failed:', err.message || err);
        // 403 = feed URL blocks requests from Render's IP. Try another RSS source or leave RSS_FEED_URL unset to disable.
      }
    };
    runRssPoll();
    setInterval(runRssPoll, RSS_POLL_INTERVAL_MS);
  }
});

// When a user joins the server, post the welcome video + user tag in #new-arrivals (skip if already welcomed on role to avoid double message)
// Welcome each UserID only ONCE ever (persisted); skip very new accounts (bot/alt filter)
client.on('guildMemberAdd', async (member) => {
  if (welcomedOnceEver.has(member.user.id)) return; // already welcomed once ever – never again
  if (welcomedUserIds.has(member.user.id)) return; // already welcomed on role this session – don't welcome again
  if (!shouldWelcomeAccountAge(member.user)) {
    if (DEBUG) console.log(`[new-arrival] Skipped welcome for ${member.user.tag} (account too new, < ${WELCOME_MIN_ACCOUNT_AGE_DAYS} days)`);
    return;
  }
  recordAdminWelcome(member.user.id); // record immediately to avoid race with guildMemberUpdate (both firing → double welcome)
  try {
    const channel = await client.channels.fetch(NEW_ARRIVALS_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(getWelcomeMessagePayload(member.user.toString()));
      if (DEBUG) console.log(`[new-arrival] Posted welcome for ${member.user.tag} in #new-arrivals`);
    } else {
      if (DEBUG) console.log(`[new-arrival] Channel ${NEW_ARRIVALS_CHANNEL_ID} not found or not text-based`);
    }
  } catch (err) {
    console.error('New-arrival welcome post failed:', err.message || err);
  }
});

// When a user leaves, clear in-memory session state only (welcomedOnceEver is persisted – we still never welcome them again)
client.on('guildMemberRemove', (member) => {
  welcomedUserIds.delete(member.id);
});

// When a new user picks one of the nation roles (or is given a role) for the first time: welcome in #new-arrivals (same as join). Skip if already welcomed on join to avoid double message.
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.roles.cache.size <= oldMember.roles.cache.size) return; // no role added
  const addedRoleIds = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const pickedNationRole = [...addedRoleIds.keys()].some(id => WELCOME_ROLE_IDS.has(id));
  if (!pickedNationRole) return;

  const userId = newMember.user.id;
  if (welcomedOnceEver.has(userId)) return; // already welcomed once ever – never again
  if (welcomedUserIds.has(userId)) return; // already welcomed on guildMemberAdd – don't welcome again (no double message)
  if (welcomedForNationRoleByUser.has(userId)) return; // already welcomed for a nation role this session (e.g. switching to another)
  if (!shouldWelcomeAccountAge(newMember.user)) return; // skip very new accounts (bot/alt filter)

  const joinedAt = newMember.joinedAt ? newMember.joinedAt.getTime() : 0;
  if (joinedAt === 0) return;
  // Only welcome if they joined after bot became active, OR joined within last 24h (catches join right before bot restart)
  const joinedWithin24h = Date.now() - joinedAt <= 24 * 60 * 60 * 1000;
  if (joinedAt < botReadyAt && !joinedWithin24h) return; // old member who just picked a role – skip

  welcomedForNationRoleByUser.add(userId);
  recordAdminWelcome(userId); // record immediately to avoid race with guildMemberAdd (both firing → double welcome)
  try {
    const channel = await client.channels.fetch(NEW_ARRIVALS_CHANNEL_ID);
    if (channel?.isTextBased()) {
      await channel.send(getWelcomeMessagePayload(newMember.user.toString()));
      if (DEBUG) console.log(`[role-assign] Welcome posted in #new-arrivals for ${newMember.user.tag}`);
    } else {
      if (DEBUG) console.log(`[role-assign] Channel ${NEW_ARRIVALS_CHANNEL_ID} not found or not text-based`);
    }
  } catch (err) {
    console.error('Role-assign welcome failed:', err.message || err);
    welcomedForNationRoleByUser.delete(userId); // allow retry
  }
});

client.on('messageCreate', async (message) => {
  // Never read or process DMs. Message Content Intent is required for gv-general only; we ignore all DM messages.
  if (!message.guild) return;

  const channelId = String(message.channelId);

  // Admin channel: ignore for welcome — we only welcome via guildMemberAdd (and role assign) so we never post on "Member left" from Carl-bot
  if (channelId === ADMIN_JOIN_CHANNEL_ID) {
    return; // don't run gv-general triggers for admin channel
  }

  if (message.author.bot) return; // from here on we only react to user messages in gv-general

  // Replace Israel flag tokens with :flag_ps: (delete original + repost in same channel)
  if (hasIsraelFlagToken(message.content)) {
    const replaced = replaceIsraelFlagWithPalestine(message.content).trim();
    const repost = replaced || FLAG_PS_REPLACEMENT;
    try {
      await message.delete();
    } catch (err) {
      console.error('Flag replace: could not delete original message:', err.message);
      return;
    }
    try {
      if (message.channel?.isTextBased()) {
        await message.channel.send({ content: `${message.author.toString()} ${repost}`.trim() });
      }
    } catch (err) {
      console.error('Flag replace: repost failed:', err.message);
    }
    return;
  }

  // Off-topic → gv-general: move this user's image/GIF/video/audio posts. Download to local folder first so we upload fresh files (Discord attachment URLs break after original message is deleted).
  if (OFFTOPIC_TO_GENERAL_USER_ID && channelId === REDIRECT_CHANNEL_ID && message.author.id === OFFTOPIC_TO_GENERAL_USER_ID && message.attachments?.size > 0) {
    const mediaAttachments = message.attachments.filter(
      a => IMAGE_CONTENT_TYPES.test(a.contentType || '') || VIDEO_CONTENT_TYPES.test(a.contentType || '') || /^audio\//.test(a.contentType || '') || IMAGE_EXTENSIONS.test(a.name || '') || FORWARDED_MEDIA_EXTENSIONS.test(a.name || '')
    );
    if (mediaAttachments.size > 0) {
      try {
        const dir = FORWARDED_MEDIA_DIR;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const localPaths = [];
        let idx = 0;
        for (const att of mediaAttachments.values()) {
          const ext = path.extname(att.name || '') || '.jpg';
          const safeName = (att.name || `file${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
          const localPath = path.join(dir, `${message.id}_${idx}_${safeName}`);
          await downloadUrlToFile(att.url, localPath);
          localPaths.push({ attachment: localPath, name: safeName });
          idx++;
        }
        const generalChannel = await message.client.channels.fetch(GV_GENERAL_CHANNEL_ID);
        if (generalChannel?.isTextBased()) {
          await generalChannel.send({ files: localPaths });
          if (DEBUG) console.log(`[offtopic→general] Moved ${localPaths.length} file(s) from ${message.author.tag} (saved to ${dir})`);
        }
        await message.delete();
      } catch (err) {
        console.error('Off-topic → gv-general move failed:', err);
      }
    }
    return;
  }

  if (channelId !== TRIGGER_CHANNEL_ID) {
    if (DEBUG) console.log(`[skip] channel ${channelId} !== ${TRIGGER_CHANNEL_ID}`);
    return; // only gv-general
  }

  const csamScanText = getMessageTextForCsamScan(message);
  if (csamScanText && hasCsamGroomingTrigger(csamScanText)) {
    if (DEBUG) console.log(`[csam-hold] Trigger for ${message.author.tag}`);
    await deleteInGeneralAndForwardCsamAck(message);
    return;
  }

  if (messageHasBlockedMediaId(message)) {
    if (!isExcludedFromDeleteAndMeme(message)) {
      await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
      if (DEBUG) console.log(`[blocked-media] ${message.author.tag}`);
    }
    return;
  }

  if (await handleSpamWatchVolumeFlush(message)) return;

  // Specific user: move their media (GIF/image/video or tenor.com links) when the message text contains religion/politics → hold channel
  if (message.author.id === MEDIA_RELIGION_OFFTOPIC_USER_ID) {
    const hasImageOrVideo = message.attachments?.some(
      a => IMAGE_CONTENT_TYPES.test(a.contentType || '') || VIDEO_CONTENT_TYPES.test(a.contentType || '') || IMAGE_EXTENSIONS.test(a.name || '')
    );
    const hasTenorLink = message.content && message.content.includes('tenor.com');
    const hasMedia = hasImageOrVideo || hasTenorLink;
    const hasReligionPolitics = message.content && shouldTriggerReligionPolitics(message.content);
    if (hasMedia && hasReligionPolitics) {
      const randomGifMedia = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
      await deleteInGeneralAndForwardMovedHold(message, randomGifMedia);
      if (DEBUG) console.log(`[media-religion] Moved ${message.author.tag} media+religion/politics to hold channel`);
      return;
    }
  }

  if (!message.content) {
    if (DEBUG) console.log('[skip] empty content (enable Message Content Intent in Discord Developer Portal → Bot)');
    return;
  }

  if (await handleSpamWatchUser(message)) return;

  // Monkey-emoji / moderation trope OR in-game “monkey noises” comms culture: react only, do not return
  if (hasMonkeyModerationTrope(message.content) || hasMonkeyNoisesCultureTrope(message.content)) {
    try {
      const tropeEmoji = MONKEY_TROPE_EMOJIS[Math.floor(Math.random() * MONKEY_TROPE_EMOJIS.length)];
      await message.react(tropeEmoji);
      if (DEBUG) console.log(`[monkey-trope] Reacted ${tropeEmoji} for ${message.author.tag}`);
    } catch (err) {
      console.error('Monkey trope reaction failed (set MONKEY_TROPE_EMOJIS to comma-separated unicode or <:emoji:id> that exist in this server):', err.message);
    }
  }

  // "Poor … Savage" — reply with raid meme video (gv-general only)
  if (hasPoorSomethingSavageTrigger(message.content)) {
    const vidPath = POOR_SAVAGE_VIDEO_PATH;
    try {
      if (fs.existsSync(vidPath)) {
        await message.reply({
          files: [{ attachment: vidPath, name: path.basename(vidPath) }],
        });
        if (DEBUG) console.log(`[poor-savage] Video reply for ${message.author.tag}`);
      } else {
        console.error(`Poor Savage video missing: ${vidPath} — set POOR_SAVAGE_VIDEO_PATH or add assets/The_Way_We_Raid_Gloria_Victis.mp4`);
      }
    } catch (err) {
      console.error('Poor Savage video reply failed:', err.message);
    }
    return;
  }

  // "Where is Miaow?" / "Miaow is missing?" – reply with Emperor of Miðland role ping + random Miaow image (only when author has Miðland role)
  if (hasMiaowWhereTrigger(message.content)) {
    const hasTriggerRole = message.member?.roles?.cache?.has(MIAOW_TRIGGER_ROLE_ID);
    if (hasTriggerRole) {
      try {
        const roleMention = `<@&${EMPEROR_MIAOW_ROLE_ID}>`;
        const payload = { content: roleMention };
        const miaowImagePath = getRandomMiaowImage();
        if (miaowImagePath) {
          payload.files = [{ attachment: miaowImagePath, name: path.basename(miaowImagePath) }];
        }
        await message.reply(payload);
        if (DEBUG) console.log('[miaow] Replied with Emperor role ping + image');
      } catch (err) {
        console.error('Miaow reply failed:', err.message);
      }
    } else if (DEBUG) {
      console.log('[miaow] Skipped – author does not have Miðland role');
    }
    return;
  }

  // "Soon" trigger: react with :soon:; for game-related phrases only (when can we play, is the game up, any eta, etc.) also post a random Soon meme image
  if (hasSoonTrigger(message.content)) {
    try {
      await message.react(SOON_EMOJI);
    } catch (err) {
      console.error('Soon emoji reaction failed (emoji must exist in this server):', err.message);
    }
    if (hasSoonTriggerWithImage(message.content)) {
      try {
        const soonPath = getRandomSoonMeme();
        if (soonPath) {
          await message.reply({
            files: [{ attachment: soonPath, name: path.basename(soonPath) }],
          });
        } else if (DEBUG) {
          console.warn('[soon] No Soon meme files found under assets/memes (expected 5 Soon-only files)');
        }
      } catch (err) {
        console.error('Soon meme reply failed:', err.message);
      }
    }
    return;
  }

  // Slur: first offense = GIF + redirect; repeated/spam (same user within 1h) = video. Delete in gv-general, repost to hold channel.
  if (hasSpamSlur(message.content)) {
    if (isExcludedFromDeleteAndMeme(message)) return; // e.g. admin with Savage/unban in name — no delete, no meme
    const userId = message.author.id;
    const repeated = isRepeatedSlurOffender(userId);
    recordSlurReply(userId);
    const videoPayload = getSpamVideoPayload();
    const gifOrVideoPayload = repeated ? videoPayload : TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardMovedHold(message, gifOrVideoPayload);
    return;
  }

  // Racial/religious stereotype bait (e.g. "isn't everyone south of the border Mexican?") — hold channel, no safe-context bypass
  if (hasStereotypeRaceReligionRedirect(message.content)) {
    if (isExcludedFromDeleteAndMeme(message)) return;
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Psychiatric / disability slurs (e.g. "schizo", "they're autistic") — hold channel, no safe-context bypass
  if (hasMedicalPsychiatricInsult(message.content)) {
    if (isExcludedFromDeleteAndMeme(message)) return;
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Geopolitical keywords (states, NATO, UN, sanctions, invasion, regime, …) — hold channel even if message also has guild/nation safe-context
  if (hasGeopoliticalHardRedirect(message.content)) {
    if (isExcludedFromDeleteAndMeme(message)) return;
    const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardMovedHold(message, randomGif);
    return;
  }

  // Safe-context BEFORE off-topic/religion so game lines (e.g. "choosing a nation", "more military") are not mis-flagged
  if (hasSafeContext(message.content)) {
    if (DEBUG) console.log('[skip] safe-context word in:', message.content.slice(0, 80));
    return; // game/community context – don't trigger
  }

  // Off-topic phrases (vulgar/body/gender/race): Mace Windu GIF. Delete in gv-general, repost to hold channel.
  if (hasOffTopicPhrase(message.content)) {
    if (isExcludedFromDeleteAndMeme(message)) return; // e.g. admin with Savage/unban in name — no delete, no meme
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }
  if (messageContainsSafeTenorLink(message.content)) {
    if (DEBUG) console.log('[skip] message contains safe tenor GIF (e.g. kittens)');
    return; // whitelisted tenor link – don't trigger religion/politics
  }

  // Religion/politics/goy: trigger if ≥80% filter words OR ideological phrases OR obvious religion/politics phrases
  if (!shouldTriggerReligionPolitics(message.content)) {
    if (DEBUG) console.log('[skip] not religion/politics:', message.content.slice(0, 80));
    return;
  }

  // Religion/politics/ideological: random GIF. Delete in gv-general, repost to hold channel.
  if (isExcludedFromDeleteAndMeme(message)) return; // e.g. admin with Savage/unban in name — no delete, no meme
  const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
  await deleteInGeneralAndForwardMovedHold(message, randomGif);
});

// --- Health check server (for Render: readiness + keep-alive) ---
// On Render free tier the service sleeps after ~15 min without incoming HTTP requests.
// Use an external pinger (e.g. UptimeRobot) to hit your Render URL every 5 min so the service stays awake.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Health check server on 0.0.0.0:${PORT}`);
});

// Log and avoid silent exit on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at', promise, 'reason:', reason);
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});
client.on('warn', (info) => {
  console.warn('Discord client warn:', info);
});
client.on('debug', (info) => {
  const s = String(info || '');
  // Never leak token-like values to logs.
  if (/provided token/i.test(s)) {
    console.log('Discord debug: [token redacted]');
    return;
  }
  console.log('Discord debug:', s);
});
client.on('shardReady', (id) => {
  console.log(`Discord shard ${id} ready`);
});
client.on('shardError', (error, id) => {
  console.error(`Discord shard ${id} error:`, error?.message || error);
});
client.on('shardDisconnect', (event, id) => {
  console.error(`Discord shard ${id} disconnected:`, event?.code, event?.reason || '');
});
client.on('shardReconnecting', (id) => {
  console.warn(`Discord shard ${id} reconnecting...`);
});
process.on('exit', (code) => {
  console.log(`Process exit: code=${code}`);
});
process.on('SIGTERM', () => {
  console.warn('Received SIGTERM');
});
process.on('SIGINT', () => {
  console.warn('Received SIGINT');
});

// --- Start bot ---
if (!DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in environment (e.g. on Render: Environment tab).');
  process.exit(1);
}
const BOT_TOKEN = String(DISCORD_TOKEN).trim();
console.log('Attempting Discord login...');
// Heartbeat so Render logs show if process is alive/restarting.
setInterval(() => {
  const mu = process.memoryUsage();
  const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
  console.log(`[hb] pid=${process.pid} uptime=${Math.round(process.uptime())}s rss=${mb(mu.rss)}MB heapUsed=${mb(mu.heapUsed)}MB`);
}, 5000);
const LOGIN_READY_TIMEOUT_MS = Math.max(15000, parseInt(process.env.LOGIN_READY_TIMEOUT_MS || '60000', 10));
const loginWatchdog = setTimeout(() => {
  if (!client.isReady()) {
    console.error(`Discord login watchdog: not ready after ${LOGIN_READY_TIMEOUT_MS}ms, exiting for clean restart`);
    process.exit(1);
  }
}, LOGIN_READY_TIMEOUT_MS);

try {
  const p = client.login(BOT_TOKEN);
  Promise.resolve(p)
    .then(() => {
      // login() resolves after ready in discord.js; keep a log here so Render shows it conclusively.
      clearTimeout(loginWatchdog);
      console.log('Discord login ok (ready).');
    })
    .catch((err) => {
      clearTimeout(loginWatchdog);
      console.error('Discord login failed:', err?.message || err);
      process.exit(1);
    });
} catch (err) {
  clearTimeout(loginWatchdog);
  console.error('Discord login threw synchronously:', err?.message || err);
  process.exit(1);
}
