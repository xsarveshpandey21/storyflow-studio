import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (e) {
    // .env may not exist yet or is already loaded by dotenv
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8'
};

const DEFAULT_VOICE = 'hi-IN-SwaraNeural';

/**
 * Splits long text into chunks of <= 500 characters at sentence or word boundaries
 */
function splitTextIntoChunks(text, maxChars = 500) {
  if (!text || text.length <= maxChars) return [text];
  const sentenceParts = text.split(/([।\.\?!;\n\r]+)/g);
  const sentences = [];
  for (let i = 0; i < sentenceParts.length; i += 2) {
    const part = sentenceParts[i] || '';
    const punct = sentenceParts[i + 1] || '';
    const full = (part + punct).trim();
    if (full) sentences.push(full);
  }

  const chunks = [];
  let currentChunk = '';
  for (const s of sentences) {
    if ((currentChunk + ' ' + s).length <= maxChars) {
      currentChunk = currentChunk ? currentChunk + ' ' + s : s;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      if (s.length <= maxChars) {
        currentChunk = s;
      } else {
        // Break very long sentence by spaces / commas
        const words = s.split(/([,،\s]+)/g);
        let sub = '';
        for (const w of words) {
          if ((sub + w).length <= maxChars) {
            sub += w;
          } else {
            if (sub.trim()) chunks.push(sub.trim());
            sub = w;
          }
        }
        currentChunk = sub.trim();
      }
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

/**
 * Formats rate for SSML / MsEdgeTTS (e.g. 1.0 -> "+0%", 1.2 -> "+20%", 0.8 -> "-20%")
 */
export function formatRateStr(rate) {
  if (typeof rate === 'number') {
    const pct = Math.round((rate - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
  if (typeof rate === 'string') {
    return rate;
  }
  return '+0%';
}

/**
 * Formats pitch for SSML / MsEdgeTTS (e.g. 1.0 -> "+0%", 1.2 -> "+20%", 0.8 -> "-20%")
 * Converts relative factor (0.7 - 1.3) to percentage string (+20% / -15%)
 */
export function formatPitchStr(pitch) {
  if (typeof pitch === 'number') {
    const pct = Math.round((pitch - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
  if (typeof pitch === 'string') {
    return pitch;
  }
  return '+0%';
}

/**
 * Formats volume for SSML / MsEdgeTTS (e.g. 1.0 -> "+0%", 0.8 -> "-20%")
 */
export function formatVolumeStr(volume) {
  if (typeof volume === 'number') {
    const pct = Math.round((volume - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
  if (typeof volume === 'string') {
    return volume;
  }
  return '+0%';
}

/**
 * Maps raw TTS errors to short, user-friendly error messages
 */
export function mapTtsErrorMessage(err) {
  if (!err) return 'Edge TTS synthesis failed';
  const msg = (err.message || '').toLowerCase();
  const code = err.code || (err.cause && err.cause.code);

  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' ||
      msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('enetunreach') ||
      msg.includes('getaddrinfo')) {
    return 'No internet connection to Microsoft TTS';
  }
  if (msg.includes('403') || msg.includes('429') || msg.includes('rate limit') || msg.includes('throttle')) {
    return 'Microsoft TTS rejected the request (403/429)';
  }
  if (msg.includes('unknown voice') || (msg.includes('voice') && msg.includes('not found')) || msg.includes('voicelocale')) {
    return 'Unknown voice';
  }
  if (msg.includes('zero-byte') || msg.includes('empty audio')) {
    return 'TTS service returned empty audio';
  }
  return err.message || 'Edge TTS synthesis failed';
}

/**
 * Synthesizes a single chunk using MsEdgeTTS with resilient backoff on rate limits / 429
 * Closes the instance in finally block, and aborts retries immediately on connection drops.
 */
async function synthesizeChunk(text, voice = DEFAULT_VOICE, rate = 1.0, pitch = 1.0, volume = 1.0, retries = 5) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    let tts = null;
    try {
      if (attempt > 0) {
        // Exponential backoff with jitter for 429 rate limits
        const baseWait = 800 * Math.pow(1.8, attempt - 1);
        const jitter = Math.random() * 400;
        const waitMs = Math.min(8000, Math.round(baseWait + jitter));
        console.log(`[TTS] Rate limit / retry backoff: waiting ${waitMs}ms before attempt ${attempt + 1}...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

      const rateStr = formatRateStr(rate);
      const pitchStr = formatPitchStr(pitch);
      const volumeStr = formatVolumeStr(volume);

      const { audioStream } = tts.toStream(text, {
        rate: rateStr,
        pitch: pitchStr,
        volume: volumeStr
      });

      const buffers = [];
      for await (const chunk of audioStream) {
        buffers.push(chunk);
      }
      const resultBuf = Buffer.concat(buffers);
      if (resultBuf.length === 0) {
        throw new Error('Zero-byte audio received from TTS service.');
      }
      return resultBuf;
    } catch (err) {
      lastErr = err;
      console.warn(`[TTS] Synthesis attempt ${attempt + 1}/${retries} failed: ${err.message}`);

      // Stop retrying immediately on network unreachable / DNS errors (no internet)
      const code = err.code || (err.cause && err.cause.code);
      const msg = (err.message || '').toLowerCase();
      const isOffline = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' ||
                        msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('enetunreach') ||
                        msg.includes('getaddrinfo');
      const isClientErr = msg.includes('voicelocale') || msg.includes('unknown voice');
      if (isOffline || isClientErr) {
        console.warn(`[TTS] Non-retryable error detected (${code || err.message}). Stopping retry loop immediately.`);
        break;
      }
    } finally {
      if (tts) {
        try {
          tts.close();
        } catch (closeErr) {
          // ignore socket close error
        }
      }
    }
  }
  throw lastErr;
}

/**
 * Parses JSON body from either pre-parsed req.body (e.g. Vercel) or incoming stream (Node.js)
 */
export async function parseJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        tooLarge = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        return reject(err);
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });

    req.on('error', reject);
  });
}

/**
 * Handles POST /api/tts
 */
export async function handleTtsRequest(req, res) {
  try {
    const data = await parseJsonBody(req, 10 * 1024 * 1024);
    const text = (data.text || '').trim();
    if (!text) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify({ error: 'Text parameter is required.' }));
    }

    let voice = data.voice || DEFAULT_VOICE;
    const rate = data.rate !== undefined ? data.rate : 1.0;
    const pitch = data.pitch !== undefined ? data.pitch : 1.0;
    const volume = data.volume !== undefined ? data.volume : 1.0;

    // Smart language matching: if text is Hindi and voice is an English-only voice, use Hindi voice
    const hasDevanagari = /[\u0900-\u097F]/.test(text);
    if (hasDevanagari && voice.startsWith('en-')) {
      console.log(`[TTS] Text contains Hindi characters; switching voice from ${voice} to hi-IN-SwaraNeural.`);
      voice = 'hi-IN-SwaraNeural';
    }

    console.log(`[TTS] Synthesizing (${voice}, rate=${rate}, pitch=${pitch}, vol=${volume}): "${text.slice(0, 60)}..."`);

    const chunks = splitTextIntoChunks(text, 500);
    const audioBuffers = [];

    for (let i = 0; i < chunks.length; i++) {
      let audioBuf = await synthesizeChunk(chunks[i], voice, rate, pitch, volume);
      if (audioBuf.length === 0 && voice !== DEFAULT_VOICE) {
        // Retry with default voice
        console.warn(`[TTS] Chunk returned 0 bytes with ${voice}. Retrying with default ${DEFAULT_VOICE}...`);
        audioBuf = await synthesizeChunk(chunks[i], DEFAULT_VOICE, rate, pitch, volume);
      }
      audioBuffers.push(audioBuf);
    }

    const combinedAudio = Buffer.concat(audioBuffers);
    if (combinedAudio.length === 0) {
      throw new Error('TTS service generated empty audio.');
    }

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': combinedAudio.length,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(combinedAudio);
  } catch (err) {
    console.error('[TTS Error]', err);
    const humanError = mapTtsErrorMessage(err);
    res.writeHead(err.statusCode || 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      error: humanError,
      detail: err.message || 'Unknown error'
    }));
  }
}

/**
 * Static file server
 */
function serveStaticFile(req, res) {
  let reqPath = decodeURI(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const filePath = path.join(__dirname, reqPath);

  // Security check to avoid path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.log('[404 Not Found]', reqPath);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`404 Not Found: ${reqPath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

/**
 * Calls Google Gemini REST API to generate YouTube & Facebook metadata
 */
export async function callGeminiMetaAPI({
  script,
  platforms = 'both',
  language = 'Hindi',
  tone = 'Curious',
  videoType = 'Shorts',
  niche = '',
  audience = ''
}, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY missing in .env');
    err.statusCode = 500;
    throw err;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const truncatedScript = (script || '').slice(0, 12000);

  const systemInstruction = `You are a world-class YouTube and Facebook strategist and SEO copywriter.
Analyze the provided video script and generate high-performing, high-CTR metadata.

STRICT CONSTRAINTS:
1. TRUTHFULNESS: Base all content strictly on facts and events mentioned in the provided script. Do NOT invent claims, false statistics, imaginary names, or events not present in the script.
2. SCRIPT TOPIC & EMOTION: Extract the core moments, emotion, and key topic of the script.
3. LANGUAGE CONSISTENCY:
   - If language is 'Hindi' or the script is in Devanagari Hindi, output in Devanagari Hindi.
   - If Hinglish, output in natural Hinglish.
   - If English, output in English.
4. YOUTUBE CONSTRAINTS:
   - titles: Exactly 5 distinct, high-CTR, curiosity-driven titles in the requested language. Each title MUST be at most 70 characters. Place the main keyword near the start.
   - description: Beautifully formatted YouTube description (<= 5000 chars) with neat sections, emojis, and clear paragraph breaks:
     📌 Hook: First 2 captivating lines that hook viewers before the 'Show more' button.
     📖 Story Overview: An engaging 2-paragraph overview of the video topic based on the script.
     ✨ Key Highlights: 3 to 4 bullet points with emojis (e.g. 🔹, 📍, 💡) highlighting the core moments.
     ⏱️ Chapters: 3 to 4 estimated chapters with timestamps (e.g. 00:00 - Introduction, 00:30 - The Story Unfolds, 01:00 - Conclusion).
     🔔 Call to Action: A friendly CTA to Like 👍, Share 📲, and Subscribe 🔔 with an engagement question.
     🏷️ Hashtags: Conclude with 5 to 8 top hashtags at the very bottom.
     Ensure neat spacing with double line breaks between sections.
   - hashtags: Exactly 20 to 25+ viral and trending hashtags starting with '#' (no internal spaces). MUST include top broad trending tags (#Trending, #Viral, #ViralVideo, #FYP, #Shorts, #Explore, #MustWatch, #TrendingNow) combined with topic-specific trending hashtags derived from the script concepts.
   - tags: Array of keyword tags totaling at most 450 characters combined.
   - pinned_comment: Engaging question or comment in the requested language to spark community interaction and discussion.
5. FACEBOOK CONSTRAINTS:
   - headlines: Exactly 3 catchy headline or caption options, each at most 100 characters.
   - post_text: Beautifully formatted Facebook post text with neat sections, emojis, and line breaks:
     🎯 Hook: First-line hook visible before 'See more' (~125 characters).
     📜 Story Summary: 2 engaging, well-spaced paragraphs with emojis.
     💬 Discussion Question: An engaging question asking viewers for their thoughts in the comments.
     📢 CTA & Hashtags: Clear call to action followed by 5 to 8 hashtags.
   - video_title: Catchy title for video/reel upload.
   - video_description: Concise formatted description for Facebook video.
   - hashtags: Exactly 20+ viral and trending hashtags starting with '#' (no spaces), including top trending tags (#Trending, #Viral, #Reels, #ViralPost, #FYP, #Explore, #ViralReels) and content-specific tags.
   - first_comment: Engaging first comment with CTA for higher reach.`;

  const userPrompt = `Generate YouTube and Facebook metadata for the following video script.
Target Format: ${videoType}
Tone: ${tone}
Target Language: ${language}
${niche ? `Niche / Topic: ${niche}` : ''}
${audience ? `Target Audience: ${audience}` : ''}

VIDEO SCRIPT:
"""
${truncatedScript}
"""`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          youtube: {
            type: 'OBJECT',
            properties: {
              titles: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: '5 title options, each <= 70 characters'
              },
              description: {
                type: 'STRING',
                description: 'Professionally formatted YouTube description <= 5000 chars with Hook, Story Overview, Highlights, Chapters, CTA and Hashtags'
              },
              hashtags: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: '20 to 25+ viral and trending hashtags starting with #'
              },
              tags: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'YouTube keyword tags totaling <= 450 characters combined'
              },
              pinned_comment: {
                type: 'STRING',
                description: 'Engaging pinned comment for viewer interaction'
              }
            },
            required: ['titles', 'description', 'hashtags', 'tags', 'pinned_comment']
          },
          facebook: {
            type: 'OBJECT',
            properties: {
              headlines: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: '3 caption/headline options <= 100 characters'
              },
              post_text: {
                type: 'STRING',
                description: 'Formatted Facebook post text with Hook, Story Summary, Highlights, Question, CTA and Hashtags'
              },
              video_title: {
                type: 'STRING',
                description: 'Catchy video or reel title'
              },
              video_description: {
                type: 'STRING',
                description: 'Concise description for Facebook video'
              },
              hashtags: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: '20+ viral and trending hashtags starting with #'
              },
              first_comment: {
                type: 'STRING',
                description: 'First comment for engagement'
              }
            },
            required: ['headlines', 'post_text', 'video_title', 'video_description', 'hashtags', 'first_comment']
          }
        },
        required: ['youtube', 'facebook']
      }
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const status = res.status;
        const errText = await res.text();
        if (status === 401 || status === 403) {
          const err = new Error('API key invalid');
          err.statusCode = status;
          throw err;
        } else if (status === 429) {
          const err = new Error('Rate limit, wait a minute');
          err.statusCode = 429;
          throw err;
        } else if (status >= 500) {
          const err = new Error('Gemini temporarily unavailable');
          err.statusCode = 502;
          throw err;
        } else {
          const err = new Error(`Gemini API error (${status}): ${errText}`);
          err.statusCode = status;
          throw err;
        }
      }

      const json = await res.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error('Empty response from Gemini API');
      }

      const parsed = JSON.parse(rawText);

      // Ensure at least 20+ viral and trending hashtags for YouTube & Facebook
      const DEFAULT_TRENDING_YT = [
        '#Trending', '#Viral', '#FYP', '#Shorts', '#ViralVideo',
        '#Explore', '#MustWatch', '#TrendingNow', '#ForYou', '#YouTubeShorts',
        '#ViralShorts', '#DailyShorts', '#ExplorePage', '#Creator', '#StoryTime',
        '#ShortsViral', '#WatchNow', '#TrendingTopic', '#NewVideo', '#Entertainment',
        '#TopTrending', '#TrendingReels', '#VideoOfTheDay'
      ];
      const DEFAULT_TRENDING_FB = [
        '#Trending', '#Viral', '#Reels', '#FYP', '#ViralPost',
        '#Explore', '#FacebookReels', '#ViralReels', '#TrendingReels', '#ForYouPage',
        '#MustWatch', '#DailyReels', '#TrendingNow', '#WatchThis', '#ReelsViral',
        '#ViralVideo', '#ReelItFeelIt', '#Shorts', '#VideoOfTheDay', '#TopTrend',
        '#TrendingPost', '#Creators'
      ];

      const enrichTags = (existing, fallbackTrending, minCount = 20) => {
        const set = new Set();
        const list = [];
        (existing || []).forEach((t) => {
          let clean = (t || '').trim().replace(/\s+/g, '');
          if (clean && !clean.startsWith('#')) clean = '#' + clean;
          if (clean && !set.has(clean.toLowerCase())) {
            set.add(clean.toLowerCase());
            list.push(clean);
          }
        });
        for (const tag of fallbackTrending) {
          if (list.length >= minCount) break;
          if (!set.has(tag.toLowerCase())) {
            set.add(tag.toLowerCase());
            list.push(tag);
          }
        }
        return list;
      };

      if (parsed && parsed.youtube) {
        parsed.youtube.hashtags = enrichTags(parsed.youtube.hashtags, DEFAULT_TRENDING_YT, 20);
      }
      if (parsed && parsed.facebook) {
        parsed.facebook.hashtags = enrichTags(parsed.facebook.hashtags, DEFAULT_TRENDING_FB, 20);
      }

      return parsed;
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 500) {
        break; // Non-retryable
      }
    }
  }

  if (lastErr) {
    const isNetworkError =
      lastErr.code === 'ENOTFOUND' ||
      lastErr.code === 'ECONNREFUSED' ||
      lastErr.code === 'EAI_AGAIN' ||
      lastErr.cause?.code === 'ENOTFOUND' ||
      (lastErr.message && (
        lastErr.message.includes('fetch failed') ||
        lastErr.message.includes('ENOTFOUND') ||
        lastErr.message.includes('network')
      ));

    if (isNetworkError) {
      const netErr = new Error('Cannot reach Gemini. Check your internet connection.');
      netErr.statusCode = 503;
      throw netErr;
    }
  }

  throw lastErr;
}

/**
 * Handles POST /api/generate-meta
 */
export async function handleGenerateMetaRequest(req, res) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify({ error: 'GEMINI_API_KEY missing in .env' }));
    }

    const data = await parseJsonBody(req, 1024 * 1024);
    const script = (data.script || '').trim();
    if (!script) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify({ error: 'Script text is required' }));
    }

    const result = await callGeminiMetaAPI(data, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[Generate-Meta Error]', err);
    const isNetworkError =
      err.code === 'ENOTFOUND' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'EAI_AGAIN' ||
      err.cause?.code === 'ENOTFOUND' ||
      (err.message && (
        err.message.includes('fetch failed') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('Cannot reach Gemini') ||
        err.message.includes('network')
      ));

    let statusCode = err.statusCode || 500;
    let message = err.message || 'Gemini metadata generation failed';
    if (isNetworkError) {
      statusCode = 503;
      message = 'Cannot reach Gemini. Check your internet connection.';
    }

    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: message }));
  }
}

