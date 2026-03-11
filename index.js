const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Parser = require('rss-parser');

// --- Config (env or defaults for local) ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;

// --- Channel IDs ---
// Trigger channel = gv-general (bot listens here for slurs, off-topic, religion/politics, Soon).
const TRIGGER_CHANNEL_ID = String(process.env.TRIGGER_CHANNEL_ID || '1166738417539887218');
const GV_GENERAL_CHANNEL_ID = String(process.env.GV_GENERAL_CHANNEL_ID || TRIGGER_CHANNEL_ID); // channel to post new-arrival video
// Admin-only channel: we skip gv-general triggers for messages here; welcomes are only from guildMemberAdd (not from Carl-bot log)
const ADMIN_JOIN_CHANNEL_ID = String(process.env.ADMIN_JOIN_CHANNEL_ID || '1166746316999757864');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
// Message to send when a word is detected
const REDIRECT_CHANNEL_ID = '1168446788810842172';
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
// RSS feed → Discord announcement channel (e.g. Gloria Victis news). If the site has no RSS, use a converter like https://rss.app/ with the news page URL.
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '1166742322738905178';
const RSS_FEED_URL = process.env.RSS_FEED_URL || 'https://rss.app/feeds/570E40bRtM0TKZJF.xml'; // Gloria Victis | gamigo news (override with env if needed)
const RSS_POLL_INTERVAL_MS = Math.max(60000, parseInt(process.env.RSS_POLL_INTERVAL_MS, 10) || 15 * 60 * 1000); // default 15 min
const RSS_SEEN_FILE = path.join(process.cwd(), 'rss-seen.json');
const NEW_ARRIVALS_CHANNEL_ID = process.env.NEW_ARRIVALS_CHANNEL_ID || '1166775627089719436'; // notify when user gets a role
// Role IDs that count as "nation/faction" choice — welcome only when new user picks one of these for the first time
const WELCOME_ROLE_IDS = new Set(['1167525339103248384', '1167525255577870396', '1167525387413229628', '1167524888941187272']); // nation roles + veteran
const NEW_USER_JOIN_DAYS = Math.max(0, parseInt(process.env.NEW_USER_JOIN_DAYS, 10) || 7); // only welcome if joined within this many days
const NEW_USER_JOIN_WINDOW_MS = NEW_USER_JOIN_DAYS * 24 * 60 * 60 * 1000;
// Welcome videos when user joins or gets their role — one is picked at random (add more via env NEW_ARRIVAL_VIDEO_URLS comma-separated, or use defaults)
const NEW_ARRIVAL_VIDEO_URLS = (process.env.NEW_ARRIVAL_VIDEO_URLS || process.env.NEW_ARRIVAL_VIDEO_URL || 'https://streamable.com/vxi8bu,https://streamable.com/63lazw')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);
function getRandomWelcomeVideoUrl() {
  return NEW_ARRIVAL_VIDEO_URLS[Math.floor(Math.random() * NEW_ARRIVAL_VIDEO_URLS.length)] || 'https://streamable.com/vxi8bu';
}
const REDIRECT_MESSAGE = `Please move to <#${REDIRECT_CHANNEL_ID}> instead.`;
// Image + text for "Chronicus Generalium" reply in gv-general when user is moved to off-topic
const CHRONICUS_IMAGE_PATH = path.join(process.cwd(), 'assets', 'memes', 'v11.png');
const CHRONICUS_TEXT = '**Chronicus Generalium**\n\n***A long-lasting condition marked by the inability to locate the Off-Topic scrolls and a mystical attraction to gv-general.***';

