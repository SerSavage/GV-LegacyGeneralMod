const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const http = require('http');

// --- Config (env or defaults for local) ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;

// Only react to messages in this channel (gv-general)
const TRIGGER_CHANNEL_ID = '1166738417539887218';
// Message to send when a word is detected
const REDIRECT_CHANNEL_ID = '1168446788810842172';
const REDIRECT_MESSAGE = `Please move to <#${REDIRECT_CHANNEL_ID}> instead.`;

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

// If the message contains any of these (game/community context), we do NOT trigger even if a trigger word appears
const SAFE_CONTEXT_WORDS = new Set(['nations', 'guilds', 'greenleafs', 'greenleaves', 'enemy', 'helping', 'players', 'emotes', 'monke'].map(w => w.toLowerCase()));

// Load trigger words (comma-separated, one line)
function loadWords() {
  const path = process.env.WORDS_FILE || 'words.txt';
  if (!fs.existsSync(path)) {
    console.error('words.txt not found. Set WORDS_FILE or add words.txt');
    return new Set();
  }
  const line = fs.readFileSync(path, 'utf8').trim();
  const words = line.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  return new Set(words);
}

const triggerWords = loadWords();
console.log(`Loaded ${triggerWords.size} trigger words.`);

// Strip emojis and Discord custom emoji text so we only match real words (e.g. 🙏 doesn't count as "pray")
function stripEmojis(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/:[\w]+:/g, ' ') // Discord custom emoji like :pray:
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, ' ') // common emoji ranges
    .replace(/\s+/g, ' ')
    .trim();
}

// Check if message text contains any trigger word (case-insensitive), after stripping emojis
function hasTriggerWord(text) {
  const cleaned = stripEmojis(text);
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  for (const word of triggerWords) {
    if (lower.includes(word)) return true;
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

// --- Discord bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== TRIGGER_CHANNEL_ID) return; // only gv-general
  if (!message.content) return;

  if (hasSafeContext(message.content)) return; // game/community context – don't trigger
  if (!hasTriggerWord(message.content)) return;

  const randomGif = TENOR_GIFS[Math.floor(Math.random() * TENOR_GIFS.length)];
  try {
    await message.reply({
      content: REDIRECT_MESSAGE + '\n\n' + randomGif,
    });
  } catch (err) {
    console.error('Reply failed:', err);
  }
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
