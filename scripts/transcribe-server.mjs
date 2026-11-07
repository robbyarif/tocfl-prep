// Local Whisper transcription server for the CATO listening userscript.
//
//   npm run transcribe
//
// Listens on 127.0.0.1 only. POST the raw mp3 bytes to /transcribe?key=<id>
// and get back { text } in Traditional Chinese. Audio never leaves this machine.
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
const CACHE_VERSION = 'q8-windowed-v2';

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
  const WINDOW = TARGET_RATE * 30;
  const parts = [];
  for (let start = 0; start < audio.length; start += WINDOW) {
    const slice = audio.subarray(start, Math.min(start + WINDOW, audio.length));
    const result = await asr(slice, { language: 'chinese', task: 'transcribe' });
    parts.push(String(result.text || '').trim());
  }
  const text = toTraditional(parts.join(''));
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, model: MODEL });
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
