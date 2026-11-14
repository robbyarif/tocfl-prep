// Local Whisper transcription server for the CATO listening userscript.
//
//   npm run transcribe
//
// Listens on 127.0.0.1 only. POST the raw mp3 bytes to /transcribe?key=<id>
// and get back { text } in Traditional Chinese. Audio never leaves this machine.
// GET /script?id=<question id> returns the listening script from the question bank
// (public/data/questions.json), or 404 when the bank has none for that id.
// The first request downloads the Whisper model into .cache/models/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MPEGDecoder } from 'mpg123-decoder';
import * as OpenCC from 'opencc-js';
import { pipeline, env } from '@huggingface/transformers';

const PORT = Number(process.env.TRANSCRIBE_PORT) || 8787;
const HOST = '127.0.0.1';
const MODEL = process.env.TRANSCRIBE_MODEL || 'Xenova/whisper-small';
const MAX_BYTES = 20 * 1024 * 1024;
const TARGET_RATE = 16000;
const CACHE_VERSION = 'q8-windowed-v5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const MODEL_DIR = path.join(CACHE_DIR, 'models');
const TRANSCRIPT_DIR = path.join(CACHE_DIR, 'transcripts');
fs.mkdirSync(MODEL_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
env.cacheDir = MODEL_DIR;

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });

let asrPromise = null;
function getAsr() {
  if (!asrPromise) {
    console.log(`[transcribe] loading ${MODEL} (first run downloads the model)…`);
    // q8 (quantized) keeps memory low enough for Node; full fp32 ran out of memory.
    asrPromise = pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' }).then(p => {
      console.log('[transcribe] model ready');
      return p;
    });
    asrPromise.catch(() => { asrPromise = null; });
  }
  return asrPromise;
}

// Decode mp3 to mono Float32 at 16 kHz (linear resampling is enough for speech).
async function decodeMp3(buf) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate } = decoder.decode(new Uint8Array(buf));
    const mono = channelData.length === 1
      ? channelData[0]
      : mixDown(channelData);
    return resample(mono, sampleRate, TARGET_RATE);
  } finally {
    decoder.free();
  }
}

function mixDown(channels) {
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i] / channels.length;
  return out;
}

function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// Joins the text of two overlapping windows. The longest run at the end of `prev` that
// is also at the start of `next` is counted once. If there is no shared run, the two are
// joined as they are (a possible repeat is better than a dropped sentence).
async function transcribeBuffer(buf) {
  // The version is part of the key so results from older server code (e.g. the
  // 30-second cut-off) are never returned. Bump it whenever the transcription changes.
  const hash = crypto.createHash('sha1').update(CACHE_VERSION).update(buf).digest('hex');
  const cachePath = path.join(TRANSCRIPT_DIR, hash + '.json');
  if (fs.existsSync(cachePath)) {
    return { text: JSON.parse(fs.readFileSync(cachePath, 'utf8')).text, cached: true };
  }

  const audio = await decodeMp3(buf);
  const asr = await getAsr();
  // Whisper only sees 30 s at a time. Split longer clips into 30 s windows
  // ourselves; the library's built-in chunking ran out of memory in Node.
  // Windows do not overlap: overlapping windows made Whisper repeat text at each seam.
  const WINDOW = TARGET_RATE * 30;
  let text = '';
  for (let start = 0; start < audio.length; start += WINDOW) {
    const slice = audio.subarray(start, Math.min(start + WINDOW, audio.length));
    const result = await asr(slice, { language: 'chinese', task: 'transcribe' });
    text += String(result.text || '').trim();
  }
  // Whisper sometimes loops on one character (e.g. 車車車…). Keep at most two in a row.
  text = toTraditional(text).replace(/(.)\1{7,}/gu, '$1$1');
  fs.writeFileSync(cachePath, JSON.stringify({ text }, null, 2));
  return { text, cached: false };
}

// The question bank written by `npm run build:data`. Loaded on first use; restart the server after a rebuild.
const BANK_PATH = path.join(ROOT, 'public', 'data', 'questions.json');
let bankPages = null;
function loadBankPages() {
  if (!bankPages) bankPages = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8')).pages;
  return bankPages;
}

// The listening script for a question ID from the bank (its "Listening Script" PDF, OCR'd at build time).
function sendBankScript(res, id) {
  if (!/^[A-Z]\d{8}$/.test(id)) return send(res, 400, { error: 'bad id' });
  if (!fs.existsSync(BANK_PATH)) return send(res, 503, { error: 'question bank not built: run npm run build:data' });
  const page = loadBankPages()[id];
  if (!page || !page.script) return send(res, 404, { error: 'not in question bank' });
  return send(res, 200, { text: page.script, source: 'bank' });
}


