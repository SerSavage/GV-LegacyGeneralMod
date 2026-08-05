/**
 * Midland EU — multi-language voice booths + shotcaller relay.
 *
 * Shotcaller (role) speaks in any language booth → STT → translate to every
 * other booth language → post text in each voice-channel chat + TTS spoken
 * by the bot (visits each channel; Discord allows one VC per guild).
 *
 * Languages / channels: EN, RU, DE, PL, FR, ES, PT, ZH, IT (both directions).
 * Only the shotcaller role is listened to (Leaders/Officers removed).
 *
 * Kick: do not auto-rejoin. Unexpected voice disconnect: rejoin if shotcaller
 * still in a booth and we were not kicked / intentionally left.
 */
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { DeepgramClient } = require('@deepgram/sdk');
const deepl = require('deepl-node');
const { ElevenLabsClient } = require('elevenlabs');

try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch {
  /* optional */
}

const MIDLAND_EU_GUILD_ID = String(process.env.MIDLAND_EU_GUILD_ID || '1045040260268163194').trim();
const SHOTCALLER_ROLE_ID = String(
  process.env.MIDLAND_SHOTCALLER_ROLE_ID || '1534633764570009703',
).trim();

/** lang code → Discord voice channel ID */
const CHANNEL_BY_LANG = {
  en: String(process.env.MIDLAND_VOICE_EN || '1534284673247613099').trim(),
  ru: String(process.env.MIDLAND_VOICE_RU || '1534284963657289878').trim(),
  de: String(process.env.MIDLAND_VOICE_DE || '1534285176362893463').trim(),
  pl: String(process.env.MIDLAND_VOICE_PL || '1534285248517509250').trim(),
  fr: String(process.env.MIDLAND_VOICE_FR || '1534285292616286218').trim(),
  es: String(process.env.MIDLAND_VOICE_ES || '1534632851679744192').trim(),
  pt: String(process.env.MIDLAND_VOICE_PT || '1534285484333731974').trim(),
  zh: String(process.env.MIDLAND_VOICE_ZH || '1534285547923705927').trim(),
  it: String(process.env.MIDLAND_VOICE_IT || '1534633326143340675').trim(),
};

const LANG_BY_CHANNEL = new Map(
  Object.entries(CHANNEL_BY_LANG).map(([lang, id]) => [String(id), lang]),
);
const LANG_CHANNEL_IDS = new Set(Object.values(CHANNEL_BY_LANG).filter(Boolean));

const EVENT_LANGS = Object.keys(CHANNEL_BY_LANG); // en, ru, de, pl, fr, es, pt, zh, it

