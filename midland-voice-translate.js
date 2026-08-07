/**
 * Midland EU — multi-language voice booths + shotcaller relay.
 *
 * Shotcaller speaks in a language booth → STT → translate → text + TTS only in
 * OTHER language booths that have ≥1 verified participant (never the shotcaller's
 * booth, never same-language echo like English→English). Discord allows one VC
 * per guild, so TTS tours target channels then returns to the shotcaller.
 *
 * Languages / channels: EN, RU, DE, PL, FR, ES, PT, ZH, IT (both directions).
 * Only the shotcaller role is listened to.
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
  StreamType,
  entersState,
  EndBehaviorType,
  getVoiceConnection,
  generateDependencyReport,
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
/** Verified role — TTS (and text) only go to booths with ≥1 non-bot member holding this role. */
const VERIFIED_ROLE_ID = String(
  process.env.MIDLAND_VERIFYED_ROLE_ID
  || process.env.MIDLAND_VERIFIED_ROLE_ID
  || '1079821419606712330',
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
const ELEVENLABS_MODEL_ID = String(
  process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
).trim();
const DEEPGRAM_MODEL = String(process.env.DEEPGRAM_MODEL || 'nova-3').trim();

const SILENCE_END_MS = Math.max(300, parseInt(process.env.MIDLAND_VOICE_SILENCE_MS || '550', 10) || 550);
const MIN_PCM_BYTES = Math.max(32000, parseInt(process.env.MIDLAND_VOICE_MIN_PCM_BYTES || '64000', 10) || 64000);
/** Hard cap on one shotcaller utterance capture (open-mic / never-silence). */
const MAX_UTTERANCE_MS = Math.max(3000, parseInt(process.env.MIDLAND_VOICE_MAX_UTTERANCE_MS || '12000', 10) || 12000);
/** Deepgram STT timeout */
const STT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.MIDLAND_VOICE_STT_TIMEOUT_MS || '20000', 10) || 20000);
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

async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch (err) {
    debug(`Member fetch failed for ${userId}:`, err.message);
    return null;
  }
}

async function memberHasShotcallerRole(guild, userId) {
  const member = await fetchMember(guild, userId);
  if (!member || member.user?.bot) return false;
  return member.roles.cache.has(SHOTCALLER_ROLE_ID);
}

async function memberHasVerifiedRole(guild, userId) {
  if (!VERIFIED_ROLE_ID) return true;
  const member = await fetchMember(guild, userId);
  if (!member || member.user?.bot) return false;
  return member.roles.cache.has(VERIFIED_ROLE_ID);
}

/** One pass over voice states → set of language booth IDs with a verified listener. */
async function getVerifiedOccupiedChannelIds(guild) {
  const botId = clientRef?.user?.id ? String(clientRef.user.id) : null;
  const occupied = new Set();
  const pending = [];

  for (const vs of guild.voiceStates.cache.values()) {
    const chId = String(vs.channelId || '');
    if (!LANG_CHANNEL_IDS.has(chId)) continue;
    const uid = String(vs.id);
    if (botId && uid === botId) continue;
    if (vs.member?.user?.bot) continue;
    pending.push(
      (async () => {
        if (await memberHasVerifiedRole(guild, uid)) occupied.add(chId);
      })(),
    );
  }

  await Promise.all(pending);
  return occupied;
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

  let timedOut = false;
  const maxTimer = setTimeout(() => {
    timedOut = true;
    debug(`Utterance capture hit ${MAX_UTTERANCE_MS}ms cap for ${userId} — forcing end`);
    try {
      opusStream.destroy();
    } catch {
      /* ignore */
    }
    try {
      decoder.destroy();
    } catch {
      /* ignore */
    }
  }, MAX_UTTERANCE_MS);

  try {
    await pipeline(opusStream, decoder);
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !timedOut) throw err;
  } finally {
    clearTimeout(maxTimer);
  }

  const buf = Buffer.concat(chunks);
  if (timedOut) log(`Capture capped at ${MAX_UTTERANCE_MS}ms → ${buf.length} bytes from ${userId}`);
  return buf;
}