// "Soon" reaction: when someone asks about game/servers/ETA, bot reacts with this custom emoji (gv-general only)
const SOON_EMOJI = '<:Soon:1480665289715617842>';
function buildSoonTriggerPhrases() {
  const phrases = new Set();
  const add = (p) => { if (p && p.length > 0) phrases.add(p.toLowerCase()); };

  // game / gaem / gæm variants
  ['game', 'gaem', 'gæm', 'gamm', 'gaeme'].forEach(g => {
    add(g); add(g + '?'); add(g + ' up'); add(g + ' up?'); add(g + ' open'); add(g + ' open?');
    add('when ' + g); add('when\'s ' + g); add('when is ' + g); add('when\'s the ' + g); add('when is the ' + g);
    add('is the ' + g + ' up'); add('is ' + g + ' up'); add('is ' + g + ' up?'); add('is the ' + g + ' out');
    add(g + ' when'); add(g + ' when?'); add('when does ' + g + ' open'); add('when will ' + g + ' open');
    add('when can we play ' + g); add('when can i play ' + g); add('when can we play'); add('when can i play');
  });

  // server(s) open/up/live
  ['server', 'servers', 'servr', 'servrs'].forEach(s => {
    add(s + ' open'); add(s + ' open?'); add(s + ' up'); add(s + ' up?'); add(s + ' live'); add(s + ' live?');
    add('is ' + s + ' open'); add('are ' + s + ' open'); add('is the ' + s + ' open'); add('are the ' + s + ' open');
    add(s + ' open yet'); add(s + ' up yet'); add('when do ' + s + ' open'); add('when will ' + s + ' open');
    add('when are ' + s + ' open'); add('when is ' + s + ' open'); add('when ' + s + ' open'); add('when ' + s + ' up');
    add('servers status'); add('server status');
  });
  add('open yet'); add('up yet'); add('is it open yet'); add('are we live'); add('is it live'); add('are servers up');
  add('is server up'); add('servers online'); add('server online'); add('game online'); add('game live');

  // play / can we play / when can we
  ['play', 'play yet', 'play now', 'can we play', 'can we play?', 'can we play yet', 'can i play', 'can i play?', 'can i play yet',
   'when can we play', 'when can we play?', 'when can i play', 'when can i play?', 'can we play now', 'can i play now',
   'ready to play', 'when can we play the game', 'when can i play the game', 'able to play', 'when can we get in',
   'can we get in', 'can i get in', 'when can we get in the game', 'get in the game', 'join the game', 'when can we join'].forEach(add);

  // ETA / when / release / launch
  ['eta', 'eta?', 'any eta', 'what\'s the eta', 'whats the eta', 'any eta?', 'got an eta', 'got a eta', 'have an eta',
   'when\'s it out', 'when is it out', 'when out', 'when\'s the release', 'when is the release', 'release when',
   'release date', 'when release', 'when\'s release', 'launch when', 'when launch', 'when\'s launch', 'when is launch',
   'when does it open', 'when will it open', 'when does the game open', 'when will the game open', 'when is the game open',
   'game release', 'game release?', 'when game release', 'release the game', 'when\'s the game coming', 'when is the game coming',
   'game coming out', 'when coming out', 'when\'s it coming', 'when is it coming', 'any news on', 'any news on the game',
   'any word on', 'any word on the game', 'heard anything about', 'heard anything about the game', 'any update on',
   'any update on the game', 'when\'s the update', 'when is the update', 'update when', 'patch when', 'when patch',
   'maintenance over', 'maintenance done', 'servers back', 'server back', 'back up yet', 'is it back up'].forEach(add);

  // "game when" style
  ['game when', 'game when?', 'game out when', 'game out?', 'game ready', 'game ready?', 'game available', 'game available?',
   'game drop', 'game drop?', 'when drop', 'when\'s the drop', 'game live yet', 'live yet', 'playable yet', 'is it playable',
   'can we play yet', 'we can play yet', 'can we get on', 'when can we get on', 'get on the game', 'when get on',
   'log in yet', 'can we log in', 'when can we log in', 'login yet', 'servers back up', 'server back up',
   'anyone know when', 'anyone know when the game', 'anyone know when servers', 'know when the game', 'know when servers',
   'when we getting', 'when we getting the game', 'when are we getting', 'when we get to play', 'time to play',
   'is it time to play', 'can we start playing', 'when can we start playing', 'start playing', 'playing yet',
   'are we playing', 'we playing yet', 'game time', 'game time?', 'when game time', 'game out yet', 'out yet',
   'game up yet', 'up yet', 'still down', 'game still down', 'servers still down', 'server still down',
   'when\'s it live', 'when is it live', 'when\'s the game live', 'when is the game live', 'going live', 'when going live',
   'going up', 'when going up', 'coming up', 'when coming up', 'opening when', 'when opening', 'opens when',
   'when does it go live', 'when will it go live', 'when do servers go live', 'when will servers go live',
   'gæm?', 'gaem?', 'game?', 'wen game', 'wen gaem', 'when gaem', 'when gæm', 'whn game', 'whens game',
   'game wen', 'gaem when', 'servers wen', 'wen servers', 'when servrs', 'play wen', 'wen play',
   'can we play rn', 'can i play rn', 'play rn', 'game rn', 'servers rn', 'up rn', 'open rn',
   'any chance we can play', 'any chance to play', 'any chance the game', 'any chance servers',
   'is the game out', 'game out', 'game out?', 'when\'s the game out', 'when is the game out',
   'game available yet', 'available yet', 'ready yet', 'is it ready', 'is the game ready',
   'when will we be able to play', 'when can we start', 'when can i start', 'able to play yet',
   'can we access', 'when can we access', 'when can i access', 'access the game', 'game access',
   'servers working', 'server working', 'is server working', 'are servers working', 'game working',
   'when\'s the beta', 'when is the beta', 'beta when', 'beta out', 'beta open', 'when beta',
   'early access when', 'when early access', 'early access yet', 'open beta', 'open beta?',
   'closed beta when', 'when closed beta', 'alpha when', 'when alpha', 'test when', 'when test',
   'stress test', 'when stress test', 'beta test when', 'when beta test', 'playtest when',
   'downtime over', 'downtime done', 'when\'s downtime over', 'maintenance when', 'when maintenance',
   'patch out', 'patch out?', 'when patch out', 'update out', 'update out?', 'when update',
   'hotfix when', 'when hotfix', 'fix when', 'when fix', 'back online', 'online yet',
   'game back', 'servers back yet', 'back yet', 'is it back', 'are we back', 'we back',
   'can we hop on', 'when can we hop on', 'hop on', 'hop on the game', 'get on yet',
   'when\'s it dropping', 'when is it dropping', 'when dropping', 'drop when', 'game drop when',
   'launch when', 'when\'s launch', 'when is launch', 'launch date', 'launch date?', 'when\'s launch date',
   'release date?', 'when release date', 'release when', 'when\'s the release date', 'release the game when',
   'any info on', 'any info on the game', 'any info on servers', 'got info', 'any news', 'any news?',
   'when we playing', 'we playing', 'playing today', 'play today', 'can we play today',
   'tomorrow', 'game tomorrow', 'servers tomorrow', 'open tomorrow', 'when tomorrow',
   'this week', 'game this week', 'servers this week', 'release this week', 'this weekend',
   'game this weekend', 'play this weekend', 'next week', 'game next week', 'servers next week',
   'still waiting', 'waiting for game', 'waiting for servers', 'waiting to play', 'when can we stop waiting',
   'im waiting', 'i\'m waiting', 'we waiting', 'still no game', 'still no servers', 'no game yet',
   'no servers yet', 'game not out', 'servers not up', 'not open yet', 'not up yet', 'not live yet',
   'delayed', 'game delayed', 'release delayed', 'when\'s the delay', 'delay when', 'delayed when',
   'postponed', 'game postponed', 'release postponed', 'pushed back', 'game pushed back',
   'wen', 'wen game', 'wen servers', 'wen play', 'wen open', 'wen up', 'wen release', 'wen launch',
   'whn', 'whens', 'when\'s', 'when is', 'when are', 'when will', 'when do', 'when can',
   'game when', 'gaem when', 'gæm when', 'servers when', 'server when', 'play when', 'open when',
   'when game', 'when gaem', 'when gæm', 'when servers', 'when server', 'when play', 'when open',
   'game?', 'gaem?', 'gæm?', 'servers?', 'server?', 'play?', 'open?', 'up?', 'eta?',
   'soon?', 'when soon', 'how soon', 'how soon until', 'how long until', 'how long until we can play',
   'how long until servers', 'how long until game', 'how much longer', 'how much longer until',
   'any minute now', 'any time now', 'should be soon', 'supposed to be soon', 'was supposed to open',
   'was supposed to be up', 'should be up', 'should be open', 'should be live', 'must be soon',
  ].forEach(add);

  return [...phrases];
}
const SOON_TRIGGER_PHRASES = buildSoonTriggerPhrases();
console.log(`Soon trigger phrases: ${SOON_TRIGGER_PHRASES.length}`);

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