const DEEPGRAM_API_KEY = String(process.env.DEEPGRAM_API_KEY || '').trim();
const DEEPL_AUTH_KEY = String(process.env.DEEPL_AUTH_KEY || process.env.DEEPL_API_KEY || '').trim();
const ELEVENLABS_API_KEY = String(process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_VOICE_ID = String(
  process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
).trim();
const ELEVENLABS_MODEL_ID = String(process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2').trim();
const DEEPGRAM_MODEL = String(process.env.DEEPGRAM_MODEL || 'nova-3').trim();

const SILENCE_END_MS = Math.max(400, parseInt(process.env.MIDLAND_VOICE_SILENCE_MS || '900', 10) || 900);
const MIN_PCM_BYTES = Math.max(48000, parseInt(process.env.MIDLAND_VOICE_MIN_PCM_BYTES || '96000', 10) || 96000);
const LEAVE_DEBOUNCE_MS = Math.max(500, parseInt(process.env.MIDLAND_VOICE_LEAVE_DEBOUNCE_MS || '2500', 10) || 2500);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const ENABLED = Boolean(
  DEEPGRAM_API_KEY
  && DEEPL_AUTH_KEY
  && ELEVENLABS_API_KEY
  && MIDLAND_EU_GUILD_ID
  && SHOTCALLER_ROLE_ID
  && LANG_CHANNEL_IDS.size > 0,
);

const ENGLISH_LANG_CODES = new Set(['en', 'en-us', 'en-gb', 'en-au', 'en-in', 'english']);

const DEEPL_TARGET_BY_CODE = {
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
  ru: 'ru',
  de: 'de',
  pl: 'pl',
  fr: 'fr',
  es: 'es',
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-PT',
  zh: 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-hant': 'zh-Hant',
  it: 'it',
};

const DEEPL_SOURCE_BY_HINT = {
  en: 'en', english: 'en',
  ru: 'ru', russian: 'ru',
  de: 'de', german: 'de',
  pl: 'pl', polish: 'pl',
  fr: 'fr', french: 'fr',
  es: 'es', spanish: 'es',
  pt: 'pt', 'pt-br': 'pt', 'pt-pt': 'pt', portuguese: 'pt', brazilian: 'pt',
  zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh',
  cmn: 'zh', mandarin: 'zh', chinese: 'zh',
  it: 'it', italian: 'it',
};

const LANG_LABEL = {
  en: 'English',
  ru: 'Russian',
  de: 'German',
  pl: 'Polish',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese',
  it: 'Italian',
};

let clientRef = null;
let deepgram = null;
let deeplClient = null;
let eleven = null;
let audioPlayer = null;
let playing = false;
let delivering = false; // touring language channels for TTS
const activeListeners = new Set();
const processQueue = [];
let queueRunning = false;

let leaveTimer = null;
let joinPromise = null;
let intentionalLeave = false;
/** After a kick/force-remove, do not auto-join until shotcaller fully leaves all booths. */
let suppressAutoJoinAfterKick = false;
let homeChannelIdWhileDelivering = null;

function log(...args) {
  console.log('[midland-voice]', ...args);
}
function warn(...args) {
  console.warn('[midland-voice]', ...args);
}
function debug(...args) {
  if (DEBUG) console.log('[midland-voice:debug]', ...args);
}

function isEnabled() {
  return ENABLED;
}

function isProtectedVoiceChannel(channelId) {
  return LANG_CHANNEL_IDS.has(String(channelId));
}

function isEnglishLang(code) {
  const c = String(code || '').toLowerCase();
  return ENGLISH_LANG_CODES.has(c) || /^en([-_]|$)/i.test(c);
}

function normalizeLang(code) {
  const c = String(code || '').toLowerCase().trim();
  if (!c) return '';
  if (isEnglishLang(c)) return 'en';
  const base = c.split(/[-_]/)[0];
  if (DEEPL_SOURCE_BY_HINT[c]) {
    const mapped = DEEPL_SOURCE_BY_HINT[c];
    return mapped === 'en' ? 'en' : mapped;
  }
  if (EVENT_LANGS.includes(base)) return base;
  if (DEEPL_SOURCE_BY_HINT[base]) return DEEPL_SOURCE_BY_HINT[base];
  return base;
}

function ensureClients() {
  if (!ENABLED) return false;
  if (!deepgram) deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });
  if (!deeplClient) deeplClient = new deepl.DeepLClient(DEEPL_AUTH_KEY);
  if (!eleven) eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
  if (!audioPlayer) {
    audioPlayer = createAudioPlayer();
    audioPlayer.on('error', (err) => {
      warn('Audio player error:', err.message || err);
      playing = false;
    });
    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      playing = false;
    });
  }
  return true;
}

async function memberHasShotcallerRole(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    if (!member || member.user?.bot) return false;
    return member.roles.cache.has(SHOTCALLER_ROLE_ID);
  } catch (err) {
    debug(`Shotcaller role fetch failed for ${userId}:`, err.message);
    return false;
  }
}

/**
 * Find the single shotcaller currently in any language booth.
 * Returns { userId, channelId, lang } or null.
 * If multiple (shouldn't happen), prefers first found and logs a warning.
 */
