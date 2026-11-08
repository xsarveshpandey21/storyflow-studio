/**
 * StoryFlow Studio — Validators & Text Analysis Engine
 * Provides word budget estimation, retention warnings, publish pack validation,
 * and resilient JSON parsing for Gemini responses.
 */

export const WORDS_PER_SECOND = 2.4;

/**
 * Calculates word count of a string (Devanagari, Latin, or mixed)
 * @param {string} text 
 * @returns {number}
 */
export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimates spoken duration in seconds
 * @param {string} text 
 * @returns {number}
 */
export function estimateDuration(text) {
  const words = countWords(text);
  return Number((words / WORDS_PER_SECOND).toFixed(1));
}

/**
 * Retention Meter analysis for a single script line.
 * Flags lines over 9 seconds or over 25 words.
 * @param {string} lineText 
 * @returns {{ words: number, seconds: number, isWarning: boolean, reasons: string[] }}
 */
export function analyzeRetentionLine(lineText) {
  const words = countWords(lineText);
  const seconds = estimateDuration(lineText);
  const reasons = [];

  if (seconds > 9.0) {
    reasons.push(`Too long for spoken flow (${seconds}s > 9s)`);
  }
  if (words > 25) {
    reasons.push(`High word density (${words} words > 25 words)`);
  }

  return {
    words,
    seconds,
    isWarning: reasons.length > 0,
    reasons
  };
}

/**
 * Checks if total script word budget is within 10% of target
 * @param {Array<string>} scriptLines 
 * @param {number} targetSeconds 
 * @returns {{ targetWords: number, actualWords: number, deltaPercent: number, isWithinBudget: boolean }}
 */
export function checkWordBudget(scriptLines, targetSeconds = 75) {
  const totalWords = (scriptLines || []).reduce((acc, line) => acc + countWords(line), 0);
  const targetWords = Math.round(targetSeconds * WORDS_PER_SECOND);
  const delta = Math.abs(totalWords - targetWords);
  const deltaPercent = (delta / (targetWords || 1)) * 100;
  const isWithinBudget = deltaPercent <= 10.0;

  return {
    targetWords,
    actualWords: totalWords,
    deltaPercent: Number(deltaPercent.toFixed(1)),
    isWithinBudget
  };
}

/**
 * Validates YouTube & Facebook publish pack metadata
 * Rules:
 * - Each title <= 70 characters
 * - Total tags <= 450 characters
 * - Hashtags valid format (#tag)
 * - Facebook hashtags count between 3 and 5
 * @param {object} meta 
 * @param {string} [videoType='Shorts']
 * @returns {{ isValid: boolean, errors: string[] }}
 */
export function validatePublishPack(meta, videoType = 'Shorts') {
  const errors = [];

  // 1. Titles validation
  const titles = meta?.youtube?.titles || meta?.titles || [];
  if (!Array.isArray(titles) || titles.length === 0) {
    errors.push('At least 1 title is required');
  } else {
    titles.forEach((t, idx) => {
      if (typeof t !== 'string' || t.trim().length === 0) {
        errors.push(`Title #${idx + 1} is empty`);
      } else if (t.length > 70) {
        errors.push(`Title #${idx + 1} exceeds 70 characters (${t.length} chars)`);
      }
    });
  }

  // 2. Keyword tags validation
  const tags = meta?.youtube?.tags || meta?.tags || [];
  const tagsList = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  const combinedTagsStr = tagsList.map(t => t.trim()).join(', ');
  if (combinedTagsStr.length > 450) {
    errors.push(`Total keyword tags exceed 450 characters limit (${combinedTagsStr.length} chars)`);
  }

  // 3. Hashtags validation
  const hashtags = meta?.youtube?.hashtags || meta?.hashtags || [];
  if (Array.isArray(hashtags)) {
    hashtags.forEach((h, idx) => {
      const cleanH = (h || '').trim();
      if (!cleanH.startsWith('#')) {
        errors.push(`Hashtag #${idx + 1} ("${cleanH}") must start with '#'`);
      } else if (/\s/.test(cleanH)) {
        errors.push(`Hashtag #${idx + 1} ("${cleanH}") must not contain spaces`);
      }
    });
  }

  // 4. Facebook hashtags count
  const fbHashtags = meta?.facebook?.hashtags || [];
  if (Array.isArray(fbHashtags)) {
    if (fbHashtags.length < 3 || fbHashtags.length > 5) {
      errors.push(`Facebook requires exactly 3 to 5 hashtags (found ${fbHashtags.length})`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Resilient JSON parsing fallback for raw LLM text
 * @param {string} rawText 
 * @returns {any}
 */
export function parseGeminiJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty response content');
  }

  let cleaned = rawText.trim();
  // Strip Markdown code fences ```json ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Attempt to extract the first { ... } or [ ... ] block
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = cleaned.substring(firstBrace, lastBrace + 1);
      return JSON.parse(slice);
    }
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const slice = cleaned.substring(firstBracket, lastBracket + 1);
      return JSON.parse(slice);
    }
    throw new Error(`Failed to parse JSON: ${e1.message}`);
  }
}