// Reference: which media goes with which trigger (all in gv-general → delete + forward to #off-topic unless noted)
// • Slurs (first time)  → random TENOR_GIF  | Slurs (repeated in 1h) → VIDEO_URL (TMFIAR streamable.com/e/mwfkm2)
// • Off-topic phrases   → OFF_TOPIC_GIF (Mace Windu only)
// • Religion/politics  → random TENOR_GIF
// • Soon (Gæm?, ETA?)  → SOON_EMOJI reaction only (no delete/forward)
// • New member welcome → random from NEW_ARRIVAL_VIDEO_URLS (e.g. streamable.com/vxi8bu, streamable.com/63lazw) in gv-general, user mentioned by ID

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
  // Gloria Victis Wiki – game/lore so "war", "empire", "worship" etc. don't trigger
  'state of war', 'gloria victis', 'black eye games',
  'midland', 'midlanders', 'azebia', 'azebs', 'nordheim', 'ismirs', 'sangmar', 'sangarians',
  'empire of azebia', 'azebian', 'midlandic', 'sangmar empire',
  'forefather', 'greatfather', 'khagan', 'zenith',
  'crafting', 'economy', 'bosses', 'recipes', 'resources', 'shields', 'glory', 'reputation',
  'guild', 'siege', 'territory', 'non-targeting', 'loot', 'medieval', 'mmorpg',
  'geliand', 'hillead', 'infidels', 'island', 'fashion', 'chests', 'titles', 'interfaces', 'map',
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
].map(w => w.toLowerCase());

