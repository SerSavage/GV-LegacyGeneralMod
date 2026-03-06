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
const TENOR_GIF_URL = 'https://tenor.com/view/person-of-interest-hersh-i-think-we\'re-getting-off-topic-gif-13873963244115564618';

// Optional: direct GIF URL for embed (replace with actual media URL if you have one)
// Discord may unfurl the Tenor page link as a preview anyway.
const TENOR_GIF_LINK = TENOR_GIF_URL;

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

// Check if message text contains any trigger word (whole-word or as substring, case-insensitive)
function hasTriggerWord(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const word of triggerWords) {
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

  if (!hasTriggerWord(message.content)) return;

  try {
    await message.reply({
      content: REDIRECT_MESSAGE + '\n\n' + TENOR_GIF_LINK,
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
