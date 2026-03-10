const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const http = require('http');

// --- Config (env or defaults for local) ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;

// --- Channel IDs ---
// Trigger channel = gv-general (bot listens here for slurs, off-topic, religion/politics, Soon).
const TRIGGER_CHANNEL_ID = String(process.env.TRIGGER_CHANNEL_ID || '1166738417539887218');
const GV_GENERAL_CHANNEL_ID = String(process.env.GV_GENERAL_CHANNEL_ID || TRIGGER_CHANNEL_ID); // channel to post new-arrival video
// Admin channel that gets join notifications — when we see a join message here, we welcome that user in gv-general (fallback if guildMemberAdd doesn't fire)
const ADMIN_JOIN_CHANNEL_ID = String(process.env.ADMIN_JOIN_CHANNEL_ID || '1166746316999757864');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
// Message to send when a word is detected
const REDIRECT_CHANNEL_ID = '1168446788810842172';
const NEW_ARRIVALS_CHANNEL_ID = process.env.NEW_ARRIVALS_CHANNEL_ID || '1166775627089719436'; // notify when user gets a role
// Role IDs that count as "nation/faction" choice — welcome only when new user picks one of these for the first time
const WELCOME_ROLE_IDS = new Set(['1167525339103248384', '1167525255577870396', '1167525387413229628', '1167524888941187272']); // nation roles + veteran
const NEW_USER_JOIN_DAYS = Math.max(0, parseInt(process.env.NEW_USER_JOIN_DAYS, 10) || 7); // only welcome if joined within this many days
const NEW_USER_JOIN_WINDOW_MS = NEW_USER_JOIN_DAYS * 24 * 60 * 60 * 1000;
// Welcome video when user joins or gets their role
const NEW_ARRIVAL_VIDEO_URL = process.env.NEW_ARRIVAL_VIDEO_URL || 'https://streamable.com/vxi8bu';
const REDIRECT_MESSAGE = `Please move to <#${REDIRECT_CHANNEL_ID}> instead.`;

// "Soon" reaction: when someone asks about game/servers/ETA, bot reacts with this custom emoji (gv-general only)
const SOON_EMOJI = '<:Soon:1480665289715617842>';
const SOON_TRIGGER_PHRASES = [
  'gæm', 'gaem', 'gæm?', 'gaem?', 'game?', 'game up', 'game up?', 'when\'s the game', 'when is the game', 'is the game up',
  'eta', 'eta?', 'any eta',
  'servers open', 'servers open?', 'servers up', 'servers up?', 'server open', 'server open?', 'server up', 'server up?',
  'when can we play', 'when can we play?', 'can we play', 'can we play?', 'can we play yet', 'when do servers open',
  'are servers open', 'is the server open', 'servers open yet', 'open yet', 'when does the game open', 'is it open yet',
  'server status', 'when will servers open', 'when are servers open', 'game open', 'game open?', 'play yet', 'when can i play',
].map(p => p.toLowerCase());

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
// • New member welcome → NEW_ARRIVAL_VIDEO_URL (Knights with sub streamable.com/vxi8bu) in gv-general, user mentioned by ID

// If the message contains any of these (game/community context or benign hobby/life talk), we do NOT trigger
const SAFE_CONTEXT_WORDS = new Set([
  'nations', 'guilds', 'greenleafs', 'greenleaves', 'enemy', 'helping', 'players', 'emotes', 'monke',
  'downvote', 'upvote', 'voted', 'voting', 'sub', // casual voting/sub (e.g. "voted downvote for the sub")
  'grayward', 'gv', // community/game name (avoids "war" in "Grayward" triggering)
  'interest', 'hobbies', 'share', 'experience', 'personal', // hobby/life context ("share an interest", "personal experience")
  'another round', 'round in', // gaming/activity ("another round in JC" = game/server, not religion)
  'emperor', 'represent', // lore/roleplay ("represent'n' the emperor" = in-universe, not politics)
  'jc', 'jarnclan', 'jarn', // JC = JarnClan (game/clan), not Jesus Christ
  'destiny', // game/lore ("destiny of the player base", nation choice), not religion
].map(w => w.toLowerCase()));

// Spam/slur terms – if message contains any of these, bot replies with the video (no safe-context bypass).
// Includes common evasive spellings users type to avoid filters.
const SPAM_SLUR_TERMS = [
  'nigger', 'nigga', 'niggas', 'niggers', 'nigers', 'nigas', 'niga', 'nigra', 'nigrah', 'niggar', 'niggur', 'nigguh', 'niggr', 'niger', 'nigor', 'nigar',
  'n1gga', 'n1gger', 'n1ga', 'n1gas', 'n1ggas', 'n1ggers', 'ni99a', 'ni99er', 'n!gga', 'n!gger', 'n!ga', 'n!gg@', 'nigg@', 'nigg3r', 'n1gg3r', 'nigg4', 'n1gg4',
  'niqqa', 'niqqer', 'n1qqa', 'n1qqer', 'n!qqa', 'n!qqer',
  'mein fuhrer', 'mein fuher', 'mein furer', 'fuhrer', 'fuher', 'furer', 'master race', 'masterrace',
  'kike', 'kikes', 'k1ke', 'k!ke', 'kyke', 'kik3', 'k1k3',
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

// Delete message in gv-general and forward it to #off-topic with user tag and same GIF/video response
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
}

