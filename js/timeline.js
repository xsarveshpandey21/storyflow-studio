/**
 * FrameFlow Studio — Timeline & Animation Scheduler
 * Schedules photo segments across the target video duration,
 * assigns Ken Burns animation parameters, ensures no consecutive photo repeats,
 * gives starred photos higher weight, and manages transition overlaps.
 */

export class TimelineEngine {
  constructor() {
    this.segments = []; // Array<{ id, photoItem, startTime, endTime, duration, animType, zoomStart, zoomEnd, panX, panY }>
    this.totalDuration = 60; // seconds
    this.transitionDuration = 0.6; // seconds
    this.transitionType = 'crossfade'; // 'crossfade' | 'dip-to-black' | 'slide'
    this.seed = Date.now();
  }

  /**
   * Builds the photo segment timeline
   * @param {Array<object>} photos Extracted photo list
   * @param {number} totalDuration Target duration in seconds
   * @param {object} options
   * @param {number} options.minDuration Min seconds per photo (default 4)
   * @param {number} options.maxDuration Max seconds per photo (default 8)
   * @param {Array<string>} options.enabledAnimations List of enabled animation types
   * @param {number} options.maxZoom Max zoom factor (default 1.25)
   * @param {number} options.transitionDuration Transition overlap in seconds (default 0.6)
   * @param {string} options.transitionType
   * @returns {Array<object>}
   */
  generateTimeline(photos, totalDuration, options = {}) {
    if (!photos || photos.length === 0) {
      this.segments = [];
      return [];
    }

    const {
      minDuration = 4.0,
      maxDuration = 8.0,
      enabledAnimations = ['zoom-in', 'zoom-out', 'pan-lr', 'pan-rl', 'pan-up', 'pan-down', 'diagonal'],
      maxZoom = 1.25,
      transitionDuration = 0.6,
      transitionType = 'crossfade'
    } = options;

    this.totalDuration = Math.max(1, totalDuration);
    this.transitionDuration = Math.min(transitionDuration, minDuration * 0.4);
    this.transitionType = transitionType;

    const animPool = enabledAnimations.length > 0
      ? enabledAnimations
      : ['zoom-in', 'zoom-out'];

    // Weighted photo pool: starred photos get 2.5x more entries
    const weightedPool = [];
    photos.forEach((photo) => {
      const weight = photo.starred ? 3 : 1;
      for (let w = 0; w < weight; w++) {
        weightedPool.push(photo);
      }
    });

    const segments = [];
    let currentTime = 0;
    let lastPhotoId = null;
    let segIdx = 0;

    // Helper to shuffle an array
    const shuffle = (arr) => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };

    let currentDeck = shuffle(weightedPool);

    while (currentTime < this.totalDuration) {
      if (currentDeck.length === 0) {
        currentDeck = shuffle(weightedPool);
      }

      // Pick next photo, ensuring no consecutive duplicates if more than 1 photo exists
      let chosenPhoto = null;
      if (photos.length > 1) {
        let deckIndex = currentDeck.findIndex((p) => p.id !== lastPhotoId);
        if (deckIndex === -1) {
          // If only identical photos left in currentDeck, pick from full pool
          const available = photos.filter((p) => p.id !== lastPhotoId);
          chosenPhoto = available[Math.floor(Math.random() * available.length)];
        } else {
          chosenPhoto = currentDeck.splice(deckIndex, 1)[0];
        }
      } else {
        chosenPhoto = photos[0];
      }

      lastPhotoId = chosenPhoto.id;

      // Random duration between minDuration and maxDuration
      let dur = minDuration + Math.random() * (maxDuration - minDuration);
      
      // If near end of timeline, adjust
      const remainingTime = this.totalDuration - currentTime;
      if (remainingTime <= maxDuration * 1.2) {
        dur = remainingTime;
      }

      dur = Math.max(minDuration * 0.5, dur);

      // Assign random animation from enabled pool
      const animType = animPool[Math.floor(Math.random() * animPool.length)];

      // Configure animation zoom and pan vectors
      let zoomStart = 1.0;
      let zoomEnd = 1.0;
      let panXStart = 0;
      let panXEnd = 0;
      let panYStart = 0;
      let panYEnd = 0;

      switch (animType) {
        case 'zoom-in':
          zoomStart = 1.0;
          zoomEnd = maxZoom;
          break;
        case 'zoom-out':
          zoomStart = maxZoom;
          zoomEnd = 1.0;
          break;
        case 'pan-lr':
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panXStart = -1.0;
          panXEnd = 1.0;
          break;
        case 'pan-rl':
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panXStart = 1.0;
          panXEnd = -1.0;
          break;
        case 'pan-up':
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panYStart = 1.0;
          panYEnd = -1.0;
          break;
        case 'pan-down':
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panYStart = -1.0;
          panYEnd = 1.0;
          break;
        case 'diagonal':
          zoomStart = 1.08;
          zoomEnd = maxZoom;
          panXStart = -0.8;
          panXEnd = 0.8;
          panYStart = -0.8;
          panYEnd = 0.8;
          break;
        default:
          zoomStart = 1.0;
          zoomEnd = maxZoom;
      }

      const segment = {
        id: `seg_${segIdx++}`,
        photo: chosenPhoto,
        startTime: currentTime,
        endTime: currentTime + dur,
        duration: dur,
        animType,
        zoomStart,
        zoomEnd,
        panXStart,
        panXEnd,
        panYStart,
        panYEnd
      };

      segments.push(segment);
      currentTime += dur;
    }