// Religion-related "goy" terms – same as religion/politics: redirect to #off-topic with random GIF (no safe-context bypass)
const GOY_TERMS = [
  'goy', 'goyim', 'goyish', 'goys', 'goyische', 'goyishe', 'goyisher', 'goyem', 'goi', 'goim', 'g0y', 'g0yim',
].map(w => w.toLowerCase());

// Off-topic phrases – vulgar/objectifying by body, gender, race, nationality. Bot replies with GIF + redirect (no safe-context bypass)
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

  return [...phrases];
}
const OFF_TOPIC_PHRASES = buildOffTopicPhrases();
console.log(`Off-topic phrases: ${OFF_TOPIC_PHRASES.length} (body/gender/race/nationality variants).`);

// Video reply: default is Streamable link so the bot always has access. Override with VIDEO_URL or VIDEO_PATH (local file).
const DEFAULT_VIDEO_URL = 'https://streamable.com/e/mwfkm2';
const VIDEO_URL = process.env.VIDEO_URL !== undefined && process.env.VIDEO_URL !== '' ? process.env.VIDEO_URL : DEFAULT_VIDEO_URL;
const VIDEO_PATH = process.env.VIDEO_PATH || (() => {
  const inRepo = 'assets/TMFIAR.mp4';
  if (fs.existsSync(inRepo)) return inRepo;
  if (process.platform === 'win32') return 'C:\\Users\\serje\\Downloads\\TMFIAR.mp4';
  return inRepo;
})();

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

// If message contains any safe-context word (game/community talk), don't trigger
function hasSafeContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const word of SAFE_CONTEXT_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

// Check if message contains any spam/slur term (case-insensitive)
function hasSpamSlur(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return SPAM_SLUR_TERMS.some(term => lower.includes(term));
}

// Check if message contains any off-topic phrase (case-insensitive substring)
function hasOffTopicPhrase(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return OFF_TOPIC_PHRASES.some(phrase => lower.includes(phrase));
}

// Check if message contains any goy-related term (religion filter)
function hasGoyTerm(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return GOY_TERMS.some(term => lower.includes(term));
}

// Religion/politics: only trigger if ≥80% of words are filter words (so normal sentences with one trigger word don't get moved)
const RELIGION_POLITICS_RATIO = Math.min(1, Math.max(0.5, parseFloat(process.env.RELIGION_POLITICS_RATIO) || 0.8));
const RELIGION_POLITICS_MIN_WORDS = Math.max(2, parseInt(process.env.RELIGION_POLITICS_MIN_WORDS, 10) || 3);

function tokenizeWords(text) {
  if (!text || typeof text !== 'string') return [];
  return stripEmojis(text)
    .split(/\s+/)
    .map(w => w.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, '').toLowerCase())
    .filter(w => w.length > 0);
}

function wordMatchesTriggerWord(word) {
  if (!word) return false;
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

/** Returns true only if the message is mostly (≥80%) religion/politics/goy trigger words, so normal chat is not moved. */
function isMostlyReligionPolitics(text) {
  const words = tokenizeWords(text);
  if (words.length < RELIGION_POLITICS_MIN_WORDS) return false;
  let triggerCount = 0;
  for (const w of words) {
    if (wordMatchesTriggerWord(w) || wordContainsGoy(w)) triggerCount++;
  }
  return triggerCount / words.length >= RELIGION_POLITICS_RATIO;
}

// Check if message is asking about game/servers/ETA (triggers "Soon" emoji reaction)
function hasSoonTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  return SOON_TRIGGER_PHRASES.some(phrase => lower.includes(phrase));
}