// Track users we've already welcomed for picking a nation role (first-time only)
const welcomedForNationRoleByUser = new Set();

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

// --- Discord bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for guildMemberAdd (enable "Server Members Intent" in Discord Developer Portal)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Trigger channel (gv-general): ${TRIGGER_CHANNEL_ID} — ensure Message Content Intent is ON in Developer Portal`);
  console.log(`Admin join fallback channel: ${ADMIN_JOIN_CHANNEL_ID}`);
});

// When a user joins the server, post the welcome video in gv-general
client.on('guildMemberAdd', async (member) => {
  try {
    const channel = await client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({
        content: `Welcome, ${member.user.toString()}!\n${NEW_ARRIVAL_VIDEO_URL}`,
      });
      if (DEBUG) console.log(`[new-arrival] Posted welcome video for ${member.user.tag} in gv-general`);
    }
  } catch (err) {
    console.error('New-arrival video post failed:', err);
  }
});

// When a new user picks one of the nation roles for the first time: notify new-arrivals and welcome in gv-general
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.roles.cache.size <= oldMember.roles.cache.size) return; // no role added
  const addedRoleIds = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const pickedNationRole = [...addedRoleIds.keys()].some(id => WELCOME_ROLE_IDS.has(id));
  if (!pickedNationRole) return;

  const userId = newMember.user.id;
  if (welcomedForNationRoleByUser.has(userId)) return; // already welcomed for a nation role (e.g. switching)

  const joinedAt = newMember.joinedAt ? newMember.joinedAt.getTime() : 0;
  if (Date.now() - joinedAt > NEW_USER_JOIN_WINDOW_MS) return; // not a "new" user (joined too long ago)

  welcomedForNationRoleByUser.add(userId);
  try {
    const newArrivalsChannel = await client.channels.fetch(NEW_ARRIVALS_CHANNEL_ID);
    if (newArrivalsChannel?.isTextBased()) {
      await newArrivalsChannel.send({
        content: `Welcome ${newMember.user.toString()} — they've chosen their role for the first time!\n${NEW_ARRIVAL_VIDEO_URL}`,
      });
      if (DEBUG) console.log(`[role-assign] Notified new-arrivals for ${newMember.user.tag} (first nation role)`);
    }
    const generalChannel = await client.channels.fetch(GV_GENERAL_CHANNEL_ID);
    if (generalChannel?.isTextBased()) {
      await generalChannel.send({
        content: `Welcome, ${newMember.user.toString()}!\n${NEW_ARRIVAL_VIDEO_URL}`,
      });
      if (DEBUG) console.log(`[role-assign] Welcome posted in gv-general for ${newMember.user.tag}`);
    }
  } catch (err) {
    console.error('Role-assign welcome failed:', err);
    welcomedForNationRoleByUser.delete(userId); // allow retry
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelId = String(message.channelId);

  // Admin channel: if this message looks like a join notification (mentions a user + "joined"/"welcome"), welcome that user in gv-general
  if (channelId === ADMIN_JOIN_CHANNEL_ID) {
    const content = (message.content || '').toLowerCase();
    const hasJoinKeyword = /\b(joined|welcome|just joined)\b/i.test(content) || content.includes('joined the server');
    const mentionedUser = message.mentions?.users?.first();
    if (hasJoinKeyword && mentionedUser) {
      try {
        const generalChannel = await client.channels.fetch(GV_GENERAL_CHANNEL_ID);
        if (generalChannel?.isTextBased()) {
          await generalChannel.send({
            content: `Welcome, ${mentionedUser.toString()}!\n${NEW_ARRIVAL_VIDEO_URL}`,
          });
          if (DEBUG) console.log(`[admin-join] Welcomed ${mentionedUser.tag} in gv-general from admin channel notification`);
        }
      } catch (err) {
        console.error('Admin-join welcome failed:', err);
      }
    }
    return; // don't run gv-general triggers for admin channel
  }

  if (channelId !== TRIGGER_CHANNEL_ID) {
    if (DEBUG) console.log(`[skip] channel ${channelId} !== ${TRIGGER_CHANNEL_ID}`);
    return; // only gv-general
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
  if (!hasTriggerWord(message.content)) {
    if (DEBUG) console.log('[skip] no trigger word in:', message.content.slice(0, 80));
    return;
  }

  // Religion/politics: random GIF. Delete in gv-general, forward to #off-topic.
  const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
  await deleteInGeneralAndForwardToOffTopic(message, randomGif);
});

// --- Health check server (for Render: keep service alive / readiness) ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(PORT, () => {
  console.log(`Health check server on port ${PORT}`);
});

// --- Start bot ---
if (!DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in environment (e.g. on Render: Environment tab).');
  process.exit(1);
}
client.login(DISCORD_TOKEN);