    this.segments = segments;
    return segments;
  }

  /**
   * Helper to compute Ken Burns zoom and pan parameters
   */
  computeAnimParams(animType, maxZoom = 1.25) {
    let zoomStart = 1.0;
    let zoomEnd = 1.0;
    let panXStart = 0;
    let panXEnd = 0;
    let panYStart = 0;
    let panYEnd = 0;

    switch (animType) {
      case 'zoom-in':
        zoomStart = 1.0;
        zoomEnd = maxZoom;
        break;
      case 'zoom-out':
        zoomStart = maxZoom;
        zoomEnd = 1.0;
        break;
      case 'pan-lr':
        zoomStart = maxZoom;
        zoomEnd = maxZoom;
        panXStart = -1.0;
        panXEnd = 1.0;
        break;
      case 'pan-rl':
        zoomStart = maxZoom;
        zoomEnd = maxZoom;
        panXStart = 1.0;
        panXEnd = -1.0;
        break;
      case 'pan-up':
        zoomStart = maxZoom;
        zoomEnd = maxZoom;
        panYStart = 1.0;
        panYEnd = -1.0;
        break;
      case 'pan-down':
        zoomStart = maxZoom;
        zoomEnd = maxZoom;
        panYStart = -1.0;
        panYEnd = 1.0;
        break;
      case 'diagonal':
        zoomStart = 1.08;
        zoomEnd = maxZoom;
        panXStart = -0.8;
        panXEnd = 0.8;
        panYStart = -0.8;
        panYEnd = 0.8;
        break;
      default:
        zoomStart = 1.0;
        zoomEnd = maxZoom;
    }

    return { zoomStart, zoomEnd, panXStart, panXEnd, panYStart, panYEnd };
  }

  /**
   * Generates a timeline strictly based on Scene Match assignments and script line / audio durations.
   * Ensures different Ken Burns animation directions when photos are reused.
   * @param {Array<object>} photos 
   * @param {Array<string|object>} scriptLines Array of strings or { text, estimatedSeconds }
   * @param {Array<object>} sceneMatches Array of { line_index, photo_id }
   * @param {number} totalDuration Target video duration in seconds
   * @param {Array<object>} captionChunks Optional aligned caption chunks with { start, end, text }
   * @param {object} options
   */
  generateSceneMatchedTimeline(photos, scriptLines, sceneMatches, totalDuration, captionChunks = null, options = {}) {
    if (!photos || photos.length === 0) {
      this.segments = [];
      return [];
    }

    if (!scriptLines || scriptLines.length === 0 || !sceneMatches || sceneMatches.length === 0) {
      return this.generateTimeline(photos, totalDuration, options);
    }

    const {
      enabledAnimations = ['zoom-in', 'zoom-out', 'pan-lr', 'pan-rl', 'pan-up', 'pan-down', 'diagonal'],
      maxZoom = 1.25,
      transitionDuration = 0.6,
      transitionType = 'crossfade'
    } = options;

    const animPool = enabledAnimations.length > 0
      ? enabledAnimations
      : ['zoom-in', 'zoom-out'];

    const photoMap = new Map();
    photos.forEach((p) => photoMap.set(p.id, p));

    // Determine duration for each line
    const lineDurations = [];
    let sumEstimated = 0;

    scriptLines.forEach((line, idx) => {
      let dur = 0;
      if (captionChunks && captionChunks[idx] && captionChunks[idx].end > captionChunks[idx].start) {
        dur = captionChunks[idx].end - captionChunks[idx].start;
      } else {
        const text = typeof line === 'string' ? line : (line.text || '');
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        dur = Math.max(2.5, wordCount / 2.4);
      }
      lineDurations.push(dur);
      sumEstimated += dur;
    });

    // If totalDuration is provided and audio chunks weren't explicitly used, scale proportionally
    const scaleFactor = (totalDuration && (!captionChunks || captionChunks.length === 0))
      ? totalDuration / sumEstimated
      : 1.0;

    this.totalDuration = totalDuration || sumEstimated;
    this.transitionDuration = Math.min(transitionDuration, 1.5);
    this.transitionType = transitionType;

    const segments = [];
    let currentTime = 0;
    const photoAnimCounters = new Map(); // photoId -> count of times used, to rotate anims

    scriptLines.forEach((line, idx) => {
      const match = sceneMatches.find((m) => m.line_index === idx);
      let photoId = match?.photo_id;
      let photo = photoMap.get(photoId);

      if (!photo) {
        photo = photos[idx % photos.length];
        photoId = photo.id;
      }

      // Rotate animation direction for reused photos
      const timesUsed = photoAnimCounters.get(photoId) || 0;
      photoAnimCounters.set(photoId, timesUsed + 1);

      const animIdx = (idx + timesUsed) % animPool.length;
      const animType = animPool[animIdx];
      const animParams = this.computeAnimParams(animType, maxZoom);

      let dur = lineDurations[idx] * scaleFactor;
      if (idx === scriptLines.length - 1 && totalDuration) {
        // Clamp last segment to exactly totalDuration
        dur = Math.max(1.0, totalDuration - currentTime);
      }

      const segment = {
        id: `seg_${idx}`,
        photo,
        lineIndex: idx,
        lineText: typeof line === 'string' ? line : (line.text || ''),
        startTime: currentTime,
        endTime: currentTime + dur,
        duration: dur,
        animType,
        ...animParams
      };

      segments.push(segment);
      currentTime += dur;
    });

    this.segments = segments;
    this.totalDuration = currentTime;
    return segments;
  }

  /**
   * Finds the active photo segment(s) at time t, including crossfade overlap
   * @param {number} t Time in seconds
   * @returns {{ currentSegment: object|null, nextSegment: object|null, transitionProgress: number }}
   */
  getActiveSegments(t) {
    if (!this.segments || this.segments.length === 0) {
      return { currentSegment: null, nextSegment: null, transitionProgress: 0 };
    }

    const clampedT = Math.max(0, Math.min(t, this.totalDuration));

    // Find current segment
    let curIdx = this.segments.findIndex((s) => clampedT >= s.startTime && clampedT < s.endTime);
    if (curIdx === -1) {
      curIdx = this.segments.length - 1;
    }

    const curSeg = this.segments[curIdx];
    let nextSeg = null;
    let transProgress = 0;

    // Check if we are inside transition window near end of segment
    const timeUntilEnd = curSeg.endTime - clampedT;
    if (timeUntilEnd <= this.transitionDuration && curIdx + 1 < this.segments.length) {
      nextSeg = this.segments[curIdx + 1];
      transProgress = 1.0 - (timeUntilEnd / this.transitionDuration);
      transProgress = Math.max(0, Math.min(1, transProgress));
    }

    return {
      currentSegment: curSeg,
      nextSegment: nextSeg,
      transitionProgress: transProgress
    };
  }
}
