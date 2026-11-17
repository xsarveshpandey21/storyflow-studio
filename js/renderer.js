/**
 * FrameFlow Studio — Deterministic Canvas Renderer
 * One single renderFrame(t) function used by both live preview and video exporters.
 * Handles Ken Burns math with strict edge clamping, crossfades, 9:16 blurred background layout,
 * film grain, vignette, color grading, and burned-in captions with Devanagari support.
 */

import { countSpokenUnits } from './captions.js';

export class FrameRenderer {
  constructor(extractor) {
    this.extractor = extractor;

    // Offscreen canvas for 9:16 blurred background rendering
    this.blurCanvas = document.createElement('canvas');
    this.blurCtx = this.blurCanvas.getContext('2d');

    // Pre-generated film grain pattern
    this.grainCanvas = document.createElement('canvas');
    this.grainCanvas.width = 256;
    this.grainCanvas.height = 256;
    this.initFilmGrainPattern();
  }

  /**
   * Pre-renders a subtle film grain pattern canvas for high-performance repetition
   */
  initFilmGrainPattern() {
    const ctx = this.grainCanvas.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 50;
      data[i] = 128 + noise;
      data[i + 1] = 128 + noise;
      data[i + 2] = 128 + noise;
      data[i + 3] = 40; // low opacity
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Smooth easeInOutSine easing function
   * @param {number} x Progress 0..1
   * @returns {number}
   */
  easeInOutSine(x) {
    return -(Math.cos(Math.PI * x) - 1) / 2;
  }

  /**
   * Linear interpolation helper
   */
  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Wraps text into lines that fit within a maximum width on the canvas context
   * Supports Devanagari words and Latin words cleanly.
   * @param {CanvasRenderingContext2D} ctx 
   * @param {string} text 
   * @param {number} maxWidth 
   * @param {number} maxLines 
   * @returns {Array<string>}
   */
  wrapText(ctx, text, maxWidth, maxLines = 2) {
    if (!text) return [];
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          if (lines.length >= maxLines - 1) {
            // For the last line, combine remaining words
            const remaining = words.slice(i).join(' ');
            lines.push(remaining);
            return lines.slice(0, maxLines);
          }
        }
        currentLine = word;
      }
    }
    if (currentLine && lines.length < maxLines) {
      lines.push(currentLine);
    }
    return lines.slice(0, maxLines);
  }

  /**
   * Draws a single photo segment with Ken Burns transformation, strictly clamped
   * to guarantee NO empty edges/black bars appear.
   * @param {CanvasRenderingContext2D} ctx 
   * @param {ImageBitmap} img 
   * @param {object} segment 
   * @param {number} t Current time in seconds
   * @param {number} width Canvas width
   * @param {number} height Canvas height
   * @param {object} state Studio settings
   */
  drawSegmentPhoto(ctx, img, segment, t, width, height, state) {
    if (!img || !img.width || !img.height) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Calculate Ken Burns progress across the segment duration
    const startTime = segment?.startTime || 0;
    const endTime = segment?.endTime || (startTime + (segment?.duration || 5));
    const segDuration = Math.max(0.1, endTime - startTime);
    const rawProgress = Math.max(0, Math.min(1, (t - startTime) / segDuration));
    const progress = this.easeInOutSine(rawProgress);

    // 2. Interpolate Zoom and Pan factors
    const maxZoomLimit = state?.maxZoom || 1.25;
    const zoomStart = segment?.zoomStart !== undefined ? segment.zoomStart : 1.0;
    const zoomEnd = segment?.zoomEnd !== undefined ? segment.zoomEnd : maxZoomLimit;
    const currentZoom = this.lerp(zoomStart, zoomEnd, progress);

    const panXStart = segment?.panXStart !== undefined ? segment.panXStart : 0;
    const panXEnd = segment?.panXEnd !== undefined ? segment.panXEnd : 0;
    const panX = this.lerp(panXStart, panXEnd, progress);

    const panYStart = segment?.panYStart !== undefined ? segment.panYStart : 0;
    const panYEnd = segment?.panYEnd !== undefined ? segment.panYEnd : 0;
    const panY = this.lerp(panYStart, panYEnd, progress);

    // 3. Layout checks
    const imgAspect = img.width / img.height;
    const canvasAspect = width / height;
    const isRatioMatch = Math.abs(imgAspect - canvasAspect) / canvasAspect < 0.05;
    const isVerticalCanvas = height > width;
    const isHorizontalPhoto = img.width > img.height;
    const useBlurBg = state?.verticalModeLayout === 'blur-bg' || (isVerticalCanvas && isHorizontalPhoto && !isRatioMatch);

    if (useBlurBg) {
      // Step A: Draw blurred, cover-scaled background
      const bgScale = Math.max(width / img.width, height / img.height) * 1.05;
      const bgW = img.width * bgScale;
      const bgH = img.height * bgScale;
      const bgX = (width - bgW) / 2;
      const bgY = (height - bgH) / 2;

      ctx.save();
      try { ctx.filter = 'blur(28px) brightness(0.65)'; } catch (e) {}
      ctx.drawImage(img, bgX, bgY, bgW, bgH);
      ctx.restore();

      // Step B: Draw sharp foreground photo fitted in center safe zone with subtle Ken Burns motion
      const fitScale = Math.min(width / img.width, (height * 0.78) / img.height);
      const fgZoom = this.lerp(1.0, 1.08, progress);
      const fgTotalScale = fitScale * fgZoom;
      const fgWidth = Math.round(img.width * fgTotalScale);
      const fgHeight = Math.round(img.height * fgTotalScale);
      const fgX = Math.round((width - fgWidth) / 2 + (panX * 12));
      const fgY = Math.round((height - fgHeight) / 2 + (panY * 12));

      ctx.save();
      try { ctx.filter = 'none'; } catch (e) {}
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 30;
      ctx.drawImage(img, fgX, fgY, fgWidth, fgHeight);
      ctx.restore();
      return;
    }

    // Standard Ken Burns: Cover scaling with strict edge-clamping (guarantees no empty edges)
    const baseScale = Math.max(width / img.width, height / img.height);
    const totalScale = baseScale * currentZoom;
    const drawnW = img.width * totalScale;
    const drawnH = img.height * totalScale;

    // Clamping guarantees no empty edges appear:
    const excessX = Math.max(0, drawnW - width);
    const excessY = Math.max(0, drawnH - height);
    const offsetX = ((width - drawnW) / 2) + (panX * (excessX / 2));
    const offsetY = ((height - drawnH) / 2) + (panY * (excessY / 2));

    ctx.drawImage(img, offsetX, offsetY, drawnW, drawnH);
  }

  /**
   * Draws burned-in captions onto the canvas with Devanagari font support,
   * safe margins, outline, background box, and karaoke highlighting
   * @param {CanvasRenderingContext2D} ctx 
   * @param {object} caption Caption chunk object
   * @param {number} t Current timestamp
   * @param {number} width Canvas width
   * @param {number} height Canvas height
   * @param {object} styling Caption styling parameters
   */
  drawCaptions(ctx, caption, t, width, height, styling = {}) {
    if (!caption || !caption.text) return;
    const style = styling || {};

    // Calculate fade in / fade out alpha
    const FADE_DUR = 0.15;
    let alpha = 1.0;
    const timeSinceStart = t - caption.start;
    const timeUntilEnd = caption.end - t;

    if (timeSinceStart < FADE_DUR) {
      alpha = Math.max(0, timeSinceStart / FADE_DUR);
    } else if (timeUntilEnd < FADE_DUR) {
      alpha = Math.max(0, timeUntilEnd / FADE_DUR);
    }

    ctx.save();
    ctx.globalAlpha *= alpha;

    // Setup font
    const fontSize = style.fontSize || 42;
    const fontFamily = style.fontFamily || "'Noto Sans Devanagari', 'Plus Jakarta Sans', sans-serif";
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Maximum safe width for captions (82% of canvas width)
    const maxTextWidth = width * 0.82;
    const lines = this.wrapText(ctx, caption.text, maxTextWidth, 2);
    if (!lines.length) {
      ctx.restore();
      return;
    }

    // Round pixel positions for text so captions stay razor sharp
    const lineHeight = Math.round(fontSize * 1.35);
    const totalBlockHeight = lines.length * lineHeight;

    // Calculate vertical position with safe area margins
    let blockCenterY = Math.round(height * 0.82); // Default bottom safe zone
    if (style.position === 'top') {
      blockCenterY = Math.round(height * 0.15);
    } else if (style.position === 'center') {
      blockCenterY = Math.round(height * 0.50);
    }

    // 9:16 aspect ratio safe margin adjustment (keep away from bottom UI buttons)
    if (width < height && style.position === 'bottom') {
      blockCenterY = Math.round(height * 0.76);
    }

    const startY = Math.round(blockCenterY - (totalBlockHeight / 2) + (lineHeight / 2));

    // Optional Background Box
    if (style.boxEnabled) {
      const boxOpacity = (style.boxOpacity !== undefined ? style.boxOpacity : 65) / 100;
      ctx.fillStyle = `rgba(10, 14, 23, ${boxOpacity})`;

      // Measure max line width for the box
      let maxLineWidth = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxLineWidth) maxLineWidth = w;
      }

      const boxPaddingX = Math.round(fontSize * 0.75);
      const boxPaddingY = Math.round(fontSize * 0.45);
      const boxWidth = Math.round(maxLineWidth + boxPaddingX * 2);
      const boxHeight = Math.round(totalBlockHeight + boxPaddingY * 2);
      const boxX = Math.round((width - boxWidth) / 2);
      const boxY = Math.round(blockCenterY - (totalBlockHeight / 2) - boxPaddingY);
      const radius = 12;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(boxX, boxY, boxWidth, boxHeight, radius);
      } else {
        ctx.rect(boxX, boxY, boxWidth, boxHeight);
      }
      ctx.fill();
    }

    // Word-by-word karaoke highlight timing using spoken unit weighting
    const chunkDuration = Math.max(0.1, caption.end - caption.start);
    const progressInChunk = Math.max(0, Math.min(1, (t - caption.start) / chunkDuration));

    // Draw each line
    for (let li = 0; li < lines.length; li++) {
      const lineText = lines[li];
      const lineY = Math.round(startY + (li * lineHeight));

      // Text Outline / Drop Shadow
      if (style.outlineThickness > 0) {
        ctx.strokeStyle = style.outlineColor || '#000000';
        ctx.lineWidth = style.outlineThickness * 2;
        ctx.lineJoin = 'round';
        ctx.strokeText(lineText, Math.round(width / 2), lineY);
      }

      // Fill Main Text
      ctx.fillStyle = style.textColor || '#ffffff';

      if (style.karaokeEnabled) {
        // Karaoke word highlighting weighted by spoken units (aksharas / syllables)
        const words = lineText.split(' ');
        const wordWeights = words.map((w) => countSpokenUnits(w));
        const totalLineWeight = wordWeights.reduce((a, b) => a + b, 0);

        let accWeight = 0;
        let currentActiveWordIdx = 0;
        for (let wi = 0; wi < words.length; wi++) {
          accWeight += wordWeights[wi];
          if (progressInChunk >= accWeight / totalLineWeight) {
            currentActiveWordIdx = wi + 1;
          }
        }
        currentActiveWordIdx = Math.min(words.length - 1, currentActiveWordIdx);

        // Measure line start position
        const lineWidth = ctx.measureText(lineText).width;
        let cursorX = Math.round((width - lineWidth) / 2);

        ctx.textAlign = 'left';
        for (let wi = 0; wi < words.length; wi++) {
          const w = words[wi];
          const isHighlighted = (wi <= currentActiveWordIdx);

          ctx.fillStyle = isHighlighted
            ? (style.highlightColor || '#fbbf24')
            : (style.textColor || '#ffffff');

          ctx.fillText(w, cursorX, lineY);
          cursorX += Math.round(ctx.measureText(w + ' ').width);
        }
        ctx.textAlign = 'center';
      } else {
        ctx.fillText(lineText, Math.round(width / 2), lineY);
      }
    }

    ctx.restore();
  }

  /**
   * Applies subtle vignette overlay
   */
  drawVignette(ctx, width, height, intensity = 0.35) {
    if (intensity <= 0.01) return;
    ctx.save();
    const radius = Math.max(width, height) * 0.72;
    const grad = ctx.createRadialGradient(
      width / 2, height / 2, radius * 0.35,
      width / 2, height / 2, radius
    );
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, `rgba(0, 0, 0, ${intensity})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /**
   * Applies subtle film grain
   */
  drawFilmGrain(ctx, width, height, intensity = 0.15) {
    if (intensity <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = intensity;
    ctx.globalCompositeOperation = 'overlay';
    const pattern = ctx.createPattern(this.grainCanvas, 'repeat');
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /**
   * THE DETERMINISTIC RENDER FUNCTION
   * Renders the complete frame at timestamp t onto ctx.
   * Both Live Preview and Exporters MUST use this function.
   * @param {number} t Timestamp in seconds
   * @param {CanvasRenderingContext2D} ctx 
   * @param {number} width Canvas width
   * @param {number} height Canvas height
   * @param {object} appState Complete application state
   * @returns {Promise<void>}
   */
  async renderFrame(t, ctx, width, height, appState) {
    if (!ctx || !width || !height) return;
    const state = appState || {};

    // 1. Clear Canvas with deep black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // 2. Query Active Segments from Timeline
    if (!state.timelineEngine || typeof state.timelineEngine.getActiveSegments !== 'function') {
      return;
    }
    const timelineData = state.timelineEngine.getActiveSegments(t);
    const { currentSegment, nextSegment, transitionProgress } = timelineData || {};

    if (!currentSegment) return;

    // Ensure high-quality image smoothing
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Apply Color Grading Filter safely
    const grading = state.colorGrading || {};
    const contrast = 100 + (grading.contrast || 5);
    const saturation = (grading.saturation !== undefined ? grading.saturation : 105);
    try {
      ctx.filter = `contrast(${contrast}%) saturate(${saturation}%)`;
    } catch (e) {}

    // 3. Render Current Segment Photo
    if (this.extractor && typeof this.extractor.getBitmap === 'function' && currentSegment.photo) {
      const currentImg = await this.extractor.getBitmap(currentSegment.photo);
      if (currentImg) {
        this.drawSegmentPhoto(ctx, currentImg, currentSegment, t, width, height, state);
      }
    }

    // 4. Render Crossfade / Transition if active
    if (nextSegment && transitionProgress > 0 && state.transitionType !== 'none') {
      if (this.extractor && typeof this.extractor.getBitmap === 'function' && nextSegment.photo) {
        const nextImg = await this.extractor.getBitmap(nextSegment.photo);
        if (nextImg) {
          ctx.save();
          if (state.transitionType === 'dip-to-black') {
            const blackAlpha = (transitionProgress < 0.5)
              ? transitionProgress * 2
              : (1 - transitionProgress) * 2;
            ctx.fillStyle = `rgba(0, 0, 0, ${blackAlpha})`;
            ctx.fillRect(0, 0, width, height);
            if (transitionProgress >= 0.5) {
              ctx.globalAlpha = (transitionProgress - 0.5) * 2;
              this.drawSegmentPhoto(ctx, nextImg, nextSegment, t, width, height, state);
            }
          } else {
            // Smooth Crossfade
            ctx.globalAlpha = transitionProgress;
            this.drawSegmentPhoto(ctx, nextImg, nextSegment, t, width, height, state);
          }
          ctx.restore();
        }
      }
    }

    // Reset Filter for overlays and text
    try {
      ctx.filter = 'none';
    } catch (e) {}

    // 5. Cinematic Overlays: Vignette & Film Grain
    const overlays = state.overlays || {};
    this.drawVignette(ctx, width, height, (overlays.vignette !== undefined ? overlays.vignette : 35) / 100);
    this.drawFilmGrain(ctx, width, height, (overlays.filmGrain !== undefined ? overlays.filmGrain : 15) / 100);

    // 6. Burned-in Captions
    if (state.captionEngine && typeof state.captionEngine.getCaptionAtTime === 'function') {
      const activeCaption = state.captionEngine.getCaptionAtTime(t);
      if (activeCaption) {
        this.drawCaptions(ctx, activeCaption, t, width, height, state.captionStyle);
      }
    }
  }
}
