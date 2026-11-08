/**
 * FrameFlow Studio — Video Frame Extraction & Sampling Engine
 * Performs stratified random frame sampling per minute,
 * quality filtering (near-black/white + duplicate rejection),
 * memory-safe JPEG Blob storage, and an LRU ImageBitmap cache.
 */

export class FrameExtractor {
  constructor(videoElement, offscreenCanvas) {
    this.video = videoElement;
    this.canvas = offscreenCanvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    this.ctx = this.canvas ? this.canvas.getContext('2d', { willReadFrequently: true }) : null;
    
    // Tiny canvas for fast 32x18 thumbnail quality comparison
    if (typeof document !== 'undefined') {
      this.thumbCanvas = document.createElement('canvas');
      this.thumbCanvas.width = 32;
      this.thumbCanvas.height = 18;
      this.thumbCtx = this.thumbCanvas.getContext('2d', { willReadFrequently: true });
    } else {
      this.thumbCanvas = null;
      this.thumbCtx = null;
    }

    this.isExtracting = false;
    this.cancelRequested = false;

    // LRU Cache for rendered ImageBitmaps (max 30 in memory)
    this.lruCapacity = 30;
    this.bitmapCache = new Map(); // id -> ImageBitmap
  }

  /**
   * Resets and closes all cached ImageBitmaps to free GPU/RAM memory
   */
  clearCache() {
    for (const [id, bmp] of this.bitmapCache.entries()) {
      if (bmp && typeof bmp.close === 'function') {
        bmp.close();
      }
    }
    this.bitmapCache.clear();
  }

  /**
   * Retrieves an ImageBitmap for a frame, using the LRU cache
   * @param {object} frameItem 
   * @returns {Promise<ImageBitmap>}
   */
  async getBitmap(frameItem) {
    if (!frameItem || !frameItem.blob) return null;

    if (this.bitmapCache.has(frameItem.id)) {
      const bmp = this.bitmapCache.get(frameItem.id);
      // Refresh order for LRU
      this.bitmapCache.delete(frameItem.id);
      this.bitmapCache.set(frameItem.id, bmp);
      return bmp;
    }

    // Create new bitmap lazily from Blob
    const bmp = await createImageBitmap(frameItem.blob);

    // Evict oldest if exceeding capacity
    if (this.bitmapCache.size >= this.lruCapacity) {
      const oldestKey = this.bitmapCache.keys().next().value;
      const oldBmp = this.bitmapCache.get(oldestKey);
      if (oldBmp && typeof oldBmp.close === 'function') {
        oldBmp.close();
      }
      this.bitmapCache.delete(oldestKey);
    }

    this.bitmapCache.set(frameItem.id, bmp);
    return bmp;
  }

  /**
   * Creates an object URL for previewing, and tracks it for revocation
   * @param {Blob} blob 
   * @returns {string}
   */
  createBlobUrl(blob) {
    return URL.createObjectURL(blob);
  }