async function findActiveShotcaller(guild) {
  const botId = clientRef?.user?.id ? String(clientRef.user.id) : null;
  const found = [];

  for (const vs of guild.voiceStates.cache.values()) {
    const chId = String(vs.channelId || '');
    if (!LANG_CHANNEL_IDS.has(chId)) continue;
    const uid = String(vs.id);
    if (botId && uid === botId) continue;
    if (vs.member?.user?.bot) continue;
    if (await memberHasShotcallerRole(guild, uid)) {
      found.push({ userId: uid, channelId: chId, lang: LANG_BY_CHANNEL.get(chId) || 'en' });
    }
  }

  if (found.length > 1) {
    warn(`Multiple shotcallers in booths (${found.length}) — using ${found[0].userId}; only one allowed per event`);
  }
  return found[0] || null;
}

function cancelScheduledLeave() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

function scheduleLeaveIfNoShotcaller(guild) {
  cancelScheduledLeave();
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    void (async () => {
      try {
        const fresh = await guild.client.guilds.fetch(guild.id).catch(() => guild);
        const sc = await findActiveShotcaller(fresh);
        if (sc) {
          log(`Stay — shotcaller still in #${sc.lang} (${sc.channelId})`);
          if (!suppressAutoJoinAfterKick) {
            const conn = getVoiceConnection(fresh.id);
            if (!conn || conn.joinConfig?.channelId !== sc.channelId) {
              await joinChannel(fresh, sc.channelId);
            }
          }
          return;
        }
        suppressAutoJoinAfterKick = false; // session ended — allow join next time
        await leaveVoice(fresh.id, 'no shotcaller in language booths');
      } catch (err) {
        warn('Debounced leave failed:', err.message || err);
      }
    })();
  }, LEAVE_DEBOUNCE_MS);
}

function pcmToWav(pcmBuffer, { channels = 2, sampleRate = 48000, bitDepth = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

async function collectPcmFromUser(receiver, userId) {
  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
  });
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));
  try {
    await pipeline(opusStream, decoder);
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
  }
  return Buffer.concat(chunks);
}

async function transcribeWav(wavBuffer) {
  const response = await deepgram.listen.v1.media.transcribeFile(wavBuffer, {
    model: DEEPGRAM_MODEL,
    smart_format: 'true',
    punctuate: 'true',
    detect_language: 'true',
  });
  const alt = response?.results?.channels?.[0]?.alternatives?.[0];
  const transcript = String(alt?.transcript || '').trim();
  const detected =
    response?.results?.channels?.[0]?.detected_language
    || alt?.languages?.[0]
    || response?.metadata?.detected_language
    || '';
  return {
    transcript,
    language: normalizeLang(detected),
    confidence: Number(alt?.confidence || 0),
  };
}

async function translateText(text, sourceLangHint, targetCode) {
  const target = DEEPL_TARGET_BY_CODE[String(targetCode || '').toLowerCase()] || targetCode;
  if (!target) throw new Error(`Unsupported DeepL target: ${targetCode}`);

  const hint = normalizeLang(sourceLangHint);
  let sourceLang = null;
  if (hint === 'en') sourceLang = 'en';
  else if (hint && DEEPL_SOURCE_BY_HINT[hint]) sourceLang = DEEPL_SOURCE_BY_HINT[hint];

  try {
    const result = await deeplClient.translateText(text, sourceLang, target);
    return {
      text: String(result.text || '').trim(),
      detectedSource: normalizeLang(result.detectedSourceLang || sourceLang || ''),
    };
  } catch (err) {
    if (sourceLang) {
      warn(`DeepL ${sourceLang}→${target} failed (${err.message}); auto-detect source`);
      const result = await deeplClient.translateText(text, null, target);
      return {
        text: String(result.text || '').trim(),
        detectedSource: normalizeLang(result.detectedSourceLang || ''),
      };
    }
    throw err;
  }
}

