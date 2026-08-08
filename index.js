const { Client, GatewayIntentBits, Options, Partials, ChannelType, SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const dns = require('dns');
const Parser = require('rss-parser');
const midlandVoiceTranslate = require('./midland-voice-translate');

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
// Main Gloria Victis Discord guild (GV-only welcomes, Miaow, spam-watch, gv-general moderation).
const GV_MAIN_GUILD_ID = String(process.env.GV_MAIN_GUILD_ID || '1166738416654897203');
// Midland Nation EU — separate guild: delete + warn DM + offense log (no Chronicus/hold repost).
const MIDLAND_EU_GUILD_ID = String(process.env.MIDLAND_EU_GUILD_ID || '').trim();
const MIDLAND_EU_MOD_CHANNEL_IDS = new Set(
  String(process.env.MIDLAND_EU_MOD_CHANNEL_IDS || '1045054231004053564,1097987852358406204')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const MIDLAND_EU_OFFENSE_LOG_CHANNEL_ID = String(
  process.env.MIDLAND_EU_OFFENSE_LOG_CHANNEL_ID || '1516103168940048444',
);
const MIDLAND_EU_WARN_DM =
  process.env.MIDLAND_EU_WARN_DM || "Don't be too toxic now. I'm watching you, mate.";
const MIDLAND_EU_ENABLED = Boolean(MIDLAND_EU_GUILD_ID && MIDLAND_EU_MOD_CHANNEL_IDS.size > 0);
// Trigger channel = gv-general (bot listens here for slurs, off-topic, religion/politics, Soon).
const TRIGGER_CHANNEL_ID = String(process.env.TRIGGER_CHANNEL_ID || '1166738417539887218');
const GV_GENERAL_CHANNEL_ID = String(process.env.GV_GENERAL_CHANNEL_ID || TRIGGER_CHANNEL_ID); // trigger channel (slurs, Soon, etc.) and Chronicus meme target
// Admin-only channel: we skip gv-general triggers for messages here; welcomes are only from guildMemberAdd (not from Carl-bot log)
const ADMIN_JOIN_CHANNEL_ID = String(process.env.ADMIN_JOIN_CHANNEL_ID || '1166746316999757864');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
// gv-general: after a runic-only bypass message, post English guess + Latin transliteration (see RUNE_LATIN_* env)
const RUNE_LATIN_FOLLOWUP_ENABLED = process.env.RUNE_LATIN_FOLLOWUP_ENABLED !== '0' && process.env.RUNE_LATIN_FOLLOWUP_ENABLED !== 'false';
const RUNE_LATIN_FOLLOWUP_DELAY_MS = Math.max(0, parseInt(process.env.RUNE_LATIN_FOLLOWUP_DELAY_MS, 10) || 800);
// When true (default): only post transliteration for plain public questions (has "?", no reply, no user/role/@everyone/@here).
const RUNE_LATIN_FOLLOWUP_QUESTIONS_ONLY = process.env.RUNE_LATIN_FOLLOWUP_QUESTIONS_ONLY !== '0' && process.env.RUNE_LATIN_FOLLOWUP_QUESTIONS_ONLY !== 'false';
// Primary line is English (heuristics + optional Google). Set to 0 for Latin-only follow-up.
const RUNE_LATIN_ENGLISH_LINE = process.env.RUNE_LATIN_ENGLISH_LINE !== '0' && process.env.RUNE_LATIN_ENGLISH_LINE !== 'false';
// After heuristics, call Google translate (auto→en) so non-English runic text can become English. Sends text to Google; set 0 to disable.
const RUNE_LATIN_GOOGLE_TRANSLATE = process.env.RUNE_LATIN_GOOGLE_TRANSLATE !== '0' && process.env.RUNE_LATIN_GOOGLE_TRANSLATE !== 'false';
// Temp voice channels: users join a "hub" voice channel, bot creates a temp channel in this category and moves them there.
const TEMP_VOICE_CATEGORY_ID = String(process.env.TEMP_VOICE_CATEGORY_ID || '1166738417539887216');
const TEMP_VOICE_TRIGGER_CHANNEL_ID = String(process.env.TEMP_VOICE_TRIGGER_CHANNEL_ID || '');
const TEMP_VOICE_NAME_TEMPLATE = process.env.TEMP_VOICE_NAME_TEMPLATE || '{displayName}\'s channel';
const TEMP_VOICE_COMMAND_GUILD_ID = String(process.env.TEMP_VOICE_COMMAND_GUILD_ID || '');
const TEMP_VOICE_STARTUP_GRACE_MS = Math.max(0, parseInt(process.env.TEMP_VOICE_STARTUP_GRACE_MS, 10) || 90000);
const TEMP_VOICE_OWNERS_FILE = path.join(process.cwd(), 'temp-voice-owners.json');
// Message to send when a word is detected
// #off-topic — Chronicus + “please move here” education (gv-general warning still points here)
const REDIRECT_CHANNEL_ID = String(process.env.REDIRECT_CHANNEL_ID || '1168446788810842172');
// Bot-moved gv-general posts land here so #off-topic chat flow stays clean; message body still tells users to use off-topic
const MOVED_BY_BOT_CHANNEL_ID = String(process.env.MOVED_BY_BOT_CHANNEL_ID || '1485211311070511225');
// When rule-hit Chronicus/off-topic education cannot be DM’d, post mention + text here (default same hold channel; override if needed).
const CHRONICUS_EDUCATION_DM_FALLBACK_CHANNEL_ID = String(process.env.CHRONICUS_EDUCATION_DM_FALLBACK_CHANNEL_ID || '1485211311070511225');
// Severe CSAM/grooming-related text in gv-general → same hold channel + TMFIAR + mandatory ✅ from author (same rules for all users).
const CSAM_GROOMING_WORDS_FILE = process.env.CSAM_GROOMING_WORDS_FILE || path.join(process.cwd(), 'assets', 'csam-grooming-triggers.txt');
const CSAM_ACK_EMOJI = '✅';
const CSAM_ACK_COLLECTOR_MS = 7 * 24 * 60 * 60 * 1000; // wait up to 7 days for first ✅ from author
// User whose image/GIF posts in off-topic get moved to gv-general (delete in off-topic, re-post there with no message). Set in Render only — do not commit.
const OFFTOPIC_TO_GENERAL_USER_ID = process.env.OFFTOPIC_TO_GENERAL_USER_ID || '';
// If configured authors target Ser/SirSavage (mention or evasion spelling), bot DMs them with NOOBMARS_MENTION_REPLY.
// Same author list can also trigger on "Poor <something>" (e.g. "Poor immigrant swede", "Poor serclown").
const NOOBMARS_TRIGGER_AUTHOR_IDS = new Set(
  String(process.env.NOOBMARS_TRIGGER_AUTHOR_IDS || '210085436566011904,188328879180480512,405079515765800979,506091599420194817')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
// Optional subset override for "Poor <something>" trigger. Empty = all NOOBMARS_TRIGGER_AUTHOR_IDS.
const NOOBMARS_POOR_TRIGGER_AUTHOR_IDS = new Set(
  String(process.env.NOOBMARS_POOR_TRIGGER_AUTHOR_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const NOOBMARS_TRIGGER_TARGET_ID = String(process.env.NOOBMARS_TRIGGER_TARGET_ID || '275603696036085760');
const NOOBMARS_MENTION_REPLY = process.env.NOOBMARS_MENTION_REPLY || 'Sangnoobs';
const NOOBMARS_DM_FALLBACK_CHANNEL_ID = String(process.env.NOOBMARS_DM_FALLBACK_CHANNEL_ID || '1485211311070511225');
const DELUSION_STRICT_USER_ID = String(process.env.DELUSION_STRICT_USER_ID || '188328879180480512');
function hasSavageNameTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  // Direct forms in sentence context (e.g. "tarzan and savage")
  if (/\bsersavage\b/.test(lower) || /\bsirsavage\b/.test(lower) || /\bsavage\b/.test(lower)) return true;
  if (/\bser\s+savage\b/.test(lower) || /\bsir\s+savage\b/.test(lower)) return true;

  const compact = normalizeForMatch(lower).replace(/[^a-z]/g, '');
  if (compact.includes('sersavage') || compact.includes('sirsavage') || compact.includes('savage')) return true;
  // Evasion-friendly shapes: sir/ser + savage OR stretched plain savage (e.g. "sirsaavage", "sersavge", "saaavage")
  if (/s[ei]r+s+a?v+a?g+e?/.test(compact)) return true;
  return /s+a+v+a?g+e+/.test(compact);
}
function hasPoorNoobmarsTrigger(message) {
  if (!message?.author?.id || !message.content) return false;
  const authorId = String(message.author.id);
  const poorAllowed =
    NOOBMARS_POOR_TRIGGER_AUTHOR_IDS.size > 0
      ? NOOBMARS_POOR_TRIGGER_AUTHOR_IDS.has(authorId)
      : NOOBMARS_TRIGGER_AUTHOR_IDS.has(authorId);
  if (!poorAllowed) return false;
  const t = stripDiacritics(message.content.toLowerCase());
  return /\bpoor\s+[a-z0-9][a-z0-9'_-]{1,}\b/.test(t);
}

function shouldReplyNoobmars(message) {
  if (!message || !message.author) return false;
  if (!NOOBMARS_TRIGGER_AUTHOR_IDS.has(String(message.author.id))) return false;
  if (message.mentions?.users?.has(NOOBMARS_TRIGGER_TARGET_ID)) return true;
  if (hasPoorNoobmarsTrigger(message)) return true;
  return hasSavageNameTrigger(message.content);
}
function getNoobmarsDmPayload() {
  return { content: NOOBMARS_MENTION_REPLY };
}
async function relayNoobmarsToHoldOnDmFailure(message) {
  const holdChannel = await message.client.channels.fetch(NOOBMARS_DM_FALLBACK_CHANNEL_ID).catch(() => null);
  if (!holdChannel?.isTextBased()) return false;
  const raw = message.content ? String(message.content).trim() : '';
  const movedText = raw ? raw.slice(0, 1200) + (raw.length > 1200 ? '…' : '') : '(no text)';
  const relay = [
    `${message.author.toString()} — moved from <#${TRIGGER_CHANNEL_ID}> (Noobmars DM closed/blocked):`,
    movedText,
    `${message.author.toString()} ${NOOBMARS_MENTION_REPLY}`,
  ].join('\n\n');
  try {
    await holdChannel.send({
      content: relay,
      allowedMentions: { users: [message.author.id] },
    });
  } catch (err) {
    console.error('Noobmars hold relay failed:', err.message);
    return false;
  }
  try {
    await message.delete();
  } catch (err) {
    console.error('Noobmars fallback delete failed:', err.message);
    return false;
  }
  return true;
}

function stripDiacritics(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Strip one pair of wrapping quotation marks (ASCII or typographic) so moderation sees the same text as without quotes. */
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
// 4-file scam: delete in any channel + strip roles → Court Jester only (numbered 1–4, four× image.jpg, or known SHA256 set)
const FOUR_IMAGE_SCAM_BLOCK =
  process.env.FOUR_IMAGE_SCAM_BLOCK !== '0' && process.env.FOUR_IMAGE_SCAM_BLOCK !== 'false';
const COURT_JESTER_ROLE_ID = String(process.env.COURT_JESTER_ROLE_ID || '1322332947197464606');
const FOUR_IMAGE_SCAM_NAME_RE = /^([1-4])\.(jpe?g|png)$/i;
const FOUR_IMAGE_SCAM_DUPLICATE_NAME = 'image.jpg';
/** Minimum attachments for four× image.jpg or hash-subset match (scammers sometimes post only 2). Numbered 1–4 still requires exactly 4. */
const FOUR_IMAGE_SCAM_MIN_DUPLICATE_ATTACHMENTS = Math.max(
  2,
  parseInt(process.env.FOUR_IMAGE_SCAM_MIN_DUPLICATE_ATTACHMENTS || '2', 10),
);
const FOUR_IMAGE_SCAM_HASH_MAX_BYTES = Math.max(
  512 * 1024,
  parseInt(process.env.FOUR_IMAGE_SCAM_HASH_MAX_BYTES || String(12 * 1024 * 1024), 10),
);
const FOUR_IMAGE_SCAM_HASHES_FILE = path.join(process.cwd(), 'assets', 'four-image-scam-hashes.json');

function loadFourImageScamHashSets() {
  const sets = [];
  try {
    if (fs.existsSync(FOUR_IMAGE_SCAM_HASHES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FOUR_IMAGE_SCAM_HASHES_FILE, 'utf8'));
      for (const entry of raw.sets || []) {
        const hashes = (entry.hashes || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
        if (hashes.length === 4) sets.push({ id: entry.id || 'file', label: entry.label || entry.id, hashes });
      }
    }
  } catch (err) {
    console.warn('four-image-scam-hashes.json load failed:', err.message);
  }
  const extra = String(process.env.FOUR_IMAGE_SCAM_HASH_SET || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const block of extra) {
    const hashes = block.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (hashes.length === 4) sets.push({ id: 'env', label: 'env', hashes });
  }
  return sets;
}

const FOUR_IMAGE_SCAM_HASH_SETS = loadFourImageScamHashSets();
// RSS feed → Discord announcement channel (e.g. Gloria Victis news). If the site has no RSS, use a converter like https://rss.app/ with the news page URL.
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '1482341063674036284';
const RSS_FEED_URL = process.env.RSS_FEED_URL || 'https://rss.app/feeds/570E40bRtM0TKZJF.xml'; // Gloria Victis | gamigo news (override with env if needed)
const RSS_POLL_INTERVAL_MS = Math.max(60000, parseInt(process.env.RSS_POLL_INTERVAL_MS, 10) || 15 * 60 * 1000); // default 15 min
// Second feed: official gloriavictisgame.com news (rss.app). Polled once per day; up to 2 newest unseen items per run.
const RSS_FEED_URL_2 = process.env.RSS_FEED_URL_2 || 'https://rss.app/feeds/TKc8HJF30JuGn4mI.xml';
const RSS_FEED_2_POLL_INTERVAL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.RSS_FEED_2_POLL_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000); // default 24 h
const RSS_FEED_2_MAX_POSTS = Math.max(1, Math.min(5, parseInt(process.env.RSS_FEED_2_MAX_POSTS, 10) || 2));
const RSS_OFFICIAL_BOOTSTRAP_KEY = '__rss_official_gv_news_bootstrapped__';
const RSS_2_CHANNEL_HISTORY_LIMIT = Math.min(500, Math.max(40, parseInt(process.env.RSS_2_CHANNEL_HISTORY_LIMIT, 10) || 200));
const RSS_SEEN_FILE = path.join(process.cwd(), 'rss-seen.json');
// Nexus Mods API: notify Discord when tracked mod file(s) change (needs NEXUS_API_KEY from a Nexus account with API access).
const NEXUS_MOD_WATCH_FILE = path.join(process.cwd(), 'nexus-mod-watch.json');
const NEXUS_API_KEY = process.env.NEXUS_API_KEY || '';
const NEXUS_MOD_GAME_DOMAIN = process.env.NEXUS_MOD_GAME_DOMAIN || 'mountandblade2bannerlord';
const NEXUS_MOD_ID_PARSED = parseInt(process.env.NEXUS_MOD_ID || '10668', 10);
const NEXUS_MOD_ID = Number.isFinite(NEXUS_MOD_ID_PARSED) && NEXUS_MOD_ID_PARSED > 0 ? NEXUS_MOD_ID_PARSED : 0;
const NEXUS_MOD_NOTIFY_CHANNEL_ID = process.env.NEXUS_MOD_NOTIFY_CHANNEL_ID || '1168572760054841425';
const NEXUS_MOD_PAGE_URL =
  process.env.NEXUS_MOD_PAGE_URL || 'https://www.nexusmods.com/mountandblade2bannerlord/mods/10668';
const NEXUS_MOD_POLL_INTERVAL_MS = Math.max(15 * 60 * 1000, parseInt(process.env.NEXUS_MOD_POLL_INTERVAL_MS, 10) || 60 * 60 * 1000);
// Nexus file category_id: 1=MAIN, 2=PATCH, 3=OPTION, 4=OLD_VERSION, … (see Nexus public API types)
const NEXUS_MOD_FILE_CATEGORY_IDS = (process.env.NEXUS_MOD_FILE_CATEGORY_IDS || '1')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !Number.isNaN(n));
const NEXUS_APP_NAME = process.env.NEXUS_APP_NAME || 'GV-LegacyGeneralMod';
const NEXUS_APP_VERSION = process.env.NEXUS_APP_VERSION || '1.0.0';
const NEW_ARRIVALS_CHANNEL_ID = String(process.env.NEW_ARRIVALS_CHANNEL_ID || '1166775627089719436'); // #new-arrivals: welcome video + user tag (join or first role)
// Channel IDs for welcome message links (Welcome + server-roles). Override with env if needed.
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1166746745582125096';   // #Welcome
const SERVER_ROLES_CHANNEL_ID = process.env.SERVER_ROLES_CHANNEL_ID || '1252706362899562647'; // #server-roles
// Emperor Miaow: when someone asks where Miaow is, reply with role ping + random image. Only triggered when the message author has Miðland role.
const EMPEROR_MIAOW_ROLE_ID = process.env.EMPEROR_MIAOW_ROLE_ID || '1279896690517737515'; // Emperor of Miðland (pinged in reply)
const MIAOW_TRIGGER_ROLE_ID = process.env.MIAOW_TRIGGER_ROLE_ID || '1167525339103248384'; // Miðland – only this role can trigger the "Where is Miaow?" reply
const EMPEROR_MIAOW_DIR = path.join(process.cwd(), 'EmperorMiaow');
const MIAOW_IMAGE_NAMES = [
  'MiaowMIA.png',
  'miaow_1.png', 'miaow_2.png', 'miaow_3.png', 'miaow_4.png', 'miaow_5.png',
  'miaow_6.png', 'miaow_7.png', 'miaow_8.png', 'miaow_9.png',
  'MiaowMissingNew1.png', 'MiaowMissingNew2.png', 'MiaowMissingNew3.png', 'MiaowMissingNew4.png',
];
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

// Reference: which media goes with which trigger (gv-general → delete + repost to MOVED_BY_BOT_CHANNEL; Chronicus education → author DM, else CHRONICUS_EDUCATION_DM_FALLBACK_CHANNEL_ID)
// • Slurs (first time)  → random TENOR_GIF  | Slurs (repeated in 1h) → VIDEO_URL (TMFIAR streamable.com/e/mwfkm2)
// • Off-topic phrases   → OFF_TOPIC_GIF (Mace Windu only)
// • Religion/politics  → random TENOR_GIF
// • Soon (Gæm?, ETA?)  → SOON_EMOJI reaction only (no delete/forward)
// • New member welcome → random from NEW_ARRIVAL_VIDEO_URLS in #new-arrivals (channel NEW_ARRIVALS_CHANNEL_ID), user mentioned by ID

// Safe-context terms: if message contains any of these (game/community/lore), we do NOT trigger religion/politics filter.
// Built from in-code list + Gloria Victis Wiki (https://gloriavictis.fandom.com/wiki/Gloria_Victis_Wiki) + official wiki
// (https://wiki.gloriavictisgame.com/index.php/Main_Page) + safe-context.txt + gv-legacy-index.txt (patch-note export; regenerate with scripts/extract-gv-legacy-index.mjs)
const GV_LEGACY_INDEX_FILE = process.env.GV_LEGACY_INDEX_FILE || path.join(process.cwd(), 'gv-legacy-index.txt');
const SAFE_CONTEXT_BASE = [
  'nations', 'guilds', 'greenleafs', 'greenleaves', 'enemy', 'helping', 'players', 'emotes', 'monke',
  'downvote', 'upvote', 'voted', 'voting', 'sub',
  'grayward', 'gv',
  'interest', 'hobbies', 'share', 'experience', 'personal',
  'another round', 'round in',
  'emperor', 'represent',
  'jc', 'jarnclan', 'jarn',
  'destiny',
  // Pings / display names — only skips religion-politics + off-topic *after* Balkans/geopolitical/slurs (those run first).
  'savage', 'sersavage', 'sirsavage', 'cassander',
  'dipshit', // mod-style scolding (e.g. "for him dipshit") – don't trigger
  'good', // common word (agreement/approval); if in words.txt would trigger on single "Good" – skip
  'mad men', 'mad man', 'lunatics', 'lunatic', // idiom/quote (e.g. "nation filled with mad men and lunatics") – skip off-topic and religion/politics
  // Gloria Victis Wiki – game/lore so "war", "empire", "worship" etc. don't trigger
  'state of war', 'gloria victis', 'black eye games',
  // Game title context ("God of War") should not trigger religion/politics moderation.
  'god of war',
  'midland', 'midlanders', 'azebia', 'azebs', 'nordheim', 'ismir', 'ismirs', 'sangmar', 'sangmir', 'sangarians',
  'empire of azebia', 'azebian', 'midlandic', 'sangmar empire',
  'twinfall', 'midland day', 'non-loot', 'non loot',
  'forefather', 'greatfather', 'khagan', 'zenith',
  'crafting', 'economy', 'bosses', 'recipes', 'resources', 'shields', 'glory', 'reputation',
  'guild', 'siege', 'territory', 'non-targeting', 'loot', 'medieval', 'mmorpg',
  // Midland / GV party + shotcall jargon (abbey is also a religion word in words.txt)
  'abbey party', 'req for south', 'req for north', 'call req', 'shotcall', 'shotcaller',
  // Character attributes (words.txt may list "constitution" as political; standalone stat posts are game talk).
  'constitution', 'strength', 'dexterity', 'agility', 'vitality', 'endurance',
  // Gloria Victis wikis (https://wiki.gloriavictisgame.com/ + Fandom) — base terms; deeper curated phrases live in safe-context.txt
  'character statistics', 'fast travel', 'mounts', 'player stalls', 'gathering resources', 'barn manager',
  'renovation kit', 'frontier guard', 'guild levels', 'feudal system', 'patronus nobilis', 'leveling guide',
  'video combat guide', 'survival instinct',
  // Store/platform + game discussion so real-world politics triggers don't fire on game-related posts.
  'steam', 'mortal online',
  'geliand', 'hillead', 'infidels', 'island', 'fashion', 'chests', 'titles', 'interfaces', 'map',
  'log in', 'login', 'log in.', 'can\'t log in', 'cant log in', // game/server – avoid triggering on "I can't log in"
  'in-game', 'ingame', // "genocide a nation in-game" = game talk, don't trigger
  // Ping, matchmaking, game balance – allow in gv-general (e.g. "match between ping 30 and 110", "remove the marker", "unplayable")
  'ping', 'marker', 'unplayable', 'match', 'matchmaking', 'latency', 'ms',
  // In-game PvP / character combat – not IRL violence (e.g. "Meow Army", "it's going to be a bloodbath" = in-game)
  'bloodbath', 'meow army',
  // Sports / speed idiom — "turned on the jets" (fast PvP), not the jeet slur
  'turned on the jets', 'on the jets',
  // Nation choice / faction traits – game context (e.g. "Soon you'll be choosing a nation", "some are more military")
  'choosing a nation', 'choosing a faction', 'more military', 'nation choice', 'pick a nation',
  // Player region / server zone shorthand (not IRL politics)
  'north america', 'south america', 'southeast asia', 'south east asia', 'latin america', 'oceania',
  // GV official server shards (EU / SEA / NA) — nationality labels when server hopping are game talk
  'wolfield', 'wolfied', 'aquilla', 'aquila', 'dukla', 'server hop', 'server hopping', 'server hoppers',
  // Midland houses — "Germanica" contains substring "manic" (medical-psych); allow house/legio names
  'germanica', 'legio', 'legio germanica', 'legiogermanica', 'house germanica',
];
function loadSafeContextWords() {
  const fromFile = loadWordsFromFile(process.env.SAFE_CONTEXT_FILE || 'safe-context.txt')
    .filter(w => !w.startsWith('#'));
  const fromLegacy = fs.existsSync(GV_LEGACY_INDEX_FILE)
    ? loadWordsFromFile(GV_LEGACY_INDEX_FILE).filter((w) => !w.startsWith('#'))
    : [];
  const all = [...new Set([...SAFE_CONTEXT_BASE.map(w => w.toLowerCase()), ...fromFile, ...fromLegacy])];
  return new Set(all);
}
const SAFE_CONTEXT_WORDS = loadSafeContextWords();
console.log(`Safe-context terms: ${SAFE_CONTEXT_WORDS.size} (GV Wiki + safe-context.txt + gv-legacy-index)`);

// Gloria Victis character attributes — never hold delete for stat-only posts (constitution / strength / dexterity).
const GV_CHARACTER_STAT_WORDS = [
  'constitution', 'strength', 'dexterity', 'agility', 'vitality', 'endurance',
  'intelligence', 'wisdom', 'charisma', 'stamina', 'willpower',
  'attribute', 'attributes',
].map((w) => w.toLowerCase());
const GV_CHARACTER_STAT_ALIASES = new Set([
  ...GV_CHARACTER_STAT_WORDS,
  'str', 'dex', 'con', 'vit', 'agi', 'end', 'int', 'wis', 'cha', 'stat', 'stats',
]);

/** True when the message is only GV stat names/aliases (optional numbers, str/dex/con, punctuation). */
function isGvCharacterStatMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const norm = stripDiacritics(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .trim();
  if (!norm) return false;
  const tokens = norm
    .split(/\s+/)
    .map((w) => w.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, '').toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let sawStat = false;
  for (const raw of tokens) {
    const segments = raw.split(/[/+:\-]+/).filter(Boolean);
    for (const seg of segments) {
      const t = seg.replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
      if (!t) continue;
      if (/^\d+$/.test(t)) continue;
      if (GV_CHARACTER_STAT_ALIASES.has(t)) {
        sawStat = true;
        continue;
      }
      return false;
    }
  }
  return sawStat;
}

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
  // Anti-Indian / South-Asian racist slurs (4chan meme terms; also checked in hasIndianAsianRaceSlur)
  'pajeet', 'pajeets', 'poojeet', 'poojeets', 'poopjeet', 'poopjeets',
  'jeet', 'jeets', 'j33t', 'j3et', 'p4jeet', 'p@jeet', 'paje3t',
  'curry muncher', 'currymuncher', 'curry-muncher',
  'dothead', 'dot head', 'dot-head',
  'designated shitting', 'designated shitter',
  'street shitter', 'street shitting',
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
  // "fuck a [race/nat] [person]", "fuck [race/nat] [person]" — bare "[race] girl/guy" is omitted so harmless refs
  // (e.g. Willy Wonka / film) are not flagged; explicit fuck-variants still catch objectifying lines.
  for (const r of raceNat) {
    for (const p of person) {
      add(`fuck a ${r} ${p}`);
      add(`fuck ${r} ${p}`);
    }
    add(`fuck a ${r}`);
    add(`fuck ${r}`);
  }
  // "lets fuck a ...", "let's fuck a ..." — bare "lets fuck" omitted (matches inside "let's fucking go"); see hasOffTopicPhrase negative lookahead
  add('lets fuck a');
  add('let\'s fuck a');
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

// Extra phrases (meme slang / desktop list) — must be defined before OFF_TOPIC_PHRASES log below
const OFF_TOPIC_EXTRA_PHRASES = [
  'copium', 'afrocentrism', 'afrocentric',
  'delulu', 'dilulu', 'telulu', 'sir delulu', 'miss delulu', 'mr delulu', 'missus delulu',
].map((p) => p.toLowerCase());

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

/** Normalize $ / ＄ / regional-indicator S (U+1F1F8) used instead of "S" in "Savage" for Poor-Savage meme detection. */
function normalizePoorSavageEvasion(text) {
  const t = stripDiacritics(String(text || '').toLowerCase());
  return t
    .replace(/:regional_indicator_s:\s*avage\b/gi, ' savage')
    .replace(/\u{1F1F8}\s*avage\b/giu, ' savage')
    .replace(/[\$＄]\s*avage\b/gi, ' savage')
    .replace(/\s{2,}/g, ' ');
}

/** e.g. "Poor unban Savage", "Poor little Savage", "Poor little $avage" — requires at least one character between Poor and Savage */
function hasPoorSomethingSavageTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const folded = normalizePoorSavageEvasion(text);
  const m = folded.match(/\bpoor\s+(.+?)\s+\bsavage\b/is);
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

/**
 * Match phrase as whole words (not embedded in another word/URL slug).
 * Multi-word phrases use flexible whitespace; hyphenated tokens (e.g. far-left, neo-nazi) are one word.
 */
function matchesPhraseOrWordBoundaries(text, phrase) {
  const lower = stripDiacritics(String(text || '').toLowerCase());
  const p = String(phrase || '').trim().toLowerCase();
  if (!p) return false;
  if (p.includes(' ')) {
    const parts = p.split(/\s+/).map((t) => escapeRegex(t));
    return new RegExp(`\\b${parts.join('\\s+')}\\b`, 'i').test(lower);
  }
  return new RegExp(`\\b${escapeRegex(p)}\\b`, 'i').test(lower);
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

/**
 * Unicode Runic block (U+16A0–U+16F8) → Latin transliteration (Unicode name–based; approximate for Younger variants).
 * Non-runic characters (e.g. punctuation, Braille) pass through unchanged.
 */
const RUNIC_UNICODE_TO_LATIN = new Map([
  ['ᚠ', 'f'], ['ᚡ', 'v'], ['ᚢ', 'u'], ['ᚣ', 'yr'], ['ᚤ', 'y'], ['ᚥ', 'w'],
  ['ᚦ', 'th'], ['ᚧ', 'eth'], ['ᚨ', 'a'], ['ᚩ', 'o'], ['ᚪ', 'a'], ['ᚫ', 'ae'],
  ['ᚬ', 'o'], ['ᚭ', 'o'], ['ᚮ', 'o'], ['ᚯ', 'oe'], ['ᚰ', 'on'], ['ᚱ', 'r'], ['ᚲ', 'k'], ['ᚳ', 'c'],
  ['ᚴ', 'k'], ['ᚵ', 'g'], ['ᚶ', 'ng'], ['ᚷ', 'g'], ['ᚸ', 'g'], ['ᚹ', 'w'],
  ['ᚺ', 'h'], ['ᚻ', 'h'], ['ᚼ', 'h'], ['ᚽ', 'h'], ['ᚾ', 'n'], ['ᚿ', 'n'], ['ᛀ', 'n'],
  ['ᛁ', 'i'], ['ᛂ', 'e'], ['ᛃ', 'j'], ['ᛄ', 'j'], ['ᛅ', 'ae'], ['ᛆ', 'a'], ['ᛇ', 'ei'],
  ['ᛈ', 'p'], ['ᛉ', 'z'], ['ᛊ', 's'], ['ᛋ', 's'], ['ᛌ', 's'], ['ᛍ', 'c'], ['ᛎ', 'z'],
  ['ᛏ', 't'], ['ᛐ', 't'], ['ᛑ', 'd'], ['ᛒ', 'b'], ['ᛓ', 'b'], ['ᛔ', 'p'], ['ᛕ', 'p'],
  ['ᛖ', 'e'], ['ᛗ', 'm'], ['ᛘ', 'm'], ['ᛙ', 'm'], ['ᛚ', 'l'], ['ᛛ', 'l'], ['ᛜ', 'ng'], ['ᛝ', 'ng'],
  ['ᛞ', 'd'], ['ᛟ', 'o'], ['ᛠ', 'ea'], ['ᛡ', 'ior'], ['ᛢ', 'cw'], ['ᛣ', 'k'], ['ᛤ', 'k'],
  ['ᛥ', 'st'], ['ᛦ', 'r'], ['ᛧ', 'r'], ['ᛨ', 'r'], ['ᛩ', 'q'], ['ᛪ', 'x'],
  ['᛫', ' '], ['᛬', ' · '], ['᛭', '+'],
  ['ᛮ', '17'], ['ᛯ', '18'], ['ᛰ', '19'],
  ['ᛱ', 'k'], ['ᛲ', 'sh'], ['ᛳ', 'oo'], ['ᛴ', 'os'], ['ᛵ', 'is'], ['ᛶ', 'eh'], ['ᛷ', 'ac'], ['ᛸ', 'aesc'],
]);

function transliterateRunesToLatin(text) {
  if (!text || typeof text !== 'string') return '';
  return Array.from(text).map((ch) => RUNIC_UNICODE_TO_LATIN.get(ch) || ch).join('');
}

/**
 * Runes with spaces between letters become "i s m i r" not "ismir" — collapse known faction spellings
 * so safe-context substring checks (ismir / ismirs) match.
 */
function normalizeRunesForContextScan(text) {
  let t = transliterateRunesToLatin(String(text || ''));
  t = t.replace(/\bi\s+s\s+m\s+i\s+r\b/gi, 'ismir');
  return t;
}

/** Count Unicode runic letters (Elder/Younger Futhark etc. in U+16A0–U+16FF). */
function countElderFutharkRunes(text) {
  if (!text || typeof text !== 'string') return 0;
  const m = text.match(/[\u16A0-\u16FF]/g);
  return m ? m.length : 0;
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

// Check if message contains any spam/slur term (case-insensitive + compact anti-evasion)
function hasSpamSlur(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  if (SPAM_SLUR_TERMS.some((term) => lower.includes(term))) return true;
  // ! → i for compact scan only (evasion: n!gger → niger); avoids tc "nger" matching inside "longer", "stronger", …
  const compact = normalizeForMatch(lower.replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
  for (const term of SPAM_SLUR_TERMS) {
    if (term.length < 4) continue;
    const rawTc = term.replace(/!/g, 'i').replace(/[^a-z0-9]/g, '');
    const tc = normalizeForMatch(term.replace(/!/g, 'i')).replace(/[^a-z0-9]/g, '');
    // normalizeForMatch collapses "jeets"→"jets" — must not false-positive sports idiom "turned on the jets".
    if (rawTc.startsWith('j') && rawTc.includes('ee') && !tc.includes('ee')) continue;
    if (tc.length >= 4 && compact.includes(tc)) return true;
  }
  return false;
}

/**
 * Common English words mistyped when using ᚠ (f) for /v/ or similar; longest keys first.
 * Extend as needed — this is a guess layer on top of Unicode transliteration, not a full translator.
 */
const RUNIC_LATIN_ENGLISH_GUESSES = [
  ['efening', 'evening'],
  ['evning', 'evening'],
  ['happi', 'happy'],
  ['mornin', 'morning'],
  ['plese', 'please'],
  ['peple', 'people'],
  ['thans', 'thanks'],
  ['toomorrow', 'tomorrow'],
  ['tommorow', 'tomorrow'],
  ['whan', 'when'],
];
const RUNIC_LATIN_ENGLISH_GUESSES_SORTED = Object.freeze(
  [...RUNIC_LATIN_ENGLISH_GUESSES].sort((a, b) => b[0].length - a[0].length),
);

function applyRunicLatinEnglishGuesses(latin) {
  if (!latin || typeof latin !== 'string') return '';
  let t = latin;
  for (const [from, to] of RUNIC_LATIN_ENGLISH_GUESSES_SORTED) {
    const re = new RegExp('\\b' + escapeRegex(from) + '\\b', 'gi');
    t = t.replace(re, (m) => {
      if (m.length > 1 && m === m.toUpperCase()) return to.toUpperCase();
      if (m[0] >= 'A' && m[0] <= 'Z') return to.charAt(0).toUpperCase() + to.slice(1);
      return to;
    });
  }
  return t;
}

function parseGoogleTranslateSentence(data) {
  const block = data?.[0];
  if (!Array.isArray(block)) return '';
  return block.map((seg) => (Array.isArray(seg) ? seg[0] : '')).join('');
}

async function translateGoogleAutoToEn(text) {
  if (!RUNE_LATIN_GOOGLE_TRANSLATE || !text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4500) return null;
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'en');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', trimmed);
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const out = parseGoogleTranslateSentence(data).trim();
    return out || null;
  } catch (e) {
    if (DEBUG) console.error('[runic-latin] Google translate failed:', e.message);
    return null;
  }
}

/**
 * Plain question to the channel: must look like a public question (ASCII ?), not a reply, no pings.
 */
function shouldPostRunicLatinFollowUp(message, gvModerationText) {
  if (!RUNE_LATIN_FOLLOWUP_QUESTIONS_ONLY) return true;
  if (message.reference) return false;
  if (message.mentions?.users?.size > 0) return false;
  if (message.mentions?.roles?.size > 0) return false;
  if (message.mentions?.everyone) return false;
  if (!/\?/.test(String(gvModerationText || ''))) return false;
  return true;
}

/**
 * Post a normal channel message (not a reply) with Latin transliteration after gv-general runic bypass.
 * Re-fetches the message after a delay so we skip if it was deleted (e.g. by moderation elsewhere).
 */
function scheduleRunicLatinFollowUp(message) {
  if (!RUNE_LATIN_FOLLOWUP_ENABLED) return;
  const gvPre = message.content ? String(message.content) : '';
  const gvModerationTextEarly = stripOuterQuotesForGeneral(gvPre.trim()) || gvPre;
  if (!shouldPostRunicLatinFollowUp(message, gvModerationTextEarly)) return;
  const channel = message.channel;
  const messageId = message.id;
  const delay = RUNE_LATIN_FOLLOWUP_DELAY_MS;
  setTimeout(() => {
    (async () => {
      try {
        if (!channel?.isTextBased?.()) return;
        const fresh = await channel.messages.fetch(messageId).catch(() => null);
        if (!fresh) return;
        const raw = fresh.content ? String(fresh.content) : '';
        const gvModerationText = stripOuterQuotesForGeneral(raw.trim()) || raw;
        if (!shouldPostRunicLatinFollowUp(fresh, gvModerationText)) return;
        if (countElderFutharkRunes(gvModerationText) < 3) return;
        const norm = normalizeRunesForContextScan(gvModerationText);
        if (hasSpamSlur(gvModerationText) || hasSpamSlur(norm)) return;
        const latin = transliterateRunesToLatin(gvModerationText);
        if (!latin) return;
        let englishLine = latin;
        if (RUNE_LATIN_ENGLISH_LINE) {
          englishLine = applyRunicLatinEnglishGuesses(latin);
          if (RUNE_LATIN_GOOGLE_TRANSLATE) {
            const viaGoogle = await translateGoogleAutoToEn(englishLine);
            if (viaGoogle && viaGoogle.length > 0) englishLine = viaGoogle;
          }
        }
        let content;
        if (RUNE_LATIN_ENGLISH_LINE) {
          const same =
            englishLine.replace(/\s+/g, ' ').trim().toLowerCase() ===
            latin.replace(/\s+/g, ' ').trim().toLowerCase();
          if (same) {
            content = `**Runic → English (approx.)**\n${englishLine}`;
          } else {
            content = `**Runic → English (approx.)**\n${englishLine}\n\n*Latin transliteration:*\n${latin}`;
          }
        } else {
          content = `**Runic → Latin (approx.)**\n${latin}`;
        }
        if (content.length > 2000) content = content.slice(0, 1997) + '…';
        await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        if (DEBUG) console.error('[runic-latin] follow-up failed:', err.message || err);
      }
    })();
  }, delay);
}

/**
 * Unicode runes (U+16A0–U+16FF): allow in gv-general when ≥3 runes and slur scan passes on raw + transliterated text.
 * Used for early skip (before harassment/spam/geopolitics) and for safe-context — runes-only, no English keywords required.
 */
const RUNIC_EPIGRAPHY_PHRASE_RES = [
  /\bold\s+norse\b/i,
  /\bproto[- ]?norse\b/i,
  /\belder\s+futhark\b/i,
  /\byounger\s+futhark\b/i,
  /\b(?:viking|norse)\s+runes?\b/i,
  /\brune\s+stones?\b/i,
  /\brunestones?\b/i,
  /\b(?:futhark|futhork)\b/i,
  /\b(?:epigraphy|transliterat(?:e|ion|ing))\b/i,
  /\b(?:runic|runes)\b/i,
];
function isRunicInscriptionAllowed(text) {
  if (!text || typeof text !== 'string') return false;
  if (countElderFutharkRunes(text) < 3) return false;
  const norm = normalizeRunesForContextScan(text);
  if (hasSpamSlur(text) || hasSpamSlur(norm)) return false;
  return true;
}
function hasRunicEpigraphySafeContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  if (RUNIC_EPIGRAPHY_PHRASE_RES.some((re) => re.test(lower))) return true;
  return isRunicInscriptionAllowed(text);
}

// Exception: "mad men" / "lunatics" in idiom/quote context (e.g. "nation filled with mad men and lunatics") — don't trigger off-topic
const OFF_TOPIC_SAFE_PHRASES = ['mad men', 'mad man', 'lunatics', 'lunatic', 'gamigo', 'trove'];

// Check if message contains any off-topic phrase (substring + compact anti-evasion for spaced typing)
function hasOffTopicPhrase(text) {
  if (isGvCharacterStatMessage(text)) return false;
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  if (OFF_TOPIC_SAFE_PHRASES.some((safe) => lower.includes(safe))) return false;
  const compact = normalizeForMatch(lower).replace(/[^a-z]/g, '');
  const phraseMatches = (phrase, minCompact) => {
    if (lower.includes(phrase)) return true;
    if (phrase.length < minCompact) return false;
    const pc = phrase.replace(/\s+/g, '');
    return pc.length >= minCompact && compact.includes(pc);
  };
  if (OFF_TOPIC_EXTRA_PHRASES.some((phrase) => phraseMatches(phrase, 4))) return true;
  if (OFF_TOPIC_PHRASES.some((phrase) => phraseMatches(phrase, 6))) return true;
  // Sexual "let's fuck" / "lets fuck" — not intensifier "let's fucking go", etc. (fuck(?!ing))
  if (/\blet'?s fuck(?!ing\b)/i.test(lower) || /\blets fuck(?!ing\b)/i.test(lower)) return true;
  if (/letsfuck(?!ing)/i.test(compact)) return true;
  return false;
}

// Broad racial/religious stereotype generalizations (same redirect as vulgar off-topic). Runs before safe-context so it is not bypassed.
function hasStereotypeRaceReligionRedirect(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  const group = /\b(muslim|muslims|islam|jew|jews|jewish|mexican|mexicans|arab|arabs|black people|whites|white people|asian|asians|indian|indians|hindu|hindus|christian|christians|catholic|catholics|protestant|mormon|mormons|latino|latinos|hispanic|illegal aliens?|immigrants?)\b/i;

  if (matchesPhraseOrWordBoundaries(lower, 'south of the border') && /\b(mexican|mexico|latino|hispanic|illegal|border)\b/.test(lower)) return true;
  if (/\bisn'?t everyone\b/.test(lower) && group.test(text)) return true;
  if (/\baren'?t (all|everyone|most people)\b/.test(lower) && group.test(text)) return true;
  if (/\bwhy (do|are) (all|most|every)\b/.test(lower) && group.test(text)) return true;
  if (/\b(all|most) (muslims|jews|christians|mexicans|blacks|whites|asians|arabs|hindus|indians|immigrants)\s+(are|like|so|always|just|smell|stink)\b/i.test(lower)) return true;
  if (/\bdo (all|most) (muslims|jews|christians|hindus|indians|mormons)\b/i.test(lower)) return true;
  if (/\b(is|are) (all|most) (muslims|jews|christians|hindus|mexicans|indians)\b/i.test(lower)) return true;
  // Degrading "brown people" / curry stereotypes aimed at South Asians
  if (/\b(curry|indians?|hindus?|pajeets?|jeets?)\s+(smell|stink|reek)\b/i.test(lower)) return true;
  if (/\b(smell|stink|reek)s?\s+(like|of)\s+curry\b/i.test(lower)) return true;
  // Racialized “brown people” bait / UK meme patterns (desktop list)
  if (matchesPhraseOrWordBoundaries(lower, 'soft spot for brown people')) return true;
  if (matchesPhraseOrWordBoundaries(lower, 'brown spot for') && matchesPhraseOrWordBoundaries(lower, 'brown people')) return true;
  if (matchesPhraseOrWordBoundaries(lower, 'many such cases') && (/\buk\b/i.test(lower) || matchesPhraseOrWordBoundaries(lower, 'united kingdom'))) return true;
  return false;
}

// Psychiatric / disability slurs and using clinical terms as insults — gv-general → off-topic (no safe-context bypass).
// Not applied to idiom-only "lunatic(s)" here; OFF_TOPIC_SAFE_PHRASES still shields that phrase from *other* off-topic lists.
const MEDICAL_PSYCH_INSULT_SUBSTRINGS = [
  'schizo', 'schizophren', 'schizoaffective',
  'psychopath', 'psychotic', 'psychosis', 'sociopath',
  // Banter allowlist: plain "retard"/"retarded"/"fucktard" are allowed in gv-general.
  // Keep political-derivative slurs blocked here.
  'libtard', 'conservatard', // leetspeak variants partly caught by normalizeForMatch in check below
  'autist', 'autistic', 'asperger', 'aspie', 'tism',
  'manic', 'maniac',
  'delusional', 'delusion',
  'delulu', 'dilulu', 'telulu', 'sir delulu', 'miss delulu', 'mr delulu',
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

/**
 * Midland house / Legio names embed "manic" (Germanica). Faction names can glue into
 * false psych hits too ("bait Ismirs" → baitismirs → "tism"). Scrub before scan.
 */
function scrubMidlandHouseNamesForPsychScan(text) {
  let t = String(text || '');
  // Leet / spaced forms before digit→letter normalize (G3rm4nica, LegioGermanica, …)
  t = t.replace(/l[\W_]*e[\W_]*g[\W_]*i[\W_]*o[\W_]*[\s_-]*g[\W_]*[e3][\W_]*r[\W_]*m[\W_]*[a4][\W_]*n[\W_]*[i1][\W_]*c[\W_]*(?:[a4])?/gi, ' ');
  t = t.replace(/g[\W_]*[e3][\W_]*r[\W_]*m[\W_]*[a4][\W_]*n[\W_]*[i1][\W_]*c[\W_]*(?:[a4])?/gi, ' ');
  t = t.replace(/\bl[\W_]*e[\W_]*g[\W_]*i[\W_]*o\b/gi, ' ');
  // After normalizeForMatch (germanica / germanic / legiogermanica)
  t = t.replace(/legiogermanica/gi, ' ');
  t = t.replace(/germanica/gi, ' ');
  t = t.replace(/germanic/gi, ' ');
  t = t.replace(/\blegio\b/gi, ' ');
  // Midland EU / GV faction & realm names (word boundaries on spaced text)
  t = t.replace(/\bismirs?\b/gi, ' ');
  t = t.replace(/\bsangm[ae]rs?\b/gi, ' ');
  t = t.replace(/\bsangarians?\b/gi, ' ');
  t = t.replace(/\bmidlanders?\b/gi, ' ');
  t = t.replace(/\bmidland\b/gi, ' ');
  t = t.replace(/\bazebians?\b/gi, ' ');
  t = t.replace(/\bazebs?\b/gi, ' ');
  t = t.replace(/\bnordheims?\b/gi, ' ');
  return t;
}

/** Letters-only compact form with Midland house/legio/faction names removed (leet-safe). */
function compactWithoutMidlandHouseNames(text) {
  const compact = normalizeForMatch(stripDiacritics(String(text || '').toLowerCase()))
    .replace(/[^a-z]/g, '');
  return compact
    .replace(/legiogermanica/g, '')
    .replace(/germanica/g, '')
    .replace(/germanic/g, '')
    .replace(/legio/g, '')
    .replace(/ismirs?/g, '')
    .replace(/sangmars?/g, '')
    .replace(/sangmirs?/g, '')
    .replace(/sangarians?/g, '')
    .replace(/midlanders?/g, '')
    .replace(/midland/g, '')
    .replace(/azebians?/g, '')
    .replace(/azebs?/g, '')
    .replace(/nordheims?/g, '');
}

/** "tism" autism shorthand — token-only so "bait Ismirs" cannot span into baitismirs. */
function tokenHasTismInsult(text) {
  const tokens = normalizeForMatch(stripDiacritics(String(text || '').toLowerCase()))
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  for (const t of tokens) {
    if (t === 'tism' || t === 'tisms') return true;
    // autism / autistic (autist* also caught by MEDICAL substring list)
    if (t.startsWith('auti') && t.includes('tism')) return true;
  }
  return false;
}

function hasMedicalPsychiatricInsult(text) {
  if (!text || typeof text !== 'string') return false;

  // Authoritative path for manic/maniac: house names removed from letter-compact text.
  // This catches HOUSE GERMANICA, G3rm4nica, zero-width/punctuated forms, etc.
  const compactNoHouse = compactWithoutMidlandHouseNames(text);

  // Scrubbed views for other psych substrings / spaced phrases
  const lower = scrubMidlandHouseNamesForPsychScan(stripDiacritics(text.toLowerCase()));
  const normalized = scrubMidlandHouseNamesForPsychScan(normalizeForMatch(lower));
  const compact = normalized.replace(/[^a-z]/g, '');

  for (const sub of MEDICAL_PSYCH_INSULT_SUBSTRINGS) {
    const subNorm = normalizeForMatch(sub);
    const subCompact = subNorm.replace(/[^a-z]/g, '');

    // manic / maniac only via house-scrubbed compact (Germanica false positive)
    if (subCompact === 'manic' || subCompact === 'maniac') {
      if (subCompact.length >= 3 && compactNoHouse.includes(subCompact)) return true;
      continue;
    }

    // tism: never full-message compact (bait+Ismirs → baitismirs)
    if (subCompact === 'tism') {
      if (tokenHasTismInsult(text)) return true;
      continue;
    }

    if (lower.includes(sub)) return true;
    if (subNorm.length >= 3 && normalized.includes(subNorm)) return true;
    if (subCompact.length >= 3 && compactNoHouse.includes(subCompact)) return true;
    if (sub.includes(' ') && sub.replace(/\s+/g, '').length >= 5 && compact.includes(sub.replace(/\s+/g, ''))) {
      return true;
    }
  }
  return false;
}
console.log('Medical/psychiatric: Germanica/Legio + Midland faction scrub ON (manic/tism false-positive guard)');
console.log(`Medical/psychiatric insult substrings: ${MEDICAL_PSYCH_INSULT_SUBSTRINGS.length} (banter allowlist excludes retard/retarded).`);

// Anti-Indian / South-Asian racist slurs & degrading meme terms — no safe-context bypass; evasion-resistant compact scan.
const INDIAN_ASIAN_SLUR_SUBSTRINGS = [
  'pajeet', 'pajeets', 'poojeet', 'poojeets', 'poopjeet', 'poopjeets', 'poogeet',
  'jeetcel', 'jeetcels', 'jeetmax', 'jeetmaxx', 'jeetmaxxing',
  'curry muncher', 'currymuncher', 'curry-muncher', 'currymunchers',
  'dot head', 'dothead', 'dot-head', 'dot heads', 'dotheads',
  'designated shitting', 'designated shitter', 'designated shit', 'designated shitting street',
  'street shitter', 'street shitting', 'street shit', 'street pooper',
  'shit skin', 'shitskin', 'shit-skin',
  'bobs and vagene', 'bobs and vagen', 'send bobs', 'send bob',
  'cow piss', 'cow urine', 'cow worshiper', 'cow worshipper',
  'open defecat', 'open defecation',
  'indian rapist', 'rapist indian', 'indians are rapists', 'indian scammers',
  'go back to india', 'go back to your curry', 'curry people',
  'smell like curry', 'reeks of curry', 'stinks of curry',
  'typical indian', 'typical pajeet',
].map((s) => s.toLowerCase());

/** Leet / punctuation variants for pajeet·jeet (checked on normalized + compact text). */
const INDIAN_ASIAN_SLUR_TOKEN_RES = [
  /\bp+[a@4]+j+[e3]+[e3]+t+s?\b/i,
  /\bpoo+j+[e3]+t+s?\b/i,
  /\bj+[e3]+[e3]+t+s?\b/i,
  /\bjeets?\b/i,
];

function compactIncludesIndianAsianSlurToken(compact) {
  if (!compact) return false;
  if (compact.includes('pajeet') || compact.includes('poojeet') || compact.includes('poopjeet')) return true;
  if (/(?:^|[^a-z])p+a+j+e+e+t+(?:s)?(?:[^a-z]|$)/.test(compact)) return true;
  if (/(?:^|[^a-z])p+o+o+j+e+e+t+(?:s)?(?:[^a-z]|$)/.test(compact)) return true;
  // Spaced / punctuated typing: j e e t, j.e.e.t
  if (/(?:^|[^a-z])j+e+e+t+(?:s)?(?:[^a-z]|$)/.test(compact)) return true;
  if (compact.includes('currymuncher') || compact.includes('dothead')) return true;
  if (compact.includes('designatedshitting') || compact.includes('designatedshitter')) return true;
  if (compact.includes('streetshitter') || compact.includes('streetshitting')) return true;
  return false;
}

function hasIndianAsianRaceSlur(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  const normalized = normalizeForMatch(lower);
  const compact = normalized.replace(/[^a-z]/g, '');

  for (const sub of INDIAN_ASIAN_SLUR_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
    const subNorm = normalizeForMatch(sub);
    if (subNorm.length >= 4 && normalized.includes(subNorm)) return true;
    if (sub.includes(' ') && sub.replace(/\s+/g, '').length >= 5 && compact.includes(sub.replace(/\s+/g, ''))) {
      return true;
    }
  }

  for (const re of INDIAN_ASIAN_SLUR_TOKEN_RES) {
    if (re.test(lower) || re.test(normalized)) return true;
  }
  if (compactIncludesIndianAsianSlurToken(compact)) return true;

  // Slur usage of "jeet" as a label (e.g. "Heard you were a Jeet") — not bare names in neutral sentences.
  if (
    /\b(?:a|the|some|that|another|typical|fucking|fcking|f+ing|damn)\s+jeets?\b/i.test(lower)
    || /\b(?:you|u|ur|ya|he|she|they|we)(?:\s*(?:'re|r|are|were|was))?\s+(?:a|the|some|that|another|typical)?\s*jeets?\b/i.test(lower)
    || /\bjeets?\s+(?:ass|behavior|behaviour|energy|moment|move|brain|logic)\b/i.test(lower)
  ) {
    return true;
  }

  // Degrading generalizations targeting Indians / Hindus / South Asians.
  if (/\b(all|most|every)\s+(indians?|hindus?|pajeets?|jeets?)\s+(are|like|smell|stink|always)\b/i.test(lower)) {
    return true;
  }
  if (/\b(indians?|hindus?)\s+(are|smell|stink|always)\s+(dirty|filthy|stupid|disgusting|gross|trash|subhuman|rapists?|scammers?|smelly)\b/i.test(lower)) {
    return true;
  }
  if (
    /\b(stupid|dirty|filthy|smelly|gross|disgusting|trash|subhuman|inbred|rapist|scammer)\s+(indians?|hindus?|pajeets?|jeets?)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}
console.log(`Indian/Asian racist slur substrings: ${INDIAN_ASIAN_SLUR_SUBSTRINGS.length} (+ jeet/pajeet compact evasion).`);

// Harassment / race-bait with evasion-resistant normalization ("de lusional", "d3lusional", "SirDelulu", etc.).
// Same rules for all users — routed to hold/off-topic flow with no safe-context bypass.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
function multisetOverlapCount(a, b) {
  const count = new Map();
  for (const ch of b) count.set(ch, (count.get(ch) || 0) + 1);
  let overlap = 0;
  for (const ch of a) {
    const n = count.get(ch) || 0;
    if (n > 0) {
      overlap++;
      count.set(ch, n - 1);
    }
  }
  return overlap;
}
// Words that fuzzy-match "delusion" by letter overlap/edit distance but are normal English (e.g. mod talk "deleting messages").
const DELUSION_FUZZY_EXCLUDE_TOKENS = new Set([
  'delete', 'deletes', 'deleting', 'deleted', 'deletion',
  'deliver', 'delivers', 'delivering', 'delivered', 'delivery',
]);

function looksLikeDelusionVariant(text, strict) {
  const cleaned = stripDiacritics(normalizeForMatch(text).toLowerCase());
  const tokens = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
  const targets = ['delusion', 'delusional', 'delulu', 'dilusion', 'dilusional', 'deulusion'];
  const compact = cleaned.replace(/[^a-z]/g, '');
  // Compact regex catches spaced/separated/stretched variants:
  // "d e l u l u", "deeeluluuu", "delulululu", "de_lu_lu", etc.
  if (/(?:^|[^a-z])d[e]+l+u+l+u+(?:[^a-z]|$)/i.test(cleaned)) return true;
  if (/d[e]+l+u+l+u+/.test(compact)) return true;
  for (const tok of tokens) {
    const t = tok.replace(/[^a-z]/g, '');
    if (!t) continue;
    if (DELUSION_FUZZY_EXCLUDE_TOKENS.has(t)) continue;
    // "discussion" → normalizeForMatch collapses ss → "discusion", which falsely scored like "delusion"
    // (overlap + edit distance). Delusion slurs/evasions do not use the English discuss- stem — skip it.
    if (t.startsWith('discus')) continue;
    if (targets.some((x) => t.includes(x))) return true;
    if (t.length < 6 || t.length > 18) continue;
    const overlap = multisetOverlapCount(t, 'delusion');
    const minDist = Math.min(
      editDistance(t, 'delusion'),
      editDistance(t, 'delusional'),
      editDistance(t, 'delulu'),
    );
    const hasCore =
      t.includes('delu')
      || t.includes('lusi')
      || /d[e]+l+u+l+u+/.test(t)
      || (t.includes('del') && t.includes('usi'));
    // Overlap/edit-distance alone must not fire (e.g. "decisions" ≈ delusion); require delu/lusi core.
    if (overlap >= 6 && hasCore && minDist <= 3) return true;
    if (strict && overlap >= 5 && hasCore && minDist <= 4) return true;
  }
  return false;
}
function hasHarassmentRaceBaitEvasion(text, authorId) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  const normalized = normalizeForMatch(lower);
  const compact = normalized.replace(/[^a-z]/g, '');
  const strict = String(authorId) === DELUSION_STRICT_USER_ID;

  // Delusion insults (clinical + meme slang / handles): SirDelulu, Sir_Delulu, s i r d e l u l u → compact delulu
  const hasDelusional =
    looksLikeDelusionVariant(lower, strict) ||
    compact.includes('delusional') ||
    compact.includes('delusion') ||
    compact.includes('delulu') ||
    compact.includes('delul') ||
    compact.includes('delulz') ||
    compact.includes('delulut') ||
    compact.includes('deluloo') ||
    compact.includes('dilulu') ||
    compact.includes('telulu') ||
    compact.includes('dilusion') ||
    compact.includes('deulusion') ||
    compact.includes('dilusional') ||
    /d[e]+l+u+l+u+/.test(compact) ||
    lower.includes('sir delulu') ||
    lower.includes('miss delulu') ||
    lower.includes('mr delulu') ||
    lower.includes('missus delulu');

  const hasBigFella = lower.includes('big fella') || compact.includes('bigfella');
  const hasBlackPlaguePlayer =
    lower.includes('black plague player') ||
    (lower.includes('black plague') && lower.includes('player')) ||
    compact.includes('blackplagueplayer');

  return hasDelusional || hasBigFella || hasBlackPlaguePlayer;
}

// Real-world geopolitical keywords (POLITICAL_EXTRA-style + close variants). Runs BEFORE safe-context so "guilds + NATO" still → #off-topic (random GIF, same as religion/politics).
const GEOPOLITICAL_HARD_SUBSTRINGS = [
  'nato', 'sanctions', 'sanctioned', 'sanction ',
  'invasion', 'invade',
  'regime',
  'geopolitical', 'embargo', 'embargoes',
  'intervention', 'annexation', 'insurgency',
  'war crime', 'war crimes',
  // Middle East / current-conflict phrasing: hard redirect (independent of ratio thresholds)
  'middle east', 'middle-east',
  'iran', 'iraq', 'israel', 'gaza', 'palestine',
].map(s => s.toLowerCase());

/** UN / U.N. — dotted u.n., uppercase UN, or "un + institution" phrases; not French article "un" in oui-un-peu. */
const GEOPOLITICAL_UN_RE = /\b(?:the\s+)?u\.n\.|\bunited\s+nations\b|\bun\s+security\b|\bun\s+general\b|\bun\s+council\b|\bun\s+vote\b|\bun\s+resolution\b|\bun\s+peacekeeping\b/i;
const GEOPOLITICAL_UN_ACRONYM_RE = /\bUN\b/;

function hasGeopoliticalHardRedirect(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  // Directed conflict framing around Middle East should always route away from gv-general.
  if (/\bfight(?:ing)?\s+(?:in|for|over)\s+the\s+middle[\s-]+east\b/i.test(lower)) return true;
  if (/\bwar\s+(?:in|for|over)\s+the\s+middle[\s-]+east\b/i.test(lower)) return true;
  for (const s of GEOPOLITICAL_HARD_SUBSTRINGS) {
    const term = s.trim();
    if (!term) continue;
    // Match as terms/phrases, not as substrings inside larger words/URLs (e.g. "anatomy" must not hit "nato").
    const termRe = new RegExp(`\\b${escapeRegex(term).replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (termRe.test(lower)) return true;
  }
  // "sanction" at word start / after space (sanctioning, sanctions already caught)
  if (/\bsanction/i.test(text)) return true;
  if (/\bstates\b/.test(lower)) return true;
  if (GEOPOLITICAL_UN_RE.test(text)) return true;
  if (GEOPOLITICAL_UN_ACRONYM_RE.test(text)) return true;
  return false;
}

/** IRL Balkans / former Yugoslavia travel & history (not GV lore). Before safe-context; skip if clearly only language-learning. */
function hasBalkansRealWorldOffTopicRedirect(text) {
  if (!text || typeof text !== 'string') return false;
  if (hasLanguageLearningContext(text)) return false;
  if (hasRunicEpigraphySafeContext(text)) return false;
  const lower = stripDiacritics(text.toLowerCase());
  const balkanSingles = ['bosnia', 'bosnian', 'bosniak', 'mostar', 'sarajevo', 'srebrenica', 'yugoslav', 'archduke'];
  if (balkanSingles.some((w) => matchesPhraseOrWordBoundaries(lower, w))) return true;
  if (matchesPhraseOrWordBoundaries(lower, 'franz ferdinand')) return true;
  if (/\b(serbia|serbian|serbs?)\b/.test(lower)) return true;
  if (/\b(croatia|croatian|croats?)\b/.test(lower)) return true;
  if (/\bbalkans?\b/.test(lower)) return true;
  if (/\b(kosovo|montenegro|skopje|tirana|belgrade|beograd|ljubljana)\b/.test(lower)) return true;
  if (/\bbosnian\s+serb\b|\bserb\s+nationalist\b|\bnationalist\s+serb\b/.test(lower)) return true;
  return false;
}

// Check if message contains any goy-related term (religion filter)
function hasGoyTerm(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  return GOY_TERMS.some((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(lower));
}

// Any Tenor link Discord embeds (any language slug; CDN hosts media1.tenor.com, etc.).
const TENOR_URL_RE = /https?:\/\/(?:[\w-]+\.)*tenor\.com(?:\/|$)|https?:\/\/tenor\.googleapis\.com\//i;
function collectTenorLinkBlob(messageOrText) {
  const parts = [];
  if (typeof messageOrText === 'string') {
    parts.push(messageOrText);
  } else if (messageOrText) {
    if (messageOrText.content) parts.push(String(messageOrText.content));
    for (const e of messageOrText.embeds || []) {
      if (e.url) parts.push(e.url);
      if (e.provider?.url) parts.push(e.provider.url);
      if (e.thumbnail?.url) parts.push(e.thumbnail.url);
      if (e.image?.url) parts.push(e.image.url);
      if (e.video?.url) parts.push(e.video.url);
    }
  }
  return parts.join(' ');
}
function messageHasTenorLink(messageOrText) {
  const blob = collectTenorLinkBlob(messageOrText);
  if (!blob) return false;
  let decoded = blob;
  try {
    decoded = decodeURIComponent(blob);
  } catch {
    decoded = blob;
  }
  return TENOR_URL_RE.test(blob) || TENOR_URL_RE.test(decoded);
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
  'nationalist', 'nationalists', 'nationalism',
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
    // Word contains the full leader name (e.g. "putins")
    if (w.includes(leader)) return true;
    // NEVER use leader.includes(word): "any" ⊂ "netanyahu", "son" ⊂ "johnson", etc.
  }
  return false;
}

// Languages / demonyms that also appear in politics filter — safe when clearly "speak/write/learn …" (not geopolitics)
const LANGUAGE_LEXICON_EXTRA = [
  'english', 'korean', 'japanese', 'spanish', 'italian', 'portuguese', 'arabic', 'hindi', 'urdu', 'latin', 'greek',
  'norwegian', 'danish', 'finnish', 'swedish', 'dutch', 'polish', 'czech', 'slovak', 'hungarian', 'romanian', 'bulgarian',
  'serbian', 'croatian', 'bosnian', 'slovenian', 'albanian', 'macedonian', 'lithuanian', 'latvian', 'estonian', 'icelandic',
  'welsh', 'scottish', 'gaelic', 'catalan', 'basque', 'galician', 'maltese', 'hebrew', 'farsi', 'mandarin', 'cantonese',
  'old norse',
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

/**
 * "Danger" / "dangerous" in Gloria Victis or clear fantasy framing (enemy nations, evil forces, faction names).
 * Lets gv-general allow e.g. "danger to evil people", "danger to Sangmar" / sangmir typo, without treating "danger" as real-world politics.
 */
function hasGameDangerLoreContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  if (!/\bdanger(ous)?\b/.test(lower)) return false;
  if (
    /\b(sangmar|sangmir|midland|midlanders|azebia|azebs|nordheim|ismirs?|sangarians|gloria victis|\bgv\b|in[- ]game|ingame|mmorpg|nation|nations|guild|guilds|siege|faction|lore|npc|boss|realm|enemy|empire|emperor|khagan|forefather|greatfather|zenith|sangmar empire)\b/i.test(lower)
  ) {
    return true;
  }
  if (/\bdanger\s+to\s+evil\b/i.test(lower)) return true;
  if (/\bevil\s+(people|king|queen|empire|nation|forces|lords?|villains?|npcs?)\b/i.test(lower)) return true;
  if (/\bdanger\s+to\s+(the\s+)?(?:enemy|faction|realm|nation)\b/i.test(lower)) return true;
  return false;
}

/** Directed "you're a danger" / "danger to players" (real users or IRL) — not bypassed by game-danger lore. */
function hasDangerFramingTargetPlayersOrHumans(text) {
  if (!text || typeof text !== 'string') return false;
  if (hasGameDangerLoreContext(text)) return false;
  const lower = stripDiacritics(text.toLowerCase());
  if (!/\bdanger(ous)?\b/.test(lower)) return false;
  if (/\b(you'?re|you\s+are|u\s+r|ur)\s+a\s+danger\b/i.test(lower)) return true;
  if (/\bdanger\s+to\s+(?:all\s+|the\s+)?people\b/i.test(lower)) return true;
  if (/\bdanger\s+to\s+(you|u|players?|everyone|someone|anyone|humans?|irl|the\s+community|this\s+community|other\s+players?)\b/i.test(lower)) return true;
  if (/\b(players?|people|everyone)\s+are\s+a\s+danger\b/i.test(lower)) return true;
  return false;
}

// When true (default): gv-general skips English-centric holds (off-topic phrase bag, religion/politics ratio, geopolitical, …)
// for messages that look primarily non–English casual chat. Serious slurs (hasSpamSlur) still apply first.
const MULTILINGUAL_BANTER_BYPASS =
  process.env.MULTILINGUAL_BANTER_BYPASS !== '0' && process.env.MULTILINGUAL_BANTER_BYPASS !== 'false';

const MULTILINGUAL_FUNCTION_WORDS = new Set(
  [
    // French
    'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est', 'que', 'qui', 'quoi', 'dont', 'ou', 'où',
    'pas', 'pour', 'dans', 'sur', 'avec', 'sous', 'chez', 'vers', 'entre', 'par', 'sans', 'mais', 'donc', 'car',
    'ce', 'ces', 'cette', 'cet', 'cela', 'ca', 'ça', 'celui', 'celle', 'ceux', 'celles', 'comme', 'aussi', 'alors',
    'tres', 'très', 'plus', 'moins', 'bien', 'tout', 'tous', 'toute', 'toutes', 'rien', 'jamais', 'toujours', 'encore',
    'nous', 'vous', 'ils', 'elles', 'je', 'tu', 'il', 'elle', 'on', 'mon', 'ton', 'son', 'ma', 'ta', 'sa', 'mes', 'tes', 'ses',
    'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'au', 'aux', 'du', 'des', 'en', 'y', 'ne', 'ni', 'meme', 'même',
    'fait', 'faire', 'suis', 'es', 'est', 'sommes', 'etes', 'êtes', 'sont', 'ai', 'as', 'a', 'avons', 'avez', 'ont',
    'ete', 'été', 'dis', 'dit', 'voir', 'sais', 'peux', 'dois', 'veux', 'peut', 'doit', 'veut', 'quand', 'comment', 'pourquoi',
    'parce', 'quel', 'quelle', 'quels', 'quelles', 'chose', 'choses', 'autre', 'autres', 'deja', 'déjà', 'ici', 'la', 'là',
    // Spanish
    'el', 'los', 'las', 'una', 'unos', 'unas', 'del', 'al', 'y', 'o', 'pero', 'sino', 'como', 'muy', 'mas', 'más', 'menos',
    'hay', 'soy', 'eres', 'somos', 'sois', 'esta', 'está', 'están', 'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'aqui', 'aquí',
    'porque', 'cuando', 'donde', 'dónde', 'quien', 'quién', 'algo', 'nada', 'tambien', 'también', 'solo', 'sólo', 'ya',
    // German
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'und', 'oder', 'aber', 'nicht',
    'ist', 'sind', 'bin', 'bist', 'war', 'waren', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mit', 'von', 'zu', 'auf',
    'aus', 'bei', 'nach', 'über', 'auch', 'nur', 'noch', 'schon', 'schön', 'wie', 'was', 'wenn', 'dann', 'hier', 'da',
    // Italian
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'non',
    'che', 'chi', 'questo', 'questa', 'quello', 'quella', 'sono', 'sei', 'siamo', 'siete', 'molto', 'piu', 'più', 'cosi',
    'così', 'qui', 'qua', 'anche', 'solo', 'gia', 'già',
    // Portuguese
    'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'à', 'às',
    'em', 'por', 'para', 'com', 'sem', 'nao', 'não', 'que', 'se', 'eu', 'ele', 'ela', 'nos', 'você', 'voces', 'vocês',
    'muito', 'mais', 'menos', 'bem', 'mal', 'aqui', 'lá', 'então', 'também',
    // Dutch
    'het', 'een', 'van', 'en', 'in', 'op', 'met', 'zijn', 'ben', 'bent', 'is', 'was', 'waren', 'ik', 'jij', 'je', 'hij',
    'zij', 'wij', 'jullie', 'niet', 'ook', 'nog', 'wel', 'maar', 'of', 'als', 'dan', 'om', 'bij', 'uit', 'te', 'naar',
    // Polish (ASCII-heavy; needs token hits + optional script check)
    'w', 'z', 'na', 'do', 'od', 'i', 'nie', 'ze', 'jak', 'co', 'to', 'tu', 'tam', 'czy', 'bardzo', 'bardziej', 'jest',
    'jestem', 'sa', 'są', 'się', 'mnie', 'mną', 'mi', 'ci', 'go', 'je', 'ich', 'nam', 'was',
  ].map((w) => stripDiacritics(w.toLowerCase())),
);

/**
 * Heuristic: message is primarily casual chat in a non-English language (French, Spanish, DE/IT/PT/NL/PL, …).
 * Used to skip English-only moderation lists that false-positive on harmless banter.
 */
function isPrimarilyNonEnglishCasualChat(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;

  let extendedScriptChars = 0;
  let asciiLetters = 0;
  for (const ch of trimmed) {
    if (/[A-Za-z]/.test(ch)) asciiLetters++;
    // Latin Extended, Cyrillic, Greek, CJK, Hangul, etc.
    if (/[\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF\u0500-\u052F\u0370-\u03FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) {
      extendedScriptChars++;
    }
  }
  if (extendedScriptChars >= 3) return true;

  const lower = stripDiacritics(trimmed.toLowerCase());
  // Split on spaces and apostrophes so French c'est, d'un, j'ai → est, un, ai, …
  const tokens = lower
    .split(/[\s\u2019']+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
    .filter(Boolean);
  if (tokens.length < 3) return false;

  let fnHits = 0;
  for (const w of tokens) {
    if (MULTILINGUAL_FUNCTION_WORDS.has(w)) fnHits++;
  }
  const ratio = fnHits / tokens.length;
  if (ratio >= 0.28) return true;
  if (fnHits >= 4 && ratio >= 0.2) return true;

  return false;
}

// GV server shards + nationality labels used for server hopping / zerg callouts (not IRL geopolitics).
const GV_SERVER_SHARD_RE = /\b(wolfield|wolfied|wolfi|aquill?a|dukla)\b/i;
const SERVER_HOP_GAME_TERMS_RE =
  /\b(army|guild|guilds|players?|zerg|zergs|raid|raids|siege|take|took|taken|hop|hopping|hoppers|server|servers|shard|shards|online|pop|population|group|groups|alliance|alliances|war|pvp|attack|defend|defense|defence|push|wiped|wipe|logged|log\s*in)\b/i;
const SERVER_HOP_DEMONYNMS = new Set([
  'chinese', 'china', 'korean', 'korea', 'japanese', 'japan', 'american', 'america', 'british', 'french', 'german',
  'russian', 'russia', 'polish', 'poland', 'swedish', 'sweden', 'dutch', 'italian', 'italy', 'spanish', 'spain',
  'brazilian', 'brazil', 'indian', 'india', 'pakistani', 'pakistan', 'iranian', 'iran', 'israeli', 'turkish',
  'ukrainian', 'taiwanese', 'taiwan', 'mexican', 'mexico', 'canadian', 'canada', 'australian', 'australia',
  'european', 'eu', 'na', 'sea', 'oce', 'oceania',
].map((w) => w.toLowerCase()));

/** Nationality/region + in-game force talk, GV shard names, or player-count zerg posts. */
function hasGvServerShardOrRegionPlayerContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());

  if (GV_SERVER_SHARD_RE.test(lower)) return true;
  if (/\bserver\s*hop(?:ping|pers?)?\b/i.test(lower)) return true;
  if (/\b\d+\+?\s*players?\b/i.test(lower) && SERVER_HOP_GAME_TERMS_RE.test(lower)) return true;

  if (
    /\b(chinese|korean|japanese|american|british|french|german|russian|polish|swedish|eu|na|sea|oce)\s+(army|guild|zerg|group|raid|players?)\b/i.test(lower)
  ) {
    return true;
  }

  if (SERVER_HOP_GAME_TERMS_RE.test(lower)) {
    for (const dem of SERVER_HOP_DEMONYNMS) {
      if (matchesPhraseOrWordBoundaries(lower, dem)) return true;
    }
  }

  return false;
}

function shouldSkipPoliticalDemonymForServerHop(fullText, word) {
  if (!SERVER_HOP_DEMONYNMS.has(cleanModerationToken(word))) return false;
  return hasGvServerShardOrRegionPlayerContext(fullText);
}

// If message contains any safe-context word (game/community talk), don't trigger
function hasSafeContext(text) {
  if (!text || typeof text !== 'string') return false;
  if (isGvCharacterStatMessage(text)) return true;
  if (hasGvServerShardOrRegionPlayerContext(text)) return true;
  if (hasRunicEpigraphySafeContext(text)) return true;
  const normalizedRunes = normalizeRunesForContextScan(text);
  if (hasLanguageLearningContext(text) || hasLanguageLearningContext(normalizedRunes)) return true;
  const lower = stripDiacritics(normalizedRunes.toLowerCase());
  for (const word of SAFE_CONTEXT_WORDS) {
    if (lower.includes(word)) return true;
  }
  if (hasGameDangerLoreContext(text) || hasGameDangerLoreContext(normalizedRunes)) return true;
  return false;
}

function messageContainsIdeologicalPhrase(text) {
  if (!text || typeof text !== 'string') return false;
  return IDEOLOGICAL_PHRASES.some((p) => matchesPhraseOrWordBoundaries(text, p));
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
  return RELIGION_POLITICS_PHRASES.some((p) => matchesPhraseOrWordBoundaries(text, p));
}

/** Obvious religious discussion — do not treat "god" as casual if these appear. */
function hasStrongReligionMarker(text) {
  const lower = stripDiacritics(text.toLowerCase());
  const markers = [
    'church', 'mosque', 'synagogue', 'temple', 'bible', 'quran', 'koran', 'gospel', 'torah', 'talmud',
    'jesus', 'christ', 'christian', 'muslim', 'islam', 'jewish', 'judaism', 'allah',
    'pray', 'prayer', 'prayers', 'worship', 'sermon', 'pastor', 'priest', 'imam', 'rabbi', 'agnostic',
    'sacrament', 'communion', 'eucharist',
  ];
  if (markers.some((m) => matchesPhraseOrWordBoundaries(lower, m))) return true;
  // Prefix stems (buddhist, atheist, baptism, hinduism) — word-start only, not embedded in unrelated tokens
  if (/\bbuddh\w*/i.test(lower)) return true;
  if (/\batheis\w*/i.test(lower)) return true;
  if (/\bbaptis\w*/i.test(lower)) return true;
  if (/\bhindu\w*/i.test(lower)) return true;
  return false;
}

/** "God" as exclamation / filler (not theology) — e.g. "god would it be gross". */
function isCasualGodInterjection(text) {
  const lower = stripDiacritics(text.toLowerCase());
  return (
    /\bgod[,!]/i.test(lower)
    || /\bgod\s+(would|that's|that is|damn|dammit|this|it|what|i|we|you)\b/i.test(lower)
    || /\boh\s+god\b/i.test(lower)
    || /\bmy\s+god\b/i.test(lower)
    || /\bfor\s+god'?s\s+sake\b/i.test(lower)
  );
}

/** Combat / GV mechanics context so religion filter ignores casual "god". */
function hasGameplayCombatContext(text) {
  const lower = stripDiacritics(text.toLowerCase());
  return (
    /\b(weapon|weapons|damage|swing|stab|slash|block|parry|shield|sword|mace|axe|bow|spear|polearm|dagger|backstab|hitting)\b/i.test(lower)
    || /\b(light|heavy)\s+(armou?r)\b/i.test(lower)
    || /\b(hit|hits|behind|pvp|combat|duel|fight|fighting|siege|loot|looting)\b/i.test(lower)
    || /\b(party|parties|alliance|alliances|guild|guilds|nation|nations)\b/i.test(lower)
    || /\b(glory|reputation|tier\s*[0-9]|non-targeting|character|stats)\b/i.test(lower)
    || /\b(constitution|strength|dexterity|agility|vitality|endurance|attribute|attributes)\b/i.test(lower)
    || /\bgloria\s+victis\b|\bgv\b/i.test(lower)
  );
}

/** Skip counting token "god"/"gods" toward religion ratio when clearly game talk + casual usage. */
function shouldSkipReligionGodToken(fullText, word) {
  const w = (word || '').toLowerCase();
  if (w !== 'god' && w !== 'gods') return false;
  if (hasStrongReligionMarker(fullText)) return false;
  const lower = stripDiacritics(fullText.toLowerCase());
  if (/\bgod\s*(tier|roll|rng)\b/i.test(lower) && hasGameplayCombatContext(fullText)) return true;
  if (isCasualGodInterjection(fullText) && hasGameplayCombatContext(fullText)) return true;
  return false;
}

/**
 * "abbey" is in words.txt (monastery), but Midland/GV often means a party/guild name
 * ("abbey party", req calls). Skip unless clearly religious abbey context.
 */
function shouldSkipReligionAbbeyToken(fullText, word) {
  const w = (word || '').toLowerCase();
  if (w !== 'abbey' && w !== 'abbeys' && w !== 'abbot') return false;
  const lower = stripDiacritics(fullText.toLowerCase());
  if (/\b(monk|monks|monastery|monasteries|cathedral|chapel|nun|nuns|vatican|pilgrim|pilgrimage|catholic|cistercian|benedictine)\b/i.test(lower)) {
    return false;
  }
  if (hasGameplayCombatContext(fullText)) return true;
  if (/\b(party|parties|guild|guilds|req|shotcall|shotcaller|siege|raid|north|south|discord|nation|nations|faction)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/** Bare "war" is too common (game PvP + "declare a war on me"). Real conflict uses harder terms. */
function shouldSkipReligionWarToken(fullText, word) {
  const w = (word || '').toLowerCase();
  if (w !== 'war' && w !== 'wars') return false;
  const lower = stripDiacritics(fullText.toLowerCase());
  if (/\bwar\s+crimes?\b/i.test(lower)) return false;
  if (/\bwar\s+(?:in|for|over)\s+(?:the\s+)?(?:middle[\s-]+east|ukraine|gaza|israel|iraq|iran|syria)\b/i.test(lower)) {
    return false;
  }
  return true;
}

// Combined: should we treat message as religion/politics (ratio, ideological phrase, or obvious religion/politics phrase)
function shouldTriggerReligionPolitics(text) {
  if (!text || typeof text !== 'string') return false;
  if (isGvCharacterStatMessage(text)) return false;
  if (hasGvServerShardOrRegionPlayerContext(text)) return false;
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
// nation / nations — GV faction chat ("nation chat", "which nation"); words.txt lists bare "nation" as political otherwise.
// danger / dangerous — common in GV (NPCs, nations, combat); not political by themselves (see hasGameDangerLoreContext).
// constitution / strength / dexterity — GV character attributes; words.txt may list "constitution" as political otherwise.
const TRIGGER_WORD_IGNORE = new Set([
  ...['good', 'goods', 'mod', 'mods', 'nation', 'nations', 'danger', 'dangerous', 'war', 'wars'].map((w) => w.toLowerCase()),
  ...GV_CHARACTER_STAT_WORDS,
  ...REGION_OR_SERVER_ZONE_WORDS,
]);
function cleanModerationToken(word) {
  return String(word || '').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
}
function wordMatchesTriggerWord(word) {
  if (!word) return false;
  if (TRIGGER_WORD_IGNORE.has(cleanModerationToken(word))) return false;
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
  const normalized = normalizeForMatch(lower);
  return GOY_TERMS.some((term) => {
    const tn = normalizeForMatch(term);
    return lower === term || normalized === term || lower === tn || normalized === tn;
  });
}

/** Returns true if message is mostly (≥80%) trigger words, or has ≥2 trigger words (catches e.g. "killing Muslims is based"). */
function isMostlyReligionPolitics(text) {
  const words = tokenizeWords(text);
  if (words.length < RELIGION_POLITICS_MIN_WORDS) return false;
  let triggerCount = 0;
  for (const w of words) {
    if (shouldSkipPoliticalDemonymForServerHop(text, w)) continue;
    if (shouldSkipReligionGodToken(text, w)) continue;
    if (shouldSkipReligionAbbeyToken(text, w)) continue;
    if (shouldSkipReligionWarToken(text, w)) continue;
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
  const lower = stripDiacritics(text.toLowerCase()).trim();
  if (!lower.includes('miaow')) return false;
  return MIAOW_WHERE_PHRASES.some(phrase => lower.includes(phrase));
}

/** Miðland role check — fetch member when guild member cache is tiny (GUILD_MEMBER_CACHE_MAX_SIZE). */
async function memberHasMiaowTriggerRole(message) {
  let member = message.member;
  if (!member && message.guild) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  return Boolean(member?.roles?.cache?.has(MIAOW_TRIGGER_ROLE_ID));
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
  const raw = message.content ? String(message.content) : '';
  const stripped = stripOuterQuotesForGeneral(raw.trim()) || raw;
  let t = stripped;
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

/** True if message text/embeds/attachments reference a blocked Tenor/GIF id (substring match). Tenor view links are always allowed. */
function messageHasBlockedMediaId(message) {
  if (!BLOCKED_MEDIA_IDS.length) return false;
  if (messageHasTenorLink(message)) return false;
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

function attachmentBasename(name) {
  return String(name || '').trim().replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function sortedHashMultiset(hashes) {
  return [...hashes].map((h) => h.toLowerCase()).sort();
}

function hashMultisetMatchesKnown(messageHashes, knownHashes) {
  if (messageHashes.length !== 4 || knownHashes.length !== 4) return false;
  const a = sortedHashMultiset(messageHashes);
  const b = sortedHashMultiset(knownHashes);
  return a.every((h, i) => h === b[i]);
}

/** Filename: exactly four attachments named 1.jpg … 4.jpg (or .png). */
function fourImageScamFilenameNumbered(message) {
  const atts = message.attachments;
  if (!atts || atts.size !== 4) return false;
  const nums = new Set();
  for (const a of atts.values()) {
    const m = attachmentBasename(a.name).match(FOUR_IMAGE_SCAM_NAME_RE);
    if (!m) return false;
    nums.add(m[1]);
  }
  return nums.size === 4;
}

/** Filename: ≥2 attachments, each named image.jpg (Discord duplicate names). */
function fourImageScamFilenameDuplicateImage(message) {
  const atts = message.attachments;
  if (!atts || atts.size < FOUR_IMAGE_SCAM_MIN_DUPLICATE_ATTACHMENTS) return false;
  for (const a of atts.values()) {
    if (attachmentBasename(a.name) !== FOUR_IMAGE_SCAM_DUPLICATE_NAME) return false;
  }
  return true;
}

function detectFourImageScamFilenames(message) {
  if (fourImageScamFilenameNumbered(message)) return 'numbered-1-4';
  if (fourImageScamFilenameDuplicateImage(message)) return 'four-image-jpg';
  return null;
}

async function sha256FromAttachmentUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'DiscordBot (GV-LegacyGeneralMod)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Content hash: full 4-set match, or ≥2 attachments whose hashes are all from a known scam set. */
async function detectFourImageScamHashes(message) {
  if (!FOUR_IMAGE_SCAM_HASH_SETS.length) return null;
  const atts = message.attachments;
  if (!atts || atts.size < FOUR_IMAGE_SCAM_MIN_DUPLICATE_ATTACHMENTS) return null;
  const hashes = [];
  for (const a of atts.values()) {
    if (a.size && a.size > FOUR_IMAGE_SCAM_HASH_MAX_BYTES) return null;
    try {
      hashes.push(await sha256FromAttachmentUrl(a.url));
    } catch (err) {
      if (DEBUG) console.warn('[four-image-scam] hash download failed:', err.message);
      return null;
    }
  }
  for (const set of FOUR_IMAGE_SCAM_HASH_SETS) {
    if (hashes.length === 4 && hashMultisetMatchesKnown(hashes, set.hashes)) return `hash:${set.id}`;
    const knownSet = new Set(set.hashes);
    if (hashes.every((h) => knownSet.has(h))) return `hash-subset:${set.id}`;
  }
  return null;
}

/** Numbered names (4 only), four× image.jpg (≥2), or known hash set. */
async function detectFourImageScam(message) {
  if (!message.attachments?.size) return null;
  const byName = detectFourImageScamFilenames(message);
  if (byName) return byName;
  return detectFourImageScamHashes(message);
}

/** Delete message with fetch/retry (Manage Messages required in that channel). */
async function deleteMessageRobust(message) {
  const channelId = message.channelId;
  const messageId = message.id;
  const tryDelete = async (msg) => {
    if (!msg?.deletable) return false;
    await msg.delete();
    return true;
  };
  try {
    if (await tryDelete(message)) return true;
  } catch (err) {
    if (DEBUG) console.warn('[four-image-scam] delete attempt 1:', err.message);
  }
  try {
    const ch = message.channel?.isTextBased()
      ? message.channel
      : await message.client.channels.fetch(channelId);
    if (!ch?.isTextBased()) return false;
    const fresh = await ch.messages.fetch(messageId);
    if (await tryDelete(fresh)) return true;
  } catch (err) {
    console.error(
      `[four-image-scam] delete failed for ${messageId} in #${channelId} — grant Manage Messages in that channel:`,
      err.message,
    );
  }
  return false;
}

/** Delete scam post and replace member roles with Court Jester only (no exemptions). */
async function handleFourImageScam(message, reason) {
  const deleted = await deleteMessageRobust(message);
  if (!deleted) {
    console.error(
      `[four-image-scam] message ${message.id} still visible in #${message.channelId} — bot needs Manage Messages there`,
    );
  }
  let member = message.member;
  if (!member && message.guild) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  if (!member) {
    console.error('[four-image-scam] could not resolve member for role punishment:', message.author.id);
    return;
  }
  try {
    await member.roles.set(
      [COURT_JESTER_ROLE_ID],
      `Uploaded blocked 4-image scam (${reason || 'unknown'})`,
    );
    console.log(`[four-image-scam] ${message.author.tag} → Court Jester only (${reason}, #${message.channelId})`);
  } catch (err) {
    console.error('[four-image-scam] Court Jester role punishment failed (check Manage Roles + role hierarchy):', err.message);
  }
}

/** Re-check when Discord may add more image.jpg attachments after the first messageCreate. */
function scheduleFourImageScamAttachmentRecheck(message) {
  const atts = message.attachments;
  if (!atts?.size || atts.size >= 4) return;
  for (const a of atts.values()) {
    if (attachmentBasename(a.name) !== FOUR_IMAGE_SCAM_DUPLICATE_NAME) return;
  }
  const { client, channelId, id: messageId, author } = message;
  setTimeout(async () => {
    try {
      if (!FOUR_IMAGE_SCAM_BLOCK) return;
      const ch = await client.channels.fetch(channelId);
      if (!ch?.isTextBased()) return;
      const fresh = await ch.messages.fetch(messageId);
      if (fresh.author.id !== author.id) return;
      const reason = await detectFourImageScam(fresh);
      if (reason) await handleFourImageScam(fresh, `${reason}-recheck`);
    } catch (err) {
      if (err?.code !== 10008 && DEBUG) console.warn('[four-image-scam] attachment recheck:', err.message);
    }
  }, 2000);
}

// gv-general only: watch one user — same text 3+ times, or too many messages in rolling window, or paste-wall → redirect;
// DM (French) when ≥10 strikes in 5 min OR ≥50 strikes in 1 h; if DM fails, ping in #miaow (French).
// Also: ≥N posts in M min in gv-general → delete each + repost to SPAM_WATCH_MIAOW_CHANNEL_ID (volume flush; defaults 20 / 20 min),
// reset when another user replies to, @mentions, or reacts to the watched user’s gv-general posts.
const SPAM_WATCH_USER_ID = String(process.env.SPAM_WATCH_USER_ID || '1409669933801144453');
const SPAM_WATCH_MIAOW_CHANNEL_ID = String(process.env.SPAM_WATCH_MIAOW_CHANNEL_ID || '1168970870287503412');
const SPAM_WATCH_GV_VOLUME_WINDOW_MS = Math.max(60_000, parseInt(process.env.SPAM_WATCH_GV_VOLUME_WINDOW_MS || String(20 * 60 * 1000), 10));
const SPAM_WATCH_GV_VOLUME_THRESHOLD = Math.max(2, parseInt(process.env.SPAM_WATCH_GV_VOLUME_THRESHOLD || '20', 10));
const SPAM_WATCH_STRIKES_FILE = path.join(process.cwd(), 'spam-watch-strikes.json');
const SPAM_WATCH_VOLUME_WINDOW_MS = Math.max(60_000, parseInt(process.env.SPAM_WATCH_VOLUME_WINDOW_MS || String(60 * 60 * 1000), 10)); // default 1h
/** Same-user message count in gv-general within SPAM_WATCH_VOLUME_WINDOW_MS (default 1h) before redirect — was hardcoded 10. */
const SPAM_WATCH_VOLUME_MSG_THRESHOLD = Math.max(2, parseInt(process.env.SPAM_WATCH_VOLUME_MSG_THRESHOLD || String(SPAM_WATCH_GV_VOLUME_THRESHOLD), 10));
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

/** Single in-memory copy + disk — avoids lost resets when reply + watched-user messages race (read-modify-write). */
let spamWatchState = loadSpamWatchState();

/** Resolve reply target; fetchReference() alone can fail on uncached / thread edge cases. */
async function fetchSpamWatchReferencedMessage(message) {
  if (!message.reference?.messageId) return null;
  try {
    let ref = await message.fetchReference().catch(() => null);
    if (ref?.partial) ref = await ref.fetch().catch(() => ref);
    if (ref?.author?.id) return ref;
  } catch (e) {
    if (DEBUG) console.warn('[spam-watch] fetchReference failed:', e.message);
  }
  const chId = message.reference.channelId || message.channelId;
  if (!chId) return null;
  try {
    const ch = await message.client.channels.fetch(chId).catch(() => null);
    if (!ch?.isTextBased()) return null;
    let m = await ch.messages.fetch(message.reference.messageId).catch(() => null);
    if (m?.partial) m = await m.fetch().catch(() => m);
    return m;
  } catch (e) {
    if (DEBUG) console.warn('[spam-watch] manual referenced message fetch failed:', e.message);
    return null;
  }
}

/** True if the message lives in gv-general (including threads under that channel). */
function isGvMainGuild(guildId) {
  return String(guildId) === GV_MAIN_GUILD_ID;
}

function isMidlandEuGuild(guildId) {
  return MIDLAND_EU_ENABLED && String(guildId) === MIDLAND_EU_GUILD_ID;
}

/** #nation-discussion, listed thread IDs, and any thread whose parent is a listed mod channel. */
function isMessageInMidlandEuModScope(message) {
  if (!message?.guild || !isMidlandEuGuild(message.guild.id)) return false;
  const channelId = String(message.channelId);
  if (MIDLAND_EU_MOD_CHANNEL_IDS.has(channelId)) return true;
  const ch = message.channel;
  if (ch && typeof ch.isThread === 'function' && ch.isThread()) {
    const parentId = String(ch.parentId);
    if (MIDLAND_EU_MOD_CHANNEL_IDS.has(parentId)) return true;
  }
  return false;
}

function isMessageInGvGeneral(message) {
  if (!isGvMainGuild(message.guild?.id)) return false;
  if (!message?.channel) return false;
  const ch = message.channel;
  if (typeof ch.isThread === 'function' && ch.isThread()) {
    return (
      String(ch.parentId) === String(TRIGGER_CHANNEL_ID)
      || String(ch.parentId) === String(GV_GENERAL_CHANNEL_ID)
    );
  }
  return (
    String(message.channelId) === String(TRIGGER_CHANNEL_ID)
    || String(message.channelId) === String(GV_GENERAL_CHANNEL_ID)
  );
}

/** Same trigger chain as gv-general moderation holds, without Soon/Miaow/Poor-Savage side effects. */
function hasMidlandEventGameplayContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = stripDiacritics(text.toLowerCase());
  const hasMidland = /\bmidland(?:ers?)?\b/i.test(lower);
  const hasFactionOrPoi =
    /\b(?:ismirs?|sangmars?|sangmirs?|sangarians?|azebs?|azebians?|nordheims?|twinfall)\b/i.test(lower);
  const hasEventTalk =
    /\b(?:events?|day|loots?|non-?loot|lz|reqs?|shotcalls?|capped|capping|siege|meetings?|organising|organizing|planning)\b/i.test(lower);
  return hasMidland && (hasFactionOrPoi || hasEventTalk);
}

function detectStandardModerationTrigger(message, gvModerationText, options = {}) {
  const csamScanText = getMessageTextForCsamScan(message);
  if (csamScanText && hasCsamGroomingTrigger(csamScanText)) return 'csam-grooming';
  if (messageHasBlockedMediaId(message)) return 'blocked-media';
  if (!message.content && !messageHasTenorLink(message)) return null;
  if (isRunicInscriptionAllowed(gvModerationText)) return null;
  if (hasIndianAsianRaceSlur(gvModerationText)) return 'indian-asian-slur';
  if (hasSpamSlur(gvModerationText)) return 'slur';
  if (isGvCharacterStatMessage(gvModerationText)) return null;
  if (messageHasTenorLink(message)) return null;
  if (MULTILINGUAL_BANTER_BYPASS && isPrimarilyNonEnglishCasualChat(gvModerationText)) return null;
  if (hasHarassmentRaceBaitEvasion(gvModerationText, message.author.id)) return 'harassment-evasion';
  if (hasStereotypeRaceReligionRedirect(gvModerationText)) return 'stereotype-race-religion';

  // Midland nation-discussion: skip medical-psych when this is clearly Midland event talk
  // (safe-context would have allowed it after medical, but "bait Ismirs" dies on tism glue first).
  const skipMedicalForMidlandEvent =
    options.midlandSoftMedical
    || (options.preferSafeContextBeforeMedical && hasMidlandEventGameplayContext(gvModerationText));
  if (!skipMedicalForMidlandEvent || !hasSafeContext(gvModerationText)) {
    if (hasMedicalPsychiatricInsult(gvModerationText)) return 'medical-psych';
  }

  if (hasDangerFramingTargetPlayersOrHumans(gvModerationText)) return 'danger-framing';
  if (hasSafeContext(gvModerationText)) return null;
  if (hasGeopoliticalHardRedirect(gvModerationText)) return 'geopolitical';
  if (hasBalkansRealWorldOffTopicRedirect(gvModerationText)) return 'balkans-irl';
  if (hasOffTopicPhrase(gvModerationText)) return 'off-topic';
  if (shouldTriggerReligionPolitics(gvModerationText)) return 'religion-politics';
  return null;
}

/** Full dump of a Midland message before delete (text + attachments + stickers + embeds). */
function collectMidlandDeletedMessageDump(message) {
  const lines = [];
  const raw = message.content != null ? String(message.content) : '';
  lines.push('--- Message content ---');
  lines.push(raw.length ? raw : '(no text)');

  if (message.attachments?.size) {
    lines.push('');
    lines.push(`--- Attachments (${message.attachments.size}) ---`);
    for (const att of message.attachments.values()) {
      const meta = [
        att.name || 'file',
        att.contentType || 'unknown-type',
        typeof att.size === 'number' ? `${att.size}B` : null,
      ].filter(Boolean).join(' · ');
      lines.push(`${meta}`);
      if (att.url) lines.push(String(att.url));
      if (att.proxyURL && att.proxyURL !== att.url) lines.push(`proxy: ${att.proxyURL}`);
    }
  }

  if (message.stickers?.size) {
    lines.push('');
    lines.push(`--- Stickers (${message.stickers.size}) ---`);
    for (const sticker of message.stickers.values()) {
      lines.push(`${sticker.name || 'sticker'} (\`${sticker.id}\`)`);
    }
  }

  if (message.embeds?.length) {
    lines.push('');
    lines.push(`--- Embeds (${message.embeds.length}) ---`);
    message.embeds.forEach((embed, i) => {
      lines.push(`[embed ${i + 1}]`);
      if (embed.title) lines.push(`title: ${embed.title}`);
      if (embed.url) lines.push(`url: ${embed.url}`);
      if (embed.description) lines.push(String(embed.description));
      if (embed.author?.name) lines.push(`author: ${embed.author.name}`);
      for (const field of embed.fields || []) {
        lines.push(`${field.name}: ${field.value}`);
      }
      if (embed.footer?.text) lines.push(`footer: ${embed.footer.text}`);
      if (embed.image?.url) lines.push(`image: ${embed.image.url}`);
      if (embed.thumbnail?.url) lines.push(`thumbnail: ${embed.thumbnail.url}`);
      if (embed.video?.url) lines.push(`video: ${embed.video.url}`);
    });
  }

  if (message.mentions?.everyone) {
    lines.push('');
    lines.push('(message mentioned @everyone / @here)');
  }

  return lines.join('\n');
}

function chunkTextForDiscord(text, maxLen = 1900) {
  const s = String(text || '');
  if (!s.length) return ['(empty)'];
  const chunks = [];
  for (let i = 0; i < s.length; i += maxLen) {
    chunks.push(s.slice(i, i + maxLen));
  }
  return chunks;
}

async function postMidlandOffenseLog(logChannel, { reason, author, channelRef, messageId, dump }) {
  const header = [
    `**Offense** — \`${reason}\``,
    `User: ${author.toString()} (\`${author.id}\`)`,
    `Channel: ${channelRef}`,
    `Message ID: \`${messageId}\``,
    `Logged chars: ${dump.length}`,
  ].join('\n');

  const combined = `${header}\n\n${dump}`;
  const files = [];
  // Always attach a full .txt when the dump would not fit cleanly in one message
  if (combined.length > 2000 || dump.length > 1800) {
    files.push(new AttachmentBuilder(Buffer.from(dump, 'utf8'), {
      name: `midland-offense-${messageId}.txt`,
    }));
  }

  if (combined.length <= 2000) {
    await logChannel.send({
      content: combined,
      files,
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Header + as much content as possible in an embed (4096), full dump in file + chunked follow-ups
  const embed = new EmbedBuilder()
    .setTitle(`Offense — ${String(reason).slice(0, 200)}`)
    .setColor(0xb03a2e)
    .addFields(
      { name: 'User', value: `${author.toString()} (\`${author.id}\`)`.slice(0, 1024), inline: false },
      { name: 'Channel', value: String(channelRef).slice(0, 1024), inline: false },
      { name: 'Message ID', value: `\`${messageId}\``, inline: true },
      { name: 'Logged chars', value: String(dump.length), inline: true },
    )
    .setDescription(dump.length <= 4096 ? dump : `${dump.slice(0, 4080)}\n… _(truncated — see attachment + follow-ups)_`)
    .setTimestamp(new Date());

  if (!files.length) {
    files.push(new AttachmentBuilder(Buffer.from(dump, 'utf8'), {
      name: `midland-offense-${messageId}.txt`,
    }));
  }

  await logChannel.send({
    embeds: [embed],
    files,
    allowedMentions: { parse: [] },
  });

  // Follow-ups so mods can read the full text in-channel without opening the file
  if (dump.length > 4096) {
    const chunks = chunkTextForDiscord(dump, 1900);
    for (let i = 0; i < chunks.length; i++) {
      await logChannel.send({
        content: `_(deleted message part ${i + 1}/${chunks.length})_\n${chunks[i]}`.slice(0, 2000),
        allowedMentions: { parse: [] },
      });
    }
  }
}

async function handleMidlandEuModeration(message, reason) {
  // Capture everything before delete — attachment CDN URLs die after the message is gone
  const dump = collectMidlandDeletedMessageDump(message);
  const ch = message.channel;
  const channelRef =
    ch && typeof ch.isThread === 'function' && ch.isThread()
      ? `<#${message.channelId}> (thread under <#${ch.parentId}>)`
      : `<#${message.channelId}>`;
  const author = message.author;
  const messageId = message.id;

  try {
    await message.delete();
  } catch (err) {
    console.error('[midland-eu] delete failed:', err.message);
  }

  try {
    await author.send(MIDLAND_EU_WARN_DM);
  } catch (err) {
    console.warn(`[midland-eu] warn DM failed for ${author.tag}:`, err.message);
  }

  try {
    const logChannel = await message.client.channels.fetch(MIDLAND_EU_OFFENSE_LOG_CHANNEL_ID);
    if (logChannel?.isTextBased()) {
      await postMidlandOffenseLog(logChannel, {
        reason,
        author,
        channelRef,
        messageId,
        dump,
      });
    }
  } catch (err) {
    console.error('[midland-eu] offense log failed:', err.message);
  }

  console.log(`[midland-eu] ${author.tag} — ${reason} (#${message.channelId}) [${dump.length} chars logged]`);
}

async function handleMidlandEuMessage(message) {
  const rawGvContent = message.content ? String(message.content) : '';
  const gvModerationText = stripOuterQuotesForGeneral(rawGvContent.trim()) || rawGvContent;
  const reason = detectStandardModerationTrigger(message, gvModerationText, {
    preferSafeContextBeforeMedical: true,
    midlandSoftMedical: hasMidlandEventGameplayContext(gvModerationText),
  });
  if (reason) {
    await handleMidlandEuModeration(message, reason);
  }
}

/**
 * Reset all rolling spam-watch counters (volume flush + the separate rolling msg count + same-text counts).
 * The French #miaow prompt uses handleSpamWatchUser (recentMessageTimes / contentCounts), not gvVolumeRecent alone.
 */
function resetSpamWatchRollingCounters(reason) {
  const state = spamWatchState;
  const hadGv = Array.isArray(state.gvVolumeRecent) && state.gvVolumeRecent.length > 0;
  const hadRecent = Array.isArray(state.recentMessageTimes) && state.recentMessageTimes.length > 0;
  const hadContent = state.contentCounts && Object.keys(state.contentCounts).length > 0;
  const hadStrikes = Array.isArray(state.strikeTimes) && state.strikeTimes.length > 0;
  if (!hadGv && !hadRecent && !hadContent && !hadStrikes) return false;
  state.gvVolumeRecent = [];
  state.recentMessageTimes = [];
  state.contentCounts = {};
  state.strikeTimes = [];
  saveSpamWatchState(spamWatchState);
  if (DEBUG) console.log(`[spam-watch] Reset rolling counters (${reason})`);
  return true;
}

function isSpamWatchTargetMessage(message) {
  return Boolean(
    message
    && String(message.author?.id) === SPAM_WATCH_USER_ID
    && isMessageInGvGeneral(message),
  );
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

/** Download attachments, post to #miaow, then delete from gv-general (Discord CDN URLs expire after delete). @returns {Promise<boolean>} true if deleted from gv-general */
async function deleteAndRepostSpamWatchToMiaow(message, headerSuffix) {
  const dest = await message.client.channels.fetch(SPAM_WATCH_MIAOW_CHANNEL_ID).catch(() => null);
  if (!dest?.isTextBased()) return false;
  const label =
    headerSuffix
    ?? `${SPAM_WATCH_GV_VOLUME_THRESHOLD}+ posts / ${Math.round(SPAM_WATCH_GV_VOLUME_WINDOW_MS / 60000)} min`;
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
  const content = [`${message.author} — moved from <#${TRIGGER_CHANNEL_ID}> (${label}):`, text].join('\n\n');
  try {
    await dest.send({
      content,
      files: files.length ? files : undefined,
      allowedMentions: { users: [message.author.id] },
    });
  } catch (e) {
    console.error('[spam-watch-volume] send failed:', e.message);
    return false;
  }
  try {
    await message.delete();
  } catch (e) {
    console.error('[spam-watch-volume] delete failed:', e.message);
    return false;
  }
  return true;
}

/**
 * Track all gv-general messages from spam-watch user; when count ≥ threshold in rolling window, move oldest batch to #miaow.
 * @returns {Promise<boolean>} true if this turn flushed (caller should return)
 */
async function handleSpamWatchVolumeFlush(message) {
  if (String(message.author.id) !== SPAM_WATCH_USER_ID) return false;
  const state = spamWatchState;
  const now = Date.now();
  state.gvVolumeRecent = (state.gvVolumeRecent || []).filter((e) => now - e.ts < SPAM_WATCH_GV_VOLUME_WINDOW_MS);
  state.gvVolumeRecent.push({ id: message.id, ts: now });
  if (state.gvVolumeRecent.length < SPAM_WATCH_GV_VOLUME_THRESHOLD) {
    saveSpamWatchState(spamWatchState);
    return false;
  }
  state.gvVolumeRecent.sort((a, b) => a.ts - b.ts);
  const batch = state.gvVolumeRecent.splice(0, SPAM_WATCH_GV_VOLUME_THRESHOLD);
  saveSpamWatchState(spamWatchState);

  const channel = message.channel;
  for (const { id } of batch) {
    const m = id === message.id ? message : await channel.messages.fetch(id).catch(() => null);
    if (m) await deleteAndRepostSpamWatchToMiaow(m, undefined);
  }
  if (DEBUG) {
    console.log(`[spam-watch-volume] Flushed ${batch.length} message(s) to <#${SPAM_WATCH_MIAOW_CHANNEL_ID}>`);
  }
  return true;
}

/** @returns {Promise<boolean>} true if handled (caller should return) */
async function handleSpamWatchUser(message) {
  if (String(message.author.id) !== SPAM_WATCH_USER_ID) return false;
  // Empty body / stickers / attachment-only still count (shared key) so spam isn’t skipped.
  const norm = normalizeSpamContent(message.content) || '(no text)';

  const now = Date.now();
  const state = spamWatchState;
  state.recentMessageTimes = (state.recentMessageTimes || []).filter((t) => now - t < SPAM_WATCH_VOLUME_WINDOW_MS);
  state.recentMessageTimes.push(now);

  const key = spamContentKey(norm);
  state.contentCounts = pruneSpamContentCounts(state.contentCounts || {});
  state.contentCounts[key] = (state.contentCounts[key] || 0) + 1;

  const sameTextSpam = state.contentCounts[key] >= 3;
  const volumeSpam = state.recentMessageTimes.length > SPAM_WATCH_VOLUME_MSG_THRESHOLD;
  const wallSpam = looksLikeInMessageRepeatSpam(message.content);
  const isSpam = sameTextSpam || volumeSpam || wallSpam;

  if (!isSpam) {
    saveSpamWatchState(spamWatchState);
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

  saveSpamWatchState(spamWatchState);

  const why = [];
  if (sameTextSpam) why.push('même texte ≥3×');
  if (volumeSpam) why.push(`>${SPAM_WATCH_VOLUME_MSG_THRESHOLD} messages en ${Math.round(SPAM_WATCH_VOLUME_WINDOW_MS / 60000)} min`);
  if (wallSpam) why.push('copier-coller répété');

  const moved = await deleteAndRepostSpamWatchToMiaow(message, why.join(' · '));
  if (!moved) {
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

/** After a gv-general removal, send off-topic + Chronicus education to the author (DM). Keeps gv-general clean. */
async function sendPostModerationChronicusEducation(message) {
  const chronicusContent = `${message.author.toString()}\n\n<#${REDIRECT_CHANNEL_ID}>\n\n${getChronicusAnnouncementText()}`;
  const memePath = getRandomChronicusMeme();
  const payload = memePath
    ? { content: chronicusContent, files: [{ attachment: memePath, name: path.basename(memePath) }] }
    : { content: chronicusContent };
  try {
    await message.author.send(payload);
    return;
  } catch (err) {
    console.error('Chronicus education DM failed (DM closed/blocked):', err.message);
  }
  try {
    const hold = await message.client.channels.fetch(CHRONICUS_EDUCATION_DM_FALLBACK_CHANNEL_ID).catch(() => null);
    if (hold?.isTextBased()) {
      await hold.send({
        ...payload,
        content: [
          `${message.author.toString()} — **DM failed** (closed or bot blocked); education posted in <#${CHRONICUS_EDUCATION_DM_FALLBACK_CHANNEL_ID}> instead of gv-general:`,
          payload.content,
        ].join('\n\n'),
        allowedMentions: { users: [message.author.id] },
      });
    }
  } catch (err2) {
    console.error('Chronicus education fallback channel send failed:', err2.message);
  }
}

// Delete message in gv-general, repost to MOVED_BY_BOT_CHANNEL (hold/archive), still tell user to continue in #off-topic; Chronicus + redirect go to author DM (not gv-general).
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
  await sendPostModerationChronicusEducation(message);
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

function loadNexusModWatchState() {
  try {
    if (fs.existsSync(NEXUS_MOD_WATCH_FILE)) {
      const data = JSON.parse(fs.readFileSync(NEXUS_MOD_WATCH_FILE, 'utf8'));
      return {
        initialized: Boolean(data.initialized),
        fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : '',
      };
    }
  } catch (e) {
    if (DEBUG) console.warn('[nexus-mod-watch] state load failed:', e.message);
  }
  return { initialized: false, fingerprint: '' };
}
function saveNexusModWatchState(state) {
  try {
    fs.writeFileSync(NEXUS_MOD_WATCH_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    if (DEBUG) console.warn('[nexus-mod-watch] state save failed:', e.message);
  }
}
let nexusModWatchState = loadNexusModWatchState();

/** Poll Nexus files API; post to Discord when MAIN (etc.) file fingerprint changes. Requires NEXUS_API_KEY. */
async function runNexusModFilePoll(client) {
  if (!NEXUS_API_KEY || !NEXUS_MOD_ID || !NEXUS_MOD_NOTIFY_CHANNEL_ID) return;
  const categoryAllow = new Set(NEXUS_MOD_FILE_CATEGORY_IDS.length ? NEXUS_MOD_FILE_CATEGORY_IDS : [1]);
  const url = `https://api.nexusmods.com/v1/games/${encodeURIComponent(NEXUS_MOD_GAME_DOMAIN)}/mods/${NEXUS_MOD_ID}/files.json`;
  let data;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: NEXUS_API_KEY,
        Accept: 'application/json',
        'Application-Name': NEXUS_APP_NAME,
        'Application-Version': NEXUS_APP_VERSION,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (err) {
    console.error('[nexus-mod-watch] API request failed:', err.message || err);
    return;
  }
  const files = Array.isArray(data?.files) ? data.files : [];
  const tracked = files.filter((f) => categoryAllow.has(Number(f.category_id)));
  const fingerprint = tracked
    .map((f) => `${f.file_id}:${f.uploaded_timestamp}`)
    .sort()
    .join('|');

  if (!nexusModWatchState.initialized) {
    nexusModWatchState = { initialized: true, fingerprint };
    saveNexusModWatchState(nexusModWatchState);
    if (DEBUG) console.log('[nexus-mod-watch] bootstrap: stored fingerprint, no Discord post');
    return;
  }
  if (nexusModWatchState.fingerprint === fingerprint) return;

  const channel = await client.channels.fetch(NEXUS_MOD_NOTIFY_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error('[nexus-mod-watch] notify channel missing or not text-based');
    return;
  }
  const lines = tracked
    .slice(0, 20)
    .map((f) => {
      const label = f.name || f.file_name || `file ${f.file_id}`;
      const ver = f.version || f.mod_version || '?';
      const cat = f.category_name || String(f.category_id);
      return `• ${label} (${ver}) — ${cat}`;
    })
    .join('\n');
  const content = [
    '**Nexus mod — tracked file(s) updated**',
    NEXUS_MOD_PAGE_URL,
    tracked.length ? lines : '_API returned no files in selected categories; fingerprint changed anyway._',
  ].join('\n');
  try {
    await channel.send({
      content: content.slice(0, 2000),
      allowedMentions: { parse: [] },
    });
    nexusModWatchState = { initialized: true, fingerprint };
    saveNexusModWatchState(nexusModWatchState);
    if (DEBUG) console.log('[nexus-mod-watch] posted update notification');
  } catch (err) {
    console.error('[nexus-mod-watch] Discord send failed:', err.message || err);
  }
}

const RSS_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/',
};

/** Normalize article URLs so channel text and RSS items match after redeploy (dedupe). */
function normalizeAnnouncementRelayUrl(href) {
  if (!href || typeof href !== 'string') return '';
  let s = href.trim();
  const trailing = /[.,;:!?)>]+$/;
  s = s.replace(trailing, '');
  try {
    const u = new URL(s);
    if (/gloriavictisgame\.com$/i.test(u.hostname)) u.protocol = 'https:';
    u.hash = '';
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    u.pathname = p || '/';
    return u.href.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/** Collect http(s) URLs from recent announcement-channel messages (body + embeds) for RSS dedupe. */
async function collectRelayedUrlsFromChannel(channel, maxToScan) {
  const out = new Set();
  const urlRe = /https?:\/\/[^\s<>)\]'"]+/gi;
  const addFromText = (text) => {
    if (!text || typeof text !== 'string') return;
    urlRe.lastIndex = 0;
    let m;
    while ((m = urlRe.exec(text)) !== null) {
      const n = normalizeAnnouncementRelayUrl(m[0]);
      if (n) out.add(n);
    }
  };
  const cap = Math.min(500, Math.max(30, maxToScan));
  let remaining = cap;
  let before = undefined;
  while (remaining > 0) {
    const batchSize = Math.min(100, remaining);
    const msgs = await channel.messages.fetch({ limit: batchSize, before });
    if (msgs.size === 0) break;
    for (const msg of msgs.values()) {
      addFromText(msg.content);
      for (const em of msg.embeds) {
        if (em.url) addFromText(em.url);
        if (em.description) addFromText(em.description);
        if (em.title) addFromText(em.title);
      }
    }
    before = msgs.last()?.id;
    remaining -= msgs.size;
    if (msgs.size < batchSize) break;
  }
  return out;
}

// --- Discord bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for guildMemberAdd (enable "Server Members Intent" in Discord Developer Portal)
    GatewayIntentBits.GuildVoiceStates, // required for temp voice create/move/delete
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

function loadTempVoiceOwners() {
  try {
    if (!fs.existsSync(TEMP_VOICE_OWNERS_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(TEMP_VOICE_OWNERS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return new Map();
    return new Map(
      Object.entries(raw)
        .filter(([channelId, ownerId]) => Boolean(channelId) && Boolean(ownerId)),
    );
  } catch (err) {
    console.warn('Temp voice owners load failed:', err.message || err);
    return new Map();
  }
}

function saveTempVoiceOwners() {
  try {
    const obj = Object.fromEntries(tempVoiceOwners.entries());
    fs.writeFileSync(TEMP_VOICE_OWNERS_FILE, JSON.stringify(obj), 'utf8');
  } catch (err) {
    console.warn('Temp voice owners save failed:', err.message || err);
  }
}

const tempVoiceOwners = loadTempVoiceOwners(); // voiceChannelId -> ownerUserId
const tempVoiceCreateLockByUser = new Map(); // userId -> timestamp
const tempVoiceProcessStartedAt = Date.now();
const TEMP_VOICE_OWNER_PERMS = {
  Connect: true,
  ViewChannel: true,
  ManageChannels: true,
  ManageRoles: true,
  MoveMembers: true,
  MuteMembers: true,
  DeafenMembers: true,
  PrioritySpeaker: true,
};

function buildTempVoiceName(member) {
  const safeName = (member.displayName || member.user?.username || 'Temp').trim().slice(0, 80);
  return TEMP_VOICE_NAME_TEMPLATE.replace('{displayName}', safeName).replace('{username}', member.user?.username || safeName);
}

function isTrackedTempVoiceChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (channel.id === TEMP_VOICE_TRIGGER_CHANNEL_ID) return false;
  // Midland language booths are permanent — never auto-delete (temp-voice must not touch them).
  if (midlandVoiceTranslate.isProtectedVoiceChannel?.(channel.id)) return false;
  if (String(channel.id) === String(midlandVoiceTranslate.MIDLAND_EU_VOICE_CHANNEL_ID || '')) return false;
  if (tempVoiceOwners.has(channel.id)) return true;
  return Boolean(resolveTempVoiceOwnerId(channel));
}

function resolveTempVoiceOwnerId(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return null;
  const fromMap = tempVoiceOwners.get(channel.id);
  if (fromMap) return fromMap;
  for (const [id, overwrite] of channel.permissionOverwrites.cache.entries()) {
    if (overwrite.type !== 1 && overwrite.type !== 'member') continue; // member overwrite
    if (overwrite.allow?.has('ManageChannels')) return id;
  }
  return null;
}

function findOwnedTempVoiceChannel(guild, userId) {
  for (const [channelId, ownerId] of tempVoiceOwners.entries()) {
    if (ownerId !== userId) continue;
    const ch = guild.channels.cache.get(channelId);
    if (ch && ch.type === ChannelType.GuildVoice) return ch;
  }
  return null;
}

function findOwnedTempVoiceChannelDeep(guild, userId) {
  const fromMap = findOwnedTempVoiceChannel(guild, userId);
  if (fromMap) return fromMap;
  const chans = guild.channels?.cache?.values?.();
  if (!chans) return null;
  for (const ch of chans) {
    if (!ch || ch.type !== ChannelType.GuildVoice) continue;
    if (ch.id === TEMP_VOICE_TRIGGER_CHANNEL_ID) continue;
    if (String(ch.parentId || '') !== TEMP_VOICE_CATEGORY_ID) continue;
    const ownerId = resolveTempVoiceOwnerId(ch);
    if (ownerId === userId) return ch;
  }
  return null;
}

function shouldPauseTempVoiceActions() {
  return Date.now() - tempVoiceProcessStartedAt < TEMP_VOICE_STARTUP_GRACE_MS;
}

function getVoiceStateOccupancy(guild, channelId) {
  if (!guild || !channelId) return 0;
  return guild.voiceStates.cache.filter((vs) => vs.channelId === channelId).size;
}

async function applyTempVoiceOwner(channel, userId) {
  await channel.permissionOverwrites.edit(userId, TEMP_VOICE_OWNER_PERMS, { reason: 'Temp voice owner permissions' });
}

async function clearTempVoiceOwner(channel, userId) {
  await channel.permissionOverwrites.edit(
    userId,
    {
      ManageChannels: null,
      ManageRoles: null,
      MoveMembers: null,
      MuteMembers: null,
      DeafenMembers: null,
      PrioritySpeaker: null,
    },
    { reason: 'Temp voice ownership transferred' },
  );
}

function canClaimTempVoiceOwnership(guild, channel, ownerId) {
  if (!ownerId) return true;
  const ownerInChannel = channel.members.has(ownerId);
  if (ownerInChannel) return false;
  const ownerMember = guild.members.cache.get(ownerId);
  if (!ownerMember) return true; // owner left guild or not cached
  return ownerMember.voice?.channelId !== channel.id;
}

async function reconcileTempVoiceOwners(clientInstance) {
  if (tempVoiceOwners.size === 0) return;
  let changed = false;
  for (const [channelId] of tempVoiceOwners.entries()) {
    try {
      const ch = await clientInstance.channels.fetch(channelId).catch(() => null);
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        tempVoiceOwners.delete(channelId);
        changed = true;
        continue;
      }
      const occupants = getVoiceStateOccupancy(ch.guild, ch.id);
      if (occupants === 0) {
        await ch.delete('Temp voice cleanup after restart');
        tempVoiceOwners.delete(channelId);
        changed = true;
      }
    } catch (err) {
      console.warn(`Temp voice reconcile failed for ${channelId}:`, err.message || err);
    }
  }
  if (changed) saveTempVoiceOwners();
}

function tempVoiceHelpText(prefix = '!vc') {
  return [
    'Temp voice commands:',
    `\`${prefix} help\` - show this help.`,
    `\`${prefix} transfer @user\` - transfer ownership of your current temp voice channel.`,
    `\`${prefix} rename <new name>\` - rename your current temp voice channel.`,
    `\`${prefix} limit <number>\` - set user limit (0-99, where 0 means unlimited).`,
    `\`${prefix} claim\` - become owner if current owner is gone.`,
  ].join('\n');
}

async function safeInteractionReply(interaction, text) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({ content: text, flags: 64 });
    }
    return await interaction.reply({ content: text, flags: 64 });
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('Interaction has already been acknowledged.')) {
      try {
        return await interaction.followUp({ content: text, flags: 64 });
      } catch {
        return null;
      }
    }
    throw err;
  }
}

async function executeTempVoiceCommand(ctx) {
  const { guild, member, authorId, authorTag, authorMention, sub, rawName, limitValue, targetMember, reply } = ctx;
  const freshMember = await guild.members.fetch(authorId).catch(() => member || null);
  const voiceChannel = freshMember?.voice?.channel || member?.voice?.channel || null;
  const requiresOwnedChannel = sub === 'transfer'
    || sub === 'owner'
    || sub === 'rename'
    || sub === 'limit';

  if (sub === 'help') {
    await reply(tempVoiceHelpText('/vc'));
    return true;
  }

  if (requiresOwnedChannel) {
    if (!voiceChannel || !isTrackedTempVoiceChannel(voiceChannel)) {
      await reply('You must be inside your temp voice channel to use this command.');
      return true;
    }
    let currentOwnerId = resolveTempVoiceOwnerId(voiceChannel);
    const hasOwnerLikePerm = voiceChannel.permissionOverwrites.cache.get(authorId)?.allow?.has('ManageChannels');
    if (!currentOwnerId && hasOwnerLikePerm) {
      tempVoiceOwners.set(voiceChannel.id, authorId);
      saveTempVoiceOwners();
      currentOwnerId = authorId;
    }
    if (currentOwnerId !== authorId) {
      await reply('Only the current channel owner can use this command.');
      return true;
    }
  }

  if (sub === 'rename') {
    const safeNewName = String(rawName || '').trim().slice(0, 100);
    if (!safeNewName) {
      await reply('Provide a new name: `/vc rename name:<new name>`.');
      return true;
    }
    try {
      await voiceChannel.setName(safeNewName, `Temp voice rename by ${authorTag}`);
      await reply(`Channel renamed to **${safeNewName}**.`);
    } catch (err) {
      console.error('Temp voice rename failed:', err.message || err);
      await reply('Could not rename channel. Ensure the bot has Manage Channels permission.');
    }
    return true;
  }

  if (sub === 'limit') {
    const parsed = Number(limitValue);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
      await reply('Limit must be a whole number between 0 and 99.');
      return true;
    }
    try {
      await voiceChannel.setUserLimit(parsed, `Temp voice limit set by ${authorTag}`);
      await reply(parsed === 0 ? 'User limit removed (unlimited).' : `User limit set to **${parsed}**.`);
    } catch (err) {
      console.error('Temp voice limit update failed:', err.message || err);
      await reply('Could not update user limit. Ensure the bot has Manage Channels permission.');
    }
    return true;
  }

  if (sub === 'claim') {
    if (!voiceChannel || !isTrackedTempVoiceChannel(voiceChannel)) {
      await reply('You must be inside a temp voice channel to claim ownership.');
      return true;
    }
    const currentOwnerId = resolveTempVoiceOwnerId(voiceChannel);
    if (!currentOwnerId) {
      tempVoiceOwners.set(voiceChannel.id, authorId);
      saveTempVoiceOwners();
      await applyTempVoiceOwner(voiceChannel, authorId);
      await reply('Ownership claimed.');
      return true;
    }
    if (currentOwnerId === authorId) {
      await reply('You already own this temp voice channel.');
      return true;
    }
    if (!canClaimTempVoiceOwnership(guild, voiceChannel, currentOwnerId)) {
      await reply('Current owner is still active in this channel, so it cannot be claimed.');
      return true;
    }
    try {
      await applyTempVoiceOwner(voiceChannel, authorId);
      await clearTempVoiceOwner(voiceChannel, currentOwnerId);
      tempVoiceOwners.set(voiceChannel.id, authorId);
      saveTempVoiceOwners();
      await reply(`Ownership claimed by ${authorMention}.`);
    } catch (err) {
      console.error('Temp voice claim failed:', err.message || err);
      await reply('Could not claim ownership. Ensure the bot has Manage Channels and Manage Roles permissions.');
    }
    return true;
  }

  if (sub !== 'transfer' && sub !== 'owner') {
    await reply('Unknown temp voice command. Use `/vc help`.');
    return true;
  }

  if (!targetMember) {
    await reply('Choose a user to transfer ownership: `/vc transfer user:@member`.');
    return true;
  }
  if (targetMember.id === authorId) {
    await reply('You already own this temp voice channel.');
    return true;
  }
  if (targetMember.voice?.channelId !== voiceChannel.id) {
    await reply('The new owner must be in the same temp voice channel.');
    return true;
  }

  try {
    await applyTempVoiceOwner(voiceChannel, targetMember.id);
    await clearTempVoiceOwner(voiceChannel, authorId);
    tempVoiceOwners.set(voiceChannel.id, targetMember.id);
    saveTempVoiceOwners();
    await reply(`Ownership transferred to ${targetMember.toString()}.`);
  } catch (err) {
    console.error('Temp voice ownership transfer failed:', err.message || err);
    await reply('Could not transfer ownership. Ensure the bot has Manage Channels and Manage Roles permissions.');
  }
  return true;
}

async function handleTempVoiceCommand(message) {
  return false; // !vc text commands disabled; use /vc app commands only.
}

client.once('ready', () => {
  botReadyAt = Date.now();
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`GV main guild: ${GV_MAIN_GUILD_ID}`);
  if (MIDLAND_EU_ENABLED) {
    console.log(
      `Midland EU moderation: guild ${MIDLAND_EU_GUILD_ID}; channels ${[...MIDLAND_EU_MOD_CHANNEL_IDS].join(', ')} → delete + warn DM + <#${MIDLAND_EU_OFFENSE_LOG_CHANNEL_ID}>`,
    );
    console.log('Midland EU: event-context soft medical guard ON (bait+Ismirs / Midland Day false-positive fix)');
  }
  void midlandVoiceTranslate.init(client);
  console.log(`Trigger channel (gv-general): ${TRIGGER_CHANNEL_ID} — ensure Message Content Intent is ON in Developer Portal`);
  const miaowImageCount = MIAOW_IMAGE_NAMES.map((name) => path.join(EMPEROR_MIAOW_DIR, name)).filter((p) => fs.existsSync(p)).length;
  console.log(
    `Miaow replies: #gv-general + threads; author needs role ${MIAOW_TRIGGER_ROLE_ID} (Miðland); ping ${EMPEROR_MIAOW_ROLE_ID}; ${miaowImageCount} image(s) in EmperorMiaow/`,
  );
  console.log(`Moved-from-general posts → <#${MOVED_BY_BOT_CHANNEL_ID}>; Chronicus education → author DM (hold fallback if DMs closed); <#${REDIRECT_CHANNEL_ID}> (off-topic)`);
  if (FOUR_IMAGE_SCAM_BLOCK) {
    console.log(
      `4-image scam block: ON — 1–4.jpg/png (×4) OR ≥${FOUR_IMAGE_SCAM_MIN_DUPLICATE_ATTACHMENTS}× image.jpg OR hash set(s) → delete + Court Jester <@&${COURT_JESTER_ROLE_ID}> (Manage Messages per channel)`,
    );
  }
  console.log(`CSAM/grooming triggers: ${csamGroomingTriggers.length} lines → hold + TMFIAR + ${CSAM_ACK_EMOJI} ack (${CSAM_GROOMING_WORDS_FILE})`);
  console.log(`Welcomes in #new-arrivals (guildMemberAdd + first role); admin channel ignored for welcome`);
  console.log(`Welcome skip: accounts younger than ${WELCOME_MIN_ACCOUNT_AGE_DAYS} days (set WELCOME_MIN_ACCOUNT_AGE_DAYS=730 for 2 years)`);
  if (MULTILINGUAL_BANTER_BYPASS) {
    console.log('Multilingual banter: gv-general skips EN-only holds when text looks non-English casual chat (MULTILINGUAL_BANTER_BYPASS=0 to disable)');
  }

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
  const officialNewsItemKey = (item) => {
    const raw = String(item.guid || item.link || item.title || '').trim();
    return raw ? `official:${raw}` : '';
  };
  const itemPubTime = (item) => {
    const pub = item.pubDate;
    if (!pub) return 0;
    const ts = pub instanceof Date ? pub.getTime() : new Date(pub).getTime();
    return Number.isNaN(ts) ? 0 : ts;
  };
  const sendAnnouncementRssItem = async (channel, item) => {
    const title = item.title || 'News';
    const link = item.link || '';
    const snippet = (item.contentSnippet || item.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const content = link ? `${title}\n${link}${snippet ? `\n${snippet}` : ''}` : title;
    await channel.send({ content: content.slice(0, 2000) });
  };

  // RSS feed (gamigo) → announcement channel: Gloria Victis only, from today forward (no old items)
  if (RSS_FEED_URL && ANNOUNCEMENT_CHANNEL_ID) {
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
          await sendAnnouncementRssItem(channel, item);
          posted++;
          saveRssSeen(rssSeen);
        }
        if (DEBUG && posted > 0) console.log(`[rss] Posted ${posted} Gloria Victis item(s) to announcement channel (gamigo feed)`);
      } catch (err) {
        console.error('RSS poll failed:', err.message || err);
        // 403 = feed URL blocks requests from Render's IP. Try another RSS source or leave RSS_FEED_URL unset to disable.
      }
    };
    runRssPoll();
    setInterval(runRssPoll, RSS_POLL_INTERVAL_MS);
  }

  // Second RSS (official site / rss.app) → same channel; daily poll; max N newest unseen per run.
  // First poll after deploy: post up to N newest items in the feed, then mark every item currently in the feed as seen so older entries are not dripped out day by day.
  if (RSS_FEED_URL_2 && ANNOUNCEMENT_CHANNEL_ID) {
    const runOfficialNewsPoll = async () => {
      try {
        const res = await fetch(RSS_FEED_URL_2, { headers: RSS_FETCH_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          const host = (() => { try { return new URL(RSS_FEED_URL_2).host; } catch { return 'feed'; } })();
          throw new Error(`Status code ${res.status} from ${host} (RSS feed 2)`);
        }
        const xml = await res.text();
        const feed = await rssParser.parseString(xml);
        const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
        if (!channel?.isTextBased()) return;

        const relayedUrls = await collectRelayedUrlsFromChannel(channel, RSS_2_CHANNEL_HISTORY_LIMIT);
        const itemLinkRelayed = (item) => {
          const u = normalizeAnnouncementRelayUrl(item.link || '');
          return Boolean(u && relayedUrls.has(u));
        };

        const items = [...(feed.items || [])];
        for (const item of items) {
          const key = officialNewsItemKey(item);
          if (key && itemLinkRelayed(item)) rssSeen.add(key);
        }
        saveRssSeen(rssSeen);

        if (!rssSeen.has(RSS_OFFICIAL_BOOTSTRAP_KEY)) {
          const withKeys = items
            .map((item) => ({ item, key: officialNewsItemKey(item) }))
            .filter(({ key }) => key);
          withKeys.sort((a, b) => itemPubTime(b.item) - itemPubTime(a.item));
          const notYetInChannel = withKeys.filter((x) => !itemLinkRelayed(x.item));
          const toPost = notYetInChannel.slice(0, RSS_FEED_2_MAX_POSTS);
          for (const { key } of withKeys) rssSeen.add(key);
          rssSeen.add(RSS_OFFICIAL_BOOTSTRAP_KEY);
          saveRssSeen(rssSeen);
          let posted = 0;
          for (let i = toPost.length - 1; i >= 0; i--) {
            await sendAnnouncementRssItem(channel, toPost[i].item);
            posted++;
          }
          if (posted > 0) console.log(`[rss2] Initial sync: posted ${posted} item(s); ${withKeys.length} current feed entr${withKeys.length === 1 ? 'y' : 'ies'} marked seen; skipped ${withKeys.length - notYetInChannel.length} already in <#${ANNOUNCEMENT_CHANNEL_ID}>`);
          else if (notYetInChannel.length === 0 && withKeys.length > 0) console.log(`[rss2] Initial sync: no new posts (${withKeys.length} feed item(s) already in <#${ANNOUNCEMENT_CHANNEL_ID}>); bootstrap complete`);
          else if (DEBUG) console.log('[rss2] First run: feed empty or no valid item keys; bootstrap only');
          return;
        }

        const unseen = items
          .map((item) => ({ item, key: officialNewsItemKey(item) }))
          .filter(({ key, item: it }) => key && !rssSeen.has(key) && !itemLinkRelayed(it))
          .sort((a, b) => itemPubTime(b.item) - itemPubTime(a.item))
          .slice(0, RSS_FEED_2_MAX_POSTS);

        let posted = 0;
        for (let i = unseen.length - 1; i >= 0; i--) {
          const { item, key } = unseen[i];
          rssSeen.add(key);
          saveRssSeen(rssSeen);
          await sendAnnouncementRssItem(channel, item);
          posted++;
        }
        if (DEBUG && posted > 0) console.log(`[rss2] Posted ${posted} official GV news item(s) (feed 2)`);
      } catch (err) {
        console.error('RSS feed 2 poll failed:', err.message || err);
      }
    };
    runOfficialNewsPoll();
    setInterval(runOfficialNewsPoll, RSS_FEED_2_POLL_INTERVAL_MS);
    console.log(`RSS feed 2 (official GV news): every ${Math.round(RSS_FEED_2_POLL_INTERVAL_MS / 3600000)}h, max ${RSS_FEED_2_MAX_POSTS} new item(s) → <#${ANNOUNCEMENT_CHANNEL_ID}>`);
  }

  // Nexus Mods: poll mod files API; notify when MAIN (default) file set changes. Needs NEXUS_API_KEY (see nexusmods.com API terms).
  if (NEXUS_API_KEY && NEXUS_MOD_ID && NEXUS_MOD_NOTIFY_CHANNEL_ID) {
    runNexusModFilePoll(client);
    setInterval(() => runNexusModFilePoll(client), NEXUS_MOD_POLL_INTERVAL_MS);
    const cats = NEXUS_MOD_FILE_CATEGORY_IDS.length ? NEXUS_MOD_FILE_CATEGORY_IDS.join(',') : '1';
    console.log(
      `Nexus mod watch: game=${NEXUS_MOD_GAME_DOMAIN} mod=${NEXUS_MOD_ID} categories=[${cats}] → <#${NEXUS_MOD_NOTIFY_CHANNEL_ID}> every ${Math.round(
        NEXUS_MOD_POLL_INTERVAL_MS / 3600000,
      )}h`,
    );
  } else if (DEBUG) {
    console.log('[nexus-mod-watch] disabled (set NEXUS_API_KEY; optional NEXUS_MOD_ID / NEXUS_MOD_NOTIFY_CHANNEL_ID)');
  }

  if (!TEMP_VOICE_TRIGGER_CHANNEL_ID) {
    console.warn('Temp voice disabled: set TEMP_VOICE_TRIGGER_CHANNEL_ID to your "join to create" voice channel ID.');
  } else {
    console.log(`Temp voice enabled: trigger=${TEMP_VOICE_TRIGGER_CHANNEL_ID}, category=${TEMP_VOICE_CATEGORY_ID}`);
  }
  if (tempVoiceOwners.size > 0) {
    console.log(`Temp voice owners restored: ${tempVoiceOwners.size}`);
  }
  if (TEMP_VOICE_STARTUP_GRACE_MS > 0) {
    console.log(`Temp voice startup grace: ${TEMP_VOICE_STARTUP_GRACE_MS}ms (prevents deploy-overlap duplicate handling).`);
  }
  reconcileTempVoiceOwners(client).catch((err) => {
    console.warn('Temp voice reconcile run failed:', err.message || err);
  });

  const vcSlashCommand = new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Manage your temporary voice channel')
    .addSubcommand((s) => s.setName('help').setDescription('Show temp voice help'))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim ownership if owner is gone'))
    .addSubcommand((s) => s.setName('rename').setDescription('Rename your temp voice channel')
      .addStringOption((o) => o.setName('name').setDescription('New voice channel name').setRequired(true)))
    .addSubcommand((s) => s.setName('limit').setDescription('Set user limit (0-99)')
      .addIntegerOption((o) => o.setName('number').setDescription('0 to 99 (0 is unlimited)').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand((s) => s.setName('transfer').setDescription('Transfer ownership to a member')
      .addUserOption((o) => o.setName('user').setDescription('Member to transfer ownership to').setRequired(true)));

  client.application.commands.set(
    [vcSlashCommand.toJSON()],
    TEMP_VOICE_COMMAND_GUILD_ID || undefined,
  ).then(() => {
    if (TEMP_VOICE_COMMAND_GUILD_ID) console.log(`Registered /vc command in guild ${TEMP_VOICE_COMMAND_GUILD_ID}`);
    else console.log('Registered global /vc command (may take up to ~1 hour to appear).');
  }).catch((err) => {
    console.error('Slash command registration failed:', err.message || err);
  });
  if (TEMP_VOICE_COMMAND_GUILD_ID) {
    client.application.commands.set([], undefined).then(() => {
      console.log('Cleared global app commands to avoid duplicate /vc entries.');
    }).catch((err) => {
      console.warn('Could not clear global app commands:', err.message || err);
    });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (shouldPauseTempVoiceActions()) return;
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'vc') return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const rawName = sub === 'rename' ? interaction.options.getString('name', true) : '';
  const limitValue = sub === 'limit' ? interaction.options.getInteger('number', true) : undefined;
  const userOption = (sub === 'transfer')
    ? interaction.options.getUser('user', true)
    : null;
  const targetMember = userOption ? await interaction.guild.members.fetch(userOption.id).catch(() => null) : null;
  const invokingMember = interaction.member && 'voice' in interaction.member
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  await executeTempVoiceCommand({
    guild: interaction.guild,
    member: invokingMember,
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    authorMention: interaction.user.toString(),
    sub,
    rawName,
    limitValue,
    targetMember,
    reply: async (text) => safeInteractionReply(interaction, text),
  });
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Midland POWER booth: auto-join/leave for Leader/Officer translation (independent of GV temp-voice).
  try {
    await midlandVoiceTranslate.onVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('[midland-voice] voiceStateUpdate failed:', err.message || err);
  }

  // Temp-voice create/delete is GV-main only — never run on Midland EU.
  if (!isGvMainGuild(newState.guild?.id || oldState.guild?.id)) return;

  if (shouldPauseTempVoiceActions()) return;
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const joinedChannel = newState.channel;
  const leftChannel = oldState.channel;

  if (
    TEMP_VOICE_TRIGGER_CHANNEL_ID &&
    joinedChannel &&
    joinedChannel.id === TEMP_VOICE_TRIGGER_CHANNEL_ID &&
    oldState.channelId !== newState.channelId
  ) {
    try {
      const currentMember = await newState.guild.members.fetch(member.id).catch(() => member);
      if (currentMember?.voice?.channelId !== TEMP_VOICE_TRIGGER_CHANNEL_ID) return;
      const now = Date.now();
      const lockTs = tempVoiceCreateLockByUser.get(member.id) || 0;
      if (now - lockTs < 5000) {
        const existingLocked = findOwnedTempVoiceChannelDeep(newState.guild, member.id);
        if (existingLocked) {
          await member.voice.setChannel(existingLocked, 'Move user to existing temp voice (debounced)');
        }
        return;
      }
      tempVoiceCreateLockByUser.set(member.id, now);

      const existingOwned = findOwnedTempVoiceChannelDeep(newState.guild, member.id);
      if (existingOwned) {
        await member.voice.setChannel(existingOwned, 'Move user to existing owned temp voice');
        tempVoiceCreateLockByUser.delete(member.id);
        return;
      }
      const created = await newState.guild.channels.create({
        name: buildTempVoiceName(member),
        type: ChannelType.GuildVoice,
        parent: TEMP_VOICE_CATEGORY_ID,
        reason: `Temp voice requested by ${member.user.tag}`,
      });
      tempVoiceOwners.set(created.id, member.id);
      saveTempVoiceOwners();
      await applyTempVoiceOwner(created, member.id);
      const currentMemberAfterCreate = await newState.guild.members.fetch(member.id).catch(() => member);
      if (currentMemberAfterCreate?.voice?.channelId !== TEMP_VOICE_TRIGGER_CHANNEL_ID) {
        if (created.members.filter((m) => !m.user.bot).size === 0) {
          await created.delete('Duplicate create race cleanup');
          tempVoiceOwners.delete(created.id);
          saveTempVoiceOwners();
        }
        tempVoiceCreateLockByUser.delete(member.id);
        return;
      }
      await member.voice.setChannel(created, 'Move user to newly created temp voice');
      if (DEBUG) console.log(`[temp-voice] Created ${created.id} for ${member.user.tag}`);
      tempVoiceCreateLockByUser.delete(member.id);
    } catch (err) {
      console.error('Temp voice create/move failed:', err.message || err);
      tempVoiceCreateLockByUser.delete(member.id);
    }
  }

  if (isTrackedTempVoiceChannel(leftChannel)) {
    const occupantsLeft = getVoiceStateOccupancy(newState.guild, leftChannel.id);
    if (occupantsLeft === 0) {
      try {
        tempVoiceOwners.delete(leftChannel.id);
        saveTempVoiceOwners();
        await leftChannel.delete('Temp voice empty');
        if (DEBUG) console.log(`[temp-voice] Deleted empty channel ${leftChannel.id}`);
      } catch (err) {
        if ((err.message || '').includes('Unknown Channel')) return;
        console.error('Temp voice delete failed:', err.message || err);
      }
    }
  }
});

// When a user joins the server, post the welcome video + user tag in #new-arrivals (skip if already welcomed on role to avoid double message)
// Welcome each UserID only ONCE ever (persisted); skip very new accounts (bot/alt filter)
client.on('guildMemberAdd', async (member) => {
  if (!isGvMainGuild(member.guild.id)) return;
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
  if (!isGvMainGuild(newMember.guild.id)) return;
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

  if (await handleTempVoiceCommand(message)) return;

  if (message.author.bot) return;

  // 4-image scam: all channels, delete + Court Jester only — no exemptions
  if (FOUR_IMAGE_SCAM_BLOCK) {
    const scamReason = await detectFourImageScam(message);
    if (scamReason) {
      await handleFourImageScam(message, scamReason);
      return;
    }
    scheduleFourImageScamAttachmentRecheck(message);
  }

  // Midland Nation EU: delete + warn DM + offense log (same text triggers as gv-general holds).
  if (MIDLAND_EU_ENABLED && isMessageInMidlandEuModScope(message)) {
    await handleMidlandEuMessage(message);
    return;
  }

  if (!isGvMainGuild(message.guild.id)) {
    if (DEBUG) console.log(`[skip] not GV main guild (${message.guild.id})`);
    return;
  }

  const channelId = String(message.channelId);

  // Admin channel: ignore for welcome — we only welcome via guildMemberAdd (and role assign) so we never post on "Member left" from Carl-bot
  if (channelId === ADMIN_JOIN_CHANNEL_ID) {
    return; // don't run gv-general triggers for admin channel
  }

  // If someone engages with the watched user (reply, @mention, or reaction), forgive rolling spam counters.
  if (String(message.author.id) !== SPAM_WATCH_USER_ID && message.reference?.messageId) {
    const repliedTo = await fetchSpamWatchReferencedMessage(message);
    const rid = repliedTo?.author?.id;
    if (repliedTo && rid && String(rid) === SPAM_WATCH_USER_ID && isMessageInGvGeneral(repliedTo)) {
      resetSpamWatchRollingCounters(`reply from ${message.author.id}`);
    }
  }
  if (
    String(message.author.id) !== SPAM_WATCH_USER_ID
    && message.mentions?.users?.has(SPAM_WATCH_USER_ID)
  ) {
    resetSpamWatchRollingCounters(`mention of <@${SPAM_WATCH_USER_ID}> from ${message.author.id}`);
  }

  // TEMPORARY: Noobmars auto-reply disabled (DM + hold-channel author ping when list users tag/mention target).
  // Re-enable when ready: uncomment block below.
  // if (shouldReplyNoobmars(message)) {
  //   try {
  //     await message.author.send(getNoobmarsDmPayload());
  //   } catch (err) {
  //     console.error('Noobmars DM failed (user may have DMs closed):', err.message);
  //     if (channelId === TRIGGER_CHANNEL_ID) {
  //       await relayNoobmarsToHoldOnDmFailure(message);
  //     }
  //   }
  //   return;
  // }

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

  if (!isMessageInGvGeneral(message)) {
    if (DEBUG) console.log(`[skip] not gv-general (channel ${channelId})`);
    return; // gv-general + threads under it only
  }

  const rawGvContent = message.content ? String(message.content) : '';
  const gvModerationText = stripOuterQuotesForGeneral(rawGvContent.trim()) || rawGvContent;

  const csamScanText = getMessageTextForCsamScan(message);
  if (csamScanText && hasCsamGroomingTrigger(csamScanText)) {
    if (DEBUG) console.log(`[csam-hold] Trigger for ${message.author.tag}`);
    await deleteInGeneralAndForwardCsamAck(message);
    return;
  }

  if (messageHasBlockedMediaId(message)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    if (DEBUG) console.log(`[blocked-media] ${message.author.tag}`);
    return;
  }

  if (await handleSpamWatchVolumeFlush(message)) return;

  // Before empty-content skip: watched user attachment/sticker spam must still hit handleSpamWatchUser.
  if (await handleSpamWatchUser(message)) return;

  if (!message.content && !messageHasTenorLink(message)) {
    if (DEBUG) console.log('[skip] empty content (enable Message Content Intent in Discord Developer Portal → Bot)');
    return;
  }

  // Elder Futhark / runic text: skip remaining gv-general moderation (harassment, slur GIF, geopolitics, religion filter, …).
  // CSAM/blocked-media/spam-watch already ran above. Slurs still block via hasSpamSlur on raw + transliterated text.
  if (isRunicInscriptionAllowed(gvModerationText)) {
    if (DEBUG) console.log('[skip] runic inscription (Unicode runes + slur scan):', gvModerationText.slice(0, 80));
    scheduleRunicLatinFollowUp(message);
    return;
  }

  // Serious slurs (global list + anti-Indian/South-Asian slurs) — always enforced before multilingual bypass.
  if (hasSpamSlur(gvModerationText) || hasIndianAsianRaceSlur(gvModerationText)) {
    const userId = message.author.id;
    const repeated = isRepeatedSlurOffender(userId);
    recordSlurReply(userId);
    const videoPayload = getSpamVideoPayload();
    const gifOrVideoPayload = repeated ? videoPayload : TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardMovedHold(message, gifOrVideoPayload);
    return;
  }

  if (isGvCharacterStatMessage(gvModerationText)) {
    if (DEBUG) console.log('[skip] GV character stat message:', gvModerationText.slice(0, 80));
    return;
  }

  // Any Tenor GIF (any language slug / CDN URL) — skip English-centric holds below (geo, off-topic, religion/politics).
  if (messageHasTenorLink(message)) {
    if (DEBUG) console.log('[skip] Tenor GIF link — allowed in gv-general');
    return;
  }

  // Non–English-primary casual banter: skip English-centric holds (off-topic phrase bag, religion/politics ratio, geo, …).
  if (MULTILINGUAL_BANTER_BYPASS && isPrimarilyNonEnglishCasualChat(gvModerationText)) {
    if (DEBUG) console.log('[skip] multilingual casual chat:', gvModerationText.slice(0, 80));
    return;
  }

  // Harassment/race-bait evasion (e.g. "de lusional ... black plague player ... big fella") → hold channel.
  if (hasHarassmentRaceBaitEvasion(gvModerationText, message.author.id)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Monkey-emoji / moderation trope OR in-game “monkey noises” comms culture: react only, do not return
  if (hasMonkeyModerationTrope(gvModerationText) || hasMonkeyNoisesCultureTrope(gvModerationText)) {
    try {
      const tropeEmoji = MONKEY_TROPE_EMOJIS[Math.floor(Math.random() * MONKEY_TROPE_EMOJIS.length)];
      await message.react(tropeEmoji);
      if (DEBUG) console.log(`[monkey-trope] Reacted ${tropeEmoji} for ${message.author.tag}`);
    } catch (err) {
      console.error('Monkey trope reaction failed (set MONKEY_TROPE_EMOJIS to comma-separated unicode or <:emoji:id> that exist in this server):', err.message);
    }
  }

  // "Poor … Savage" — reply with raid meme video (gv-general only)
  if (hasPoorSomethingSavageTrigger(gvModerationText)) {
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

  // "Where is Miaow?" / "Miaow is missing!" – reply with Emperor role ping + random Miaow image (author must have Miðland role)
  if (hasMiaowWhereTrigger(gvModerationText)) {
    const hasTriggerRole = await memberHasMiaowTriggerRole(message);
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
    } else {
      console.warn(
        `[miaow] Phrase matched but no Miðland role for ${message.author.tag} (${message.author.id}) — check MIAOW_TRIGGER_ROLE_ID=${MIAOW_TRIGGER_ROLE_ID}`,
      );
    }
    return;
  }

  // "Soon" trigger: react with :soon:; for game-related phrases only (when can we play, is the game up, any eta, etc.) also post a random Soon meme image
  if (hasSoonTrigger(gvModerationText)) {
    try {
      await message.react(SOON_EMOJI);
    } catch (err) {
      console.error('Soon emoji reaction failed (emoji must exist in this server):', err.message);
    }
    if (hasSoonTriggerWithImage(gvModerationText)) {
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

  // Racial/religious stereotype bait (e.g. "isn't everyone south of the border Mexican?") — hold channel, no safe-context bypass
  if (hasStereotypeRaceReligionRedirect(gvModerationText)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Psychiatric / disability slurs (e.g. "schizo", "they're autistic") — hold channel, no safe-context bypass
  if (hasMedicalPsychiatricInsult(gvModerationText)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // "You're a danger" / "danger to players" (IRL or targeting users) — before safe-context so bare "players" doesn't bypass.
  if (hasDangerFramingTargetPlayersOrHumans(gvModerationText)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Safe-context short-circuit for normal GV chat before geopolitical/off-topic/religion paths.
  // Hard filters above (slurs / stereotype / medical) remain non-bypassable.
  if (hasSafeContext(gvModerationText)) {
    if (DEBUG) console.log('[skip] safe-context word in:', gvModerationText.slice(0, 80));
    return; // game/community context – don't trigger
  }

  // Geopolitical keywords (states, NATO, UN, sanctions, invasion, regime, …)
  if (hasGeopoliticalHardRedirect(gvModerationText)) {
    const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardMovedHold(message, randomGif);
    return;
  }

  // IRL Balkans / former Yugoslavia discussion (travel, history, identity) — same hold flow as geopolitical
  if (hasBalkansRealWorldOffTopicRedirect(gvModerationText)) {
    const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardMovedHold(message, randomGif);
    return;
  }

  // Off-topic phrases (vulgar/body/gender/race): Mace Windu GIF. Delete in gv-general, repost to hold channel.
  if (hasOffTopicPhrase(gvModerationText)) {
    await deleteInGeneralAndForwardMovedHold(message, OFF_TOPIC_GIF);
    return;
  }

  // Religion/politics/goy: trigger if ≥80% filter words OR ideological phrases OR obvious religion/politics phrases
  if (!shouldTriggerReligionPolitics(gvModerationText)) {
    if (DEBUG) console.log('[skip] not religion/politics:', gvModerationText.slice(0, 80));
    return;
  }

  // Religion/politics/ideological: random GIF. Delete in gv-general, repost to hold channel.
  const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
  await deleteInGeneralAndForwardMovedHold(message, randomGif);
});

// Scam posts sometimes gain attachments after the first messageCreate — re-scan on update.
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || !FOUR_IMAGE_SCAM_BLOCK) return;
  try {
    if (newMessage.partial) await newMessage.fetch();
    if (oldMessage.partial) await oldMessage.fetch().catch(() => null);
  } catch {
    return;
  }
  const oldN = oldMessage.attachments?.size || 0;
  const newN = newMessage.attachments?.size || 0;
  if (newN <= oldN) return;
  const reason = await detectFourImageScam(newMessage);
  if (reason) await handleFourImageScam(newMessage, reason);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (!user || user.bot || String(user.id) === SPAM_WATCH_USER_ID) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    if (isSpamWatchTargetMessage(reaction.message)) {
      resetSpamWatchRollingCounters(`reaction from ${user.id}`);
    }
  } catch (err) {
    if (DEBUG) console.warn('[spam-watch] reaction reset check failed:', err.message);
  }
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