  /**
   * Revokes a created Blob URL
   * @param {string} url 
   */
  revokeBlobUrl(url) {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Generates stratified random sample timestamps across the video duration
   * @param {number} duration Duration in seconds
   * @param {number} minPhotos Min photos per minute (default 15)
   * @param {number} maxPhotos Max photos per minute (default 20)
   * @returns {Array<{minuteIdx: number, slotIdx: number, slotStart: number, slotEnd: number, targetTime: number}>}
   */
  generateSamplingSchedule(duration, minPhotos = 15, maxPhotos = 20) {
    const schedule = [];
    const totalMinutes = Math.ceil(duration / 60);

    for (let m = 0; m < totalMinutes; m++) {
      const minuteStart = m * 60;
      const minuteEnd = Math.min((m + 1) * 60, duration);
      const minuteDuration = minuteEnd - minuteStart;
      if (minuteDuration <= 0.2) continue;

      // Random N for this minute
      const randomN = Math.floor(minPhotos + Math.random() * (maxPhotos - minPhotos + 1));
      
      // If partial minute, scale N proportionally
      const effectiveN = (minuteDuration < 60)
        ? Math.max(1, Math.round(randomN * (minuteDuration / 60)))
        : randomN;

      const slotDuration = minuteDuration / effectiveN;

      for (let s = 0; s < effectiveN; s++) {
        const slotStart = minuteStart + s * slotDuration;
        const slotEnd = minuteStart + (s + 1) * slotDuration;
        // Pick one random timestamp inside slot, avoiding the very edge by 0.05s
        const t = slotStart + 0.05 + Math.random() * Math.max(0.01, slotDuration - 0.1);
        const clampedT = Math.min(duration - 0.05, Math.max(0.05, t));

        schedule.push({
          minuteIdx: m,
          slotIdx: s,
          slotStart,
          slotEnd,
          targetTime: clampedT
        });
      }
    }

    return schedule;
  }

  /**
   * Seeks the hidden video to a timestamp safely
   * @param {number} timeSeconds 
   * @returns {Promise<void>}
   */
  seekVideo(timeSeconds) {
    return new Promise((resolve) => {
      let isDone = false;
      const onSeeked = () => {
        if (isDone) return;
        isDone = true;
        this.video.removeEventListener('seeked', onSeeked);
        resolve();
      };

      this.video.addEventListener('seeked', onSeeked, { once: true });
      this.video.currentTime = timeSeconds;

      // Safety timeout in case seeked doesn't fire promptly
      setTimeout(() => {
        if (!isDone) {
          isDone = true;
          this.video.removeEventListener('seeked', onSeeked);
          resolve();
        }
      }, 700);
    });
  }

  /**
   * Captures the current video frame into a 32x18 grayscale thumbnail
   * and computes average luminance
   * @returns {{ avgLuma: number, thumbData: Float32Array }}
   */
  analyzeCurrentFrame() {
    this.thumbCtx.drawImage(this.video, 0, 0, 32, 18);
    const imgData = this.thumbCtx.getImageData(0, 0, 32, 18);
    const data = imgData.data;
    const totalPixels = 32 * 18;
    const thumbData = new Float32Array(totalPixels);
    let lumaSum = 0;

    for (let i = 0; i < totalPixels; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // Standard perceived luminance formula
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      thumbData[i] = luma;
      lumaSum += luma;
    }

    return {
      avgLuma: lumaSum / totalPixels,
      thumbData
    };
  }

  /**
   * Computes Mean Absolute Difference between two thumbnail luminance buffers
   * @param {Float32Array} thumbA 
   * @param {Float32Array} thumbB 
   * @returns {number} Value from 0.0 (identical) to 1.0 (completely opposite)
   */
  calculateDifference(thumbA, thumbB) {
    if (!thumbA || !thumbB) return 1.0;
    let diffSum = 0;
    const len = thumbA.length;
    for (let i = 0; i < len; i++) {
      diffSum += Math.abs(thumbA[i] - thumbB[i]);
    }
    // Normalize by 255
    return diffSum / (len * 255);
  }

  /**
   * Runs the extraction loop with quality filtering and yielding to the event loop
   * @param {object} options
   * @param {number} options.minPhotos
   * @param {number} options.maxPhotos
   * @param {boolean} options.filterBlackWhite
   * @param {boolean} options.filterDuplicates
   * @param {number} options.maxResolution
   * @param {function} onProgress
   * @returns {Promise<Array<object>>}
   */
  async extractFrames(options, onProgress) {
    if (this.isExtracting) {
      throw new Error('Extraction is already in progress.');
    }

    const {
      minPhotos = 15,
      maxPhotos = 20,
      filterBlackWhite = true,
      filterDuplicates = true,
      maxResolution = 1920,
      aspectRatio = '16:9',
      applyCrop = true,
      cropOffsetX = 0.5,
      cropOffsetY = 0.5,
      targetWidth: optTargetW,
      targetHeight: optTargetH,
      customNorm = null,
      resolutionMode = '1080p',
      customWidth = 1920,
      customHeight = 1080,
      watermark = null
    } = options;

    this.isExtracting = true;
    this.cancelRequested = false;
    this.clearCache();

    const videoDuration = this.video.duration;
    if (!videoDuration || isNaN(videoDuration) || videoDuration <= 0) {
      this.isExtracting = false;
      throw new Error('Invalid video duration.');
    }

    // Calculate target extraction dimensions
    const videoWidth = this.video.videoWidth || 1920;
    const videoHeight = this.video.videoHeight || 1080;
    const bounds = this.computeCropBounds(videoWidth, videoHeight, aspectRatio, cropOffsetX, cropOffsetY, customNorm);

    let targetWidth;
    let targetHeight;

    if (resolutionMode === 'original') {
      targetWidth = videoWidth;
      targetHeight = videoHeight;
    } else if (resolutionMode === 'custom' && customWidth && customHeight) {
      targetWidth = Math.max(100, Math.min(7680, customWidth));
      targetHeight = Math.max(100, Math.min(4320, customHeight));
    } else {
      let maxDim = 1920;
      if (resolutionMode === '720p') maxDim = 1280;
      else if (resolutionMode === '4k') maxDim = 3840;
      else if (resolutionMode === '1080p') maxDim = 1920;
      else if (maxResolution) maxDim = maxResolution;

      targetWidth = applyCrop ? (optTargetW || bounds.cropW) : videoWidth;
      targetHeight = applyCrop ? (optTargetH || bounds.cropH) : videoHeight;

      if (Math.max(targetWidth, targetHeight) > maxDim) {
        const scale = maxDim / Math.max(targetWidth, targetHeight);
        targetWidth = Math.round(targetWidth * scale);
        targetHeight = Math.round(targetHeight * scale);
      }
    }

    // Align to even numbers
    targetWidth = targetWidth - (targetWidth % 2);
    targetHeight = targetHeight - (targetHeight % 2);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;

    const schedule = this.generateSamplingSchedule(videoDuration, minPhotos, maxPhotos);
    const totalSlots = schedule.length;
    const extractedFrames = [];
    let prevThumbData = null;

    const startTime = performance.now();

    for (let i = 0; i < totalSlots; i++) {
      if (this.cancelRequested) {
        break;
      }

      const slot = schedule[i];
      let chosenTimestamp = slot.targetTime;
      let frameBlob = null;
      let currentThumb = null;
      let retryCount = 0;
      const MAX_RETRIES = 3;

      while (retryCount <= MAX_RETRIES && !this.cancelRequested) {
        await this.seekVideo(chosenTimestamp);

        // Analyze luminance and thumbnail
        const analysis = this.analyzeCurrentFrame();
        currentThumb = analysis.thumbData;
        const avgLuma = analysis.avgLuma;

        let passed = true;

        // Filter 1: Near black (< 14) or near white (> 242)
        if (filterBlackWhite) {
          if (avgLuma < 14 || avgLuma > 242) {
            passed = false;
          }
        }

        // Filter 2: Near duplicate of previous frame (difference < 6%)
        if (passed && filterDuplicates && prevThumbData) {
          const diff = this.calculateDifference(currentThumb, prevThumbData);
          if (diff < 0.058) {
            passed = false;
          }
        }

        if (passed || retryCount === MAX_RETRIES) {
          // Frame accepted or retries exhausted: draw to target canvas
          if (applyCrop) {
            this.ctx.drawImage(
              this.video,
              bounds.srcX, bounds.srcY, bounds.cropW, bounds.cropH,
              0, 0, targetWidth, targetHeight
            );
          } else {
            this.ctx.drawImage(this.video, 0, 0, targetWidth, targetHeight);
          }

          if (watermark && watermark.enabled) {
            this.applyWatermark(this.ctx, targetWidth, targetHeight, watermark);
          }
          
          frameBlob = await new Promise((res) => {
            this.canvas.toBlob((b) => res(b), 'image/jpeg', 0.95);
          });
          break;
        } else {
          // Pick another random timestamp in the same slot
          retryCount++;
          const slotSpan = slot.slotEnd - slot.slotStart;
          chosenTimestamp = slot.slotStart + 0.05 + Math.random() * Math.max(0.01, slotSpan - 0.1);
          chosenTimestamp = Math.min(videoDuration - 0.05, Math.max(0.05, chosenTimestamp));
        }
      }

      if (this.cancelRequested) break;

      if (frameBlob) {
        prevThumbData = currentThumb;
        const frameItem = {
          id: `frame_${Date.now()}_${i}`,
          index: extractedFrames.length,
          timestamp: chosenTimestamp,
          sourceMinute: slot.minuteIdx,
          blob: frameBlob,
          sizeBytes: frameBlob.size,
          width: targetWidth,
          height: targetHeight,
          aspectRatio,
          cropOffsetX,
          cropOffsetY,
          customNorm: customNorm ? { ...customNorm } : null,
          isCropped: applyCrop,
          starred: false,
          previewUrl: null
        };

        // Create initial preview URL
        frameItem.previewUrl = this.createBlobUrl(frameBlob);
        extractedFrames.push(frameItem);
      }

      // Compute progress & ETA
      const elapsedMs = performance.now() - startTime;
      const progressRatio = (i + 1) / totalSlots;
      const totalEstimatedMs = (progressRatio > 0) ? (elapsedMs / progressRatio) : 0;
      const remainingMs = Math.max(0, totalEstimatedMs - elapsedMs);

      if (typeof onProgress === 'function') {
        onProgress({
          current: i + 1,
          total: totalSlots,
          percent: Math.round(progressRatio * 100),
          keptCount: extractedFrames.length,
          currentMinute: slot.minuteIdx + 1,
          totalMinutes: Math.ceil(videoDuration / 60),
          etaSeconds: Math.round(remainingMs / 1000)
        });
      }

      // Crucial: yield to browser event loop so UI is always buttery smooth
      await new Promise((r) => setTimeout(r, 0));
    }

    this.isExtracting = false;
    return extractedFrames;
  }

  /**
   * Calculates crop sub-rectangle dimensions and offsets for a given target aspect ratio
   * @param {number} sourceW 
   * @param {number} sourceH 
   * @param {string} targetRatio '16:9' | '9:16' | '1:1' | '4:5' | 'source'
   * @param {number} cropOffsetX 0.0 (left), 0.5 (center), 1.0 (right)
   * @param {number} cropOffsetY 0.0 (top), 0.5 (center), 1.0 (bottom)
   * @returns {{ srcX: number, srcY: number, cropW: number, cropH: number, ratioVal: number }}
   */
  computeCropBounds(sourceW, sourceH, targetRatio = '16:9', cropOffsetX = 0.5, cropOffsetY = 0.5, customNorm = null) {
    if (targetRatio === 'custom' && customNorm) {
      let srcX = Math.round(customNorm.x * sourceW);
      let srcY = Math.round(customNorm.y * sourceH);
      let cropW = Math.round(customNorm.w * sourceW);
      let cropH = Math.round(customNorm.h * sourceH);
      cropW = cropW - (cropW % 2);
      cropH = cropH - (cropH % 2);
      srcX = Math.max(0, Math.min(sourceW - cropW, srcX));
      srcY = Math.max(0, Math.min(sourceH - cropH, srcY));
      const ratioVal = cropH > 0 ? (cropW / cropH) : 1;
      return { srcX, srcY, cropW, cropH, ratioVal };
    }

    let ratioVal = sourceW / sourceH;
    if (targetRatio === '16:9' || targetRatio === '16:9-720p') ratioVal = 16 / 9;
    else if (targetRatio === '9:16') ratioVal = 9 / 16;
    else if (targetRatio === '1:1') ratioVal = 1.0;
    else if (targetRatio === '4:5') ratioVal = 4 / 5;

    const sourceAspect = sourceW / sourceH;
    let cropW = sourceW;
    let cropH = sourceH;
    let srcX = 0;
    let srcY = 0;

    if (sourceAspect > ratioVal) {
      // Source is wider than target: crop sides
      cropH = sourceH;
      cropW = Math.round(sourceH * ratioVal);
      const excessX = Math.max(0, sourceW - cropW);
      srcX = Math.round(excessX * Math.max(0, Math.min(1, cropOffsetX)));
    } else if (sourceAspect < ratioVal) {
      // Source is taller than target: crop top/bottom
      cropW = sourceW;
      cropH = Math.round(sourceW / ratioVal);
      const excessY = Math.max(0, sourceH - cropH);
      srcY = Math.round(excessY * Math.max(0, Math.min(1, cropOffsetY)));
    }

    // Ensure even dimensions
    cropW = cropW - (cropW % 2);
    cropH = cropH - (cropH % 2);
    srcX = Math.max(0, Math.min(sourceW - cropW, srcX));
    srcY = Math.max(0, Math.min(sourceH - cropH, srcY));

    return { srcX, srcY, cropW, cropH, ratioVal };
  }

  /**
   * Clips a single frame from the video at current or given timestamp,
   * respecting chosen aspect ratio and framing crop position.
   * @param {object} options
   * @param {number} [options.timestamp] Optional seek timestamp (uses video.currentTime if omitted)
   * @param {string} [options.aspectRatio] '16:9' | '9:16' | '1:1' | '4:5' | 'source'
   * @param {number} [options.cropOffsetX] Horizontal offset (0.0 = left, 0.5 = center, 1.0 = right)
   * @param {number} [options.cropOffsetY] Vertical offset (0.0 = top, 0.5 = center, 1.0 = bottom)
   * @param {boolean} [options.applyCrop] If true, canvas will be cropped to ratio; if false, full frame is saved
   * @param {number} [options.maxResolution] Max width or height constraint (default 1920)
   * @returns {Promise<object>} frameItem
   */
  async clipCurrentFrame(options = {}) {
    const {
      timestamp = undefined,
      aspectRatio = '16:9',
      cropOffsetX = 0.5,
      cropOffsetY = 0.5,
      customNorm = null,
      applyCrop = true,
      maxResolution = 1920,
      targetWidth: optTargetW,
      targetHeight: optTargetH,
      watermark = null
    } = options;

    if (!this.video) {
      throw new Error('No source video element available.');
    }

    if (timestamp !== undefined && !isNaN(timestamp)) {
      await this.seekVideo(timestamp);
    }

    const currentT = this.video.currentTime;
    const sourceW = this.video.videoWidth || 1920;
    const sourceH = this.video.videoHeight || 1080;

    const bounds = this.computeCropBounds(sourceW, sourceH, aspectRatio, cropOffsetX, cropOffsetY, customNorm);

    let destW = applyCrop ? (optTargetW || bounds.cropW) : sourceW;
    let destH = applyCrop ? (optTargetH || bounds.cropH) : sourceH;

    // Scale down if larger than maxResolution while keeping aspect
    if (Math.max(destW, destH) > maxResolution) {
      const scale = maxResolution / Math.max(destW, destH);
      destW = Math.round(destW * scale);
      destH = Math.round(destH * scale);
    }
    destW = destW - (destW % 2);
    destH = destH - (destH % 2);

    this.canvas.width = destW;
    this.canvas.height = destH;

    if (applyCrop) {
      this.ctx.drawImage(
        this.video,
        bounds.srcX, bounds.srcY, bounds.cropW, bounds.cropH,
        0, 0, destW, destH
      );
    } else {
      this.ctx.drawImage(this.video, 0, 0, destW, destH);
    }

    if (watermark && watermark.enabled) {
      this.applyWatermark(this.ctx, destW, destH, watermark);
    }

    const blob = await new Promise((res) => {
      this.canvas.toBlob((b) => res(b), 'image/jpeg', 0.95);
    });

    const previewUrl = this.createBlobUrl(blob);
    const minute = Math.floor(currentT / 60);

    const frameItem = {
      id: `frame_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: currentT,
      sourceMinute: minute,
      blob,
      sizeBytes: blob ? blob.size : 0,
      width: destW,
      height: destH,
      aspectRatio,
      cropOffsetX,
      cropOffsetY,
      customNorm: customNorm ? { ...customNorm } : null,
      isCropped: applyCrop,
      starred: false,
      previewUrl
    };

    return frameItem;
  }

  /**
   * Composites a watermark, channel tag mark, or sticker onto the target 2D context
   * @param {CanvasRenderingContext2D} ctx Destination canvas 2D context
   * @param {number} width Canvas width
   * @param {number} height Canvas height
   * @param {object} wm Watermark configuration
   */
  applyWatermark(ctx, width, height, wm) {
    if (!wm || !wm.enabled) return;

    const pad = Math.max(16, Math.round(Math.min(width, height) * 0.035));
    const opacity = typeof wm.opacity === 'number' ? wm.opacity : 0.85;
    const pos = wm.position || 'bottom-right';

    ctx.save();
    ctx.globalAlpha = Math.max(0.1, Math.min(1.0, opacity));

    if (wm.type === 'image' && wm.imageElement) {
      const img = wm.imageElement;
      const imgW = img.naturalWidth || img.width || 120;
      const imgH = img.naturalHeight || img.height || 120;
      const imgAspect = imgW / imgH;

      let scaleFrac = 0.18; // medium
      if (wm.size === 'small') scaleFrac = 0.12;
      else if (wm.size === 'large') scaleFrac = 0.26;

      let drawW = Math.round(width * scaleFrac);
      let drawH = Math.round(drawW / imgAspect);
      if (drawH > height * 0.4) {
        drawH = Math.round(height * 0.4);
        drawW = Math.round(drawH * imgAspect);
      }

      let x = width - drawW - pad;
      let y = height - drawH - pad;
      if (pos === 'custom' && wm.customNorm) {
        x = Math.max(pad, Math.min(width - drawW - pad, Math.round(wm.customNorm.relX * width)));
        y = Math.max(pad, Math.min(height - drawH - pad, Math.round(wm.customNorm.relY * height)));
      } else if (pos === 'bottom-left') {
        x = pad;
        y = height - drawH - pad;
      } else if (pos === 'top-right') {
        x = width - drawW - pad;
        y = pad;
      } else if (pos === 'top-left') {
        x = pad;
        y = pad;
      } else if (pos === 'center') {
        x = Math.round((width - drawW) / 2);
        y = Math.round((height - drawH) / 2);
      }

      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      ctx.drawImage(img, x, y, drawW, drawH);
    } else {
      const text = (wm.text || '').trim();
      if (!text) {
        ctx.restore();
        return;
      }

      let fontScale = 0.038;
      if (wm.size === 'small') fontScale = 0.026;
      else if (wm.size === 'large') fontScale = 0.052;
      const fontSize = Math.max(14, Math.round(Math.min(width, height) * fontScale));

      ctx.font = `700 ${fontSize}px 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif`;
      const textMetrics = ctx.measureText(text);
      const textW = textMetrics.width;

      const pillPadX = Math.round(fontSize * 0.75);
      const pillPadY = Math.round(fontSize * 0.4);
      const pillW = Math.round(textW + pillPadX * 2);
      const pillH = Math.round(fontSize + pillPadY * 2);
      const radius = Math.round(pillH * 0.35);

      let x = width - pillW - pad;
      let y = height - pillH - pad;
      if (pos === 'custom' && wm.customNorm) {
        x = Math.max(pad, Math.min(width - pillW - pad, Math.round(wm.customNorm.relX * width)));
        y = Math.max(pad, Math.min(height - pillH - pad, Math.round(wm.customNorm.relY * height)));
      } else if (pos === 'bottom-left') {
        x = pad;
        y = height - pillH - pad;
      } else if (pos === 'top-right') {
        x = width - pillW - pad;
        y = pad;
      } else if (pos === 'top-left') {
        x = pad;
        y = pad;
      } else if (pos === 'center') {
        x = Math.round((width - pillW) / 2);
        y = Math.round((height - pillH) / 2);
      }

      const style = wm.style || 'dark-pill';

      if (style !== 'clean-text') {
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, y, pillW, pillH, radius);
        } else {
          ctx.rect(x, y, pillW, pillH);
        }

        if (style === 'gold-pill') {
          ctx.fillStyle = 'rgba(46, 32, 22, 0.9)';
          ctx.fill();
          ctx.strokeStyle = '#f5d97a';
          ctx.lineWidth = Math.max(1.5, Math.round(fontSize * 0.08));
          ctx.stroke();
        } else if (style === 'red-box') {
          ctx.fillStyle = 'rgba(214, 40, 40, 0.92)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.lineWidth = Math.max(1.5, Math.round(fontSize * 0.06));
          ctx.stroke();
        } else {
          // dark-pill default
          ctx.fillStyle = 'rgba(15, 10, 8, 0.82)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;

      if (style === 'gold-pill') {
        ctx.fillStyle = '#f5d97a';
      } else {
        ctx.fillStyle = '#ffffff';
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + pillW / 2, y + pillH / 2);
    }

    ctx.restore();
  }

  /**
   * Signals the extraction loop to stop
   */
  cancel() {
    this.cancelRequested = true;
  }
}

