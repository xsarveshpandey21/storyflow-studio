/**
 * FrameFlow Studio — Script & Caption Processing Engine
 * Splits Hindi and English text cleanly (respecting '।' and punctuation),
 * aligns chunks proportionally with silence-gap snapping, and exports to SRT/VTT/TXT.
 */

/**
 * Counts spoken syllable-like units:
 * For Hindi (Devanagari), counts aksharas (base consonants & independent vowels),
 * ignoring punctuation, matras, viramas, and spaces.
 * For English/Latin, counts syllables/words.
 * @param {string} text 
 * @returns {number}
 */
export function countSpokenUnits(text) {
  if (!text) return 1;
  // 1. Devanagari aksharas (consonants and independent vowels)
  const devanagariMatches = text.match(/[\u0904-\u0939\u0958-\u0961]/g);
  const devanagariCount = devanagariMatches ? devanagariMatches.length : 0;

  // 2. English / Latin words and syllables
  const nonDevanagari = text.replace(/[\u0900-\u097F]/g, ' ');
  const words = nonDevanagari.match(/[a-zA-Z0-9]+/g) || [];
  let latinSyllables = 0;
  for (const w of words) {
    const vowelMatches = w.toLowerCase().replace(/e$/, '').match(/[aeiouy]{1,2}/g);
    latinSyllables += Math.max(1, vowelMatches ? vowelMatches.length : 1);
  }

  const baseUnits = devanagariCount + latinSyllables;
  return Math.max(1, baseUnits);
}

/**
 * Calculates sentence weight considering spoken units and pause length:
 * longer pause after '।', '.', '?', '!' than after commas/semicolons.
 * @param {string} sentence 
 * @returns {number}
 */
export function getSentenceWeight(sentence) {
  const units = countSpokenUnits(sentence);
  let pauseWeight = 0;
  if (/[।\.\?!]/.test(sentence)) {
    pauseWeight = 2.0; // longer pause after full stops / danda / questions / exclamations
  } else if (/[,;،]/.test(sentence)) {
    pauseWeight = 0.8; // shorter pause after commas
  }
  return units + pauseWeight;
}

/**
 * Detects the speech region from an AudioBuffer using ~20ms RMS windows, skipping silence
 * @param {AudioBuffer} audioBuffer 
 * @param {number} silenceThreshold 
 * @returns {{ start: number, end: number }|null}
 */
export function detectSpeechRegionFromBuffer(audioBuffer, silenceThreshold = 0.015) {
  if (!audioBuffer) return null;
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const windowSize = Math.floor(sampleRate * 0.02); // 20ms
  const hopSize = Math.floor(sampleRate * 0.01);     // 10ms
  const total = channelData.length;

  let firstSpeech = -1;
  let lastSpeech = -1;

  for (let i = 0; i <= total - windowSize; i += hopSize) {
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const v = channelData[i + j];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    if (rms >= silenceThreshold) {
      const t = i / sampleRate;
      if (firstSpeech < 0) firstSpeech = t;
      lastSpeech = t + (windowSize / sampleRate);
    }
  }

  if (firstSpeech < 0) return null;
  return {
    start: Math.max(0, firstSpeech - 0.05),
    end: Math.min(audioBuffer.duration, lastSpeech + 0.05)
  };
}

export class CaptionEngine {
  constructor() {
    this.scriptText = '';
    this.chunks = []; // Array<{ id, text, start, end, duration }>
  }

  /**
   * Splits a script into sentence chunks respecting Hindi Danda '।', '.', '?', '!', newlines,
   * and caps chunk length to ~90 characters by splitting at commas or spaces.
   * @param {string} text 
   * @returns {Array<string>}
   */
  splitScriptIntoSentences(text) {
    if (!text || !text.trim()) return [];

    // Split on Hindi Danda '।', '.', '?', '!', '\n', '\r'
    const rawSentences = text
      .split(/([।\.\?!;\n\r]+)/g)
      .reduce((acc, part, idx, arr) => {
        if (idx % 2 === 0) {
          const punctuation = arr[idx + 1] || '';
          const fullSentence = (part + punctuation).trim();
          if (fullSentence) acc.push(fullSentence);
        }
        return acc;
      }, []);

    const chunks = [];
    const MAX_CHUNK_CHARS = 90;

    for (const sentence of rawSentences) {
      if (sentence.length <= MAX_CHUNK_CHARS) {
        chunks.push(sentence);
      } else {
        // Sentence is too long, split further by commas or word boundaries
        const subParts = sentence.split(/([,،\s]+)/g);
        let currentChunk = '';

        for (const token of subParts) {
          if ((currentChunk + token).length <= MAX_CHUNK_CHARS) {
            currentChunk += token;
          } else {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = token.trimStart();
          }
        }
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
      }
    }

    return chunks;
  }