// Read optional GEMINI_API_KEY from .env or process.env
let serverHasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^\s*GEMINI_API_KEY\s*=\s*(["']?)(.*?)\1\s*$/m);
    if (match && match[2].trim()) {
      serverHasGeminiKey = true;
      process.env.GEMINI_API_KEY = match[2].trim();
    }
  }
} catch (e) {}

export function handleAppRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const rawUrl = req.url || '/';
  const urlPath = rawUrl.split('?')[0];

  if (urlPath === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (urlPath === '/api/health' || urlPath.endsWith('/api/health'))) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ ok: true, tts: true }));
  }

  if (req.method === 'GET' && (urlPath === '/api/config' || urlPath.endsWith('/api/config') || rawUrl.includes('/api/config'))) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
    }));
  }

  if (req.method === 'GET' && (urlPath === '/api/has-key' || urlPath.endsWith('/api/has-key'))) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ hasKey: Boolean(process.env.GEMINI_API_KEY) }));
  }

  if (req.method === 'POST' && (urlPath === '/api/generate-meta' || urlPath.endsWith('/api/generate-meta'))) {
    return handleGenerateMetaRequest(req, res);
  }

  if (req.method === 'POST' && (urlPath === '/api/tts' || urlPath.endsWith('/api/tts'))) {
    return handleTtsRequest(req, res);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStaticFile(req, res);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
}

const server = http.createServer(handleAppRequest);

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 StoryFlow Studio Server running at http://localhost:${PORT}`);
    console.log(`🎙️  Neural TTS endpoint ready at POST /api/tts`);
    console.log(`✨ Gemini Meta endpoint ready at POST /api/generate-meta`);
    console.log(`======================================================\n`);
  });
}

export { server, splitTextIntoChunks, synthesizeChunk };