async function transcribeWav(wavBuffer, boothLangHint = '') {
  return withTimeout((async () => {
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
    const hint = normalizeLang(boothLangHint);
    const language = normalizeLang(detected) || hint || '';
    return {
      transcript,
      language,
      confidence: Number(alt?.confidence || 0),
    };
  })(), STT_TIMEOUT_MS, 'Deepgram STT');
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
  if (typeof Readable.fromWeb === 'function') {
    if (typeof audio.getReader === 'function') return Readable.fromWeb(audio);
    // ElevenLabs UniversalStreamWrapper often exposes .readableStream
    if (audio.readableStream && typeof audio.readableStream.getReader === 'function') {
      return Readable.fromWeb(audio.readableStream);
    }
  }
  return Readable.from(audio);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Buffer ElevenLabs MP3 fully — streaming wrappers often break discord.js ffmpeg demux. */
async function synthesizeSpeechBuffer(text) {
  return withTimeout((async () => {
    const audio = await eleven.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text,
      model_id: ELEVENLABS_MODEL_ID,
      output_format: 'mp3_44100_128',
    });
    const stream = toNodeReadable(audio);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('ElevenLabs returned empty audio');
    return buf;
  })(), 25_000, 'ElevenLabs TTS');
}

async function playInConnection(connection, mp3Buffer) {
  if (!connection || !audioPlayer) return;
  connection.subscribe(audioPlayer);
  playing = true;
  try {
    const resource = createAudioResource(Readable.from(mp3Buffer), {
      inputType: StreamType.Arbitrary,
    });
    audioPlayer.play(resource);
    await entersState(audioPlayer, AudioPlayerStatus.Playing, 8_000).catch((err) => {
      warn('TTS did not reach Playing:', err?.message || err);
    });
    // Cap playback wait so a stuck ffmpeg demux cannot freeze the whole tour
    await Promise.race([
      entersState(audioPlayer, AudioPlayerStatus.Idle, 60_000).catch(() => null),
      sleep(60_000),
    ]);
  } finally {
    stopAudioPlayer();
  }
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

/** Confirm the bot's Discord voice state is in the target channel (joinConfig alone is not enough). */
async function waitUntilBotInChannel(guild, channelId, timeoutMs = 12_000) {
  const botId = clientRef?.user?.id ? String(clientRef.user.id) : null;
  if (!botId) return false;
  const want = String(channelId);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const meCh = guild.members.me?.voice?.channelId;
    if (meCh && String(meCh) === want) return true;

    const cached = guild.voiceStates.cache.get(botId);
    if (cached && String(cached.channelId || '') === want) return true;

    await sleep(200);
  }
  return false;
}

function wireConnectionHandlers(connection, guild) {
  connection.removeAllListeners('error');
  connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  connection.on('error', (err) => warn('Voice connection error:', err.message || err));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (intentionalLeave || suppressAutoJoinAfterKick || delivering) return;
    try {
      const sc = await findActiveShotcaller(guild);
      if (sc) {
        warn('Voice disconnected unexpectedly — rejoining shotcaller booth');
        cancelScheduledLeave();
        setTimeout(() => {
          if (!suppressAutoJoinAfterKick && !delivering) {
            void joinChannel(guild, sc.channelId).then((c) => {
              if (c) attachReceiver(c, guild);
            });
          }
        }, 750);
      }
    } catch (err) {
      warn('Reconnect check failed:', err.message || err);
    }
  });
}

function stopAudioPlayer() {
  if (!audioPlayer) return;
  try {
    audioPlayer.stop(true);
  } catch {
    /* ignore */
  }
  playing = false;
}

/**
 * Join or move the bot into a voice channel.
 * @discordjs/voice does not wait for channel moves when already Ready — we must
 * rejoin() and confirm via voice state, with destroy+recreate as fallback.
 */