  /**
   * Speech-aware caption alignment with spoken-unit weighting and silence snapping.
   * Uses real voice audio when available to detect true speech bounds.
   * @param {Array<string>} rawSentences 
   * @param {number} totalDuration Duration in seconds
   * @param {Array<{start: number, end: number, mid: number}>} silenceGaps 
   * @param {AudioBuffer} [audioBuffer]
   * @returns {Array<object>}
   */
  alignCaptionsWithAudio(rawSentences, totalDuration, silenceGaps = [], audioBuffer = null) {
    if (!rawSentences || !rawSentences.length) return [];
    const safeDuration = Math.max(1, totalDuration || 10);

    // Respect manual edits if present and chunk count matches
    const hasManualEdits = this.chunks && this.chunks.length === rawSentences.length && this.chunks.some((c) => c.isManuallyEdited);
    if (hasManualEdits) {
      const allTextMatch = this.chunks.every((c, idx) => c.text.trim() === rawSentences[idx].trim());
      if (allTextMatch) {
        return this.chunks;
      }
    }

    let speechStart = 0;
    let speechEnd = safeDuration;

    if (audioBuffer) {
      const region = detectSpeechRegionFromBuffer(audioBuffer);
      if (region && region.end > region.start + 0.5) {
        speechStart = Math.min(region.start, safeDuration - 0.5);
        speechEnd = Math.min(region.end, safeDuration);
      }
    }

    const speechDuration = Math.max(0.5, speechEnd - speechStart);

    // Calculate spoken unit weights (Hindi aksharas, English syllables, pause lengths)
    const weights = rawSentences.map((s) => getSentenceWeight(s));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    const chunks = [];
    let cumulativeWeight = 0;

    for (let i = 0; i < rawSentences.length; i++) {
      const sentence = rawSentences[i];
      const w = weights[i];

      const rawStart = speechStart + (cumulativeWeight / totalWeight) * speechDuration;
      cumulativeWeight += w;
      const rawEnd = speechStart + (cumulativeWeight / totalWeight) * speechDuration;

      chunks.push({
        id: `cap_${i + 1}`,
        index: i + 1,
        text: sentence,
        start: rawStart,
        end: rawEnd,
        duration: Math.max(0.2, rawEnd - rawStart),
        isManuallyEdited: false
      });
    }

    // Snap every sentence boundary to the nearest real silence gap (widen tolerance to ~2s)
    // and keep boundaries strictly increasing
    if (silenceGaps && silenceGaps.length > 0) {
      const SNAP_TOLERANCE_SEC = 2.0;

      for (let i = 0; i < chunks.length - 1; i++) {
        const boundaryTime = chunks[i].end;
        let closestGap = null;
        let minDiff = SNAP_TOLERANCE_SEC;

        for (const gap of silenceGaps) {
          const diff = Math.abs(gap.mid - boundaryTime);
          if (diff < minDiff) {
            minDiff = diff;
            closestGap = gap;
          }
        }

        if (closestGap) {
          const minAllowed = chunks[i].start + 0.25;
          const maxAllowed = (chunks[i + 1].end || safeDuration) - 0.25;
          if (minAllowed < maxAllowed) {
            const snappedTime = Math.max(minAllowed, Math.min(maxAllowed, closestGap.mid));
            chunks[i].end = snappedTime;
            chunks[i].duration = chunks[i].end - chunks[i].start;
            chunks[i + 1].start = snappedTime;
            chunks[i + 1].duration = chunks[i + 1].end - chunks[i + 1].start;
          }
        }
      }
    }

    // Ensure boundaries are strictly increasing
    for (let i = 0; i < chunks.length - 1; i++) {
      if (chunks[i].end > chunks[i + 1].start) {
        const mid = (chunks[i].start + chunks[i + 1].end) / 2;
        chunks[i].end = mid;
        chunks[i].duration = Math.max(0.1, chunks[i].end - chunks[i].start);
        chunks[i + 1].start = mid;
        chunks[i + 1].duration = Math.max(0.1, chunks[i + 1].end - chunks[i + 1].start);
      }
    }

    // Ensure first caption starts at 0 if no audioBuffer or leading silence is negligible
    if (chunks.length > 0 && (!audioBuffer || speechStart < 0.1)) {
      chunks[0].start = 0;
      chunks[0].duration = chunks[0].end - chunks[0].start;
    }

    // Ensure last chunk ends at safeDuration
    if (chunks.length > 0) {
      chunks[chunks.length - 1].end = safeDuration;
      chunks[chunks.length - 1].duration = Math.max(0.4, safeDuration - chunks[chunks.length - 1].start);
    }

    this.chunks = chunks;
    return chunks;
  }

