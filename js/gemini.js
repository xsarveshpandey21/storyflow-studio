/**
 * StoryFlow Studio — Google Gemini API Client
 * Centralized client for Gemini REST API with:
 * - Concurrency limiter (max 2 parallel requests)
 * - Automatic retry on 5xx or JSON parse glitch
 * - Exponential back-off on 429 rate limit
 * - Timeouts via AbortController
 * - JSON responseSchema support
 * - Search-grounded research (Google Search tool)
 * - Session calls counter
 * - Local fallback scoring for Scene Match
 */

import { saveSetting, loadSetting } from './storage.js';

export class GeminiClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'gemini-2.5-flash';
    this.sessionCallsCount = 0;
    this.activeRequests = 0;
    this.maxConcurrent = 2;
    this.queue = [];
    this.onCallCountChange = options.onCallCountChange || null;
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
  }

  getApiKey() {
    return this.apiKey || '';
  }

  setModel(model) {
    this.model = (model || '').trim() || 'gemini-2.5-flash';
    saveSetting('gemini_model', this.model);
  }

  getModel() {
    return this.model || loadSetting('gemini_model', 'gemini-2.5-flash');
  }

  incrementCallsCount() {
    this.sessionCallsCount++;
    if (typeof this.onCallCountChange === 'function') {
      try {
        this.onCallCountChange(this.sessionCallsCount);
      } catch (e) {}
    }
  }

  /**
   * Enqueues a request to maintain at most maxConcurrent (2) parallel executions
   */
  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  processQueue() {
    if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }
    const item = this.queue.shift();
    this.activeRequests++;

    (async () => {
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        this.activeRequests--;
        this.processQueue();
      }
    })();
  }

  /**
   * Core request dispatcher with retries, timeouts, and backoff
   */
  async request({ model, payload, timeoutMs = 45000, maxRetries = 2, isSearchTool = false }) {
    return this.enqueue(async () => {
      const key = this.getApiKey();
      if (!key) {
        throw new Error('API key missing. Please enter your Gemini API key in settings.');
      }
      if (typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) {
        throw new Error('You are offline. Please check your internet connection.');
      }

      const effectiveModel = model || this.getModel();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(effectiveModel)}:generateContent`;

      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          this.incrementCallsCount();

          const authHeader = ['x-goog', 'api-key'].join('-');
          const headers = {
            'Content-Type': 'application/json'
          };
          if (key) {
            headers[authHeader] = key;
          }

          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (response.status === 400 || response.status === 401 || response.status === 403) {
              throw new Error('API key invalid. Please check your Gemini API key.');
            } else if (response.status === 429) {
              if (attempt < maxRetries) {
                const waitTime = Math.min(8000, 1500 * Math.pow(2, attempt) + Math.random() * 500);
                await new Promise((r) => setTimeout(r, waitTime));
                continue;
              }
              throw new Error('Rate limit reached (429). Please wait a moment and try again.');
            } else if (response.status >= 500) {
              if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, 1200));
                continue;
              }
              throw new Error('Gemini service temporarily unavailable (5xx).');
            } else {
              let errMsg = '';
              try {
                const errBody = await response.json();
                errMsg = errBody?.error?.message || '';
              } catch (e) {}
              throw new Error(errMsg || `Request failed with HTTP status ${response.status}`);
            }
          }

          const data = await response.json();
          const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!candidateText && candidateText !== '') {
            throw new Error('Invalid response structure from Gemini API');
          }

          if (isSearchTool) {
            return candidateText;
          }

          // JSON parsing
          try {
            // Strip any accidental markdown formatting
            const cleaned = candidateText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const parsed = JSON.parse(cleaned);
            return parsed;
          } catch (jsonErr) {
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            throw new Error('Failed to parse Gemini JSON response');
          }
        } catch (err) {
          clearTimeout(timeoutId);
          lastError = err;
          if (err.name === 'AbortError') {
            lastError = new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
          }
          if (
            lastError.message.includes('API key invalid') ||
            lastError.message.includes('offline')
          ) {
            break;
          }
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }

      throw lastError;
    });
  }

  /**
   * 1. generateScript
   */
  async generateScript({
    story,
    language = 'Hindi',
    targetSeconds = 75,
    tone = 'Emotional',
    openingStyle = 'Scene',
    skipPolitics = true,
    skipHistory = true,
    customInstructions = '',
    platforms = ['YouTube Shorts', 'Instagram Reels'],
    trendingKeywords = ''
  }) {
    const targetWords = Math.round(targetSeconds * 2.4);
    const minWords = Math.round(targetWords * 0.9);
    const maxWords = Math.round(targetWords * 1.1);

    const systemPrompt = `You are an elite video scriptwriter specializing in high-retention narration for short-form historical and emotional story videos.
Your task is to transform the provided source story into a powerful, spoken narration script in ${language}.

CRITICAL RULES:
1. FACTS & TRUTH: Use strictly facts present in the source. NEVER invent names, numbers, quotes, or dates.
2. SPOKEN HINDI / NATURAL PHRASING:
   - Natural spoken Hindi with correct nukta (e.g. क़िला, ज़िंदगी, फ़रीदाबाद, महफ़ूज़, वतन).
   - Short, punchy sentences. Exactly ONE sentence per line.
   - Every single line MUST end with a Hindi danda (।) or question mark (?).
3. WORD BUDGET & TIMING:
   - Target length: ${targetSeconds} seconds.
   - Word count MUST stay between ${minWords} and ${maxWords} words (narration pace ~2.4 words per second).
4. OPENING & HOOK:
   - Opening style chosen: "${openingStyle}" (e.g. Scene, Question, Shocking fact, Object hook).
   - Line 1 must immediately grab attention using this style without generic introductions like "आज हम बात करेंगे".
5. ENDING:
   - The very last line must naturally prompt viewers to share their thoughts or comment.
6. NO POLITICS / LEADERS:
   ${skipPolitics ? '- SKIP political roles and leaders. Name NO political leaders, explain NO political negotiations, and start directly inside a human scene.' : ''}
   ${skipHistory ? '- SKIP background political treaties and macro history. Focus 100% on personal human drama, emotional stakes, and vivid sensory details.' : ''}
${customInstructions ? `7. CUSTOM USER INSTRUCTIONS:\n${customInstructions}` : ''}
${trendingKeywords ? `8. TRENDING KEYWORD CONTEXT (from Google Search):\n${trendingKeywords}` : ''}

SOURCE STORY:
"""
${story}
"""`;

    const schema = {
      type: 'OBJECT',
      properties: {
        script_lines: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Array of short spoken script lines, one sentence per line ending with ।'
        },
        estimated_seconds: {
          type: 'NUMBER',
          description: 'Estimated narration duration in seconds (total words / 2.4)'
        },
        hook_options: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              text: { type: 'STRING', description: 'Alternative hook line for line 1' },
              why: { type: 'STRING', description: 'Psychological reasoning why this hook retains viewers' },
              score: { type: 'NUMBER', description: 'Retention score from 1 to 10' }
            },
            required: ['text', 'why', 'score']
          },
          description: 'Exactly 3 alternative hook options'
        },
        scene_tags: {
          type: 'ARRAY',
          items: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: '2 to 4 English keywords describing the ideal visual for this line'
          },
          description: 'Scene tags for each script line, matching the script_lines array length'
        },
        youtube: {
          type: 'OBJECT',
          properties: {
            titles: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: '5 curiosity-driven titles, each <= 70 characters'
            },
            description: {
              type: 'STRING',
              description: 'YouTube description with hook in first 2 lines, summary, CTA, and 3-5 hashtags at bottom'
            },
            hashtags: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: '8 to 12 hashtags starting with #'
            },
            tags: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Keyword tags totaling <= 450 characters'
            },
            pinned_comment: {
              type: 'STRING',
              description: 'Engaging comment asking a question to spark viewer discussions'
            }
          },
          required: ['titles', 'description', 'hashtags', 'tags', 'pinned_comment']
        },
        facebook: {
          type: 'OBJECT',
          properties: {
            caption: { type: 'STRING', description: 'Facebook video caption' },
            hook_line: { type: 'STRING', description: 'Punchy hook line for the post' },
            hashtags: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Exactly 3 to 5 relevant hashtags'
            },
            first_comment: { type: 'STRING', description: 'First comment for engagement' }
          },
          required: ['caption', 'hook_line', 'hashtags', 'first_comment']
        }
      },
      required: ['script_lines', 'estimated_seconds', 'hook_options', 'scene_tags', 'youtube', 'facebook']
    };

    const payload = {
      contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.7
      }
    };

    return this.request({ payload });
  }

  /**
   * 2. shortenLine - rewrites one script line to be shorter and punchier
   */
  async shortenLine({ lineText, targetSeconds = 5, storyContext = '' }) {
    const prompt = `Rewrite this single video narration line in natural spoken Hindi.
Make it shorter, more urgent, and concise. It MUST end with a Hindi danda (।) and be under ${Math.round(targetSeconds * 2.4)} words.
Base it strictly on the original line. Do not invent new facts.

ORIGINAL LINE:
"${lineText}"

${storyContext ? `STORY CONTEXT:\n${storyContext.slice(0, 300)}` : ''}`;

    const schema = {
      type: 'OBJECT',
      properties: {
        shortened_line: { type: 'STRING', description: 'Shortened Hindi line ending with ।' },
        estimated_seconds: { type: 'NUMBER', description: 'Estimated spoken duration (words / 2.4)' }
      },
      required: ['shortened_line', 'estimated_seconds']
    };

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.5
      }
    };

    return this.request({ payload });
  }

  /**
   * 3. moreHooks - generates 3 more hook options
   */
  async moreHooks({ story, currentHooks = [], openingStyle = 'Scene' }) {
    const prompt = `Generate 3 completely fresh, ultra-compelling hook lines in Hindi for opening this story video.
Opening style: "${openingStyle}".
Each hook must be emotional, spark curiosity, and make the viewer stay.
Do NOT repeat these existing hooks:
${currentHooks.map((h) => `- ${typeof h === 'string' ? h : h.text}`).join('\n')}

STORY:
"""
${story}
"""`;

    const schema = {
      type: 'OBJECT',
      properties: {
        hook_options: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              text: { type: 'STRING', description: 'Compelling Hindi hook line ending with । or ?' },
              why: { type: 'STRING', description: 'Why this hook grabs psychological attention' },
              score: { type: 'NUMBER', description: 'Score from 1 to 10' }
            },
            required: ['text', 'why', 'score']
          }
        }
      },
      required: ['hook_options']
    };

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.8
      }
    };

    return this.request({ payload });
  }

  /**
   * 4. tagPhotos - sends up to 8 downscaled photo base64 JPEGs in a batch
   */
  async tagPhotos(photos) {
    if (!photos || photos.length === 0) return [];

    // photos: Array<{ id: string, base64: string, mimeType?: string }>
    const parts = [
      {
        text: `You are an expert visual archivist. Analyze each provided image.
For every image, provide:
1. "tags": 3 to 6 English keywords accurately describing the subjects, setting, actions, or objects visible (e.g. ["steam locomotive", "crowded platform", "vintage luggage", "refugees"]).
2. "caption": A concise 1-line Hindi caption describing the photo.
3. "mood": A single emotional mood tag (e.g. "sorrowful", "chaotic", "nostalgic", "hopeful", "tense", "solemn").`
      }
    ];

    photos.forEach((p, idx) => {
      parts.push({
        text: `Image #${idx + 1} (Photo ID: ${p.id}):`
      });
      parts.push({
        inlineData: {
          mimeType: p.mimeType || 'image/jpeg',
          data: p.base64
        }
      });
    });

    const schema = {
      type: 'OBJECT',
      properties: {
        results: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              id: { type: 'STRING', description: 'The Photo ID matched from the request' },
              tags: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: '3 to 6 English descriptive tags'
              },
              caption: { type: 'STRING', description: 'One-line Hindi description' },
              mood: { type: 'STRING', description: 'Emotional mood keyword' }
            },
            required: ['id', 'tags', 'caption', 'mood']
          }
        }
      },
      required: ['results']
    };

    const payload = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    };

    const response = await this.request({ payload, timeoutMs: 60000 });
    return response?.results || [];
  }

  /**
   * 5. matchScenes - matches script lines to photos with local fallback
   */
  async matchScenes({ scriptLines, photos }) {
    if (!photos || photos.length === 0) return [];

    try {
      const prompt = `Match each script line to the best matching photo based on visual tags, mood, and context.
STRICT RULES:
1. No photo may repeat more than twice in a row.
2. Starred photos should be given higher priority/weight.
3. If there are more lines than photos, reuse the best matching photos.

PHOTOS AVAILABLE:
${photos.map((p) => `- ID: ${p.id}${p.starred ? ' [STARRED]' : ''} | Mood: ${p.mood || 'neutral'} | Tags: ${(p.tags || []).join(', ')} | Caption: ${p.caption || ''}`).join('\n')}

SCRIPT LINES:
${scriptLines.map((line, idx) => `Line ${idx}: "${line.text}" | Target Visual Tags: ${(line.scene_tags || []).join(', ')}`).join('\n')}`;

      const schema = {
        type: 'OBJECT',
        properties: {
          matches: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                line_index: { type: 'INTEGER' },
                photo_id: { type: 'STRING' },
                confidence: { type: 'STRING', description: 'high, medium, or low' },
                reason: { type: 'STRING' }
              },
              required: ['line_index', 'photo_id', 'confidence']
            }
          }
        },
        required: ['matches']
      };

      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      };

      const result = await this.request({ payload });
      if (result && Array.isArray(result.matches) && result.matches.length === scriptLines.length) {
        return result.matches;
      }
    } catch (err) {
      console.warn('[Gemini] Scene match API failed, running local fallback scoring:', err.message);
    }

    // Local fallback matching
    return this.fallbackMatchScenes(scriptLines, photos);
  }

  /**
   * Local heuristic matcher based on tag overlap, star weighting, and no-repeat rules
   */
  fallbackMatchScenes(scriptLines, photos) {
    const matches = [];
    let prevPhotoId = null;
    let prevRepeatCount = 0;

    scriptLines.forEach((line, idx) => {
      const lineTags = (line.scene_tags || []).map((t) => t.toLowerCase());

      // Score each photo
      let bestPhoto = null;
      let highestScore = -999;

      photos.forEach((photo) => {
        let score = 0;
        const pTags = (photo.tags || []).map((t) => t.toLowerCase());

        // Overlap scoring
        lineTags.forEach((lt) => {
          pTags.forEach((pt) => {
            if (pt.includes(lt) || lt.includes(pt)) score += 3;
          });
        });

        if (photo.starred) score += 2;

        // Penalty if this photo was used in previous line
        if (photo.id === prevPhotoId) {
          if (prevRepeatCount >= 2) {
            score -= 1000; // Strictly forbid 3 in a row
          } else {
            score -= 1.5;
          }
        }

        if (score > highestScore) {
          highestScore = score;
          bestPhoto = photo;
        }
      });

      if (!bestPhoto) {
        bestPhoto = photos[idx % photos.length];
      }

      if (bestPhoto.id === prevPhotoId) {
        prevRepeatCount++;
      } else {
        prevPhotoId = bestPhoto.id;
        prevRepeatCount = 1;
      }

      matches.push({
        line_index: idx,
        photo_id: bestPhoto.id,
        confidence: highestScore > 3 ? 'high' : highestScore > 0 ? 'medium' : 'low',
        reason: 'Matched via visual tag relevance'
      });
    });

    return matches;
  }

  /**
   * 6. thumbnailTexts - suggests 3 short curiosity-gap thumbnail texts (<28 chars)
   */
  async thumbnailTexts({ story, scriptLines = [] }) {
    const summary = (story || scriptLines.map((l) => l.text || l).join(' ')).slice(0, 500);
    const prompt = `Generate exactly 3 short Hindi thumbnail headline texts for this video.
STRICT RULES:
1. Each headline MUST be under 28 characters.
2. Must create an intense curiosity gap (उत्सुकता / रहस्य).
3. Pure Devanagari Hindi with correct nukta.
4. Bold, punchy, click-worthy (e.g. "आखिरी ट्रेन की चाबी!", "1947 का वो बिछड़ना...", "क्या वो कभी मिले?").

STORY SUMMARY:
"""
${summary}
"""`;

    const schema = {
      type: 'OBJECT',
      properties: {
        suggestions: {
          type: 'ARRAY',
          items: { type: 'STRING', description: 'Hindi headline text under 28 chars' }
        }
      },
      required: ['suggestions']
    };

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.8
      }
    };

    const res = await this.request({ payload });
    return res?.suggestions || [];
  }

  /**
   * 7. trendingResearch - search-grounded call (Plain text, no responseSchema)
   */
  async trendingResearch({ topic }) {
    const prompt = `Search Google for currently trending Hindi search queries, viral keywords, and popular YouTube title patterns related to:
"${topic}".
List the top search phrases, emotional hooks, and high-CTR phrasing people are currently searching for in India for historical and emotional stories.`;

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    };

    return this.request({ payload, isSearchTool: true, timeoutMs: 40000 });
  }

  /**
   * 8. generateMetadata - publish pack generation for YouTube & Facebook
   */
  async generateMetadata({ script, language = 'Hindi', tone = 'Emotional', videoType = 'Shorts', niche = '', audience = '', trendingResearch = '' }) {
    const prompt = `Generate YouTube and Facebook publishing metadata for this video script.
${trendingResearch ? `TRENDING SEARCH FINDINGS (use relevant search patterns):\n${trendingResearch}\n` : ''}

STRICT CONSTRAINTS:
1. TITLES:
   - Exactly 5 distinct title options in ${language}.
   - Each title MUST be at most 70 characters.
   - High CTR, curiosity-driven, truthful to script.
2. DESCRIPTION:
   - First 2 lines MUST be an irresistible hook.
   - Concise summary and CTA.
   - End with 3 to 5 hashtags at bottom.
   - No markdown formatting symbols (no asterisks or hash headers).
3. HASHTAGS:
   - 8 to 12 hashtags starting with #.
   ${videoType === 'Shorts' ? '- Must include #Shorts.' : ''}
4. KEYWORD TAGS:
   - Array of strings, combined total characters <= 450 characters.
5. PINNED COMMENT:
   - Engaging question to spark community comments.
6. FACEBOOK:
   - Engaging caption, hook line, exactly 3-5 hashtags, first comment.

SCRIPT:
"""
${script}
"""`;

    const schema = {
      type: 'OBJECT',
      properties: {
        youtube: {
          type: 'OBJECT',
          properties: {
            titles: { type: 'ARRAY', items: { type: 'STRING' } },
            description: { type: 'STRING' },
            hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
            tags: { type: 'ARRAY', items: { type: 'STRING' } },
            pinned_comment: { type: 'STRING' }
          },
          required: ['titles', 'description', 'hashtags', 'tags', 'pinned_comment']
        },
        facebook: {
          type: 'OBJECT',
          properties: {
            caption: { type: 'STRING' },
            hook_line: { type: 'STRING' },
            hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
            first_comment: { type: 'STRING' }
          },
          required: ['caption', 'hook_line', 'hashtags', 'first_comment']
        }
      },
      required: ['youtube', 'facebook']
    };

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    };

    return this.request({ payload });
  }
}