async function joinChannel(guild, channelId) {
  if (!ensureClients()) return null;

  while (joinPromise) {
    await joinPromise.catch(() => null);
  }

  const wantId = String(channelId);

  joinPromise = (async () => {
    intentionalLeave = true;
    try {
      stopAudioPlayer();

      let connection = getVoiceConnection(guild.id);

      // Already in the right channel
      if (
        connection
        && connection.state.status !== VoiceConnectionStatus.Destroyed
        && String(connection.joinConfig?.channelId) === wantId
      ) {
        if (connection.state.status === VoiceConnectionStatus.Ready) {
          const ok = await waitUntilBotInChannel(guild, wantId, 3_000);
          if (ok || connection.state.status === VoiceConnectionStatus.Ready) {
            connection.subscribe(audioPlayer);
            intentionalLeave = false;
            return connection;
          }
        } else {
          try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
            connection.subscribe(audioPlayer);
            intentionalLeave = false;
            return connection;
          } catch (err) {
            warn('Wait Ready (same channel) failed:', err.message || err);
          }
        }
      }

      // Move existing Ready/Signalling connection via rejoin (updates joinConfig)
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        const moved = connection.rejoin({
          channelId: wantId,
          selfDeaf: false,
          selfMute: false,
        });
        if (moved) {
          wireConnectionHandlers(connection, guild);
          // Stay Ready during move — must wait for Discord voice state, not entersState(Ready)
          const confirmed = await waitUntilBotInChannel(guild, wantId, 12_000);
          if (confirmed) {
            try {
              if (connection.state.status !== VoiceConnectionStatus.Ready) {
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
              }
            } catch {
              /* still try to use connection if VSU confirmed */
            }
            connection.subscribe(audioPlayer);
            intentionalLeave = false;
            log(`Moved voice → ${LANG_BY_CHANNEL.get(wantId) || '?'} (${wantId})`);
            return connection;
          }
          warn(`Voice move to ${wantId} not confirmed — recreating connection`);
        }

        try {
          connection.destroy();
        } catch {
          /* ignore */
        }
        connection = null;
        await sleep(400);
      }

      const channel = await guild.channels.fetch(wantId).catch(() => null);
      if (!channel || !channel.isVoiceBased?.()) {
        warn(`Voice channel not found: ${wantId}`);
        return null;
      }

      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      wireConnectionHandlers(connection, guild);

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

      const confirmed = await waitUntilBotInChannel(guild, wantId, 10_000);
      if (!confirmed) {
        warn(`Joined ${wantId} but voice state not confirmed yet — continuing`);
      }

      connection.subscribe(audioPlayer);
      intentionalLeave = false;
      log(`Joined voice ${LANG_BY_CHANNEL.get(wantId) || '?'} (${wantId})`);
      return connection;
    } catch (err) {
      warn(`joinChannel(${wantId}) failed:`, err.message || err);
      return null;
    } finally {
      // If we failed before clearing, still release the intentional flag
      if (intentionalLeave) intentionalLeave = false;
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
      log(`Listening to shotcaller ${userId}`);
      const pcm = await collectPcmFromUser(connection.receiver, userId);
      log(`Captured ${pcm?.length || 0} bytes from shotcaller ${userId}`);
      // Process while still holding the listener lock so a second speak cannot
      // pile up behind a hung Deepgram/TTS job with no logs.
      await processUtterance({ guild, userId, pcm });
    } catch (err) {
      warn(`Listen/pipeline failed for ${userId}:`, err.message || err);
    } finally {
      activeListeners.delete(userId);
    }
  })();
}

/**
 * Translate + post text + TTS only to OTHER language booths.
 * Never echo into the shotcaller's current booth, and never send same-language
 * (e.g. English→English) text/TTS — only real translations for other booths
 * that have ≥1 verified participant. Then return to the shotcaller.
 *
 * Translate / chat / TTS synth run in parallel for speed; Discord VC TTS tour
 * must stay sequential (one channel per guild).
 */
