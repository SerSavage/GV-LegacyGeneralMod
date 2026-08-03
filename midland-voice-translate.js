/**
 * Midland EU — MIDLAND POWER voice booth translation.
 * Deepgram (STT) → DeepL (translate → EN) → ElevenLabs (TTS) → Discord playback.
 * Only Guild Leader / Guild Officer roles are transcribed; everyone else is ignored.
 *
 * Supported speech → English: EN, FR, RU, ES, DE, PL, ZH (Mandarin/Traditional),
 * PT (Portuguese/Brazilian), MS (Malay), VI, TH, KO — plus DeepL auto-detect fallback.
 */
const fs = require('fs');
const path = require('path');
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

// Prefer bundled ffmpeg for TTS decode on Render / local.
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch {
  /* optional */
}

const MIDLAND_EU_GUILD_ID = String(process.env.MIDLAND_EU_GUILD_ID || '1045040260268163194').trim();
const MIDLAND_EU_VOICE_CHANNEL_ID = String(
  process.env.MIDLAND_EU_VOICE_CHANNEL_ID || '1533873541663952957',
).trim();
const MIDLAND_TRANSLATOR_ROLE_IDS = new Set(
  String(
    process.env.MIDLAND_EU_TRANSLATOR_ROLE_IDS
      || '1045066996259238020,1045067247875530834',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const DEEPGRAM_API_KEY = String(process.env.DEEPGRAM_API_KEY || '').trim();
const DEEPL_AUTH_KEY = String(process.env.DEEPL_AUTH_KEY || process.env.DEEPL_API_KEY || '').trim();
const ELEVENLABS_API_KEY = String(process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_VOICE_ID = String(
  process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Sarah — clear English
).trim();
const ELEVENLABS_MODEL_ID = String(process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2').trim();
const DEEPGRAM_MODEL = String(process.env.DEEPGRAM_MODEL || 'nova-3').trim();

const SILENCE_END_MS = Math.max(400, parseInt(process.env.MIDLAND_VOICE_SILENCE_MS || '900', 10) || 900);
const MIN_PCM_BYTES = Math.max(48000, parseInt(process.env.MIDLAND_VOICE_MIN_PCM_BYTES || '96000', 10) || 96000); // ~1s stereo 48k 16-bit
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const ENABLED = Boolean(
  DEEPGRAM_API_KEY
  && DEEPL_AUTH_KEY
  && ELEVENLABS_API_KEY
  && MIDLAND_EU_GUILD_ID
  && MIDLAND_EU_VOICE_CHANNEL_ID
  && MIDLAND_TRANSLATOR_ROLE_IDS.size > 0,
);

/** DeepL target English (American). Source auto-detect when unmapped. */
const DEEPL_TARGET = 'en-US';
const ENGLISH_LANG_CODES = new Set(['en', 'en-us', 'en-gb', 'en-au', 'en-in', 'english']);

/**
 * Languages we expect Leaders/Officers to speak in MIDLAND POWER.
 * Deepgram detects; DeepL translates → English; ElevenLabs speaks English.
 * Chinese: Mandarin + Traditional both map to DeepL source `zh` (DeepL does not split source variants).
 * Portuguese / Brazilian: both map to DeepL source `pt`.
 */
const SUPPORTED_SPEECH_LANGUAGES = [
  'en', 'fr', 'ru', 'es', 'de', 'pl',
  'zh', // Mandarin / Chinese (incl. Traditional → zh)
  'pt', // Portuguese + Brazilian Portuguese
  'ms', // Malay (Malaysian)
  'vi', // Vietnamese
  'th', // Thai
  'ko', // Korean
];

/** Map Deepgram / BCP-47 style codes → DeepL source language codes. */
const DEEPL_SOURCE_BY_HINT = {
  fr: 'fr', french: 'fr',
  ru: 'ru', russian: 'ru',
  es: 'es', spanish: 'es',
  de: 'de', german: 'de',
  pl: 'pl', polish: 'pl',
  // Chinese — Mandarin / Simplified / Traditional / Cantonese→still zh for DeepL text source
  zh: 'zh',
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  'zh-hk': 'zh',
  'zh-hans': 'zh',
  'zh-hant': 'zh',
  cmn: 'zh',
  mandarin: 'zh',
  chinese: 'zh',
  yue: 'zh',
  // Portuguese — European + Brazilian
  pt: 'pt',
  'pt-pt': 'pt',
  'pt-br': 'pt',
  portuguese: 'pt',
  brazilian: 'pt',
  // Malay / Malaysian
  ms: 'ms',
  msa: 'ms',
  malay: 'ms',
  malaysian: 'ms',
  // Vietnamese, Thai, Korean
  vi: 'vi', vietnamese: 'vi',
  th: 'th', thai: 'th',
  ko: 'ko', korean: 'ko',
};

let clientRef = null;
let deepgram = null;
let deeplClient = null;
let eleven = null;
let audioPlayer = null;
let playing = false;
const activeListeners = new Set(); // userId currently being recorded
const processQueue = [];
let queueRunning = false;

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

function ensureClients() {
  if (!ENABLED) return false;
  if (!deepgram) {
    deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });
  }
  if (!deeplClient) {
    deeplClient = new deepl.DeepLClient(DEEPL_AUTH_KEY);
  }
  if (!eleven) {
    eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
  }
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

async function memberHasTranslatorRole(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    if (!member || member.user?.bot) return false;
    return member.roles.cache.some((r) => MIDLAND_TRANSLATOR_ROLE_IDS.has(String(r.id)));
  } catch (err) {
    debug(`Role fetch failed for ${userId}:`, err.message);
    return false;
  }
}

async function countApprovedSpeakersInChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased?.()) return 0;
  let n = 0;
  for (const [, member] of channel.members) {
    if (member.user?.bot) continue;
    if (member.roles.cache.some((r) => MIDLAND_TRANSLATOR_ROLE_IDS.has(String(r.id)))) {
      n += 1;
      continue;
    }
    // Cache may be incomplete — fetch when not clearly approved
    if (await memberHasTranslatorRole(guild, member.id)) n += 1;
  }
  return n;
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
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_END_MS,
    },
  });

  const decoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));

  try {
    await pipeline(opusStream, decoder);
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      throw err;
    }
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
    language: String(detected || '').toLowerCase(),
    confidence: Number(alt?.confidence || 0),
  };
}