// ---- English translation (local model, same library as the transcription) ----
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'Xenova/opus-mt-zh-en';
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }); // the model is trained on Simplified Chinese
const ENGLISH_DIR = path.join(CACHE_DIR, 'english');
fs.mkdirSync(ENGLISH_DIR, { recursive: true });
let translatorPromise = null;
function getTranslator() {
  if (!translatorPromise) {
    console.log(`[translate] loading ${TRANSLATE_MODEL} (first run downloads the model)…`);
    translatorPromise = pipeline('translation', TRANSLATE_MODEL, { dtype: 'q8' }).then(p => {
      console.log('[translate] model ready');
      return p;
    });
    translatorPromise.catch(() => { translatorPromise = null; });
  }
  return translatorPromise;
}

// Split at sentence ends so each piece is a sentence the model handles well.
function splitSentences(text) {
  // Answer letters (A. B. C. D.) start new pieces, so the model never sees all the choices as one run.
  return text.replace(/([A-D]\.)/g, '\n$1').split('\n')
    .flatMap(line => line.match(/[^。！？!?，,]+[。！？!?，,]?/g) || [])
    .map(s => s.trim()).filter(Boolean);
}

async function translateText(zhTw) {
  // The version is part of the key so older translations (e.g. choices without their text) are not reused.
  const hash = crypto.createHash('sha1').update('translate-v3:' + TRANSLATE_MODEL).update(zhTw).digest('hex');
  const cachePath = path.join(ENGLISH_DIR, hash + '.json');
  if (fs.existsSync(cachePath)) return { text: JSON.parse(fs.readFileSync(cachePath, 'utf8')).text, cached: true };
  const translator = await getTranslator();
  const parts = [];
  for (const sentence of splitSentences(toSimplified(zhTw))) {
    // An answer choice like "A. 要遵守交通規則": translate the text after the letter and keep the letter.
    const choice = /^([A-D])\.\s*(.*)$/.exec(sentence);
    const body = choice ? choice[2] : sentence;
    console.log('[translate] piece:', JSON.stringify(body));
    const out = body ? await translator(body, { max_new_tokens: 200 }) : [{ translation_text: '' }];
    const en = String(out[0].translation_text || '').trim();
    parts.push(choice ? `${choice[1]}. ${en}` : en);
  }
  const text = parts.join(' ');
  fs.writeFileSync(cachePath, JSON.stringify({ text }, null, 2));
  return { text, cached: false };
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Allow the userscript (running on the CATO https page) to call this server.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

// English line translations for the transcript panel, from the study app's data
// (public/data/translations.json). Read once and kept in memory.
const TRANSLATIONS_FILE = path.join(ROOT, 'public', 'data', 'translations.json');
let translationLines = null;
function sendTranslations(res) {
  if (!translationLines) {
    try {
      translationLines = JSON.parse(fs.readFileSync(TRANSLATIONS_FILE, 'utf8')).lines || {};
    } catch (err) {
      return send(res, 500, { error: 'translations not available: ' + err.message });
    }
  }
  return send(res, 200, { lines: translationLines });
}

// Dictionary (CC-CEDICT subset) for the transcript popup, from public/data/dict.json.
const DICT_FILE = path.join(ROOT, 'public', 'data', 'dict.json');
let dictData = null;
function sendDict(res) {
  if (!dictData) {
    try {
      dictData = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
    } catch (err) {
      return send(res, 500, { error: 'dictionary not available: ' + err.message });
    }
  }
  return send(res, 200, dictData);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, model: MODEL });
  }

  if (req.method === 'GET' && url.pathname === '/script') {
    return sendBankScript(res, url.searchParams.get('id') || '');
  }

  if (req.method === 'GET' && url.pathname === '/translations') {
    return sendTranslations(res);
  }

  if (req.method === 'GET' && url.pathname === '/dict') {
    return sendDict(res);
  }

  if (req.method === 'POST' && url.pathname === '/translate') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'no text' });
        const { text: english, cached } = await translateText(text);
        send(res, 200, { text: english, cached });
      } catch (err) {
        console.error('[translate] failed:', err);
        send(res, 500, { error: String(err && err.message || err) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/transcribe') {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        send(res, 413, { error: 'audio too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size > MAX_BYTES) return;
      try {
        const { text, cached } = await transcribeBuffer(Buffer.concat(chunks));
        send(res, 200, { text, cached });
      } catch (err) {
        console.error('[transcribe] failed:', err);
        send(res, 500, { error: String(err && err.message || err) });
      }
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[transcribe] listening on http://${HOST}:${PORT}`);
});