function toNodeReadable(audio) {
  if (!audio) throw new Error('Empty TTS audio');
  if (Buffer.isBuffer(audio)) return Readable.from(audio);
  if (typeof audio.pipe === 'function') return audio;
  if (typeof Readable.fromWeb === 'function' && audio.getReader) {
    return Readable.fromWeb(audio);
  }
  return Readable.from(audio);
}

async function synthesizeSpeech(text) {
  const audio = await eleven.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
    text,
    model_id: ELEVENLABS_MODEL_ID,
    output_format: 'mp3_44100_128',
  });
  return toNodeReadable(audio);
}

async function playInConnection(connection, audioReadable) {
  if (!connection || !audioPlayer) return;
  connection.subscribe(audioPlayer);
  playing = true;
  const resource = createAudioResource(audioReadable);
  audioPlayer.play(resource);
  await entersState(audioPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => null);
  await entersState(audioPlayer, AudioPlayerStatus.Idle, 180_000).catch(() => null);
  playing = false;
}

async function postTextToChannel(guild, channelId, content) {
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) {
      warn(`Cannot post text to ${channelId}`);
      return;
    }
    const body = content.length > 1900 ? `${content.slice(0, 1897)}...` : content;
    await ch.send({ content: body, allowedMentions: { parse: [] } });
  } catch (err) {
    warn(`Text post to ${channelId} failed:`, err.message || err);
  }
}

async function joinChannel(guild, channelId) {
  if (!ensureClients()) return null;
  if (joinPromise) return joinPromise;

  joinPromise = (async () => {
    try {
      const existing = getVoiceConnection(guild.id);
      if (existing) {
        const status = existing.state.status;
        if (
          (status === VoiceConnectionStatus.Ready
            || status === VoiceConnectionStatus.Connecting
            || status === VoiceConnectionStatus.Signalling)
          && existing.joinConfig?.channelId === String(channelId)
        ) {
          existing.subscribe(audioPlayer);
          return existing;
        }
        try {
          existing.destroy();
        } catch {
          /* ignore */
        }
      }

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isVoiceBased?.()) {
        warn(`Voice channel not found: ${channelId}`);
        return null;
      }

      intentionalLeave = false;
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      connection.on('error', (err) => warn('Voice connection error:', err.message || err));
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (intentionalLeave || suppressAutoJoinAfterKick || delivering) return;
        try {
          const sc = await findActiveShotcaller(guild);
          if (sc) {
            warn('Voice disconnected unexpectedly — rejoining shotcaller booth');
            cancelScheduledLeave();
            setTimeout(() => {
              if (!suppressAutoJoinAfterKick) void joinChannel(guild, sc.channelId).then((c) => {
                if (c) attachReceiver(c, guild);
              });
            }, 750);
          }
        } catch (err) {
          warn('Reconnect check failed:', err.message || err);
        }
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (err) {
        warn('Voice Ready failed:', err.message || err);
        try {
          connection.destroy();
        } catch {
          /* ignore */
        }
        return null;
      }

      connection.subscribe(audioPlayer);
      log(`Joined voice ${LANG_BY_CHANNEL.get(String(channelId)) || '?'} (${channelId})`);
      return connection;
    } finally {
      joinPromise = null;
    }
  })();

  return joinPromise;
}

async function leaveVoice(guildId, reason) {
  cancelScheduledLeave();
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  intentionalLeave = true;
  try {
    connection.destroy();
    log(`Left voice (${reason})`);
  } catch (err) {
    warn('Leave failed:', err.message || err);
  }
}

function attachReceiver(connection, guild) {
  if (!connection?.receiver) return;
  const speaking = connection.receiver.speaking;
  speaking.removeAllListeners('start');
  speaking.on('start', (userId) => {
    if (String(userId) === String(clientRef?.user?.id)) return;
    if (delivering || playing) return;
    void startListeningToUser(connection, guild, String(userId));
  });
}