async function translateToEnglish(text, sourceLangHint) {
  const hint = String(sourceLangHint || '').toLowerCase().trim();
  let sourceLang = null;
  if (hint && !ENGLISH_LANG_CODES.has(hint) && !/^en([-_]|$)/i.test(hint)) {
    const base = hint.split(/[-_]/)[0];
    sourceLang =
      DEEPL_SOURCE_BY_HINT[hint]
      || DEEPL_SOURCE_BY_HINT[base]
      || null;
  }
  // DeepL: null source = auto-detect (covers edge cases / new Deepgram labels)
  try {
    const result = await deeplClient.translateText(text, sourceLang, DEEPL_TARGET);
    return {
      text: String(result.text || '').trim(),
      detectedSource: String(result.detectedSourceLang || sourceLang || '').toLowerCase(),
    };
  } catch (err) {
    // If an explicit source code is rejected (e.g. beta MS on some plans), retry with auto-detect.
    if (sourceLang) {
      warn(`DeepL source "${sourceLang}" failed (${err.message}); retrying auto-detect`);
      const result = await deeplClient.translateText(text, null, DEEPL_TARGET);
      return {
        text: String(result.text || '').trim(),
        detectedSource: String(result.detectedSourceLang || '').toLowerCase(),
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
  // Async iterable / array of chunks
  return Readable.from(audio);
}

async function synthesizeEnglish(text) {
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
  await entersState(audioPlayer, AudioPlayerStatus.Idle, 120_000).catch(() => null);
  playing = false;
}

async function processUtterance({ guild, userId, pcm }) {
  if (!pcm || pcm.length < MIN_PCM_BYTES) {
    debug(`Skip short utterance from ${userId} (${pcm?.length || 0} bytes)`);
    return;
  }

  const wav = pcmToWav(pcm);
  const { transcript, language } = await transcribeWav(wav);
  if (!transcript) {
    debug(`Empty transcript for ${userId}`);
    return;
  }

  log(`STT ${userId}: [${language || '?'}] ${transcript.slice(0, 160)}`);

  if (ENGLISH_LANG_CODES.has(language) || /^en\b/i.test(language)) {
    debug('Speaker already in English — skip TTS echo');
    return;
  }

  const { text: english, detectedSource } = await translateToEnglish(transcript, language);
  if (!english) {
    debug('Empty translation');
    return;
  }

  // If DeepL says source was English, skip playback
  if (ENGLISH_LANG_CODES.has(detectedSource) || detectedSource === 'en') {
    debug('DeepL detected English — skip TTS');
    return;
  }

  // Near-identical to transcript → likely already English
  if (english.toLowerCase() === transcript.toLowerCase()) {
    debug('Translation identical to source — skip TTS');
    return;
  }

  log(`EN ${userId}: ${english.slice(0, 160)}`);

  const connection = getVoiceConnection(guild.id);
  if (!connection) {
    warn('No voice connection; skip playback');
    return;
  }

  const ttsStream = await synthesizeEnglish(english);
  await playInConnection(connection, ttsStream);
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

function startListeningToUser(connection, guild, userId) {
  // Skip capturing while the bot is speaking to avoid feedback loops.
  if (playing) {
    debug(`Defer listen ${userId} — bot is speaking`);
    return;
  }
  if (activeListeners.has(userId)) return;
  activeListeners.add(userId);

  (async () => {
    try {
      if (!(await memberHasTranslatorRole(guild, userId))) {
        debug(`Ignore non-translator ${userId}`);
        return;
      }
      debug(`Listening to ${userId}`);
      const pcm = await collectPcmFromUser(connection.receiver, userId);
      enqueueUtterance({ guild, userId, pcm });
    } catch (err) {
      warn(`Listen failed for ${userId}:`, err.message || err);
    } finally {
      activeListeners.delete(userId);
    }
  })();
}

function attachReceiver(connection, guild) {
  const speaking = connection.receiver.speaking;
  speaking.removeAllListeners('start');
  speaking.on('start', (userId) => {
    if (String(userId) === String(clientRef?.user?.id)) return;
    void startListeningToUser(connection, guild, String(userId));
  });
}

async function joinMidlandPower(guild) {
  if (!ensureClients()) return null;

  const existing = getVoiceConnection(guild.id);
  if (existing) {
    attachReceiver(existing, guild);
    existing.subscribe(audioPlayer);
    return existing;
  }

  const channel = await guild.channels.fetch(MIDLAND_EU_VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isVoiceBased?.()) {
    warn(`MIDLAND POWER channel not found: ${MIDLAND_EU_VOICE_CHANNEL_ID}`);
    return null;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // required to receive audio
    selfMute: false,
  });

  connection.on('error', (err) => warn('Voice connection error:', err.message || err));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    warn('Voice connection failed to become Ready:', err.message || err);
    try {
      connection.destroy();
    } catch {
      /* ignore */
    }
    return null;
  }

  attachReceiver(connection, guild);
  connection.subscribe(audioPlayer);
  log(`Joined MIDLAND POWER (${MIDLAND_EU_VOICE_CHANNEL_ID})`);
  return connection;
}

async function leaveMidlandPower(guildId) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  try {
    connection.destroy();
    log('Left MIDLAND POWER (no Leader/Officer remaining)');
  } catch (err) {
    warn('Leave failed:', err.message || err);
  }
}

/**
 * Keep bot in MIDLAND POWER only while ≥1 Leader/Officer is present.
 */
async function reconcileMidlandVoice(guild) {
  if (!ENABLED || !guild || String(guild.id) !== MIDLAND_EU_GUILD_ID) return;

  const approved = await countApprovedSpeakersInChannel(guild, MIDLAND_EU_VOICE_CHANNEL_ID);
  const connection = getVoiceConnection(guild.id);
  const inTarget =
    connection
    && connection.joinConfig?.channelId === MIDLAND_EU_VOICE_CHANNEL_ID;

  if (approved > 0) {
    if (!inTarget) await joinMidlandPower(guild);
    else attachReceiver(connection, guild);
  } else if (connection) {
    await leaveMidlandPower(guild.id);
  }
}

async function onVoiceStateUpdate(oldState, newState) {
  if (!ENABLED) return;
  const guild = newState.guild || oldState.guild;
  if (!guild || String(guild.id) !== MIDLAND_EU_GUILD_ID) return;

  const touched =
    oldState.channelId === MIDLAND_EU_VOICE_CHANNEL_ID
    || newState.channelId === MIDLAND_EU_VOICE_CHANNEL_ID;
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
      '[midland-voice] Disabled — set DEEPGRAM_API_KEY, DEEPL_AUTH_KEY, ELEVENLABS_API_KEY to enable Midland POWER translation',
    );
    return;
  }
  ensureClients();
  log(
    `Enabled — guild ${MIDLAND_EU_GUILD_ID}; channel ${MIDLAND_EU_VOICE_CHANNEL_ID}; roles ${[...MIDLAND_TRANSLATOR_ROLE_IDS].join(',')}`,
  );
  log(`Pipeline: Deepgram(${DEEPGRAM_MODEL}) → DeepL → ElevenLabs(${ELEVENLABS_VOICE_ID})`);
  log(`Speech languages: ${SUPPORTED_SPEECH_LANGUAGES.join(', ')} (+ auto-detect fallback)`);

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
  MIDLAND_EU_VOICE_CHANNEL_ID,
  MIDLAND_TRANSLATOR_ROLE_IDS,
};