// Get video attachment or URL for spam reply (returns { files } or { content } for message.reply)
function getSpamVideoPayload() {
  if (VIDEO_URL) return { content: VIDEO_URL };
  const path = VIDEO_PATH;
  if (path && fs.existsSync(path)) {
    return { files: [{ attachment: path, name: 'TMFIAR.mp4' }] };
  }
  return { content: '(Video not configured: set VIDEO_PATH or VIDEO_URL, or add assets/TMFIAR.mp4)' };
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

// Delete message in gv-general and forward it to #off-topic with user tag and same GIF/video response; then post Chronicus Generalium in gv-general
async function deleteInGeneralAndForwardToOffTopic(message, gifOrVideoUrl) {
  try {
    await message.delete();
  } catch (err) {
    console.error('Could not delete message in gv-general (need Manage Messages):', err.message);
  }
  try {
    const channel = await message.client.channels.fetch(REDIRECT_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    const movedText = message.content ? String(message.content).slice(0, 1500) : '(no text)';
    const content = [
      `${message.author.toString()} — moved from <#${TRIGGER_CHANNEL_ID}>:`,
      `\`\`\`${movedText}${message.content && message.content.length > 1500 ? '…' : ''}\`\`\``,
      REDIRECT_MESSAGE,
      gifOrVideoUrl,
    ].join('\n\n');
    await channel.send({ content });
  } catch (err) {
    console.error('Forward to off-topic failed:', err);
  }
  try {
    const generalChannel = await message.client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (generalChannel?.isTextBased()) {
      const chronicusContent = `${message.author.toString()}\n\n${CHRONICUS_TEXT}`;
      const payload = fs.existsSync(CHRONICUS_IMAGE_PATH)
        ? { content: chronicusContent, files: [{ attachment: CHRONICUS_IMAGE_PATH, name: 'v11.png' }] }
        : { content: chronicusContent };
      await generalChannel.send(payload);
    }
  } catch (err) {
    console.error('Chronicus Generalium post failed:', err.message);
  }
}

// Track users we've already welcomed for picking a nation role (first-time only)
const welcomedForNationRoleByUser = new Set();
// User IDs we've already welcomed via guildMemberAdd (clear on leave so we re-welcome if they rejoin)
const welcomedUserIds = new Set();
function recordAdminWelcome(userId) {
  welcomedUserIds.add(userId);
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
  ],
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Trigger channel (gv-general): ${TRIGGER_CHANNEL_ID} — ensure Message Content Intent is ON in Developer Portal`);
  console.log(`Welcomes only from guildMemberAdd (+ first role); admin channel ignored for welcome`);

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

// When a user joins the server, post the welcome video in gv-general (record so scan/messageCreate won't welcome again)
client.on('guildMemberAdd', async (member) => {
  try {
    const channel = await client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({
        content: `Welcome, ${member.user.toString()}!\n${getRandomWelcomeVideoUrl()}`,
      });
      recordAdminWelcome(member.user.id);
      if (DEBUG) console.log(`[new-arrival] Posted welcome video for ${member.user.tag} in gv-general`);
    }
  } catch (err) {
    console.error('New-arrival video post failed:', err);
  }
});

// When a user leaves, allow re-welcome if they rejoin
client.on('guildMemberRemove', (member) => {
  welcomedUserIds.delete(member.id);
});

// When a new user picks one of the nation roles for the first time: notify new-arrivals and welcome in gv-general (only if we didn't already welcome them on join)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.roles.cache.size <= oldMember.roles.cache.size) return; // no role added
  const addedRoleIds = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const pickedNationRole = [...addedRoleIds.keys()].some(id => WELCOME_ROLE_IDS.has(id));
  if (!pickedNationRole) return;

  const userId = newMember.user.id;
  if (welcomedUserIds.has(userId)) return; // already welcomed on guildMemberAdd – don't welcome again for role
  if (welcomedForNationRoleByUser.has(userId)) return; // already welcomed for a nation role (e.g. switching to another)

  const joinedAt = newMember.joinedAt ? newMember.joinedAt.getTime() : 0;
  if (Date.now() - joinedAt > NEW_USER_JOIN_WINDOW_MS) return; // not a "new" user (joined too long ago)

  welcomedForNationRoleByUser.add(userId);
  try {
    const newArrivalsChannel = await client.channels.fetch(NEW_ARRIVALS_CHANNEL_ID);
    if (newArrivalsChannel?.isTextBased()) {
      await newArrivalsChannel.send({
        content: `Welcome ${newMember.user.toString()} — they've chosen their role for the first time!\n${getRandomWelcomeVideoUrl()}`,
      });
      if (DEBUG) console.log(`[role-assign] Notified new-arrivals for ${newMember.user.tag} (first nation role)`);
    }
    const generalChannel = await client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (generalChannel?.isTextBased()) {
      await generalChannel.send({
        content: `Welcome, ${newMember.user.toString()}!\n${getRandomWelcomeVideoUrl()}`,
      });
      if (DEBUG) console.log(`[role-assign] Welcome posted in gv-general for ${newMember.user.tag}`);
    }
  } catch (err) {
    console.error('Role-assign welcome failed:', err);
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

  // Specific user: move their media (GIF/image/video or tenor.com links) when the message text contains religion/politics to #off-topic
  if (message.author.id === MEDIA_RELIGION_OFFTOPIC_USER_ID) {
    const hasImageOrVideo = message.attachments?.some(
      a => IMAGE_CONTENT_TYPES.test(a.contentType || '') || VIDEO_CONTENT_TYPES.test(a.contentType || '') || IMAGE_EXTENSIONS.test(a.name || '')
    );
    const hasTenorLink = message.content && message.content.includes('tenor.com');
    const hasMedia = hasImageOrVideo || hasTenorLink;
    const hasReligionPolitics = message.content && isMostlyReligionPolitics(message.content);
    if (hasMedia && hasReligionPolitics) {
      const randomGifMedia = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
      await deleteInGeneralAndForwardToOffTopic(message, randomGifMedia);
      if (DEBUG) console.log(`[media-religion] Moved ${message.author.tag} media+religion/politics to off-topic`);
      return;
    }
  }

  if (!message.content) {
    if (DEBUG) console.log('[skip] empty content (enable Message Content Intent in Discord Developer Portal → Bot)');
    return;
  }

  // "Soon" trigger: Gæm?, ETA?, Servers open?, When can we play?, etc. — react with Soon emoji only (no delete/forward)
  if (hasSoonTrigger(message.content)) {
    try {
      await message.react(SOON_EMOJI);
    } catch (err) {
      console.error('Soon emoji reaction failed (emoji must exist in this server):', err.message);
    }
    return;
  }

  // Slur: first offense = GIF + redirect; repeated/spam (same user within 1h) = video. Delete in gv-general, forward to #off-topic.
  if (hasSpamSlur(message.content)) {
    const userId = message.author.id;
    const repeated = isRepeatedSlurOffender(userId);
    recordSlurReply(userId);
    const videoPayload = getSpamVideoPayload();
    const gifOrVideoUrl = repeated ? (videoPayload.content || VIDEO_URL) : TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
    await deleteInGeneralAndForwardToOffTopic(message, gifOrVideoUrl);
    return;
  }

  // Off-topic phrases (vulgar/body/gender/race): Mace Windu GIF. Delete in gv-general, forward to #off-topic.
  if (hasOffTopicPhrase(message.content)) {
    await deleteInGeneralAndForwardToOffTopic(message, OFF_TOPIC_GIF);
    return;
  }

  if (hasSafeContext(message.content)) {
    if (DEBUG) console.log('[skip] safe-context word in:', message.content.slice(0, 80));
    return; // game/community context – don't trigger
  }

  // Religion/politics/goy: only if ≥80% of words are filter words (normal sentences with one trigger word stay)
  if (!isMostlyReligionPolitics(message.content)) {
    if (DEBUG) console.log('[skip] not mostly religion/politics:', message.content.slice(0, 80));
    return;
  }

  // Religion/politics: random GIF. Delete in gv-general, forward to #off-topic.
  const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
  await deleteInGeneralAndForwardToOffTopic(message, randomGif);
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

// --- Start bot ---
if (!DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in environment (e.g. on Render: Environment tab).');
  process.exit(1);
}
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Discord login failed:', err.message || err);
  process.exit(1);
});