function startListeningToUser(connection, guild, userId) {
  if (playing || delivering) return;
  if (activeListeners.has(userId)) return;
  activeListeners.add(userId);

  (async () => {
    try {
      if (!(await memberHasShotcallerRole(guild, userId))) {
        debug(`Ignore non-shotcaller ${userId}`);
        return;
      }
      debug(`Listening to shotcaller ${userId}`);
      const pcm = await collectPcmFromUser(connection.receiver, userId);
      enqueueUtterance({ guild, userId, pcm });
    } catch (err) {
      warn(`Listen failed for ${userId}:`, err.message || err);
    } finally {
      activeListeners.delete(userId);
    }
  })();
}

/**
 * Post translated text to every language booth chat, then TTS in each booth
 * (skip source-language TTS — shotcaller already said it), return to shotcaller.
 */
async function relayShotcall(guild, userId, transcript, sourceLang) {
  const src = normalizeLang(sourceLang) || 'en';
  const payloads = [];

  for (const lang of EVENT_LANGS) {
    const channelId = CHANNEL_BY_LANG[lang];
    if (!channelId) continue;
    let text = transcript;
    if (lang !== src) {
      try {
        const { text: translated } = await translateText(transcript, src, lang);
        if (translated) text = translated;
      } catch (err) {
        warn(`Translate ${src}→${lang} failed:`, err.message || err);
        continue;
      }
    }
    payloads.push({ lang, channelId, text, speak: lang !== src });
  }

  // Text to all booths first (fast)
  for (const p of payloads) {
    const label = LANG_LABEL[p.lang] || p.lang;
    const header = `**Shotcall** (${LANG_LABEL[src] || src} → ${label})`;
    await postTextToChannel(guild, p.channelId, `${header}\n${p.text}`);
    log(`Chat ${src}→${p.lang}: ${p.text.slice(0, 100)}`);
  }

  const sc = await findActiveShotcaller(guild);
  const homeId = sc?.channelId || getVoiceConnection(guild.id)?.joinConfig?.channelId || null;
  homeChannelIdWhileDelivering = homeId;

  delivering = true;
  try {
    for (const p of payloads) {
      if (!p.speak || !p.text) continue;
      try {
        const conn = await joinChannel(guild, p.channelId);
        if (!conn) continue;
        const tts = await synthesizeSpeech(p.text);
        await playInConnection(conn, tts);
      } catch (err) {
        warn(`TTS in ${p.lang} failed:`, err.message || err);
      }
    }
  } finally {
    delivering = false;
    if (homeId && !suppressAutoJoinAfterKick) {
      const conn = await joinChannel(guild, homeId);
      if (conn) attachReceiver(conn, guild);
    }
    homeChannelIdWhileDelivering = null;
  }
}

async function processUtterance({ guild, userId, pcm }) {
  if (!pcm || pcm.length < MIN_PCM_BYTES) {
    debug(`Skip short utterance from ${userId} (${pcm?.length || 0} bytes)`);
    return;
  }
  if (!(await memberHasShotcallerRole(guild, userId))) return;

  const wav = pcmToWav(pcm);
  const { transcript, language } = await transcribeWav(wav);
  if (!transcript) {
    debug(`Empty transcript for ${userId}`);
    return;
  }

  log(`STT shotcaller ${userId}: [${language || '?'}] ${transcript.slice(0, 160)}`);
  await relayShotcall(guild, userId, transcript, language);
}

function enqueueUtterance(job) {
  processQueue.push(job);
  void drainQueue();
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (processQueue.length) {
      const job = processQueue.shift();
      try {
        await processUtterance(job);
      } catch (err) {
        warn('Utterance pipeline failed:', err.message || err);
      }
    }
  } finally {
    queueRunning = false;
  }
}