  /**
   * Validates that the concatenation of all caption chunks matches the normalized script text.
   * If any mismatch is found, logs it and repairs the chunks automatically.
   * @param {string} scriptText 
   * @returns {boolean} True if matched, false if repaired
   */
  verifyAndFixScriptIntegrity(scriptText) {
    if (!scriptText || !scriptText.trim()) return true;
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const normalizedScript = normalize(scriptText);
    const chunkConcat = normalize((this.chunks || []).map((c) => c.text).join(' '));

    if (normalizedScript !== chunkConcat) {
      console.warn('[Captions] Integrity mismatch: chunks do not match script text. Auto-fixing.');
      const sentences = this.splitScriptIntoSentences(scriptText);
      const totalDur = (this.chunks && this.chunks.length > 0) ? this.chunks[this.chunks.length - 1].end : 10;
      this.alignCaptionsWithAudio(sentences, totalDur);
      return false;
    }
    return true;
  }

  /**
   * Returns active caption chunk at given time t
   * @param {number} t Time in seconds
   * @returns {object|null}
   */
  getCaptionAtTime(t) {
    if (!this.chunks || !this.chunks.length) return null;
    return this.chunks.find((c) => t >= c.start && t <= c.end) || null;
  }

  /**
   * Formats seconds into SRT timestamp format: HH:MM:SS,mmm
   * @param {number} seconds 
   * @returns {string}
   */
  formatSrtTimestamp(seconds) {
    const s = Math.max(0, seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    const millis = Math.floor((s % 1) * 1000);

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
  }

  /**
   * Formats seconds into VTT timestamp format: HH:MM:SS.mmm
   * @param {number} seconds 
   * @returns {string}
   */
  formatVttTimestamp(seconds) {
    return this.formatSrtTimestamp(seconds).replace(',', '.');
  }

  /**
   * Generates SubRip (.srt) subtitle content
   * @param {Array<object>} [customChunks]
   * @returns {string}
   */
  generateSRT(customChunks = null) {
    const items = customChunks || this.chunks;
    return items
      .map((item, idx) => {
        const start = this.formatSrtTimestamp(item.start);
        const end = this.formatSrtTimestamp(item.end);
        return `${idx + 1}\n${start} --> ${end}\n${item.text.trim()}\n`;
      })
      .join('\n');
  }

  /**
   * Generates WebVTT (.vtt) subtitle content
   * @param {Array<object>} [customChunks]
   * @returns {string}
   */
  generateVTT(customChunks = null) {
    const items = customChunks || this.chunks;
    const body = items
      .map((item) => {
        const start = this.formatVttTimestamp(item.start);
        const end = this.formatVttTimestamp(item.end);
        return `${start} --> ${end}\n${item.text.trim()}\n`;
      })
      .join('\n');
    return `WEBVTT - FrameFlow Studio Captions\n\n${body}`;
  }

  /**
   * Generates clean script text (.txt)
   * @param {Array<object>} [customChunks]
   * @returns {string}
   */
  generateTXT(customChunks = null) {
    const items = customChunks || this.chunks;
    return items.map((c) => c.text.trim()).join('\n');
  }

  /**
   * Triggers a browser file download of caption text
   * @param {string} content 
   * @param {string} filename 
   * @param {string} mimeType 
   */
  downloadFile(content, filename, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