async function relayShotcall(guild, userId, transcript, sourceLang) {
  const t0 = Date.now();
  const src = normalizeLang(sourceLang) || 'en';
  const sc = await findActiveShotcaller(guild);
  const homeId = sc?.channelId || getVoiceConnection(guild.id)?.joinConfig?.channelId || null;
  const homeLang = homeId ? (LANG_BY_CHANNEL.get(String(homeId)) || '') : '';
  homeChannelIdWhileDelivering = homeId;

  const candidates = [];
  for (const lang of EVENT_LANGS) {
    const channelId = CHANNEL_BY_LANG[lang];
    if (!channelId) continue;
    if (homeId && String(channelId) === String(homeId)) {
      debug(`Skip ${lang} — shotcaller is in this booth`);
      continue;
    }
    if (lang === src) {
      debug(`Skip ${lang} — source language (no translate needed)`);
      continue;
    }
    if (homeLang && lang === homeLang) {
      debug(`Skip ${lang} — shotcaller booth language`);
      continue;
    }
    candidates.push({ lang, channelId });
  }

  if (!candidates.length) {
    log(`No relay candidates for ${src}`);
    homeChannelIdWhileDelivering = null;
    return;
  }

  // One audience scan, then filter candidates
  const occupied = await getVerifiedOccupiedChannelIds(guild);
  const withAudience = candidates.filter((c) => {
    const ok = occupied.has(String(c.channelId));
    if (!ok) debug(`Skip ${c.lang} — no verified participants`);
    return ok;
  });

  if (!withAudience.length) {
    log(`No relay targets for ${src} (other booths need verified listeners)`);
    homeChannelIdWhileDelivering = null;
    return;
  }

  // Translations in parallel
  const translated = await Promise.all(
    withAudience.map(async (c) => {
      try {
        const { text } = await translateText(transcript, src, c.lang);
        const trimmed = String(text || '').trim();
        if (!trimmed) return null;
        return { ...c, text: trimmed };
      } catch (err) {
        warn(`Translate ${src}→${c.lang} failed:`, err.message || err);
        return null;
      }
    }),
  );
  const payloads = translated.filter(Boolean);

  if (!payloads.length) {
    log(`No translations produced for ${src}`);
    homeChannelIdWhileDelivering = null;
    return;
  }

  log(`Relay ${src} → ${payloads.map((p) => p.lang).join(',')} (${Date.now() - t0}ms to translate)`);

  // Chat posts + TTS synth in parallel (text reaches booths ASAP).
  // Keep them independent so a TTS failure never blocks chat delivery.
  await Promise.all([
    Promise.all(
      payloads.map(async (p) => {
        const label = LANG_LABEL[p.lang] || p.lang;
        const header = `**Shotcall** (${LANG_LABEL[src] || src} → ${label})`;
        await postTextToChannel(guild, p.channelId, `${header}\n${p.text}`);
        log(`Chat ${src}→${p.lang} @ ${p.channelId}: ${p.text.slice(0, 100)}`);
      }),
    ),
    Promise.all(
      payloads.map(async (p) => {
        try {
          p.mp3 = await synthesizeSpeechBuffer(p.text);
          log(`TTS ready ${p.lang}: ${p.mp3.length} bytes`);
        } catch (err) {
          const body = err?.body ? ` body=${JSON.stringify(err.body).slice(0, 200)}` : '';
          warn(`TTS synth ${p.lang} failed:`, `${err.message || err}${body}`);
          if (/401|unauthorized|invalid/i.test(String(err.message || ''))) {
            warn('ElevenLabs 401 — check ELEVENLABS_API_KEY on Render (valid key from elevenlabs.io)');
          }
          p.mp3 = null;
        }
      }),
    ),
  ]);

  const speakable = payloads.filter((p) => p.mp3);
  if (!speakable.length) {
    warn('No TTS audio ready — text was sent; skipping voice tour');
    homeChannelIdWhileDelivering = null;
    log(`Relay complete in ${Date.now() - t0}ms (text only)`);
    return;
  }

  log(`Text+TTS synth done in ${Date.now() - t0}ms (${speakable.length} voice targets)`);

  delivering = true;
  try {
    for (const p of speakable) {
      try {
        log(`TTS join ${p.lang} (${p.channelId})`);
        const conn = await joinChannel(guild, p.channelId);
        if (!conn) {
          warn(`TTS join failed for ${p.lang}`);
          continue;
        }
        attachReceiver(conn, guild);
        await playInConnection(conn, p.mp3);
        log(`TTS played in ${p.lang}`);
      } catch (err) {
        warn(`TTS in ${p.lang} failed:`, err.message || err);
      }
    }
  } finally {
    // Keep delivering=true until we are back with the shotcaller so VSU cannot
    // treat the hop as a kick and block rejoin via suppressAutoJoinAfterKick.
    try {
      const returnId =
        homeId
        || (await findActiveShotcaller(guild))?.channelId
        || null;
      if (returnId) {
        suppressAutoJoinAfterKick = false;
        log(`TTS tour done — returning to shotcaller booth ${returnId}`);
        const conn = await joinChannel(guild, returnId);
        if (conn) {
          attachReceiver(conn, guild);
          log(`Back with shotcaller in ${LANG_BY_CHANNEL.get(String(returnId)) || returnId}`);
        } else {
          warn(`Failed to return to shotcaller booth ${returnId}`);
        }
      } else {
        warn('TTS tour done — no shotcaller booth to return to');
      }
    } catch (err) {
      warn('Return to shotcaller failed:', err.message || err);
    } finally {
      delivering = false;
      homeChannelIdWhileDelivering = null;
      log(`Relay complete in ${Date.now() - t0}ms`);
    }
  }
}