async function reconcileMidlandVoice(guild) {
  if (!ENABLED || !guild || String(guild.id) !== MIDLAND_EU_GUILD_ID) return;

  const sc = await findActiveShotcaller(guild);
  const connection = getVoiceConnection(guild.id);

  if (sc) {
    cancelScheduledLeave();
    if (suppressAutoJoinAfterKick) {
      debug('Shotcaller present but auto-join suppressed after kick');
      return;
    }
    if (delivering) return;
    const inRightChannel = connection && connection.joinConfig?.channelId === sc.channelId;
    if (!inRightChannel) {
      log(`Follow shotcaller ${sc.userId} → ${sc.lang} (${sc.channelId})`);
      const conn = await joinChannel(guild, sc.channelId);
      if (conn) attachReceiver(conn, guild);
    } else {
      attachReceiver(connection, guild);
    }
    return;
  }

  if (connection) {
    log('No shotcaller in language booths — scheduling leave');
    scheduleLeaveIfNoShotcaller(guild);
  }
}

async function onVoiceStateUpdate(oldState, newState) {
  if (!ENABLED) return;
  const guild = newState.guild || oldState.guild;
  if (!guild || String(guild.id) !== MIDLAND_EU_GUILD_ID) return;

  const botId = clientRef?.user?.id ? String(clientRef.user.id) : null;
  const changedUserId = String(newState.id || oldState.id || '');

  // Bot kicked / moved out of a language booth by someone else
  if (botId && changedUserId === botId) {
    const leftLangBooth =
      LANG_CHANNEL_IDS.has(String(oldState.channelId || ''))
      && !LANG_CHANNEL_IDS.has(String(newState.channelId || ''));
    if (leftLangBooth && !intentionalLeave && !delivering) {
      suppressAutoJoinAfterKick = true;
      warn('Bot removed from language booth — will not auto-rejoin until shotcaller leaves all booths');
      cancelScheduledLeave();
    }
    debug('Ignore bot own voiceStateUpdate');
    return;
  }

  const touched =
    LANG_CHANNEL_IDS.has(String(oldState.channelId || ''))
    || LANG_CHANNEL_IDS.has(String(newState.channelId || ''));
  if (!touched) return;

  try {
    await reconcileMidlandVoice(guild);
  } catch (err) {
    warn('reconcile failed:', err.message || err);
  }
}

async function init(client) {
  clientRef = client;
  if (!ENABLED) {
    console.log(
      '[midland-voice] Disabled — set DEEPGRAM_API_KEY, DEEPL_AUTH_KEY, ELEVENLABS_API_KEY to enable shotcaller relay',
    );
    return;
  }
  ensureClients();
  log(`Enabled — guild ${MIDLAND_EU_GUILD_ID}; shotcaller role ${SHOTCALLER_ROLE_ID}`);
  log(`Language booths: ${EVENT_LANGS.map((l) => `${l}=${CHANNEL_BY_LANG[l]}`).join(', ')}`);
  log(`Pipeline: Deepgram(${DEEPGRAM_MODEL}) → DeepL → chat+TTS ElevenLabs(${ELEVENLABS_VOICE_ID})`);
  log('Kick = no auto-rejoin until shotcaller clears booths; unexpected disconnect = rejoin');

  try {
    const guild = await client.guilds.fetch(MIDLAND_EU_GUILD_ID);
    await reconcileMidlandVoice(guild);
  } catch (err) {
    warn('Startup reconcile failed:', err.message || err);
  }
}

module.exports = {
  init,
  onVoiceStateUpdate,
  isEnabled,
  isProtectedVoiceChannel,
  /** @deprecated use isProtectedVoiceChannel — kept so index.js temp-voice guard still works */
  MIDLAND_EU_VOICE_CHANNEL_ID: CHANNEL_BY_LANG.en,
  LANG_CHANNEL_IDS,
  SHOTCALLER_ROLE_ID,
};