async function processUtterance({ guild, userId, pcm }) {
  if (!pcm || pcm.length < MIN_PCM_BYTES) {
    log(`Skip short utterance from ${userId} (${pcm?.length || 0} bytes, need ≥${MIN_PCM_BYTES})`);
    return;
  }
  if (!(await memberHasShotcallerRole(guild, userId))) return;

  const sc = await findActiveShotcaller(guild);
  const boothLang = sc?.userId === String(userId) ? (sc.lang || '') : '';

  const wav = pcmToWav(pcm);
  log(`STT sending ${(wav.length / 1024).toFixed(1)}KB wav for shotcaller ${userId}…`);
  let transcript;
  let language;
  try {
    ({ transcript, language } = await transcribeWav(wav, boothLang));
  } catch (err) {
    warn(`STT failed for ${userId}:`, err.message || err);
    return;
  }
  if (!transcript) {
    log(`Empty transcript for ${userId}`);
    return;
  }

  // Prefer Deepgram language; fall back to booth language when detection is empty
  const src = normalizeLang(language) || normalizeLang(boothLang) || 'en';
  log(`STT shotcaller ${userId}: [${src}${boothLang && boothLang !== src ? ` booth=${boothLang}` : ''}] ${transcript.slice(0, 160)}`);
  await relayShotcall(guild, userId, transcript, src);
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
    // Ignore intentional TTS hops / leaves; only real removals suppress rejoin
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
  log(`Verified audience role ${VERIFIED_ROLE_ID} (MIDLAND_VERIFYED_ROLE_ID) — text+TTS only to occupied booths`);
  log(`Language booths: ${EVENT_LANGS.map((l) => `${l}=${CHANNEL_BY_LANG[l]}`).join(', ')}`);
  log(`Pipeline: Deepgram(${DEEPGRAM_MODEL}) → DeepL → chat+TTS ElevenLabs(${ELEVENLABS_VOICE_ID} / ${ELEVENLABS_MODEL_ID})`);
  log(`ElevenLabs key: ${ELEVENLABS_API_KEY ? `set (len=${ELEVENLABS_API_KEY.length})` : 'MISSING'}`);
  log('Kick = no auto-rejoin until shotcaller clears booths; unexpected disconnect = rejoin');
  try {
    const report = generateDependencyReport();
    if (report.includes('ffmpeg') || report.includes('FFmpeg')) {
      log(`Voice deps:\n${report}`);
    }
  } catch (err) {
    warn('Could not print voice dependency report:', err.message || err);
  }

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
