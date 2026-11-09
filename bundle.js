(() => {
  // js/extractor.js
  var FrameExtractor = class {
    constructor(videoElement, offscreenCanvas) {
      this.video = videoElement;
      this.canvas = offscreenCanvas || (typeof document !== "undefined" ? document.createElement("canvas") : null);
      this.ctx = this.canvas ? this.canvas.getContext("2d", { willReadFrequently: true }) : null;
      if (typeof document !== "undefined") {
        this.thumbCanvas = document.createElement("canvas");
        this.thumbCanvas.width = 32;
        this.thumbCanvas.height = 18;
        this.thumbCtx = this.thumbCanvas.getContext("2d", { willReadFrequently: true });
      } else {
        this.thumbCanvas = null;
        this.thumbCtx = null;
      }
      this.isExtracting = false;
      this.cancelRequested = false;
      this.lruCapacity = 30;
      this.bitmapCache = /* @__PURE__ */ new Map();
    }
    /**
     * Resets and closes all cached ImageBitmaps to free GPU/RAM memory
     */
    clearCache() {
      for (const [id, bmp] of this.bitmapCache.entries()) {
        if (bmp && typeof bmp.close === "function") {
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
        const bmp2 = this.bitmapCache.get(frameItem.id);
        this.bitmapCache.delete(frameItem.id);
        this.bitmapCache.set(frameItem.id, bmp2);
        return bmp2;
      }
      const bmp = await createImageBitmap(frameItem.blob);
      if (this.bitmapCache.size >= this.lruCapacity) {
        const oldestKey = this.bitmapCache.keys().next().value;
        const oldBmp = this.bitmapCache.get(oldestKey);
        if (oldBmp && typeof oldBmp.close === "function") {
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
    revokeBlobUrl(url2) {
      if (url2 && url2.startsWith("blob:")) {
        URL.revokeObjectURL(url2);
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
        const randomN = Math.floor(minPhotos + Math.random() * (maxPhotos - minPhotos + 1));
        const effectiveN = minuteDuration < 60 ? Math.max(1, Math.round(randomN * (minuteDuration / 60))) : randomN;
        const slotDuration = minuteDuration / effectiveN;
        for (let s = 0; s < effectiveN; s++) {
          const slotStart = minuteStart + s * slotDuration;
          const slotEnd = minuteStart + (s + 1) * slotDuration;
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
          this.video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        this.video.addEventListener("seeked", onSeeked, { once: true });
        this.video.currentTime = timeSeconds;
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            this.video.removeEventListener("seeked", onSeeked);
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
      if (!thumbA || !thumbB) return 1;
      let diffSum = 0;
      const len = thumbA.length;
      for (let i = 0; i < len; i++) {
        diffSum += Math.abs(thumbA[i] - thumbB[i]);
      }
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
        throw new Error("Extraction is already in progress.");
      }
      const {
        minPhotos = 15,
        maxPhotos = 20,
        filterBlackWhite = true,
        filterDuplicates = true,
        maxResolution = 1920,
        aspectRatio = "16:9",
        applyCrop = true,
        cropOffsetX = 0.5,
        cropOffsetY = 0.5,
        targetWidth: optTargetW,
        targetHeight: optTargetH,
        customNorm = null,
        resolutionMode = "1080p",
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
        throw new Error("Invalid video duration.");
      }
      const videoWidth = this.video.videoWidth || 1920;
      const videoHeight = this.video.videoHeight || 1080;
      const bounds = this.computeCropBounds(videoWidth, videoHeight, aspectRatio, cropOffsetX, cropOffsetY, customNorm);
      let targetWidth;
      let targetHeight;
      if (resolutionMode === "original") {
        targetWidth = videoWidth;
        targetHeight = videoHeight;
      } else if (resolutionMode === "custom" && customWidth && customHeight) {
        targetWidth = Math.max(100, Math.min(7680, customWidth));
        targetHeight = Math.max(100, Math.min(4320, customHeight));
      } else {
        let maxDim = 1920;
        if (resolutionMode === "720p") maxDim = 1280;
        else if (resolutionMode === "4k") maxDim = 3840;
        else if (resolutionMode === "1080p") maxDim = 1920;
        else if (maxResolution) maxDim = maxResolution;
        targetWidth = applyCrop ? optTargetW || bounds.cropW : videoWidth;
        targetHeight = applyCrop ? optTargetH || bounds.cropH : videoHeight;
        if (Math.max(targetWidth, targetHeight) > maxDim) {
          const scale = maxDim / Math.max(targetWidth, targetHeight);
          targetWidth = Math.round(targetWidth * scale);
          targetHeight = Math.round(targetHeight * scale);
        }
      }
      targetWidth = targetWidth - targetWidth % 2;
      targetHeight = targetHeight - targetHeight % 2;
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
          const analysis = this.analyzeCurrentFrame();
          currentThumb = analysis.thumbData;
          const avgLuma = analysis.avgLuma;
          let passed = true;
          if (filterBlackWhite) {
            if (avgLuma < 14 || avgLuma > 242) {
              passed = false;
            }
          }
          if (passed && filterDuplicates && prevThumbData) {
            const diff = this.calculateDifference(currentThumb, prevThumbData);
            if (diff < 0.058) {
              passed = false;
            }
          }
          if (passed || retryCount === MAX_RETRIES) {
            if (applyCrop) {
              this.ctx.drawImage(
                this.video,
                bounds.srcX,
                bounds.srcY,
                bounds.cropW,
                bounds.cropH,
                0,
                0,
                targetWidth,
                targetHeight
              );
            } else {
              this.ctx.drawImage(this.video, 0, 0, targetWidth, targetHeight);
            }
            if (watermark && watermark.enabled) {
              this.applyWatermark(this.ctx, targetWidth, targetHeight, watermark);
            }
            frameBlob = await new Promise((res) => {
              this.canvas.toBlob((b) => res(b), "image/jpeg", 0.95);
            });
            break;
          } else {
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
          frameItem.previewUrl = this.createBlobUrl(frameBlob);
          extractedFrames.push(frameItem);
        }
        const elapsedMs = performance.now() - startTime;
        const progressRatio = (i + 1) / totalSlots;
        const totalEstimatedMs = progressRatio > 0 ? elapsedMs / progressRatio : 0;
        const remainingMs = Math.max(0, totalEstimatedMs - elapsedMs);
        if (typeof onProgress === "function") {
          onProgress({
            current: i + 1,
            total: totalSlots,
            percent: Math.round(progressRatio * 100),
            keptCount: extractedFrames.length,
            currentMinute: slot.minuteIdx + 1,
            totalMinutes: Math.ceil(videoDuration / 60),
            etaSeconds: Math.round(remainingMs / 1e3)
          });
        }
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
    computeCropBounds(sourceW, sourceH, targetRatio = "16:9", cropOffsetX = 0.5, cropOffsetY = 0.5, customNorm = null) {
      if (targetRatio === "custom" && customNorm) {
        let srcX2 = Math.round(customNorm.x * sourceW);
        let srcY2 = Math.round(customNorm.y * sourceH);
        let cropW2 = Math.round(customNorm.w * sourceW);
        let cropH2 = Math.round(customNorm.h * sourceH);
        cropW2 = cropW2 - cropW2 % 2;
        cropH2 = cropH2 - cropH2 % 2;
        srcX2 = Math.max(0, Math.min(sourceW - cropW2, srcX2));
        srcY2 = Math.max(0, Math.min(sourceH - cropH2, srcY2));
        const ratioVal2 = cropH2 > 0 ? cropW2 / cropH2 : 1;
        return { srcX: srcX2, srcY: srcY2, cropW: cropW2, cropH: cropH2, ratioVal: ratioVal2 };
      }
      let ratioVal = sourceW / sourceH;
      if (targetRatio === "16:9" || targetRatio === "16:9-720p") ratioVal = 16 / 9;
      else if (targetRatio === "9:16") ratioVal = 9 / 16;
      else if (targetRatio === "1:1") ratioVal = 1;
      else if (targetRatio === "4:5") ratioVal = 4 / 5;
      const sourceAspect = sourceW / sourceH;
      let cropW = sourceW;
      let cropH = sourceH;
      let srcX = 0;
      let srcY = 0;
      if (sourceAspect > ratioVal) {
        cropH = sourceH;
        cropW = Math.round(sourceH * ratioVal);
        const excessX = Math.max(0, sourceW - cropW);
        srcX = Math.round(excessX * Math.max(0, Math.min(1, cropOffsetX)));
      } else if (sourceAspect < ratioVal) {
        cropW = sourceW;
        cropH = Math.round(sourceW / ratioVal);
        const excessY = Math.max(0, sourceH - cropH);
        srcY = Math.round(excessY * Math.max(0, Math.min(1, cropOffsetY)));
      }
      cropW = cropW - cropW % 2;
      cropH = cropH - cropH % 2;
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
        timestamp = void 0,
        aspectRatio = "16:9",
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
        throw new Error("No source video element available.");
      }
      if (timestamp !== void 0 && !isNaN(timestamp)) {
        await this.seekVideo(timestamp);
      }
      const currentT = this.video.currentTime;
      const sourceW = this.video.videoWidth || 1920;
      const sourceH = this.video.videoHeight || 1080;
      const bounds = this.computeCropBounds(sourceW, sourceH, aspectRatio, cropOffsetX, cropOffsetY, customNorm);
      let destW = applyCrop ? optTargetW || bounds.cropW : sourceW;
      let destH = applyCrop ? optTargetH || bounds.cropH : sourceH;
      if (Math.max(destW, destH) > maxResolution) {
        const scale = maxResolution / Math.max(destW, destH);
        destW = Math.round(destW * scale);
        destH = Math.round(destH * scale);
      }
      destW = destW - destW % 2;
      destH = destH - destH % 2;
      this.canvas.width = destW;
      this.canvas.height = destH;
      if (applyCrop) {
        this.ctx.drawImage(
          this.video,
          bounds.srcX,
          bounds.srcY,
          bounds.cropW,
          bounds.cropH,
          0,
          0,
          destW,
          destH
        );
      } else {
        this.ctx.drawImage(this.video, 0, 0, destW, destH);
      }
      if (watermark && watermark.enabled) {
        this.applyWatermark(this.ctx, destW, destH, watermark);
      }
      const blob = await new Promise((res) => {
        this.canvas.toBlob((b) => res(b), "image/jpeg", 0.95);
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
      const opacity = typeof wm.opacity === "number" ? wm.opacity : 0.85;
      const pos = wm.position || "bottom-right";
      ctx.save();
      ctx.globalAlpha = Math.max(0.1, Math.min(1, opacity));
      if (wm.type === "image" && wm.imageElement) {
        const img = wm.imageElement;
        const imgW = img.naturalWidth || img.width || 120;
        const imgH = img.naturalHeight || img.height || 120;
        const imgAspect = imgW / imgH;
        let scaleFrac = 0.18;
        if (wm.size === "small") scaleFrac = 0.12;
        else if (wm.size === "large") scaleFrac = 0.26;
        let drawW = Math.round(width * scaleFrac);
        let drawH = Math.round(drawW / imgAspect);
        if (drawH > height * 0.4) {
          drawH = Math.round(height * 0.4);
          drawW = Math.round(drawH * imgAspect);
        }
        let x = width - drawW - pad;
        let y = height - drawH - pad;
        if (pos === "custom" && wm.customNorm) {
          x = Math.max(pad, Math.min(width - drawW - pad, Math.round(wm.customNorm.relX * width)));
          y = Math.max(pad, Math.min(height - drawH - pad, Math.round(wm.customNorm.relY * height)));
        } else if (pos === "bottom-left") {
          x = pad;
          y = height - drawH - pad;
        } else if (pos === "top-right") {
          x = width - drawW - pad;
          y = pad;
        } else if (pos === "top-left") {
          x = pad;
          y = pad;
        } else if (pos === "center") {
          x = Math.round((width - drawW) / 2);
          y = Math.round((height - drawH) / 2);
        }
        ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.drawImage(img, x, y, drawW, drawH);
      } else {
        const text = (wm.text || "").trim();
        if (!text) {
          ctx.restore();
          return;
        }
        let fontScale = 0.038;
        if (wm.size === "small") fontScale = 0.026;
        else if (wm.size === "large") fontScale = 0.052;
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
        if (pos === "custom" && wm.customNorm) {
          x = Math.max(pad, Math.min(width - pillW - pad, Math.round(wm.customNorm.relX * width)));
          y = Math.max(pad, Math.min(height - pillH - pad, Math.round(wm.customNorm.relY * height)));
        } else if (pos === "bottom-left") {
          x = pad;
          y = height - pillH - pad;
        } else if (pos === "top-right") {
          x = width - pillW - pad;
          y = pad;
        } else if (pos === "top-left") {
          x = pad;
          y = pad;
        } else if (pos === "center") {
          x = Math.round((width - pillW) / 2);
          y = Math.round((height - pillH) / 2);
        }
        const style = wm.style || "dark-pill";
        if (style !== "clean-text") {
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, pillW, pillH, radius);
          } else {
            ctx.rect(x, y, pillW, pillH);
          }
          if (style === "gold-pill") {
            ctx.fillStyle = "rgba(46, 32, 22, 0.9)";
            ctx.fill();
            ctx.strokeStyle = "#f5d97a";
            ctx.lineWidth = Math.max(1.5, Math.round(fontSize * 0.08));
            ctx.stroke();
          } else if (style === "red-box") {
            ctx.fillStyle = "rgba(214, 40, 40, 0.92)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
            ctx.lineWidth = Math.max(1.5, Math.round(fontSize * 0.06));
            ctx.stroke();
          } else {
            ctx.fillStyle = "rgba(15, 10, 8, 0.82)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
        ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        if (style === "gold-pill") {
          ctx.fillStyle = "#f5d97a";
        } else {
          ctx.fillStyle = "#ffffff";
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
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
  };

  // js/voice.js
  function getApiUrl(endpoint) {
    var _a;
    if (typeof window === "undefined") {
      const port = typeof process !== "undefined" && ((_a = process.env) == null ? void 0 : _a.PORT) || 3e3;
      return `http://localhost:${port}${endpoint}`;
    }
    if (window.location && window.location.protocol === "file:") {
      return `http://localhost:3000${endpoint}`;
    }
    return endpoint;
  }
  var VoiceEngine = class {
    constructor() {
      this.audioCtx = null;
      this.audioBuffer = null;
      this.audioFileName = "voice_audio.wav";
      this.audioDuration = 0;
      this.previewSourceNode = null;
      this.previewGainNode = null;
      this.isAudioPlaying = false;
      this.previewStartTime = 0;
      this.previewPauseOffset = 0;
      this.settings = {
        reduceNoise: true,
        normalize: true,
        masterGain: 1,
        eqLow: 0,
        eqMid: 2,
        eqHigh: 1,
        abCleanedActive: true
        // A/B test toggle
      };
      this.mediaRecorder = null;
      this.recordStream = null;
      this.recordChunks = [];
      this.recordTimerInterval = null;
      this.recordSeconds = 0;
      this.analyserNode = null;
      this.visualizerAnimationId = null;
      this.voices = [];
      this.ttsCurrentUtterance = null;
      this.ttsKeepAliveTimer = null;
      this.ttsIsSpeaking = false;
      this.isSpeakingChunks = false;
      this.currentAudioPreview = null;
    }
    /**
     * Initializes or resumes the AudioContext
     * @returns {AudioContext}
     */
    getAudioContext() {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }
      return this.audioCtx;
    }
    /**
     * Loads and decodes an audio file into an AudioBuffer
     * @param {File|Blob} file 
     * @param {string} filename 
     * @returns {Promise<AudioBuffer>}
     */
    async loadAudioFile(file, filename = "voice_audio.wav") {
      const ctx = this.getAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      this.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.audioFileName = filename || file.name || "voice_audio.wav";
      this.audioDuration = this.audioBuffer.duration;
      return this.audioBuffer;
    }
    /**
     * Sets the current AudioBuffer directly
     * @param {AudioBuffer} buffer 
     * @param {string} name 
     */
    setAudioBuffer(buffer, name = "recorded_voice.wav") {
      this.audioBuffer = buffer;
      this.audioFileName = name;
      this.audioDuration = buffer ? buffer.duration : 0;
    }
    /**
     * Calculates peak amplitude of an AudioBuffer
     * @param {AudioBuffer} buffer 
     * @returns {number} Peak between 0.0 and 1.0+
     */
    getPeakAmplitude(buffer) {
      if (!buffer) return 0;
      let max = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i += 10) {
          const abs = Math.abs(data[i]);
          if (abs > max) max = abs;
        }
      }
      return max;
    }
    /**
     * Detects pauses/silence gaps in the AudioBuffer (> 300ms) for caption snapping
     * @param {number} silenceThreshold RMS threshold (default 0.015)
     * @param {number} minGapSeconds Minimum pause duration in seconds (default 0.3s)
     * @returns {Array<{ start: number, end: number, mid: number }>}
     */
    detectSilenceGaps(silenceThreshold = 0.018, minGapSeconds = 0.28) {
      if (!this.audioBuffer) return [];
      const buffer = this.audioBuffer;
      const sampleRate = buffer.sampleRate;
      const channelData = buffer.getChannelData(0);
      const windowSize = Math.floor(sampleRate * 0.03);
      const hopSize = Math.floor(sampleRate * 0.015);
      const totalSamples = channelData.length;
      const silentFrames = [];
      for (let i = 0; i < totalSamples - windowSize; i += hopSize) {
        let sumSq = 0;
        for (let j = 0; j < windowSize; j++) {
          const val = channelData[i + j];
          sumSq += val * val;
        }
        const rms = Math.sqrt(sumSq / windowSize);
        const timeSec = i / sampleRate;
        silentFrames.push({ time: timeSec, isSilent: rms < silenceThreshold });
      }
      const gaps = [];
      let inGap = false;
      let gapStart = 0;
      for (let k = 0; k < silentFrames.length; k++) {
        const f = silentFrames[k];
        if (f.isSilent && !inGap) {
          inGap = true;
          gapStart = f.time;
        } else if (!f.isSilent && inGap) {
          inGap = false;
          const gapEnd = f.time;
          if (gapEnd - gapStart >= minGapSeconds) {
            gaps.push({
              start: gapStart,
              end: gapEnd,
              mid: (gapStart + gapEnd) / 2
            });
          }
        }
      }
      if (inGap) {
        const gapEnd = buffer.duration;
        if (gapEnd - gapStart >= minGapSeconds) {
          gaps.push({ start: gapStart, end: gapEnd, mid: (gapStart + gapEnd) / 2 });
        }
      }
      return gaps;
    }
    /**
     * Builds an audio processing graph (High-pass, Noise gate, Normalizer, EQ)
     * connected between sourceNode and destinationNode
     * @param {AudioNode} sourceNode 
     * @param {AudioNode} destinationNode 
     * @param {object} [overrideSettings] 
     * @param {BaseAudioContext} [ctx] AudioContext or OfflineAudioContext (defaults to live context or sourceNode.context)
     * @returns {{ inputNode: AudioNode, outputNode: AudioNode }}
     */
    connectProcessingGraph(sourceNode, destinationNode, overrideSettings = null, ctxOverride = null) {
      const ctx = ctxOverride || this.getAudioContext();
      const cfg = overrideSettings || this.settings || {};
      if (!cfg.abCleanedActive) {
        sourceNode.connect(destinationNode);
        return { inputNode: sourceNode, outputNode: destinationNode };
      }
      let currentNode = sourceNode;
      const now = 0;
      if (cfg.reduceNoise) {
        const highPass = ctx.createBiquadFilter();
        highPass.type = "highpass";
        highPass.frequency.value = 80;
        highPass.Q.value = 0.707;
        currentNode.connect(highPass);
        currentNode = highPass;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-28, now);
        comp.knee.setValueAtTime(8, now);
        comp.ratio.setValueAtTime(4, now);
        comp.attack.setValueAtTime(5e-3, now);
        comp.release.setValueAtTime(0.08, now);
        currentNode.connect(comp);
        currentNode = comp;
      }
      let normFactor = 1;
      if (cfg.normalize && this.audioBuffer) {
        const peak = this.getPeakAmplitude(this.audioBuffer);
        if (peak > 0.01) {
          normFactor = Math.min(3.5, 0.94 / peak);
        }
      }
      const safeNorm = Number.isFinite(normFactor) && normFactor > 0 ? normFactor : 1;
      const normGain = ctx.createGain();
      normGain.gain.setValueAtTime(safeNorm, now);
      currentNode.connect(normGain);
      currentNode = normGain;
      const eqLow = ctx.createBiquadFilter();
      eqLow.type = "lowshelf";
      eqLow.frequency.value = 160;
      eqLow.gain.setValueAtTime(Number.isFinite(cfg.eqLow) ? cfg.eqLow : 0, now);
      currentNode.connect(eqLow);
      currentNode = eqLow;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = "peaking";
      eqMid.frequency.value = 1200;
      eqMid.Q.value = 1;
      eqMid.gain.setValueAtTime(Number.isFinite(cfg.eqMid) ? cfg.eqMid : 0, now);
      currentNode.connect(eqMid);
      currentNode = eqMid;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = "highshelf";
      eqHigh.frequency.value = 4800;
      eqHigh.gain.setValueAtTime(Number.isFinite(cfg.eqHigh) ? cfg.eqHigh : 0, now);
      currentNode.connect(eqHigh);
      currentNode = eqHigh;
      const safeMaster = Number.isFinite(cfg.masterGain) && cfg.masterGain > 0 ? cfg.masterGain : 1;
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(safeMaster, now);
      currentNode.connect(masterGain);
      currentNode = masterGain;
      currentNode.connect(destinationNode);
      return { inputNode: sourceNode, outputNode: currentNode };
    }
    /**
     * Renders the processed voice-over into a fixed-duration AudioBuffer via OfflineAudioContext,
     * applying the full DSP clean-up/EQ chain and padding/trimming to targetDuration exactly.
     * @param {number} targetDuration Duration in seconds
     * @param {number} [targetSampleRate] 48000 Hz default
     * @returns {Promise<AudioBuffer|null>}
     */
    async renderProcessedAudioBuffer(targetDuration, targetSampleRate = 48e3) {
      if (!this.audioBuffer) return null;
      const OfflineCtxClass = typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      if (!OfflineCtxClass) return null;
      const channels = 2;
      const safeDuration = Math.max(0.1, targetDuration);
      const totalSamples = Math.ceil(safeDuration * targetSampleRate);
      const offlineCtx = new OfflineCtxClass(channels, totalSamples, targetSampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = this.audioBuffer;
      source.start(0);
      this.connectProcessingGraph(source, offlineCtx.destination, null, offlineCtx);
      const rendered = await offlineCtx.startRendering();
      return rendered;
    }
    /**
     * Detects speech region start and end using ~20ms RMS windows, skipping leading and trailing silence
     * @param {AudioBuffer} [buffer] 
     * @param {number} [silenceThreshold] RMS energy threshold
     * @returns {{ speechStart: number, speechEnd: number, hasSpeech: boolean }}
     */
    detectSpeechBounds(buffer = this.audioBuffer, silenceThreshold = 0.015) {
      if (!buffer) return { speechStart: 0, speechEnd: 0, hasSpeech: false };
      const sampleRate = buffer.sampleRate;
      const channelData = buffer.getChannelData(0);
      const windowSize = Math.floor(sampleRate * 0.02);
      const hopSize = Math.floor(sampleRate * 0.01);
      const totalSamples = channelData.length;
      let firstSpeechSec = -1;
      let lastSpeechSec = -1;
      for (let i = 0; i <= totalSamples - windowSize; i += hopSize) {
        let sumSq = 0;
        for (let j = 0; j < windowSize; j++) {
          const val = channelData[i + j];
          sumSq += val * val;
        }
        const rms = Math.sqrt(sumSq / windowSize);
        if (rms >= silenceThreshold) {
          const timeSec = i / sampleRate;
          if (firstSpeechSec < 0) firstSpeechSec = timeSec;
          lastSpeechSec = timeSec + windowSize / sampleRate;
        }
      }
      if (firstSpeechSec < 0) {
        return { speechStart: 0, speechEnd: buffer.duration, hasSpeech: false };
      }
      const speechStart = Math.max(0, firstSpeechSec - 0.04);
      const speechEnd = Math.min(buffer.duration, lastSpeechSec + 0.04);
      return { speechStart, speechEnd, hasSpeech: true };
    }
    /**
     * Generates a unified AudioBuffer and exact sentence timings from script sentence chunks
     * using the local neural TTS API (/api/tts).
     * @param {Array<string>|string} chunks 
     * @param {object} [options] { voice, rate, pitch }
     * @returns {Promise<{ buffer: AudioBuffer, sentenceTimings: Array<{ text: string, start: number, end: number, duration: number }> }>}
     */
    async generateVoiceFromScript(chunks, options = {}) {
      const rawList = Array.isArray(chunks) ? chunks : [chunks];
      const sentenceList = rawList.map((c) => (c || "").trim()).filter((c) => c.length > 0);
      if (sentenceList.length === 0) {
        throw new Error("No script sentences provided for TTS generation.");
      }
      const ctx = this.getAudioContext();
      if (ctx && ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
        }
      }
      const voice = options.voice || "hi-IN-SwaraNeural";
      const rate = options.rate !== void 0 ? options.rate : 1;
      const pitch = options.pitch !== void 0 ? options.pitch : 1;
      const volume = options.volume !== void 0 ? options.volume : 1;
      const decodedItems = [];
      for (let i = 0; i < sentenceList.length; i++) {
        const sentenceText = sentenceList[i];
        let resp = null;
        let lastErrMsg = "";
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            if (i > 0 && attempt === 0) {
              await new Promise((r) => setTimeout(r, 280));
            } else if (attempt > 0) {
              await new Promise((r) => setTimeout(r, 1e3 * attempt));
            }
            const ttsUrl = getApiUrl("/api/tts");
            resp = await fetch(ttsUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: sentenceText,
                voice,
                rate,
                pitch,
                volume
              })
            });
            if (resp.status === 404) {
              throw new Error("server not running \u2013 open the app via `npm start` at http://localhost:3000");
            }
            if (resp.ok) break;
            try {
              const errData = await resp.json();
              if (errData && errData.error) lastErrMsg = errData.error;
            } catch (e) {
            }
            if (!resp.ok) {
              throw new Error(lastErrMsg || `TTS request failed with status ${resp.status}`);
            }
          } catch (netErr) {
            lastErrMsg = netErr.message;
            const msg = (netErr.message || "").toLowerCase();
            if (msg.includes("404") || msg.includes("server not running") || msg.includes("no internet")) {
              throw netErr;
            }
          }
        }
        if (!resp || !resp.ok) {
          throw new Error(lastErrMsg || `TTS request failed after retries for sentence: "${sentenceText.slice(0, 30)}..."`);
        }
        const arrayBuffer = await resp.arrayBuffer();
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error(`TTS service returned empty audio for chunk: "${sentenceText.slice(0, 30)}...". Please ensure selected voice matches the script language.`);
        }
        const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
        decodedItems.push({
          text: sentenceText,
          audioBuffer: decodedBuffer
        });
        if (typeof options.onProgress === "function") {
          options.onProgress(i + 1, sentenceList.length, sentenceText);
        }
      }
      const sampleRate = decodedItems[0].audioBuffer.sampleRate || 48e3;
      let totalSamples = 0;
      const pauses = [];
      for (let i = 0; i < decodedItems.length; i++) {
        const item = decodedItems[i];
        totalSamples += item.audioBuffer.length;
        let pauseSec = 0.2;
        if (/[।\.\?!]/.test(item.text)) {
          pauseSec = 0.25;
        } else if (/[,;،]/.test(item.text)) {
          pauseSec = 0.1;
        }
        const pauseSamples = Math.round(pauseSec * sampleRate);
        pauses.push(pauseSamples);
        totalSamples += pauseSamples;
      }
      const combinedBuffer = ctx.createBuffer(2, Math.max(1, totalSamples), sampleRate);
      const ch0 = combinedBuffer.getChannelData(0);
      const ch1 = combinedBuffer.getChannelData(1);
      let currentSample = 0;
      const sentenceTimings = [];
      for (let i = 0; i < decodedItems.length; i++) {
        const item = decodedItems[i];
        const src0 = item.audioBuffer.getChannelData(0);
        const src1 = item.audioBuffer.numberOfChannels > 1 ? item.audioBuffer.getChannelData(1) : src0;
        const startSec = currentSample / sampleRate;
        for (let s = 0; s < item.audioBuffer.length; s++) {
          ch0[currentSample + s] = src0[s];
          ch1[currentSample + s] = src1[s];
        }
        currentSample += item.audioBuffer.length;
        const endSec = currentSample / sampleRate;
        sentenceTimings.push({
          text: item.text,
          start: startSec,
          end: endSec,
          duration: endSec - startSec
        });
        currentSample += pauses[i];
      }
      const vol = options.volume !== void 0 ? Math.max(0, Math.min(1, Number(options.volume))) : 1;
      if (!isNaN(vol) && vol !== 1) {
        for (let s = 0; s < combinedBuffer.length; s++) {
          ch0[s] *= vol;
          ch1[s] *= vol;
        }
      }
      this.setAudioBuffer(combinedBuffer, "tts_voice.wav");
      return {
        buffer: combinedBuffer,
        sentenceTimings
      };
    }
    /**
     * Plays the voice-over preview from an offset with processing applied
     * @param {number} offsetSeconds 
     * @param {function} onEnded 
     */
    playPreview(offsetSeconds = 0, onEnded = null) {
      if (!this.audioBuffer) return;
      this.stopPreview();
      const ctx = this.getAudioContext();
      const source = ctx.createBufferSource();
      source.buffer = this.audioBuffer;
      this.connectProcessingGraph(source, ctx.destination);
      source.onended = () => {
        this.isAudioPlaying = false;
        if (typeof onEnded === "function") onEnded();
      };
      if (offsetSeconds >= this.audioBuffer.duration) {
        this.isAudioPlaying = false;
        if (typeof onEnded === "function") onEnded();
        return;
      }
      const clampedOffset = Math.max(0, offsetSeconds);
      source.start(0, clampedOffset);
      this.previewSourceNode = source;
      this.previewStartTime = ctx.currentTime - clampedOffset;
      this.isAudioPlaying = true;
    }
    /**
     * Stops voice preview playback
     */
    stopPreview() {
      if (this.previewSourceNode) {
        try {
          this.previewSourceNode.stop();
          this.previewSourceNode.disconnect();
        } catch (e) {
        }
        this.previewSourceNode = null;
      }
      this.isAudioPlaying = false;
    }
    /**
     * Starts live microphone recording with live visualizer
     * @param {HTMLCanvasElement} visualizerCanvas 
     * @param {HTMLElement} dbMeterFill 
     * @param {function} onTimerTick 
     * @returns {Promise<void>}
     */
    async startRecording(visualizerCanvas, dbMeterFill, onTimerTick) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          // We provide clean in-app DSP
          autoGainControl: false
        }
      });
      this.recordStream = stream;
      this.recordChunks = [];
      const ctx = this.getAudioContext();
      if (ctx && ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
        }
      }
      const sourceNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      sourceNode.connect(analyser);
      this.analyserNode = analyser;
      this.drawLiveVisualizer(visualizerCanvas, dbMeterFill);
      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      }
      const options = mimeType ? { mimeType } : void 0;
      this.mediaRecorder = new MediaRecorder(stream, options);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordChunks.push(e.data);
        }
      };
      this.mediaRecorder.start(100);
      this.recordSeconds = 0;
      if (this.recordTimerInterval) clearInterval(this.recordTimerInterval);
      this.recordTimerInterval = setInterval(() => {
        this.recordSeconds++;
        if (typeof onTimerTick === "function") {
          onTimerTick(this.recordSeconds);
        }
      }, 1e3);
    }
    /**
     * Pauses recording
     */
    pauseRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.mediaRecorder.pause();
      }
    }
    /**
     * Resumes recording
     */
    resumeRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state === "paused") {
        this.mediaRecorder.resume();
      }
    }
    /**
     * Stops recording and decodes into AudioBuffer
     * @returns {Promise<AudioBuffer>}
     */
    async stopRecording() {
      if (this.recordTimerInterval) {
        clearInterval(this.recordTimerInterval);
        this.recordTimerInterval = null;
      }
      if (this.visualizerAnimationId) {
        cancelAnimationFrame(this.visualizerAnimationId);
        this.visualizerAnimationId = null;
      }
      return new Promise((resolve, reject) => {
        if (!this.mediaRecorder) {
          return reject(new Error("No active recorder found."));
        }
        this.mediaRecorder.onstop = async () => {
          try {
            const blob = new Blob(this.recordChunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
            if (this.recordStream) {
              this.recordStream.getTracks().forEach((track) => track.stop());
              this.recordStream = null;
            }
            const buffer = await this.loadAudioFile(blob, "recorded_voice.wav");
            resolve(buffer);
          } catch (err) {
            reject(err);
          }
        };
        if (this.mediaRecorder.state !== "inactive") {
          this.mediaRecorder.stop();
        }
      });
    }
    /**
     * Renders the live audio visualizer loop on canvas
     */
    drawLiveVisualizer(canvas, dbMeterFill) {
      if (!canvas || !this.analyserNode) return;
      const ctx = canvas.getContext("2d");
      const analyser = this.analyserNode;
      const bufferLength = analyser.frequencyBinCount;
      const timeData = new Uint8Array(bufferLength);
      const render = () => {
        this.visualizerAnimationId = requestAnimationFrame(render);
        analyser.getByteTimeDomainData(timeData);
        ctx.fillStyle = "#05080f";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#6366f1";
        ctx.beginPath();
        const sliceWidth = canvas.width / bufferLength;
        let x = 0;
        let sumSq = 0;
        for (let i = 0; i < bufferLength; i++) {
          const v = timeData[i] / 128;
          const y = v * canvas.height / 2;
          const centered = v - 1;
          sumSq += centered * centered;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.stroke();
        if (dbMeterFill) {
          const rms = Math.sqrt(sumSq / bufferLength);
          const percent = Math.min(100, Math.max(0, rms * 350));
          dbMeterFill.style.height = `${percent}%`;
        }
      };
      render();
    }
    /**
     * Draws a static waveform representation of an AudioBuffer
     * @param {HTMLCanvasElement} canvas 
     * @param {AudioBuffer} buffer 
     */
    drawWaveform(canvas, buffer) {
      if (!canvas || !buffer) return;
      const ctx = canvas.getContext("2d");
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      const data = buffer.getChannelData(0);
      const step = Math.ceil(data.length / width);
      const amp = height / 2;
      ctx.fillStyle = "#6366f1";
      for (let i = 0; i < width; i++) {
        let min = 1;
        let max = -1;
        const start = i * step;
        for (let j = 0; j < step; j++) {
          const val = data[start + j] || 0;
          if (val < min) min = val;
          if (val > max) max = val;
        }
        const y1 = Math.max(0, (1 + min) * amp);
        const y2 = Math.min(height, (1 + max) * amp);
        const barHeight = Math.max(2, y2 - y1);
        ctx.fillRect(i, y1, 1, barHeight);
      }
    }
    // =========================================================================
    // Mode A: Web Speech API (TTS) Methods
    // =========================================================================
    /**
     * Loads speech synthesis voices and notifies callback whenever voices update
     * @param {function} [onVoicesChanged]
     * @returns {Promise<Array<SpeechSynthesisVoice>>}
     */
    loadVoices(onVoicesChanged = null) {
      if (onVoicesChanged) {
        this.onVoicesChangedCallback = onVoicesChanged;
      }
      return new Promise((resolve) => {
        const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
        if (!synth) return resolve([]);
        const updateVoices = () => {
          const voices = synth.getVoices();
          if (voices && voices.length > 0) {
            this.voices = voices;
            if (typeof this.onVoicesChangedCallback === "function") {
              this.onVoicesChangedCallback(this.voices);
            }
            resolve(voices);
          }
        };
        updateVoices();
        if (synth.onvoiceschanged !== void 0) {
          synth.onvoiceschanged = () => {
            updateVoices();
          };
        }
        [100, 300, 600, 1200].forEach((ms) => {
          setTimeout(() => {
            if (!this.voices.length || this.voices.length !== synth.getVoices().length) {
              updateVoices();
            }
          }, ms);
        });
      });
    }
    /**
     * Checks whether the local Node backend (/api/health) is running.
     * @param {number} [timeoutMs=1500]
     * @returns {Promise<boolean>}
     */
    async checkBackend(timeoutMs = 1500) {
      try {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        let timer = null;
        if (controller) {
          timer = setTimeout(() => controller.abort(), timeoutMs);
        }
        const healthUrl = getApiUrl("/api/health");
        const resp = await fetch(healthUrl, {
          method: "GET",
          signal: controller ? controller.signal : void 0
        });
        if (timer) clearTimeout(timer);
        if (!resp.ok) return false;
        const data = await resp.json();
        return Boolean(data && data.ok && data.tts);
      } catch (e) {
        return false;
      }
    }
    /**
     * Previews sample speech using the Neural TTS server endpoint (/api/tts)
     * Plays the audio immediately through HTML5 Audio / Web Audio.
     * On failure, invokes onError(err) callback before falling back to browser voice.
     * @param {string} text 
     * @param {object} ttsOptions 
     * @param {function} onStart 
     * @param {function} onEnd 
     * @param {function} onError 
     */
    async previewNeuralVoice(text, ttsOptions = {}, onStart = null, onEnd = null, onError = null) {
      this.stopSpeaking();
      this.ttsIsSpeaking = true;
      if (typeof onStart === "function") onStart();
      const errCallback = typeof onError === "function" ? onError : typeof (ttsOptions == null ? void 0 : ttsOptions.onError) === "function" ? ttsOptions.onError : null;
      try {
        const v = ttsOptions.voice;
        let voiceName = v && (v.voiceURI || v.name) || (typeof v === "string" ? v : "");
        const isHindi = /[\u0900-\u097F]/.test(text);
        if (!voiceName || !voiceName.includes("Neural") && isHindi) {
          voiceName = "hi-IN-SwaraNeural";
        } else if (!voiceName) {
          voiceName = "en-IN-NeerjaNeural";
        }
        const rate = ttsOptions.rate !== void 0 ? ttsOptions.rate : 1;
        const pitch = ttsOptions.pitch !== void 0 ? ttsOptions.pitch : 1;
        const volume = ttsOptions.volume !== void 0 ? Number(ttsOptions.volume) : 1;
        const ttsUrl = getApiUrl("/api/tts");
        const resp = await fetch(ttsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: voiceName,
            rate,
            pitch,
            volume
          })
        });
        if (resp.status === 404) {
          throw new Error("server not running \u2013 open the app via `npm start` at http://localhost:3000");
        }
        if (!resp.ok) {
          let serverErr = `TTS server returned status ${resp.status}`;
          try {
            const errBody = await resp.json();
            if (errBody && errBody.error) {
              serverErr = errBody.error;
            }
          } catch (e) {
          }
          throw new Error(serverErr);
        }
        const blob = await resp.blob();
        const audioUrl = typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : "mock-audio-url";
        if (typeof Audio !== "undefined") {
          const audio = new Audio(audioUrl);
          const validVol = Math.max(0, Math.min(1, isNaN(volume) ? 1 : volume));
          audio.volume = validVol;
          this.currentAudioPreview = audio;
          audio.onended = () => {
            if (!this.isSpeakingChunks) {
              this.ttsIsSpeaking = false;
            }
            this.currentAudioPreview = null;
            if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(audioUrl);
            if (typeof onEnd === "function") onEnd();
          };
          audio.onerror = (err) => {
            console.warn("[TTS] Neural audio playback error:", err);
            if (!this.isSpeakingChunks) {
              this.ttsIsSpeaking = false;
            }
            this.currentAudioPreview = null;
            if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(audioUrl);
            if (typeof onEnd === "function") onEnd();
          };
          await audio.play();
        } else {
          if (!this.isSpeakingChunks) {
            this.ttsIsSpeaking = false;
          }
          if (typeof onEnd === "function") onEnd();
        }
      } catch (err) {
        const isAbort = err.name === "AbortError" || err.message && err.message.includes("interrupted");
        if (isAbort) {
          this.ttsIsSpeaking = false;
          return;
        }
        console.warn("[TTS] Neural preview failed, calling onError before browser fallback:", err.message || err);
        if (typeof errCallback === "function") {
          try {
            errCallback(err);
          } catch (cbErr) {
            console.error("[TTS] Error in onError callback:", cbErr);
          }
        }
        this.speakSingleBrowser(text, ttsOptions, onStart, onEnd);
      }
    }
    /**
     * Speaks a single sample text for quick preview
     * @param {string} text 
     * @param {object} ttsOptions 
     * @param {function} onStart 
     * @param {function} onEnd 
     * @param {function} onError
     */
    speakSingle(text, ttsOptions, onStart = null, onEnd = null, onError = null) {
      const v = ttsOptions == null ? void 0 : ttsOptions.voice;
      const vStr = typeof v === "string" ? v : (v == null ? void 0 : v.voiceURI) || (v == null ? void 0 : v.name) || "";
      const isNeural = vStr.includes("Neural");
      const isHindi = /[\u0900-\u097F]/.test(text);
      if (isNeural || isHindi && !this.voices.some((bv) => (bv.lang || "").toLowerCase().startsWith("hi"))) {
        return this.previewNeuralVoice(text, ttsOptions, onStart, onEnd, onError);
      }
      return this.speakSingleBrowser(text, ttsOptions, onStart, onEnd);
    }
    /**
     * Browser SpeechSynthesis fallback for system voices
     */
    speakSingleBrowser(text, ttsOptions, onStart = null, onEnd = null) {
      if (typeof window === "undefined" || !window.speechSynthesis || !text) {
        if (typeof onEnd === "function") onEnd();
        return;
      }
      this.stopSpeaking();
      const synth = window.speechSynthesis;
      if (synth.paused) synth.resume();
      const utterance = new SpeechSynthesisUtterance(text);
      const isHindi = /[\u0900-\u097F]/.test(text);
      if (ttsOptions.voice && typeof ttsOptions.voice === "object" && ttsOptions.voice.voiceURI && !ttsOptions.voice.voiceURI.includes("Neural")) {
        utterance.voice = ttsOptions.voice;
        utterance.lang = ttsOptions.voice.lang || (isHindi ? "hi-IN" : "en-US");
      } else {
        const matchVoice = this.voices.find((v) => (v.lang || "").toLowerCase().startsWith(isHindi ? "hi" : "en"));
        if (matchVoice) {
          utterance.voice = matchVoice;
          utterance.lang = matchVoice.lang;
        } else {
          utterance.lang = isHindi ? "hi-IN" : navigator.language || "en-US";
        }
      }
      utterance.rate = ttsOptions.rate || 1;
      utterance.pitch = ttsOptions.pitch || 1;
      utterance.volume = ttsOptions.volume !== void 0 ? ttsOptions.volume : 1;
      this.currentUtterance = utterance;
      utterance.onstart = () => {
        this.ttsIsSpeaking = true;
        if (typeof onStart === "function") onStart();
      };
      utterance.onend = () => {
        this.ttsIsSpeaking = false;
        this.currentUtterance = null;
        if (typeof onEnd === "function") onEnd();
      };
      utterance.onerror = (err) => {
        console.warn("[TTS] Single speech error:", err);
        this.ttsIsSpeaking = false;
        this.currentUtterance = null;
        if (typeof onEnd === "function") onEnd();
      };
      synth.speak(utterance);
    }
    /**
     * Speaks a series of caption chunks sequentially to prevent browser speech cutoff
     * @param {Array<string>} chunks 
     * @param {object} ttsOptions 
     * @param {function} onChunkStart 
     * @param {function} onFinished 
     */
    speakChunks(chunks, ttsOptions, onChunkStart, onFinished) {
      if (!chunks || !chunks.length) return;
      const v = ttsOptions == null ? void 0 : ttsOptions.voice;
      const vStr = typeof v === "string" ? v : (v == null ? void 0 : v.voiceURI) || (v == null ? void 0 : v.name) || "";
      const isNeural = vStr.includes("Neural");
      if (isNeural) {
        this.stopSpeaking();
        this.isSpeakingChunks = true;
        this.ttsIsSpeaking = true;
        let currentIndex2 = 0;
        const speakNextNeural = async () => {
          if (!this.isSpeakingChunks || currentIndex2 >= chunks.length) {
            this.stopSpeaking();
            if (typeof onFinished === "function") onFinished();
            return;
          }
          const text = chunks[currentIndex2];
          if (typeof onChunkStart === "function") {
            onChunkStart(currentIndex2, text);
          }
          await this.previewNeuralVoice(
            text,
            ttsOptions,
            null,
            () => {
              if (this.isSpeakingChunks) {
                currentIndex2++;
                setTimeout(speakNextNeural, 120);
              }
            }
          );
        };
        speakNextNeural();
        return;
      }
      if (!window.speechSynthesis) return;
      this.stopSpeaking();
      const synth = window.speechSynthesis;
      if (synth.paused) synth.resume();
      let currentIndex = 0;
      this.ttsIsSpeaking = true;
      this.ttsKeepAliveTimer = setInterval(() => {
        if (synth.speaking) {
          synth.pause();
          synth.resume();
        }
      }, 1e4);
      const speakNext = () => {
        if (!this.ttsIsSpeaking || currentIndex >= chunks.length) {
          this.stopSpeaking();
          if (typeof onFinished === "function") onFinished();
          return;
        }
        const text = chunks[currentIndex];
        const utterance = new SpeechSynthesisUtterance(text);
        const isHindi = /[\u0900-\u097F]/.test(text);
        if (ttsOptions.voice && typeof ttsOptions.voice === "object" && ttsOptions.voice.voiceURI && !ttsOptions.voice.voiceURI.includes("Neural")) {
          utterance.voice = ttsOptions.voice;
          utterance.lang = ttsOptions.voice.lang || (isHindi ? "hi-IN" : "en-US");
        } else {
          const matchVoice = this.voices.find((v2) => (v2.lang || "").toLowerCase().startsWith(isHindi ? "hi" : "en"));
          if (matchVoice) {
            utterance.voice = matchVoice;
            utterance.lang = matchVoice.lang;
          } else {
            utterance.lang = isHindi ? "hi-IN" : navigator.language || "en-US";
          }
        }
        utterance.rate = ttsOptions.rate || 1;
        utterance.pitch = ttsOptions.pitch || 1;
        utterance.volume = ttsOptions.volume !== void 0 ? ttsOptions.volume : 1;
        if (typeof onChunkStart === "function") {
          onChunkStart(currentIndex, text);
        }
        utterance.onend = () => {
          currentIndex++;
          setTimeout(speakNext, 120);
        };
        utterance.onerror = (err) => {
          console.warn("[TTS] Speech error:", err);
          currentIndex++;
          setTimeout(speakNext, 100);
        };
        this.currentUtterance = utterance;
        synth.speak(utterance);
      };
      speakNext();
    }
    /**
     * Stops TTS playback and clears keep-alive
     */
    stopSpeaking() {
      this.isSpeakingChunks = false;
      this.ttsIsSpeaking = false;
      if (this.currentAudioPreview) {
        try {
          this.currentAudioPreview.pause();
          this.currentAudioPreview.currentTime = 0;
        } catch (e) {
        }
        this.currentAudioPreview = null;
      }
      if (this.ttsKeepAliveTimer) {
        clearInterval(this.ttsKeepAliveTimer);
        this.ttsKeepAliveTimer = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch (e) {
        }
      }
      this.currentUtterance = null;
    }
  };

  // js/captions.js
  function countSpokenUnits(text) {
    if (!text) return 1;
    const devanagariMatches = text.match(/[\u0904-\u0939\u0958-\u0961]/g);
    const devanagariCount = devanagariMatches ? devanagariMatches.length : 0;
    const nonDevanagari = text.replace(/[\u0900-\u097F]/g, " ");
    const words = nonDevanagari.match(/[a-zA-Z0-9]+/g) || [];
    let latinSyllables = 0;
    for (const w of words) {
      const vowelMatches = w.toLowerCase().replace(/e$/, "").match(/[aeiouy]{1,2}/g);
      latinSyllables += Math.max(1, vowelMatches ? vowelMatches.length : 1);
    }
    const baseUnits = devanagariCount + latinSyllables;
    return Math.max(1, baseUnits);
  }
  function getSentenceWeight(sentence) {
    const units = countSpokenUnits(sentence);
    let pauseWeight = 0;
    if (/[।\.\?!]/.test(sentence)) {
      pauseWeight = 2;
    } else if (/[,;،]/.test(sentence)) {
      pauseWeight = 0.8;
    }
    return units + pauseWeight;
  }
  function detectSpeechRegionFromBuffer(audioBuffer, silenceThreshold = 0.015) {
    if (!audioBuffer) return null;
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    const windowSize = Math.floor(sampleRate * 0.02);
    const hopSize = Math.floor(sampleRate * 0.01);
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
        lastSpeech = t + windowSize / sampleRate;
      }
    }
    if (firstSpeech < 0) return null;
    return {
      start: Math.max(0, firstSpeech - 0.05),
      end: Math.min(audioBuffer.duration, lastSpeech + 0.05)
    };
  }
  var CaptionEngine = class {
    constructor() {
      this.scriptText = "";
      this.chunks = [];
    }
    /**
     * Splits a script into sentence chunks respecting Hindi Danda '।', '.', '?', '!', newlines,
     * and caps chunk length to ~90 characters by splitting at commas or spaces.
     * @param {string} text 
     * @returns {Array<string>}
     */
    splitScriptIntoSentences(text) {
      if (!text || !text.trim()) return [];
      const rawSentences = text.split(/([।\.\?!;\n\r]+)/g).reduce((acc, part, idx, arr) => {
        if (idx % 2 === 0) {
          const punctuation = arr[idx + 1] || "";
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
          const subParts = sentence.split(/([,،\s]+)/g);
          let currentChunk = "";
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
      const weights = rawSentences.map((s) => getSentenceWeight(s));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      const chunks = [];
      let cumulativeWeight = 0;
      for (let i = 0; i < rawSentences.length; i++) {
        const sentence = rawSentences[i];
        const w = weights[i];
        const rawStart = speechStart + cumulativeWeight / totalWeight * speechDuration;
        cumulativeWeight += w;
        const rawEnd = speechStart + cumulativeWeight / totalWeight * speechDuration;
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
      if (silenceGaps && silenceGaps.length > 0) {
        const SNAP_TOLERANCE_SEC = 2;
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
      for (let i = 0; i < chunks.length - 1; i++) {
        if (chunks[i].end > chunks[i + 1].start) {
          const mid = (chunks[i].start + chunks[i + 1].end) / 2;
          chunks[i].end = mid;
          chunks[i].duration = Math.max(0.1, chunks[i].end - chunks[i].start);
          chunks[i + 1].start = mid;
          chunks[i + 1].duration = Math.max(0.1, chunks[i + 1].end - chunks[i + 1].start);
        }
      }
      if (chunks.length > 0 && (!audioBuffer || speechStart < 0.1)) {
        chunks[0].start = 0;
        chunks[0].duration = chunks[0].end - chunks[0].start;
      }
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
      const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
      const normalizedScript = normalize(scriptText);
      const chunkConcat = normalize((this.chunks || []).map((c) => c.text).join(" "));
      if (normalizedScript !== chunkConcat) {
        console.warn("[Captions] Integrity mismatch: chunks do not match script text. Auto-fixing.");
        const sentences = this.splitScriptIntoSentences(scriptText);
        const totalDur = this.chunks && this.chunks.length > 0 ? this.chunks[this.chunks.length - 1].end : 10;
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
      const mins = Math.floor(s % 3600 / 60);
      const secs = Math.floor(s % 60);
      const millis = Math.floor(s % 1 * 1e3);
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
    }
    /**
     * Formats seconds into VTT timestamp format: HH:MM:SS.mmm
     * @param {number} seconds 
     * @returns {string}
     */
    formatVttTimestamp(seconds) {
      return this.formatSrtTimestamp(seconds).replace(",", ".");
    }
    /**
     * Generates SubRip (.srt) subtitle content
     * @param {Array<object>} [customChunks]
     * @returns {string}
     */
    generateSRT(customChunks = null) {
      const items = customChunks || this.chunks;
      return items.map((item, idx) => {
        const start = this.formatSrtTimestamp(item.start);
        const end = this.formatSrtTimestamp(item.end);
        return `${idx + 1}
${start} --> ${end}
${item.text.trim()}
`;
      }).join("\n");
    }
    /**
     * Generates WebVTT (.vtt) subtitle content
     * @param {Array<object>} [customChunks]
     * @returns {string}
     */
    generateVTT(customChunks = null) {
      const items = customChunks || this.chunks;
      const body = items.map((item) => {
        const start = this.formatVttTimestamp(item.start);
        const end = this.formatVttTimestamp(item.end);
        return `${start} --> ${end}
${item.text.trim()}
`;
      }).join("\n");
      return `WEBVTT - FrameFlow Studio Captions

${body}`;
    }
    /**
     * Generates clean script text (.txt)
     * @param {Array<object>} [customChunks]
     * @returns {string}
     */
    generateTXT(customChunks = null) {
      const items = customChunks || this.chunks;
      return items.map((c) => c.text.trim()).join("\n");
    }
    /**
     * Triggers a browser file download of caption text
     * @param {string} content 
     * @param {string} filename 
     * @param {string} mimeType 
     */
    downloadFile(content, filename, mimeType = "text/plain") {
      const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
      const url2 = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url2), 2e3);
    }
  };

  // js/timeline.js
  var TimelineEngine = class {
    constructor() {
      this.segments = [];
      this.totalDuration = 60;
      this.transitionDuration = 0.6;
      this.transitionType = "crossfade";
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
        minDuration = 4,
        maxDuration = 8,
        enabledAnimations = ["zoom-in", "zoom-out", "pan-lr", "pan-rl", "pan-up", "pan-down", "diagonal"],
        maxZoom = 1.25,
        transitionDuration = 0.6,
        transitionType = "crossfade"
      } = options;
      this.totalDuration = Math.max(1, totalDuration);
      this.transitionDuration = Math.min(transitionDuration, minDuration * 0.4);
      this.transitionType = transitionType;
      const animPool = enabledAnimations.length > 0 ? enabledAnimations : ["zoom-in", "zoom-out"];
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
        let chosenPhoto = null;
        if (photos.length > 1) {
          let deckIndex = currentDeck.findIndex((p) => p.id !== lastPhotoId);
          if (deckIndex === -1) {
            const available = photos.filter((p) => p.id !== lastPhotoId);
            chosenPhoto = available[Math.floor(Math.random() * available.length)];
          } else {
            chosenPhoto = currentDeck.splice(deckIndex, 1)[0];
          }
        } else {
          chosenPhoto = photos[0];
        }
        lastPhotoId = chosenPhoto.id;
        let dur = minDuration + Math.random() * (maxDuration - minDuration);
        const remainingTime = this.totalDuration - currentTime;
        if (remainingTime <= maxDuration * 1.2) {
          dur = remainingTime;
        }
        dur = Math.max(minDuration * 0.5, dur);
        const animType = animPool[Math.floor(Math.random() * animPool.length)];
        let zoomStart = 1;
        let zoomEnd = 1;
        let panXStart = 0;
        let panXEnd = 0;
        let panYStart = 0;
        let panYEnd = 0;
        switch (animType) {
          case "zoom-in":
            zoomStart = 1;
            zoomEnd = maxZoom;
            break;
          case "zoom-out":
            zoomStart = maxZoom;
            zoomEnd = 1;
            break;
          case "pan-lr":
            zoomStart = maxZoom;
            zoomEnd = maxZoom;
            panXStart = -1;
            panXEnd = 1;
            break;
          case "pan-rl":
            zoomStart = maxZoom;
            zoomEnd = maxZoom;
            panXStart = 1;
            panXEnd = -1;
            break;
          case "pan-up":
            zoomStart = maxZoom;
            zoomEnd = maxZoom;
            panYStart = 1;
            panYEnd = -1;
            break;
          case "pan-down":
            zoomStart = maxZoom;
            zoomEnd = maxZoom;
            panYStart = -1;
            panYEnd = 1;
            break;
          case "diagonal":
            zoomStart = 1.08;
            zoomEnd = maxZoom;
            panXStart = -0.8;
            panXEnd = 0.8;
            panYStart = -0.8;
            panYEnd = 0.8;
            break;
          default:
            zoomStart = 1;
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
      let zoomStart = 1;
      let zoomEnd = 1;
      let panXStart = 0;
      let panXEnd = 0;
      let panYStart = 0;
      let panYEnd = 0;
      switch (animType) {
        case "zoom-in":
          zoomStart = 1;
          zoomEnd = maxZoom;
          break;
        case "zoom-out":
          zoomStart = maxZoom;
          zoomEnd = 1;
          break;
        case "pan-lr":
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panXStart = -1;
          panXEnd = 1;
          break;
        case "pan-rl":
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panXStart = 1;
          panXEnd = -1;
          break;
        case "pan-up":
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panYStart = 1;
          panYEnd = -1;
          break;
        case "pan-down":
          zoomStart = maxZoom;
          zoomEnd = maxZoom;
          panYStart = -1;
          panYEnd = 1;
          break;
        case "diagonal":
          zoomStart = 1.08;
          zoomEnd = maxZoom;
          panXStart = -0.8;
          panXEnd = 0.8;
          panYStart = -0.8;
          panYEnd = 0.8;
          break;
        default:
          zoomStart = 1;
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
        enabledAnimations = ["zoom-in", "zoom-out", "pan-lr", "pan-rl", "pan-up", "pan-down", "diagonal"],
        maxZoom = 1.25,
        transitionDuration = 0.6,
        transitionType = "crossfade"
      } = options;
      const animPool = enabledAnimations.length > 0 ? enabledAnimations : ["zoom-in", "zoom-out"];
      const photoMap = /* @__PURE__ */ new Map();
      photos.forEach((p) => photoMap.set(p.id, p));
      const lineDurations = [];
      let sumEstimated = 0;
      scriptLines.forEach((line, idx) => {
        let dur = 0;
        if (captionChunks && captionChunks[idx] && captionChunks[idx].end > captionChunks[idx].start) {
          dur = captionChunks[idx].end - captionChunks[idx].start;
        } else {
          const text = typeof line === "string" ? line : line.text || "";
          const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
          dur = Math.max(2.5, wordCount / 2.4);
        }
        lineDurations.push(dur);
        sumEstimated += dur;
      });
      const scaleFactor = totalDuration && (!captionChunks || captionChunks.length === 0) ? totalDuration / sumEstimated : 1;
      this.totalDuration = totalDuration || sumEstimated;
      this.transitionDuration = Math.min(transitionDuration, 1.5);
      this.transitionType = transitionType;
      const segments = [];
      let currentTime = 0;
      const photoAnimCounters = /* @__PURE__ */ new Map();
      scriptLines.forEach((line, idx) => {
        const match = sceneMatches.find((m) => m.line_index === idx);
        let photoId = match == null ? void 0 : match.photo_id;
        let photo = photoMap.get(photoId);
        if (!photo) {
          photo = photos[idx % photos.length];
          photoId = photo.id;
        }
        const timesUsed = photoAnimCounters.get(photoId) || 0;
        photoAnimCounters.set(photoId, timesUsed + 1);
        const animIdx = (idx + timesUsed) % animPool.length;
        const animType = animPool[animIdx];
        const animParams = this.computeAnimParams(animType, maxZoom);
        let dur = lineDurations[idx] * scaleFactor;
        if (idx === scriptLines.length - 1 && totalDuration) {
          dur = Math.max(1, totalDuration - currentTime);
        }
        const segment = {
          id: `seg_${idx}`,
          photo,
          lineIndex: idx,
          lineText: typeof line === "string" ? line : line.text || "",
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
      let curIdx = this.segments.findIndex((s) => clampedT >= s.startTime && clampedT < s.endTime);
      if (curIdx === -1) {
        curIdx = this.segments.length - 1;
      }
      const curSeg = this.segments[curIdx];
      let nextSeg = null;
      let transProgress = 0;
      const timeUntilEnd = curSeg.endTime - clampedT;
      if (timeUntilEnd <= this.transitionDuration && curIdx + 1 < this.segments.length) {
        nextSeg = this.segments[curIdx + 1];
        transProgress = 1 - timeUntilEnd / this.transitionDuration;
        transProgress = Math.max(0, Math.min(1, transProgress));
      }
      return {
        currentSegment: curSeg,
        nextSegment: nextSeg,
        transitionProgress: transProgress
      };
    }
  };

  // js/renderer.js
  var FrameRenderer = class {
    constructor(extractor) {
      this.extractor = extractor;
      this.blurCanvas = document.createElement("canvas");
      this.blurCtx = this.blurCanvas.getContext("2d");
      this.grainCanvas = document.createElement("canvas");
      this.grainCanvas.width = 256;
      this.grainCanvas.height = 256;
      this.initFilmGrainPattern();
    }
    /**
     * Pre-renders a subtle film grain pattern canvas for high-performance repetition
     */
    initFilmGrainPattern() {
      const ctx = this.grainCanvas.getContext("2d");
      const imgData = ctx.createImageData(256, 256);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 50;
        data[i] = 128 + noise;
        data[i + 1] = 128 + noise;
        data[i + 2] = 128 + noise;
        data[i + 3] = 40;
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
      let currentLine = "";
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
              const remaining = words.slice(i).join(" ");
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
      ctx.imageSmoothingQuality = "high";
      const imgAspect = img.width / img.height;
      const canvasAspect = width / height;
      const isRatioMatch = Math.abs(imgAspect - canvasAspect) / canvasAspect < 0.02;
      const isCropped = (segment == null ? void 0 : segment.photo) ? segment.photo.isCropped !== false : true;
      const matchesSelectedFrame = isCropped && isRatioMatch;
      if (matchesSelectedFrame && state.verticalModeLayout !== "blur-bg") {
        ctx.drawImage(img, 0, 0, width, height);
        return;
      }
      const bgScale = Math.max(width / img.width, height / img.height);
      const bgW = img.width * bgScale;
      const bgH = img.height * bgScale;
      const bgX = (width - bgW) / 2;
      const bgY = (height - bgH) / 2;
      ctx.save();
      ctx.filter = "blur(28px) brightness(0.65)";
      ctx.drawImage(img, bgX, bgY, bgW, bgH);
      ctx.restore();
      const fitScale = height > width ? Math.min(width / img.width, height * 0.75 / img.height) : Math.min(width / img.width, height / img.height);
      const safeScale = img.width < width && img.height < height && fitScale > 1 ? 1 : fitScale;
      const fgWidth = Math.round(img.width * safeScale);
      const fgHeight = Math.round(img.height * safeScale);
      const fgX = Math.round((width - fgWidth) / 2);
      const fgY = Math.round((height - fgHeight) / 2);
      ctx.save();
      ctx.filter = "none";
      ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
      ctx.shadowBlur = 30;
      ctx.drawImage(img, fgX, fgY, fgWidth, fgHeight);
      ctx.restore();
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
    drawCaptions(ctx, caption, t, width, height, styling) {
      if (!caption || !caption.text) return;
      const FADE_DUR = 0.15;
      let alpha = 1;
      const timeSinceStart = t - caption.start;
      const timeUntilEnd = caption.end - t;
      if (timeSinceStart < FADE_DUR) {
        alpha = Math.max(0, timeSinceStart / FADE_DUR);
      } else if (timeUntilEnd < FADE_DUR) {
        alpha = Math.max(0, timeUntilEnd / FADE_DUR);
      }
      ctx.save();
      ctx.globalAlpha *= alpha;
      const fontSize = styling.fontSize || 42;
      const fontFamily = styling.fontFamily || "'Noto Sans Devanagari', sans-serif";
      ctx.font = `700 ${fontSize}px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const maxTextWidth = width * 0.82;
      const lines = this.wrapText(ctx, caption.text, maxTextWidth, 2);
      if (!lines.length) {
        ctx.restore();
        return;
      }
      const lineHeight = Math.round(fontSize * 1.35);
      const totalBlockHeight = lines.length * lineHeight;
      let blockCenterY = Math.round(height * 0.82);
      if (styling.position === "top") {
        blockCenterY = Math.round(height * 0.15);
      } else if (styling.position === "center") {
        blockCenterY = Math.round(height * 0.5);
      }
      if (width < height && styling.position === "bottom") {
        blockCenterY = Math.round(height * 0.76);
      }
      const startY = Math.round(blockCenterY - totalBlockHeight / 2 + lineHeight / 2);
      if (styling.boxEnabled) {
        const boxOpacity = (styling.boxOpacity !== void 0 ? styling.boxOpacity : 65) / 100;
        ctx.fillStyle = `rgba(10, 14, 23, ${boxOpacity})`;
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
        const boxY = Math.round(blockCenterY - totalBlockHeight / 2 - boxPaddingY);
        const radius = 12;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxWidth, boxHeight, radius);
        ctx.fill();
      }
      const chunkDuration = Math.max(0.1, caption.end - caption.start);
      const progressInChunk = Math.max(0, Math.min(1, (t - caption.start) / chunkDuration));
      for (let li = 0; li < lines.length; li++) {
        const lineText = lines[li];
        const lineY = Math.round(startY + li * lineHeight);
        if (styling.outlineThickness > 0) {
          ctx.strokeStyle = styling.outlineColor || "#000000";
          ctx.lineWidth = styling.outlineThickness * 2;
          ctx.lineJoin = "round";
          ctx.strokeText(lineText, Math.round(width / 2), lineY);
        }
        ctx.fillStyle = styling.textColor || "#ffffff";
        if (styling.karaokeEnabled) {
          const words = lineText.split(" ");
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
          const lineWidth = ctx.measureText(lineText).width;
          let cursorX = Math.round((width - lineWidth) / 2);
          ctx.textAlign = "left";
          for (let wi = 0; wi < words.length; wi++) {
            const w = words[wi];
            const isHighlighted = wi <= currentActiveWordIdx;
            ctx.fillStyle = isHighlighted ? styling.highlightColor || "#fbbf24" : styling.textColor || "#ffffff";
            ctx.fillText(w, cursorX, lineY);
            cursorX += Math.round(ctx.measureText(w + " ").width);
          }
          ctx.textAlign = "center";
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
        width / 2,
        height / 2,
        radius * 0.35,
        width / 2,
        height / 2,
        radius
      );
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
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
      ctx.globalCompositeOperation = "overlay";
      const pattern = ctx.createPattern(this.grainCanvas, "repeat");
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
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);
      const timelineData = appState.timelineEngine.getActiveSegments(t);
      const { currentSegment, nextSegment, transitionProgress } = timelineData;
      if (!currentSegment) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const grading = appState.colorGrading || {};
      const contrast = 100 + (grading.contrast || 5);
      const saturation = grading.saturation !== void 0 ? grading.saturation : 105;
      ctx.filter = `contrast(${contrast}%) saturate(${saturation}%)`;
      const currentImg = await this.extractor.getBitmap(currentSegment.photo);
      if (currentImg) {
        this.drawSegmentPhoto(ctx, currentImg, currentSegment, t, width, height, appState);
      }
      if (nextSegment && transitionProgress > 0) {
        const nextImg = await this.extractor.getBitmap(nextSegment.photo);
        if (nextImg) {
          ctx.save();
          if (appState.transitionType === "dip-to-black") {
            const blackAlpha = transitionProgress < 0.5 ? transitionProgress * 2 : (1 - transitionProgress) * 2;
            ctx.fillStyle = `rgba(0, 0, 0, ${blackAlpha})`;
            ctx.fillRect(0, 0, width, height);
            if (transitionProgress >= 0.5) {
              ctx.globalAlpha = (transitionProgress - 0.5) * 2;
              this.drawSegmentPhoto(ctx, nextImg, nextSegment, t, width, height, appState);
            }
          } else {
            ctx.globalAlpha = transitionProgress;
            this.drawSegmentPhoto(ctx, nextImg, nextSegment, t, width, height, appState);
          }
          ctx.restore();
        }
      }
      ctx.filter = "none";
      const overlays = appState.overlays || {};
      this.drawVignette(ctx, width, height, (overlays.vignette !== void 0 ? overlays.vignette : 35) / 100);
      this.drawFilmGrain(ctx, width, height, (overlays.filmGrain !== void 0 ? overlays.filmGrain : 15) / 100);
      const activeCaption = appState.captionEngine.getCaptionAtTime(t);
      if (activeCaption) {
        this.drawCaptions(ctx, activeCaption, t, width, height, appState.captionStyle);
      }
    }
  };

  // js/vendor/mp4-muxer.mjs
  var __accessCheck = (obj, member, msg) => {
    if (!member.has(obj))
      throw TypeError("Cannot " + msg);
  };
  var __privateGet = (obj, member, getter) => {
    __accessCheck(obj, member, "read from private field");
    return getter ? getter.call(obj) : member.get(obj);
  };
  var __privateAdd = (obj, member, value) => {
    if (member.has(obj))
      throw TypeError("Cannot add the same private member more than once");
    member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  };
  var __privateSet = (obj, member, value, setter) => {
    __accessCheck(obj, member, "write to private field");
    setter ? setter.call(obj, value) : member.set(obj, value);
    return value;
  };
  var __privateWrapper = (obj, member, setter, getter) => ({
    set _(value) {
      __privateSet(obj, member, value, setter);
    },
    get _() {
      return __privateGet(obj, member, getter);
    }
  });
  var __privateMethod = (obj, member, method) => {
    __accessCheck(obj, member, "access private method");
    return method;
  };
  var bytes = new Uint8Array(8);
  var view = new DataView(bytes.buffer);
  var u8 = (value) => {
    return [(value % 256 + 256) % 256];
  };
  var u16 = (value) => {
    view.setUint16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var i16 = (value) => {
    view.setInt16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var u24 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[1], bytes[2], bytes[3]];
  };
  var u32 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var i32 = (value) => {
    view.setInt32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var u64 = (value) => {
    view.setUint32(0, Math.floor(value / 2 ** 32), false);
    view.setUint32(4, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
  };
  var fixed_8_8 = (value) => {
    view.setInt16(0, 2 ** 8 * value, false);
    return [bytes[0], bytes[1]];
  };
  var fixed_16_16 = (value) => {
    view.setInt32(0, 2 ** 16 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var fixed_2_30 = (value) => {
    view.setInt32(0, 2 ** 30 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var ascii = (text, nullTerminated = false) => {
    let bytes2 = Array(text.length).fill(null).map((_, i) => text.charCodeAt(i));
    if (nullTerminated)
      bytes2.push(0);
    return bytes2;
  };
  var last = (arr) => {
    return arr && arr[arr.length - 1];
  };
  var lastPresentedSample = (samples) => {
    let result = void 0;
    for (let sample of samples) {
      if (!result || sample.presentationTimestamp > result.presentationTimestamp) {
        result = sample;
      }
    }
    return result;
  };
  var intoTimescale = (timeInSeconds, timescale, round = true) => {
    let value = timeInSeconds * timescale;
    return round ? Math.round(value) : value;
  };
  var rotationMatrix = (rotationInDegrees) => {
    let theta = rotationInDegrees * (Math.PI / 180);
    let cosTheta = Math.cos(theta);
    let sinTheta = Math.sin(theta);
    return [
      cosTheta,
      sinTheta,
      0,
      -sinTheta,
      cosTheta,
      0,
      0,
      0,
      1
    ];
  };
  var IDENTITY_MATRIX = rotationMatrix(0);
  var matrixToBytes = (matrix) => {
    return [
      fixed_16_16(matrix[0]),
      fixed_16_16(matrix[1]),
      fixed_2_30(matrix[2]),
      fixed_16_16(matrix[3]),
      fixed_16_16(matrix[4]),
      fixed_2_30(matrix[5]),
      fixed_16_16(matrix[6]),
      fixed_16_16(matrix[7]),
      fixed_2_30(matrix[8])
    ];
  };
  var deepClone = (x) => {
    if (!x)
      return x;
    if (typeof x !== "object")
      return x;
    if (Array.isArray(x))
      return x.map(deepClone);
    return Object.fromEntries(Object.entries(x).map(([key, value]) => [key, deepClone(value)]));
  };
  var isU32 = (value) => {
    return value >= 0 && value < 2 ** 32;
  };
  var box = (type, contents, children) => ({
    type,
    contents: contents && new Uint8Array(contents.flat(10)),
    children
  });
  var fullBox = (type, version, flags, contents, children) => box(
    type,
    [u8(version), u24(flags), contents ?? []],
    children
  );
  var ftyp = (details) => {
    let minorVersion = 512;
    if (details.fragmented)
      return box("ftyp", [
        ascii("iso5"),
        // Major brand
        u32(minorVersion),
        // Minor version
        // Compatible brands
        ascii("iso5"),
        ascii("iso6"),
        ascii("mp41")
      ]);
    return box("ftyp", [
      ascii("isom"),
      // Major brand
      u32(minorVersion),
      // Minor version
      // Compatible brands
      ascii("isom"),
      details.holdsAvc ? ascii("avc1") : [],
      ascii("mp41")
    ]);
  };
  var mdat = (reserveLargeSize) => ({ type: "mdat", largeSize: reserveLargeSize });
  var free = (size) => ({ type: "free", size });
  var moov = (tracks, creationTime, fragmented = false) => box("moov", null, [
    mvhd(creationTime, tracks),
    ...tracks.map((x) => trak(x, creationTime)),
    fragmented ? mvex(tracks) : null
  ]);
  var mvhd = (creationTime, tracks) => {
    let duration = intoTimescale(Math.max(
      0,
      ...tracks.filter((x) => x.samples.length > 0).map((x) => {
        const lastSample = lastPresentedSample(x.samples);
        return lastSample.presentationTimestamp + lastSample.duration;
      })
    ), GLOBAL_TIMESCALE);
    let nextTrackId = Math.max(...tracks.map((x) => x.id)) + 1;
    let needsU64 = !isU32(creationTime) || !isU32(duration);
    let u32OrU64 = needsU64 ? u64 : u32;
    return fullBox("mvhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(GLOBAL_TIMESCALE),
      // Timescale
      u32OrU64(duration),
      // Duration
      fixed_16_16(1),
      // Preferred rate
      fixed_8_8(1),
      // Preferred volume
      Array(10).fill(0),
      // Reserved
      matrixToBytes(IDENTITY_MATRIX),
      // Matrix
      Array(24).fill(0),
      // Pre-defined
      u32(nextTrackId)
      // Next track ID
    ]);
  };
  var trak = (track, creationTime) => box("trak", null, [
    tkhd(track, creationTime),
    mdia(track, creationTime)
  ]);
  var tkhd = (track, creationTime) => {
    let lastSample = lastPresentedSample(track.samples);
    let durationInGlobalTimescale = intoTimescale(
      lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
      GLOBAL_TIMESCALE
    );
    let needsU64 = !isU32(creationTime) || !isU32(durationInGlobalTimescale);
    let u32OrU64 = needsU64 ? u64 : u32;
    let matrix;
    if (track.info.type === "video") {
      matrix = typeof track.info.rotation === "number" ? rotationMatrix(track.info.rotation) : track.info.rotation;
    } else {
      matrix = IDENTITY_MATRIX;
    }
    return fullBox("tkhd", +needsU64, 3, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(track.id),
      // Track ID
      u32(0),
      // Reserved
      u32OrU64(durationInGlobalTimescale),
      // Duration
      Array(8).fill(0),
      // Reserved
      u16(0),
      // Layer
      u16(0),
      // Alternate group
      fixed_8_8(track.info.type === "audio" ? 1 : 0),
      // Volume
      u16(0),
      // Reserved
      matrixToBytes(matrix),
      // Matrix
      fixed_16_16(track.info.type === "video" ? track.info.width : 0),
      // Track width
      fixed_16_16(track.info.type === "video" ? track.info.height : 0)
      // Track height
    ]);
  };
  var mdia = (track, creationTime) => box("mdia", null, [
    mdhd(track, creationTime),
    hdlr(track.info.type === "video" ? "vide" : "soun"),
    minf(track)
  ]);
  var mdhd = (track, creationTime) => {
    let lastSample = lastPresentedSample(track.samples);
    let localDuration = intoTimescale(
      lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
      track.timescale
    );
    let needsU64 = !isU32(creationTime) || !isU32(localDuration);
    let u32OrU64 = needsU64 ? u64 : u32;
    return fullBox("mdhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(track.timescale),
      // Timescale
      u32OrU64(localDuration),
      // Duration
      u16(21956),
      // Language ("und", undetermined)
      u16(0)
      // Quality
    ]);
  };
  var hdlr = (componentSubtype) => fullBox("hdlr", 0, 0, [
    ascii("mhlr"),
    // Component type
    ascii(componentSubtype),
    // Component subtype
    u32(0),
    // Component manufacturer
    u32(0),
    // Component flags
    u32(0),
    // Component flags mask
    ascii("mp4-muxer-hdlr", true)
    // Component name
  ]);
  var minf = (track) => box("minf", null, [
    track.info.type === "video" ? vmhd() : smhd(),
    dinf(),
    stbl(track)
  ]);
  var vmhd = () => fullBox("vmhd", 0, 1, [
    u16(0),
    // Graphics mode
    u16(0),
    // Opcolor R
    u16(0),
    // Opcolor G
    u16(0)
    // Opcolor B
  ]);
  var smhd = () => fullBox("smhd", 0, 0, [
    u16(0),
    // Balance
    u16(0)
    // Reserved
  ]);
  var dinf = () => box("dinf", null, [
    dref()
  ]);
  var dref = () => fullBox("dref", 0, 0, [
    u32(1)
    // Entry count
  ], [
    url()
  ]);
  var url = () => fullBox("url ", 0, 1);
  var stbl = (track) => {
    const needsCtts = track.compositionTimeOffsetTable.length > 1 || track.compositionTimeOffsetTable.some((x) => x.sampleCompositionTimeOffset !== 0);
    return box("stbl", null, [
      stsd(track),
      stts(track),
      stss(track),
      stsc(track),
      stsz(track),
      stco(track),
      needsCtts ? ctts(track) : null
    ]);
  };
  var stsd = (track) => fullBox("stsd", 0, 0, [
    u32(1)
    // Entry count
  ], [
    track.info.type === "video" ? videoSampleDescription(
      VIDEO_CODEC_TO_BOX_NAME[track.info.codec],
      track
    ) : soundSampleDescription(
      AUDIO_CODEC_TO_BOX_NAME[track.info.codec],
      track
    )
  ]);
  var videoSampleDescription = (compressionType, track) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1),
    // Data reference index
    u16(0),
    // Pre-defined
    u16(0),
    // Reserved
    Array(12).fill(0),
    // Pre-defined
    u16(track.info.width),
    // Width
    u16(track.info.height),
    // Height
    u32(4718592),
    // Horizontal resolution
    u32(4718592),
    // Vertical resolution
    u32(0),
    // Reserved
    u16(1),
    // Frame count
    Array(32).fill(0),
    // Compressor name
    u16(24),
    // Depth
    i16(65535)
    // Pre-defined
  ], [
    VIDEO_CODEC_TO_CONFIGURATION_BOX[track.info.codec](track),
    track.info.decoderConfig.colorSpace ? colr(track) : null
  ]);
  var COLOR_PRIMARIES_MAP = {
    "bt709": 1,
    // ITU-R BT.709
    "bt470bg": 5,
    // ITU-R BT.470BG
    "smpte170m": 6
    // ITU-R BT.601 525 - SMPTE 170M
  };
  var TRANSFER_CHARACTERISTICS_MAP = {
    "bt709": 1,
    // ITU-R BT.709
    "smpte170m": 6,
    // SMPTE 170M
    "iec61966-2-1": 13
    // IEC 61966-2-1
  };
  var MATRIX_COEFFICIENTS_MAP = {
    "rgb": 0,
    // Identity
    "bt709": 1,
    // ITU-R BT.709
    "bt470bg": 5,
    // ITU-R BT.470BG
    "smpte170m": 6
    // SMPTE 170M
  };
  var colr = (track) => box("colr", [
    ascii("nclx"),
    // Colour type
    u16(COLOR_PRIMARIES_MAP[track.info.decoderConfig.colorSpace.primaries]),
    // Colour primaries
    u16(TRANSFER_CHARACTERISTICS_MAP[track.info.decoderConfig.colorSpace.transfer]),
    // Transfer characteristics
    u16(MATRIX_COEFFICIENTS_MAP[track.info.decoderConfig.colorSpace.matrix]),
    // Matrix coefficients
    u8((track.info.decoderConfig.colorSpace.fullRange ? 1 : 0) << 7)
    // Full range flag
  ]);
  var avcC = (track) => track.info.decoderConfig && box("avcC", [
    // For AVC, description is an AVCDecoderConfigurationRecord, so nothing else to do here
    ...new Uint8Array(track.info.decoderConfig.description)
  ]);
  var hvcC = (track) => track.info.decoderConfig && box("hvcC", [
    // For HEVC, description is a HEVCDecoderConfigurationRecord, so nothing else to do here
    ...new Uint8Array(track.info.decoderConfig.description)
  ]);
  var vpcC = (track) => {
    if (!track.info.decoderConfig) {
      return null;
    }
    let decoderConfig = track.info.decoderConfig;
    if (!decoderConfig.colorSpace) {
      throw new Error(`'colorSpace' is required in the decoder config for VP9.`);
    }
    let parts = decoderConfig.codec.split(".");
    let profile = Number(parts[1]);
    let level = Number(parts[2]);
    let bitDepth = Number(parts[3]);
    let chromaSubsampling = 0;
    let thirdByte = (bitDepth << 4) + (chromaSubsampling << 1) + Number(decoderConfig.colorSpace.fullRange);
    let colourPrimaries = 2;
    let transferCharacteristics = 2;
    let matrixCoefficients = 2;
    return fullBox("vpcC", 1, 0, [
      u8(profile),
      // Profile
      u8(level),
      // Level
      u8(thirdByte),
      // Bit depth, chroma subsampling, full range
      u8(colourPrimaries),
      // Colour primaries
      u8(transferCharacteristics),
      // Transfer characteristics
      u8(matrixCoefficients),
      // Matrix coefficients
      u16(0)
      // Codec initialization data size
    ]);
  };
  var av1C = () => {
    let marker = 1;
    let version = 1;
    let firstByte = (marker << 7) + version;
    return box("av1C", [
      firstByte,
      0,
      0,
      0
    ]);
  };
  var soundSampleDescription = (compressionType, track) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1),
    // Data reference index
    u16(0),
    // Version
    u16(0),
    // Revision level
    u32(0),
    // Vendor
    u16(track.info.numberOfChannels),
    // Number of channels
    u16(16),
    // Sample size (bits)
    u16(0),
    // Compression ID
    u16(0),
    // Packet size
    fixed_16_16(track.info.sampleRate)
    // Sample rate
  ], [
    AUDIO_CODEC_TO_CONFIGURATION_BOX[track.info.codec](track)
  ]);
  var esds = (track) => {
    let description = new Uint8Array(track.info.decoderConfig.description);
    return fullBox("esds", 0, 0, [
      // https://stackoverflow.com/a/54803118
      u32(58753152),
      // TAG(3) = Object Descriptor ([2])
      u8(32 + description.byteLength),
      // length of this OD (which includes the next 2 tags)
      u16(1),
      // ES_ID = 1
      u8(0),
      // flags etc = 0
      u32(75530368),
      // TAG(4) = ES Descriptor ([2]) embedded in above OD
      u8(18 + description.byteLength),
      // length of this ESD
      u8(64),
      // MPEG-4 Audio
      u8(21),
      // stream type(6bits)=5 audio, flags(2bits)=1
      u24(0),
      // 24bit buffer size
      u32(130071),
      // max bitrate
      u32(130071),
      // avg bitrate
      u32(92307584),
      // TAG(5) = ASC ([2],[3]) embedded in above OD
      u8(description.byteLength),
      // length
      ...description,
      u32(109084800),
      // TAG(6)
      u8(1),
      // length
      u8(2)
      // data
    ]);
  };
  var dOps = (track) => {
    var _a;
    let preskip = 3840;
    let gain = 0;
    const description = (_a = track.info.decoderConfig) == null ? void 0 : _a.description;
    if (description) {
      if (description.byteLength < 18) {
        throw new TypeError("Invalid decoder description provided for Opus; must be at least 18 bytes long.");
      }
      const view2 = ArrayBuffer.isView(description) ? new DataView(description.buffer, description.byteOffset, description.byteLength) : new DataView(description);
      preskip = view2.getUint16(10, true);
      gain = view2.getInt16(14, true);
    }
    return box("dOps", [
      u8(0),
      // Version
      u8(track.info.numberOfChannels),
      // OutputChannelCount
      u16(preskip),
      u32(track.info.sampleRate),
      // InputSampleRate
      fixed_8_8(gain),
      // OutputGain
      u8(0)
      // ChannelMappingFamily
    ]);
  };
  var stts = (track) => {
    return fullBox("stts", 0, 0, [
      u32(track.timeToSampleTable.length),
      // Number of entries
      track.timeToSampleTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        u32(x.sampleDelta)
        // Sample duration
      ])
    ]);
  };
  var stss = (track) => {
    if (track.samples.every((x) => x.type === "key"))
      return null;
    let keySamples = [...track.samples.entries()].filter(([, sample]) => sample.type === "key");
    return fullBox("stss", 0, 0, [
      u32(keySamples.length),
      // Number of entries
      keySamples.map(([index]) => u32(index + 1))
      // Sync sample table
    ]);
  };
  var stsc = (track) => {
    return fullBox("stsc", 0, 0, [
      u32(track.compactlyCodedChunkTable.length),
      // Number of entries
      track.compactlyCodedChunkTable.map((x) => [
        // Sample-to-chunk table
        u32(x.firstChunk),
        // First chunk
        u32(x.samplesPerChunk),
        // Samples per chunk
        u32(1)
        // Sample description index
      ])
    ]);
  };
  var stsz = (track) => fullBox("stsz", 0, 0, [
    u32(0),
    // Sample size (0 means non-constant size)
    u32(track.samples.length),
    // Number of entries
    track.samples.map((x) => u32(x.size))
    // Sample size table
  ]);
  var stco = (track) => {
    if (track.finalizedChunks.length > 0 && last(track.finalizedChunks).offset >= 2 ** 32) {
      return fullBox("co64", 0, 0, [
        u32(track.finalizedChunks.length),
        // Number of entries
        track.finalizedChunks.map((x) => u64(x.offset))
        // Chunk offset table
      ]);
    }
    return fullBox("stco", 0, 0, [
      u32(track.finalizedChunks.length),
      // Number of entries
      track.finalizedChunks.map((x) => u32(x.offset))
      // Chunk offset table
    ]);
  };
  var ctts = (track) => {
    return fullBox("ctts", 0, 0, [
      u32(track.compositionTimeOffsetTable.length),
      // Number of entries
      track.compositionTimeOffsetTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        u32(x.sampleCompositionTimeOffset)
        // Sample offset
      ])
    ]);
  };
  var mvex = (tracks) => {
    return box("mvex", null, tracks.map(trex));
  };
  var trex = (track) => {
    return fullBox("trex", 0, 0, [
      u32(track.id),
      // Track ID
      u32(1),
      // Default sample description index
      u32(0),
      // Default sample duration
      u32(0),
      // Default sample size
      u32(0)
      // Default sample flags
    ]);
  };
  var moof = (sequenceNumber, tracks) => {
    return box("moof", null, [
      mfhd(sequenceNumber),
      ...tracks.map(traf)
    ]);
  };
  var mfhd = (sequenceNumber) => {
    return fullBox("mfhd", 0, 0, [
      u32(sequenceNumber)
      // Sequence number
    ]);
  };
  var fragmentSampleFlags = (sample) => {
    let byte1 = 0;
    let byte2 = 0;
    let byte3 = 0;
    let byte4 = 0;
    let sampleIsDifferenceSample = sample.type === "delta";
    byte2 |= +sampleIsDifferenceSample;
    if (sampleIsDifferenceSample) {
      byte1 |= 1;
    } else {
      byte1 |= 2;
    }
    return byte1 << 24 | byte2 << 16 | byte3 << 8 | byte4;
  };
  var traf = (track) => {
    return box("traf", null, [
      tfhd(track),
      tfdt(track),
      trun(track)
    ]);
  };
  var tfhd = (track) => {
    let tfFlags = 0;
    tfFlags |= 8;
    tfFlags |= 16;
    tfFlags |= 32;
    tfFlags |= 131072;
    let referenceSample = track.currentChunk.samples[1] ?? track.currentChunk.samples[0];
    let referenceSampleInfo = {
      duration: referenceSample.timescaleUnitsToNextSample,
      size: referenceSample.size,
      flags: fragmentSampleFlags(referenceSample)
    };
    return fullBox("tfhd", 0, tfFlags, [
      u32(track.id),
      // Track ID
      u32(referenceSampleInfo.duration),
      // Default sample duration
      u32(referenceSampleInfo.size),
      // Default sample size
      u32(referenceSampleInfo.flags)
      // Default sample flags
    ]);
  };
  var tfdt = (track) => {
    return fullBox("tfdt", 1, 0, [
      u64(intoTimescale(track.currentChunk.startTimestamp, track.timescale))
      // Base Media Decode Time
    ]);
  };
  var trun = (track) => {
    let allSampleDurations = track.currentChunk.samples.map((x) => x.timescaleUnitsToNextSample);
    let allSampleSizes = track.currentChunk.samples.map((x) => x.size);
    let allSampleFlags = track.currentChunk.samples.map(fragmentSampleFlags);
    let allSampleCompositionTimeOffsets = track.currentChunk.samples.map((x) => intoTimescale(x.presentationTimestamp - x.decodeTimestamp, track.timescale));
    let uniqueSampleDurations = new Set(allSampleDurations);
    let uniqueSampleSizes = new Set(allSampleSizes);
    let uniqueSampleFlags = new Set(allSampleFlags);
    let uniqueSampleCompositionTimeOffsets = new Set(allSampleCompositionTimeOffsets);
    let firstSampleFlagsPresent = uniqueSampleFlags.size === 2 && allSampleFlags[0] !== allSampleFlags[1];
    let sampleDurationPresent = uniqueSampleDurations.size > 1;
    let sampleSizePresent = uniqueSampleSizes.size > 1;
    let sampleFlagsPresent = !firstSampleFlagsPresent && uniqueSampleFlags.size > 1;
    let sampleCompositionTimeOffsetsPresent = uniqueSampleCompositionTimeOffsets.size > 1 || [...uniqueSampleCompositionTimeOffsets].some((x) => x !== 0);
    let flags = 0;
    flags |= 1;
    flags |= 4 * +firstSampleFlagsPresent;
    flags |= 256 * +sampleDurationPresent;
    flags |= 512 * +sampleSizePresent;
    flags |= 1024 * +sampleFlagsPresent;
    flags |= 2048 * +sampleCompositionTimeOffsetsPresent;
    return fullBox("trun", 1, flags, [
      u32(track.currentChunk.samples.length),
      // Sample count
      u32(track.currentChunk.offset - track.currentChunk.moofOffset || 0),
      // Data offset
      firstSampleFlagsPresent ? u32(allSampleFlags[0]) : [],
      track.currentChunk.samples.map((_, i) => [
        sampleDurationPresent ? u32(allSampleDurations[i]) : [],
        // Sample duration
        sampleSizePresent ? u32(allSampleSizes[i]) : [],
        // Sample size
        sampleFlagsPresent ? u32(allSampleFlags[i]) : [],
        // Sample flags
        // Sample composition time offsets
        sampleCompositionTimeOffsetsPresent ? i32(allSampleCompositionTimeOffsets[i]) : []
      ])
    ]);
  };
  var mfra = (tracks) => {
    return box("mfra", null, [
      ...tracks.map(tfra),
      mfro()
    ]);
  };
  var tfra = (track, trackIndex) => {
    let version = 1;
    return fullBox("tfra", version, 0, [
      u32(track.id),
      // Track ID
      u32(63),
      // This specifies that traf number, trun number and sample number are 32-bit ints
      u32(track.finalizedChunks.length),
      // Number of entries
      track.finalizedChunks.map((chunk) => [
        u64(intoTimescale(chunk.startTimestamp, track.timescale)),
        // Time
        u64(chunk.moofOffset),
        // moof offset
        u32(trackIndex + 1),
        // traf number
        u32(1),
        // trun number
        u32(1)
        // Sample number
      ])
    ]);
  };
  var mfro = () => {
    return fullBox("mfro", 0, 0, [
      // This value needs to be overwritten manually from the outside, where the actual size of the enclosing mfra box
      // is known
      u32(0)
      // Size
    ]);
  };
  var VIDEO_CODEC_TO_BOX_NAME = {
    "avc": "avc1",
    "hevc": "hvc1",
    "vp9": "vp09",
    "av1": "av01"
  };
  var VIDEO_CODEC_TO_CONFIGURATION_BOX = {
    "avc": avcC,
    "hevc": hvcC,
    "vp9": vpcC,
    "av1": av1C
  };
  var AUDIO_CODEC_TO_BOX_NAME = {
    "aac": "mp4a",
    "opus": "Opus"
  };
  var AUDIO_CODEC_TO_CONFIGURATION_BOX = {
    "aac": esds,
    "opus": dOps
  };
  var Target = class {
  };
  var ArrayBufferTarget = class extends Target {
    constructor() {
      super(...arguments);
      this.buffer = null;
    }
  };
  var StreamTarget = class extends Target {
    constructor(options) {
      super();
      this.options = options;
      if (typeof options !== "object") {
        throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");
      }
      if (options.onData) {
        if (typeof options.onData !== "function") {
          throw new TypeError("options.onData, when provided, must be a function.");
        }
        if (options.onData.length < 2) {
          throw new TypeError(
            "options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs."
          );
        }
      }
      if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
        throw new TypeError("options.chunked, when provided, must be a boolean.");
      }
      if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
        throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.");
      }
    }
  };
  var FileSystemWritableFileStreamTarget = class extends Target {
    constructor(stream, options) {
      super();
      this.stream = stream;
      this.options = options;
      if (!(stream instanceof FileSystemWritableFileStream)) {
        throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");
      }
      if (options !== void 0 && typeof options !== "object") {
        throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");
      }
      if (options) {
        if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
          throw new TypeError("options.chunkSize, when provided, must be a positive integer");
        }
      }
    }
  };
  var _helper;
  var _helperView;
  var Writer = class {
    constructor() {
      this.pos = 0;
      __privateAdd(this, _helper, new Uint8Array(8));
      __privateAdd(this, _helperView, new DataView(__privateGet(this, _helper).buffer));
      this.offsets = /* @__PURE__ */ new WeakMap();
    }
    /** Sets the current position for future writes to a new one. */
    seek(newPos) {
      this.pos = newPos;
    }
    writeU32(value) {
      __privateGet(this, _helperView).setUint32(0, value, false);
      this.write(__privateGet(this, _helper).subarray(0, 4));
    }
    writeU64(value) {
      __privateGet(this, _helperView).setUint32(0, Math.floor(value / 2 ** 32), false);
      __privateGet(this, _helperView).setUint32(4, value, false);
      this.write(__privateGet(this, _helper).subarray(0, 8));
    }
    writeAscii(text) {
      for (let i = 0; i < text.length; i++) {
        __privateGet(this, _helperView).setUint8(i % 8, text.charCodeAt(i));
        if (i % 8 === 7)
          this.write(__privateGet(this, _helper));
      }
      if (text.length % 8 !== 0) {
        this.write(__privateGet(this, _helper).subarray(0, text.length % 8));
      }
    }
    writeBox(box2) {
      this.offsets.set(box2, this.pos);
      if (box2.contents && !box2.children) {
        this.writeBoxHeader(box2, box2.size ?? box2.contents.byteLength + 8);
        this.write(box2.contents);
      } else {
        let startPos = this.pos;
        this.writeBoxHeader(box2, 0);
        if (box2.contents)
          this.write(box2.contents);
        if (box2.children) {
          for (let child of box2.children)
            if (child)
              this.writeBox(child);
        }
        let endPos = this.pos;
        let size = box2.size ?? endPos - startPos;
        this.seek(startPos);
        this.writeBoxHeader(box2, size);
        this.seek(endPos);
      }
    }
    writeBoxHeader(box2, size) {
      this.writeU32(box2.largeSize ? 1 : size);
      this.writeAscii(box2.type);
      if (box2.largeSize)
        this.writeU64(size);
    }
    measureBoxHeader(box2) {
      return 8 + (box2.largeSize ? 8 : 0);
    }
    patchBox(box2) {
      let endPos = this.pos;
      this.seek(this.offsets.get(box2));
      this.writeBox(box2);
      this.seek(endPos);
    }
    measureBox(box2) {
      if (box2.contents && !box2.children) {
        let headerSize = this.measureBoxHeader(box2);
        return headerSize + box2.contents.byteLength;
      } else {
        let result = this.measureBoxHeader(box2);
        if (box2.contents)
          result += box2.contents.byteLength;
        if (box2.children) {
          for (let child of box2.children)
            if (child)
              result += this.measureBox(child);
        }
        return result;
      }
    }
  };
  _helper = /* @__PURE__ */ new WeakMap();
  _helperView = /* @__PURE__ */ new WeakMap();
  var _target;
  var _buffer;
  var _bytes;
  var _maxPos;
  var _ensureSize;
  var ensureSize_fn;
  var ArrayBufferTargetWriter = class extends Writer {
    constructor(target) {
      super();
      __privateAdd(this, _ensureSize);
      __privateAdd(this, _target, void 0);
      __privateAdd(this, _buffer, new ArrayBuffer(2 ** 16));
      __privateAdd(this, _bytes, new Uint8Array(__privateGet(this, _buffer)));
      __privateAdd(this, _maxPos, 0);
      __privateSet(this, _target, target);
    }
    write(data) {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos + data.byteLength);
      __privateGet(this, _bytes).set(data, this.pos);
      this.pos += data.byteLength;
      __privateSet(this, _maxPos, Math.max(__privateGet(this, _maxPos), this.pos));
    }
    finalize() {
      __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos);
      __privateGet(this, _target).buffer = __privateGet(this, _buffer).slice(0, Math.max(__privateGet(this, _maxPos), this.pos));
    }
  };
  _target = /* @__PURE__ */ new WeakMap();
  _buffer = /* @__PURE__ */ new WeakMap();
  _bytes = /* @__PURE__ */ new WeakMap();
  _maxPos = /* @__PURE__ */ new WeakMap();
  _ensureSize = /* @__PURE__ */ new WeakSet();
  ensureSize_fn = function(size) {
    let newLength = __privateGet(this, _buffer).byteLength;
    while (newLength < size)
      newLength *= 2;
    if (newLength === __privateGet(this, _buffer).byteLength)
      return;
    let newBuffer = new ArrayBuffer(newLength);
    let newBytes = new Uint8Array(newBuffer);
    newBytes.set(__privateGet(this, _bytes), 0);
    __privateSet(this, _buffer, newBuffer);
    __privateSet(this, _bytes, newBytes);
  };
  var DEFAULT_CHUNK_SIZE = 2 ** 24;
  var MAX_CHUNKS_AT_ONCE = 2;
  var _target2;
  var _sections;
  var _chunked;
  var _chunkSize;
  var _chunks;
  var _writeDataIntoChunks;
  var writeDataIntoChunks_fn;
  var _insertSectionIntoChunk;
  var insertSectionIntoChunk_fn;
  var _createChunk;
  var createChunk_fn;
  var _flushChunks;
  var flushChunks_fn;
  var StreamTargetWriter = class extends Writer {
    constructor(target) {
      var _a, _b;
      super();
      __privateAdd(this, _writeDataIntoChunks);
      __privateAdd(this, _insertSectionIntoChunk);
      __privateAdd(this, _createChunk);
      __privateAdd(this, _flushChunks);
      __privateAdd(this, _target2, void 0);
      __privateAdd(this, _sections, []);
      __privateAdd(this, _chunked, void 0);
      __privateAdd(this, _chunkSize, void 0);
      __privateAdd(this, _chunks, []);
      __privateSet(this, _target2, target);
      __privateSet(this, _chunked, ((_a = target.options) == null ? void 0 : _a.chunked) ?? false);
      __privateSet(this, _chunkSize, ((_b = target.options) == null ? void 0 : _b.chunkSize) ?? DEFAULT_CHUNK_SIZE);
    }
    write(data) {
      __privateGet(this, _sections).push({
        data: data.slice(),
        start: this.pos
      });
      this.pos += data.byteLength;
    }
    flush() {
      var _a, _b;
      if (__privateGet(this, _sections).length === 0)
        return;
      let chunks = [];
      let sorted = [...__privateGet(this, _sections)].sort((a, b) => a.start - b.start);
      chunks.push({
        start: sorted[0].start,
        size: sorted[0].data.byteLength
      });
      for (let i = 1; i < sorted.length; i++) {
        let lastChunk = chunks[chunks.length - 1];
        let section = sorted[i];
        if (section.start <= lastChunk.start + lastChunk.size) {
          lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
        } else {
          chunks.push({
            start: section.start,
            size: section.data.byteLength
          });
        }
      }
      for (let chunk of chunks) {
        chunk.data = new Uint8Array(chunk.size);
        for (let section of __privateGet(this, _sections)) {
          if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
            chunk.data.set(section.data, section.start - chunk.start);
          }
        }
        if (__privateGet(this, _chunked)) {
          __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, chunk.data, chunk.start);
          __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
        } else {
          (_b = (_a = __privateGet(this, _target2).options).onData) == null ? void 0 : _b.call(_a, chunk.data, chunk.start);
        }
      }
      __privateGet(this, _sections).length = 0;
    }
    finalize() {
      if (__privateGet(this, _chunked)) {
        __privateMethod(this, _flushChunks, flushChunks_fn).call(this, true);
      }
    }
  };
  _target2 = /* @__PURE__ */ new WeakMap();
  _sections = /* @__PURE__ */ new WeakMap();
  _chunked = /* @__PURE__ */ new WeakMap();
  _chunkSize = /* @__PURE__ */ new WeakMap();
  _chunks = /* @__PURE__ */ new WeakMap();
  _writeDataIntoChunks = /* @__PURE__ */ new WeakSet();
  writeDataIntoChunks_fn = function(data, position) {
    let chunkIndex = __privateGet(this, _chunks).findIndex((x) => x.start <= position && position < x.start + __privateGet(this, _chunkSize));
    if (chunkIndex === -1)
      chunkIndex = __privateMethod(this, _createChunk, createChunk_fn).call(this, position);
    let chunk = __privateGet(this, _chunks)[chunkIndex];
    let relativePosition = position - chunk.start;
    let toWrite = data.subarray(0, Math.min(__privateGet(this, _chunkSize) - relativePosition, data.byteLength));
    chunk.data.set(toWrite, relativePosition);
    let section = {
      start: relativePosition,
      end: relativePosition + toWrite.byteLength
    };
    __privateMethod(this, _insertSectionIntoChunk, insertSectionIntoChunk_fn).call(this, chunk, section);
    if (chunk.written[0].start === 0 && chunk.written[0].end === __privateGet(this, _chunkSize)) {
      chunk.shouldFlush = true;
    }
    if (__privateGet(this, _chunks).length > MAX_CHUNKS_AT_ONCE) {
      for (let i = 0; i < __privateGet(this, _chunks).length - 1; i++) {
        __privateGet(this, _chunks)[i].shouldFlush = true;
      }
      __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
    }
    if (toWrite.byteLength < data.byteLength) {
      __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, data.subarray(toWrite.byteLength), position + toWrite.byteLength);
    }
  };
  _insertSectionIntoChunk = /* @__PURE__ */ new WeakSet();
  insertSectionIntoChunk_fn = function(chunk, section) {
    let low = 0;
    let high = chunk.written.length - 1;
    let index = -1;
    while (low <= high) {
      let mid = Math.floor(low + (high - low + 1) / 2);
      if (chunk.written[mid].start <= section.start) {
        low = mid + 1;
        index = mid;
      } else {
        high = mid - 1;
      }
    }
    chunk.written.splice(index + 1, 0, section);
    if (index === -1 || chunk.written[index].end < section.start)
      index++;
    while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
      chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
      chunk.written.splice(index + 1, 1);
    }
  };
  _createChunk = /* @__PURE__ */ new WeakSet();
  createChunk_fn = function(includesPosition) {
    let start = Math.floor(includesPosition / __privateGet(this, _chunkSize)) * __privateGet(this, _chunkSize);
    let chunk = {
      start,
      data: new Uint8Array(__privateGet(this, _chunkSize)),
      written: [],
      shouldFlush: false
    };
    __privateGet(this, _chunks).push(chunk);
    __privateGet(this, _chunks).sort((a, b) => a.start - b.start);
    return __privateGet(this, _chunks).indexOf(chunk);
  };
  _flushChunks = /* @__PURE__ */ new WeakSet();
  flushChunks_fn = function(force = false) {
    var _a, _b;
    for (let i = 0; i < __privateGet(this, _chunks).length; i++) {
      let chunk = __privateGet(this, _chunks)[i];
      if (!chunk.shouldFlush && !force)
        continue;
      for (let section of chunk.written) {
        (_b = (_a = __privateGet(this, _target2).options).onData) == null ? void 0 : _b.call(
          _a,
          chunk.data.subarray(section.start, section.end),
          chunk.start + section.start
        );
      }
      __privateGet(this, _chunks).splice(i--, 1);
    }
  };
  var FileSystemWritableFileStreamTargetWriter = class extends StreamTargetWriter {
    constructor(target) {
      var _a;
      super(new StreamTarget({
        onData: (data, position) => target.stream.write({
          type: "write",
          data,
          position
        }),
        chunked: true,
        chunkSize: (_a = target.options) == null ? void 0 : _a.chunkSize
      }));
    }
  };
  var GLOBAL_TIMESCALE = 1e3;
  var SUPPORTED_VIDEO_CODECS = ["avc", "hevc", "vp9", "av1"];
  var SUPPORTED_AUDIO_CODECS = ["aac", "opus"];
  var TIMESTAMP_OFFSET = 2082844800;
  var FIRST_TIMESTAMP_BEHAVIORS = ["strict", "offset", "cross-track-offset"];
  var _options;
  var _writer;
  var _ftypSize;
  var _mdat;
  var _videoTrack;
  var _audioTrack;
  var _creationTime;
  var _finalizedChunks;
  var _nextFragmentNumber;
  var _videoSampleQueue;
  var _audioSampleQueue;
  var _finalized;
  var _validateOptions;
  var validateOptions_fn;
  var _writeHeader;
  var writeHeader_fn;
  var _computeMoovSizeUpperBound;
  var computeMoovSizeUpperBound_fn;
  var _prepareTracks;
  var prepareTracks_fn;
  var _generateMpeg4AudioSpecificConfig;
  var generateMpeg4AudioSpecificConfig_fn;
  var _createSampleForTrack;
  var createSampleForTrack_fn;
  var _addSampleToTrack;
  var addSampleToTrack_fn;
  var _validateTimestamp;
  var validateTimestamp_fn;
  var _finalizeCurrentChunk;
  var finalizeCurrentChunk_fn;
  var _finalizeFragment;
  var finalizeFragment_fn;
  var _maybeFlushStreamingTargetWriter;
  var maybeFlushStreamingTargetWriter_fn;
  var _ensureNotFinalized;
  var ensureNotFinalized_fn;
  var Muxer = class {
    constructor(options) {
      __privateAdd(this, _validateOptions);
      __privateAdd(this, _writeHeader);
      __privateAdd(this, _computeMoovSizeUpperBound);
      __privateAdd(this, _prepareTracks);
      __privateAdd(this, _generateMpeg4AudioSpecificConfig);
      __privateAdd(this, _createSampleForTrack);
      __privateAdd(this, _addSampleToTrack);
      __privateAdd(this, _validateTimestamp);
      __privateAdd(this, _finalizeCurrentChunk);
      __privateAdd(this, _finalizeFragment);
      __privateAdd(this, _maybeFlushStreamingTargetWriter);
      __privateAdd(this, _ensureNotFinalized);
      __privateAdd(this, _options, void 0);
      __privateAdd(this, _writer, void 0);
      __privateAdd(this, _ftypSize, void 0);
      __privateAdd(this, _mdat, void 0);
      __privateAdd(this, _videoTrack, null);
      __privateAdd(this, _audioTrack, null);
      __privateAdd(this, _creationTime, Math.floor(Date.now() / 1e3) + TIMESTAMP_OFFSET);
      __privateAdd(this, _finalizedChunks, []);
      __privateAdd(this, _nextFragmentNumber, 1);
      __privateAdd(this, _videoSampleQueue, []);
      __privateAdd(this, _audioSampleQueue, []);
      __privateAdd(this, _finalized, false);
      __privateMethod(this, _validateOptions, validateOptions_fn).call(this, options);
      options.video = deepClone(options.video);
      options.audio = deepClone(options.audio);
      options.fastStart = deepClone(options.fastStart);
      this.target = options.target;
      __privateSet(this, _options, {
        firstTimestampBehavior: "strict",
        ...options
      });
      if (options.target instanceof ArrayBufferTarget) {
        __privateSet(this, _writer, new ArrayBufferTargetWriter(options.target));
      } else if (options.target instanceof StreamTarget) {
        __privateSet(this, _writer, new StreamTargetWriter(options.target));
      } else if (options.target instanceof FileSystemWritableFileStreamTarget) {
        __privateSet(this, _writer, new FileSystemWritableFileStreamTargetWriter(options.target));
      } else {
        throw new Error(`Invalid target: ${options.target}`);
      }
      __privateMethod(this, _prepareTracks, prepareTracks_fn).call(this);
      __privateMethod(this, _writeHeader, writeHeader_fn).call(this);
    }
    addVideoChunk(sample, meta, timestamp, compositionTimeOffset) {
      if (!(sample instanceof EncodedVideoChunk)) {
        throw new TypeError("addVideoChunk's first argument (sample) must be of type EncodedVideoChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
        throw new TypeError(
          "addVideoChunk's fourth argument (compositionTimeOffset), when provided, must be a real number."
        );
      }
      let data = new Uint8Array(sample.byteLength);
      sample.copyTo(data);
      this.addVideoChunkRaw(
        data,
        sample.type,
        timestamp ?? sample.timestamp,
        sample.duration,
        meta,
        compositionTimeOffset
      );
    }
    addVideoChunkRaw(data, type, timestamp, duration, meta, compositionTimeOffset) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("addVideoChunkRaw's fourth argument (duration) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addVideoChunkRaw's fifth argument (meta), when provided, must be an object.");
      }
      if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
        throw new TypeError(
          "addVideoChunkRaw's sixth argument (compositionTimeOffset), when provided, must be a real number."
        );
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).video)
        throw new Error("No video track declared.");
      if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _videoTrack).samples.length === __privateGet(this, _options).fastStart.expectedVideoChunks) {
        throw new Error(`Cannot add more video chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedVideoChunks}).`);
      }
      let videoSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _videoTrack), data, type, timestamp, duration, meta, compositionTimeOffset);
      if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _audioTrack)) {
        while (__privateGet(this, _audioSampleQueue).length > 0 && __privateGet(this, _audioSampleQueue)[0].decodeTimestamp <= videoSample.decodeTimestamp) {
          let audioSample = __privateGet(this, _audioSampleQueue).shift();
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        }
        if (videoSample.decodeTimestamp <= __privateGet(this, _audioTrack).lastDecodeTimestamp) {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        } else {
          __privateGet(this, _videoSampleQueue).push(videoSample);
        }
      } else {
        __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
      }
    }
    addAudioChunk(sample, meta, timestamp) {
      if (!(sample instanceof EncodedAudioChunk)) {
        throw new TypeError("addAudioChunk's first argument (sample) must be of type EncodedAudioChunk.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");
      }
      if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
        throw new TypeError(
          "addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number."
        );
      }
      let data = new Uint8Array(sample.byteLength);
      sample.copyTo(data);
      this.addAudioChunkRaw(data, sample.type, timestamp ?? sample.timestamp, sample.duration, meta);
    }
    addAudioChunkRaw(data, type, timestamp, duration, meta) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");
      }
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("addAudioChunkRaw's fourth argument (duration) must be a non-negative real number.");
      }
      if (meta && typeof meta !== "object") {
        throw new TypeError("addAudioChunkRaw's fifth argument (meta), when provided, must be an object.");
      }
      __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
      if (!__privateGet(this, _options).audio)
        throw new Error("No audio track declared.");
      if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _audioTrack).samples.length === __privateGet(this, _options).fastStart.expectedAudioChunks) {
        throw new Error(`Cannot add more audio chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedAudioChunks}).`);
      }
      let audioSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _audioTrack), data, type, timestamp, duration, meta);
      if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _videoTrack)) {
        while (__privateGet(this, _videoSampleQueue).length > 0 && __privateGet(this, _videoSampleQueue)[0].decodeTimestamp <= audioSample.decodeTimestamp) {
          let videoSample = __privateGet(this, _videoSampleQueue).shift();
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        }
        if (audioSample.decodeTimestamp <= __privateGet(this, _videoTrack).lastDecodeTimestamp) {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        } else {
          __privateGet(this, _audioSampleQueue).push(audioSample);
        }
      } else {
        __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
      }
    }
    /** Finalizes the file, making it ready for use. Must be called after all video and audio chunks have been added. */
    finalize() {
      if (__privateGet(this, _finalized)) {
        throw new Error("Cannot finalize a muxer more than once.");
      }
      if (__privateGet(this, _options).fastStart === "fragmented") {
        for (let videoSample of __privateGet(this, _videoSampleQueue))
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        for (let audioSample of __privateGet(this, _audioSampleQueue))
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this, false);
      } else {
        if (__privateGet(this, _videoTrack))
          __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _videoTrack));
        if (__privateGet(this, _audioTrack))
          __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _audioTrack));
      }
      let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter(Boolean);
      if (__privateGet(this, _options).fastStart === "in-memory") {
        let mdatSize;
        for (let i = 0; i < 2; i++) {
          let movieBox2 = moov(tracks, __privateGet(this, _creationTime));
          let movieBoxSize = __privateGet(this, _writer).measureBox(movieBox2);
          mdatSize = __privateGet(this, _writer).measureBox(__privateGet(this, _mdat));
          let currentChunkPos = __privateGet(this, _writer).pos + movieBoxSize + mdatSize;
          for (let chunk of __privateGet(this, _finalizedChunks)) {
            chunk.offset = currentChunkPos;
            for (let { data } of chunk.samples) {
              currentChunkPos += data.byteLength;
              mdatSize += data.byteLength;
            }
          }
          if (currentChunkPos < 2 ** 32)
            break;
          if (mdatSize >= 2 ** 32)
            __privateGet(this, _mdat).largeSize = true;
        }
        let movieBox = moov(tracks, __privateGet(this, _creationTime));
        __privateGet(this, _writer).writeBox(movieBox);
        __privateGet(this, _mdat).size = mdatSize;
        __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
        for (let chunk of __privateGet(this, _finalizedChunks)) {
          for (let sample of chunk.samples) {
            __privateGet(this, _writer).write(sample.data);
            sample.data = null;
          }
        }
      } else if (__privateGet(this, _options).fastStart === "fragmented") {
        let startPos = __privateGet(this, _writer).pos;
        let mfraBox = mfra(tracks);
        __privateGet(this, _writer).writeBox(mfraBox);
        let mfraBoxSize = __privateGet(this, _writer).pos - startPos;
        __privateGet(this, _writer).seek(__privateGet(this, _writer).pos - 4);
        __privateGet(this, _writer).writeU32(mfraBoxSize);
      } else {
        let mdatPos = __privateGet(this, _writer).offsets.get(__privateGet(this, _mdat));
        let mdatSize = __privateGet(this, _writer).pos - mdatPos;
        __privateGet(this, _mdat).size = mdatSize;
        __privateGet(this, _mdat).largeSize = mdatSize >= 2 ** 32;
        __privateGet(this, _writer).patchBox(__privateGet(this, _mdat));
        let movieBox = moov(tracks, __privateGet(this, _creationTime));
        if (typeof __privateGet(this, _options).fastStart === "object") {
          __privateGet(this, _writer).seek(__privateGet(this, _ftypSize));
          __privateGet(this, _writer).writeBox(movieBox);
          let remainingBytes = mdatPos - __privateGet(this, _writer).pos;
          __privateGet(this, _writer).writeBox(free(remainingBytes));
        } else {
          __privateGet(this, _writer).writeBox(movieBox);
        }
      }
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
      __privateGet(this, _writer).finalize();
      __privateSet(this, _finalized, true);
    }
  };
  _options = /* @__PURE__ */ new WeakMap();
  _writer = /* @__PURE__ */ new WeakMap();
  _ftypSize = /* @__PURE__ */ new WeakMap();
  _mdat = /* @__PURE__ */ new WeakMap();
  _videoTrack = /* @__PURE__ */ new WeakMap();
  _audioTrack = /* @__PURE__ */ new WeakMap();
  _creationTime = /* @__PURE__ */ new WeakMap();
  _finalizedChunks = /* @__PURE__ */ new WeakMap();
  _nextFragmentNumber = /* @__PURE__ */ new WeakMap();
  _videoSampleQueue = /* @__PURE__ */ new WeakMap();
  _audioSampleQueue = /* @__PURE__ */ new WeakMap();
  _finalized = /* @__PURE__ */ new WeakMap();
  _validateOptions = /* @__PURE__ */ new WeakSet();
  validateOptions_fn = function(options) {
    if (typeof options !== "object") {
      throw new TypeError("The muxer requires an options object to be passed to its constructor.");
    }
    if (!(options.target instanceof Target)) {
      throw new TypeError("The target must be provided and an instance of Target.");
    }
    if (options.video) {
      if (!SUPPORTED_VIDEO_CODECS.includes(options.video.codec)) {
        throw new TypeError(`Unsupported video codec: ${options.video.codec}`);
      }
      if (!Number.isInteger(options.video.width) || options.video.width <= 0) {
        throw new TypeError(`Invalid video width: ${options.video.width}. Must be a positive integer.`);
      }
      if (!Number.isInteger(options.video.height) || options.video.height <= 0) {
        throw new TypeError(`Invalid video height: ${options.video.height}. Must be a positive integer.`);
      }
      const videoRotation = options.video.rotation;
      if (typeof videoRotation === "number" && ![0, 90, 180, 270].includes(videoRotation)) {
        throw new TypeError(`Invalid video rotation: ${videoRotation}. Has to be 0, 90, 180 or 270.`);
      } else if (Array.isArray(videoRotation) && (videoRotation.length !== 9 || videoRotation.some((value) => typeof value !== "number"))) {
        throw new TypeError(`Invalid video transformation matrix: ${videoRotation.join()}`);
      }
      if (options.video.frameRate !== void 0 && (!Number.isInteger(options.video.frameRate) || options.video.frameRate <= 0)) {
        throw new TypeError(
          `Invalid video frame rate: ${options.video.frameRate}. Must be a positive integer.`
        );
      }
    }
    if (options.audio) {
      if (!SUPPORTED_AUDIO_CODECS.includes(options.audio.codec)) {
        throw new TypeError(`Unsupported audio codec: ${options.audio.codec}`);
      }
      if (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0) {
        throw new TypeError(
          `Invalid number of audio channels: ${options.audio.numberOfChannels}. Must be a positive integer.`
        );
      }
      if (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0) {
        throw new TypeError(
          `Invalid audio sample rate: ${options.audio.sampleRate}. Must be a positive integer.`
        );
      }
    }
    if (options.firstTimestampBehavior && !FIRST_TIMESTAMP_BEHAVIORS.includes(options.firstTimestampBehavior)) {
      throw new TypeError(`Invalid first timestamp behavior: ${options.firstTimestampBehavior}`);
    }
    if (typeof options.fastStart === "object") {
      if (options.video) {
        if (options.fastStart.expectedVideoChunks === void 0) {
          throw new TypeError(`'fastStart' is an object but is missing property 'expectedVideoChunks'.`);
        } else if (!Number.isInteger(options.fastStart.expectedVideoChunks) || options.fastStart.expectedVideoChunks < 0) {
          throw new TypeError(`'expectedVideoChunks' must be a non-negative integer.`);
        }
      }
      if (options.audio) {
        if (options.fastStart.expectedAudioChunks === void 0) {
          throw new TypeError(`'fastStart' is an object but is missing property 'expectedAudioChunks'.`);
        } else if (!Number.isInteger(options.fastStart.expectedAudioChunks) || options.fastStart.expectedAudioChunks < 0) {
          throw new TypeError(`'expectedAudioChunks' must be a non-negative integer.`);
        }
      }
    } else if (![false, "in-memory", "fragmented"].includes(options.fastStart)) {
      throw new TypeError(`'fastStart' option must be false, 'in-memory', 'fragmented' or an object.`);
    }
    if (options.minFragmentDuration !== void 0 && (!Number.isFinite(options.minFragmentDuration) || options.minFragmentDuration < 0)) {
      throw new TypeError(`'minFragmentDuration' must be a non-negative number.`);
    }
  };
  _writeHeader = /* @__PURE__ */ new WeakSet();
  writeHeader_fn = function() {
    var _a;
    __privateGet(this, _writer).writeBox(ftyp({
      holdsAvc: ((_a = __privateGet(this, _options).video) == null ? void 0 : _a.codec) === "avc",
      fragmented: __privateGet(this, _options).fastStart === "fragmented"
    }));
    __privateSet(this, _ftypSize, __privateGet(this, _writer).pos);
    if (__privateGet(this, _options).fastStart === "in-memory") {
      __privateSet(this, _mdat, mdat(false));
    } else if (__privateGet(this, _options).fastStart === "fragmented") {
    } else {
      if (typeof __privateGet(this, _options).fastStart === "object") {
        let moovSizeUpperBound = __privateMethod(this, _computeMoovSizeUpperBound, computeMoovSizeUpperBound_fn).call(this);
        __privateGet(this, _writer).seek(__privateGet(this, _writer).pos + moovSizeUpperBound);
      }
      __privateSet(this, _mdat, mdat(true));
      __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
    }
    __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
  };
  _computeMoovSizeUpperBound = /* @__PURE__ */ new WeakSet();
  computeMoovSizeUpperBound_fn = function() {
    if (typeof __privateGet(this, _options).fastStart !== "object")
      return;
    let upperBound = 0;
    let sampleCounts = [
      __privateGet(this, _options).fastStart.expectedVideoChunks,
      __privateGet(this, _options).fastStart.expectedAudioChunks
    ];
    for (let n of sampleCounts) {
      if (!n)
        continue;
      upperBound += (4 + 4) * Math.ceil(2 / 3 * n);
      upperBound += 4 * n;
      upperBound += (4 + 4 + 4) * Math.ceil(2 / 3 * n);
      upperBound += 4 * n;
      upperBound += 8 * n;
    }
    upperBound += 4096;
    return upperBound;
  };
  _prepareTracks = /* @__PURE__ */ new WeakSet();
  prepareTracks_fn = function() {
    if (__privateGet(this, _options).video) {
      __privateSet(this, _videoTrack, {
        id: 1,
        info: {
          type: "video",
          codec: __privateGet(this, _options).video.codec,
          width: __privateGet(this, _options).video.width,
          height: __privateGet(this, _options).video.height,
          rotation: __privateGet(this, _options).video.rotation ?? 0,
          decoderConfig: null
        },
        // The fallback contains many common frame rates as factors
        timescale: __privateGet(this, _options).video.frameRate ?? 57600,
        samples: [],
        finalizedChunks: [],
        currentChunk: null,
        firstDecodeTimestamp: void 0,
        lastDecodeTimestamp: -1,
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        compactlyCodedChunkTable: []
      });
    }
    if (__privateGet(this, _options).audio) {
      __privateSet(this, _audioTrack, {
        id: __privateGet(this, _options).video ? 2 : 1,
        info: {
          type: "audio",
          codec: __privateGet(this, _options).audio.codec,
          numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
          sampleRate: __privateGet(this, _options).audio.sampleRate,
          decoderConfig: null
        },
        timescale: __privateGet(this, _options).audio.sampleRate,
        samples: [],
        finalizedChunks: [],
        currentChunk: null,
        firstDecodeTimestamp: void 0,
        lastDecodeTimestamp: -1,
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        compactlyCodedChunkTable: []
      });
      if (__privateGet(this, _options).audio.codec === "aac") {
        let guessedCodecPrivate = __privateMethod(this, _generateMpeg4AudioSpecificConfig, generateMpeg4AudioSpecificConfig_fn).call(
          this,
          2,
          // Object type for AAC-LC, since it's the most common
          __privateGet(this, _options).audio.sampleRate,
          __privateGet(this, _options).audio.numberOfChannels
        );
        __privateGet(this, _audioTrack).info.decoderConfig = {
          codec: __privateGet(this, _options).audio.codec,
          description: guessedCodecPrivate,
          numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
          sampleRate: __privateGet(this, _options).audio.sampleRate
        };
      }
    }
  };
  _generateMpeg4AudioSpecificConfig = /* @__PURE__ */ new WeakSet();
  generateMpeg4AudioSpecificConfig_fn = function(objectType, sampleRate, numberOfChannels) {
    let frequencyIndices = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
    let frequencyIndex = frequencyIndices.indexOf(sampleRate);
    let channelConfig = numberOfChannels;
    let configBits = "";
    configBits += objectType.toString(2).padStart(5, "0");
    configBits += frequencyIndex.toString(2).padStart(4, "0");
    if (frequencyIndex === 15)
      configBits += sampleRate.toString(2).padStart(24, "0");
    configBits += channelConfig.toString(2).padStart(4, "0");
    let paddingLength = Math.ceil(configBits.length / 8) * 8;
    configBits = configBits.padEnd(paddingLength, "0");
    let configBytes = new Uint8Array(configBits.length / 8);
    for (let i = 0; i < configBits.length; i += 8) {
      configBytes[i / 8] = parseInt(configBits.slice(i, i + 8), 2);
    }
    return configBytes;
  };
  _createSampleForTrack = /* @__PURE__ */ new WeakSet();
  createSampleForTrack_fn = function(track, data, type, timestamp, duration, meta, compositionTimeOffset) {
    let presentationTimestampInSeconds = timestamp / 1e6;
    let decodeTimestampInSeconds = (timestamp - (compositionTimeOffset ?? 0)) / 1e6;
    let durationInSeconds = duration / 1e6;
    let adjusted = __privateMethod(this, _validateTimestamp, validateTimestamp_fn).call(this, presentationTimestampInSeconds, decodeTimestampInSeconds, track);
    presentationTimestampInSeconds = adjusted.presentationTimestamp;
    decodeTimestampInSeconds = adjusted.decodeTimestamp;
    if (meta == null ? void 0 : meta.decoderConfig) {
      if (track.info.decoderConfig === null) {
        track.info.decoderConfig = meta.decoderConfig;
      } else {
        Object.assign(track.info.decoderConfig, meta.decoderConfig);
      }
    }
    let sample = {
      presentationTimestamp: presentationTimestampInSeconds,
      decodeTimestamp: decodeTimestampInSeconds,
      duration: durationInSeconds,
      data,
      size: data.byteLength,
      type,
      // Will be refined once the next sample comes in
      timescaleUnitsToNextSample: intoTimescale(durationInSeconds, track.timescale)
    };
    return sample;
  };
  _addSampleToTrack = /* @__PURE__ */ new WeakSet();
  addSampleToTrack_fn = function(track, sample) {
    if (__privateGet(this, _options).fastStart !== "fragmented") {
      track.samples.push(sample);
    }
    const sampleCompositionTimeOffset = intoTimescale(sample.presentationTimestamp - sample.decodeTimestamp, track.timescale);
    if (track.lastTimescaleUnits !== null) {
      let timescaleUnits = intoTimescale(sample.decodeTimestamp, track.timescale, false);
      let delta = Math.round(timescaleUnits - track.lastTimescaleUnits);
      track.lastTimescaleUnits += delta;
      track.lastSample.timescaleUnitsToNextSample = delta;
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        let lastTableEntry = last(track.timeToSampleTable);
        if (lastTableEntry.sampleCount === 1) {
          lastTableEntry.sampleDelta = delta;
          lastTableEntry.sampleCount++;
        } else if (lastTableEntry.sampleDelta === delta) {
          lastTableEntry.sampleCount++;
        } else {
          lastTableEntry.sampleCount--;
          track.timeToSampleTable.push({
            sampleCount: 2,
            sampleDelta: delta
          });
        }
        const lastCompositionTimeOffsetTableEntry = last(track.compositionTimeOffsetTable);
        if (lastCompositionTimeOffsetTableEntry.sampleCompositionTimeOffset === sampleCompositionTimeOffset) {
          lastCompositionTimeOffsetTableEntry.sampleCount++;
        } else {
          track.compositionTimeOffsetTable.push({
            sampleCount: 1,
            sampleCompositionTimeOffset
          });
        }
      }
    } else {
      track.lastTimescaleUnits = 0;
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        track.timeToSampleTable.push({
          sampleCount: 1,
          sampleDelta: intoTimescale(sample.duration, track.timescale)
        });
        track.compositionTimeOffsetTable.push({
          sampleCount: 1,
          sampleCompositionTimeOffset
        });
      }
    }
    track.lastSample = sample;
    let beginNewChunk = false;
    if (!track.currentChunk) {
      beginNewChunk = true;
    } else {
      let currentChunkDuration = sample.presentationTimestamp - track.currentChunk.startTimestamp;
      if (__privateGet(this, _options).fastStart === "fragmented") {
        let mostImportantTrack = __privateGet(this, _videoTrack) ?? __privateGet(this, _audioTrack);
        const chunkDuration = __privateGet(this, _options).minFragmentDuration ?? 1;
        if (track === mostImportantTrack && sample.type === "key" && currentChunkDuration >= chunkDuration) {
          beginNewChunk = true;
          __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this);
        }
      } else {
        beginNewChunk = currentChunkDuration >= 0.5;
      }
    }
    if (beginNewChunk) {
      if (track.currentChunk) {
        __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, track);
      }
      track.currentChunk = {
        startTimestamp: sample.presentationTimestamp,
        samples: []
      };
    }
    track.currentChunk.samples.push(sample);
  };
  _validateTimestamp = /* @__PURE__ */ new WeakSet();
  validateTimestamp_fn = function(presentationTimestamp, decodeTimestamp, track) {
    var _a, _b;
    const strictTimestampBehavior = __privateGet(this, _options).firstTimestampBehavior === "strict";
    const noLastDecodeTimestamp = track.lastDecodeTimestamp === -1;
    const timestampNonZero = decodeTimestamp !== 0;
    if (strictTimestampBehavior && noLastDecodeTimestamp && timestampNonZero) {
      throw new Error(
        `The first chunk for your media track must have a timestamp of 0 (received DTS=${decodeTimestamp}).Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of thedocument, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
`
      );
    } else if (__privateGet(this, _options).firstTimestampBehavior === "offset" || __privateGet(this, _options).firstTimestampBehavior === "cross-track-offset") {
      if (track.firstDecodeTimestamp === void 0) {
        track.firstDecodeTimestamp = decodeTimestamp;
      }
      let baseDecodeTimestamp;
      if (__privateGet(this, _options).firstTimestampBehavior === "offset") {
        baseDecodeTimestamp = track.firstDecodeTimestamp;
      } else {
        baseDecodeTimestamp = Math.min(
          ((_a = __privateGet(this, _videoTrack)) == null ? void 0 : _a.firstDecodeTimestamp) ?? Infinity,
          ((_b = __privateGet(this, _audioTrack)) == null ? void 0 : _b.firstDecodeTimestamp) ?? Infinity
        );
      }
      decodeTimestamp -= baseDecodeTimestamp;
      presentationTimestamp -= baseDecodeTimestamp;
    }
    if (decodeTimestamp < track.lastDecodeTimestamp) {
      throw new Error(
        `Timestamps must be monotonically increasing (DTS went from ${track.lastDecodeTimestamp * 1e6} to ${decodeTimestamp * 1e6}).`
      );
    }
    track.lastDecodeTimestamp = decodeTimestamp;
    return { presentationTimestamp, decodeTimestamp };
  };
  _finalizeCurrentChunk = /* @__PURE__ */ new WeakSet();
  finalizeCurrentChunk_fn = function(track) {
    if (__privateGet(this, _options).fastStart === "fragmented") {
      throw new Error("Can't finalize individual chunks if 'fastStart' is set to 'fragmented'.");
    }
    if (!track.currentChunk)
      return;
    track.finalizedChunks.push(track.currentChunk);
    __privateGet(this, _finalizedChunks).push(track.currentChunk);
    if (track.compactlyCodedChunkTable.length === 0 || last(track.compactlyCodedChunkTable).samplesPerChunk !== track.currentChunk.samples.length) {
      track.compactlyCodedChunkTable.push({
        firstChunk: track.finalizedChunks.length,
        // 1-indexed
        samplesPerChunk: track.currentChunk.samples.length
      });
    }
    if (__privateGet(this, _options).fastStart === "in-memory") {
      track.currentChunk.offset = 0;
      return;
    }
    track.currentChunk.offset = __privateGet(this, _writer).pos;
    for (let sample of track.currentChunk.samples) {
      __privateGet(this, _writer).write(sample.data);
      sample.data = null;
    }
    __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
  };
  _finalizeFragment = /* @__PURE__ */ new WeakSet();
  finalizeFragment_fn = function(flushStreamingWriter = true) {
    if (__privateGet(this, _options).fastStart !== "fragmented") {
      throw new Error("Can't finalize a fragment unless 'fastStart' is set to 'fragmented'.");
    }
    let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter((track) => track && track.currentChunk);
    if (tracks.length === 0)
      return;
    let fragmentNumber = __privateWrapper(this, _nextFragmentNumber)._++;
    if (fragmentNumber === 1) {
      let movieBox = moov(tracks, __privateGet(this, _creationTime), true);
      __privateGet(this, _writer).writeBox(movieBox);
    }
    let moofOffset = __privateGet(this, _writer).pos;
    let moofBox = moof(fragmentNumber, tracks);
    __privateGet(this, _writer).writeBox(moofBox);
    {
      let mdatBox = mdat(false);
      let totalTrackSampleSize = 0;
      for (let track of tracks) {
        for (let sample of track.currentChunk.samples) {
          totalTrackSampleSize += sample.size;
        }
      }
      let mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
      if (mdatSize >= 2 ** 32) {
        mdatBox.largeSize = true;
        mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
      }
      mdatBox.size = mdatSize;
      __privateGet(this, _writer).writeBox(mdatBox);
    }
    for (let track of tracks) {
      track.currentChunk.offset = __privateGet(this, _writer).pos;
      track.currentChunk.moofOffset = moofOffset;
      for (let sample of track.currentChunk.samples) {
        __privateGet(this, _writer).write(sample.data);
        sample.data = null;
      }
    }
    let endPos = __privateGet(this, _writer).pos;
    __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(moofBox));
    let newMoofBox = moof(fragmentNumber, tracks);
    __privateGet(this, _writer).writeBox(newMoofBox);
    __privateGet(this, _writer).seek(endPos);
    for (let track of tracks) {
      track.finalizedChunks.push(track.currentChunk);
      __privateGet(this, _finalizedChunks).push(track.currentChunk);
      track.currentChunk = null;
    }
    if (flushStreamingWriter) {
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    }
  };
  _maybeFlushStreamingTargetWriter = /* @__PURE__ */ new WeakSet();
  maybeFlushStreamingTargetWriter_fn = function() {
    if (__privateGet(this, _writer) instanceof StreamTargetWriter) {
      __privateGet(this, _writer).flush();
    }
  };
  _ensureNotFinalized = /* @__PURE__ */ new WeakSet();
  ensureNotFinalized_fn = function() {
    if (__privateGet(this, _finalized)) {
      throw new Error("Cannot add new video or audio chunks after the file has been finalized.");
    }
  };

  // js/exporter.js
  var VideoExporter = class {
    constructor(renderer, voiceEngine, captionEngine) {
      this.renderer = renderer;
      this.voiceEngine = voiceEngine;
      this.captionEngine = captionEngine;
      this.isExporting = false;
      this.cancelRequested = false;
      this.activeMediaRecorder = null;
      this.activeAudioSource = null;
      this.activeTabStream = null;
    }
    /**
     * Helper to format seconds as MM:SS
     */
    formatTime(sec) {
      const s = Math.max(0, Math.floor(sec));
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    }
    /**
     * Resolves the canvas dimensions strictly based on the user's selected export resolution / aspect ratio,
     * never allowing crop-box dragging to shrink the export canvas.
     * @param {object} appState 
     * @returns {{ width: number, height: number }}
     */
    getExportDimensions(appState) {
      const ratio = (appState == null ? void 0 : appState.aspectRatio) || "16:9";
      let width = 1920;
      let height = 1080;
      if (ratio === "9:16") {
        width = 1080;
        height = 1920;
      } else if (ratio === "1:1") {
        width = 1080;
        height = 1080;
      } else if (ratio === "4:5") {
        width = 1080;
        height = 1350;
      } else if (ratio === "16:9-720p") {
        width = 1280;
        height = 720;
      } else if (ratio === "custom") {
        width = appState.exportWidth || 1920;
        height = appState.exportHeight || 1080;
      } else {
        width = 1920;
        height = 1080;
      }
      width = width - width % 2;
      height = height - height % 2;
      return { width, height };
    }
    /**
     * Computes video bitrate based on export dimensions and fps:
     * 1080p30 & 9:16 (1080x1920) at ~14 Mbps, 720p at ~8 Mbps.
     * For other sizes, uses pixels * fps * 0.12 bits.
     * @param {number} width 
     * @param {number} height 
     * @param {number} [fps] 
     * @returns {number} Bitrate in bits per second
     */
    getOptimalVideoBitrate(width, height, fps = 30) {
      if (width === 1080 && height === 1920) return 14e6;
      const pixels = width * height;
      if (pixels >= 1920 * 1080) return 14e6;
      if (pixels <= 1280 * 720) return 8e6;
      return Math.round(pixels * fps * 0.12);
    }
    /**
     * Computes the absolute peak amplitude of an AudioBuffer
     * @param {AudioBuffer} buf 
     * @returns {number}
     */
    computeBufferPeak(buf) {
      if (!buf) return 0;
      let max = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const data = buf.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > max) max = abs;
        }
      }
      return max;
    }
    /**
     * Decodes output blob's audio with AudioContext.decodeAudioData and computes its RMS
     * @param {Blob} blob 
     * @returns {Promise<number>}
     */
    async computeBlobAudioRms(blob) {
      try {
        const AudioCtxClass = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
        if (!AudioCtxClass) return 1;
        const ctx = new AudioCtxClass();
        const buf = await blob.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        let sumSq = 0;
        let count = 0;
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const data = decoded.getChannelData(c);
          for (let i = 0; i < data.length; i += 2) {
            sumSq += data[i] * data[i];
            count++;
          }
        }
        try {
          ctx.close();
        } catch (e) {
        }
        return count > 0 ? Math.sqrt(sumSq / count) : 0;
      } catch (e) {
        console.warn("[computeBlobAudioRms Error]", e);
        return 1;
      }
    }
    /**
     * Builds the export audio via OfflineAudioContext and returns Float32Array channel buffers
     * @param {number} totalDuration 
     * @returns {Promise<{ channels: [Float32Array, Float32Array], sampleRate: number, frames: number, peak: number }|null>}
     */
    async buildExportAudio(totalDuration) {
      if (!this.voiceEngine || !this.voiceEngine.audioBuffer) {
        return null;
      }
      const sourceBuf = this.voiceEngine.audioBuffer;
      const sourcePeak = this.computeBufferPeak(sourceBuf);
      if (sourcePeak < 5e-4) {
        throw new Error("voice is silent");
      }
      const sampleRate = 48e3;
      const frames = Math.ceil(totalDuration * sampleRate);
      const OfflineCtxClass = typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      if (!OfflineCtxClass) {
        throw new Error("OfflineAudioContext is not supported in this environment.");
      }
      let rendered = null;
      let renderedPeak = 0;
      try {
        const off = new OfflineCtxClass(2, frames, sampleRate);
        const src = off.createBufferSource();
        src.buffer = sourceBuf;
        this.voiceEngine.connectProcessingGraph(src, off.destination, null, off);
        src.start(0);
        rendered = await off.startRendering();
        renderedPeak = this.computeBufferPeak(rendered);
      } catch (dspErr) {
        console.warn("[Export audio] DSP render failed:", dspErr);
      }
      console.log(`[Export audio] Source peak: ${sourcePeak.toFixed(5)} | Rendered peak: ${renderedPeak.toFixed(5)}`);
      if (!rendered || renderedPeak < 5e-4) {
        console.warn("[Export audio] DSP render peak is below 0.0005 or failed. Re-rendering WITHOUT the DSP graph.");
        const rawOff = new OfflineCtxClass(2, frames, sampleRate);
        const rawSrc = rawOff.createBufferSource();
        rawSrc.buffer = sourceBuf;
        rawSrc.connect(rawOff.destination);
        rawSrc.start(0);
        rendered = await rawOff.startRendering();
        renderedPeak = this.computeBufferPeak(rendered);
        console.log(`[Export audio] Raw fallback peak: ${renderedPeak.toFixed(5)}`);
      }
      const ch0 = rendered.getChannelData(0);
      const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
      return {
        channels: [ch0, ch1],
        sampleRate,
        frames,
        peak: renderedPeak
      };
    }
    /**
     * Probes supported codecs for video and audio using isConfigSupported
     * @param {number} width 
     * @param {number} height 
     * @param {number} fps 
     * @param {boolean} wantAudio 
     * @returns {Promise<{ videoCodec: string, muxerVideoCodec: string, videoBitrate: number, audioCodec: string|null, muxerAudioCodec: string }>}
     */
    async pickCodecs(width, height, fps = 30, wantAudio = false) {
      const videoCandidates = [
        "avc1.640028",
        "avc1.4d0028",
        "vp09.00.40.08"
      ];
      const rawBitrate = Math.round(width * height * fps * 0.22);
      const videoBitrate = Math.max(4e6, Math.min(4e7, rawBitrate));
      let chosenVideoCodec = null;
      let muxerVideoCodec = "avc";
      if (typeof window !== "undefined" && typeof window.VideoEncoder !== "undefined") {
        for (const codec of videoCandidates) {
          try {
            const support = await VideoEncoder.isConfigSupported({
              codec,
              width,
              height,
              bitrate: videoBitrate,
              bitrateMode: "variable",
              latencyMode: "quality",
              framerate: fps
            });
            if (support && support.supported) {
              chosenVideoCodec = codec;
              muxerVideoCodec = codec.startsWith("vp09") ? "vp9" : "avc";
              break;
            }
          } catch (e) {
          }
        }
      }
      if (!chosenVideoCodec) {
        chosenVideoCodec = "avc1.640028";
        muxerVideoCodec = "avc";
      }
      let chosenAudioCodec = null;
      let muxerAudioCodec = "aac";
      if (wantAudio && typeof window !== "undefined" && typeof window.AudioEncoder !== "undefined") {
        const audioCandidates = [
          { encoderCodec: "mp4a.40.2", muxerCodec: "aac" },
          { encoderCodec: "opus", muxerCodec: "opus" }
        ];
        for (const item of audioCandidates) {
          try {
            const support = await AudioEncoder.isConfigSupported({
              codec: item.encoderCodec,
              sampleRate: 48e3,
              numberOfChannels: 2,
              bitrate: 192e3
            });
            if (support && support.supported) {
              chosenAudioCodec = item.encoderCodec;
              muxerAudioCodec = item.muxerCodec;
              break;
            }
          } catch (e) {
          }
        }
      }
      return {
        videoCodec: chosenVideoCodec,
        muxerVideoCodec,
        videoBitrate,
        audioCodec: chosenAudioCodec,
        muxerAudioCodec
      };
    }
    /**
     * Chooses the best supported video container and codec for MediaRecorder
     */
    getBestMimeType() {
      const candidates = [
        "video/mp4;codecs=avc1.640028,mp4a.40.2",
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ];
      for (const mime of candidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
          return mime;
        }
      }
      return "video/webm";
    }
    /**
     * Helper to trigger download of a generated video blob
     */
    triggerDownload(blob, filename) {
      const url2 = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url2), 2e3);
    }
    /**
     * Post-export verification: loads blob into hidden <video> element and decodes audio with Web Audio,
     * verifies duration is within 0.3s of timeline and audio track is present when expected.
     * If audio is missing when expected, shows a red warning toast: "Exported file has no audio. Try Mode 1."
     * Logs mode used, audio track present (yes/no), and audio duration for debugging.
     * @param {Blob} blob 
     * @param {number} expectedDuration 
     * @param {boolean} shouldHaveAudio 
     * @param {function} [toastFn] 
     * @param {string} [modeName]
     * @returns {Promise<object>}
     */
    async verifyExportResult(blob, expectedDuration, shouldHaveAudio, toastFn = null, modeName = "Export") {
      if (typeof document === "undefined") return { valid: true, hasAudio: shouldHaveAudio };
      return new Promise(async (resolve) => {
        let hasAudio = false;
        let audioDuration = 0;
        let actualDur = 0;
        if (shouldHaveAudio) {
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
              const tempCtx = new AudioContextClass();
              const arrayBuffer = await blob.arrayBuffer();
              const decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
              if (decoded && decoded.numberOfChannels > 0 && decoded.duration > 0) {
                hasAudio = true;
                audioDuration = decoded.duration;
              }
              try {
                tempCtx.close();
              } catch (e) {
              }
            }
          } catch (decodeErr) {
          }
        }
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.style.display = "none";
        document.body.appendChild(video);
        const url2 = URL.createObjectURL(blob);
        video.src = url2;
        let finished = false;
        const cleanup = () => {
          if (!finished) {
            finished = true;
            URL.revokeObjectURL(url2);
            video.remove();
          }
        };
        const finishEvaluation = () => {
          actualDur = video.duration || 0;
          if (!hasAudio && shouldHaveAudio) {
            if (video.audioTracks && video.audioTracks.length > 0) {
              hasAudio = true;
            } else if (typeof video.mozHasAudio !== "undefined" && video.mozHasAudio) {
              hasAudio = true;
            } else if (typeof video.webkitAudioDecodedByteCount !== "undefined" && video.webkitAudioDecodedByteCount > 0) {
              hasAudio = true;
            } else {
              try {
                const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream ? video.mozCaptureStream() : null;
                if (stream && stream.getAudioTracks().length > 0) {
                  hasAudio = true;
                }
              } catch (e) {
              }
            }
          }
          if (hasAudio && audioDuration === 0) {
            audioDuration = actualDur;
          }
          const durDiff = Math.abs(actualDur - expectedDuration);
          const warnings = [];
          if (durDiff > 0.3) {
            warnings.push(`Export duration (${actualDur.toFixed(2)}s) differs from timeline (${expectedDuration.toFixed(2)}s) by >0.3s.`);
          }
          if (shouldHaveAudio && !hasAudio) {
            const redMsg = "Exported file has no audio. Try Mode 1.";
            warnings.push(redMsg);
            if (typeof toastFn === "function") {
              toastFn(redMsg, "error", 7e3);
            }
          } else if (warnings.length > 0) {
            if (typeof toastFn === "function") {
              toastFn(warnings.join(" "), "warning", 6e3);
            }
          }
          console.log(`[Export Debug] Mode: ${modeName} | Audio track present: ${hasAudio ? "yes" : "no"} | Audio duration: ${audioDuration.toFixed(2)}s | Video duration: ${actualDur.toFixed(2)}s`);
          cleanup();
          resolve({ valid: warnings.length === 0, duration: actualDur, hasAudio, audioDuration, warnings });
        };
        video.onloadedmetadata = finishEvaluation;
        video.onerror = () => {
          console.log(`[Export Debug] Mode: ${modeName} | Audio track present: ${hasAudio ? "yes" : "no"} | Audio duration: ${audioDuration.toFixed(2)}s | Video metadata error`);
          cleanup();
          resolve({ valid: false, duration: 0, hasAudio, audioDuration: 0, warnings: ["Could not verify video metadata."] });
        };
        setTimeout(() => {
          if (!finished) {
            finishEvaluation();
          }
        }, 3500);
      });
    }
    /**
     * Cancels any active export
     */
    cancel() {
      this.cancelRequested = true;
      if (this.activeMediaRecorder && this.activeMediaRecorder.state !== "inactive") {
        try {
          this.activeMediaRecorder.stop();
        } catch (e) {
        }
      }
      if (this.activeAudioSource) {
        try {
          this.activeAudioSource.stop();
          this.activeAudioSource.disconnect();
        } catch (e) {
        }
      }
      if (this.activeTabStream) {
        try {
          this.activeTabStream.getTracks().forEach((t) => t.stop());
        } catch (e) {
        }
        this.activeTabStream = null;
      }
      this.isExporting = false;
    }
    /**
     * EXPORT MODE 1 — With Voice-Over Audio (Mode B)
     * Uses WebCodecs exportFastSilent when available, falling back to MediaRecorder only if WebCodecs is unsupported.
     */
    async exportWithVoice(appState, onProgress, miniThumbCanvas) {
      var _a;
      if (!this.voiceEngine || !this.voiceEngine.audioBuffer) {
        const errMsg = "No voice-over loaded. Load or record your voice first.";
        if (typeof appState.uiToast === "function") appState.uiToast(errMsg, "error");
        throw new Error(errMsg);
      }
      if (typeof window !== "undefined" && typeof window.VideoEncoder !== "undefined" && typeof window.AudioEncoder !== "undefined") {
        try {
          return await this.exportFastSilent(appState, onProgress, miniThumbCanvas);
        } catch (err) {
          if (this.cancelRequested || ((_a = err.message) == null ? void 0 : _a.includes("cancelled"))) throw err;
          console.warn("[Mode 1] WebCodecs fast export failed, falling back to real-time recorder:", err);
        }
      }
      if (this.isExporting) throw new Error("Export already in progress.");
      this.isExporting = true;
      this.cancelRequested = false;
      const totalDuration = appState.timelineDuration || 60;
      const { width, height } = this.getExportDimensions(appState);
      const renderCanvas = document.createElement("canvas");
      renderCanvas.width = width;
      renderCanvas.height = height;
      const ctx = renderCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext("2d") : null;
      if (thumbCtx) {
        thumbCtx.imageSmoothingEnabled = true;
        thumbCtx.imageSmoothingQuality = "high";
      }
      const fps = 30;
      const canvasStream = renderCanvas.captureStream(fps);
      const audioCtx = this.voiceEngine.getAudioContext();
      if (audioCtx) {
        await audioCtx.resume();
      }
      const mediaStreamDest = audioCtx.createMediaStreamDestination();
      const audioSourceNode = audioCtx.createBufferSource();
      audioSourceNode.buffer = this.voiceEngine.audioBuffer;
      this.voiceEngine.connectProcessingGraph(audioSourceNode, mediaStreamDest);
      this.activeAudioSource = audioSourceNode;
      const combinedStream = new MediaStream();
      const videoTrack = canvasStream.getVideoTracks()[0];
      if (videoTrack) combinedStream.addTrack(videoTrack);
      const audioTracks = mediaStreamDest.stream.getAudioTracks();
      if (!audioTracks.length || audioTracks[0].readyState !== "live" || audioTracks[0].muted) {
        this.isExporting = false;
        const errMsg = "Voice audio track is missing, muted, or ended. Cannot export voice.";
        if (typeof appState.uiToast === "function") appState.uiToast(errMsg, "error");
        throw new Error(errMsg);
      }
      combinedStream.addTrack(audioTracks[0]);
      const targetBitrate = Math.max(4e6, Math.min(4e7, Math.round(width * height * fps * 0.22)));
      console.log(`[Video Encoding Mode 1] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(targetBitrate / 1e6).toFixed(2)} Mbps`);
      const mimeType = this.getBestMimeType();
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: targetBitrate,
        audioBitsPerSecond: 192e3
      });
      this.activeMediaRecorder = recorder;
      const recordedChunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };
      return new Promise(async (resolve, reject) => {
        recorder.onstop = async () => {
          this.isExporting = false;
          if (this.cancelRequested) {
            return reject(new Error("Export was cancelled by user."));
          }
          const blob = new Blob(recordedChunks, { type: mimeType });
          const ratioTag = width > height ? "16x9" : "9x16";
          const durTag = `${Math.round(totalDuration)}s`;
          const filename = `framemix_${ratioTag}_${durTag}.${extension}`;
          this.triggerDownload(blob, filename);
          await this.verifyExportResult(blob, totalDuration, hasVoice, appState.uiToast, "Mode 1 (Real-time Voice)");
          let audioRms = 0;
          let audioOk = false;
          if (hasVoice) {
            audioRms = await this.computeBlobAudioRms(blob);
            audioOk = audioRms > 5e-4;
          }
          resolve({ blob, filename, hasAudio: hasVoice, audioOk, audioRms });
        };
        recorder.start(100);
        const startAudioTime = audioCtx.currentTime;
        if (audioSourceNode) {
          audioSourceNode.start(0);
        }
        const startTimeReal = performance.now();
        let lastRenderedTime = 0;
        const renderLoop = async () => {
          if (this.cancelRequested) {
            recorder.stop();
            return;
          }
          const elapsedClock = audioCtx.currentTime - startAudioTime;
          lastRenderedTime = elapsedClock;
          if (elapsedClock >= totalDuration) {
            if (audioSourceNode) {
              try {
                audioSourceNode.stop();
              } catch (e) {
              }
            }
            recorder.stop();
            return;
          }
          await this.renderer.renderFrame(elapsedClock, ctx, width, height, appState);
          if (thumbCtx && miniThumbCanvas) {
            thumbCtx.drawImage(renderCanvas, 0, 0, miniThumbCanvas.width, miniThumbCanvas.height);
          }
          const progressRatio = elapsedClock / totalDuration;
          const realElapsedSec = (performance.now() - startTimeReal) / 1e3;
          const etaSec = progressRatio > 0 ? realElapsedSec / progressRatio - realElapsedSec : 0;
          const currentFrame = Math.floor(elapsedClock * fps);
          const totalFrames = Math.floor(totalDuration * fps);
          if (typeof onProgress === "function") {
            onProgress({
              percent: Math.round(progressRatio * 100),
              currentFrame,
              totalFrames,
              elapsedText: this.formatTime(realElapsedSec),
              etaText: this.formatTime(Math.max(0, etaSec))
            });
          }
          setTimeout(renderLoop, 1e3 / fps);
        };
        renderLoop();
      });
    }
    /**
     * EXPORT MODE 2 — With Browser TTS Audio (Mode A)
     * Uses getDisplayMedia tab audio capture, starts speech and rendering simultaneously.
     */
    async exportWithTts(appState, onProgress, miniThumbCanvas, tabAudioStream) {
      if (this.isExporting) throw new Error("Export already in progress.");
      this.isExporting = true;
      this.cancelRequested = false;
      this.activeTabStream = tabAudioStream;
      const totalDuration = appState.timelineDuration || 60;
      const { width, height } = this.getExportDimensions(appState);
      const renderCanvas = document.createElement("canvas");
      renderCanvas.width = width;
      renderCanvas.height = height;
      const ctx = renderCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext("2d") : null;
      if (thumbCtx) {
        thumbCtx.imageSmoothingEnabled = true;
        thumbCtx.imageSmoothingQuality = "high";
      }
      const fps = 30;
      const canvasStream = renderCanvas.captureStream(fps);
      const combinedStream = new MediaStream();
      const videoTrack = canvasStream.getVideoTracks()[0];
      if (videoTrack) combinedStream.addTrack(videoTrack);
      const tabAudioTracks = tabAudioStream ? tabAudioStream.getAudioTracks() : [];
      if (!tabAudioTracks.length || tabAudioTracks[0].readyState !== "live" || tabAudioTracks[0].muted) {
        this.isExporting = false;
        const errMsg = "Tab audio track is missing, muted, or ended. Please share tab audio before export.";
        if (typeof appState.uiToast === "function") appState.uiToast(errMsg, "error");
        throw new Error(errMsg);
      }
      combinedStream.addTrack(tabAudioTracks[0]);
      const targetBitrate = this.getOptimalVideoBitrate(width, height, fps);
      console.log(`[Video Encoding Mode 2] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(targetBitrate / 1e6).toFixed(2)} Mbps`);
      const mimeType = this.getBestMimeType();
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: targetBitrate,
        audioBitsPerSecond: 192e3
      });
      this.activeMediaRecorder = recorder;
      const recordedChunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };
      return new Promise(async (resolve, reject) => {
        recorder.onstop = async () => {
          this.isExporting = false;
          if (this.activeTabStream) {
            this.activeTabStream.getTracks().forEach((t) => t.stop());
            this.activeTabStream = null;
          }
          if (this.cancelRequested) {
            return reject(new Error("Export was cancelled by user."));
          }
          const blob = new Blob(recordedChunks, { type: mimeType });
          const ratioTag = width > height ? "16x9" : "9x16";
          const durTag = `${Math.round(totalDuration)}s`;
          const filename = `framemix_${ratioTag}_${durTag}.${extension}`;
          this.triggerDownload(blob, filename);
          await this.verifyExportResult(blob, totalDuration, true, appState.uiToast, "Mode 2 (Browser TTS)");
          resolve({ blob, filename });
        };
        recorder.start(100);
        let scriptChunks = (appState.captionEngine.chunks || []).map((c) => c.text);
        if (!scriptChunks.length && appState.scriptText) {
          scriptChunks = appState.captionEngine.splitScriptIntoSentences(appState.scriptText);
        }
        if (scriptChunks.length > 0) {
          this.voiceEngine.speakChunks(scriptChunks, appState.ttsOptions, null, null);
        }
        const startTimeReal = performance.now();
        const renderLoop = async () => {
          if (this.cancelRequested) {
            this.voiceEngine.stopSpeaking();
            recorder.stop();
            return;
          }
          const elapsedSec = (performance.now() - startTimeReal) / 1e3;
          if (elapsedSec >= totalDuration) {
            this.voiceEngine.stopSpeaking();
            recorder.stop();
            return;
          }
          await this.renderer.renderFrame(elapsedSec, ctx, width, height, appState);
          if (thumbCtx && miniThumbCanvas) {
            thumbCtx.drawImage(renderCanvas, 0, 0, miniThumbCanvas.width, miniThumbCanvas.height);
          }
          const progressRatio = elapsedSec / totalDuration;
          const etaSec = progressRatio > 0 ? elapsedSec / progressRatio - elapsedSec : 0;
          if (typeof onProgress === "function") {
            onProgress({
              percent: Math.round(progressRatio * 100),
              currentFrame: Math.floor(elapsedSec * fps),
              totalFrames: Math.floor(totalDuration * fps),
              elapsedText: this.formatTime(elapsedSec),
              etaText: this.formatTime(Math.max(0, etaSec))
            });
          }
          setTimeout(renderLoop, 1e3 / fps);
        };
        renderLoop();
      });
    }
    /**
     * EXPORT MODE 3 — Ultra-Fast Render (with Voice when voice track exists)
     * Uses WebCodecs VideoEncoder + AudioEncoder + vendored mp4-muxer.
     * If WebCodecs or AudioEncoder is not supported, falls back to MediaRecorder WITH audio.
     */
    /**
     * EXPORT MODE 3 — Ultra-Fast Render (with Voice when voice track exists)
     * Uses WebCodecs VideoEncoder + AudioEncoder + vendored mp4-muxer.
     * If WebCodecs or AudioEncoder is not supported, falls back to MediaRecorder WITH audio.
     * @param {object} appState 
     * @param {function} onProgress 
     * @param {HTMLCanvasElement} [miniThumbCanvas] 
     * @param {boolean} [forceRawAudio] If true, encodes raw audioBuffer without DSP (used for retry)
     */
    /**
     * EXPORT MODE 3 — Ultra-Fast Render (with Voice when voice track exists)
     * Uses WebCodecs VideoEncoder + AudioEncoder + vendored mp4-muxer.
     * Deterministic WebCodecs path.
     * @param {object} appState 
     * @param {function} onProgress 
     * @param {HTMLCanvasElement} [miniThumbCanvas] 
     */
    async exportFastSilent(appState, onProgress, miniThumbCanvas, autoDownload = true) {
      var _a;
      if (this.isExporting) throw new Error("Export already in progress.");
      this.isExporting = true;
      this.cancelRequested = false;
      const totalDuration = appState.timelineDuration || 60;
      const { width, height } = this.getExportDimensions(appState);
      const fps = 30;
      const totalFrames = Math.floor(totalDuration * fps);
      const renderCanvas = document.createElement("canvas");
      renderCanvas.width = width;
      renderCanvas.height = height;
      const ctx = renderCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext("2d") : null;
      if (thumbCtx) {
        thumbCtx.imageSmoothingEnabled = true;
        thumbCtx.imageSmoothingQuality = "high";
      }
      const hasVoice2 = !!(this.voiceEngine && this.voiceEngine.audioBuffer);
      const hasWebCodecs = typeof window !== "undefined" && typeof window.VideoEncoder !== "undefined";
      try {
        let exportAudio = null;
        if (hasVoice2) {
          exportAudio = await this.buildExportAudio(totalDuration);
        }
        if (!hasWebCodecs) {
          if (hasVoice2) {
            throw new Error("WebCodecs VideoEncoder is not supported in this browser. Cannot export with voice.");
          }
          this.isExporting = false;
          return await this.exportWithVoice(appState, onProgress, miniThumbCanvas);
        }
        if (exportAudio && (typeof window === "undefined" || typeof window.AudioEncoder === "undefined")) {
          throw new Error("WebCodecs AudioEncoder is not supported in this browser. Cannot export with voice.");
        }
        const codecs = await this.pickCodecs(width, height, fps, !!exportAudio);
        console.log(`[Video Encoding Mode 3] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(codecs.videoBitrate / 1e6).toFixed(2)} Mbps | Codec: ${codecs.videoCodec}`);
        const Muxer2 = Muxer;
        const ArrayBufferTarget2 = ArrayBufferTarget;
        const muxer = new Muxer2({
          target: new ArrayBufferTarget2(),
          video: {
            codec: codecs.muxerVideoCodec,
            width,
            height
          },
          audio: exportAudio ? {
            codec: codecs.muxerAudioCodec,
            numberOfChannels: 2,
            sampleRate: 48e3
          } : void 0,
          fastStart: "in-memory",
          firstTimestampBehavior: "offset"
        });
        if (exportAudio) {
          let audioEncoderError = null;
          const audioEncoder = new AudioEncoder({
            output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
            error: (e) => {
              console.error("[WebCodecs AudioEncoder Error]", e);
              audioEncoderError = e;
            }
          });
          await audioEncoder.configure({
            codec: codecs.audioCodec,
            sampleRate: exportAudio.sampleRate,
            numberOfChannels: 2,
            bitrate: 192e3
          });
          const sampleRate = exportAudio.sampleRate;
          const totalAudioFrames = exportAudio.frames;
          const ch0 = exportAudio.channels[0];
          const ch1 = exportAudio.channels[1];
          const chunkSize = 4096;
          for (let offset = 0; offset < totalAudioFrames; offset += chunkSize) {
            if (this.cancelRequested) {
              audioEncoder.close();
              this.isExporting = false;
              throw new Error("Export was cancelled by user.");
            }
            if (audioEncoderError) {
              audioEncoder.close();
              throw audioEncoderError;
            }
            const chunkFrames = Math.min(chunkSize, totalAudioFrames - offset);
            const planarData = new Float32Array(chunkFrames * 2);
            for (let i = 0; i < chunkFrames; i++) {
              planarData[i] = ch0[offset + i];
              planarData[chunkFrames + i] = ch1[offset + i];
            }
            const timestampMicros = Math.round(offset / sampleRate * 1e6);
            const audioData = new AudioData({
              format: "f32-planar",
              sampleRate,
              numberOfFrames: chunkFrames,
              numberOfChannels: 2,
              timestamp: timestampMicros,
              data: planarData
            });
            audioEncoder.encode(audioData);
            audioData.close();
          }
          await audioEncoder.flush();
          audioEncoder.close();
          if (audioEncoderError) throw audioEncoderError;
        }
        let videoEncoderError = null;
        const videoEncoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => {
            console.error("[WebCodecs VideoEncoder Error]", e);
            videoEncoderError = e;
          }
        });
        await videoEncoder.configure({
          codec: codecs.videoCodec,
          width,
          height,
          bitrate: codecs.videoBitrate,
          bitrateMode: "variable",
          latencyMode: "quality",
          framerate: fps
        });
        const startTimeReal = performance.now();
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          if (this.cancelRequested) {
            videoEncoder.close();
            this.isExporting = false;
            throw new Error("Export was cancelled by user.");
          }
          if (videoEncoderError) {
            videoEncoder.close();
            throw videoEncoderError;
          }
          while (videoEncoder.encodeQueueSize > 12) {
            if (this.cancelRequested) {
              videoEncoder.close();
              this.isExporting = false;
              throw new Error("Export was cancelled by user.");
            }
            await new Promise((r) => setTimeout(r, 4));
          }
          const t = frameIdx / fps;
          await this.renderer.renderFrame(t, ctx, width, height, appState);
          if (thumbCtx && miniThumbCanvas && frameIdx % 5 === 0) {
            thumbCtx.drawImage(renderCanvas, 0, 0, miniThumbCanvas.width, miniThumbCanvas.height);
          }
          const timestampMicros = Math.round(t * 1e6);
          const videoFrame = new VideoFrame(renderCanvas, { timestamp: timestampMicros });
          const keyFrame = frameIdx % (fps * 2) === 0;
          videoEncoder.encode(videoFrame, { keyFrame });
          videoFrame.close();
          if (frameIdx % 4 === 0 || frameIdx === totalFrames - 1) {
            const progressRatio = (frameIdx + 1) / totalFrames;
            const elapsedSec = (performance.now() - startTimeReal) / 1e3;
            const etaSec = progressRatio > 0 ? elapsedSec / progressRatio - elapsedSec : 0;
            if (typeof onProgress === "function") {
              onProgress({
                percent: Math.round(progressRatio * 100),
                currentFrame: frameIdx + 1,
                totalFrames,
                elapsedText: this.formatTime(elapsedSec),
                etaText: this.formatTime(Math.max(0, etaSec))
              });
            }
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        await videoEncoder.flush();
        videoEncoder.close();
        if (videoEncoderError) throw videoEncoderError;
        muxer.finalize();
        const buffer = muxer.target.buffer;
        const blob = new Blob([buffer], { type: "video/mp4" });
        const ratioTag = width > height ? "16x9" : "9x16";
        const durTag = `${Math.round(totalDuration)}s`;
        const filename = `framemix_${ratioTag}_${durTag}.mp4`;
        let audioRms = 0;
        let audioOk = false;
        const hasAudio = !!exportAudio;
        if (hasAudio) {
          audioRms = await this.computeBlobAudioRms(blob);
          audioOk = audioRms > 5e-4;
          console.log(`[Export audio] Output blob audio RMS: ${audioRms.toFixed(5)} | audioOk: ${audioOk}`);
          if (!audioOk && typeof (appState == null ? void 0 : appState.uiToast) === "function") {
            appState.uiToast("Exported file has no audible audio. Check your voice file", "error", 7e3);
          }
        }
        if (autoDownload) {
          this.triggerDownload(blob, filename);
        }
        this.isExporting = false;
        await this.verifyExportResult(blob, totalDuration, hasAudio, appState.uiToast, "Mode 3 (Fast Render)");
        return { blob, filename, hasAudio, audioOk, audioRms };
      } catch (err) {
        this.isExporting = false;
        if (this.cancelRequested || ((_a = err.message) == null ? void 0 : _a.includes("cancelled"))) {
          throw err;
        }
        if (hasVoice2) {
          throw err;
        }
        console.warn("[WebCodecs] Silent render failed, falling back to MediaRecorder:", err);
        return await this.exportWithVoice(appState, onProgress, miniThumbCanvas);
      }
    }
  };

  // js/ui.js
  var UIController = class {
    constructor() {
      this.toastContainer = document.getElementById("toastContainer");
    }
    /**
     * Displays a modern toast alert
     * @param {string} message 
     * @param {'success'|'error'|'info'} type 
     * @param {number} durationMs 
     */
    showToast(message, type = "info", durationMs = 3500) {
      if (!this.toastContainer) return;
      const toast = document.createElement("div");
      toast.className = `toast toast-${type}`;
      let icon = "\u2139\uFE0F";
      if (type === "success") icon = "\u2713";
      if (type === "error") icon = "\u26A0\uFE0F";
      toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
      this.toastContainer.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
        toast.style.transition = "all 0.25s ease";
        setTimeout(() => toast.remove(), 250);
      }, durationMs);
    }
    /**
     * Sets current wizard step (1 to 8)
     * @param {number} stepNumber 
     * @param {Array<number>} [unlockedSteps] List of unlocked steps
     */
    setStep(stepNumber, unlockedSteps = null) {
      for (let i = 1; i <= 8; i++) {
        const btn = document.getElementById(`stepBtn${i}`);
        const sec = document.getElementById(`step${i}Section`);
        if (btn) {
          btn.classList.toggle("active", i === stepNumber);
          btn.classList.toggle("done", i < stepNumber);
          btn.classList.toggle("completed", i < stepNumber);
          if (unlockedSteps) {
            const isUnlocked = unlockedSteps.includes(i);
            btn.classList.toggle("locked", !isUnlocked);
          }
        }
        if (sec) {
          sec.classList.toggle("active", i === stepNumber);
        }
      }
      const mobileStepName = document.getElementById("mobileStepName");
      if (mobileStepName) {
        const names = [
          "Step 1: Source & Frames",
          "Step 2: Voice & Script",
          "Step 3: Studio & Export",
          "Step 4: Publish Portal"
        ];
        mobileStepName.textContent = names[stepNumber - 1] || `Step ${stepNumber}`;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    /**
     * Formats seconds into MM:SS.s
     * @param {number} sec 
     * @returns {string}
     */
    formatTime(sec) {
      const s = Math.max(0, sec || 0);
      const m = Math.floor(s / 60);
      const remainder = s % 60;
      const wholeSec = Math.floor(remainder);
      const frac = Math.floor(remainder % 1 * 10);
      return `${String(m).padStart(2, "0")}:${String(wholeSec).padStart(2, "0")}.${frac}`;
    }
    /**
     * Formats byte counts into human readable strings
     * @param {number} bytes 
     * @returns {string}
     */
    formatBytes(bytes2) {
      if (!bytes2 || bytes2 === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes2) / Math.log(k));
      return `${parseFloat((bytes2 / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }
    /**
     * Renders the Extracted Frames Gallery Grid
     * @param {Array<object>} frames 
     * @param {object} callbacks 
     */
    renderFramesGrid(frames = [], callbacks = {}, filterStarredOnly = false) {
      const grid = document.getElementById("extractedGalleryGrid") || document.getElementById("framesGrid");
      const totalBadge = document.getElementById("totalExtractedBadge");
      if (totalBadge) totalBadge.textContent = `${frames.length} Photos`;
      const starredBadge = document.getElementById("starredCountBadge");
      if (starredBadge) {
        const starredCount = frames.filter((f) => f.starred).length;
        starredBadge.textContent = `${starredCount} Starred`;
      }
      if (!grid) return;
      grid.innerHTML = "";
      const list = filterStarredOnly ? frames.filter((f) => f.starred) : frames;
      if (list.length === 0) {
        grid.innerHTML = `<div class="empty-placeholder" style="grid-column: 1 / -1;">
        <span>${filterStarredOnly ? "No starred photos found. Click \u2B50 on any photo to star it!" : "No photos extracted yet. Upload a video or generate a sample video above."}</span>
      </div>`;
        return;
      }
      let onToggleStar, onDeleteFrame, onPreviewFrame;
      if (typeof callbacks === "function") {
        onToggleStar = callbacks;
        onDeleteFrame = arguments[2];
        onPreviewFrame = arguments[3];
      } else if (callbacks && typeof callbacks === "object") {
        onToggleStar = callbacks.onToggleStar;
        onDeleteFrame = callbacks.onDeleteFrame;
        onPreviewFrame = callbacks.onPreviewFrame;
      }
      list.forEach((frame) => {
        const card = document.createElement("div");
        card.className = `frame-card ${frame.starred ? "is-starred" : ""}`;
        card.dataset.id = frame.id;
        const mins = Math.floor(frame.timestamp / 60);
        const secs = Math.floor(frame.timestamp % 60);
        const timeTag = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        const ratioTag = frame.aspectRatio || "16:9";
        const imgSrc = frame.previewUrl || frame.dataUrl || "";
        card.innerHTML = `
        <div class="frame-thumb-wrapper" title="Click to view full preview">
          <img src="${imgSrc}" alt="Extracted frame at ${timeTag}" class="frame-img" loading="lazy">
          <span class="frame-ts-badge">${timeTag}</span>
          <span class="frame-ratio-badge">${ratioTag}</span>
        </div>
        <div class="frame-actions-bar">
          <button type="button" class="frame-star-btn star-btn ${frame.starred ? "active" : ""}" title="${frame.starred ? "Remove star" : "Star photo (2.5x more appearances)"}">
            ${frame.starred ? "\u2B50" : "\u2606"}
          </button>
          <button type="button" class="frame-recrop-btn" title="Adjust Crop & Framing (\u2702\uFE0F)">
            \u2702\uFE0F
          </button>
          <button type="button" class="frame-delete-btn" title="Delete photo">
            \u{1F5D1}\uFE0F
          </button>
        </div>
      `;
        const thumb = card.querySelector(".frame-thumb-wrapper");
        thumb == null ? void 0 : thumb.addEventListener("click", () => {
          if (typeof onPreviewFrame === "function") onPreviewFrame(frame);
        });
        const starBtn = card.querySelector(".frame-star-btn");
        starBtn == null ? void 0 : starBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (typeof onToggleStar === "function") onToggleStar(frame.id);
        });
        const delBtn = card.querySelector(".frame-delete-btn");
        delBtn == null ? void 0 : delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (typeof onDeleteFrame === "function") onDeleteFrame(frame.id);
        });
        grid.appendChild(card);
      });
    }
    /**
     * Updates the live camera viewfinder framing box and dark masks over the video player
     * @param {HTMLElement} viewportEl 
     * @param {number} sourceW 
     * @param {number} sourceH 
     * @param {string} targetRatio '16:9' | '9:16' | '1:1' | '4:5' | 'custom' | 'source'
     * @param {number} cropOffsetX 0.0 to 1.0
     * @param {number} cropOffsetY 0.0 to 1.0
     * @param {object} [customNorm] Normalized custom crop box { x, y, w, h }
     */
    updateClipperFramingOverlay(viewportEl, sourceW, sourceH, targetRatio = "16:9", cropOffsetX = 0.5, cropOffsetY = 0.5, customNorm = null) {
      if (!viewportEl) return;
      const dispW = viewportEl.clientWidth;
      const dispH = viewportEl.clientHeight;
      if (!dispW || !dispH || !sourceW || !sourceH) return;
      const videoAspect = sourceW / sourceH;
      const viewportAspect = dispW / dispH;
      let actualVideoW, actualVideoH, videoLeft, videoTop;
      if (viewportAspect > videoAspect) {
        actualVideoH = dispH;
        actualVideoW = dispH * videoAspect;
        videoLeft = (dispW - actualVideoW) / 2;
        videoTop = 0;
      } else {
        actualVideoW = dispW;
        actualVideoH = dispW / videoAspect;
        videoLeft = 0;
        videoTop = (dispH - actualVideoH) / 2;
      }
      let targetAspect = videoAspect;
      if (targetRatio === "16:9" || targetRatio === "16:9-720p") targetAspect = 16 / 9;
      else if (targetRatio === "9:16") targetAspect = 9 / 16;
      else if (targetRatio === "1:1") targetAspect = 1;
      else if (targetRatio === "4:5") targetAspect = 4 / 5;
      else if (targetRatio === "custom" && customNorm && customNorm.h > 0) targetAspect = customNorm.w * actualVideoW / (customNorm.h * actualVideoH);
      let cropW = actualVideoW;
      let cropH = actualVideoH;
      let cropLeft = videoLeft;
      let cropTop = videoTop;
      const maskLeft = document.getElementById("cropMaskLeft");
      const maskRight = document.getElementById("cropMaskRight");
      const maskTop = document.getElementById("cropMaskTop");
      const maskBottom = document.getElementById("cropMaskBottom");
      const cropWindow = document.getElementById("cropWindow");
      const tagEl = document.getElementById("cropWindowRatioTag");
      if (!cropWindow) return;
      if (targetRatio === "custom" && customNorm) {
        cropLeft = videoLeft + customNorm.x * actualVideoW;
        cropTop = videoTop + customNorm.y * actualVideoH;
        cropW = customNorm.w * actualVideoW;
        cropH = customNorm.h * actualVideoH;
        if (maskLeft) {
          maskLeft.style.display = "block";
          maskLeft.style.left = `${videoLeft}px`;
          maskLeft.style.top = `${videoTop}px`;
          maskLeft.style.width = `${Math.max(0, cropLeft - videoLeft)}px`;
          maskLeft.style.height = `${actualVideoH}px`;
        }
        if (maskRight) {
          maskRight.style.display = "block";
          maskRight.style.left = `${cropLeft + cropW}px`;
          maskRight.style.top = `${videoTop}px`;
          maskRight.style.width = `${Math.max(0, videoLeft + actualVideoW - (cropLeft + cropW))}px`;
          maskRight.style.height = `${actualVideoH}px`;
        }
        if (maskTop) {
          maskTop.style.display = "block";
          maskTop.style.left = `${cropLeft}px`;
          maskTop.style.top = `${videoTop}px`;
          maskTop.style.width = `${cropW}px`;
          maskTop.style.height = `${Math.max(0, cropTop - videoTop)}px`;
        }
        if (maskBottom) {
          maskBottom.style.display = "block";
          maskBottom.style.left = `${cropLeft}px`;
          maskBottom.style.top = `${cropTop + cropH}px`;
          maskBottom.style.width = `${cropW}px`;
          maskBottom.style.height = `${Math.max(0, videoTop + actualVideoH - (cropTop + cropH))}px`;
        }
      } else if (videoAspect > targetAspect) {
        cropH = actualVideoH;
        cropW = actualVideoH * targetAspect;
        const excessX = Math.max(0, actualVideoW - cropW);
        cropLeft = videoLeft + excessX * Math.max(0, Math.min(1, cropOffsetX));
        cropTop = videoTop;
        if (maskLeft) {
          maskLeft.style.display = "block";
          maskLeft.style.left = `${videoLeft}px`;
          maskLeft.style.top = `${videoTop}px`;
          maskLeft.style.width = `${Math.max(0, cropLeft - videoLeft)}px`;
          maskLeft.style.height = `${actualVideoH}px`;
        }
        if (maskRight) {
          maskRight.style.display = "block";
          maskRight.style.left = `${cropLeft + cropW}px`;
          maskRight.style.top = `${videoTop}px`;
          maskRight.style.width = `${Math.max(0, videoLeft + actualVideoW - (cropLeft + cropW))}px`;
          maskRight.style.height = `${actualVideoH}px`;
        }
        if (maskTop) maskTop.style.display = "none";
        if (maskBottom) maskBottom.style.display = "none";
      } else if (videoAspect < targetAspect) {
        cropW = actualVideoW;
        cropH = actualVideoW / targetAspect;
        const excessY = Math.max(0, actualVideoH - cropH);
        cropTop = videoTop + excessY * Math.max(0, Math.min(1, cropOffsetY));
        cropLeft = videoLeft;
        if (maskTop) {
          maskTop.style.display = "block";
          maskTop.style.left = `${videoLeft}px`;
          maskTop.style.top = `${videoTop}px`;
          maskTop.style.width = `${actualVideoW}px`;
          maskTop.style.height = `${Math.max(0, cropTop - videoTop)}px`;
        }
        if (maskBottom) {
          maskBottom.style.display = "block";
          maskBottom.style.left = `${videoLeft}px`;
          maskBottom.style.top = `${cropTop + cropH}px`;
          maskBottom.style.width = `${actualVideoW}px`;
          maskBottom.style.height = `${Math.max(0, videoTop + actualVideoH - (cropTop + cropH))}px`;
        }
        if (maskLeft) maskLeft.style.display = "none";
        if (maskRight) maskRight.style.display = "none";
      } else {
        if (maskLeft) maskLeft.style.display = "none";
        if (maskRight) maskRight.style.display = "none";
        if (maskTop) maskTop.style.display = "none";
        if (maskBottom) maskBottom.style.display = "none";
      }
      cropWindow.style.left = `${cropLeft}px`;
      cropWindow.style.top = `${cropTop}px`;
      cropWindow.style.width = `${cropW}px`;
      cropWindow.style.height = `${cropH}px`;
      if (tagEl) {
        tagEl.textContent = `${targetRatio} Viewfinder`;
      }
    }
    /**
     * Renders the Caption Chunks Editor List
     * @param {Array<object>} chunks 
     * @param {object} callbacks 
     */
    renderCaptionChunks(chunks, { onUpdateChunk, onDeleteChunk }) {
      const container = document.getElementById("captionChunksContainer") || document.getElementById("captionsListContainer");
      if (!container) return;
      container.innerHTML = "";
      if (!chunks || chunks.length === 0) {
        container.innerHTML = `<div class="empty-placeholder">
        Paste a script above to auto-generate sentence-by-sentence caption chunks.
      </div>`;
        return;
      }
      chunks.forEach((chunk, idx) => {
        const item = document.createElement("div");
        item.className = "caption-chunk-item";
        item.dataset.id = chunk.id;
        item.innerHTML = `
        <div class="chunk-header-row">
          <span class="badge">#${idx + 1}</span>
          <div class="chunk-timing-inputs">
            <span>Start:</span>
            <input type="number" step="0.1" min="0" class="chunk-time-input chunk-start-input" value="${chunk.start.toFixed(1)}">
            <span>End:</span>
            <input type="number" step="0.1" min="0" class="chunk-time-input chunk-end-input" value="${chunk.end.toFixed(1)}">
            <button type="button" class="btn btn-xs btn-ghost text-danger chunk-del-btn" title="Delete chunk">\u2715</button>
          </div>
        </div>
        <input type="text" class="chunk-text-input hindi-font" value="${chunk.text.replace(/"/g, "&quot;")}" placeholder="Caption text...">
      `;
        const startInput = item.querySelector(".chunk-start-input");
        const endInput = item.querySelector(".chunk-end-input");
        const textInput = item.querySelector(".chunk-text-input");
        const delBtn = item.querySelector(".chunk-del-btn");
        const triggerUpdate = () => {
          const newStart = parseFloat(startInput.value) || 0;
          const newEnd = Math.max(newStart + 0.2, parseFloat(endInput.value) || 1);
          const newText = textInput.value;
          onUpdateChunk(idx, { start: newStart, end: newEnd, text: newText });
        };
        startInput.addEventListener("change", triggerUpdate);
        endInput.addEventListener("change", triggerUpdate);
        textInput.addEventListener("input", triggerUpdate);
        delBtn.addEventListener("click", () => onDeleteChunk(idx));
        container.appendChild(item);
      });
      const countDisplay = document.getElementById("captionChunksCount");
      if (countDisplay) countDisplay.textContent = chunks.length;
    }
    /**
     * Renders the multi-track visual timeline
     * @param {Array<object>} segments Photo segments
     * @param {Array<object>} captions Captions
     * @param {number} totalDuration Total seconds
     */
    renderTimelineTracks(segments, captions, totalDuration) {
      const photoContent = document.getElementById("photoTrackContent");
      const captionContent = document.getElementById("captionTrackContent");
      const audioContent = document.getElementById("audioTrackContent");
      if (!photoContent || !captionContent) return;
      photoContent.innerHTML = "";
      captionContent.innerHTML = "";
      if (audioContent) audioContent.innerHTML = "";
      const safeDuration = Math.max(1, totalDuration || 60);
      segments.forEach((seg, idx) => {
        const leftPercent = seg.startTime / safeDuration * 100;
        const widthPercent = seg.duration / safeDuration * 100;
        const block = document.createElement("div");
        block.className = "photo-block";
        block.style.left = `${leftPercent}%`;
        block.style.width = `${Math.max(0.5, widthPercent)}%`;
        block.title = `Photo #${idx + 1} (${seg.animType}, ${seg.duration.toFixed(1)}s)`;
        let icon = "\u{1F50D}";
        if (seg.animType.includes("pan")) icon = "\u2194\uFE0F";
        if (seg.animType.includes("diagonal")) icon = "\u2197\uFE0F";
        block.innerHTML = `<span>${icon} P${idx + 1}</span>`;
        photoContent.appendChild(block);
      });
      captions.forEach((cap, idx) => {
        const leftPercent = cap.start / safeDuration * 100;
        const widthPercent = cap.duration / safeDuration * 100;
        const block = document.createElement("div");
        block.className = "caption-block hindi-font";
        block.style.left = `${leftPercent}%`;
        block.style.width = `${Math.max(0.5, widthPercent)}%`;
        block.title = `#${idx + 1}: ${cap.text} (${cap.start.toFixed(1)}s - ${cap.end.toFixed(1)}s)`;
        block.textContent = cap.text;
        captionContent.appendChild(block);
      });
      if (audioContent) {
        const audioBlock = document.createElement("div");
        audioBlock.className = "audio-block";
        audioBlock.style.left = "0%";
        audioBlock.style.width = "100%";
        audioContent.appendChild(audioBlock);
      }
    }
    /**
     * Updates playhead cursor position
     * @param {number} t Current timestamp
     * @param {number} totalDuration Total duration
     */
    updatePlayhead(t, totalDuration) {
      const playhead = document.getElementById("timelinePlayhead");
      if (!playhead) return;
      const safeDuration = Math.max(0.1, totalDuration || 60);
      const percent = Math.min(100, Math.max(0, t / safeDuration * 100));
      playhead.style.left = `${percent}%`;
    }
  };

  // js/storage.js
  var STORAGE_PREFIX = "frameflow_";
  function saveSetting(key, value) {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (err) {
      console.warn("[Storage] Failed to save setting:", key, err);
    }
  }
  function loadSetting(key, defaultValue) {
    try {
      if (typeof localStorage === "undefined") return defaultValue;
      const item = localStorage.getItem(STORAGE_PREFIX + key);
      if (item === null || item === void 0) return defaultValue;
      return JSON.parse(item);
    } catch (err) {
      console.warn("[Storage] Failed to load setting:", key, err);
      return defaultValue;
    }
  }
  function exportProjectJson(projectData) {
    const jsonStr = JSON.stringify(projectData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url2 = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url2;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `frameflow_project_${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url2), 2e3);
  }
  function importProjectJson(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (!data || typeof data !== "object") {
            throw new Error("Invalid project file structure.");
          }
          resolve(data);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read project file."));
      reader.readAsText(file);
    });
  }

  // js/youtube.js
  function calculateKeywordMatch(script, generatedData) {
    if (!script || !generatedData) {
      return { matched: 0, total: 10, percent: 0, badgeText: "Keyword match 0/10" };
    }
    const words = script.replace(/[^\p{L}\p{N}\s]/gu, " ").toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    const stopWords = /* @__PURE__ */ new Set([
      "this",
      "that",
      "with",
      "from",
      "have",
      "were",
      "they",
      "will",
      "your",
      "their",
      "about",
      "\u0915\u0930\u0924\u0947",
      "\u0915\u0930\u0924\u0940",
      "\u0915\u093F\u092F\u093E",
      "\u091C\u093E\u0924\u0947",
      "\u0939\u094B\u0924\u0947",
      "\u0939\u094B\u0924\u0940",
      "\u0932\u0947\u0915\u093F\u0928",
      "\u0938\u0915\u0924\u0947",
      "\u0938\u0915\u0924\u0940",
      "\u0915\u094D\u092F\u094B\u0902\u0915\u093F",
      "\u091C\u093F\u0938\u092E\u0947\u0902",
      "\u091C\u093F\u0938\u0915\u0947",
      "\u0909\u0928\u0915\u0940",
      "\u0909\u0928\u0915\u0947",
      "\u0909\u0938\u0915\u093E",
      "\u0909\u0938\u0915\u0940",
      "\u0939\u092E\u093E\u0930\u0947",
      "\u0905\u092A\u0928\u0940",
      "\u0905\u092A\u0928\u0947"
    ]);
    const freq = {};
    for (const w of words) {
      if (!stopWords.has(w)) {
        freq[w] = (freq[w] || 0) + 1;
      }
    }
    const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
    if (topKeywords.length === 0) {
      return { matched: 10, total: 10, percent: 100, badgeText: "Keyword match 10/10" };
    }
    const yt = generatedData.youtube || {};
    const fb = generatedData.facebook || {};
    const combinedGenerated = [
      ...yt.titles || [],
      yt.description || "",
      ...yt.hashtags || [],
      ...yt.tags || [],
      yt.pinned_comment || yt.pinnedComment || "",
      ...fb.headlines || [],
      fb.post_text || "",
      fb.video_title || "",
      fb.video_description || "",
      ...fb.hashtags || [],
      fb.first_comment || ""
    ].join(" ").toLowerCase();
    let matched = 0;
    for (const kw of topKeywords) {
      if (combinedGenerated.includes(kw)) {
        matched++;
      }
    }
    const total = topKeywords.length;
    const percent = Math.round(matched / total * 100);
    return {
      matched,
      total,
      percent,
      badgeText: `Keyword match ${matched}/${total}`
    };
  }
  var TRENDING_TAGS_YT = [
    "#Trending",
    "#Viral",
    "#FYP",
    "#Shorts",
    "#ViralVideo",
    "#Explore",
    "#MustWatch",
    "#TrendingNow",
    "#ForYou",
    "#YouTubeShorts",
    "#ViralShorts",
    "#DailyShorts",
    "#ExplorePage",
    "#Creator",
    "#StoryTime",
    "#ShortsViral",
    "#WatchNow",
    "#TrendingTopic",
    "#NewVideo",
    "#Entertainment",
    "#TopTrending",
    "#VideoOfTheDay"
  ];
  var TRENDING_TAGS_FB = [
    "#Trending",
    "#Viral",
    "#Reels",
    "#FYP",
    "#ViralPost",
    "#Explore",
    "#FacebookReels",
    "#ViralReels",
    "#TrendingReels",
    "#ForYouPage",
    "#MustWatch",
    "#DailyReels",
    "#TrendingNow",
    "#WatchThis",
    "#ReelsViral",
    "#ViralVideo",
    "#ReelItFeelIt",
    "#Shorts",
    "#VideoOfTheDay",
    "#TopTrend",
    "#TrendingPost",
    "#Creators"
  ];
  var YouTubeMetaGenerator = class {
    constructor(app) {
      this.app = app;
      this.geminiConfigured = false;
      this.currentData = null;
      this.selectedTitleIndex = 0;
      this.selectedHeadlineIndex = 0;
      this.ytHashtagsList = [];
      this.fbHashtagsList = [];
      this.isLoading = false;
      this.activeTab = "youtube";
      this.generatedForScriptText = "";
    }
    /**
     * Initializes event listeners, checks backend config, and hooks project save/restore
     */
    async init() {
      this.cacheDomElements();
      this.bindEvents();
      this.hookProjectSerialization();
      await this.checkBackendConfig();
      this.updateScriptSummary();
    }
    cacheDomElements() {
      this.geminiMissingBanner = document.getElementById("geminiMissingBanner");
      this.scriptEmptyWarning = document.getElementById("portalScriptEmptyWarning");
      this.scriptChangedBanner = document.getElementById("portalScriptChangedBanner");
      this.scriptChangedRegenBtn = document.getElementById("portalScriptChangedRegenBtn");
      this.keywordMatchBadge = document.getElementById("portalKeywordMatchBadge");
      this.scriptWordCountDisplay = document.getElementById("portalScriptWordCount");
      this.scriptSnippetDisplay = document.getElementById("portalScriptSnippet");
      this.editScriptLink = document.getElementById("portalEditScriptLink");
      this.langSelect = document.getElementById("portalLangSelect") || document.getElementById("ytLangSelect");
      this.toneSelect = document.getElementById("portalToneSelect") || document.getElementById("ytToneSelect");
      this.videoTypeSelect = document.getElementById("portalVideoTypeSelect") || document.getElementById("ytVideoTypeSelect");
      this.nicheInput = document.getElementById("portalNicheInput") || document.getElementById("ytNicheInput");
      this.audienceInput = document.getElementById("portalAudienceInput") || document.getElementById("ytAudienceInput");
      this.platformToggle = document.getElementById("portalPlatformSelect");
      this.generateBtn = document.getElementById("portalGenerateBtn") || document.getElementById("ytGenerateBtn");
      this.regenerateBtn = document.getElementById("portalRegenerateBtn") || document.getElementById("ytRegenerateBtn");
      this.skeletonLoader = document.getElementById("portalSkeletonLoader");
      this.resultsContainer = document.getElementById("portalResultsContainer") || document.getElementById("ytResultsContainer");
      this.tabYtBtn = document.getElementById("portalTabYtBtn") || document.getElementById("publishTabYtBtn");
      this.tabFbBtn = document.getElementById("portalTabFbBtn") || document.getElementById("publishTabFbBtn");
      this.panelYt = document.getElementById("portalPanelYt") || document.getElementById("publishPanelYt");
      this.panelFb = document.getElementById("portalPanelFb") || document.getElementById("publishPanelFb");
      this.ytTitlesList = document.getElementById("ytTitlesList");
      this.descInput = document.getElementById("ytDescInput");
      this.descCounter = document.getElementById("ytDescCounter");
      this.ytHashtagsContainer = document.getElementById("ytHashtagsContainer");
      this.ytAddHashtagInput = document.getElementById("ytAddHashtagInput");
      this.ytAddHashtagBtn = document.getElementById("ytAddHashtagBtn");
      this.ytAddTrendingBtn = document.getElementById("ytAddTrendingBtn");
      this.tagsInput = document.getElementById("ytTagsInput");
      this.tagsCounter = document.getElementById("ytTagsCounter");
      this.pinnedCommentInput = document.getElementById("ytPinnedCommentInput");
      this.copyTitleBtn = document.getElementById("ytCopyTitleBtn");
      this.copyDescBtn = document.getElementById("ytCopyDescBtn");
      this.ytFormatDescBtn = document.getElementById("ytFormatDescBtn");
      this.copyHashtagsBtn = document.getElementById("ytCopyHashtagsBtn");
      this.copyTagsBtn = document.getElementById("ytCopyTagsBtn");
      this.copyPinnedBtn = document.getElementById("ytCopyPinnedBtn");
      this.copyAllYtBtn = document.getElementById("ytCopyAllBtn");
      this.downloadYtTxtBtn = document.getElementById("ytDownloadTxtBtn");
      this.openYtStudioBtn = document.getElementById("openYtStudioBtn");
      this.fbHeadlinesList = document.getElementById("fbHeadlinesList");
      this.fbPostInput = document.getElementById("fbPostInput") || document.getElementById("fbCaptionInput");
      this.fbPostCounter = document.getElementById("fbPostCounter");
      this.fbVideoTitleInput = document.getElementById("fbVideoTitleInput");
      this.fbVideoDescInput = document.getElementById("fbVideoDescInput");
      this.fbHashtagsContainer = document.getElementById("fbHashtagsContainer");
      this.fbAddHashtagInput = document.getElementById("fbAddHashtagInput");
      this.fbAddHashtagBtn = document.getElementById("fbAddHashtagBtn");
      this.fbAddTrendingBtn = document.getElementById("fbAddTrendingBtn");
      this.fbCommentInput = document.getElementById("fbFirstCommentInput");
      this.copyFbHeadlineBtn = document.getElementById("copyFbHeadlineBtn");
      this.copyFbPostBtn = document.getElementById("copyFbPostBtn") || document.getElementById("copyFbCaptionBtn");
      this.fbFormatPostBtn = document.getElementById("fbFormatPostBtn");
      this.copyFbTitleBtn = document.getElementById("copyFbTitleBtn");
      this.copyFbDescBtn = document.getElementById("copyFbDescBtn");
      this.copyFbHashtagsBtn = document.getElementById("copyFbHashtagsBtn");
      this.copyFbCommentBtn = document.getElementById("copyFbCommentBtn");
      this.copyAllFbBtn = document.getElementById("copyAllFbBtn");
      this.downloadFbTxtBtn = document.getElementById("downloadFbTxtBtn");
      this.openFbComposerBtn = document.getElementById("openFbComposerBtn");
      this.openFbReelsBtn = document.getElementById("openFbReelsBtn");
      this.backToStep3Btn = document.getElementById("backToStep3Btn");
    }
    async checkBackendConfig() {
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const data = await res.json();
          this.geminiConfigured = Boolean(data.geminiConfigured);
        } else {
          this.geminiConfigured = false;
        }
      } catch (e) {
        this.geminiConfigured = false;
      }
      if (this.geminiMissingBanner) {
        this.geminiMissingBanner.classList.toggle("hidden", this.geminiConfigured);
      }
    }
    bindEvents() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E, _F, _G, _H, _I, _J;
      (_a = this.editScriptLink) == null ? void 0 : _a.addEventListener("click", (e) => {
        var _a2;
        e.preventDefault();
        (_a2 = this.app) == null ? void 0 : _a2.goToStep(2);
      });
      (_b = this.backToStep3Btn) == null ? void 0 : _b.addEventListener("click", () => {
        var _a2;
        (_a2 = this.app) == null ? void 0 : _a2.goToStep(3);
      });
      (_c = this.tabYtBtn) == null ? void 0 : _c.addEventListener("click", () => this.switchTab("youtube"));
      (_d = this.tabFbBtn) == null ? void 0 : _d.addEventListener("click", () => this.switchTab("facebook"));
      (_e = this.generateBtn) == null ? void 0 : _e.addEventListener("click", () => this.generate());
      (_f = this.regenerateBtn) == null ? void 0 : _f.addEventListener("click", () => this.generate());
      (_g = this.scriptChangedRegenBtn) == null ? void 0 : _g.addEventListener("click", () => this.generate());
      (_h = this.descInput) == null ? void 0 : _h.addEventListener("input", () => this.updateCounters());
      (_i = this.tagsInput) == null ? void 0 : _i.addEventListener("input", () => this.updateCounters());
      (_j = this.fbPostInput) == null ? void 0 : _j.addEventListener("input", () => this.updateCounters());
      (_k = this.ytAddHashtagBtn) == null ? void 0 : _k.addEventListener("click", () => this.addCustomYtHashtag());
      (_l = this.ytAddTrendingBtn) == null ? void 0 : _l.addEventListener("click", () => this.addTrendingPack("yt"));
      (_m = this.ytAddHashtagInput) == null ? void 0 : _m.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.addCustomYtHashtag();
        }
      });
      (_n = this.fbAddHashtagBtn) == null ? void 0 : _n.addEventListener("click", () => this.addCustomFbHashtag());
      (_o = this.fbAddTrendingBtn) == null ? void 0 : _o.addEventListener("click", () => this.addTrendingPack("fb"));
      (_p = this.fbAddHashtagInput) == null ? void 0 : _p.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.addCustomFbHashtag();
        }
      });
      (_q = this.copyTitleBtn) == null ? void 0 : _q.addEventListener("click", () => this.copySelectedTitle());
      (_r = this.copyDescBtn) == null ? void 0 : _r.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.descInput) == null ? void 0 : _a2.value) || "", "YouTube Description");
      });
      (_s = this.ytFormatDescBtn) == null ? void 0 : _s.addEventListener("click", () => this.autoFormatYouTubeDescription());
      (_t = this.copyHashtagsBtn) == null ? void 0 : _t.addEventListener("click", () => this.copyToClipboard(this.ytHashtagsList.join(" "), "YouTube Hashtags"));
      (_u = this.copyTagsBtn) == null ? void 0 : _u.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.tagsInput) == null ? void 0 : _a2.value) || "", "YouTube Keyword Tags");
      });
      (_v = this.copyPinnedBtn) == null ? void 0 : _v.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.pinnedCommentInput) == null ? void 0 : _a2.value) || "", "Pinned Comment");
      });
      (_w = this.copyAllYtBtn) == null ? void 0 : _w.addEventListener("click", () => this.copyAllYouTube());
      (_x = this.downloadYtTxtBtn) == null ? void 0 : _x.addEventListener("click", () => this.downloadYouTubeTxt());
      (_y = this.openYtStudioBtn) == null ? void 0 : _y.addEventListener("click", () => {
        window.open("https://studio.youtube.com", "_blank", "noopener,noreferrer");
      });
      (_z = this.copyFbHeadlineBtn) == null ? void 0 : _z.addEventListener("click", () => this.copySelectedHeadline());
      (_A = this.copyFbPostBtn) == null ? void 0 : _A.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.fbPostInput) == null ? void 0 : _a2.value) || "", "Facebook Post");
      });
      (_B = this.fbFormatPostBtn) == null ? void 0 : _B.addEventListener("click", () => this.autoFormatFacebookPost());
      (_C = this.copyFbTitleBtn) == null ? void 0 : _C.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.fbVideoTitleInput) == null ? void 0 : _a2.value) || "", "Facebook Video Title");
      });
      (_D = this.copyFbDescBtn) == null ? void 0 : _D.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.fbVideoDescInput) == null ? void 0 : _a2.value) || "", "Facebook Video Description");
      });
      (_E = this.copyFbHashtagsBtn) == null ? void 0 : _E.addEventListener("click", () => this.copyToClipboard(this.fbHashtagsList.join(" "), "Facebook Hashtags"));
      (_F = this.copyFbCommentBtn) == null ? void 0 : _F.addEventListener("click", () => {
        var _a2;
        return this.copyToClipboard(((_a2 = this.fbCommentInput) == null ? void 0 : _a2.value) || "", "Facebook First Comment");
      });
      (_G = this.copyAllFbBtn) == null ? void 0 : _G.addEventListener("click", () => this.copyAllFacebook());
      (_H = this.downloadFbTxtBtn) == null ? void 0 : _H.addEventListener("click", () => this.downloadFacebookTxt());
      (_I = this.openFbComposerBtn) == null ? void 0 : _I.addEventListener("click", () => {
        window.open("https://www.facebook.com", "_blank", "noopener,noreferrer");
      });
      (_J = this.openFbReelsBtn) == null ? void 0 : _J.addEventListener("click", () => {
        window.open("https://business.facebook.com/creatorstudio", "_blank", "noopener,noreferrer");
      });
    }
    switchTab(tabName) {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      this.activeTab = tabName;
      if (tabName === "youtube") {
        (_a = this.tabYtBtn) == null ? void 0 : _a.classList.add("active");
        (_b = this.tabFbBtn) == null ? void 0 : _b.classList.remove("active");
        (_c = this.panelYt) == null ? void 0 : _c.classList.remove("hidden");
        (_d = this.panelFb) == null ? void 0 : _d.classList.add("hidden");
      } else {
        (_e = this.tabFbBtn) == null ? void 0 : _e.classList.add("active");
        (_f = this.tabYtBtn) == null ? void 0 : _f.classList.remove("active");
        (_g = this.panelFb) == null ? void 0 : _g.classList.remove("hidden");
        (_h = this.panelYt) == null ? void 0 : _h.classList.add("hidden");
      }
    }
    updateScriptSummary() {
      var _a, _b;
      const script = this.getSourceText();
      const words = script ? script.trim().split(/\s+/).filter(Boolean).length : 0;
      if (this.scriptWordCountDisplay) {
        this.scriptWordCountDisplay.textContent = `${words} words`;
      }
      if (this.scriptSnippetDisplay) {
        if (script) {
          const lines = script.trim().split("\n").filter((l) => l.trim().length > 0);
          const snippet = lines.slice(0, 2).join(" / ");
          this.scriptSnippetDisplay.textContent = snippet.length > 140 ? `${snippet.slice(0, 140)}...` : snippet;
        } else {
          this.scriptSnippetDisplay.textContent = "No script added yet.";
        }
      }
      const isEmpty = words === 0;
      if (this.scriptEmptyWarning) {
        this.scriptEmptyWarning.classList.toggle("hidden", !isEmpty);
      }
      if (this.generateBtn) {
        this.generateBtn.disabled = isEmpty || this.isLoading;
      }
      if (this.currentData && this.generatedForScriptText && script !== this.generatedForScriptText) {
        (_a = this.scriptChangedBanner) == null ? void 0 : _a.classList.remove("hidden");
      } else {
        (_b = this.scriptChangedBanner) == null ? void 0 : _b.classList.add("hidden");
      }
    }
    getSourceText() {
      var _a, _b, _c, _d;
      const script = (((_b = (_a = this.app) == null ? void 0 : _a.state) == null ? void 0 : _b.scriptText) || "").trim();
      if (script) return script;
      const textarea = document.getElementById("scriptTextarea");
      if (textarea && textarea.value.trim()) return textarea.value.trim();
      const storyTextarea = document.getElementById("storyTextarea");
      if (storyTextarea && storyTextarea.value.trim()) return storyTextarea.value.trim();
      const chunksText = (((_d = (_c = this.app) == null ? void 0 : _c.captionEngine) == null ? void 0 : _d.chunks) || []).map((c) => (c.text || "").trim()).filter(Boolean).join(" ").trim();
      return chunksText || "";
    }
    detectLanguageFromScript(text) {
      if (!text) return "Hindi";
      const hasDevanagari = /[\u0900-\u097F]/.test(text);
      if (hasDevanagari) return "Hindi";
      const lower = text.toLowerCase();
      const hinglishMatches = (lower.match(/\b(hai|ki|ke|ka|ko|se|mein|aur|nahi|tha|thi|the|kuch|bhi|yeh|woh|raha|rahi|aaj)\b/g) || []).length;
      if (hinglishMatches >= 3) return "Hinglish";
      return "English";
    }
    async generate() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s;
      const sourceText = this.getSourceText();
      if (!sourceText) {
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Please add your script in Step 2 first.", "error");
        this.updateScriptSummary();
        return;
      }
      if (!navigator.onLine) {
        (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast("You appear to be offline. Check your internet connection.", "error");
        return;
      }
      await this.checkBackendConfig();
      if (!this.geminiConfigured) {
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast("GEMINI_API_KEY is not configured in .env on the server.", "error", 6e3);
        (_g = this.geminiMissingBanner) == null ? void 0 : _g.classList.remove("hidden");
        return;
      }
      this.setLoading(true);
      let language = ((_h = this.langSelect) == null ? void 0 : _h.value) || "Hindi";
      if (language === "auto" || language === "Auto-detect") {
        language = this.detectLanguageFromScript(sourceText);
      }
      const tone = ((_i = this.toneSelect) == null ? void 0 : _i.value) || "Curious";
      const videoType = ((_j = this.videoTypeSelect) == null ? void 0 : _j.value) || "Shorts";
      const niche = (((_k = this.nicheInput) == null ? void 0 : _k.value) || "").trim();
      const audience = (((_l = this.audienceInput) == null ? void 0 : _l.value) || "").trim();
      const platforms = ((_m = this.platformToggle) == null ? void 0 : _m.value) || "both";
      try {
        const res = await fetch("/api/generate-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            script: sourceText,
            platforms,
            language,
            tone,
            videoType,
            niche,
            audience
          })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Server error (${res.status})`);
        }
        this.generatedForScriptText = sourceText;
        (_n = this.scriptChangedBanner) == null ? void 0 : _n.classList.add("hidden");
        const ytData = data.youtube || {};
        const fbData = data.facebook || {};
        this.currentData = {
          youtube: {
            titles: Array.isArray(ytData.titles) ? ytData.titles.slice(0, 5) : [],
            description: (ytData.description || "").trim(),
            hashtags: Array.isArray(ytData.hashtags) ? ytData.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")) : [],
            tags: Array.isArray(ytData.tags) ? ytData.tags : typeof ytData.tags === "string" ? ytData.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
            pinned_comment: (ytData.pinned_comment || ytData.pinnedComment || "").trim()
          },
          facebook: {
            headlines: Array.isArray(fbData.headlines) ? fbData.headlines.slice(0, 3) : [],
            post_text: (fbData.post_text || fbData.postText || fbData.caption || "").trim(),
            video_title: (fbData.video_title || fbData.videoTitle || "").trim(),
            video_description: (fbData.video_description || fbData.videoDescription || "").trim(),
            hashtags: Array.isArray(fbData.hashtags) ? fbData.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")) : [],
            first_comment: (fbData.first_comment || fbData.firstComment || "").trim()
          },
          generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          settings: { language, tone, videoType, niche, audience, platforms }
        };
        if ((_o = this.app) == null ? void 0 : _o.state) {
          this.app.state.publishMeta = this.currentData;
          this.app.state.youtubeMeta = this.currentData.youtube;
          if (!this.app.state.publishPack) this.app.state.publishPack = {};
          this.app.state.publishPack.youtube = this.currentData.youtube;
          this.app.state.publishPack.facebook = {
            caption: this.currentData.facebook.post_text,
            hook_line: this.currentData.facebook.headlines[0] || "",
            hashtags: this.currentData.facebook.hashtags,
            first_comment: this.currentData.facebook.first_comment
          };
        }
        this.renderResults(this.currentData);
        (_q = (_p = this.app) == null ? void 0 : _p.ui) == null ? void 0 : _q.showToast("\u2728 Publish Portal metadata generated successfully!", "success");
      } catch (err) {
        console.error("[PublishPortal Error]", err);
        (_s = (_r = this.app) == null ? void 0 : _r.ui) == null ? void 0 : _s.showToast(`Metadata generation failed: ${err.message}`, "error", 6e3);
      } finally {
        this.setLoading(false);
        this.updateScriptSummary();
      }
    }
    renderResults(data) {
      var _a;
      if (!data) return;
      this.currentData = data;
      (_a = this.resultsContainer) == null ? void 0 : _a.classList.remove("hidden");
      const yt = data.youtube || {};
      const fb = data.facebook || {};
      if (this.ytTitlesList && Array.isArray(yt.titles)) {
        this.ytTitlesList.innerHTML = "";
        this.selectedTitleIndex = 0;
        yt.titles.forEach((title, idx) => {
          const item = document.createElement("div");
          item.className = `yt-title-card yt-title-row ${idx === 0 ? "selected" : ""}`;
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "portalYtTitleRadio";
          radio.id = `portalYtTitleRadio_${idx}`;
          radio.checked = idx === 0;
          const content = document.createElement("div");
          content.className = "yt-title-content";
          const textInput = document.createElement("input");
          textInput.type = "text";
          textInput.className = "form-input form-input-sm yt-title-input";
          textInput.value = title;
          textInput.maxLength = 120;
          const countBadge = document.createElement("span");
          countBadge.className = "yt-char-badge";
          countBadge.textContent = `${title.length}/70`;
          if (title.length > 70) countBadge.classList.add("over-limit");
          textInput.addEventListener("input", (e) => {
            var _a2, _b;
            const val = e.target.value;
            countBadge.textContent = `${val.length}/70`;
            countBadge.classList.toggle("over-limit", val.length > 70);
            if ((_b = (_a2 = this.currentData) == null ? void 0 : _a2.youtube) == null ? void 0 : _b.titles) {
              this.currentData.youtube.titles[idx] = val;
            }
          });
          const selectThis = () => {
            var _a2;
            radio.checked = true;
            this.selectedTitleIndex = idx;
            (_a2 = this.ytTitlesList) == null ? void 0 : _a2.querySelectorAll(".yt-title-card").forEach((c) => c.classList.remove("selected"));
            item.classList.add("selected");
          };
          radio.addEventListener("change", selectThis);
          item.addEventListener("click", (e) => {
            if (e.target !== textInput) selectThis();
          });
          content.appendChild(textInput);
          content.appendChild(countBadge);
          item.appendChild(radio);
          item.appendChild(content);
          this.ytTitlesList.appendChild(item);
        });
      }
      if (this.descInput) {
        this.descInput.value = yt.description || "";
      }
      this.ytHashtagsList = [...yt.hashtags || []];
      this.renderYtHashtagChips();
      if (this.tagsInput) {
        this.tagsInput.value = Array.isArray(yt.tags) ? yt.tags.join(", ") : yt.tags || "";
      }
      if (this.pinnedCommentInput) {
        this.pinnedCommentInput.value = yt.pinned_comment || yt.pinnedComment || "";
      }
      if (this.fbHeadlinesList && Array.isArray(fb.headlines)) {
        this.fbHeadlinesList.innerHTML = "";
        this.selectedHeadlineIndex = 0;
        fb.headlines.forEach((hl, idx) => {
          const item = document.createElement("div");
          item.className = `yt-title-card fb-headline-row ${idx === 0 ? "selected" : ""}`;
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "portalFbHeadlineRadio";
          radio.id = `portalFbHeadlineRadio_${idx}`;
          radio.checked = idx === 0;
          const content = document.createElement("div");
          content.className = "yt-title-content";
          const textInput = document.createElement("input");
          textInput.type = "text";
          textInput.className = "form-input form-input-sm fb-headline-input";
          textInput.value = hl;
          textInput.maxLength = 150;
          const countBadge = document.createElement("span");
          countBadge.className = "yt-char-badge";
          countBadge.textContent = `${hl.length}/100`;
          if (hl.length > 100) countBadge.classList.add("over-limit");
          textInput.addEventListener("input", (e) => {
            var _a2, _b;
            const val = e.target.value;
            countBadge.textContent = `${val.length}/100`;
            countBadge.classList.toggle("over-limit", val.length > 100);
            if ((_b = (_a2 = this.currentData) == null ? void 0 : _a2.facebook) == null ? void 0 : _b.headlines) {
              this.currentData.facebook.headlines[idx] = val;
            }
          });
          const selectThis = () => {
            var _a2;
            radio.checked = true;
            this.selectedHeadlineIndex = idx;
            (_a2 = this.fbHeadlinesList) == null ? void 0 : _a2.querySelectorAll(".yt-title-card").forEach((c) => c.classList.remove("selected"));
            item.classList.add("selected");
          };
          radio.addEventListener("change", selectThis);
          item.addEventListener("click", (e) => {
            if (e.target !== textInput) selectThis();
          });
          content.appendChild(textInput);
          content.appendChild(countBadge);
          item.appendChild(radio);
          item.appendChild(content);
          this.fbHeadlinesList.appendChild(item);
        });
      }
      if (this.fbPostInput) {
        this.fbPostInput.value = fb.post_text || fb.postText || fb.caption || "";
      }
      if (this.fbVideoTitleInput) {
        this.fbVideoTitleInput.value = fb.video_title || fb.videoTitle || "";
      }
      if (this.fbVideoDescInput) {
        this.fbVideoDescInput.value = fb.video_description || fb.videoDescription || "";
      }
      this.fbHashtagsList = [...fb.hashtags || []];
      this.renderFbHashtagChips();
      if (this.fbCommentInput) {
        this.fbCommentInput.value = fb.first_comment || fb.firstComment || "";
      }
      this.updateCounters();
      this.updateKeywordMatchBadge();
    }
    renderYtHashtagChips() {
      if (!this.ytHashtagsContainer) return;
      this.ytHashtagsContainer.innerHTML = "";
      this.ytHashtagsList.forEach((tag, idx) => {
        const chip = document.createElement("span");
        chip.className = "yt-hashtag-chip";
        chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove" title="Remove">&times;</button>`;
        chip.querySelector(".yt-chip-remove").addEventListener("click", (e) => {
          var _a;
          e.stopPropagation();
          this.ytHashtagsList.splice(idx, 1);
          if ((_a = this.currentData) == null ? void 0 : _a.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
          this.renderYtHashtagChips();
        });
        this.ytHashtagsContainer.appendChild(chip);
      });
    }
    addCustomYtHashtag() {
      var _a;
      if (!this.ytAddHashtagInput) return;
      let val = this.ytAddHashtagInput.value.trim().replace(/\s+/g, "");
      if (!val) return;
      if (!val.startsWith("#")) val = `#${val}`;
      if (!this.ytHashtagsList.includes(val)) {
        this.ytHashtagsList.push(val);
        if ((_a = this.currentData) == null ? void 0 : _a.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
        this.renderYtHashtagChips();
      }
      this.ytAddHashtagInput.value = "";
    }
    renderFbHashtagChips() {
      if (!this.fbHashtagsContainer) return;
      this.fbHashtagsContainer.innerHTML = "";
      this.fbHashtagsList.forEach((tag, idx) => {
        const chip = document.createElement("span");
        chip.className = "yt-hashtag-chip";
        chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove" title="Remove">&times;</button>`;
        chip.querySelector(".yt-chip-remove").addEventListener("click", (e) => {
          var _a;
          e.stopPropagation();
          this.fbHashtagsList.splice(idx, 1);
          if ((_a = this.currentData) == null ? void 0 : _a.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
          this.renderFbHashtagChips();
        });
        this.fbHashtagsContainer.appendChild(chip);
      });
    }
    addCustomFbHashtag() {
      var _a;
      if (!this.fbAddHashtagInput) return;
      let val = this.fbAddHashtagInput.value.trim().replace(/\s+/g, "");
      if (!val) return;
      if (!val.startsWith("#")) val = `#${val}`;
      if (!this.fbHashtagsList.includes(val)) {
        this.fbHashtagsList.push(val);
        if ((_a = this.currentData) == null ? void 0 : _a.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
        this.renderFbHashtagChips();
      }
      this.fbAddHashtagInput.value = "";
    }
    addTrendingPack(type = "yt") {
      var _a, _b;
      const list = type === "yt" ? this.ytHashtagsList : this.fbHashtagsList;
      const defaults = type === "yt" ? TRENDING_TAGS_YT : TRENDING_TAGS_FB;
      let added = 0;
      defaults.forEach((tag) => {
        if (!list.includes(tag)) {
          list.push(tag);
          added++;
        }
      });
      if (type === "yt") {
        if ((_a = this.currentData) == null ? void 0 : _a.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
        this.renderYtHashtagChips();
        this.showToast(`\u{1F525} Added ${added} trending tags! Total: ${this.ytHashtagsList.length}`, "success");
      } else {
        if ((_b = this.currentData) == null ? void 0 : _b.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
        this.renderFbHashtagChips();
        this.showToast(`\u{1F525} Added ${added} trending tags! Total: ${this.fbHashtagsList.length}`, "success");
      }
    }
    autoFormatYouTubeDescription() {
      var _a, _b, _c;
      if (!this.descInput) return;
      const current = this.descInput.value.trim();
      if (!current) {
        this.showToast("Please generate or enter a description first.", "warning");
        return;
      }
      const script = (((_b = (_a = this.app) == null ? void 0 : _a.state) == null ? void 0 : _b.scriptText) || "").trim();
      const hasHindi = /[\u0900-\u097F]/.test(current || script);
      const tags = this.ytHashtagsList.slice(0, 10).join(" ") || "#Trending #Viral #Shorts";
      const paragraphs = current.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const hook = paragraphs[0] || (hasHindi ? "\u{1F4CC} \u0907\u0938 \u0935\u0940\u0921\u093F\u092F\u094B \u092E\u0947\u0902 \u091C\u093E\u0928\u093F\u090F \u092A\u0942\u0930\u0940 \u0926\u093E\u0938\u094D\u0924\u093E\u0928..." : "\u{1F4CC} In this video, discover the full story...");
      const body = paragraphs.slice(1).filter((p) => !p.startsWith("#") && !p.includes("Subscribe")).join("\n\n") || current;
      const formatted = hasHindi ? `${hook}

\u{1F4D6} \u0915\u0939\u093E\u0928\u0940 \u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902 (About This Video):
${body}

\u2728 \u092E\u0941\u0916\u094D\u092F \u092C\u093F\u0902\u0926\u0941 (Key Highlights):
\u{1F539} \u0926\u093E\u0938\u094D\u0924\u093E\u0928 \u0915\u0940 \u0905\u0928\u0938\u0941\u0928\u0940 \u0938\u091A\u094D\u091A\u093E\u0908
\u{1F539} \u0910\u0924\u093F\u0939\u093E\u0938\u093F\u0915 \u0914\u0930 \u092D\u093E\u0935\u0928\u093E\u0924\u094D\u092E\u0915 \u092A\u0932
\u{1F539} \u0938\u0940\u0916 \u0914\u0930 \u0917\u0939\u0930\u093E \u0938\u0902\u0926\u0947\u0936

\u23F1\uFE0F \u092E\u0939\u0924\u094D\u0935\u092A\u0942\u0930\u094D\u0923 \u0905\u0927\u094D\u092F\u093E\u092F (Timestamps):
00:00 - \u092A\u094D\u0930\u0938\u094D\u0924\u093E\u0935\u0928\u093E (Introduction)
00:30 - \u0915\u0939\u093E\u0928\u0940 \u0915\u093E \u092E\u094B\u0921\u093C (Turning Point)
01:00 - \u0905\u0902\u0924\u093F\u092E \u0928\u093F\u0937\u094D\u0915\u0930\u094D\u0937 (Conclusion)

\u{1F514} \u091C\u0941\u0921\u093C\u0947\u0902 \u0914\u0930 \u0938\u092E\u0930\u094D\u0925\u0928 \u0915\u0930\u0947\u0902 (Join & Support):
\u0905\u0917\u0930 \u0906\u092A\u0915\u094B \u092F\u0939 \u0935\u0940\u0921\u093F\u092F\u094B \u092A\u0938\u0902\u0926 \u0906\u092F\u093E \u0924\u094B \u0915\u0943\u092A\u092F\u093E LIKE \u{1F44D}, SHARE \u{1F4F2} \u0914\u0930 SUBSCRIBE \u{1F514} \u0915\u0930\u0947\u0902!
\u{1F4AC} \u0906\u092A\u0915\u0940 \u0907\u0938 \u0915\u0939\u093E\u0928\u0940 \u092A\u0930 \u0915\u094D\u092F\u093E \u0930\u093E\u092F \u0939\u0948? \u0915\u092E\u0947\u0902\u091F \u092E\u0947\u0902 \u091C\u093C\u0930\u0942\u0930 \u092C\u0924\u093E\u090F\u0902!

${tags}` : `${hook}

\u{1F4D6} About This Video:
${body}

\u2728 Key Highlights:
\u{1F539} Untold facts & key moments
\u{1F539} Emotional journey & insights
\u{1F539} Lessons & takeaways

\u23F1\uFE0F Chapters:
00:00 - Introduction
00:30 - The Story Unfolds
01:00 - Conclusion & Summary

\u{1F514} Connect & Support:
If you enjoyed this video, please LIKE \u{1F44D}, SHARE \u{1F4F2}, and SUBSCRIBE \u{1F514} for more!
\u{1F4AC} What do you think about this story? Let us know in the comments below!

${tags}`;
      this.descInput.value = formatted;
      if ((_c = this.currentData) == null ? void 0 : _c.youtube) {
        this.currentData.youtube.description = formatted;
      }
      this.updateCounters();
      this.showToast("\u2728 Formatted description applied!", "success");
    }
    autoFormatFacebookPost() {
      var _a, _b, _c;
      if (!this.fbPostInput) return;
      const current = this.fbPostInput.value.trim();
      if (!current) {
        this.showToast("Please generate or enter Facebook post text first.", "warning");
        return;
      }
      const script = (((_b = (_a = this.app) == null ? void 0 : _a.state) == null ? void 0 : _b.scriptText) || "").trim();
      const hasHindi = /[\u0900-\u097F]/.test(current || script);
      const tags = this.fbHashtagsList.slice(0, 8).join(" ") || "#Trending #Viral #Reels";
      const paragraphs = current.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const hook = paragraphs[0] || (hasHindi ? "\u{1F3AF} \u090F\u0915 \u0910\u0938\u0940 \u0915\u0939\u093E\u0928\u0940 \u091C\u094B \u0926\u093F\u0932 \u091B\u0942 \u0932\u0947..." : "\u{1F3AF} A story that will touch your heart...");
      const body = paragraphs.slice(1).filter((p) => !p.startsWith("#")).join("\n\n") || current;
      const formatted = hasHindi ? `${hook}

\u{1F4DC} \u092A\u0942\u0930\u0940 \u0926\u093E\u0938\u094D\u0924\u093E\u0928:
${body}

\u{1F4A1} \u092E\u0941\u0916\u094D\u092F \u0938\u0940\u0916:
\u{1F449} \u0939\u0930 \u0915\u0939\u093E\u0928\u0940 \u0939\u092E\u0947\u0902 \u0915\u0941\u091B \u0928\u092F\u093E \u0938\u093F\u0916\u093E\u0924\u0940 \u0939\u0948\u0964
\u{1F449} \u0905\u092A\u0928\u0947 \u0935\u093F\u091A\u093E\u0930 \u0915\u092E\u0947\u0902\u091F \u092E\u0947\u0902 \u0938\u093E\u091D\u093E \u0915\u0930\u0947\u0902!

\u{1F4E2} \u0936\u0947\u092F\u0930 \u0915\u0930\u0947\u0902 \u0914\u0930 \u092B\u0949\u0932\u094B \u0915\u0930\u0928\u093E \u0928 \u092D\u0942\u0932\u0947\u0902! \u{1F4F2}

${tags}` : `${hook}

\u{1F4DC} The Story:
${body}

\u{1F4A1} Key Insight:
\u{1F449} Every story leaves an impact.
\u{1F449} What are your thoughts? Share below!

\u{1F4E2} Share this reel and follow for more! \u{1F4F2}

${tags}`;
      this.fbPostInput.value = formatted;
      if ((_c = this.currentData) == null ? void 0 : _c.facebook) {
        this.currentData.facebook.post_text = formatted;
      }
      this.updateCounters();
      this.showToast("\u2728 Formatted Facebook post applied!", "success");
    }
    updateCounters() {
      if (this.descInput && this.descCounter) {
        const len = this.descInput.value.length;
        this.descCounter.textContent = `${len} / 5000 characters`;
        this.descCounter.classList.toggle("over-limit", len > 5e3);
      }
      if (this.tagsInput && this.tagsCounter) {
        const len = this.tagsInput.value.length;
        this.tagsCounter.textContent = `${len} / 450 characters`;
        this.tagsCounter.classList.toggle("over-limit", len > 450);
      }
      if (this.fbPostInput && this.fbPostCounter) {
        const len = this.fbPostInput.value.length;
        this.fbPostCounter.textContent = `${len} characters (First ~125 chars visible before 'See more')`;
      }
    }
    updateKeywordMatchBadge() {
      if (!this.keywordMatchBadge) return;
      const script = this.getSourceText();
      const match = calculateKeywordMatch(script, this.currentData);
      this.keywordMatchBadge.textContent = `\u{1F3AF} ${match.badgeText} (${match.percent}% match)`;
      this.keywordMatchBadge.classList.remove("hidden");
      if (match.percent >= 70) {
        this.keywordMatchBadge.className = "badge badge-success";
      } else {
        this.keywordMatchBadge.className = "badge badge-accent";
      }
    }
    getSelectedTitle() {
      if (!this.ytTitlesList) return "";
      const selectedInput = this.ytTitlesList.querySelector(".yt-title-card.selected .yt-title-input");
      if (selectedInput) return selectedInput.value.trim();
      const firstInput = this.ytTitlesList.querySelector(".yt-title-input");
      return firstInput ? firstInput.value.trim() : "";
    }
    copySelectedTitle() {
      const title = this.getSelectedTitle();
      this.copyToClipboard(title, "YouTube Title");
    }
    getSelectedHeadline() {
      if (!this.fbHeadlinesList) return "";
      const selectedInput = this.fbHeadlinesList.querySelector(".yt-title-card.selected .fb-headline-input");
      if (selectedInput) return selectedInput.value.trim();
      const firstInput = this.fbHeadlinesList.querySelector(".fb-headline-input");
      return firstInput ? firstInput.value.trim() : "";
    }
    copySelectedHeadline() {
      const headline = this.getSelectedHeadline();
      this.copyToClipboard(headline, "Facebook Headline");
    }
    async copyToClipboard(text, label = "Content") {
      var _a, _b, _c, _d, _e, _f;
      if (!text) {
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast(`Nothing to copy for ${label}`, "warning");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast(`\u{1F4CB} Copied ${label} to clipboard! \u2713`, "success");
      } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast(`\u{1F4CB} Copied ${label} to clipboard! \u2713`, "success");
      }
    }
    copyAllYouTube() {
      var _a, _b, _c;
      const title = this.getSelectedTitle();
      const desc = ((_a = this.descInput) == null ? void 0 : _a.value) || "";
      const hashtags = this.ytHashtagsList.join(" ");
      const tags = ((_b = this.tagsInput) == null ? void 0 : _b.value) || "";
      const pinned = ((_c = this.pinnedCommentInput) == null ? void 0 : _c.value) || "";
      const bundle = `=== YOUTUBE VIDEO METADATA ===
TITLE:
${title}

DESCRIPTION:
${desc}

HASHTAGS:
${hashtags}

TAGS:
${tags}

PINNED COMMENT:
${pinned}
`;
      this.copyToClipboard(bundle, "All YouTube Details");
    }
    downloadYouTubeTxt() {
      var _a, _b, _c, _d, _e;
      const title = this.getSelectedTitle();
      const desc = ((_a = this.descInput) == null ? void 0 : _a.value) || "";
      const hashtags = this.ytHashtagsList.join(" ");
      const tags = ((_b = this.tagsInput) == null ? void 0 : _b.value) || "";
      const pinned = ((_c = this.pinnedCommentInput) == null ? void 0 : _c.value) || "";
      const textContent = `StoryFlow Studio \u2014 YouTube Video Deliverable
Generated: ${(/* @__PURE__ */ new Date()).toLocaleString()}

=======================================================
1. VIDEO TITLE
=======================================================
${title}

=======================================================
2. DESCRIPTION
=======================================================
${desc}

=======================================================
3. HASHTAGS
=======================================================
${hashtags}

=======================================================
4. KEYWORD TAGS
=======================================================
${tags}

=======================================================
5. PINNED COMMENT
=======================================================
${pinned}
`;
      const blob = new Blob([textContent], { type: "text/plain;charset=utf-8" });
      const url2 = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = `youtube_metadata_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url2), 2e3);
      (_e = (_d = this.app) == null ? void 0 : _d.ui) == null ? void 0 : _e.showToast("\u{1F4BE} Downloaded youtube_metadata.txt", "success");
    }
    copyAllFacebook() {
      var _a, _b, _c, _d;
      const headline = this.getSelectedHeadline();
      const post = ((_a = this.fbPostInput) == null ? void 0 : _a.value) || "";
      const videoTitle = ((_b = this.fbVideoTitleInput) == null ? void 0 : _b.value) || "";
      const videoDesc = ((_c = this.fbVideoDescInput) == null ? void 0 : _c.value) || "";
      const hashtags = this.fbHashtagsList.join(" ");
      const comment = ((_d = this.fbCommentInput) == null ? void 0 : _d.value) || "";
      const bundle = `=== FACEBOOK VIDEO POST ===
HEADLINE:
${headline}

POST TEXT:
${post}

VIDEO TITLE:
${videoTitle}

VIDEO DESCRIPTION:
${videoDesc}

HASHTAGS:
${hashtags}

FIRST COMMENT:
${comment}
`;
      this.copyToClipboard(bundle, "All Facebook Details");
    }
    downloadFacebookTxt() {
      var _a, _b, _c, _d, _e, _f;
      const headline = this.getSelectedHeadline();
      const post = ((_a = this.fbPostInput) == null ? void 0 : _a.value) || "";
      const videoTitle = ((_b = this.fbVideoTitleInput) == null ? void 0 : _b.value) || "";
      const videoDesc = ((_c = this.fbVideoDescInput) == null ? void 0 : _c.value) || "";
      const hashtags = this.fbHashtagsList.join(" ");
      const comment = ((_d = this.fbCommentInput) == null ? void 0 : _d.value) || "";
      const textContent = `StoryFlow Studio \u2014 Facebook Video Deliverable
Generated: ${(/* @__PURE__ */ new Date()).toLocaleString()}

=======================================================
1. HEADLINE
=======================================================
${headline}

=======================================================
2. POST TEXT
=======================================================
${post}

=======================================================
3. VIDEO TITLE
=======================================================
${videoTitle}

=======================================================
4. VIDEO DESCRIPTION
=======================================================
${videoDesc}

=======================================================
5. HASHTAGS
=======================================================
${hashtags}

=======================================================
6. FIRST COMMENT
=======================================================
${comment}
`;
      const blob = new Blob([textContent], { type: "text/plain;charset=utf-8" });
      const url2 = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = `facebook_metadata_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url2), 2e3);
      (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast("\u{1F4BE} Downloaded facebook_metadata.txt", "success");
    }
    setLoading(isLoading) {
      this.isLoading = isLoading;
      if (this.generateBtn) {
        this.generateBtn.disabled = isLoading;
        this.generateBtn.innerHTML = isLoading ? `<span class="yt-spinner"></span> Generating with Gemini...` : `\u2728 Generate with Gemini`;
      }
      if (this.regenerateBtn) {
        this.regenerateBtn.disabled = isLoading;
      }
      if (this.skeletonLoader) {
        this.skeletonLoader.classList.toggle("hidden", !isLoading);
      }
      if (this.resultsContainer) {
        if (isLoading) {
          this.resultsContainer.classList.add("opacity-50");
        } else {
          this.resultsContainer.classList.remove("opacity-50");
        }
      }
    }
    hookProjectSerialization() {
      var _a;
      if (!this.app) return;
      this.app.saveProjectFile = () => {
        var _a2;
        const meta = this.getData();
        if (meta && this.app.state) {
          this.app.state.publishMeta = meta;
          this.app.state.youtubeMeta = meta.youtube;
        }
        const project = {
          version: "1.0",
          savedAt: (/* @__PURE__ */ new Date()).toISOString(),
          scriptText: this.app.state.scriptText,
          captionChunks: this.app.captionEngine ? this.app.captionEngine.chunks : [],
          settings: {
            aspectRatio: this.app.state.aspectRatio,
            customNorm: this.app.state.customNorm,
            durationMode: this.app.state.durationMode,
            customDuration: this.app.state.customDuration,
            photoMinDuration: this.app.state.photoMinDuration,
            photoMaxDuration: this.app.state.photoMaxDuration,
            enabledAnimations: this.app.state.enabledAnimations,
            maxZoom: this.app.state.maxZoom,
            transitionDuration: this.app.state.transitionDuration,
            transitionType: this.app.state.transitionType,
            captionStyle: this.app.state.captionStyle,
            overlays: this.app.state.overlays,
            colorGrading: this.app.state.colorGrading,
            publishMeta: meta,
            ...(meta == null ? void 0 : meta.youtube) ? { youtubeMeta: meta.youtube } : {}
          },
          frameTimestamps: (this.app.state.extractedFrames || []).map((f) => ({
            timestamp: f.timestamp,
            sourceMinute: f.sourceMinute,
            starred: f.starred
          }))
        };
        exportProjectJson(project);
        (_a2 = this.app.ui) == null ? void 0 : _a2.showToast("Saved project JSON file with Publish Portal metadata.", "success");
      };
      const originalRestore = (_a = this.app.restoreProjectFile) == null ? void 0 : _a.bind(this.app);
      if (originalRestore) {
        this.app.restoreProjectFile = (project) => {
          var _a2, _b;
          originalRestore(project);
          if ((_a2 = project == null ? void 0 : project.settings) == null ? void 0 : _a2.publishMeta) {
            this.restoreData(project.settings.publishMeta);
          } else if ((_b = project == null ? void 0 : project.settings) == null ? void 0 : _b.youtubeMeta) {
            this.restoreData({ youtube: project.settings.youtubeMeta });
          } else if (project == null ? void 0 : project.publish_pack) {
            this.restoreData({ youtube: project.publish_pack.youtube, facebook: project.publish_pack.facebook });
          }
        };
      }
    }
    getData() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E;
      if (!this.currentData) return null;
      return {
        youtube: {
          titles: ((_b = (_a = this.currentData) == null ? void 0 : _a.youtube) == null ? void 0 : _b.titles) || (this.getSelectedTitle() ? [this.getSelectedTitle()] : []),
          selectedTitle: this.getSelectedTitle(),
          description: ((_c = this.descInput) == null ? void 0 : _c.value) || ((_e = (_d = this.currentData) == null ? void 0 : _d.youtube) == null ? void 0 : _e.description) || "",
          hashtags: this.ytHashtagsList.length ? [...this.ytHashtagsList] : [...((_g = (_f = this.currentData) == null ? void 0 : _f.youtube) == null ? void 0 : _g.hashtags) || []],
          tags: ((_h = this.tagsInput) == null ? void 0 : _h.value) ? this.tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean) : Array.isArray((_j = (_i = this.currentData) == null ? void 0 : _i.youtube) == null ? void 0 : _j.tags) ? [...this.currentData.youtube.tags] : [],
          pinned_comment: ((_k = this.pinnedCommentInput) == null ? void 0 : _k.value) || ((_m = (_l = this.currentData) == null ? void 0 : _l.youtube) == null ? void 0 : _m.pinned_comment) || ""
        },
        facebook: {
          headlines: ((_o = (_n = this.currentData) == null ? void 0 : _n.facebook) == null ? void 0 : _o.headlines) || (this.getSelectedHeadline() ? [this.getSelectedHeadline()] : []),
          selectedHeadline: this.getSelectedHeadline(),
          post_text: ((_p = this.fbPostInput) == null ? void 0 : _p.value) || ((_r = (_q = this.currentData) == null ? void 0 : _q.facebook) == null ? void 0 : _r.post_text) || "",
          video_title: ((_s = this.fbVideoTitleInput) == null ? void 0 : _s.value) || ((_u = (_t = this.currentData) == null ? void 0 : _t.facebook) == null ? void 0 : _u.video_title) || "",
          video_description: ((_v = this.fbVideoDescInput) == null ? void 0 : _v.value) || ((_x = (_w = this.currentData) == null ? void 0 : _w.facebook) == null ? void 0 : _x.video_description) || "",
          hashtags: this.fbHashtagsList.length ? [...this.fbHashtagsList] : [...((_z = (_y = this.currentData) == null ? void 0 : _y.facebook) == null ? void 0 : _z.hashtags) || []],
          first_comment: ((_A = this.fbCommentInput) == null ? void 0 : _A.value) || ((_C = (_B = this.currentData) == null ? void 0 : _B.facebook) == null ? void 0 : _C.first_comment) || ""
        },
        generatedAt: ((_D = this.currentData) == null ? void 0 : _D.generatedAt) || (/* @__PURE__ */ new Date()).toISOString(),
        settings: ((_E = this.currentData) == null ? void 0 : _E.settings) || {}
      };
    }
    restoreData(meta) {
      if (!meta) return;
      this.currentData = {
        youtube: meta.youtube || meta,
        facebook: meta.facebook || {},
        generatedAt: meta.generatedAt || (/* @__PURE__ */ new Date()).toISOString(),
        settings: meta.settings || {}
      };
      this.renderResults(this.currentData);
    }
  };

  // js/gemini.js
  var GeminiClient = class {
    constructor(options = {}) {
      this.apiKey = options.apiKey || "";
      this.model = options.model || "gemini-2.5-flash";
      this.sessionCallsCount = 0;
      this.activeRequests = 0;
      this.maxConcurrent = 2;
      this.queue = [];
      this.onCallCountChange = options.onCallCountChange || null;
    }
    setApiKey(key) {
      this.apiKey = (key || "").trim();
    }
    getApiKey() {
      return this.apiKey || "";
    }
    setModel(model) {
      this.model = (model || "").trim() || "gemini-2.5-flash";
      saveSetting("gemini_model", this.model);
    }
    getModel() {
      return this.model || loadSetting("gemini_model", "gemini-2.5-flash");
    }
    incrementCallsCount() {
      this.sessionCallsCount++;
      if (typeof this.onCallCountChange === "function") {
        try {
          this.onCallCountChange(this.sessionCallsCount);
        } catch (e) {
        }
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
    async request({ model, payload, timeoutMs = 45e3, maxRetries = 2, isSearchTool = false }) {
      return this.enqueue(async () => {
        var _a, _b, _c, _d, _e, _f;
        const key = this.getApiKey();
        if (!key) {
          throw new Error("API key missing. Please enter your Gemini API key in settings.");
        }
        if (typeof navigator !== "undefined" && "onLine" in navigator && navigator.onLine === false) {
          throw new Error("You are offline. Please check your internet connection.");
        }
        const effectiveModel = model || this.getModel();
        const url2 = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(effectiveModel)}:generateContent`;
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            this.incrementCallsCount();
            const authHeader = ["x-goog", "api-key"].join("-");
            const headers = {
              "Content-Type": "application/json"
            };
            if (key) {
              headers[authHeader] = key;
            }
            const response = await fetch(url2, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
              if (response.status === 400 || response.status === 401 || response.status === 403) {
                throw new Error("API key invalid. Please check your Gemini API key.");
              } else if (response.status === 429) {
                if (attempt < maxRetries) {
                  const waitTime = Math.min(8e3, 1500 * Math.pow(2, attempt) + Math.random() * 500);
                  await new Promise((r) => setTimeout(r, waitTime));
                  continue;
                }
                throw new Error("Rate limit reached (429). Please wait a moment and try again.");
              } else if (response.status >= 500) {
                if (attempt < maxRetries) {
                  await new Promise((r) => setTimeout(r, 1200));
                  continue;
                }
                throw new Error("Gemini service temporarily unavailable (5xx).");
              } else {
                let errMsg = "";
                try {
                  const errBody = await response.json();
                  errMsg = ((_a = errBody == null ? void 0 : errBody.error) == null ? void 0 : _a.message) || "";
                } catch (e) {
                }
                throw new Error(errMsg || `Request failed with HTTP status ${response.status}`);
              }
            }
            const data = await response.json();
            const candidateText = (_f = (_e = (_d = (_c = (_b = data == null ? void 0 : data.candidates) == null ? void 0 : _b[0]) == null ? void 0 : _c.content) == null ? void 0 : _d.parts) == null ? void 0 : _e[0]) == null ? void 0 : _f.text;
            if (!candidateText && candidateText !== "") {
              throw new Error("Invalid response structure from Gemini API");
            }
            if (isSearchTool) {
              return candidateText;
            }
            try {
              const cleaned = candidateText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
              const parsed = JSON.parse(cleaned);
              return parsed;
            } catch (jsonErr) {
              if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, 1e3));
                continue;
              }
              throw new Error("Failed to parse Gemini JSON response");
            }
          } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            if (err.name === "AbortError") {
              lastError = new Error(`Request timed out after ${timeoutMs / 1e3} seconds`);
            }
            if (lastError.message.includes("API key invalid") || lastError.message.includes("offline")) {
              break;
            }
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, 1e3));
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
      language = "Hindi",
      targetSeconds = 75,
      tone = "Emotional",
      openingStyle = "Scene",
      skipPolitics = true,
      skipHistory = true,
      customInstructions = "",
      platforms = ["YouTube Shorts", "Instagram Reels"],
      trendingKeywords = ""
    }) {
      const targetWords = Math.round(targetSeconds * 2.4);
      const minWords = Math.round(targetWords * 0.9);
      const maxWords = Math.round(targetWords * 1.1);
      const systemPrompt = `You are an elite video scriptwriter specializing in high-retention narration for short-form historical and emotional story videos.
Your task is to transform the provided source story into a powerful, spoken narration script in ${language}.

CRITICAL RULES:
1. FACTS & TRUTH: Use strictly facts present in the source. NEVER invent names, numbers, quotes, or dates.
2. SPOKEN HINDI / NATURAL PHRASING:
   - Natural spoken Hindi with correct nukta (e.g. \u0915\u093C\u093F\u0932\u093E, \u091C\u093C\u093F\u0902\u0926\u0917\u0940, \u092B\u093C\u0930\u0940\u0926\u093E\u092C\u093E\u0926, \u092E\u0939\u092B\u093C\u0942\u091C\u093C, \u0935\u0924\u0928).
   - Short, punchy sentences. Exactly ONE sentence per line.
   - Every single line MUST end with a Hindi danda (\u0964) or question mark (?).
3. WORD BUDGET & TIMING:
   - Target length: ${targetSeconds} seconds.
   - Word count MUST stay between ${minWords} and ${maxWords} words (narration pace ~2.4 words per second).
4. OPENING & HOOK:
   - Opening style chosen: "${openingStyle}" (e.g. Scene, Question, Shocking fact, Object hook).
   - Line 1 must immediately grab attention using this style without generic introductions like "\u0906\u091C \u0939\u092E \u092C\u093E\u0924 \u0915\u0930\u0947\u0902\u0917\u0947".
5. ENDING:
   - The very last line must naturally prompt viewers to share their thoughts or comment.
6. NO POLITICS / LEADERS:
   ${skipPolitics ? "- SKIP political roles and leaders. Name NO political leaders, explain NO political negotiations, and start directly inside a human scene." : ""}
   ${skipHistory ? "- SKIP background political treaties and macro history. Focus 100% on personal human drama, emotional stakes, and vivid sensory details." : ""}
${customInstructions ? `7. CUSTOM USER INSTRUCTIONS:
${customInstructions}` : ""}
${trendingKeywords ? `8. TRENDING KEYWORD CONTEXT (from Google Search):
${trendingKeywords}` : ""}

SOURCE STORY:
"""
${story}
"""`;
      const schema = {
        type: "OBJECT",
        properties: {
          script_lines: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Array of short spoken script lines, one sentence per line ending with \u0964"
          },
          estimated_seconds: {
            type: "NUMBER",
            description: "Estimated narration duration in seconds (total words / 2.4)"
          },
          hook_options: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: { type: "STRING", description: "Alternative hook line for line 1" },
                why: { type: "STRING", description: "Psychological reasoning why this hook retains viewers" },
                score: { type: "NUMBER", description: "Retention score from 1 to 10" }
              },
              required: ["text", "why", "score"]
            },
            description: "Exactly 3 alternative hook options"
          },
          scene_tags: {
            type: "ARRAY",
            items: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "2 to 4 English keywords describing the ideal visual for this line"
            },
            description: "Scene tags for each script line, matching the script_lines array length"
          },
          youtube: {
            type: "OBJECT",
            properties: {
              titles: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "5 curiosity-driven titles, each <= 70 characters"
              },
              description: {
                type: "STRING",
                description: "YouTube description with hook in first 2 lines, summary, CTA, and 3-5 hashtags at bottom"
              },
              hashtags: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "8 to 12 hashtags starting with #"
              },
              tags: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "Keyword tags totaling <= 450 characters"
              },
              pinned_comment: {
                type: "STRING",
                description: "Engaging comment asking a question to spark viewer discussions"
              }
            },
            required: ["titles", "description", "hashtags", "tags", "pinned_comment"]
          },
          facebook: {
            type: "OBJECT",
            properties: {
              caption: { type: "STRING", description: "Facebook video caption" },
              hook_line: { type: "STRING", description: "Punchy hook line for the post" },
              hashtags: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "Exactly 3 to 5 relevant hashtags"
              },
              first_comment: { type: "STRING", description: "First comment for engagement" }
            },
            required: ["caption", "hook_line", "hashtags", "first_comment"]
          }
        },
        required: ["script_lines", "estimated_seconds", "hook_options", "scene_tags", "youtube", "facebook"]
      };
      const payload = {
        contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.7
        }
      };
      return this.request({ payload });
    }
    /**
     * 2. shortenLine - rewrites one script line to be shorter and punchier
     */
    async shortenLine({ lineText, targetSeconds = 5, storyContext = "" }) {
      const prompt = `Rewrite this single video narration line in natural spoken Hindi.
Make it shorter, more urgent, and concise. It MUST end with a Hindi danda (\u0964) and be under ${Math.round(targetSeconds * 2.4)} words.
Base it strictly on the original line. Do not invent new facts.

ORIGINAL LINE:
"${lineText}"

${storyContext ? `STORY CONTEXT:
${storyContext.slice(0, 300)}` : ""}`;
      const schema = {
        type: "OBJECT",
        properties: {
          shortened_line: { type: "STRING", description: "Shortened Hindi line ending with \u0964" },
          estimated_seconds: { type: "NUMBER", description: "Estimated spoken duration (words / 2.4)" }
        },
        required: ["shortened_line", "estimated_seconds"]
      };
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.5
        }
      };
      return this.request({ payload });
    }
    /**
     * 3. moreHooks - generates 3 more hook options
     */
    async moreHooks({ story, currentHooks = [], openingStyle = "Scene" }) {
      const prompt = `Generate 3 completely fresh, ultra-compelling hook lines in Hindi for opening this story video.
Opening style: "${openingStyle}".
Each hook must be emotional, spark curiosity, and make the viewer stay.
Do NOT repeat these existing hooks:
${currentHooks.map((h) => `- ${typeof h === "string" ? h : h.text}`).join("\n")}

STORY:
"""
${story}
"""`;
      const schema = {
        type: "OBJECT",
        properties: {
          hook_options: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: { type: "STRING", description: "Compelling Hindi hook line ending with \u0964 or ?" },
                why: { type: "STRING", description: "Why this hook grabs psychological attention" },
                score: { type: "NUMBER", description: "Score from 1 to 10" }
              },
              required: ["text", "why", "score"]
            }
          }
        },
        required: ["hook_options"]
      };
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
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
            mimeType: p.mimeType || "image/jpeg",
            data: p.base64
          }
        });
      });
      const schema = {
        type: "OBJECT",
        properties: {
          results: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING", description: "The Photo ID matched from the request" },
                tags: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                  description: "3 to 6 English descriptive tags"
                },
                caption: { type: "STRING", description: "One-line Hindi description" },
                mood: { type: "STRING", description: "Emotional mood keyword" }
              },
              required: ["id", "tags", "caption", "mood"]
            }
          }
        },
        required: ["results"]
      };
      const payload = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema
        }
      };
      const response = await this.request({ payload, timeoutMs: 6e4 });
      return (response == null ? void 0 : response.results) || [];
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
${photos.map((p) => `- ID: ${p.id}${p.starred ? " [STARRED]" : ""} | Mood: ${p.mood || "neutral"} | Tags: ${(p.tags || []).join(", ")} | Caption: ${p.caption || ""}`).join("\n")}

SCRIPT LINES:
${scriptLines.map((line, idx) => `Line ${idx}: "${line.text}" | Target Visual Tags: ${(line.scene_tags || []).join(", ")}`).join("\n")}`;
        const schema = {
          type: "OBJECT",
          properties: {
            matches: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  line_index: { type: "INTEGER" },
                  photo_id: { type: "STRING" },
                  confidence: { type: "STRING", description: "high, medium, or low" },
                  reason: { type: "STRING" }
                },
                required: ["line_index", "photo_id", "confidence"]
              }
            }
          },
          required: ["matches"]
        };
        const payload = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema
          }
        };
        const result = await this.request({ payload });
        if (result && Array.isArray(result.matches) && result.matches.length === scriptLines.length) {
          return result.matches;
        }
      } catch (err) {
        console.warn("[Gemini] Scene match API failed, running local fallback scoring:", err.message);
      }
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
        let bestPhoto = null;
        let highestScore = -999;
        photos.forEach((photo) => {
          let score = 0;
          const pTags = (photo.tags || []).map((t) => t.toLowerCase());
          lineTags.forEach((lt) => {
            pTags.forEach((pt) => {
              if (pt.includes(lt) || lt.includes(pt)) score += 3;
            });
          });
          if (photo.starred) score += 2;
          if (photo.id === prevPhotoId) {
            if (prevRepeatCount >= 2) {
              score -= 1e3;
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
          confidence: highestScore > 3 ? "high" : highestScore > 0 ? "medium" : "low",
          reason: "Matched via visual tag relevance"
        });
      });
      return matches;
    }
    /**
     * 6. thumbnailTexts - suggests 3 short curiosity-gap thumbnail texts (<28 chars)
     */
    async thumbnailTexts({ story, scriptLines = [] }) {
      const summary = (story || scriptLines.map((l) => l.text || l).join(" ")).slice(0, 500);
      const prompt = `Generate exactly 3 short Hindi thumbnail headline texts for this video.
STRICT RULES:
1. Each headline MUST be under 28 characters.
2. Must create an intense curiosity gap (\u0909\u0924\u094D\u0938\u0941\u0915\u0924\u093E / \u0930\u0939\u0938\u094D\u092F).
3. Pure Devanagari Hindi with correct nukta.
4. Bold, punchy, click-worthy (e.g. "\u0906\u0916\u093F\u0930\u0940 \u091F\u094D\u0930\u0947\u0928 \u0915\u0940 \u091A\u093E\u092C\u0940!", "1947 \u0915\u093E \u0935\u094B \u092C\u093F\u091B\u0921\u093C\u0928\u093E...", "\u0915\u094D\u092F\u093E \u0935\u094B \u0915\u092D\u0940 \u092E\u093F\u0932\u0947?").

STORY SUMMARY:
"""
${summary}
"""`;
      const schema = {
        type: "OBJECT",
        properties: {
          suggestions: {
            type: "ARRAY",
            items: { type: "STRING", description: "Hindi headline text under 28 chars" }
          }
        },
        required: ["suggestions"]
      };
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.8
        }
      };
      const res = await this.request({ payload });
      return (res == null ? void 0 : res.suggestions) || [];
    }
    /**
     * 7. trendingResearch - search-grounded call (Plain text, no responseSchema)
     */
    async trendingResearch({ topic }) {
      const prompt = `Search Google for currently trending Hindi search queries, viral keywords, and popular YouTube title patterns related to:
"${topic}".
List the top search phrases, emotional hooks, and high-CTR phrasing people are currently searching for in India for historical and emotional stories.`;
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }]
      };
      return this.request({ payload, isSearchTool: true, timeoutMs: 4e4 });
    }
    /**
     * 8. generateMetadata - publish pack generation for YouTube & Facebook
     */
    async generateMetadata({ script, language = "Hindi", tone = "Emotional", videoType = "Shorts", niche = "", audience = "", trendingResearch = "" }) {
      const prompt = `Generate YouTube and Facebook publishing metadata for this video script.
${trendingResearch ? `TRENDING SEARCH FINDINGS (use relevant search patterns):
${trendingResearch}
` : ""}

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
   ${videoType === "Shorts" ? "- Must include #Shorts." : ""}
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
        type: "OBJECT",
        properties: {
          youtube: {
            type: "OBJECT",
            properties: {
              titles: { type: "ARRAY", items: { type: "STRING" } },
              description: { type: "STRING" },
              hashtags: { type: "ARRAY", items: { type: "STRING" } },
              tags: { type: "ARRAY", items: { type: "STRING" } },
              pinned_comment: { type: "STRING" }
            },
            required: ["titles", "description", "hashtags", "tags", "pinned_comment"]
          },
          facebook: {
            type: "OBJECT",
            properties: {
              caption: { type: "STRING" },
              hook_line: { type: "STRING" },
              hashtags: { type: "ARRAY", items: { type: "STRING" } },
              first_comment: { type: "STRING" }
            },
            required: ["caption", "hook_line", "hashtags", "first_comment"]
          }
        },
        required: ["youtube", "facebook"]
      };
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema
        }
      };
      return this.request({ payload });
    }
  };

  // js/project_store.js
  var DB_NAME = "StoryFlowStudioDB";
  var DB_VERSION = 1;
  var STORE_PROJECTS = "projects";
  var STORE_BLOBS = "media_blobs";
  var STORE_VISION_CACHE = "photo_vision_cache";
  var dbPromise = null;
  function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        return reject(new Error("IndexedDB not supported in this environment"));
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          const projStore = db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
          projStore.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_VISION_CACHE)) {
          db.createObjectStore(STORE_VISION_CACHE, { keyPath: "cacheKey" });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => {
        console.error("[IndexedDB] Failed to open database:", e.target.error);
        reject(e.target.error);
      };
    });
    return dbPromise;
  }
  var ProjectStore = class {
    /**
     * Saves or updates a project in IndexedDB
     * @param {object} project 
     */
    static async saveProject(project) {
      if (!project || !project.id) {
        throw new Error("Project must have an id");
      }
      const db = await getDB();
      const updated = {
        ...project,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_PROJECTS, "readwrite");
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.put(updated);
        req.onsuccess = () => resolve(updated);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Loads a project by ID
     * @param {string} id 
     * @returns {Promise<object|null>}
     */
    static async loadProject(id) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_PROJECTS, "readonly");
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Lists all projects sorted by updatedAt descending
     * @returns {Promise<Array<object>>}
     */
    static async listProjects() {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_PROJECTS, "readonly");
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = req.result || [];
          list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
          resolve(list.map((p) => ({
            id: p.id,
            name: p.name || "Untitled Project",
            updatedAt: p.updatedAt,
            createdAt: p.createdAt,
            photoCount: Array.isArray(p.photo_records) ? p.photo_records.length : 0,
            scriptLineCount: Array.isArray(p.script_lines) ? p.script_lines.length : 0,
            storyPreview: (p.story || "").slice(0, 100)
          })));
        };
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Deletes a project by ID and associated blobs
     * @param {string} id 
     */
    static async deleteProject(id) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_PROJECTS], "readwrite");
        const store = tx.objectStore(STORE_PROJECTS);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Duplicates an existing project
     * @param {string} id 
     * @returns {Promise<object>}
     */
    static async duplicateProject(id) {
      const original = await this.loadProject(id);
      if (!original) throw new Error("Project not found");
      const newId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const copy = {
        ...original,
        id: newId,
        name: `${original.name || "Untitled"} (Copy)`,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.saveProject(copy);
      return copy;
    }
    /**
     * Renames a project
     * @param {string} id 
     * @param {string} newName 
     */
    static async renameProject(id, newName) {
      const proj = await this.loadProject(id);
      if (!proj) throw new Error("Project not found");
      proj.name = (newName || "").trim() || "Untitled Project";
      return this.saveProject(proj);
    }
    /**
     * Stores a large Blob/ArrayBuffer in IndexedDB
     * @param {string} key 
     * @param {Blob|ArrayBuffer} blob 
     */
    static async saveBlob(key, blob) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BLOBS, "readwrite");
        const store = tx.objectStore(STORE_BLOBS);
        const req = store.put({ key, blob, updatedAt: Date.now() });
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Loads a Blob from IndexedDB
     * @param {string} key 
     * @returns {Promise<Blob|null>}
     */
    static async getBlob(key) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BLOBS, "readonly");
        const store = tx.objectStore(STORE_BLOBS);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Deletes a Blob
     * @param {string} key 
     */
    static async deleteBlob(key) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BLOBS, "readwrite");
        const store = tx.objectStore(STORE_BLOBS);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    /**
     * Retrieves cached vision tags for a photo
     * @param {string} cacheKey 
     * @returns {Promise<object|null>}
     */
    static async getCachedPhotoTags(cacheKey) {
      if (!cacheKey) return null;
      try {
        const db = await getDB();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_VISION_CACHE, "readonly");
          const store = tx.objectStore(STORE_VISION_CACHE);
          const req = store.get(cacheKey);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    }
    /**
     * Caches vision tags for a photo
     * @param {string} cacheKey 
     * @param {object} data { tags: string[], caption: string, mood: string }
     */
    static async setCachedPhotoTags(cacheKey, data) {
      if (!cacheKey || !data) return;
      try {
        const db = await getDB();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_VISION_CACHE, "readwrite");
          const store = tx.objectStore(STORE_VISION_CACHE);
          const req = store.put({
            cacheKey,
            tags: data.tags || [],
            caption: data.caption || "",
            mood: data.mood || "neutral",
            cachedAt: Date.now()
          });
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        });
      } catch (e) {
      }
    }
  };

  // js/thumbnail.js
  var ThumbnailMaker = class {
    constructor(canvasElement) {
      this.canvas = canvasElement;
      this.ctx = canvasElement.getContext("2d");
      this.format = "16:9";
      this.width = 1280;
      this.height = 720;
      this.selectedPhoto = null;
      this.textLine1 = "\u0906\u0916\u093F\u0930\u0940 \u091F\u094D\u0930\u0947\u0928 \u0915\u0940 \u091A\u093E\u092C\u0940!";
      this.textLine2 = "1947 \u0915\u093E \u0935\u094B \u0926\u0930\u094D\u0926\u0928\u093E\u0915 \u0938\u091A";
      this.textStyle = "red-box";
      this.textX = 0.5;
      this.textY = 0.72;
      this.contrast = 1.15;
      this.vignetteIntensity = 0.45;
      this.isDragging = false;
      this.dragStartY = 0;
      this.dragStartX = 0;
      this.initEvents();
    }
    setFormat(format) {
      this.format = format;
      if (format === "9:16") {
        this.width = 1080;
        this.height = 1920;
      } else {
        this.width = 1280;
        this.height = 720;
      }
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.render();
    }
    setPhoto(photo) {
      this.selectedPhoto = photo;
      this.render();
    }
    setText(line1, line2) {
      if (line1 !== void 0) this.textLine1 = line1;
      if (line2 !== void 0) this.textLine2 = line2;
      this.render();
    }
    setStyle(style) {
      this.textStyle = style;
      this.render();
    }
    setPositionY(normY) {
      this.textY = Math.max(0.1, Math.min(0.9, normY));
      this.render();
    }
    initEvents() {
      if (!this.canvas) return;
      const onPointerDown = (clientX, clientY) => {
        const rect = this.canvas.getBoundingClientRect();
        this.isDragging = true;
        this.dragStartX = clientX - rect.left;
        this.dragStartY = clientY - rect.top;
      };
      const onPointerMove = (clientX, clientY) => {
        if (!this.isDragging) return;
        const rect = this.canvas.getBoundingClientRect();
        const currentX = (clientX - rect.left) / rect.width;
        const currentY = (clientY - rect.top) / rect.height;
        this.textX = Math.max(0.2, Math.min(0.8, currentX));
        this.textY = Math.max(0.15, Math.min(0.88, currentY));
        this.render();
      };
      const onPointerUp = () => {
        this.isDragging = false;
      };
      this.canvas.addEventListener("mousedown", (e) => onPointerDown(e.clientX, e.clientY));
      window.addEventListener("mousemove", (e) => {
        if (this.isDragging) onPointerMove(e.clientX, e.clientY);
      });
      window.addEventListener("mouseup", onPointerUp);
      this.canvas.addEventListener("touchstart", (e) => {
        if (e.touches.length > 0) {
          onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });
      window.addEventListener("touchmove", (e) => {
        if (this.isDragging && e.touches.length > 0) {
          onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });
      window.addEventListener("touchend", onPointerUp);
    }
    /**
     * Renders the thumbnail canvas
     */
    async render() {
      if (!this.canvas || !this.ctx) return;
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      let imgSource = null;
      if (this.selectedPhoto) {
        if (this.selectedPhoto.bitmap) {
          imgSource = this.selectedPhoto.bitmap;
        } else if (this.selectedPhoto.imgElement) {
          imgSource = this.selectedPhoto.imgElement;
        } else if (this.selectedPhoto.dataUrl) {
          if (!this.selectedPhoto._cachedImg) {
            const img = new Image();
            img.src = this.selectedPhoto.dataUrl;
            await new Promise((r) => {
              img.onload = r;
              img.onerror = r;
            });
            this.selectedPhoto._cachedImg = img;
          }
          imgSource = this.selectedPhoto._cachedImg;
        }
      }
      if (imgSource) {
        const srcW = imgSource.width || 1920;
        const srcH = imgSource.height || 1080;
        const scale = Math.max(W / srcW, H / srcH);
        const drawnW = srcW * scale;
        const drawnH = srcH * scale;
        const offsetX = (W - drawnW) / 2;
        const offsetY = (H - drawnH) / 2;
        ctx.drawImage(imgSource, offsetX, offsetY, drawnW, drawnH);
        if (this.contrast !== 1) {
          ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, (this.contrast - 1) * 0.4)})`;
          ctx.fillRect(0, 0, W, H);
        }
      } else {
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, "#2b170c");
        grad.addColorStop(0.5, "#170e08");
        grad.addColorStop(1, "#0c0704");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }
      if (this.vignetteIntensity > 0) {
        const vignette = ctx.createRadialGradient(
          W / 2,
          H / 2,
          Math.min(W, H) * 0.35,
          W / 2,
          H / 2,
          Math.max(W, H) * 0.75
        );
        vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
        vignette.addColorStop(1, `rgba(0, 0, 0, ${this.vignetteIntensity})`);
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);
        const bottomGrad = ctx.createLinearGradient(0, H * 0.4, 0, H);
        bottomGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
        bottomGrad.addColorStop(1, "rgba(0, 0, 0, 0.6)");
        ctx.fillStyle = bottomGrad;
        ctx.fillRect(0, H * 0.4, W, H * 0.6);
      }
      const lines = [this.textLine1, this.textLine2].filter(Boolean);
      if (lines.length > 0) {
        const baseFontSize = this.format === "9:16" ? 76 : 58;
        const font = `800 ${baseFontSize}px 'Noto Sans Devanagari', -apple-system, sans-serif`;
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lineSpacing = baseFontSize * 1.35;
        const totalBlockHeight = (lines.length - 1) * lineSpacing;
        const centerY = this.textY * H;
        const startY = centerY - totalBlockHeight / 2;
        const centerX = this.textX * W;
        lines.forEach((line, idx) => {
          const y = startY + idx * lineSpacing;
          const textMetrics = ctx.measureText(line);
          const textW = textMetrics.width;
          switch (this.textStyle) {
            case "red-box": {
              const padX = baseFontSize * 0.45;
              const padY = baseFontSize * 0.22;
              const boxW = textW + padX * 2;
              const boxH = baseFontSize * 1.25;
              const boxX = centerX - boxW / 2;
              const boxY = y - boxH / 2;
              ctx.save();
              ctx.translate(centerX, y);
              const rot = idx === 0 ? -0.015 : 0.01;
              ctx.rotate(rot);
              ctx.fillStyle = "#dc2626";
              ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
              ctx.shadowBlur = 16;
              ctx.shadowOffsetY = 4;
              this.roundRect(ctx, -(boxW / 2), -(boxH / 2), boxW, boxH, 8);
              ctx.fill();
              ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
              ctx.shadowBlur = 4;
              ctx.fillStyle = "#ffffff";
              ctx.fillText(line, 0, 2);
              ctx.restore();
              break;
            }
            case "yellow-highlight": {
              ctx.save();
              ctx.lineJoin = "round";
              ctx.miterLimit = 2;
              ctx.lineWidth = baseFontSize * 0.22;
              ctx.strokeStyle = "#120a05";
              ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
              ctx.shadowBlur = 12;
              ctx.shadowOffsetY = 4;
              ctx.strokeText(line, centerX, y);
              ctx.fillStyle = "#ffd466";
              ctx.fillText(line, centerX, y);
              ctx.restore();
              break;
            }
            case "minimal": {
              ctx.save();
              ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
              ctx.shadowBlur = 18;
              ctx.shadowOffsetY = 4;
              ctx.fillStyle = "#ffffff";
              ctx.fillText(line, centerX, y);
              ctx.restore();
              break;
            }
            case "bold-white":
            default: {
              ctx.save();
              ctx.lineJoin = "round";
              ctx.miterLimit = 2;
              ctx.lineWidth = baseFontSize * 0.24;
              ctx.strokeStyle = "#000000";
              ctx.shadowColor = "rgba(0, 0, 0, 0.95)";
              ctx.shadowBlur = 14;
              ctx.shadowOffsetY = 5;
              ctx.strokeText(line, centerX, y);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(line, centerX, y);
              ctx.restore();
              break;
            }
          }
        });
      }
      ctx.restore();
    }
    roundRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }
    /**
     * Generates a Blob for export
     * @param {string} mimeType 
     * @returns {Promise<Blob>}
     */
    async toBlob(mimeType = "image/png") {
      await this.render();
      return new Promise((resolve) => {
        this.canvas.toBlob((blob) => resolve(blob), mimeType);
      });
    }
    /**
     * Triggers download of the current thumbnail
     * @param {string} [filename]
     */
    async downloadPng(filename) {
      const blob = await this.toBlob("image/png");
      if (!blob) return;
      const defaultName = this.format === "9:16" ? "cover_9x16.png" : "thumbnail_16x9.png";
      const a = document.createElement("a");
      const url2 = URL.createObjectURL(blob);
      a.href = url2;
      a.download = filename || defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url2), 2e3);
    }
  };

  // js/vendor/zip-writer.js
  var CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    CRC_TABLE[i] = c >>> 0;
  }
  function crc32(uint8Array) {
    let crc = 4294967295;
    for (let i = 0; i < uint8Array.length; i++) {
      crc = CRC_TABLE[(crc ^ uint8Array[i]) & 255] ^ crc >>> 8;
    }
    return (crc ^ 4294967295) >>> 0;
  }
  var SimpleZip = class {
    constructor() {
      this.files = [];
    }
    /**
     * Adds a file to the zip.
     * @param {string} filename 
     * @param {Uint8Array|ArrayBuffer|Blob|string} content 
     * @param {Date} [date]
     */
    async addFile(filename, content, date = /* @__PURE__ */ new Date()) {
      let data;
      if (typeof content === "string") {
        data = new TextEncoder().encode(content);
      } else if (content instanceof Uint8Array) {
        data = content;
      } else if (content instanceof ArrayBuffer) {
        data = new Uint8Array(content);
      } else if (typeof Blob !== "undefined" && content instanceof Blob) {
        const buf = await content.arrayBuffer();
        data = new Uint8Array(buf);
      } else {
        throw new Error(`Unsupported content type for ${filename}`);
      }
      this.files.push({
        name: filename.replace(/\\/g, "/"),
        data,
        date
      });
    }
    /**
     * Builds the ZIP archive and returns it as a Uint8Array.
     * @returns {Uint8Array}
     */
    generateUint8Array() {
      const encoder = new TextEncoder();
      const localHeaders = [];
      const centralDirs = [];
      let offset = 0;
      for (const file of this.files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = file.data;
        const fileCrc = crc32(dataBytes);
        const size = dataBytes.length;
        const d = file.date;
        const dosTime = (d.getHours() << 11 | d.getMinutes() << 5 | Math.floor(d.getSeconds() / 2)) & 65535;
        const dosDate = (d.getFullYear() - 1980 << 9 | d.getMonth() + 1 << 5 | d.getDate()) & 65535;
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lhView = new DataView(localHeader.buffer);
        lhView.setUint32(0, 67324752, true);
        lhView.setUint16(4, 20, true);
        lhView.setUint16(6, 2048, true);
        lhView.setUint16(8, 0, true);
        lhView.setUint16(10, dosTime, true);
        lhView.setUint16(12, dosDate, true);
        lhView.setUint32(14, fileCrc, true);
        lhView.setUint32(18, size, true);
        lhView.setUint32(22, size, true);
        lhView.setUint16(26, nameBytes.length, true);
        lhView.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);
        const localOffset = offset;
        localHeaders.push({ header: localHeader, data: dataBytes });
        offset += localHeader.length + dataBytes.length;
        const cdHeader = new Uint8Array(46 + nameBytes.length);
        const cdView = new DataView(cdHeader.buffer);
        cdView.setUint32(0, 33639248, true);
        cdView.setUint16(4, 20, true);
        cdView.setUint16(6, 20, true);
        cdView.setUint16(8, 2048, true);
        cdView.setUint16(10, 0, true);
        cdView.setUint16(12, dosTime, true);
        cdView.setUint16(14, dosDate, true);
        cdView.setUint32(16, fileCrc, true);
        cdView.setUint32(20, size, true);
        cdView.setUint32(24, size, true);
        cdView.setUint16(28, nameBytes.length, true);
        cdView.setUint16(30, 0, true);
        cdView.setUint16(32, 0, true);
        cdView.setUint16(34, 0, true);
        cdView.setUint16(36, 0, true);
        cdView.setUint32(38, 0, true);
        cdView.setUint32(42, localOffset, true);
        cdHeader.set(nameBytes, 46);
        centralDirs.push(cdHeader);
      }
      const cdStartOffset = offset;
      let cdTotalSize = 0;
      for (const cd of centralDirs) {
        cdTotalSize += cd.length;
      }
      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);
      eocdView.setUint32(0, 101010256, true);
      eocdView.setUint16(4, 0, true);
      eocdView.setUint16(6, 0, true);
      eocdView.setUint16(8, this.files.length, true);
      eocdView.setUint16(10, this.files.length, true);
      eocdView.setUint32(12, cdTotalSize, true);
      eocdView.setUint32(16, cdStartOffset, true);
      eocdView.setUint16(20, 0, true);
      const totalLength = cdStartOffset + cdTotalSize + eocd.length;
      const finalBuffer = new Uint8Array(totalLength);
      let writePos = 0;
      for (const item of localHeaders) {
        finalBuffer.set(item.header, writePos);
        writePos += item.header.length;
        finalBuffer.set(item.data, writePos);
        writePos += item.data.length;
      }
      for (const cd of centralDirs) {
        finalBuffer.set(cd, writePos);
        writePos += cd.length;
      }
      finalBuffer.set(eocd, writePos);
      return finalBuffer;
    }
    /**
     * Generates a downloadable Blob in browser environments.
     * @param {string} [mimeType='application/zip']
     * @returns {Blob}
     */
    generateBlob(mimeType = "application/zip") {
      const bytes2 = this.generateUint8Array();
      return new Blob([bytes2], { type: mimeType });
    }
  };

  // js/validators.js
  var WORDS_PER_SECOND = 2.4;
  function countWords(text) {
    if (!text || typeof text !== "string") return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  }
  function estimateDuration(text) {
    const words = countWords(text);
    return Number((words / WORDS_PER_SECOND).toFixed(1));
  }
  function analyzeRetentionLine(lineText) {
    const words = countWords(lineText);
    const seconds = estimateDuration(lineText);
    const reasons = [];
    if (seconds > 9) {
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
  function checkWordBudget(scriptLines, targetSeconds = 75) {
    const totalWords = (scriptLines || []).reduce((acc, line) => acc + countWords(line), 0);
    const targetWords = Math.round(targetSeconds * WORDS_PER_SECOND);
    const delta = Math.abs(totalWords - targetWords);
    const deltaPercent = delta / (targetWords || 1) * 100;
    const isWithinBudget = deltaPercent <= 10;
    return {
      targetWords,
      actualWords: totalWords,
      deltaPercent: Number(deltaPercent.toFixed(1)),
      isWithinBudget
    };
  }

  // js/story_controller.js
  var SAMPLE_STORY = `\u0938\u093F\u0924\u0902\u092C\u0930 1947, \u0932\u093E\u0939\u094C\u0930 \u0930\u0947\u0932\u0935\u0947 \u0938\u094D\u091F\u0947\u0936\u0928 \u0915\u093E \u0916\u091A\u093E\u0916\u091A \u092D\u0930\u093E \u092A\u094D\u0932\u0947\u091F\u092B\u093C\u0949\u0930\u094D\u092E\u0964 \u091F\u094D\u0930\u0947\u0928 \u0915\u0940 \u0938\u0940\u091F\u0940 \u092C\u091C\u0924\u0940 \u0939\u0948 \u0914\u0930 \u092D\u0940\u0921\u093C \u092E\u0947\u0902 \u092A\u0924\u093F-\u092A\u0924\u094D\u0928\u0940 \u090F\u0915-\u0926\u0942\u0938\u0930\u0947 \u0938\u0947 \u0939\u092E\u0947\u0936\u093E \u0915\u0947 \u0932\u093F\u090F \u092C\u093F\u091B\u0921\u093C \u091C\u093E\u0924\u0947 \u0939\u0948\u0902\u0964 \u092A\u0924\u094D\u0928\u0940 \u0915\u0947 \u092A\u093E\u0938 \u0938\u093F\u0930\u094D\u092B\u093C \u0909\u0938\u0915\u0940 \u0938\u093E\u0921\u093C\u0940 \u0915\u0947 \u092A\u0932\u094D\u0932\u0942 \u092E\u0947\u0902 \u092C\u0902\u0927\u0940 \u0918\u0930 \u0915\u0940 \u091A\u093E\u092C\u0940 \u0925\u0940, \u092F\u0939 \u0938\u094B\u091A\u0915\u0930 \u0915\u093F \u0935\u094B 10-15 \u0926\u093F\u0928\u094B\u0902 \u092E\u0947\u0902 \u0932\u094C\u091F \u0906\u090F\u0917\u0940\u0964 \u0932\u0947\u0915\u093F\u0928 \u0935\u0939 \u0926\u093F\u0928 \u0915\u092D\u0940 \u0928\u0939\u0940\u0902 \u0906\u092F\u093E\u0964
\u0932\u093E\u0916\u094B\u0902 \u0932\u094B\u0917 120 \u0915\u093F\u0932\u094B\u092E\u0940\u091F\u0930 \u0932\u0902\u092C\u0947 \u092A\u0948\u0926\u0932 \u0915\u093E\u092B\u093C\u093F\u0932\u094B\u0902 \u092E\u0947\u0902 \u0927\u0942\u0932 \u0914\u0930 \u0906\u0902\u0938\u0941\u0913\u0902 \u0915\u0947 \u092C\u0940\u091A \u091A\u0932\u0924\u0947 \u0930\u0939\u0947\u0964 \u0915\u0941\u0930\u0941\u0915\u094D\u0937\u0947\u0924\u094D\u0930, \u092A\u0941\u0930\u093E\u0928\u093E \u0915\u093C\u093F\u0932\u093E \u0914\u0930 \u0935\u093E\u0932\u094D\u091F\u0928 \u0915\u0947 \u0936\u0930\u0923\u093E\u0930\u094D\u0925\u0940 \u0915\u0948\u0902\u092A\u094B\u0902 \u092E\u0947\u0902 \u0930\u093E\u0924\u0947\u0902 \u0915\u091F\u0940\u0902\u0964 \u091C\u093E\u0932\u0902\u0927\u0930 \u0914\u0930 \u0905\u092E\u0943\u0924\u0938\u0930 \u0930\u0947\u0921\u093F\u092F\u094B \u092A\u0930 \u0939\u0930 \u0918\u0902\u091F\u0947 \u092C\u093F\u091B\u0921\u093C\u0947 \u0939\u0941\u090F \u0905\u092A\u0928\u094B\u0902 \u0915\u0947 \u0928\u093E\u092E \u092A\u0941\u0915\u093E\u0930\u0947 \u091C\u093E\u0924\u0947 \u0930\u0939\u0947\u0964 \u0928\u090F \u0906\u0936\u093F\u092F\u093E\u0928\u0947 \u092C\u0938\u0947\u2014\u0932\u093E\u091C\u092A\u0924 \u0928\u0917\u0930, \u092A\u091F\u0947\u0932 \u0928\u0917\u0930, \u092A\u0902\u091C\u093E\u092C\u0940 \u092C\u093E\u0917 \u0914\u0930 \u092B\u093C\u0930\u0940\u0926\u093E\u092C\u093E\u0926\u0964 \u0906\u091C \u092D\u0940 \u0915\u0908 \u092A\u0930\u093F\u0935\u093E\u0930\u094B\u0902 \u0915\u0940 \u092A\u0941\u0930\u093E\u0928\u0940 \u0938\u0902\u0926\u0942\u0915\u094B\u0902 \u092E\u0947\u0902 \u0935\u0947 \u091C\u0902\u0917 \u0932\u0917\u0940 \u091A\u093E\u092C\u093F\u092F\u093E\u0902 \u0914\u0930 \u0924\u093E\u0932\u0947 \u092E\u0939\u092B\u093C\u0942\u091C\u093C \u0939\u0948\u0902, \u091C\u094B \u0909\u0938 \u0916\u094B\u090F \u0939\u0941\u090F \u0935\u0924\u0928 \u0915\u0940 \u0917\u0935\u093E\u0939\u0940 \u0926\u0947\u0924\u0947 \u0939\u0948\u0902\u0964`;
  var StoryFlowController = class {
    constructor(app) {
      this.app = app;
      this.gemini = app.gemini || new GeminiClient({
        onCallCountChange: (count) => this.updateGeminiCallCount(count)
      });
      this.thumbnailMaker = null;
      this.autosaveTimer = null;
      this.isDirty = false;
      this.currentProjectId = loadSetting("last_project_id", `proj_${Date.now()}`);
      this.exportingDual = false;
    }
    async init() {
      this.cacheDom();
      this.initTheme();
      this.initThumbnailEngine();
      this.bindStepperEvents();
      this.bindStoryEvents();
      this.bindScriptStudioEvents();
      this.bindPhotoEvents();
      this.bindSceneMatchEvents();
      this.bindPublishEvents();
      this.bindSettingsEvents();
      this.bindProjectsEvents();
      this.startAutosaveLoop();
      this.app.toggleFrameStarred = (id) => this.togglePhotoStarred(id);
      this.app.deleteExtractedFrame = (id) => this.deletePhoto(id);
      this.app.previewLargeFrame = (id) => {
        const f = (this.app.state.extractedFrames || []).find((p) => p.id === id);
        if (f) this.previewLargePhoto(f);
      };
      await this.loadInitialProject();
    }
    cacheDom() {
      var _a, _b;
      this.stepper = document.getElementById("wizardStepper");
      this.mobileActionBar = document.getElementById("mobileActionBar");
      this.mobileBackBtn = document.getElementById("mobileBackBtn");
      this.mobileNextBtn = document.getElementById("mobileNextBtn");
      this.mobileStepName = document.getElementById("mobileStepName");
      this.themeToggleBtn = document.getElementById("themeToggleBtn");
      this.themeIconDark = (_a = this.themeToggleBtn) == null ? void 0 : _a.querySelector(".theme-icon-dark");
      this.themeIconLight = (_b = this.themeToggleBtn) == null ? void 0 : _b.querySelector(".theme-icon-light");
      this.autosaveBadge = document.getElementById("autosaveBadge");
      this.autosaveText = document.getElementById("autosaveText");
      this.geminiCallCount = document.getElementById("geminiCallCount");
      this.storyTextarea = document.getElementById("storyTextarea");
      this.storyFileInput = document.getElementById("storyFileInput");
      this.loadSampleStoryBtn = document.getElementById("loadSampleStoryBtn");
      this.startSampleBtn = document.getElementById("startSampleBtn");
      this.goToScriptBtn = document.getElementById("goToScriptBtn");
      this.storyWordCountBadge = document.getElementById("storyWordCountBadge");
      this.storyCharCountBadge = document.getElementById("storyCharCountBadge");
      this.storyEstReadBadge = document.getElementById("storyEstReadBadge");
      this.scriptLangSelect = document.getElementById("scriptLangSelect");
      this.scriptDurationSlider = document.getElementById("scriptDurationSlider");
      this.scriptDurationBudgetDisplay = document.getElementById("scriptDurationBudgetDisplay");
      this.scriptToneSelect = document.getElementById("scriptToneSelect");
      this.scriptOpeningSelect = document.getElementById("scriptOpeningSelect");
      this.skipPoliticsCheck = document.getElementById("skipPoliticsCheck");
      this.skipHistoryCheck = document.getElementById("skipHistoryCheck");
      this.trendingKeywordsToggle = document.getElementById("trendingKeywordsToggle");
      this.customInstructionsInput = document.getElementById("customInstructionsInput");
      this.generateScriptBtn = document.getElementById("generateScriptBtn");
      this.scriptHistorySelect = document.getElementById("scriptHistorySelect");
      this.restoreScriptVersionBtn = document.getElementById("restoreScriptVersionBtn");
      this.scriptLinesContainer = document.getElementById("scriptLinesContainer");
      this.addScriptLineBtn = document.getElementById("addScriptLineBtn");
      this.retentionTotalDuration = document.getElementById("retentionTotalDuration");
      this.retentionDurationBand = document.getElementById("retentionDurationBand");
      this.hookLabCardsContainer = document.getElementById("hookLabCardsContainer");
      this.moreHooksBtn = document.getElementById("moreHooksBtn");
      this.backToStoryBtn = document.getElementById("backToStoryBtn");
      this.goToPhotosBtn = document.getElementById("goToPhotosBtn");
      this.directPhotoUploadInput = document.getElementById("directPhotoUploadInput");
      this.goToSceneMatchBtn = document.getElementById("goToSceneMatchBtn");
      this.backToScriptBtn = document.getElementById("backToScriptBtn");
      this.autoMatchScenesBtn = document.getElementById("autoMatchScenesBtn");
      this.shuffleModeCheck = document.getElementById("shuffleModeCheck");
      this.sceneMatchStatus = document.getElementById("sceneMatchStatus");
      this.sceneMatchBoard = document.getElementById("sceneMatchBoard");
      this.goToVoiceBtn = document.getElementById("goToVoiceBtn");
      this.backToPhotosBtn = document.getElementById("backToPhotosBtn");
      this.goToAnimationBtn = document.getElementById("goToAnimationBtn");
      this.backToSceneMatchBtn = document.getElementById("backToSceneMatchBtn");
      this.goToThumbnailBtn = document.getElementById("goToThumbnailBtn");
      this.backToVoiceBtn = document.getElementById("backToVoiceBtn");
      this.thumbFormat16x9Btn = document.getElementById("thumbFormat16x9Btn");
      this.thumbFormat9x16Btn = document.getElementById("thumbFormat9x16Btn");
      this.downloadThumbPngBtn = document.getElementById("downloadThumbPngBtn");
      this.thumbnailCanvas = document.getElementById("thumbnailCanvas");
      this.thumbPhotoStrip = document.getElementById("thumbPhotoStrip");
      this.suggestHeadlinesBtn = document.getElementById("suggestHeadlinesBtn");
      this.headlineSuggestionsContainer = document.getElementById("headlineSuggestionsContainer");
      this.headlineChips = document.getElementById("headlineChips");
      this.thumbTextLine1 = document.getElementById("thumbTextLine1");
      this.thumbTextLine2 = document.getElementById("thumbTextLine2");
      this.thumbTextYSlider = document.getElementById("thumbTextYSlider");
      this.thumbContrastSlider = document.getElementById("thumbContrastSlider");
      this.thumbVignetteSlider = document.getElementById("thumbVignetteSlider");
      this.styleCardRedBox = document.getElementById("styleCardRedBox");
      this.styleCardYellow = document.getElementById("styleCardYellow");
      this.styleCardBoldWhite = document.getElementById("styleCardBoldWhite");
      this.styleCardMinimal = document.getElementById("styleCardMinimal");
      this.goToPublishBtn = document.getElementById("goToPublishBtn");
      this.backToAnimationBtn = document.getElementById("backToAnimationBtn");
      this.exportBothFormatsBtn = document.getElementById("exportBothFormatsBtn");
      this.downloadZipBtn = document.getElementById("downloadZipBtn");
      this.publishTabYtBtn = document.getElementById("publishTabYtBtn");
      this.publishTabFbBtn = document.getElementById("publishTabFbBtn");
      this.publishPanelYt = document.getElementById("publishPanelYt");
      this.publishPanelFb = document.getElementById("publishPanelFb");
      this.backToThumbnailBtn = document.getElementById("backToThumbnailBtn");
      this.fbCaptionInput = document.getElementById("fbCaptionInput");
      this.fbHookInput = document.getElementById("fbHookInput");
      this.fbHashtagsContainer = document.getElementById("fbHashtagsContainer");
      this.fbAddHashtagInput = document.getElementById("fbAddHashtagInput");
      this.fbAddHashtagBtn = document.getElementById("fbAddHashtagBtn");
      this.fbFirstCommentInput = document.getElementById("fbFirstCommentInput");
      this.copyFbCaptionBtn = document.getElementById("copyFbCaptionBtn");
      this.copyFbHookBtn = document.getElementById("copyFbHookBtn");
      this.copyFbHashtagsBtn = document.getElementById("copyFbHashtagsBtn");
      this.copyFbCommentBtn = document.getElementById("copyFbCommentBtn");
      this.copyAllFbBtn = document.getElementById("copyAllFbBtn");
      this.projectsModal = document.getElementById("projectsModal");
      this.myProjectsBtn = document.getElementById("myProjectsBtn");
      this.closeProjectsModalBtn = document.getElementById("closeProjectsModalBtn");
      this.newProjectBtn = document.getElementById("newProjectBtn");
      this.projectsListContainer = document.getElementById("projectsListContainer");
      this.settingsModal = document.getElementById("settingsModal");
      this.openSettingsBtn = document.getElementById("openSettingsBtn");
      this.closeSettingsModalBtn = document.getElementById("closeSettingsModalBtn");
      this.globalApiKeyInput = document.getElementById("globalApiKeyInput");
      this.toggleGlobalKeyVisBtn = document.getElementById("toggleGlobalKeyVisBtn");
      this.globalModelSelect = document.getElementById("globalModelSelect");
      this.globalCustomModelGroup = document.getElementById("globalCustomModelGroup");
      this.globalCustomModelInput = document.getElementById("globalCustomModelInput");
      this.saveSettingsBtn = document.getElementById("saveSettingsBtn");
      this.confirmModal = document.getElementById("confirmModal");
      this.confirmModalTitle = document.getElementById("confirmModalTitle");
      this.confirmModalMsg = document.getElementById("confirmModalMsg");
      this.confirmModalCancelBtn = document.getElementById("confirmModalCancelBtn");
      this.confirmModalActionBtn = document.getElementById("confirmModalActionBtn");
    }
    // =========================================================================
    // Theme & App State
    // =========================================================================
    initTheme() {
      var _a;
      const savedTheme = loadSetting("theme", null);
      const isLight = savedTheme === "light";
      this.applyTheme(isLight);
      (_a = this.themeToggleBtn) == null ? void 0 : _a.addEventListener("click", () => {
        const currentLight = document.body.classList.contains("light-theme");
        this.applyTheme(!currentLight);
        saveSetting("theme", !currentLight ? "light" : "dark");
      });
    }
    applyTheme(isLight) {
      var _a, _b, _c, _d;
      if (isLight) {
        document.body.classList.add("light-theme");
        document.body.classList.remove("dark-theme");
        (_a = this.themeIconDark) == null ? void 0 : _a.classList.add("hidden");
        (_b = this.themeIconLight) == null ? void 0 : _b.classList.remove("hidden");
      } else {
        document.body.classList.remove("light-theme");
        document.body.classList.add("dark-theme");
        (_c = this.themeIconDark) == null ? void 0 : _c.classList.remove("hidden");
        (_d = this.themeIconLight) == null ? void 0 : _d.classList.add("hidden");
      }
    }
    updateGeminiCallCount(count) {
      if (this.geminiCallCount) {
        this.geminiCallCount.textContent = count;
      }
    }
    // =========================================================================
    // Stepper & Navigation (8 Steps)
    // =========================================================================
    bindStepperEvents() {
      var _a, _b;
      (_a = this.mobileBackBtn) == null ? void 0 : _a.addEventListener("click", () => {
        const cur = this.app.state.currentStep || 1;
        if (cur > 1) this.app.goToStep(cur - 1);
      });
      (_b = this.mobileNextBtn) == null ? void 0 : _b.addEventListener("click", () => {
        const cur = this.app.state.currentStep || 1;
        if (cur < 4) {
          this.app.goToStep(cur + 1);
        }
      });
    }
    canReachStep(stepNumber) {
      var _a;
      if (stepNumber === 1) return true;
      const hasStory = Boolean((((_a = this.storyTextarea) == null ? void 0 : _a.value) || "").trim());
      if (stepNumber === 2) return hasStory;
      const hasLines = (this.app.state.scriptLines || []).length > 0;
      if (stepNumber === 3) return true;
      const hasPhotos = (this.app.state.extractedFrames || []).length > 0;
      if (stepNumber === 4) return hasLines && hasPhotos;
      if (stepNumber === 5) return hasLines;
      if (stepNumber === 6) return hasPhotos;
      if (stepNumber === 7) return hasPhotos;
      if (stepNumber === 8) return true;
      return true;
    }
    getUnlockedSteps() {
      const unlocked = [1];
      for (let s = 2; s <= 8; s++) {
        if (this.canReachStep(s)) unlocked.push(s);
      }
      return unlocked;
    }
    goToStep(stepNumber) {
      this.app.state.currentStep = stepNumber;
      const unlocked = this.getUnlockedSteps();
      this.app.ui.setStep(stepNumber, unlocked);
      const stepNames = [
        "Step 1: Story",
        "Step 2: Script (Story Studio)",
        "Step 3: Photos",
        "Step 4: Scene Match",
        "Step 5: Voice & Audio",
        "Step 6: Animation & Captions",
        "Step 7: Thumbnail Maker",
        "Step 8: Publish Pack"
      ];
      if (this.mobileStepName) {
        this.mobileStepName.textContent = stepNames[stepNumber - 1] || `Step ${stepNumber}`;
      }
      if (this.mobileBackBtn) {
        this.mobileBackBtn.style.visibility = stepNumber === 1 ? "hidden" : "visible";
      }
      if (this.mobileNextBtn) {
        this.mobileNextBtn.style.visibility = stepNumber === 8 ? "hidden" : "visible";
      }
      if (stepNumber === 4) {
        this.renderSceneMatchBoard();
      } else if (stepNumber === 5) {
        this.prefillVoiceScript();
      } else if (stepNumber === 6) {
        this.rebuildSceneTimeline();
      } else if (stepNumber === 7) {
        this.renderThumbnailStudio();
      } else if (stepNumber === 8) {
        this.renderPublishPack();
      }
      this.markDirtyAndSave();
    }
    // =========================================================================
    // Step 1: Story Input
    // =========================================================================
    bindStoryEvents() {
      var _a, _b, _c, _d;
      (_a = this.storyTextarea) == null ? void 0 : _a.addEventListener("input", () => {
        this.updateStoryStats();
        this.markDirty();
      });
      (_b = this.loadSampleStoryBtn) == null ? void 0 : _b.addEventListener("click", () => {
        var _a2, _b2;
        if (this.storyTextarea) {
          this.storyTextarea.value = SAMPLE_STORY;
          this.updateStoryStats();
          (_b2 = (_a2 = this.app) == null ? void 0 : _a2.ui) == null ? void 0 : _b2.showToast("Loaded September 1947 sample story.", "success");
          this.markDirty();
        }
      });
      (_c = this.startSampleBtn) == null ? void 0 : _c.addEventListener("click", async () => {
        if (this.storyTextarea) {
          this.storyTextarea.value = SAMPLE_STORY;
          this.updateStoryStats();
        }
        this.goToStep(2);
        await this.generateScriptWithGemini();
      });
      (_d = this.storyFileInput) == null ? void 0 : _d.addEventListener("change", (e) => {
        var _a2;
        const file = (_a2 = e.target.files) == null ? void 0 : _a2[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
          var _a3, _b2;
          if (this.storyTextarea) {
            this.storyTextarea.value = evt.target.result || "";
            this.updateStoryStats();
            (_b2 = (_a3 = this.app) == null ? void 0 : _a3.ui) == null ? void 0 : _b2.showToast(`Loaded ${file.name}`, "success");
            this.markDirty();
          }
        };
        reader.readAsText(file);
      });
    }
    updateStoryStats() {
      var _a, _b;
      const text = (((_a = this.storyTextarea) == null ? void 0 : _a.value) || "").trim();
      const words = countWords(text);
      const chars = text.length;
      const estSec = estimateDuration(text);
      if (this.storyWordCountBadge) this.storyWordCountBadge.textContent = words;
      if (this.storyCharCountBadge) this.storyCharCountBadge.textContent = chars;
      if (this.storyEstReadBadge) this.storyEstReadBadge.textContent = `${estSec}s`;
      if ((_b = this.app) == null ? void 0 : _b.state) {
        this.app.state.story = text;
      }
    }
    // =========================================================================
    // Step 2: Script (Story Studio)
    // =========================================================================
    bindScriptStudioEvents() {
      var _a, _b, _c, _d, _e;
      (_a = this.scriptDurationSlider) == null ? void 0 : _a.addEventListener("input", (e) => {
        const secs = parseInt(e.target.value, 10);
        const words = Math.round(secs * 2.4);
        if (this.scriptDurationBudgetDisplay) {
          this.scriptDurationBudgetDisplay.textContent = `${secs}s \xB7 ~${words} words`;
        }
        this.renderRetentionSummary();
      });
      (_b = this.generateScriptBtn) == null ? void 0 : _b.addEventListener("click", () => this.generateScriptWithGemini());
      (_c = this.addScriptLineBtn) == null ? void 0 : _c.addEventListener("click", () => this.addNewScriptLine());
      (_d = this.moreHooksBtn) == null ? void 0 : _d.addEventListener("click", () => this.requestMoreHooks());
      (_e = this.restoreScriptVersionBtn) == null ? void 0 : _e.addEventListener("click", () => {
        var _a2, _b2, _c2, _d2;
        const idx = parseInt((_a2 = this.scriptHistorySelect) == null ? void 0 : _a2.value, 10);
        if (!isNaN(idx) && ((_b2 = this.app.state.scriptHistory) == null ? void 0 : _b2[idx])) {
          this.app.state.scriptLines = [...this.app.state.scriptHistory[idx].lines];
          this.renderScriptLines();
          (_d2 = (_c2 = this.app) == null ? void 0 : _c2.ui) == null ? void 0 : _d2.showToast("Restored script version.", "success");
          this.markDirty();
        }
      });
    }
    async generateScriptWithGemini() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s;
      const story = (((_a = this.storyTextarea) == null ? void 0 : _a.value) || this.app.state.story || "").trim();
      if (!story) {
        (_c = (_b = this.app) == null ? void 0 : _b.ui) == null ? void 0 : _c.showToast("Please enter a story in Step 1 first.", "error");
        this.goToStep(1);
        return;
      }
      const key = this.gemini.getApiKey();
      if (!key) {
        this.openSettingsModal();
        (_e = (_d = this.app) == null ? void 0 : _d.ui) == null ? void 0 : _e.showToast("Please enter your Gemini API key to generate scripts.", "info");
        return;
      }
      const targetSec = parseInt((_f = this.scriptDurationSlider) == null ? void 0 : _f.value, 10) || 75;
      const language = ((_g = this.scriptLangSelect) == null ? void 0 : _g.value) || "Hindi";
      const tone = ((_h = this.scriptToneSelect) == null ? void 0 : _h.value) || "Emotional";
      const openingStyle = ((_i = this.scriptOpeningSelect) == null ? void 0 : _i.value) || "Scene";
      const skipPolitics = Boolean((_j = this.skipPoliticsCheck) == null ? void 0 : _j.checked);
      const skipHistory = Boolean((_k = this.skipHistoryCheck) == null ? void 0 : _k.checked);
      const customInstructions = (((_l = this.customInstructionsInput) == null ? void 0 : _l.value) || "").trim();
      const useSearch = Boolean((_m = this.trendingKeywordsToggle) == null ? void 0 : _m.checked);
      if (this.generateScriptBtn) {
        this.generateScriptBtn.disabled = true;
        this.generateScriptBtn.innerHTML = `\u23F3 <span class="yt-spinner"></span> Generating Script with Gemini...`;
      }
      try {
        let trendingKeywords = "";
        if (useSearch) {
          try {
            (_o = (_n = this.app) == null ? void 0 : _n.ui) == null ? void 0 : _o.showToast("\u{1F50D} Searching Google for trending keywords...", "info", 2500);
            trendingKeywords = await this.gemini.trendingResearch({ topic: story.slice(0, 100) });
            this.app.state.trendingResearch = trendingKeywords;
          } catch (sErr) {
            console.warn("[Search Tool]", sErr);
          }
        }
        const result = await this.gemini.generateScript({
          story,
          language,
          targetSeconds: targetSec,
          tone,
          openingStyle,
          skipPolitics,
          skipHistory,
          customInstructions,
          trendingKeywords
        });
        const budgetCheck = checkWordBudget(result.script_lines, targetSec);
        if (!budgetCheck.isWithinBudget) {
          console.warn(`[Validation] Script budget delta is ${budgetCheck.deltaPercent}%`);
        }
        this.app.state.scriptLines = (result.script_lines || []).map((line, idx) => {
          var _a2;
          return {
            text: line,
            scene_tags: ((_a2 = result.scene_tags) == null ? void 0 : _a2[idx]) || ["history", "scene"],
            estimatedSeconds: estimateDuration(line)
          };
        });
        if (!this.app.state.scriptHistory) this.app.state.scriptHistory = [];
        this.app.state.scriptHistory.unshift({
          timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
          lines: JSON.parse(JSON.stringify(this.app.state.scriptLines)),
          note: `${this.app.state.scriptLines.length} lines \xB7 ${targetSec}s target`
        });
        if (this.app.state.scriptHistory.length > 10) this.app.state.scriptHistory.pop();
        this.updateHistorySelect();
        this.app.state.hookOptions = result.hook_options || [];
        if (result.youtube) {
          if (!this.app.state.publishPack) this.app.state.publishPack = {};
          this.app.state.publishPack.youtube = result.youtube;
        }
        if (result.facebook) {
          this.app.state.publishPack.facebook = result.facebook;
        }
        this.renderScriptLines();
        this.renderHookLab();
        (_q = (_p = this.app) == null ? void 0 : _p.ui) == null ? void 0 : _q.showToast("\u2728 High-retention Hindi narration generated!", "success");
        this.markDirtyAndSave();
      } catch (err) {
        console.error("[Script Gen Error]", err);
        (_s = (_r = this.app) == null ? void 0 : _r.ui) == null ? void 0 : _s.showToast(`Script generation failed: ${err.message}`, "error", 6e3);
      } finally {
        if (this.generateScriptBtn) {
          this.generateScriptBtn.disabled = false;
          this.generateScriptBtn.innerHTML = `\u2728 Generate Script with Gemini`;
        }
      }
    }
    updateHistorySelect() {
      if (!this.scriptHistorySelect) return;
      this.scriptHistorySelect.innerHTML = '<option value="">Version History (Current)</option>';
      (this.app.state.scriptHistory || []).forEach((v, idx) => {
        const opt = document.createElement("option");
        opt.value = idx;
        opt.textContent = `v${idx + 1} (${v.timestamp}) \u2014 ${v.note}`;
        this.scriptHistorySelect.appendChild(opt);
      });
    }
    renderScriptLines() {
      if (!this.scriptLinesContainer) return;
      this.scriptLinesContainer.innerHTML = "";
      const lines = this.app.state.scriptLines || [];
      if (lines.length === 0) {
        this.scriptLinesContainer.innerHTML = `
        <div class="empty-placeholder">
          <span>Click "Generate Script with Gemini" to create your sentence-by-sentence narration script.</span>
        </div>`;
        this.renderRetentionSummary();
        return;
      }
      lines.forEach((lineObj, idx) => {
        const analysis = analyzeRetentionLine(lineObj.text);
        lineObj.estimatedSeconds = analysis.seconds;
        const card = document.createElement("div");
        card.className = `script-line-card ${analysis.isWarning ? "has-warning" : ""}`;
        const header = document.createElement("div");
        header.className = "script-line-header";
        const meta = document.createElement("div");
        meta.className = "line-meta-badge";
        meta.innerHTML = `<strong>Line ${idx + 1}</strong> &middot; <span>${analysis.words} words</span> &middot; <span>~${analysis.seconds}s</span>`;
        if (analysis.isWarning) {
          const warnBadge = document.createElement("span");
          warnBadge.className = "warning-pill";
          warnBadge.textContent = analysis.reasons.join(" \xB7 ");
          meta.appendChild(warnBadge);
        }
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "line-delete-btn";
        delBtn.title = "Delete line";
        delBtn.textContent = "\u{1F5D1}\uFE0F";
        delBtn.addEventListener("click", () => {
          this.app.state.scriptLines.splice(idx, 1);
          this.renderScriptLines();
          this.markDirty();
        });
        header.appendChild(meta);
        header.appendChild(delBtn);
        const ta = document.createElement("textarea");
        ta.className = "script-line-textarea hindi-font";
        ta.rows = 2;
        ta.value = lineObj.text;
        ta.addEventListener("input", (e) => {
          lineObj.text = e.target.value;
          const newAnalysis = analyzeRetentionLine(lineObj.text);
          lineObj.estimatedSeconds = newAnalysis.seconds;
          card.classList.toggle("has-warning", newAnalysis.isWarning);
          this.renderRetentionSummary();
          this.markDirty();
        });
        const track = document.createElement("div");
        track.className = "line-retention-track";
        const fill = document.createElement("div");
        fill.className = "line-retention-fill";
        const pct = Math.min(100, analysis.seconds / 10 * 100);
        fill.style.width = `${pct}%`;
        if (analysis.seconds > 9) fill.style.background = "#ef4444";
        else if (analysis.seconds > 7) fill.style.background = "#f59e0b";
        track.appendChild(fill);
        const footer = document.createElement("div");
        footer.className = "script-line-footer";
        const tagsSpan = document.createElement("span");
        tagsSpan.className = "subtext";
        tagsSpan.textContent = `Visual: ${(lineObj.scene_tags || []).join(", ")}`;
        const shortenBtn = document.createElement("button");
        shortenBtn.type = "button";
        shortenBtn.className = "btn-shorten-line";
        shortenBtn.innerHTML = `\u26A1 Shorten this line`;
        shortenBtn.addEventListener("click", () => this.shortenScriptLine(idx));
        footer.appendChild(tagsSpan);
        footer.appendChild(shortenBtn);
        card.appendChild(header);
        card.appendChild(ta);
        card.appendChild(track);
        card.appendChild(footer);
        this.scriptLinesContainer.appendChild(card);
      });
      this.renderRetentionSummary();
    }
    async shortenScriptLine(lineIndex) {
      var _a, _b, _c, _d, _e, _f;
      const lines = this.app.state.scriptLines || [];
      if (!lines[lineIndex]) return;
      const originalText = lines[lineIndex].text;
      (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast(`Shortening line ${lineIndex + 1} with Gemini...`, "info", 3e3);
      try {
        const res = await this.gemini.shortenLine({
          lineText: originalText,
          targetSeconds: 4.5,
          storyContext: this.app.state.story
        });
        if (res == null ? void 0 : res.shortened_line) {
          lines[lineIndex].text = res.shortened_line;
          this.renderScriptLines();
          (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast(`Line ${lineIndex + 1} shortened successfully!`, "success");
          this.markDirty();
        }
      } catch (err) {
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast(`Failed to shorten line: ${err.message}`, "error");
      }
    }
    addNewScriptLine() {
      if (!this.app.state.scriptLines) this.app.state.scriptLines = [];
      this.app.state.scriptLines.push({
        text: "\u0928\u0908 \u092A\u0902\u0915\u094D\u0924\u093F \u092F\u0939\u093E\u0901 \u0932\u093F\u0916\u0947\u0902\u0964",
        scene_tags: ["history", "scene"],
        estimatedSeconds: 2.5
      });
      this.renderScriptLines();
      this.markDirty();
    }
    renderRetentionSummary() {
      var _a;
      const lines = this.app.state.scriptLines || [];
      const totalWords = lines.reduce((acc, l) => acc + countWords(l.text || ""), 0);
      const totalSec = Number((totalWords / 2.4).toFixed(1));
      const targetSec = parseInt((_a = this.scriptDurationSlider) == null ? void 0 : _a.value, 10) || 75;
      if (this.retentionTotalDuration) {
        this.retentionTotalDuration.textContent = `Total: ${totalSec}s (~${totalWords} words) / ${targetSec}s Target`;
      }
      if (this.retentionDurationBand) {
        const pct = Math.min(100, totalSec / (targetSec * 1.3) * 100);
        this.retentionDurationBand.style.width = `${pct}%`;
        const delta = Math.abs(totalSec - targetSec);
        const deltaPct = delta / targetSec * 100;
        this.retentionDurationBand.className = "retention-progress-bar";
        if (deltaPct <= 10) {
          this.retentionDurationBand.classList.add("band-green");
        } else if (deltaPct <= 25) {
          this.retentionDurationBand.classList.add("band-amber");
        } else {
          this.retentionDurationBand.classList.add("band-red");
        }
      }
    }
    renderHookLab() {
      if (!this.hookLabCardsContainer) return;
      this.hookLabCardsContainer.innerHTML = "";
      const hooks = this.app.state.hookOptions || [];
      if (hooks.length === 0) {
        this.hookLabCardsContainer.innerHTML = `
        <span class="subtext">Generate a script to preview high-retaining alternative hooks.</span>`;
        return;
      }
      hooks.forEach((h, idx) => {
        const card = document.createElement("div");
        card.className = "hook-option-card";
        card.innerHTML = `
        <div class="hook-score-badge">\u2605 ${h.score || 9}/10 Score</div>
        <div class="hook-text hindi-font">${h.text}</div>
        <div class="hook-why">${h.why || "Attention grabbing opening"}</div>
      `;
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "btn btn-xs btn-primary";
        useBtn.textContent = "Use this hook for Line 1";
        useBtn.addEventListener("click", () => {
          var _a, _b;
          if (this.app.state.scriptLines && this.app.state.scriptLines.length > 0) {
            this.app.state.scriptLines[0].text = h.text;
            this.renderScriptLines();
            (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Applied hook to Line 1!", "success");
            this.markDirty();
          }
        });
        card.appendChild(useBtn);
        this.hookLabCardsContainer.appendChild(card);
      });
    }
    async requestMoreHooks() {
      var _a, _b, _c, _d, _e, _f, _g;
      (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Generating more hooks with Gemini...", "info", 2500);
      try {
        const res = await this.gemini.moreHooks({
          story: this.app.state.story,
          currentHooks: this.app.state.hookOptions,
          openingStyle: ((_c = this.scriptOpeningSelect) == null ? void 0 : _c.value) || "Scene"
        });
        if (res == null ? void 0 : res.hook_options) {
          this.app.state.hookOptions = res.hook_options;
          this.renderHookLab();
          (_e = (_d = this.app) == null ? void 0 : _d.ui) == null ? void 0 : _e.showToast("Fresh hooks generated!", "success");
          this.markDirty();
        }
      } catch (e) {
        (_g = (_f = this.app) == null ? void 0 : _f.ui) == null ? void 0 : _g.showToast(`Failed to generate hooks: ${e.message}`, "error");
      }
    }
    // =========================================================================
    // Step 3: Photos (Direct Upload + Video Extractor)
    // =========================================================================
    bindPhotoEvents() {
      var _a;
      (_a = this.directPhotoUploadInput) == null ? void 0 : _a.addEventListener("change", async (e) => {
        var _a2, _b, _c, _d, _e, _f, _g, _h;
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        (_b = (_a2 = this.app) == null ? void 0 : _a2.ui) == null ? void 0 : _b.showToast(`Loading ${files.length} photos...`, "info", 2e3);
        let count = 0;
        const wm = (_d = (_c = this.app) == null ? void 0 : _c.getWatermarkConfig) == null ? void 0 : _d.call(_c);
        for (const file of files) {
          try {
            let dataUrl = await this.readFileAsDataUrl(file);
            let finalBlob = file;
            if (wm && wm.enabled && ((_f = (_e = this.app) == null ? void 0 : _e.extractor) == null ? void 0 : _f.applyWatermark)) {
              try {
                const img = await new Promise((res, rej) => {
                  const i = new Image();
                  i.onload = () => res(i);
                  i.onerror = rej;
                  i.src = dataUrl;
                });
                const cvs = document.createElement("canvas");
                cvs.width = img.naturalWidth || img.width;
                cvs.height = img.naturalHeight || img.height;
                const c = cvs.getContext("2d");
                c.drawImage(img, 0, 0);
                this.app.extractor.applyWatermark(c, cvs.width, cvs.height, wm);
                dataUrl = cvs.toDataURL("image/jpeg", 0.95);
                finalBlob = await new Promise((r) => cvs.toBlob((b) => r(b), "image/jpeg", 0.95));
              } catch (wErr) {
                console.warn("[Direct Photo Watermark]", wErr);
              }
            }
            const photoId = `photo_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const photoRecord = {
              id: photoId,
              previewUrl: dataUrl,
              dataUrl,
              timestamp: count * 4,
              sourceMinute: 0,
              starred: false,
              tags: [],
              caption: file.name.replace(/\.[^/.]+$/, ""),
              mood: "neutral"
            };
            this.app.state.extractedFrames.push(photoRecord);
            await ProjectStore.saveBlob(photoId, finalBlob);
            count++;
          } catch (err) {
            console.warn("[Direct Photo Upload]", err);
          }
        }
        this.renderPhotoGallery();
        (_h = (_g = this.app) == null ? void 0 : _g.ui) == null ? void 0 : _h.showToast(`Added ${count} photos to gallery!`, "success");
        this.markDirtyAndSave();
      });
    }
    renderPhotoGallery() {
      if (typeof this.app.refreshGallery === "function") {
        this.app.refreshGallery();
      } else {
        this.app.ui.renderFramesGrid(
          this.app.state.extractedFrames,
          {
            onToggleStar: (id) => this.togglePhotoStarred(id),
            onDeleteFrame: (id) => this.deletePhoto(id),
            onPreviewFrame: (f) => this.previewLargePhoto(f)
          }
        );
      }
    }
    togglePhotoStarred(id) {
      const frame = (this.app.state.extractedFrames || []).find((f) => f.id === id);
      if (frame) {
        frame.starred = !frame.starred;
        this.renderPhotoGallery();
        this.markDirty();
      }
    }
    deletePhoto(id) {
      const frames = this.app.state.extractedFrames || [];
      const idx = frames.findIndex((f) => f.id === id);
      if (idx !== -1) {
        const [removed] = frames.splice(idx, 1);
        if (removed && removed.previewUrl && typeof removed.previewUrl === "string" && removed.previewUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(removed.previewUrl);
          } catch (e) {
          }
        }
        this.renderPhotoGallery();
        this.markDirty();
      }
    }
    previewLargePhoto(frame) {
      const modal = document.getElementById("framePreviewModal");
      const img = document.getElementById("modalPreviewImg");
      const meta = document.getElementById("modalMetaRow");
      if (modal && img) {
        img.src = frame.previewUrl || frame.dataUrl || "";
        if (meta) {
          meta.textContent = `Timestamp: ${Math.floor(frame.timestamp / 60)}:${String(Math.floor(frame.timestamp % 60)).padStart(2, "0")} \xB7 Aspect: ${frame.aspectRatio || "16:9"}`;
        }
        modal.classList.remove("hidden");
      }
    }
    readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = (e) => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }
    // =========================================================================
    // Step 4: Scene Match (Gemini Vision Tagging + Tag Overlap Matcher)
    // =========================================================================
    bindSceneMatchEvents() {
      var _a, _b;
      (_a = this.autoMatchScenesBtn) == null ? void 0 : _a.addEventListener("click", () => this.autoMatchScenes());
      (_b = this.shuffleModeCheck) == null ? void 0 : _b.addEventListener("change", (e) => {
        this.app.state.shuffleMode = e.target.checked;
        this.rebuildSceneTimeline();
        this.markDirty();
      });
    }
    async autoMatchScenes() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
      const photos = this.app.state.extractedFrames || [];
      const scriptLines = this.app.state.scriptLines || [];
      if (photos.length === 0) {
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Please add photos in Step 3 first.", "error");
        return;
      }
      if (scriptLines.length === 0) {
        (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast("Please create script lines in Step 2 first.", "error");
        return;
      }
      if (this.autoMatchScenesBtn) {
        this.autoMatchScenesBtn.disabled = true;
        this.autoMatchScenesBtn.innerHTML = `\u23F3 <span class="yt-spinner"></span> Vision Tagging & Matching...`;
      }
      const noticeSeen = loadSetting("vision_notice_acknowledged", false);
      if (!noticeSeen) {
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast("Notice: Photos are sent to Gemini Vision only for tag extraction and matching.", "info", 6e3);
        saveSetting("vision_notice_acknowledged", true);
      }
      try {
        const untaggedPhotos = [];
        for (const p of photos) {
          if (!p.tags || p.tags.length === 0) {
            const cached = await ProjectStore.getCachedPhotoTags(p.id);
            if (cached) {
              p.tags = cached.tags || [];
              p.caption = cached.caption || "";
              p.mood = cached.mood || "neutral";
            } else {
              untaggedPhotos.push(p);
            }
          }
        }
        if (untaggedPhotos.length > 0) {
          if (this.sceneMatchStatus) {
            this.sceneMatchStatus.textContent = `Analyzing ${untaggedPhotos.length} photos in batches of 8 with Gemini Vision...`;
          }
          for (let i = 0; i < untaggedPhotos.length; i += 8) {
            const batch = untaggedPhotos.slice(i, i + 8);
            const payloadPhotos = [];
            for (const bp of batch) {
              const base64 = await this.getDownscaledJpegBase64(bp);
              payloadPhotos.push({ id: bp.id, base64, mimeType: "image/jpeg" });
            }
            const visionResults = await this.gemini.tagPhotos(payloadPhotos);
            for (const vr of visionResults) {
              const targetP = photos.find((p) => p.id === vr.id);
              if (targetP) {
                targetP.tags = vr.tags || [];
                targetP.caption = vr.caption || "";
                targetP.mood = vr.mood || "neutral";
                await ProjectStore.setCachedPhotoTags(targetP.id, vr);
              }
            }
          }
        }
        if (this.sceneMatchStatus) {
          this.sceneMatchStatus.textContent = `Matching ${scriptLines.length} script lines with ${photos.length} photos...`;
        }
        const existingLocks = (this.app.state.sceneMatches || []).filter((m) => m.locked);
        const matches = await this.gemini.matchScenes({ scriptLines, photos });
        const finalMatches = matches.map((m) => {
          const lockedMatch = existingLocks.find((l) => l.line_index === m.line_index);
          return lockedMatch || { ...m, locked: false };
        });
        this.app.state.sceneMatches = finalMatches;
        this.renderSceneMatchBoard();
        this.rebuildSceneTimeline();
        (_h = (_g = this.app) == null ? void 0 : _g.ui) == null ? void 0 : _h.showToast("\u2728 Scenes matched to photos successfully!", "success");
        this.markDirtyAndSave();
      } catch (err) {
        console.error("[Scene Match Error]", err);
        const fallback = this.gemini.fallbackMatchScenes(scriptLines, photos);
        this.app.state.sceneMatches = fallback;
        this.renderSceneMatchBoard();
        this.rebuildSceneTimeline();
        (_j = (_i = this.app) == null ? void 0 : _i.ui) == null ? void 0 : _j.showToast(`Local tag matcher used: ${err.message}`, "warning");
        this.markDirty();
      } finally {
        if (this.autoMatchScenesBtn) {
          this.autoMatchScenesBtn.disabled = false;
          this.autoMatchScenesBtn.innerHTML = `\u2728 Auto-Match Scenes with Gemini`;
        }
        if (this.sceneMatchStatus) {
          this.sceneMatchStatus.textContent = `Matched ${scriptLines.length} script lines. Click locks to keep pairs.`;
        }
      }
    }
    async getDownscaledJpegBase64(photo) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 512;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round(h * maxDim / w);
              w = maxDim;
            } else {
              w = Math.round(w * maxDim / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          resolve(dataUrl.split(",")[1]);
        };
        img.onerror = () => resolve("");
        img.src = photo.dataUrl;
      });
    }
    renderSceneMatchBoard() {
      if (!this.sceneMatchBoard) return;
      this.sceneMatchBoard.innerHTML = "";
      const lines = this.app.state.scriptLines || [];
      const photos = this.app.state.extractedFrames || [];
      const matches = this.app.state.sceneMatches || [];
      if (lines.length === 0 || photos.length === 0) {
        this.sceneMatchBoard.innerHTML = `
        <div class="empty-placeholder">
          <span>Complete Step 2 (Script) and Step 3 (Photos) then click "Auto-Match Scenes" above.</span>
        </div>`;
        return;
      }
      lines.forEach((line, idx) => {
        var _a;
        const match = matches.find((m) => m.line_index === idx) || {
          line_index: idx,
          photo_id: (_a = photos[idx % photos.length]) == null ? void 0 : _a.id,
          confidence: "medium",
          locked: false
        };
        const photo = photos.find((p) => p.id === match.photo_id) || photos[0];
        const row = document.createElement("div");
        row.className = "scene-match-row";
        const leftCol = document.createElement("div");
        leftCol.className = "match-line-col";
        leftCol.innerHTML = `
        <div class="line-num">Line #${idx + 1} &middot; ~${line.estimatedSeconds || 3}s</div>
        <div class="line-text hindi-font">${line.text}</div>
        <div class="match-tags-row">
          ${(line.scene_tags || []).map((t) => `<span class="scene-tag-chip">\u{1F3F7}\uFE0F ${t}</span>`).join("")}
        </div>
      `;
        const rightCol = document.createElement("div");
        rightCol.className = "match-photo-col";
        const thumbImg = document.createElement("img");
        thumbImg.className = "match-thumb-img";
        thumbImg.src = photo.previewUrl || photo.dataUrl || "";
        thumbImg.alt = "Matched photo";
        const metaInfo = document.createElement("div");
        metaInfo.className = "match-meta-info";
        const confLevel = match.confidence || "high";
        metaInfo.innerHTML = `
        <div class="match-confidence">
          <span class="confidence-dot ${confLevel}"></span>
          <span>${confLevel.toUpperCase()} MATCH</span>
        </div>
        <div class="subtext" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;">
          ${(photo.tags || []).slice(0, 3).join(", ") || "Archival Photo"}
        </div>
      `;
        const sel = document.createElement("select");
        sel.className = "form-select form-select-xs";
        sel.style.marginTop = "0.25rem";
        photos.forEach((p, pIdx) => {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = `Photo #${pIdx + 1}${p.starred ? " \u2B50" : ""} (${(p.tags || []).slice(0, 2).join(", ")})`;
          if (p.id === photo.id) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", (e) => {
          match.photo_id = e.target.value;
          const newP = photos.find((p) => p.id === e.target.value);
          if (newP) thumbImg.src = newP.previewUrl || newP.dataUrl || "";
          this.rebuildSceneTimeline();
          this.markDirty();
        });
        metaInfo.appendChild(sel);
        const lockBtn = document.createElement("button");
        lockBtn.type = "button";
        lockBtn.className = `btn-lock-match ${match.locked ? "locked" : ""}`;
        lockBtn.title = match.locked ? "Locked (survives auto-match)" : "Click to lock";
        lockBtn.textContent = match.locked ? "\u{1F512}" : "\u{1F513}";
        lockBtn.addEventListener("click", () => {
          match.locked = !match.locked;
          lockBtn.textContent = match.locked ? "\u{1F512}" : "\u{1F513}";
          lockBtn.classList.toggle("locked", match.locked);
          this.markDirty();
        });
        rightCol.appendChild(thumbImg);
        rightCol.appendChild(metaInfo);
        rightCol.appendChild(lockBtn);
        row.appendChild(leftCol);
        row.appendChild(rightCol);
        this.sceneMatchBoard.appendChild(row);
      });
    }
    rebuildSceneTimeline() {
      var _a, _b;
      const photos = this.app.state.extractedFrames || [];
      const scriptLines = this.app.state.scriptLines || [];
      const matches = this.app.state.sceneMatches || [];
      if (photos.length === 0) return;
      if (!this.app.state.shuffleMode && matches.length > 0 && scriptLines.length > 0) {
        const dur = this.app.getEffectiveTimelineDuration();
        this.app.state.timelineDuration = dur;
        const segments = this.app.timelineEngine.generateSceneMatchedTimeline(
          photos,
          scriptLines,
          matches,
          dur,
          (_a = this.app.captionEngine) == null ? void 0 : _a.chunks,
          {
            enabledAnimations: this.app.state.enabledAnimations,
            maxZoom: this.app.state.maxZoom,
            transitionDuration: this.app.state.transitionDuration,
            transitionType: this.app.state.transitionType
          }
        );
        this.app.ui.renderTimelineTracks(segments, (_b = this.app.captionEngine) == null ? void 0 : _b.chunks, dur);
        const totalDisplay = document.getElementById("totalDurationDisplay");
        if (totalDisplay) totalDisplay.textContent = this.app.ui.formatTime(dur);
        this.app.renderCurrentPreviewFrame();
      } else {
        this.app.rebuildTimeline();
      }
    }
    prefillVoiceScript() {
      const lines = (this.app.state.scriptLines || []).map((l) => l.text);
      if (lines.length > 0) {
        const fullText = lines.join(" ");
        const scriptTa = document.getElementById("scriptTextarea");
        if (scriptTa && (!scriptTa.value.trim() || scriptTa.value.trim() !== fullText)) {
          scriptTa.value = fullText;
          this.app.state.scriptText = fullText;
          this.app.captionEngine.chunks = this.app.captionEngine.splitScriptIntoSentences(fullText);
          this.app.realignCaptionsWithCurrentVoice();
        }
      }
    }
    // =========================================================================
    // Step 7: Thumbnail Maker
    // =========================================================================
    initThumbnailEngine() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i;
      if (!this.thumbnailCanvas) return;
      this.thumbnailMaker = new ThumbnailMaker(this.thumbnailCanvas);
      (_a = this.thumbFormat16x9Btn) == null ? void 0 : _a.addEventListener("click", () => {
        this.thumbFormat16x9Btn.classList.add("active");
        this.thumbFormat9x16Btn.classList.remove("active");
        this.thumbnailMaker.setFormat("16:9");
      });
      (_b = this.thumbFormat9x16Btn) == null ? void 0 : _b.addEventListener("click", () => {
        this.thumbFormat9x16Btn.classList.add("active");
        this.thumbFormat16x9Btn.classList.remove("active");
        this.thumbnailMaker.setFormat("9:16");
      });
      (_c = this.thumbTextLine1) == null ? void 0 : _c.addEventListener("input", (e) => {
        this.thumbnailMaker.setText(e.target.value, void 0);
        this.markDirty();
      });
      (_d = this.thumbTextLine2) == null ? void 0 : _d.addEventListener("input", (e) => {
        this.thumbnailMaker.setText(void 0, e.target.value);
        this.markDirty();
      });
      const styleCards = [
        { el: this.styleCardRedBox, style: "red-box" },
        { el: this.styleCardYellow, style: "yellow-highlight" },
        { el: this.styleCardBoldWhite, style: "bold-white" },
        { el: this.styleCardMinimal, style: "minimal" }
      ];
      styleCards.forEach(({ el, style }) => {
        el == null ? void 0 : el.addEventListener("click", () => {
          styleCards.forEach((c) => {
            var _a2;
            return (_a2 = c.el) == null ? void 0 : _a2.classList.remove("selected");
          });
          el.classList.add("selected");
          this.thumbnailMaker.setStyle(style);
          this.markDirty();
        });
      });
      (_e = this.thumbTextYSlider) == null ? void 0 : _e.addEventListener("input", (e) => {
        const normY = parseInt(e.target.value, 10) / 100;
        this.thumbnailMaker.setPositionY(normY);
      });
      (_f = this.thumbContrastSlider) == null ? void 0 : _f.addEventListener("input", (e) => {
        this.thumbnailMaker.contrast = parseInt(e.target.value, 10) / 100;
        this.thumbnailMaker.render();
      });
      (_g = this.thumbVignetteSlider) == null ? void 0 : _g.addEventListener("input", (e) => {
        this.thumbnailMaker.vignetteIntensity = parseInt(e.target.value, 10) / 100;
        this.thumbnailMaker.render();
      });
      (_h = this.downloadThumbPngBtn) == null ? void 0 : _h.addEventListener("click", () => {
        var _a2, _b2;
        this.thumbnailMaker.downloadPng();
        (_b2 = (_a2 = this.app) == null ? void 0 : _a2.ui) == null ? void 0 : _b2.showToast("\u{1F4BE} Thumbnail downloaded as PNG!", "success");
      });
      (_i = this.suggestHeadlinesBtn) == null ? void 0 : _i.addEventListener("click", () => this.suggestHeadlines());
    }
    renderThumbnailStudio() {
      if (!this.thumbnailMaker) return;
      const photos = this.app.state.extractedFrames || [];
      if (this.thumbPhotoStrip) {
        this.thumbPhotoStrip.innerHTML = "";
        photos.forEach((p, idx) => {
          const img = document.createElement("img");
          img.className = `thumb-strip-item ${idx === 0 ? "selected" : ""}`;
          img.src = p.dataUrl;
          img.alt = `Photo ${idx + 1}`;
          img.addEventListener("click", () => {
            var _a;
            (_a = this.thumbPhotoStrip) == null ? void 0 : _a.querySelectorAll(".thumb-strip-item").forEach((i) => i.classList.remove("selected"));
            img.classList.add("selected");
            this.thumbnailMaker.setPhoto(p);
            this.markDirty();
          });
          this.thumbPhotoStrip.appendChild(img);
        });
      }
      if (photos.length > 0 && !this.thumbnailMaker.selectedPhoto) {
        this.thumbnailMaker.setPhoto(photos[0]);
      } else {
        this.thumbnailMaker.render();
      }
    }
    async suggestHeadlines() {
      var _a, _b, _c, _d, _e, _f;
      (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Generating headline ideas with Gemini...", "info", 2500);
      try {
        const suggestions = await this.gemini.thumbnailTexts({
          story: this.app.state.story,
          scriptLines: this.app.state.scriptLines
        });
        if (this.headlineSuggestionsContainer && this.headlineChips) {
          this.headlineSuggestionsContainer.classList.remove("hidden");
          this.headlineChips.innerHTML = "";
          suggestions.forEach((text) => {
            const chip = document.createElement("div");
            chip.className = "headline-chip hindi-font";
            chip.textContent = text;
            chip.addEventListener("click", () => {
              if (this.thumbTextLine1) {
                this.thumbTextLine1.value = text;
                this.thumbnailMaker.setText(text, void 0);
                this.markDirty();
              }
            });
            this.headlineChips.appendChild(chip);
          });
        }
        (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast("Click a headline to apply to thumbnail!", "success");
      } catch (e) {
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast(`Headline suggestion failed: ${e.message}`, "error");
      }
    }
    // =========================================================================
    // Step 8: Publish Pack & Dual Export
    // =========================================================================
    bindPublishEvents() {
      var _a, _b, _c;
      this.exportMp4Btn = document.getElementById("exportMp4Btn");
      (_a = this.exportMp4Btn) == null ? void 0 : _a.addEventListener("click", async () => {
        var _a2, _b2, _c2, _d, _e, _f, _g, _h;
        if ((this.app.state.extractedFrames || []).length === 0) {
          (_b2 = (_a2 = this.app) == null ? void 0 : _a2.ui) == null ? void 0 : _b2.showToast("Please add photos or extract frames in Step 1 first!", "warning");
          return;
        }
        const progressModal = document.getElementById("exportProgressModal");
        const progressTitle = document.getElementById("exportProgressTitle");
        progressModal == null ? void 0 : progressModal.classList.remove("hidden");
        if (this.app.state.voiceMode === "A" && (this.app.state.scriptText || "").trim() && !((_c2 = this.app.voiceEngine) == null ? void 0 : _c2.audioBuffer)) {
          try {
            if (progressTitle) progressTitle.textContent = "Generating Neural Voice (Neural TTS)...";
            const sentences = this.app.captionEngine.splitScriptIntoSentences(this.app.state.scriptText);
            const ttsOpts = this.app.getTtsOptions();
            const ttsResult = await this.app.voiceEngine.generateVoiceFromScript(sentences, {
              voice: ttsOpts.voice,
              rate: ttsOpts.rate,
              pitch: ttsOpts.pitch,
              volume: ttsOpts.volume
            });
            if (ttsResult == null ? void 0 : ttsResult.buffer) {
              this.app.onVoiceLoaded(ttsResult.buffer, "tts_voice.wav", true);
            }
          } catch (ttsErr) {
            console.warn("[Neural TTS Export fallback]", ttsErr);
          }
        }
        if (progressTitle) {
          const hasVoice2 = Boolean((_d = this.app.voiceEngine) == null ? void 0 : _d.audioBuffer);
          progressTitle.textContent = hasVoice2 ? "Fast Encoding Video & Voice (WebCodecs)..." : "Fast Encoding Video (WebCodecs)...";
        }
        try {
          const blob = await this.renderVideoBlob();
          if (this.app.state.aspectRatio === "9:16") {
            this.cachedBlob916 = blob;
          } else {
            this.cachedBlob169 = blob;
          }
          const ratioTag = this.app.state.aspectRatio === "9:16" ? "9x16" : "16x9";
          this.app.exporter.triggerDownload(blob, `storyflow_${ratioTag}.mp4`);
          (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast("Export completed successfully!", "success");
        } catch (err) {
          (_h = (_g = this.app) == null ? void 0 : _g.ui) == null ? void 0 : _h.showToast(`Export failed: ${err.message}`, "error");
        } finally {
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
        }
      });
      this.exportBothFormatsBtn = document.getElementById("exportBothFormatsBtn");
      (_b = this.exportBothFormatsBtn) == null ? void 0 : _b.addEventListener("click", () => this.exportBothFormats());
      this.downloadZipBtn = document.getElementById("downloadZipBtn");
      (_c = this.downloadZipBtn) == null ? void 0 : _c.addEventListener("click", () => this.downloadAllInZip());
    }
    renderPublishPack() {
      const pack = this.app.state.publishPack;
      if (!pack) return;
      if (pack.youtube && this.app.youtubeGenerator) {
        this.app.youtubeGenerator.renderResults(pack.youtube);
      }
      if (pack.facebook) {
        if (this.fbCaptionInput) this.fbCaptionInput.value = pack.facebook.caption || "";
        if (this.fbHookInput) this.fbHookInput.value = pack.facebook.hook_line || "";
        if (this.fbFirstCommentInput) this.fbFirstCommentInput.value = pack.facebook.first_comment || "";
        if (this.fbHashtagsContainer) {
          this.fbHashtagsContainer.innerHTML = "";
          (pack.facebook.hashtags || []).forEach((tag, idx) => {
            const chip = document.createElement("span");
            chip.className = "yt-hashtag-chip";
            chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove">&times;</button>`;
            chip.querySelector(".yt-chip-remove").addEventListener("click", () => {
              pack.facebook.hashtags.splice(idx, 1);
              this.renderPublishPack();
            });
            this.fbHashtagsContainer.appendChild(chip);
          });
        }
      }
    }
    async copyToClipboard(text, label = "Content") {
      var _a, _b, _c, _d, _e, _f;
      if (!text) {
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast(`Nothing to copy for ${label}`, "warning");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast(`\u{1F4CB} Copied ${label} to clipboard!`, "success");
      } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        (_f = (_e = this.app) == null ? void 0 : _e.ui) == null ? void 0 : _f.showToast(`\u{1F4CB} Copied ${label} to clipboard!`, "success");
      }
    }
    copyAllFacebook() {
      var _a, _b, _c, _d, _e;
      const caption = ((_a = this.fbCaptionInput) == null ? void 0 : _a.value) || "";
      const hook = ((_b = this.fbHookInput) == null ? void 0 : _b.value) || "";
      const hashtags = (((_d = (_c = this.app.state.publishPack) == null ? void 0 : _c.facebook) == null ? void 0 : _d.hashtags) || []).join(" ");
      const comment = ((_e = this.fbFirstCommentInput) == null ? void 0 : _e.value) || "";
      const bundle = `=== FACEBOOK VIDEO POST ===
HOOK:
${hook}

CAPTION:
${caption}

HASHTAGS:
${hashtags}

FIRST COMMENT:
${comment}
`;
      this.copyToClipboard(bundle, "Facebook Post Pack");
    }
    async exportBothFormats() {
      var _a, _b, _c, _d, _e, _f, _g;
      if (this.exportingDual) return;
      if ((this.app.state.extractedFrames || []).length === 0) {
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Please add photos or extract frames in Step 1 first!", "warning");
        return;
      }
      this.exportingDual = true;
      const progressModal = document.getElementById("exportProgressModal");
      const progressTitle = document.getElementById("exportProgressTitle");
      progressModal == null ? void 0 : progressModal.classList.remove("hidden");
      try {
        if (this.app.state.voiceMode === "A" && !((_c = this.app.voiceEngine) == null ? void 0 : _c.audioBuffer)) {
          const scriptText = (this.app.state.scriptText || "").trim();
          if (scriptText) {
            if (progressTitle) progressTitle.textContent = "Generating Neural Voice for Dual Export...";
            const sentences = this.app.captionEngine.splitScriptIntoSentences(scriptText);
            const ttsOpts = this.app.getTtsOptions();
            const ttsResult = await this.app.voiceEngine.generateVoiceFromScript(sentences, {
              voice: ttsOpts.voice,
              rate: ttsOpts.rate,
              pitch: ttsOpts.pitch,
              volume: ttsOpts.volume
            });
            if (ttsResult == null ? void 0 : ttsResult.buffer) {
              this.app.onVoiceLoaded(ttsResult.buffer, "tts_voice.wav", true);
            }
          }
        }
        if (progressTitle) progressTitle.textContent = "Rendering Format 1 of 2: 16:9 Landscape...";
        this.app.setAspectRatio("16:9");
        this.rebuildSceneTimeline();
        const blob169 = await this.renderVideoBlob();
        this.cachedBlob169 = blob169;
        this.app.exporter.triggerDownload(blob169, "storyflow_16x9.mp4");
        if (progressTitle) progressTitle.textContent = "Rendering Format 2 of 2: 9:16 Vertical (Shorts/Reels)...";
        this.app.setAspectRatio("9:16");
        this.app.state.verticalModeLayout = "blur-bg";
        this.rebuildSceneTimeline();
        const blob916 = await this.renderVideoBlob();
        this.cachedBlob916 = blob916;
        this.app.exporter.triggerDownload(blob916, "storyflow_9x16.mp4");
        (_e = (_d = this.app) == null ? void 0 : _d.ui) == null ? void 0 : _e.showToast("\u{1F389} Both 16:9 and 9:16 videos rendered successfully!", "success", 6e3);
      } catch (err) {
        (_g = (_f = this.app) == null ? void 0 : _f.ui) == null ? void 0 : _g.showToast(`Dual export failed: ${err.message}`, "error", 6e3);
      } finally {
        progressModal == null ? void 0 : progressModal.classList.add("hidden");
        this.exportingDual = false;
        this.app.setAspectRatio("16:9");
        this.rebuildSceneTimeline();
      }
    }
    async renderVideoBlob() {
      return new Promise(async (resolve, reject) => {
        try {
          const bar = document.getElementById("exportProgressBar");
          const pct = document.getElementById("exportPercentDisplay");
          const frameDisplay = document.getElementById("exportFrameDisplay");
          const miniCanvas = document.getElementById("exportMiniThumbCanvas");
          const onProgress = (p) => {
            if (bar) bar.style.width = `${p.percent}%`;
            if (pct) pct.textContent = `${p.percent}%`;
            if (frameDisplay) frameDisplay.textContent = `${p.currentFrame} / ${p.totalFrames}`;
          };
          const result = await this.app.exporter.exportFastSilent(this.app.state, onProgress, miniCanvas, false);
          resolve((result == null ? void 0 : result.blob) || result);
        } catch (err) {
          reject(err);
        }
      });
    }
    async downloadAllInZip() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
      (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Building in-browser ZIP bundle...", "info", 4e3);
      const zip = new SimpleZip();
      try {
        const scriptText = this.app.state.scriptText || (this.app.state.scriptLines || []).map((l) => l.text).join("\n") || ((_c = this.storyTextarea) == null ? void 0 : _c.value) || ((_d = document.getElementById("scriptTextarea")) == null ? void 0 : _d.value) || "";
        await zip.addFile("script.txt", scriptText);
        if (((_f = (_e = this.app.captionEngine) == null ? void 0 : _e.chunks) == null ? void 0 : _f.length) > 0) {
          const srt = this.app.captionEngine.generateSRT(this.app.captionEngine.chunks);
          await zip.addFile("captions.srt", srt);
          const vtt = this.app.captionEngine.generateVTT(this.app.captionEngine.chunks);
          await zip.addFile("captions.vtt", vtt);
        }
        if (this.thumbnailMaker) {
          this.thumbnailMaker.setFormat("16:9");
          const thumbBlob169 = await this.thumbnailMaker.toBlob("image/png");
          if (thumbBlob169) await zip.addFile("thumbnail_16x9.png", thumbBlob169);
          this.thumbnailMaker.setFormat("9:16");
          const thumbBlob916 = await this.thumbnailMaker.toBlob("image/png");
          if (thumbBlob916) await zip.addFile("cover_9x16.png", thumbBlob916);
        }
        const meta = this.app.state.publishPack || ((_g = this.app.youtubeGenerator) == null ? void 0 : _g.cachedResults) || {};
        const metaJson = JSON.stringify(meta, null, 2);
        await zip.addFile("metadata.json", metaJson);
        const yt = meta.youtube || {};
        const fb = meta.facebook || {};
        const metaTxt = `=== STORYFLOW STUDIO PUBLISH PACK ===
Generated: ${(/* @__PURE__ */ new Date()).toLocaleString()}

-------------------------------------------------------
1. YOUTUBE VIDEO METADATA
-------------------------------------------------------
TITLES:
${(yt.titles || []).map((t, i) => `${i + 1}. ${t}`).join("\n")}

DESCRIPTION:
${yt.description || ""}

HASHTAGS:
${(yt.hashtags || []).join(" ")}

TAGS:
${Array.isArray(yt.tags) ? yt.tags.join(", ") : yt.tags || ""}

PINNED COMMENT:
${yt.pinned_comment || ""}

-------------------------------------------------------
2. FACEBOOK VIDEO METADATA
-------------------------------------------------------
HEADLINES:
${(fb.headlines || []).map((h, i) => `${i + 1}. ${h}`).join("\n")}

POST:
${fb.post_text || fb.caption || ""}

VIDEO TITLE:
${fb.video_title || ""}

VIDEO DESCRIPTION:
${fb.video_description || ""}

HASHTAGS:
${(fb.hashtags || []).join(" ")}

FIRST COMMENT:
${fb.first_comment || ""}
`;
        await zip.addFile("publish_pack.txt", metaTxt);
        const sanitizedProject = {
          version: "2.0",
          product: "StoryFlow Studio",
          savedAt: (/* @__PURE__ */ new Date()).toISOString(),
          script: scriptText,
          photosCount: (this.app.state.extractedFrames || []).length,
          settings: {
            currentStep: this.app.state.currentStep || 1,
            aspectRatio: this.app.state.aspectRatio || "16:9",
            timelineDuration: this.app.state.timelineDuration || 60
          }
        };
        await zip.addFile("project.json", JSON.stringify(sanitizedProject, null, 2));
        if (this.cachedBlob169) {
          await zip.addFile("storyflow_16x9.mp4", this.cachedBlob169);
        }
        if (this.cachedBlob916) {
          await zip.addFile("storyflow_9x16.mp4", this.cachedBlob916);
        }
        const zipBlob = zip.generateBlob("application/zip");
        const url2 = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url2;
        a.download = `storyflow_bundle_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url2), 3e3);
        (_i = (_h = this.app) == null ? void 0 : _h.ui) == null ? void 0 : _i.showToast("\u{1F389} Downloaded storyflow_bundle.zip!", "success");
      } catch (e) {
        console.error("[Zip Error]", e);
        (_k = (_j = this.app) == null ? void 0 : _j.ui) == null ? void 0 : _k.showToast(`ZIP export failed: ${e.message}`, "error");
      }
    }
    // =========================================================================
    // Settings & Projects Modal
    // =========================================================================
    bindSettingsEvents() {
      var _a, _b, _c, _d, _e;
      (_a = this.openSettingsBtn) == null ? void 0 : _a.addEventListener("click", () => this.openSettingsModal());
      (_b = this.closeSettingsModalBtn) == null ? void 0 : _b.addEventListener("click", () => this.closeSettingsModal());
      (_c = this.toggleGlobalKeyVisBtn) == null ? void 0 : _c.addEventListener("click", () => {
        var _a2;
        const isPwd = ((_a2 = this.globalApiKeyInput) == null ? void 0 : _a2.type) === "password";
        if (this.globalApiKeyInput) {
          this.globalApiKeyInput.type = isPwd ? "text" : "password";
        }
        if (this.toggleGlobalKeyVisBtn) {
          this.toggleGlobalKeyVisBtn.textContent = isPwd ? "\u{1F648}" : "\u{1F441}\uFE0F";
        }
      });
      (_d = this.globalModelSelect) == null ? void 0 : _d.addEventListener("change", (e) => {
        var _a2, _b2;
        const val = e.target.value;
        if (val === "custom") {
          (_a2 = this.globalCustomModelGroup) == null ? void 0 : _a2.classList.remove("hidden");
        } else {
          (_b2 = this.globalCustomModelGroup) == null ? void 0 : _b2.classList.add("hidden");
          this.gemini.setModel(val);
        }
      });
      (_e = this.saveSettingsBtn) == null ? void 0 : _e.addEventListener("click", () => {
        var _a2, _b2, _c2, _d2, _e2, _f;
        const key = (((_a2 = this.globalApiKeyInput) == null ? void 0 : _a2.value) || "").trim();
        this.gemini.setApiKey(key);
        const model = ((_b2 = this.globalModelSelect) == null ? void 0 : _b2.value) === "custom" ? (((_c2 = this.globalCustomModelInput) == null ? void 0 : _c2.value) || "").trim() : (_d2 = this.globalModelSelect) == null ? void 0 : _d2.value;
        this.gemini.setModel(model);
        this.closeSettingsModal();
        (_f = (_e2 = this.app) == null ? void 0 : _e2.ui) == null ? void 0 : _f.showToast("Saved Gemini API settings.", "success");
      });
    }
    openSettingsModal() {
      if (!this.settingsModal) return;
      const key = this.gemini.getApiKey();
      if (this.globalApiKeyInput) this.globalApiKeyInput.value = key;
      this.settingsModal.classList.remove("hidden");
    }
    closeSettingsModal() {
      var _a;
      (_a = this.settingsModal) == null ? void 0 : _a.classList.add("hidden");
    }
    bindProjectsEvents() {
      var _a, _b, _c, _d;
      (_a = this.myProjectsBtn) == null ? void 0 : _a.addEventListener("click", () => this.openProjectsModal());
      (_b = this.closeProjectsModalBtn) == null ? void 0 : _b.addEventListener("click", () => {
        var _a2;
        return (_a2 = this.projectsModal) == null ? void 0 : _a2.classList.add("hidden");
      });
      (_c = this.newProjectBtn) == null ? void 0 : _c.addEventListener("click", () => {
        var _a2;
        this.createNewProject();
        (_a2 = this.projectsModal) == null ? void 0 : _a2.classList.add("hidden");
      });
      (_d = this.confirmModalCancelBtn) == null ? void 0 : _d.addEventListener("click", () => {
        var _a2;
        (_a2 = this.confirmModal) == null ? void 0 : _a2.classList.add("hidden");
      });
    }
    async openProjectsModal() {
      if (!this.projectsModal) return;
      this.projectsModal.classList.remove("hidden");
      await this.renderProjectsList();
    }
    async renderProjectsList() {
      if (!this.projectsListContainer) return;
      this.projectsListContainer.innerHTML = '<div class="subtext">Loading projects...</div>';
      try {
        const list = await ProjectStore.listProjects();
        if (list.length === 0) {
          this.projectsListContainer.innerHTML = `
          <div class="empty-placeholder">
            <span>No saved projects found in local storage. Click "New Story Project" to start.</span>
          </div>`;
          return;
        }
        this.projectsListContainer.innerHTML = "";
        list.forEach((proj) => {
          const card = document.createElement("div");
          card.className = "project-item-card";
          const info = document.createElement("div");
          info.className = "project-info";
          const d = new Date(proj.updatedAt || Date.now());
          info.innerHTML = `
          <h5>${proj.name}</h5>
          <div class="project-meta-stats">
            <span>Updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>&middot;</span>
            <span>${proj.photoCount} photos</span>
            <span>&middot;</span>
            <span>${proj.scriptLineCount} lines</span>
          </div>
        `;
          const actions = document.createElement("div");
          actions.className = "project-actions";
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "btn btn-xs btn-primary";
          openBtn.textContent = "Open";
          openBtn.addEventListener("click", async () => {
            var _a;
            await this.loadProjectById(proj.id);
            (_a = this.projectsModal) == null ? void 0 : _a.classList.add("hidden");
          });
          const dupBtn = document.createElement("button");
          dupBtn.type = "button";
          dupBtn.className = "btn btn-xs btn-secondary";
          dupBtn.textContent = "Duplicate";
          dupBtn.addEventListener("click", async () => {
            var _a, _b;
            await ProjectStore.duplicateProject(proj.id);
            await this.renderProjectsList();
            (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Project duplicated.", "success");
          });
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "btn btn-xs btn-danger";
          delBtn.textContent = "Delete";
          delBtn.addEventListener("click", () => {
            this.showInPageConfirm(
              "Delete Project?",
              `Are you sure you want to permanently delete "${proj.name}"?`,
              async () => {
                var _a, _b;
                await ProjectStore.deleteProject(proj.id);
                await this.renderProjectsList();
                (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast("Project deleted.", "info");
              }
            );
          });
          actions.appendChild(openBtn);
          actions.appendChild(dupBtn);
          actions.appendChild(delBtn);
          card.appendChild(info);
          card.appendChild(actions);
          this.projectsListContainer.appendChild(card);
        });
      } catch (e) {
        this.projectsListContainer.innerHTML = `<span class="text-danger">Failed to load projects: ${e.message}</span>`;
      }
    }
    showInPageConfirm(title, msg, onConfirm) {
      var _a;
      if (!this.confirmModal) return;
      if (this.confirmModalTitle) this.confirmModalTitle.textContent = title;
      if (this.confirmModalMsg) this.confirmModalMsg.textContent = msg;
      const handleAction = async () => {
        var _a2, _b;
        (_a2 = this.confirmModalActionBtn) == null ? void 0 : _a2.removeEventListener("click", handleAction);
        (_b = this.confirmModal) == null ? void 0 : _b.classList.add("hidden");
        await onConfirm();
      };
      (_a = this.confirmModalActionBtn) == null ? void 0 : _a.addEventListener("click", handleAction);
      this.confirmModal.classList.remove("hidden");
    }
    // =========================================================================
    // IndexedDB Autosave & Project Serialization
    // =========================================================================
    startAutosaveLoop() {
      this.autosaveTimer = setInterval(() => {
        if (this.isDirty) {
          this.saveCurrentProject();
        }
      }, 5e3);
    }
    markDirty() {
      this.isDirty = true;
      if (this.autosaveText) this.autosaveText.textContent = "Unsaved changes...";
    }
    async markDirtyAndSave() {
      this.markDirty();
      await this.saveCurrentProject();
    }
    async saveCurrentProject() {
      var _a, _b;
      try {
        if (this.autosaveText) this.autosaveText.textContent = "Saving...";
        const scriptText = this.app.state.scriptText || ((_a = document.getElementById("scriptTextarea")) == null ? void 0 : _a.value) || "";
        const projectData = {
          id: this.currentProjectId,
          name: this.getProjectName(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          story: scriptText,
          script: scriptText,
          script_lines: (this.app.state.scriptLines || []).map((l) => l.text),
          script_history: this.app.state.scriptHistory || [],
          hook_options: this.app.state.hookOptions || [],
          photo_records: (this.app.state.extractedFrames || []).map((f) => ({
            id: f.id,
            dataUrl: f.dataUrl || f.previewUrl,
            previewUrl: f.previewUrl || f.dataUrl,
            starred: Boolean(f.starred),
            timestamp: f.timestamp || 0,
            tags: f.tags || [],
            caption: f.caption || "",
            mood: f.mood || "neutral"
          })),
          line_to_photo_assignment: this.app.state.sceneMatches || [],
          publish_pack: this.app.state.publishPack || ((_b = this.app.youtubeGenerator) == null ? void 0 : _b.cachedResults) || {},
          settings: {
            currentStep: this.app.state.currentStep || 1,
            aspectRatio: this.app.state.aspectRatio || "16:9",
            timelineDuration: this.app.state.timelineDuration || 60
          }
        };
        await ProjectStore.saveProject(projectData);
        saveSetting("last_project_id", this.currentProjectId);
        this.isDirty = false;
        if (this.autosaveText) this.autosaveText.textContent = "Saved \u2713";
      } catch (e) {
        console.warn("[Autosave]", e);
        if (this.autosaveText) this.autosaveText.textContent = "Autosave paused";
      }
    }
    getProjectName() {
      var _a, _b;
      const script = this.app.state.scriptText || ((_a = document.getElementById("scriptTextarea")) == null ? void 0 : _a.value) || "";
      const firstLine = (_b = script.split("\n")[0]) == null ? void 0 : _b.trim().slice(0, 30);
      return firstLine ? `${firstLine}...` : "Untitled Story";
    }
    async loadInitialProject() {
      var _a, _b, _c;
      const hasExistingPhotos = (this.app.state.extractedFrames || []).length > 0;
      const hasExistingScript = Boolean(this.app.state.scriptText || ((_a = document.getElementById("scriptTextarea")) == null ? void 0 : _a.value));
      const lastId = loadSetting("last_project_id", null);
      if (lastId) {
        const proj = await ProjectStore.loadProject(lastId);
        if (proj) {
          this.currentProjectId = proj.id;
          if (!hasExistingPhotos && proj.photo_records && proj.photo_records.length > 0) {
            this.app.state.extractedFrames = proj.photo_records.map((p) => ({
              ...p,
              previewUrl: p.dataUrl || p.previewUrl
            }));
            this.app.refreshGallery();
          }
          if (!hasExistingScript && (proj.script || proj.story)) {
            const text = proj.script || proj.story || "";
            this.app.state.scriptText = text;
            const ta = document.getElementById("scriptTextarea");
            if (ta) ta.value = text;
            (_c = (_b = this.app).handleScriptChange) == null ? void 0 : _c.call(_b, text);
          }
          if (proj.publish_pack) {
            this.app.state.publishPack = proj.publish_pack;
          }
          return;
        }
      }
    }
    async loadProjectById(id) {
      var _a, _b;
      const proj = await ProjectStore.loadProject(id);
      if (proj) {
        this.currentProjectId = proj.id;
        this.restoreProject(proj);
        (_b = (_a = this.app) == null ? void 0 : _a.ui) == null ? void 0 : _b.showToast(`Loaded "${proj.name}"`, "success");
      }
    }
    restoreProject(proj) {
      var _a, _b, _c;
      if (!proj) return;
      this.currentProjectId = proj.id;
      const scriptText = proj.script || proj.story || "";
      if (scriptText) {
        this.app.state.scriptText = scriptText;
        const ta = document.getElementById("scriptTextarea");
        if (ta) ta.value = scriptText;
        (_b = (_a = this.app).handleScriptChange) == null ? void 0 : _b.call(_a, scriptText);
      }
      if (this.storyTextarea) {
        this.storyTextarea.value = scriptText;
        this.updateStoryStats();
      }
      if (proj.script_lines) {
        this.app.state.scriptLines = proj.script_lines.map((text, idx) => ({
          text,
          scene_tags: ["history", "scene"],
          estimatedSeconds: estimateDuration(text)
        }));
        this.renderScriptLines();
      }
      if (proj.script_history) {
        this.app.state.scriptHistory = proj.script_history;
        this.updateHistorySelect();
      }
      if (proj.hook_options) {
        this.app.state.hookOptions = proj.hook_options;
        this.renderHookLab();
      }
      if (proj.photo_records) {
        this.app.state.extractedFrames = proj.photo_records.map((p) => ({
          ...p,
          previewUrl: p.dataUrl || p.previewUrl
        }));
        this.app.refreshGallery();
      }
      if (proj.line_to_photo_assignment) {
        this.app.state.sceneMatches = proj.line_to_photo_assignment;
        this.renderSceneMatchBoard();
      }
      if (proj.publish_pack) {
        this.app.state.publishPack = proj.publish_pack;
        this.renderPublishPack();
      }
      const step = ((_c = proj.settings) == null ? void 0 : _c.currentStep) || 1;
      if (step >= 1 && step <= 4) {
        this.app.goToStep(step);
      }
    }
    createNewProject() {
      var _a, _b, _c, _d;
      this.currentProjectId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      saveSetting("last_project_id", this.currentProjectId);
      this.app.clearAllExtractedFrames();
      const ta = document.getElementById("scriptTextarea");
      if (ta) ta.value = "";
      this.app.state.scriptText = "";
      (_b = (_a = this.app).handleScriptChange) == null ? void 0 : _b.call(_a, "");
      if (this.storyTextarea) {
        this.storyTextarea.value = "";
        this.updateStoryStats();
      }
      this.app.state.scriptLines = [];
      this.app.state.scriptHistory = [];
      this.app.state.hookOptions = [];
      this.app.state.extractedFrames = [];
      this.app.state.sceneMatches = [];
      this.app.state.publishPack = {};
      this.renderScriptLines();
      this.renderHookLab();
      this.renderSceneMatchBoard();
      this.renderPhotoGallery();
      this.app.goToStep(1);
      (_d = (_c = this.app) == null ? void 0 : _c.ui) == null ? void 0 : _d.showToast("Started new project.", "info");
      this.markDirtyAndSave();
    }
  };

  // js/app.js
  var TONE_PRESETS = {
    normal: { rate: 1, pitch: 1, label: "Normal / Default" },
    storytelling: { rate: 0.95, pitch: 0.95, label: "Storytelling / Narrative" },
    dramatic: { rate: 0.85, pitch: 0.85, label: "Dramatic / Cinema" },
    serious: { rate: 0.9, pitch: 0.85, label: "Serious / Documentary" },
    energetic: { rate: 1.3, pitch: 1.1, label: "High Energy / Reels" },
    fastreels: { rate: 1.6, pitch: 1.05, label: "Fast Narration / Shorts" },
    hyper2x: { rate: 2, pitch: 1, label: "Ultra Speed 2.0x" },
    max25x: { rate: 2.5, pitch: 1.05, label: "Maximum Speed 2.5x" },
    deep: { rate: 0.9, pitch: 0.75, label: "Deep Voice / Radio Host" },
    calm: { rate: 0.8, pitch: 0.9, label: "Calm & Meditative" },
    soft: { rate: 0.85, pitch: 0.9, label: "Soft / Emotional" },
    news: { rate: 1.15, pitch: 1.05, label: "News Anchor / Broadcast" },
    casual: { rate: 1.1, pitch: 1, label: "Casual Conversation" }
  };
  var FrameFlowApp = class {
    constructor() {
      this.sourceVideo = document.getElementById("sourceVideo");
      this.offscreenCanvas = document.getElementById("offscreenCanvas");
      this.previewCanvas = document.getElementById("previewCanvas");
      this.previewCtx = this.previewCanvas.getContext("2d");
      this.ui = new UIController();
      this.extractor = new FrameExtractor(this.sourceVideo, this.offscreenCanvas);
      this.voiceEngine = new VoiceEngine();
      this.captionEngine = new CaptionEngine();
      this.timelineEngine = new TimelineEngine();
      this.renderer = new FrameRenderer(this.extractor);
      this.exporter = new VideoExporter(this.renderer, this.voiceEngine, this.captionEngine);
      this.gemini = new GeminiClient();
      this.storyController = new StoryFlowController(this);
      this.state = {
        currentStep: 1,
        sourceVideoLoaded: false,
        extractedFrames: [],
        filterStarredOnly: false,
        // Extraction Resolution & Watermark
        extractResolutionMode: "1080p",
        customExtractWidth: 1920,
        customExtractHeight: 1080,
        watermark: {
          enabled: false,
          type: "text",
          text: "@StoryFlow",
          style: "dark-pill",
          imageElement: null,
          position: "bottom-right",
          size: "medium",
          opacity: 0.85
        },
        // Voice & Script
        voiceMode: "B",
        // 'B' (My voice) or 'A' (TTS)
        scriptText: "",
        silenceGaps: [],
        // Timeline & Duration
        durationMode: "match-voice",
        // 'match-voice' | '600' | '720' | '900' | '960' | '1200' | 'custom'
        customDuration: 60,
        timelineDuration: 60,
        photoMinDuration: 4,
        photoMaxDuration: 8,
        enabledAnimations: ["zoom-in", "zoom-out", "pan-lr", "pan-rl", "pan-up", "pan-down", "diagonal"],
        maxZoom: 1.25,
        transitionDuration: 0.6,
        transitionType: "crossfade",
        // Aspect Ratio & Layout
        aspectRatio: "16:9",
        exportWidth: 1920,
        exportHeight: 1080,
        customNorm: null,
        verticalModeLayout: "crop",
        // 'crop' | 'blur-bg'
        // Captions Styling
        captionStyle: {
          fontFamily: "'Noto Sans Devanagari', sans-serif",
          fontSize: 42,
          textColor: "#ffffff",
          highlightColor: "#fbbf24",
          outlineThickness: 4,
          outlineColor: "#000000",
          boxEnabled: true,
          boxOpacity: 65,
          position: "bottom",
          karaokeEnabled: true
        },
        // Overlays & Color Grading
        overlays: {
          vignette: 35,
          filmGrain: 15
        },
        colorGrading: {
          brightness: 0,
          contrast: 5,
          saturation: 105
        },
        // TTS Settings
        ttsOptions: {
          voice: null,
          rate: 1,
          pitch: 1,
          volume: 1
        },
        // Playback
        isPlaying: false,
        currentTime: 0,
        playStartTime: 0,
        playStartOffset: 0,
        isMuted: false,
        previewVolume: 1,
        // Engines references for renderer
        timelineEngine: this.timelineEngine,
        captionEngine: this.captionEngine,
        uiToast: (msg, type, dur) => {
          var _a;
          return (_a = this.ui) == null ? void 0 : _a.showToast(msg, type, dur);
        }
      };
      this.animationFrameId = null;
    }
    /**
     * Initializes the application, restores saved settings, and binds event listeners
     */
    async init() {
      this.loadSavedSettings();
      this.bindNavigationEvents();
      this.bindStep1Events();
      this.bindStep2Events();
      this.bindStep3Events();
      this.bindPlaybackEvents();
      this.bindExportEvents();
      this.bindProjectEvents();
      this.youtubeGenerator = new YouTubeMetaGenerator(this);
      await this.youtubeGenerator.init();
      this.youtubeHelper = this.youtubeGenerator;
      if (this.storyController) {
        await this.storyController.init();
      }
      await this.voiceEngine.loadVoices(() => {
        this.populateTtsLanguagesAndVoices(true);
      });
      this.populateTtsLanguagesAndVoices(true);
      this.updateBackendVoiceStatus();
      this.updateCanvasResolution();
      this.renderCurrentPreviewFrame();
      console.log("[FrameFlow Studio] Initialized successfully.");
    }
    /**
     * Restores user preferences from localStorage
     */
    loadSavedSettings() {
      const savedCaptions = loadSetting("captionStyle", null);
      if (savedCaptions) Object.assign(this.state.captionStyle, savedCaptions);
      const savedGrading = loadSetting("colorGrading", null);
      if (savedGrading) Object.assign(this.state.colorGrading, savedGrading);
      const savedOverlays = loadSetting("overlays", null);
      if (savedOverlays) Object.assign(this.state.overlays, savedOverlays);
    }
    // =========================================================================
    // Navigation & Step Switching (4-Step Flow)
    // =========================================================================
    bindNavigationEvents() {
      var _a, _b, _c, _d, _e, _f;
      document.querySelectorAll(".step-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const step = parseInt(btn.dataset.step, 10);
          this.goToStep(step);
        });
      });
      (_a = document.getElementById("goToStep2Btn")) == null ? void 0 : _a.addEventListener("click", () => this.goToStep(2));
      (_b = document.getElementById("backToStep1Btn")) == null ? void 0 : _b.addEventListener("click", () => this.goToStep(1));
      (_c = document.getElementById("goToStep3Btn")) == null ? void 0 : _c.addEventListener("click", () => this.goToStep(3));
      (_d = document.getElementById("backToStep2Btn")) == null ? void 0 : _d.addEventListener("click", () => this.goToStep(2));
      (_e = document.getElementById("goToStep4Btn")) == null ? void 0 : _e.addEventListener("click", () => this.goToStep(4));
      (_f = document.getElementById("backToStep3Btn")) == null ? void 0 : _f.addEventListener("click", () => this.goToStep(3));
    }
    async goToStep(step) {
      var _a, _b;
      this.state.currentStep = step;
      this.ui.setStep(step);
      if (step === 2) {
        this.updateBackendVoiceStatus();
      }
      if (step === 3) {
        this.rebuildTimeline();
        this.renderCurrentPreviewFrame();
        if (this.state.voiceMode === "A" && (this.state.scriptText || "").trim() && !((_a = this.voiceEngine) == null ? void 0 : _a.audioBuffer)) {
          this.generateNeuralVoiceAction().catch(() => {
          });
        }
      }
      if (step === 4) {
        (_b = this.youtubeGenerator) == null ? void 0 : _b.updateScriptSummary();
      }
    }
    // =========================================================================
    // Step 1: Upload & Frame Extraction
    // =========================================================================
    bindStep1Events() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E, _F, _G;
      const dropzone = document.getElementById("videoDropzone");
      const fileInput = document.getElementById("videoFileInput");
      ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropzone.classList.add("dragover");
        });
      });
      ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropzone.classList.remove("dragover");
        });
      });
      dropzone.addEventListener("drop", (e) => {
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.handleSourceVideoFile(e.dataTransfer.files[0]);
        }
      });
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleSourceVideoFile(e.target.files[0]);
        }
      });
      (_a = document.getElementById("changeVideoBtn")) == null ? void 0 : _a.addEventListener("click", () => {
        fileInput.click();
      });
      (_b = document.getElementById("directPhotoUploadBtn")) == null ? void 0 : _b.addEventListener("click", () => {
        var _a2;
        (_a2 = document.getElementById("directPhotoUploadInput")) == null ? void 0 : _a2.click();
      });
      (_c = document.getElementById("createSampleVideoBtn")) == null ? void 0 : _c.addEventListener("click", () => {
        this.generateTestSampleVideo();
      });
      const minSlider = document.getElementById("photosPerMinMin");
      const maxSlider = document.getElementById("photosPerMinMax");
      const displaySpan = document.getElementById("photosPerMinDisplay");
      const minValSpan = document.getElementById("photosPerMinMinVal");
      const maxValSpan = document.getElementById("photosPerMinMaxVal");
      const updateSliderVals = () => {
        let minVal = parseInt(minSlider.value, 10);
        let maxVal = parseInt(maxSlider.value, 10);
        if (minVal > maxVal) {
          minVal = maxVal;
          minSlider.value = minVal;
        }
        displaySpan.textContent = `${minVal} \u2013 ${maxVal}`;
        minValSpan.textContent = minVal;
        maxValSpan.textContent = maxVal;
        this.updateEstimatedPhotosCount();
      };
      minSlider == null ? void 0 : minSlider.addEventListener("input", updateSliderVals);
      maxSlider == null ? void 0 : maxSlider.addEventListener("input", updateSliderVals);
      (_d = document.getElementById("startExtractionBtn")) == null ? void 0 : _d.addEventListener("click", () => {
        this.startExtractionProcess();
      });
      (_e = document.getElementById("cancelExtractionBtn")) == null ? void 0 : _e.addEventListener("click", () => {
        this.extractor.cancel();
        this.ui.showToast("Extraction cancelled.", "info");
      });
      (_f = document.getElementById("toggleSamplingSettingsBtn")) == null ? void 0 : _f.addEventListener("click", () => {
        var _a2;
        (_a2 = document.getElementById("extractionConfigCard")) == null ? void 0 : _a2.classList.toggle("hidden");
      });
      (_g = document.getElementById("openBatchSamplerBtn")) == null ? void 0 : _g.addEventListener("click", () => {
        const card = document.getElementById("extractionConfigCard");
        card == null ? void 0 : card.classList.remove("hidden");
        card == null ? void 0 : card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      this.bindExtractionResolutionEvents();
      this.bindWatermarkEvents();
      const clipperPlayBtn = document.getElementById("clipperPlayPauseBtn");
      const playIcon = document.getElementById("clipperPlayIcon");
      const pauseIcon = document.getElementById("clipperPauseIcon");
      const scrubber = document.getElementById("videoScrubberSlider");
      const speedSelect = document.getElementById("clipperPlaybackSpeedSelect");
      const framingSlider = document.getElementById("clipperFramingSlider");
      const framingVal = document.getElementById("clipperFramingVal");
      (_h = this.sourceVideo) == null ? void 0 : _h.addEventListener("click", () => {
        if (this.sourceVideo.paused) this.sourceVideo.play();
        else this.sourceVideo.pause();
      });
      clipperPlayBtn == null ? void 0 : clipperPlayBtn.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        if (this.sourceVideo.paused) this.sourceVideo.play();
        else this.sourceVideo.pause();
      });
      (_i = this.sourceVideo) == null ? void 0 : _i.addEventListener("play", () => {
        playIcon == null ? void 0 : playIcon.classList.add("hidden");
        pauseIcon == null ? void 0 : pauseIcon.classList.remove("hidden");
      });
      (_j = this.sourceVideo) == null ? void 0 : _j.addEventListener("pause", () => {
        playIcon == null ? void 0 : playIcon.classList.remove("hidden");
        pauseIcon == null ? void 0 : pauseIcon.classList.add("hidden");
      });
      (_k = this.sourceVideo) == null ? void 0 : _k.addEventListener("ended", () => {
        playIcon == null ? void 0 : playIcon.classList.remove("hidden");
        pauseIcon == null ? void 0 : pauseIcon.classList.add("hidden");
      });
      (_l = this.sourceVideo) == null ? void 0 : _l.addEventListener("timeupdate", () => {
        if (!this.state.isScrubbingClipper && scrubber) {
          scrubber.value = this.sourceVideo.currentTime;
        }
        const t = this.sourceVideo.currentTime;
        const tStr = this.ui.formatTime(t);
        const curEl = document.getElementById("videoCurrentTimeDisplay");
        if (curEl) curEl.textContent = tStr;
        const tcBadge = document.getElementById("clipperTimecodeBadge");
        if (tcBadge) tcBadge.textContent = tStr;
        const frameBadge = document.getElementById("clipperFrameNumBadge");
        if (frameBadge) frameBadge.textContent = `Frame #${Math.floor(t * 30)}`;
      });
      scrubber == null ? void 0 : scrubber.addEventListener("mousedown", () => {
        this.state.isScrubbingClipper = true;
      });
      scrubber == null ? void 0 : scrubber.addEventListener("touchstart", () => {
        this.state.isScrubbingClipper = true;
      }, { passive: true });
      scrubber == null ? void 0 : scrubber.addEventListener("input", (e) => {
        if (!this.sourceVideo) return;
        const t = parseFloat(e.target.value);
        this.sourceVideo.currentTime = t;
        const curEl = document.getElementById("videoCurrentTimeDisplay");
        if (curEl) curEl.textContent = this.ui.formatTime(t);
        const tcBadge = document.getElementById("clipperTimecodeBadge");
        if (tcBadge) tcBadge.textContent = this.ui.formatTime(t);
      });
      const finishScrub = () => {
        this.state.isScrubbingClipper = false;
      };
      scrubber == null ? void 0 : scrubber.addEventListener("mouseup", finishScrub);
      scrubber == null ? void 0 : scrubber.addEventListener("touchend", finishScrub);
      scrubber == null ? void 0 : scrubber.addEventListener("change", finishScrub);
      (_m = document.getElementById("clipperPrevFrameBtn")) == null ? void 0 : _m.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.pause();
        this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - 1 / 30);
      });
      (_n = document.getElementById("clipperNextFrameBtn")) == null ? void 0 : _n.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.pause();
        this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + 1 / 30);
      });
      (_o = document.getElementById("clipperJumpBack1Btn")) == null ? void 0 : _o.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - 1);
      });
      (_p = document.getElementById("clipperJumpForward1Btn")) == null ? void 0 : _p.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + 1);
      });
      (_q = document.getElementById("clipperJumpBack5Btn")) == null ? void 0 : _q.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - 5);
      });
      (_r = document.getElementById("clipperJumpForward5Btn")) == null ? void 0 : _r.addEventListener("click", () => {
        if (!this.sourceVideo) return;
        this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + 5);
      });
      speedSelect == null ? void 0 : speedSelect.addEventListener("change", (e) => {
        if (this.sourceVideo) this.sourceVideo.playbackRate = parseFloat(e.target.value);
      });
      document.querySelectorAll("#clipperRatioPills .aspect-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          document.querySelectorAll("#clipperRatioPills .aspect-pill").forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          const ratio = pill.dataset.ratio;
          this.setAspectRatio(ratio);
          this.updateClipperOverlay();
        });
      });
      const updateFramingOffset = (val) => {
        var _a2, _b2, _c2;
        this.state.clipperCropOffset = val / 100;
        if (framingSlider) framingSlider.value = val;
        if (framingVal) {
          if (val < 30) framingVal.textContent = `Left (${val}%)`;
          else if (val > 70) framingVal.textContent = `Right (${val}%)`;
          else framingVal.textContent = `Center (${val}%)`;
        }
        (_a2 = document.getElementById("frameAlignLeftBtn")) == null ? void 0 : _a2.classList.toggle("active", val === 0);
        (_b2 = document.getElementById("frameAlignCenterBtn")) == null ? void 0 : _b2.classList.toggle("active", val === 50);
        (_c2 = document.getElementById("frameAlignRightBtn")) == null ? void 0 : _c2.classList.toggle("active", val === 100);
        this.updateClipperOverlay();
      };
      framingSlider == null ? void 0 : framingSlider.addEventListener("input", (e) => {
        updateFramingOffset(parseInt(e.target.value, 10));
      });
      (_s = document.getElementById("frameAlignLeftBtn")) == null ? void 0 : _s.addEventListener("click", () => updateFramingOffset(0));
      (_t = document.getElementById("frameAlignCenterBtn")) == null ? void 0 : _t.addEventListener("click", () => updateFramingOffset(50));
      (_u = document.getElementById("frameAlignRightBtn")) == null ? void 0 : _u.addEventListener("click", () => updateFramingOffset(100));
      const getVideoDisplayDims = () => {
        const viewport = document.getElementById("clipperVideoViewport");
        if (!viewport || !this.sourceVideo) {
          return { actualVideoW: 1, actualVideoH: 1, videoLeft: 0, videoTop: 0 };
        }
        const dispW = viewport.clientWidth;
        const dispH = viewport.clientHeight;
        const sourceW = this.sourceVideo.videoWidth || 1920;
        const sourceH = this.sourceVideo.videoHeight || 1080;
        const videoAspect = sourceW / sourceH;
        const viewportAspect = dispW / dispH;
        let actualVideoW, actualVideoH, videoLeft, videoTop;
        if (viewportAspect > videoAspect) {
          actualVideoH = dispH;
          actualVideoW = dispH * videoAspect;
          videoLeft = (dispW - actualVideoW) / 2;
          videoTop = 0;
        } else {
          actualVideoW = dispW;
          actualVideoH = dispW / videoAspect;
          videoLeft = 0;
          videoTop = (dispH - actualVideoH) / 2;
        }
        return { actualVideoW, actualVideoH, videoLeft, videoTop };
      };
      const cropWindow = document.getElementById("cropWindow");
      let isDraggingCrop = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartOffset = 0.5;
      let dragStartCustomNorm = null;
      let isResizingCorner = false;
      let activeCorner = null;
      let resizeStartNorm = null;
      let resizeStartX = 0;
      let resizeStartY = 0;
      let resizeVideoW = 1;
      let resizeVideoH = 1;
      const onCornerResizeMove = (e) => {
        var _a2, _b2;
        if (!isResizingCorner || !resizeStartNorm) return;
        const dx = (e.clientX - resizeStartX) / resizeVideoW;
        const dy = (e.clientY - resizeStartY) / resizeVideoH;
        const minNorm = 0.08;
        let { x, y, w, h } = resizeStartNorm;
        const right = x + w;
        const bottom = y + h;
        if (activeCorner === "top-left") {
          const newX = Math.max(0, Math.min(right - minNorm, x + dx));
          const newY = Math.max(0, Math.min(bottom - minNorm, y + dy));
          x = newX;
          y = newY;
          w = right - newX;
          h = bottom - newY;
        } else if (activeCorner === "top-right") {
          const newY = Math.max(0, Math.min(bottom - minNorm, y + dy));
          y = newY;
          h = bottom - newY;
          w = Math.max(minNorm, Math.min(1 - x, w + dx));
        } else if (activeCorner === "bottom-left") {
          const newX = Math.max(0, Math.min(right - minNorm, x + dx));
          x = newX;
          w = right - newX;
          h = Math.max(minNorm, Math.min(1 - y, h + dy));
        } else if (activeCorner === "bottom-right") {
          w = Math.max(minNorm, Math.min(1 - x, w + dx));
          h = Math.max(minNorm, Math.min(1 - y, h + dy));
        }
        this.state.customNorm = { x, y, w, h };
        const sourceW = ((_a2 = this.sourceVideo) == null ? void 0 : _a2.videoWidth) || 1920;
        const sourceH = ((_b2 = this.sourceVideo) == null ? void 0 : _b2.videoHeight) || 1080;
        let expW = Math.round(w * sourceW);
        let expH = Math.round(h * sourceH);
        if (Math.max(expW, expH) > 1920) {
          const scale = 1920 / Math.max(expW, expH);
          expW = Math.round(expW * scale);
          expH = Math.round(expH * scale);
        }
        expW = expW - expW % 2;
        expH = expH - expH % 2;
        this.state.exportWidth = Math.max(128, expW);
        this.state.exportHeight = Math.max(128, expH);
        const canvasVp = document.getElementById("canvasViewport");
        if (canvasVp) {
          canvasVp.style.aspectRatio = `${this.state.exportWidth} / ${this.state.exportHeight}`;
        }
        this.updateCanvasResolution();
        this.updateClipperOverlay();
      };
      const onCornerResizeEnd = () => {
        if (!isResizingCorner) return;
        isResizingCorner = false;
        activeCorner = null;
        cropWindow == null ? void 0 : cropWindow.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onCornerResizeMove);
        window.removeEventListener("pointerup", onCornerResizeEnd);
        window.removeEventListener("pointercancel", onCornerResizeEnd);
        this.renderCurrentPreviewFrame();
      };
      document.querySelectorAll("#cropWindow .crop-corner").forEach((cornerEl) => {
        cornerEl.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (this.state.aspectRatio !== "custom") {
            this.state.customNorm = this.getNormalizedCropBounds();
            this.setAspectRatio("custom");
          } else if (!this.state.customNorm) {
            this.state.customNorm = this.getNormalizedCropBounds();
          }
          const dims = getVideoDisplayDims();
          resizeVideoW = dims.actualVideoW;
          resizeVideoH = dims.actualVideoH;
          resizeStartX = e.clientX;
          resizeStartY = e.clientY;
          resizeStartNorm = { ...this.state.customNorm };
          activeCorner = cornerEl.dataset.corner;
          isResizingCorner = true;
          cropWindow == null ? void 0 : cropWindow.classList.add("is-dragging");
          window.addEventListener("pointermove", onCornerResizeMove);
          window.addEventListener("pointerup", onCornerResizeEnd);
          window.addEventListener("pointercancel", onCornerResizeEnd);
        });
      });
      const getExcessWidth = () => {
        var _a2, _b2, _c2, _d2;
        const dims = getVideoDisplayDims();
        let targetAspect = (((_a2 = this.sourceVideo) == null ? void 0 : _a2.videoWidth) || 1920) / (((_b2 = this.sourceVideo) == null ? void 0 : _b2.videoHeight) || 1080);
        const ratio = this.state.aspectRatio || "16:9";
        if (ratio === "16:9" || ratio === "16:9-720p") targetAspect = 16 / 9;
        else if (ratio === "9:16") targetAspect = 9 / 16;
        else if (ratio === "1:1") targetAspect = 1;
        else if (ratio === "4:5") targetAspect = 4 / 5;
        const videoAspect = (((_c2 = this.sourceVideo) == null ? void 0 : _c2.videoWidth) || 1920) / (((_d2 = this.sourceVideo) == null ? void 0 : _d2.videoHeight) || 1080);
        if (videoAspect > targetAspect) {
          const cropW = dims.actualVideoH * targetAspect;
          return Math.max(0, dims.actualVideoW - cropW);
        }
        return 0;
      };
      const onCropDragMove = (e) => {
        if (!isDraggingCrop) return;
        if (this.state.aspectRatio === "custom" && dragStartCustomNorm) {
          const dims = getVideoDisplayDims();
          const dx = (e.clientX - dragStartX) / dims.actualVideoW;
          const dy = (e.clientY - dragStartY) / dims.actualVideoH;
          const maxNormX = Math.max(0, 1 - dragStartCustomNorm.w);
          const maxNormY = Math.max(0, 1 - dragStartCustomNorm.h);
          const newX = Math.max(0, Math.min(maxNormX, dragStartCustomNorm.x + dx));
          const newY = Math.max(0, Math.min(maxNormY, dragStartCustomNorm.y + dy));
          this.state.customNorm = {
            ...dragStartCustomNorm,
            x: newX,
            y: newY
          };
          this.updateClipperOverlay();
          return;
        }
        const excess = getExcessWidth();
        if (excess <= 1) return;
        const deltaX = e.clientX - dragStartX;
        const newOffset = Math.max(0, Math.min(1, dragStartOffset + deltaX / excess));
        updateFramingOffset(Math.round(newOffset * 100));
      };
      const onCropDragEnd = () => {
        if (!isDraggingCrop) return;
        isDraggingCrop = false;
        dragStartCustomNorm = null;
        cropWindow == null ? void 0 : cropWindow.classList.remove("is-dragging");
        document.querySelectorAll(".crop-mask").forEach((m) => m.classList.remove("is-dragging"));
        window.removeEventListener("pointermove", onCropDragMove);
        window.removeEventListener("pointerup", onCropDragEnd);
        window.removeEventListener("pointercancel", onCropDragEnd);
        if (this.state.aspectRatio === "custom") {
          this.renderCurrentPreviewFrame();
        }
      };
      const startCropDrag = (e) => {
        if (isResizingCorner) return;
        if (this.state.aspectRatio === "custom") {
          if (!this.state.customNorm) {
            this.state.customNorm = this.getNormalizedCropBounds();
          }
          isDraggingCrop = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartCustomNorm = { ...this.state.customNorm };
          cropWindow == null ? void 0 : cropWindow.classList.add("is-dragging");
          document.querySelectorAll(".crop-mask").forEach((m) => m.classList.add("is-dragging"));
          window.addEventListener("pointermove", onCropDragMove);
          window.addEventListener("pointerup", onCropDragEnd);
          window.addEventListener("pointercancel", onCropDragEnd);
          return;
        }
        const excess = getExcessWidth();
        if (excess <= 1) return;
        isDraggingCrop = true;
        dragStartX = e.clientX;
        dragStartOffset = this.state.clipperCropOffset !== void 0 ? this.state.clipperCropOffset : 0.5;
        cropWindow == null ? void 0 : cropWindow.classList.add("is-dragging");
        document.querySelectorAll(".crop-mask").forEach((m) => m.classList.add("is-dragging"));
        if (e.target.id === "cropMaskLeft" || e.target.id === "cropMaskRight") {
          const dims = getVideoDisplayDims();
          const viewport = document.getElementById("clipperVideoViewport");
          const rect = viewport.getBoundingClientRect();
          const clickXInVideo = e.clientX - rect.left - dims.videoLeft;
          let targetAspect = 16 / 9;
          const ratio = this.state.aspectRatio || "16:9";
          if (ratio === "9:16") targetAspect = 9 / 16;
          else if (ratio === "1:1") targetAspect = 1;
          else if (ratio === "4:5") targetAspect = 4 / 5;
          const cropW = dims.actualVideoH * targetAspect;
          const targetCropLeft = clickXInVideo - cropW / 2;
          const newOffset = Math.max(0, Math.min(1, targetCropLeft / excess));
          dragStartOffset = newOffset;
          dragStartX = e.clientX;
          updateFramingOffset(Math.round(newOffset * 100));
        }
        window.addEventListener("pointermove", onCropDragMove);
        window.addEventListener("pointerup", onCropDragEnd);
        window.addEventListener("pointercancel", onCropDragEnd);
      };
      cropWindow == null ? void 0 : cropWindow.addEventListener("pointerdown", startCropDrag);
      (_v = document.getElementById("cropMaskLeft")) == null ? void 0 : _v.addEventListener("pointerdown", startCropDrag);
      (_w = document.getElementById("cropMaskRight")) == null ? void 0 : _w.addEventListener("pointerdown", startCropDrag);
      (_x = document.getElementById("cropMaskTop")) == null ? void 0 : _x.addEventListener("pointerdown", startCropDrag);
      (_y = document.getElementById("cropMaskBottom")) == null ? void 0 : _y.addEventListener("pointerdown", startCropDrag);
      (_z = document.getElementById("clipCurrentFrameBtn")) == null ? void 0 : _z.addEventListener("click", () => {
        this.clipCurrentFrame();
      });
      (_A = document.getElementById("quickIntervalClipBtn")) == null ? void 0 : _A.addEventListener("click", () => {
        this.quickIntervalClip(5, 3);
      });
      window.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        if (e.key === "c" || e.key === "C") {
          if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
            e.preventDefault();
            this.clipCurrentFrame();
          }
        } else if (e.key === " ") {
          if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
            e.preventDefault();
            if (this.sourceVideo.paused) this.sourceVideo.play();
            else this.sourceVideo.pause();
          }
        } else if (e.key === "ArrowLeft") {
          if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
            e.preventDefault();
            this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - (e.shiftKey ? 1 : 1 / 30));
          }
        } else if (e.key === "ArrowRight") {
          if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
            e.preventDefault();
            this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + (e.shiftKey ? 1 : 1 / 30));
          }
        }
      });
      window.addEventListener("resize", () => {
        if (this.state.sourceVideoLoaded) {
          this.updateClipperOverlay();
        }
      });
      (_B = document.getElementById("filterAllFramesBtn")) == null ? void 0 : _B.addEventListener("click", (e) => {
        var _a2;
        this.state.filterStarredOnly = false;
        e.target.classList.add("active");
        (_a2 = document.getElementById("filterStarredFramesBtn")) == null ? void 0 : _a2.classList.remove("active");
        this.refreshGallery();
      });
      (_C = document.getElementById("filterStarredFramesBtn")) == null ? void 0 : _C.addEventListener("click", (e) => {
        var _a2;
        this.state.filterStarredOnly = true;
        e.target.classList.add("active");
        (_a2 = document.getElementById("filterAllFramesBtn")) == null ? void 0 : _a2.classList.remove("active");
        this.refreshGallery();
      });
      (_D = document.getElementById("starAllFramesBtn")) == null ? void 0 : _D.addEventListener("click", () => {
        this.state.extractedFrames.forEach((f) => f.starred = true);
        this.refreshGallery();
        this.ui.showToast("Starred all extracted frames.", "success");
      });
      (_E = document.getElementById("reExtractBtn")) == null ? void 0 : _E.addEventListener("click", () => {
        this.startExtractionProcess();
      });
      (_F = document.getElementById("clearFramesBtn")) == null ? void 0 : _F.addEventListener("click", () => {
        if (confirm("Clear all extracted frames?")) {
          this.clearAllExtractedFrames();
        }
      });
      (_G = document.getElementById("closeFrameModalBtn")) == null ? void 0 : _G.addEventListener("click", () => {
        var _a2;
        (_a2 = document.getElementById("framePreviewModal")) == null ? void 0 : _a2.classList.add("hidden");
      });
    }
    /**
     * Initializes the video player and framing overlay inside the Clipper Studio
     */
    initVideoClipperPlayer() {
      if (!this.sourceVideo || !this.sourceVideo.duration) return;
      const dur = this.sourceVideo.duration;
      const scrubber = document.getElementById("videoScrubberSlider");
      if (scrubber) {
        scrubber.min = 0;
        scrubber.max = dur;
        scrubber.value = 0;
      }
      const totalEl = document.getElementById("videoTotalTimeDisplay");
      if (totalEl) totalEl.textContent = this.ui.formatTime(dur);
      const curEl = document.getElementById("videoCurrentTimeDisplay");
      if (curEl) curEl.textContent = "00:00.00";
      this.updateClipperOverlay();
    }
    /**
     * Returns normalized crop bounds { x, y, w, h } in [0, 1] for current frame setting
     */
    getNormalizedCropBounds() {
      var _a, _b;
      if (this.state.customNorm) {
        return { ...this.state.customNorm };
      }
      const sourceW = ((_a = this.sourceVideo) == null ? void 0 : _a.videoWidth) || 1920;
      const sourceH = ((_b = this.sourceVideo) == null ? void 0 : _b.videoHeight) || 1080;
      const ratio = this.state.aspectRatio === "16:9-720p" ? "16:9" : this.state.aspectRatio || "16:9";
      const offset = this.state.clipperCropOffset !== void 0 ? this.state.clipperCropOffset : 0.5;
      if (this.extractor && typeof this.extractor.computeCropBounds === "function") {
        const bounds = this.extractor.computeCropBounds(sourceW, sourceH, ratio, offset, 0.5);
        return {
          x: bounds.srcX / sourceW,
          y: bounds.srcY / sourceH,
          w: bounds.cropW / sourceW,
          h: bounds.cropH / sourceH
        };
      }
      return { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    }
    /**
     * Re-computes and positions the interactive viewfinder overlay over the video player
     */
    updateClipperOverlay() {
      var _a, _b;
      const viewport = document.getElementById("clipperVideoViewport");
      const sourceW = ((_a = this.sourceVideo) == null ? void 0 : _a.videoWidth) || 1920;
      const sourceH = ((_b = this.sourceVideo) == null ? void 0 : _b.videoHeight) || 1080;
      const targetRatio = this.state.aspectRatio === "16:9-720p" ? "16:9" : this.state.aspectRatio || "16:9";
      const cropOffsetX = this.state.clipperCropOffset !== void 0 ? this.state.clipperCropOffset : 0.5;
      this.ui.updateClipperFramingOverlay(
        viewport,
        sourceW,
        sourceH,
        targetRatio,
        cropOffsetX,
        0.5,
        this.state.customNorm
      );
      const tagEl = document.getElementById("cropWindowRatioTag");
      if (tagEl) {
        const displayRatio = this.state.aspectRatio === "custom" ? "Custom" : this.state.aspectRatio;
        tagEl.textContent = `Frame: ${displayRatio} \xB7 ${this.state.exportWidth}x${this.state.exportHeight}`;
      }
    }
    /**
     * Clips a single frame from the video at current timestamp
     */
    async clipCurrentFrame() {
      var _a, _b;
      if (!this.sourceVideo || !this.state.sourceVideoLoaded) {
        this.ui.showToast("Please upload a video first!", "error");
        return;
      }
      const flash = document.getElementById("clipperFlashEffect");
      if (flash) {
        flash.classList.add("flash-active");
        setTimeout(() => flash.classList.remove("flash-active"), 120);
      }
      const applyCrop = ((_a = document.getElementById("clipperApplyCropCheck")) == null ? void 0 : _a.checked) ?? true;
      try {
        const frameItem = await this.extractor.clipCurrentFrame({
          aspectRatio: this.state.aspectRatio,
          cropOffsetX: this.state.clipperCropOffset,
          customNorm: this.state.customNorm,
          applyCrop,
          watermark: this.getWatermarkConfig(),
          targetWidth: applyCrop ? this.state.exportWidth : void 0,
          targetHeight: applyCrop ? this.state.exportHeight : void 0
        });
        this.state.extractedFrames.push(frameItem);
        this.refreshGallery();
        (_b = document.getElementById("framesGallerySection")) == null ? void 0 : _b.classList.remove("hidden");
        const timeStr = this.ui.formatTime(this.sourceVideo.currentTime);
        if (!applyCrop) {
          this.ui.showToast("Photo doesn't match frame size", "info");
        } else {
          const displayRatio = this.state.aspectRatio === "custom" ? "Custom" : this.state.aspectRatio;
          this.ui.showToast(`\u{1F4F8} Clipped frame at ${timeStr} (${displayRatio})`, "success");
        }
      } catch (err) {
        this.ui.showToast(`Failed to clip frame: ${err.message}`, "error");
      }
    }
    /**
     * Fast interval clipper: captures count frames spaced stepSec apart
     */
    async quickIntervalClip(count = 5, stepSec = 3) {
      var _a, _b;
      if (!this.sourceVideo || !this.state.sourceVideoLoaded) return;
      this.ui.showToast(`\u26A1 Clipping ${count} frames spaced ${stepSec}s apart...`, "info", 3e3);
      const startT = this.sourceVideo.currentTime;
      const dur = this.sourceVideo.duration;
      const applyCrop = ((_a = document.getElementById("clipperApplyCropCheck")) == null ? void 0 : _a.checked) ?? true;
      for (let i = 0; i < count; i++) {
        const targetT = Math.min(dur - 0.05, startT + i * stepSec);
        await this.extractor.seekVideo(targetT);
        const frameItem = await this.extractor.clipCurrentFrame({
          timestamp: targetT,
          aspectRatio: this.state.aspectRatio,
          cropOffsetX: this.state.clipperCropOffset,
          customNorm: this.state.customNorm,
          applyCrop,
          targetWidth: applyCrop ? this.state.exportWidth : void 0,
          targetHeight: applyCrop ? this.state.exportHeight : void 0
        });
        this.state.extractedFrames.push(frameItem);
      }
      this.refreshGallery();
      (_b = document.getElementById("framesGallerySection")) == null ? void 0 : _b.classList.remove("hidden");
      if (!applyCrop) {
        this.ui.showToast("Photo doesn't match frame size", "info");
      } else {
        this.ui.showToast(`\u{1F389} Captured ${count} frames!`, "success");
      }
    }
    /**
     * Loads a source video file into the muted video element
     */
    handleSourceVideoFile(file) {
      if (!file || !file.type.startsWith("video/")) {
        this.ui.showToast("Please select a valid video file (.mp4, .webm, .mov).", "error");
        return;
      }
      const fileUrl = URL.createObjectURL(file);
      this.sourceVideo.src = fileUrl;
      this.sourceVideo.muted = true;
      this.sourceVideo.onloadedmetadata = () => {
        var _a, _b, _c;
        this.state.sourceVideoLoaded = true;
        document.getElementById("videoFileName").textContent = file.name;
        document.getElementById("videoDurationBadge").textContent = `Duration: ${this.ui.formatTime(this.sourceVideo.duration)}`;
        document.getElementById("videoResolutionBadge").textContent = `Resolution: ${this.sourceVideo.videoWidth}x${this.sourceVideo.videoHeight}`;
        document.getElementById("videoSizeBadge").textContent = `Size: ${this.ui.formatBytes(file.size)}`;
        (_a = document.getElementById("videoMetaCard")) == null ? void 0 : _a.classList.remove("hidden");
        (_b = document.getElementById("videoClipperCard")) == null ? void 0 : _b.classList.remove("hidden");
        (_c = document.getElementById("videoDropzone")) == null ? void 0 : _c.classList.add("hidden");
        this.initVideoClipperPlayer();
        this.updateEstimatedPhotosCount();
        this.ui.showToast(`Loaded video (${this.ui.formatTime(this.sourceVideo.duration)})`, "success");
      };
    }
    /**
     * Generates a 1-minute test video on the fly inside the browser
     */
    async generateTestSampleVideo() {
      this.ui.showToast("Generating 1-Minute sample video with smooth motion...", "info", 4e3);
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      const fps = 30;
      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.start();
      const durationSec = 60;
      const totalFrames = durationSec * fps;
      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps;
        const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        const hue1 = t * 20 % 360;
        const hue2 = (hue1 + 120) % 360;
        grad.addColorStop(0, `hsl(${hue1}, 70%, 25%)`);
        grad.addColorStop(1, `hsl(${hue2}, 80%, 45%)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        const circleX = canvas.width / 2 + Math.cos(t * 1.5) * 350;
        const circleY = canvas.height / 2 + Math.sin(t * 1.5) * 180;
        ctx.beginPath();
        ctx.arc(circleX, circleY, 90, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 48px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`FrameFlow Test Scene \u2014 ${this.ui.formatTime(t)}`, canvas.width / 2, canvas.height / 2);
        ctx.font = "500 24px sans-serif";
        ctx.fillText(`Stratified Sampling Test &middot; Frame ${f + 1}/${totalFrames}`, canvas.width / 2, canvas.height / 2 + 60);
        if (f % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      recorder.stop();
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const testFile = new File([blob], "sample_scenery_1min.webm", { type: "video/webm" });
        this.handleSourceVideoFile(testFile);
      };
    }
    updateEstimatedPhotosCount() {
      if (!this.sourceVideo || !this.sourceVideo.duration) return;
      const minEl = document.getElementById("photosPerMinMin");
      const maxEl = document.getElementById("photosPerMinMax");
      const minVal = parseInt((minEl == null ? void 0 : minEl.value) || "15", 10);
      const maxVal = parseInt((maxEl == null ? void 0 : maxEl.value) || "20", 10);
      const avgPerMin = (minVal + maxVal) / 2;
      const durationMinutes = this.sourceVideo.duration / 60;
      const estTotal = Math.round(avgPerMin * durationMinutes);
      const estBadge = document.getElementById("estimatedPhotosCount");
      if (estBadge) {
        estBadge.textContent = `~${estTotal}`;
      }
      const displaySpan = document.getElementById("photosPerMinDisplay");
      if (displaySpan) {
        displaySpan.textContent = `${minVal} \u2013 ${maxVal} photos/min (~${estTotal} total)`;
      }
    }
    bindExtractionResolutionEvents() {
      const select = document.getElementById("extractResolutionSelect");
      const hiddenInput = document.getElementById("extractResolution");
      const resTag = document.getElementById("extractionResTag");
      const customGroup = document.getElementById("customResolutionInputs");
      const customW = document.getElementById("customExtractWidth");
      const customH = document.getElementById("customExtractHeight");
      const updateResState = () => {
        var _a, _b;
        const mode = (select == null ? void 0 : select.value) || "1080p";
        this.state.extractResolutionMode = mode;
        if (mode === "1080p") {
          customGroup == null ? void 0 : customGroup.classList.add("hidden");
          if (hiddenInput) hiddenInput.value = "1080";
          if (resTag) resTag.textContent = "1920 \xD7 1080 (1080p Full HD)";
        } else if (mode === "720p") {
          customGroup == null ? void 0 : customGroup.classList.add("hidden");
          if (hiddenInput) hiddenInput.value = "720";
          if (resTag) resTag.textContent = "1280 \xD7 720 (720p HD)";
        } else if (mode === "4k") {
          customGroup == null ? void 0 : customGroup.classList.add("hidden");
          if (hiddenInput) hiddenInput.value = "2160";
          if (resTag) resTag.textContent = "3840 \xD7 2160 (4K UHD)";
        } else if (mode === "original") {
          customGroup == null ? void 0 : customGroup.classList.add("hidden");
          if (hiddenInput) hiddenInput.value = "3840";
          const srcW = ((_a = this.sourceVideo) == null ? void 0 : _a.videoWidth) || "Native";
          const srcH = ((_b = this.sourceVideo) == null ? void 0 : _b.videoHeight) || "Native";
          if (resTag) resTag.textContent = `Match Source (${srcW} \xD7 ${srcH})`;
        } else if (mode === "custom") {
          customGroup == null ? void 0 : customGroup.classList.remove("hidden");
          const w = parseInt((customW == null ? void 0 : customW.value) || "1920", 10);
          const h = parseInt((customH == null ? void 0 : customH.value) || "1080", 10);
          this.state.customExtractWidth = w;
          this.state.customExtractHeight = h;
          if (hiddenInput) hiddenInput.value = Math.max(w, h).toString();
          if (resTag) resTag.textContent = `Custom (${w} \xD7 ${h})`;
        }
      };
      select == null ? void 0 : select.addEventListener("change", updateResState);
      const onCustomChange = () => {
        const w = parseInt((customW == null ? void 0 : customW.value) || "1920", 10);
        const h = parseInt((customH == null ? void 0 : customH.value) || "1080", 10);
        this.state.customExtractWidth = w;
        this.state.customExtractHeight = h;
        if (resTag && (select == null ? void 0 : select.value) === "custom") resTag.textContent = `Custom (${w} \xD7 ${h})`;
        if (hiddenInput) hiddenInput.value = Math.max(w, h).toString();
      };
      customW == null ? void 0 : customW.addEventListener("input", onCustomChange);
      customH == null ? void 0 : customH.addEventListener("input", onCustomChange);
      document.querySelectorAll(".res-preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const w = parseInt(btn.dataset.w || "1920", 10);
          const h = parseInt(btn.dataset.h || "1080", 10);
          if (customW) customW.value = w;
          if (customH) customH.value = h;
          onCustomChange();
        });
      });
    }
    bindWatermarkEvents() {
      const enableCheck = document.getElementById("enableWatermarkCheck");
      const panel = document.getElementById("watermarkControlsPanel");
      const badge = document.getElementById("watermarkActiveBadge");
      const tabBtns = document.querySelectorAll(".wm-tab-btn");
      const textPanel = document.getElementById("wmTextPanel");
      const imagePanel = document.getElementById("wmImagePanel");
      const presetPanel = document.getElementById("wmPresetPanel");
      const textInput = document.getElementById("watermarkTextInput");
      const styleSelect = document.getElementById("watermarkTextStyle");
      const fileInput = document.getElementById("watermarkFileInput");
      const selectStickerBtn = document.getElementById("selectStickerBtn");
      const removeStickerBtn = document.getElementById("removeStickerBtn");
      const stickerNameSpan = document.getElementById("stickerFileName");
      const stickerPreviewBox = document.getElementById("stickerThumbPreview");
      const stickerPreviewImg = document.getElementById("stickerPreviewImg");
      const posSelect = document.getElementById("watermarkPositionSelect");
      const sizeSelect = document.getElementById("watermarkSizeSelect");
      const opacitySlider = document.getElementById("watermarkOpacitySlider");
      const opacityVal = document.getElementById("watermarkOpacityVal");
      enableCheck == null ? void 0 : enableCheck.addEventListener("change", () => {
        const isEnabled = enableCheck.checked;
        this.state.watermark.enabled = isEnabled;
        if (isEnabled) {
          panel == null ? void 0 : panel.classList.remove("hidden");
          badge == null ? void 0 : badge.classList.remove("hidden");
        } else {
          panel == null ? void 0 : panel.classList.add("hidden");
          badge == null ? void 0 : badge.classList.add("hidden");
        }
        this.updateWatermarkLivePreview();
      });
      tabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          tabBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const mode = btn.dataset.wmMode;
          this.state.watermark.type = mode;
          textPanel == null ? void 0 : textPanel.classList.toggle("hidden", mode !== "text");
          imagePanel == null ? void 0 : imagePanel.classList.toggle("hidden", mode !== "image");
          presetPanel == null ? void 0 : presetPanel.classList.toggle("hidden", mode !== "preset");
          this.updateWatermarkLivePreview();
        });
      });
      textInput == null ? void 0 : textInput.addEventListener("input", () => {
        this.state.watermark.text = textInput.value;
        this.updateWatermarkLivePreview();
      });
      styleSelect == null ? void 0 : styleSelect.addEventListener("change", () => {
        this.state.watermark.style = styleSelect.value;
        this.updateWatermarkLivePreview();
      });
      selectStickerBtn == null ? void 0 : selectStickerBtn.addEventListener("click", () => fileInput == null ? void 0 : fileInput.click());
      fileInput == null ? void 0 : fileInput.addEventListener("change", (e) => {
        var _a;
        const file = (_a = e.target.files) == null ? void 0 : _a[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          const img = new Image();
          img.onload = () => {
            var _a2;
            this.state.watermark.imageElement = img;
            if (stickerPreviewImg) stickerPreviewImg.src = dataUrl;
            stickerPreviewBox == null ? void 0 : stickerPreviewBox.classList.remove("hidden");
            if (stickerNameSpan) stickerNameSpan.textContent = file.name;
            this.updateWatermarkLivePreview();
            (_a2 = this.ui) == null ? void 0 : _a2.showToast("Sticker logo uploaded!", "success");
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
      removeStickerBtn == null ? void 0 : removeStickerBtn.addEventListener("click", () => {
        this.state.watermark.imageElement = null;
        if (fileInput) fileInput.value = "";
        if (stickerPreviewImg) stickerPreviewImg.src = "";
        stickerPreviewBox == null ? void 0 : stickerPreviewBox.classList.add("hidden");
        if (stickerNameSpan) stickerNameSpan.textContent = "No file chosen";
        this.updateWatermarkLivePreview();
      });
      document.querySelectorAll(".preset-badge-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".preset-badge-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const presetText = btn.dataset.preset;
          this.state.watermark.text = presetText;
          this.updateWatermarkLivePreview();
        });
      });
      posSelect == null ? void 0 : posSelect.addEventListener("change", () => {
        this.state.watermark.position = posSelect.value;
        if (posSelect.value !== "custom") {
          this.state.watermark.customNorm = null;
        }
        this.updateWatermarkLivePreview();
      });
      sizeSelect == null ? void 0 : sizeSelect.addEventListener("change", () => {
        this.state.watermark.size = sizeSelect.value;
        this.updateWatermarkLivePreview();
      });
      opacitySlider == null ? void 0 : opacitySlider.addEventListener("input", () => {
        const val = parseInt(opacitySlider.value, 10);
        if (opacityVal) opacityVal.textContent = `${val}%`;
        this.state.watermark.opacity = val / 100;
        this.updateWatermarkLivePreview();
      });
      const draggableWatermark = document.getElementById("draggableCropWatermark");
      let isDraggingSticker = false;
      let stickerStartX = 0;
      let stickerStartY = 0;
      let stickerStartLeft = 0;
      let stickerStartTop = 0;
      const onStickerPointerMove = (e) => {
        if (!isDraggingSticker || !draggableWatermark) return;
        const cropWindow = document.getElementById("cropWindow");
        if (!cropWindow) return;
        const cropRect = cropWindow.getBoundingClientRect();
        const dx = e.clientX - stickerStartX;
        const dy = e.clientY - stickerStartY;
        const maxLeft = Math.max(0, cropRect.width - draggableWatermark.offsetWidth);
        const maxTop = Math.max(0, cropRect.height - draggableWatermark.offsetHeight);
        const newLeft = Math.max(0, Math.min(maxLeft, stickerStartLeft + dx));
        const newTop = Math.max(0, Math.min(maxTop, stickerStartTop + dy));
        draggableWatermark.style.left = `${newLeft}px`;
        draggableWatermark.style.top = `${newTop}px`;
        draggableWatermark.style.right = "auto";
        draggableWatermark.style.bottom = "auto";
        const relX = cropRect.width > 0 ? newLeft / cropRect.width : 0;
        const relY = cropRect.height > 0 ? newTop / cropRect.height : 0;
        this.state.watermark.customNorm = { relX, relY };
        this.state.watermark.position = "custom";
        if (posSelect) {
          posSelect.value = "custom";
        }
      };
      const onStickerPointerUp = () => {
        if (!isDraggingSticker) return;
        isDraggingSticker = false;
        draggableWatermark == null ? void 0 : draggableWatermark.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onStickerPointerMove);
        window.removeEventListener("pointerup", onStickerPointerUp);
        window.removeEventListener("pointercancel", onStickerPointerUp);
      };
      draggableWatermark == null ? void 0 : draggableWatermark.addEventListener("pointerdown", (e) => {
        var _a;
        e.stopPropagation();
        e.preventDefault();
        isDraggingSticker = true;
        stickerStartX = e.clientX;
        stickerStartY = e.clientY;
        const parentRect = ((_a = document.getElementById("cropWindow")) == null ? void 0 : _a.getBoundingClientRect()) || { left: 0, top: 0 };
        const elRect = draggableWatermark.getBoundingClientRect();
        stickerStartLeft = elRect.left - parentRect.left;
        stickerStartTop = elRect.top - parentRect.top;
        draggableWatermark.classList.add("is-dragging");
        window.addEventListener("pointermove", onStickerPointerMove);
        window.addEventListener("pointerup", onStickerPointerUp);
        window.addEventListener("pointercancel", onStickerPointerUp);
      });
      this.updateWatermarkLivePreview();
    }
    updateWatermarkLivePreview() {
      var _a, _b;
      const box2 = document.getElementById("wmLivePreviewBox");
      const tag = document.getElementById("wmLivePreviewText");
      const draggableCropWm = document.getElementById("draggableCropWatermark");
      const cropWmContent = document.getElementById("cropWatermarkContent");
      const wm = this.state.watermark;
      if (box2 && tag) {
        const opacity = wm.opacity || 0.85;
        tag.style.opacity = opacity.toString();
        if (wm.position === "bottom-left" || wm.position === "top-left") {
          box2.style.justifyContent = "flex-start";
        } else if (wm.position === "center") {
          box2.style.justifyContent = "center";
        } else {
          box2.style.justifyContent = "flex-end";
        }
        if (wm.type === "image" && wm.imageElement) {
          tag.innerHTML = `<img src="${wm.imageElement.src}" style="height: 22px; vertical-align: middle; max-width: 60px; object-fit: contain;">`;
          tag.style.background = "transparent";
          tag.style.border = "none";
        } else {
          const displayTxt = (wm.text || "@StoryFlow").trim();
          tag.textContent = displayTxt;
          if (wm.style === "gold-pill") {
            tag.style.background = "rgba(46, 32, 22, 0.9)";
            tag.style.border = "1px solid #f5d97a";
            tag.style.color = "#f5d97a";
          } else if (wm.style === "red-box") {
            tag.style.background = "rgba(214, 40, 40, 0.92)";
            tag.style.border = "1px solid rgba(255, 255, 255, 0.6)";
            tag.style.color = "#ffffff";
          } else if (wm.style === "clean-text") {
            tag.style.background = "transparent";
            tag.style.border = "none";
            tag.style.color = "#ffffff";
          } else {
            tag.style.background = "rgba(15, 10, 8, 0.85)";
            tag.style.border = "1px solid rgba(255, 255, 255, 0.25)";
            tag.style.color = "#ffffff";
          }
        }
      }
      if (draggableCropWm && cropWmContent) {
        if (!wm.enabled) {
          draggableCropWm.classList.add("hidden");
        } else {
          draggableCropWm.classList.remove("hidden");
          draggableCropWm.style.opacity = (wm.opacity || 0.85).toString();
          if (wm.type === "image" && wm.imageElement) {
            cropWmContent.innerHTML = `<img src="${wm.imageElement.src}" style="height: 28px; max-width: 80px; object-fit: contain; pointer-events: none;">`;
            cropWmContent.style.background = "transparent";
            cropWmContent.style.border = "none";
            cropWmContent.style.boxShadow = "none";
          } else {
            cropWmContent.textContent = (wm.text || "@StoryFlow").trim();
            if (wm.style === "gold-pill") {
              cropWmContent.style.background = "rgba(46, 32, 22, 0.9)";
              cropWmContent.style.border = "1px solid #f5d97a";
              cropWmContent.style.color = "#f5d97a";
            } else if (wm.style === "red-box") {
              cropWmContent.style.background = "rgba(214, 40, 40, 0.92)";
              cropWmContent.style.border = "1px solid rgba(255, 255, 255, 0.6)";
              cropWmContent.style.color = "#ffffff";
            } else if (wm.style === "clean-text") {
              cropWmContent.style.background = "transparent";
              cropWmContent.style.border = "none";
              cropWmContent.style.color = "#ffffff";
            } else {
              cropWmContent.style.background = "rgba(15, 10, 8, 0.85)";
              cropWmContent.style.border = "1px solid rgba(255, 255, 255, 0.25)";
              cropWmContent.style.color = "#ffffff";
            }
          }
          if (wm.position === "custom" && wm.customNorm) {
            const cropW = ((_a = document.getElementById("cropWindow")) == null ? void 0 : _a.clientWidth) || 100;
            const cropH = ((_b = document.getElementById("cropWindow")) == null ? void 0 : _b.clientHeight) || 100;
            draggableCropWm.style.left = `${Math.round(wm.customNorm.relX * cropW)}px`;
            draggableCropWm.style.top = `${Math.round(wm.customNorm.relY * cropH)}px`;
            draggableCropWm.style.right = "auto";
            draggableCropWm.style.bottom = "auto";
          } else if (wm.position === "bottom-left") {
            draggableCropWm.style.left = "12px";
            draggableCropWm.style.bottom = "12px";
            draggableCropWm.style.right = "auto";
            draggableCropWm.style.top = "auto";
          } else if (wm.position === "top-right") {
            draggableCropWm.style.right = "12px";
            draggableCropWm.style.top = "12px";
            draggableCropWm.style.left = "auto";
            draggableCropWm.style.bottom = "auto";
          } else if (wm.position === "top-left") {
            draggableCropWm.style.left = "12px";
            draggableCropWm.style.top = "12px";
            draggableCropWm.style.right = "auto";
            draggableCropWm.style.bottom = "auto";
          } else if (wm.position === "center") {
            draggableCropWm.style.left = "50%";
            draggableCropWm.style.top = "50%";
            draggableCropWm.style.transform = "translate(-50%, -50%)";
            draggableCropWm.style.right = "auto";
            draggableCropWm.style.bottom = "auto";
          } else {
            draggableCropWm.style.right = "12px";
            draggableCropWm.style.bottom = "12px";
            draggableCropWm.style.left = "auto";
            draggableCropWm.style.top = "auto";
          }
        }
      }
    }
    getWatermarkConfig() {
      return { ...this.state.watermark };
    }
    async startExtractionProcess() {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      if (!this.state.sourceVideoLoaded) return;
      const minPhotos = parseInt(((_a = document.getElementById("photosPerMinMin")) == null ? void 0 : _a.value) || "15", 10);
      const maxPhotos = parseInt(((_b = document.getElementById("photosPerMinMax")) == null ? void 0 : _b.value) || "20", 10);
      const filterBlackWhite = ((_c = document.getElementById("filterBlackWhite")) == null ? void 0 : _c.checked) ?? false;
      const filterDuplicates = ((_d = document.getElementById("filterDuplicates")) == null ? void 0 : _d.checked) ?? true;
      const maxResolution = parseInt(((_e = document.getElementById("extractResolution")) == null ? void 0 : _e.value) || "1080", 10);
      const progressPanel = document.getElementById("extractionProgressPanel");
      const progressBar = document.getElementById("extractionProgressBar");
      const percentDisplay = document.getElementById("extractProgressPercent");
      const framesCountDisplay = document.getElementById("extractFramesCount");
      const currentMinDisplay = document.getElementById("extractCurrentMinute");
      const etaDisplay = document.getElementById("extractEta");
      const startBtn = document.getElementById("startExtractionBtn");
      const originalBtnText = startBtn ? startBtn.textContent : "";
      progressPanel == null ? void 0 : progressPanel.classList.remove("hidden");
      const applyCrop = ((_f = document.getElementById("clipperApplyCropCheck")) == null ? void 0 : _f.checked) ?? true;
      try {
        if (startBtn) startBtn.textContent = "Extracting (0%)...";
        const frames = await this.extractor.extractFrames(
          {
            minPhotos,
            maxPhotos,
            filterBlackWhite,
            filterDuplicates,
            maxResolution,
            aspectRatio: this.state.aspectRatio,
            applyCrop,
            cropOffsetX: this.state.clipperCropOffset,
            customNorm: this.state.customNorm,
            resolutionMode: this.state.extractResolutionMode || "1080p",
            customWidth: this.state.customExtractWidth || 1920,
            customHeight: this.state.customExtractHeight || 1080,
            watermark: this.getWatermarkConfig(),
            targetWidth: applyCrop ? this.state.exportWidth : void 0,
            targetHeight: applyCrop ? this.state.exportHeight : void 0
          },
          (prog) => {
            if (progressBar) progressBar.style.width = `${prog.percent}%`;
            if (percentDisplay) percentDisplay.textContent = `${prog.percent}%`;
            if (framesCountDisplay) framesCountDisplay.textContent = `${prog.keptCount} photos kept`;
            if (currentMinDisplay) currentMinDisplay.textContent = `Min ${prog.currentMinute} / ${prog.totalMinutes}`;
            if (etaDisplay) etaDisplay.textContent = `${prog.etaSeconds}s remaining`;
            if (startBtn) startBtn.textContent = `Extracting (${prog.percent}%)...`;
          }
        );
        this.state.extractedFrames = frames;
        progressPanel == null ? void 0 : progressPanel.classList.add("hidden");
        if (startBtn && originalBtnText) startBtn.textContent = originalBtnText;
        (_g = document.getElementById("framesGallerySection")) == null ? void 0 : _g.classList.remove("hidden");
        this.refreshGallery();
        (_h = this.storyController) == null ? void 0 : _h.markDirtyAndSave();
        if (this.extractor.cancelRequested) {
          this.ui.showToast(`Extraction cancelled. Kept ${frames.length} photos.`, "info");
        } else {
          this.ui.showToast(`Extracted ${frames.length} photos successfully!`, "success");
        }
      } catch (err) {
        progressPanel == null ? void 0 : progressPanel.classList.add("hidden");
        if (startBtn && originalBtnText) startBtn.textContent = originalBtnText;
        this.ui.showToast(`Extraction stopped: ${err.message}`, "error");
      }
    }
    refreshGallery() {
      this.ui.renderFramesGrid(
        this.state.extractedFrames,
        {
          onToggleStar: (id) => {
            const frame = this.state.extractedFrames.find((f) => f.id === id);
            if (frame) {
              frame.starred = !frame.starred;
              this.refreshGallery();
            }
          },
          onDeleteFrame: (id) => {
            const frameIdx = this.state.extractedFrames.findIndex((f) => f.id === id);
            if (frameIdx !== -1) {
              const [removed] = this.state.extractedFrames.splice(frameIdx, 1);
              if (removed && removed.previewUrl && typeof removed.previewUrl === "string" && removed.previewUrl.startsWith("blob:")) {
                try {
                  URL.revokeObjectURL(removed.previewUrl);
                } catch (e) {
                }
              }
              this.refreshGallery();
            }
          },
          onPreviewFrame: (frame) => {
            const modal = document.getElementById("framePreviewModal");
            const img = document.getElementById("modalPreviewImg");
            const meta = document.getElementById("modalMetaRow");
            if (modal && img) {
              img.src = frame.previewUrl || frame.dataUrl || "";
              meta.textContent = `Timestamp: ${this.ui.formatTime(frame.timestamp || 0)} \xB7 Resolution: ${frame.width || 1280}x${frame.height || 720}`;
              modal.classList.remove("hidden");
            }
          },
          onRecropFrame: (frame) => {
            this.openRecropModal(frame);
          }
        },
        this.state.filterStarredOnly
      );
    }
    /**
     * Opens the Re-Crop Modal to allow interactive re-framing of any photo
     */
    openRecropModal(frame) {
      this.activeRecropFrame = frame;
      const modal = document.getElementById("recropFrameModal");
      const canvas = document.getElementById("recropPreviewCanvas");
      const slider = document.getElementById("modalFramingSlider");
      const valSpan = document.getElementById("modalFramingVal");
      if (!modal || !canvas) return;
      const initialVal = Math.round((frame.cropOffsetX ?? 0.5) * 100);
      if (slider) slider.value = initialVal;
      if (valSpan) valSpan.textContent = `${initialVal}%`;
      const renderPreview = async () => {
        const bmp = await this.extractor.getBitmap(frame);
        if (!bmp) return;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const ratio = frame.aspectRatio || this.state.aspectRatio || "16:9";
        const offset = (slider ? parseFloat(slider.value) : 50) / 100;
        const bounds = this.extractor.computeCropBounds(bmp.width, bmp.height, ratio, offset);
        ctx.globalAlpha = 0.3;
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
        const scale = Math.min(canvas.width * 0.9 / bounds.cropW, canvas.height * 0.9 / bounds.cropH);
        const destW = bounds.cropW * scale;
        const destH = bounds.cropH * scale;
        const destX = (canvas.width - destW) / 2;
        const destY = (canvas.height - destH) / 2;
        ctx.save();
        ctx.strokeStyle = "#6366f1";
        ctx.lineWidth = 3;
        ctx.strokeRect(destX, destY, destW, destH);
        ctx.drawImage(bmp, bounds.srcX, bounds.srcY, bounds.cropW, bounds.cropH, destX, destY, destW, destH);
        ctx.restore();
      };
      if (slider) {
        slider.oninput = () => {
          if (valSpan) valSpan.textContent = `${slider.value}%`;
          renderPreview();
        };
      }
      let isModalDragging = false;
      let modalStartX = 0;
      let modalStartVal = 50;
      canvas.style.cursor = "grab";
      canvas.onpointerdown = (e) => {
        isModalDragging = true;
        modalStartX = e.clientX;
        modalStartVal = slider ? parseFloat(slider.value) : 50;
        canvas.style.cursor = "grabbing";
        canvas.setPointerCapture(e.pointerId);
      };
      canvas.onpointermove = (e) => {
        if (!isModalDragging) return;
        const deltaX = e.clientX - modalStartX;
        const sensitivity = 0.35;
        const newVal = Math.max(0, Math.min(100, Math.round(modalStartVal + deltaX * sensitivity)));
        if (slider) slider.value = newVal;
        if (valSpan) valSpan.textContent = `${newVal}%`;
        renderPreview();
      };
      const stopModalDrag = (e) => {
        if (isModalDragging) {
          isModalDragging = false;
          canvas.style.cursor = "grab";
          try {
            canvas.releasePointerCapture(e.pointerId);
          } catch (_) {
          }
        }
      };
      canvas.onpointerup = stopModalDrag;
      canvas.onpointercancel = stopModalDrag;
      const leftBtn = document.getElementById("modalAlignLeftBtn");
      const centerBtn = document.getElementById("modalAlignCenterBtn");
      const rightBtn = document.getElementById("modalAlignRightBtn");
      if (leftBtn) leftBtn.onclick = () => {
        if (slider) slider.value = 0;
        if (valSpan) valSpan.textContent = "0%";
        renderPreview();
      };
      if (centerBtn) centerBtn.onclick = () => {
        if (slider) slider.value = 50;
        if (valSpan) valSpan.textContent = "50%";
        renderPreview();
      };
      if (rightBtn) rightBtn.onclick = () => {
        if (slider) slider.value = 100;
        if (valSpan) valSpan.textContent = "100%";
        renderPreview();
      };
      const saveBtn = document.getElementById("saveRecropBtn");
      if (saveBtn) {
        saveBtn.onclick = async () => {
          frame.cropOffsetX = (slider ? parseFloat(slider.value) : 50) / 100;
          if (this.sourceVideo && this.state.sourceVideoLoaded) {
            try {
              const reCropRatio = frame.aspectRatio || this.state.aspectRatio;
              const reFrame = await this.extractor.clipCurrentFrame({
                timestamp: frame.timestamp,
                aspectRatio: reCropRatio,
                cropOffsetX: frame.cropOffsetX,
                customNorm: frame.customNorm || this.state.customNorm,
                applyCrop: frame.isCropped !== false,
                targetWidth: frame.isCropped !== false && reCropRatio === this.state.aspectRatio ? this.state.exportWidth : void 0,
                targetHeight: frame.isCropped !== false && reCropRatio === this.state.aspectRatio ? this.state.exportHeight : void 0
              });
              if (frame.previewUrl) this.extractor.revokeBlobUrl(frame.previewUrl);
              frame.blob = reFrame.blob;
              frame.previewUrl = reFrame.previewUrl;
              frame.width = reFrame.width;
              frame.height = reFrame.height;
            } catch (e) {
              console.warn("Re-crop capture error:", e);
            }
          }
          this.refreshGallery();
          modal.classList.add("hidden");
          this.ui.showToast("Framing changes saved.", "success");
        };
      }
      const cancelBtn = document.getElementById("cancelRecropBtn");
      if (cancelBtn) cancelBtn.onclick = () => {
        modal.classList.add("hidden");
      };
      const closeBtn = document.getElementById("closeRecropModalBtn");
      if (closeBtn) closeBtn.onclick = () => {
        modal.classList.add("hidden");
      };
      modal.classList.remove("hidden");
      renderPreview();
    }
    clearAllExtractedFrames() {
      var _a, _b;
      this.state.extractedFrames.forEach((f) => {
        if (f.previewUrl && typeof f.previewUrl === "string" && f.previewUrl.startsWith("blob:")) {
          this.extractor.revokeBlobUrl(f.previewUrl);
        }
      });
      this.state.extractedFrames = [];
      this.extractor.clearCache();
      this.refreshGallery();
      (_a = document.getElementById("framesGallerySection")) == null ? void 0 : _a.classList.remove("hidden");
      (_b = this.storyController) == null ? void 0 : _b.markDirtyAndSave();
    }
    // =========================================================================
    // Step 2: Script & Voice-Over
    // =========================================================================
    bindStep2Events() {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      const scriptTextarea = document.getElementById("scriptTextarea");
      scriptTextarea.addEventListener("input", () => {
        this.handleScriptChange(scriptTextarea.value);
      });
      (_a = document.getElementById("loadSampleScriptBtn")) == null ? void 0 : _a.addEventListener("click", () => {
        const hindiSample = `\u092A\u094D\u0930\u0915\u0943\u0924\u093F \u0915\u0940 \u0938\u0941\u0902\u0926\u0930\u0924\u093E \u0939\u092E\u0947\u0902 \u0936\u093E\u0902\u0924\u093F \u0914\u0930 \u0928\u0908 \u090A\u0930\u094D\u091C\u093E \u0926\u0947\u0924\u0940 \u0939\u0948\u0964
The sound of gentle breeze and flowing streams calms our mind.
\u0939\u0930 \u0928\u092F\u093E \u0926\u093F\u0928 \u090F\u0915 \u0928\u0908 \u0936\u0941\u0930\u0941\u0906\u0924 \u0914\u0930 \u0928\u0908 \u0909\u092E\u094D\u092E\u0940\u0926 \u0932\u0947\u0915\u0930 \u0906\u0924\u093E \u0939\u0948\u0964
Life moves forward with small, beautiful moments that stay with us forever.
\u0905\u092A\u0928\u0947 \u0938\u092A\u0928\u094B\u0902 \u092A\u0930 \u0935\u093F\u0936\u094D\u0935\u093E\u0938 \u0930\u0916\u0947\u0902 \u0914\u0930 \u0928\u093F\u0930\u0902\u0924\u0930 \u0906\u0917\u0947 \u092C\u0922\u093C\u0924\u0947 \u0930\u0939\u0947\u0902\u0964`;
        scriptTextarea.value = hindiSample;
        this.handleScriptChange(hindiSample);
        this.ui.showToast("Loaded sample Hindi + English script.", "success");
      });
      (_b = document.getElementById("realignCaptionsBtn")) == null ? void 0 : _b.addEventListener("click", () => {
        this.realignCaptionsWithCurrentVoice();
        this.ui.showToast("Captions realigned with audio timing.", "success");
      });
      const btnB = document.getElementById("voiceModeBtnB") || document.getElementById("tabModeB");
      const btnA = document.getElementById("voiceModeBtnA") || document.getElementById("tabModeA");
      btnB == null ? void 0 : btnB.addEventListener("click", () => {
        this.setVoiceMode("B");
      });
      btnA == null ? void 0 : btnA.addEventListener("click", () => {
        this.setVoiceMode("A");
      });
      (_c = document.getElementById("subTabUpload")) == null ? void 0 : _c.addEventListener("click", (e) => {
        var _a2, _b2, _c2;
        e.target.classList.add("active");
        (_a2 = document.getElementById("subTabRecord")) == null ? void 0 : _a2.classList.remove("active");
        (_b2 = document.getElementById("audioUploadArea")) == null ? void 0 : _b2.classList.remove("hidden");
        (_c2 = document.getElementById("audioRecordArea")) == null ? void 0 : _c2.classList.add("hidden");
      });
      (_d = document.getElementById("subTabRecord")) == null ? void 0 : _d.addEventListener("click", (e) => {
        var _a2, _b2, _c2;
        e.target.classList.add("active");
        (_a2 = document.getElementById("subTabUpload")) == null ? void 0 : _a2.classList.remove("active");
        (_b2 = document.getElementById("audioRecordArea")) == null ? void 0 : _b2.classList.remove("hidden");
        (_c2 = document.getElementById("audioUploadArea")) == null ? void 0 : _c2.classList.add("hidden");
      });
      const audioFileInput = document.getElementById("audioFileInput");
      const audioDropzone = document.getElementById("audioDropzone");
      audioDropzone == null ? void 0 : audioDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        audioDropzone.style.borderColor = "var(--accent-primary)";
      });
      audioDropzone == null ? void 0 : audioDropzone.addEventListener("dragleave", () => {
        audioDropzone.style.borderColor = "rgba(255, 255, 255, 0.12)";
      });
      audioDropzone == null ? void 0 : audioDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        audioDropzone.style.borderColor = "rgba(255, 255, 255, 0.12)";
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.handleAudioFile(e.dataTransfer.files[0]);
        }
      });
      audioFileInput == null ? void 0 : audioFileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleAudioFile(e.target.files[0]);
        }
      });
      const recordVoiceBtn = document.getElementById("recordVoiceBtn") || document.getElementById("startRecordBtn");
      const stopRecordBtn = document.getElementById("stopRecordBtn");
      recordVoiceBtn == null ? void 0 : recordVoiceBtn.addEventListener("click", async () => {
        try {
          await this.voiceEngine.startRecording(null, null, (sec) => {
            if (recordVoiceBtn) recordVoiceBtn.textContent = `\u{1F534} Recording (${this.ui.formatTime(sec)})...`;
          });
          recordVoiceBtn.classList.add("hidden");
          stopRecordBtn == null ? void 0 : stopRecordBtn.classList.remove("hidden");
          this.ui.showToast("Microphone recording started. Speak now!", "info");
        } catch (err) {
          this.ui.showToast(`Microphone access error: ${err.message}`, "error");
        }
      });
      stopRecordBtn == null ? void 0 : stopRecordBtn.addEventListener("click", async () => {
        try {
          const buffer = await this.voiceEngine.stopRecording();
          recordVoiceBtn == null ? void 0 : recordVoiceBtn.classList.remove("hidden");
          if (recordVoiceBtn) recordVoiceBtn.textContent = "\u{1F534} Record Microphone";
          stopRecordBtn == null ? void 0 : stopRecordBtn.classList.add("hidden");
          this.onVoiceLoaded(buffer, "recorded_voice.wav");
          this.ui.showToast("Voice recording saved successfully!", "success");
        } catch (err) {
          this.ui.showToast(`Failed to save recording: ${err.message}`, "error");
        }
      });
      const playAudioBtn = document.getElementById("playAudioPreviewBtn");
      const stopAudioBtn = document.getElementById("stopAudioPreviewBtn");
      playAudioBtn == null ? void 0 : playAudioBtn.addEventListener("click", () => {
        if (this.voiceEngine.isAudioPlaying) {
          this.voiceEngine.stopPreview();
          playAudioBtn.textContent = "\u25B6 Play Voice";
          stopAudioBtn == null ? void 0 : stopAudioBtn.classList.add("hidden");
        } else {
          playAudioBtn.textContent = "\u23F8 Pause";
          stopAudioBtn == null ? void 0 : stopAudioBtn.classList.remove("hidden");
          this.voiceEngine.playPreview(0, () => {
            playAudioBtn.textContent = "\u25B6 Play Voice";
            stopAudioBtn == null ? void 0 : stopAudioBtn.classList.add("hidden");
          });
        }
      });
      stopAudioBtn == null ? void 0 : stopAudioBtn.addEventListener("click", () => {
        this.voiceEngine.stopPreview();
        if (playAudioBtn) playAudioBtn.textContent = "\u25B6 Play Voice";
        stopAudioBtn == null ? void 0 : stopAudioBtn.classList.add("hidden");
      });
      const playTtsBtn = document.getElementById("playTtsPreviewAudioBtn");
      const stopTtsBtn = document.getElementById("stopTtsPreviewAudioBtn");
      playTtsBtn == null ? void 0 : playTtsBtn.addEventListener("click", () => {
        if (this.voiceEngine.isAudioPlaying) {
          this.voiceEngine.stopPreview();
          playTtsBtn.textContent = "\u25B6 Play Voice";
          stopTtsBtn == null ? void 0 : stopTtsBtn.classList.add("hidden");
        } else {
          playTtsBtn.textContent = "\u23F8 Pause";
          stopTtsBtn == null ? void 0 : stopTtsBtn.classList.remove("hidden");
          this.voiceEngine.playPreview(0, () => {
            playTtsBtn.textContent = "\u25B6 Play Voice";
            stopTtsBtn == null ? void 0 : stopTtsBtn.classList.add("hidden");
          });
        }
      });
      stopTtsBtn == null ? void 0 : stopTtsBtn.addEventListener("click", () => {
        this.voiceEngine.stopPreview();
        if (playTtsBtn) playTtsBtn.textContent = "\u25B6 Play Voice";
        stopTtsBtn == null ? void 0 : stopTtsBtn.classList.add("hidden");
      });
      (_e = document.getElementById("reRecordBtn")) == null ? void 0 : _e.addEventListener("click", () => {
        var _a2, _b2;
        this.voiceEngine.stopPreview();
        (_a2 = document.getElementById("audioPlayerPanel")) == null ? void 0 : _a2.classList.add("hidden");
        (_b2 = document.getElementById("subTabUpload")) == null ? void 0 : _b2.click();
      });
      (_f = document.getElementById("toggleAbTestBtn")) == null ? void 0 : _f.addEventListener("click", (e) => {
        this.voiceEngine.settings.abCleanedActive = !this.voiceEngine.settings.abCleanedActive;
        const on = this.voiceEngine.settings.abCleanedActive;
        e.target.textContent = on ? "\u{1F50A} Test: Cleaned (ON)" : "\u{1F507} Test: Raw Audio (OFF)";
        this.ui.showToast(on ? "Audio DSP clean-up active" : "Audio DSP bypassed (Raw)", "info");
      });
      (_g = document.getElementById("enableNoiseReduction")) == null ? void 0 : _g.addEventListener("change", (e) => {
        this.voiceEngine.settings.reduceNoise = e.target.checked;
      });
      (_h = document.getElementById("enableNormalize")) == null ? void 0 : _h.addEventListener("change", (e) => {
        this.voiceEngine.settings.normalize = e.target.checked;
      });
      const lowSlider = document.getElementById("eqLowSlider");
      const midSlider = document.getElementById("eqMidSlider");
      const highSlider = document.getElementById("eqHighSlider");
      const volSlider = document.getElementById("voiceVolumeSlider");
      lowSlider == null ? void 0 : lowSlider.addEventListener("input", (e) => {
        this.voiceEngine.settings.eqLow = parseFloat(e.target.value);
        document.getElementById("eqLowVal").textContent = `${e.target.value} dB`;
      });
      midSlider == null ? void 0 : midSlider.addEventListener("input", (e) => {
        this.voiceEngine.settings.eqMid = parseFloat(e.target.value);
        document.getElementById("eqMidVal").textContent = `${e.target.value} dB`;
      });
      highSlider == null ? void 0 : highSlider.addEventListener("input", (e) => {
        this.voiceEngine.settings.eqHigh = parseFloat(e.target.value);
        document.getElementById("eqHighVal").textContent = `${e.target.value} dB`;
      });
      volSlider == null ? void 0 : volSlider.addEventListener("input", (e) => {
        this.voiceEngine.settings.masterGain = parseFloat(e.target.value) / 100;
        document.getElementById("voiceVolumeVal").textContent = `${e.target.value}%`;
      });
      this.bindTtsEvents();
    }
    setVoiceMode(mode, skipRealign = false) {
      this.state.voiceMode = mode;
      const tabB = document.getElementById("voiceModeBtnB") || document.getElementById("tabModeB");
      const tabA = document.getElementById("voiceModeBtnA") || document.getElementById("tabModeA");
      const contB = document.getElementById("voiceModeCardB") || document.getElementById("modeBContainer");
      const contA = document.getElementById("voiceModeCardA") || document.getElementById("modeAContainer");
      const exp1 = document.getElementById("exportMode1Block");
      const exp2 = document.getElementById("exportMode2Block");
      if (mode === "B") {
        tabB == null ? void 0 : tabB.classList.add("active");
        tabA == null ? void 0 : tabA.classList.remove("active");
        contB == null ? void 0 : contB.classList.remove("hidden");
        contB == null ? void 0 : contB.classList.add("active");
        contA == null ? void 0 : contA.classList.add("hidden");
        contA == null ? void 0 : contA.classList.remove("active");
        exp1 == null ? void 0 : exp1.classList.remove("hidden");
        exp2 == null ? void 0 : exp2.classList.add("hidden");
        if (!skipRealign) this.realignCaptionsWithCurrentVoice();
      } else {
        tabA == null ? void 0 : tabA.classList.add("active");
        tabB == null ? void 0 : tabB.classList.remove("active");
        contA == null ? void 0 : contA.classList.remove("hidden");
        contA == null ? void 0 : contA.classList.add("active");
        contB == null ? void 0 : contB.classList.add("hidden");
        contB == null ? void 0 : contB.classList.remove("active");
        exp2 == null ? void 0 : exp2.classList.remove("hidden");
        exp1 == null ? void 0 : exp1.classList.add("hidden");
        this.updateBackendVoiceStatus();
        this.recalculateTtsTimelineDuration();
        if (!skipRealign) this.realignCaptionsWithCurrentVoice();
      }
    }
    /**
     * Reads current rate, pitch, volume and voice as single source of truth
     */
    getTtsOptions() {
      const rateSlider = document.getElementById("ttsRateSlider");
      const pitchSlider = document.getElementById("ttsPitchSlider");
      const volSlider = document.getElementById("ttsVolumeSlider");
      const voiceSelect = document.getElementById("ttsVoiceSelect");
      const rate = rateSlider ? parseFloat(rateSlider.value) : this.state.ttsOptions.rate ?? 1;
      const pitch = pitchSlider ? parseFloat(pitchSlider.value) : this.state.ttsOptions.pitch ?? 1;
      const volume = volSlider ? parseFloat(volSlider.value) : this.state.ttsOptions.volume ?? 1;
      let voice = voiceSelect && voiceSelect.value ? voiceSelect.value : this.state.ttsOptions.voice || "hi-IN-SwaraNeural";
      if (typeof voice === "object" && voice) {
        voice = voice.voiceURI || voice.name || "hi-IN-SwaraNeural";
      }
      const finalRate = isNaN(rate) ? 1 : rate;
      const finalPitch = isNaN(pitch) ? 1 : pitch;
      const finalVolume = isNaN(volume) ? 1 : volume;
      this.state.ttsOptions.rate = finalRate;
      this.state.ttsOptions.pitch = finalPitch;
      this.state.ttsOptions.volume = finalVolume;
      this.state.ttsOptions.voice = voice;
      return {
        voice,
        rate: finalRate,
        pitch: finalPitch,
        volume: finalVolume
      };
    }
    /**
     * Checks whether the local server is running and toggles banner & neural options
     */
    async updateBackendVoiceStatus() {
      const isUp = await this.voiceEngine.checkBackend();
      this.state.isBackendUp = isUp;
      const banner = document.getElementById("ttsBackendBanner");
      if (banner) {
        if (isUp) {
          banner.classList.add("hidden");
        } else {
          banner.classList.remove("hidden");
        }
      }
      const voiceSelect = document.getElementById("ttsVoiceSelect");
      if (voiceSelect) {
        Array.from(voiceSelect.options).forEach((opt) => {
          if (opt.value && opt.value.includes("Neural")) {
            if (!isUp) {
              opt.disabled = true;
              if (!opt.textContent.includes("(Offline")) {
                opt.textContent = `${opt.textContent.replace("\u2B50 ", "")} (Offline - Requires npm start)`;
              }
            } else {
              opt.disabled = false;
              opt.textContent = opt.textContent.replace(" (Offline - Requires npm start)", "");
              if (!opt.textContent.startsWith("\u2B50 ")) {
                opt.textContent = `\u2B50 ${opt.textContent}`;
              }
            }
          }
        });
      }
      return isUp;
    }
    async handleAudioFile(file) {
      try {
        const buffer = await this.voiceEngine.loadAudioFile(file);
        this.onVoiceLoaded(buffer, file.name);
        this.ui.showToast(`Loaded voice file: ${file.name}`, "success");
      } catch (err) {
        this.ui.showToast(`Failed to decode audio file: ${err.message}`, "error");
      }
    }
    onVoiceLoaded(buffer, filename, skipRealign = false) {
      var _a, _b, _c;
      this.voiceEngine.setAudioBuffer(buffer, filename);
      const nameEl = document.getElementById("audioFileNameDisplay");
      if (nameEl) nameEl.textContent = filename;
      const durEl = document.getElementById("audioDurationDisplay");
      if (durEl) durEl.textContent = this.ui.formatTime((buffer == null ? void 0 : buffer.duration) || 0);
      (_a = document.getElementById("audioPlayerPanel")) == null ? void 0 : _a.classList.remove("hidden");
      const ttsNameEl = document.getElementById("ttsAudioFileNameDisplay");
      if (ttsNameEl) ttsNameEl.textContent = filename;
      const ttsDurEl = document.getElementById("ttsAudioDurationDisplay");
      if (ttsDurEl) ttsDurEl.textContent = this.ui.formatTime((buffer == null ? void 0 : buffer.duration) || 0);
      if (this.state.voiceMode === "A" || filename === "tts_voice.wav") {
        (_b = document.getElementById("ttsAudioPlayerPanel")) == null ? void 0 : _b.classList.remove("hidden");
      }
      const durMode = (_c = document.getElementById("durationModeSelect")) == null ? void 0 : _c.value;
      if (!durMode || durMode === "match-voice") {
        const voiceSec = Math.max(5, Math.ceil((buffer == null ? void 0 : buffer.duration) || 60));
        this.state.timelineDuration = voiceSec;
        const durInput = document.getElementById("timelineDurationInput");
        if (durInput) durInput.value = voiceSec;
      }
      const canvas = document.getElementById("waveformBarCanvas");
      if (canvas) this.voiceEngine.drawWaveform(canvas, buffer);
      this.state.silenceGaps = this.voiceEngine.detectSilenceGaps();
      this.updateFastExportButtonLabel();
      if (!skipRealign) {
        this.realignCaptionsWithCurrentVoice();
      }
    }
    handleScriptChange(text) {
      var _a, _b;
      this.state.scriptText = text;
      const charCount = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const rate = ((_a = this.state.ttsOptions) == null ? void 0 : _a.rate) || 1;
      const estSec = Math.round(words / (130 * rate) * 60);
      document.getElementById("scriptCharCount").textContent = charCount;
      document.getElementById("scriptWordCount").textContent = words;
      document.getElementById("scriptEstTime").textContent = this.ui.formatTime(estSec);
      const rawSentences = this.captionEngine.splitScriptIntoSentences(text);
      document.getElementById("scriptChunksCount").textContent = rawSentences.length;
      const hasHindi = /[\u0900-\u097F]/.test(text);
      const langSelect = document.getElementById("ttsLanguageSelect");
      if (hasHindi && langSelect && langSelect.value !== "hi") {
        langSelect.value = "hi";
        this.populateTtsLanguagesAndVoices(false);
      }
      if (this.state.voiceMode === "A") {
        this.recalculateTtsTimelineDuration();
      }
      this.realignCaptionsWithCurrentVoice();
      (_b = this.youtubeGenerator) == null ? void 0 : _b.updateScriptSummary();
    }
    realignCaptionsWithCurrentVoice() {
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      const targetDuration = this.getEffectiveTimelineDuration();
      const aligned = this.captionEngine.alignCaptionsWithAudio(
        rawSentences,
        targetDuration,
        this.state.silenceGaps,
        this.voiceEngine.audioBuffer
      );
      this.ui.renderCaptionChunks(aligned, {
        onUpdateChunk: (idx, data) => {
          if (this.captionEngine.chunks[idx]) {
            Object.assign(this.captionEngine.chunks[idx], data);
            this.captionEngine.chunks[idx].duration = data.end - data.start;
            this.captionEngine.chunks[idx].isManuallyEdited = true;
            this.rebuildTimeline();
          }
        },
        onDeleteChunk: (idx) => {
          this.captionEngine.chunks.splice(idx, 1);
          this.realignCaptionsWithCurrentVoice();
        }
      });
      if (this.state.currentStep === 3) {
        this.rebuildTimeline();
      }
    }
    updateFastExportButtonLabel() {
      var _a;
      const btn = document.getElementById("startFastSilentExportBtn");
      if (!btn) return;
      const span = btn.querySelector("span");
      const label = "Fast Render with Voice (WebCodecs)";
      if (span) span.textContent = label;
      else btn.textContent = label;
      const heading = (_a = btn.closest(".export-mode-block")) == null ? void 0 : _a.querySelector("h5");
      if (heading) {
        heading.textContent = "Mode 3: Ultra-Fast Video (adds your voice if loaded)";
      }
    }
    // TTS Setup
    bindTtsEvents() {
      const langSelect = document.getElementById("ttsLanguageSelect");
      const voiceSelect = document.getElementById("ttsVoiceSelect");
      const searchInput = document.getElementById("ttsVoiceSearch");
      const toneSelect = document.getElementById("ttsToneSelect");
      const rateSlider = document.getElementById("ttsRateSlider");
      const pitchSlider = document.getElementById("ttsPitchSlider");
      const volSlider = document.getElementById("ttsVolumeSlider");
      const previewBtn = document.getElementById("previewTtsVoiceBtn") || document.getElementById("previewTts10sBtn") || document.getElementById("previewTtsBtn");
      const stopBtn = document.getElementById("stopVoicePreviewBtn") || document.getElementById("stopTtsPreviewBtn");
      langSelect == null ? void 0 : langSelect.addEventListener("change", () => {
        this.populateTtsLanguagesAndVoices(false);
      });
      voiceSelect == null ? void 0 : voiceSelect.addEventListener("change", () => {
        const selectedVal = voiceSelect.value;
        if (selectedVal.includes("Neural")) {
          this.state.ttsOptions.voice = { name: selectedVal, voiceURI: selectedVal, lang: selectedVal.startsWith("hi-") ? "hi-IN" : "en" };
        } else {
          const found = this.voiceEngine.voices.find(
            (v) => v.voiceURI && v.voiceURI === selectedVal || v.name === selectedVal
          );
          this.state.ttsOptions.voice = found || { name: selectedVal, voiceURI: selectedVal, lang: "en" };
        }
        this.updateTtsVoiceDetails(this.state.ttsOptions.voice);
      });
      searchInput == null ? void 0 : searchInput.addEventListener("input", () => {
        this.populateTtsLanguagesAndVoices(false);
      });
      const updateRateAndPitchUI = (rate, pitch, syncTone = true) => {
        const finalRate = Number(rate).toFixed(2).replace(/\.00$/, ".0").replace(/\.([1-9])0$/, ".$1");
        const finalPitch = Number(pitch).toFixed(2).replace(/\.00$/, ".0").replace(/\.([1-9])0$/, ".$1");
        if (rateSlider) rateSlider.value = rate;
        const rateVal = document.getElementById("ttsRateVal");
        const rateDisp = document.getElementById("ttsRateDisplay");
        if (rateVal) rateVal.textContent = `${finalRate}x`;
        if (rateDisp) rateDisp.textContent = `${finalRate}x`;
        const speedBadge = document.getElementById("speedBadge");
        if (speedBadge) {
          if (rate < 0.85) speedBadge.textContent = "Slow & Clear";
          else if (rate <= 1.15) speedBadge.textContent = "Normal Speed";
          else if (rate <= 1.5) speedBadge.textContent = "Fast Pace";
          else if (rate < 2) speedBadge.textContent = "Very Fast";
          else if (rate < 2.3) speedBadge.textContent = "\u26A1 Double Speed (2x)";
          else speedBadge.textContent = "\u{1F680} Hyper Speed (2.5x)";
        }
        if (pitchSlider) pitchSlider.value = pitch;
        const pitchVal = document.getElementById("ttsPitchVal");
        const pitchDisp = document.getElementById("ttsPitchDisplay");
        if (pitchVal) pitchVal.textContent = `${finalPitch}x`;
        if (pitchDisp) pitchDisp.textContent = `${finalPitch}x`;
        const pitchBadge = document.getElementById("pitchBadge");
        if (pitchBadge) {
          if (pitch < 0.8) pitchBadge.textContent = "Deep Voice";
          else if (pitch < 0.95) pitchBadge.textContent = "Warm & Low";
          else if (pitch <= 1.05) pitchBadge.textContent = "Natural Tone";
          else if (pitch <= 1.25) pitchBadge.textContent = "Bright & Crisp";
          else pitchBadge.textContent = "High Pitch";
        }
        document.querySelectorAll(".speed-quick-btn").forEach((btn) => {
          const bRate = parseFloat(btn.dataset.rate);
          btn.classList.toggle("active", Math.abs(bRate - rate) < 0.03);
        });
        document.querySelectorAll(".pitch-quick-btn").forEach((btn) => {
          const bPitch = parseFloat(btn.dataset.pitch);
          btn.classList.toggle("active", Math.abs(bPitch - pitch) < 0.03);
        });
        if (syncTone && toneSelect) {
          const matched = Object.entries(TONE_PRESETS).find(
            ([key, p]) => Math.abs(p.rate - rate) < 0.03 && Math.abs(p.pitch - pitch) < 0.03
          );
          if (matched) {
            toneSelect.value = matched[0];
            const toneBadge = document.getElementById("activeToneBadge");
            if (toneBadge) toneBadge.textContent = matched[1].label;
            document.querySelectorAll(".preset-pill").forEach((p) => {
              p.classList.toggle("active", p.dataset.preset === matched[0]);
            });
          } else {
            toneSelect.value = "custom";
            const toneBadge = document.getElementById("activeToneBadge");
            if (toneBadge) toneBadge.textContent = "Custom Tuned";
            document.querySelectorAll(".preset-pill").forEach((p) => p.classList.remove("active"));
          }
        }
        if (this.state.voiceMode === "A") {
          this.recalculateTtsTimelineDuration();
        }
      };
      toneSelect == null ? void 0 : toneSelect.addEventListener("change", (e) => {
        const preset = TONE_PRESETS[e.target.value];
        if (!preset) return;
        this.state.ttsOptions.rate = preset.rate;
        this.state.ttsOptions.pitch = preset.pitch;
        const toneBadge = document.getElementById("activeToneBadge");
        if (toneBadge) toneBadge.textContent = preset.label;
        document.querySelectorAll(".preset-pill").forEach((p) => {
          p.classList.toggle("active", p.dataset.preset === e.target.value);
        });
        updateRateAndPitchUI(preset.rate, preset.pitch, false);
      });
      rateSlider == null ? void 0 : rateSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        const safeRate = isNaN(val) ? 1 : val;
        this.state.ttsOptions.rate = safeRate;
        updateRateAndPitchUI(safeRate, this.state.ttsOptions.pitch, true);
      });
      pitchSlider == null ? void 0 : pitchSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        const safePitch = isNaN(val) ? 1 : val;
        this.state.ttsOptions.pitch = safePitch;
        updateRateAndPitchUI(this.state.ttsOptions.rate, safePitch, true);
      });
      document.querySelectorAll(".speed-quick-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = parseFloat(btn.dataset.rate);
          if (!isNaN(r)) {
            this.state.ttsOptions.rate = r;
            updateRateAndPitchUI(r, this.state.ttsOptions.pitch, true);
          }
        });
      });
      document.querySelectorAll(".pitch-quick-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const p = parseFloat(btn.dataset.pitch);
          if (!isNaN(p)) {
            this.state.ttsOptions.pitch = p;
            updateRateAndPitchUI(this.state.ttsOptions.rate, p, true);
          }
        });
      });
      volSlider == null ? void 0 : volSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        this.state.ttsOptions.volume = isNaN(val) ? 1 : val;
        const volVal = document.getElementById("ttsVolumeVal");
        if (volVal) volVal.textContent = `${Math.round(val * 100)}%`;
      });
      document.querySelectorAll(".preset-pill").forEach((pill) => {
        pill.addEventListener("click", (e) => {
          const presetKey = pill.dataset.preset;
          const preset = TONE_PRESETS[presetKey];
          const rate = preset ? preset.rate : parseFloat(pill.dataset.rate);
          const pitch = preset ? preset.pitch : parseFloat(pill.dataset.pitch);
          this.state.ttsOptions.rate = rate;
          this.state.ttsOptions.pitch = pitch;
          if (toneSelect && presetKey) toneSelect.value = presetKey;
          const toneBadge = document.getElementById("activeToneBadge");
          if (toneBadge && preset) toneBadge.textContent = preset.label;
          document.querySelectorAll(".preset-pill").forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          updateRateAndPitchUI(rate, pitch, false);
        });
      });
      previewBtn == null ? void 0 : previewBtn.addEventListener("click", () => {
        let previewText = "";
        const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
        if (rawSentences.length > 0) {
          previewText = rawSentences.slice(0, 2).join(" ");
        } else {
          const isHindi = /[\u0900-\u097F]/.test(this.state.scriptText || "");
          if (isHindi) {
            previewText = "\u0928\u092E\u0938\u094D\u0924\u0947, \u092F\u0939 \u0938\u094D\u091F\u094B\u0930\u0940\u092B\u094D\u0932\u094B \u0938\u094D\u091F\u0942\u0921\u093F\u092F\u094B \u0915\u093E \u0935\u0949\u092F\u0938 \u091F\u0947\u0938\u094D\u091F \u0939\u0948\u0964 \u0939\u092E \u0906\u092A\u0915\u0947 \u0935\u0940\u0921\u093F\u092F\u094B \u0915\u0947 \u0932\u093F\u090F \u0938\u0941\u0902\u0926\u0930 \u090F\u0928\u0940\u092E\u30FC\u30B7\u30E7\u30F3 \u092C\u0928\u093E\u0924\u0947 \u0939\u0948\u0902\u0964";
          } else {
            previewText = "Hello! This is a voice-over preview test in StoryFlow Studio. Your story will come alive with cinematic photo animation.";
          }
        }
        previewBtn == null ? void 0 : previewBtn.classList.add("hidden");
        stopBtn == null ? void 0 : stopBtn.classList.remove("hidden");
        const onDone = () => {
          previewBtn == null ? void 0 : previewBtn.classList.remove("hidden");
          stopBtn == null ? void 0 : stopBtn.classList.add("hidden");
        };
        const ttsOpts = this.getTtsOptions();
        this.voiceEngine.speakSingle(
          previewText,
          ttsOpts,
          () => {
          },
          onDone,
          (err) => {
            console.warn("[TTS Preview Fallback]", err);
            this.ui.showToast(`Neural voice unavailable (${err.message}). Using browser speech synthesis fallback.`, "warning", 6e3);
            onDone();
          }
        );
      });
      const speakFullBtn = document.getElementById("speakFullTtsBtn");
      const recordTtsBtn = document.getElementById("recordTtsToAudioBtn");
      stopBtn == null ? void 0 : stopBtn.addEventListener("click", () => {
        this.voiceEngine.stopPreview();
        this.voiceEngine.stopSpeaking();
        previewBtn == null ? void 0 : previewBtn.classList.remove("hidden");
        stopBtn == null ? void 0 : stopBtn.classList.add("hidden");
        if (speakFullBtn) {
          speakFullBtn.classList.remove("btn-primary");
          speakFullBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          \u25B6\uFE0F Speak Full Voice-Over`;
        }
      });
      speakFullBtn == null ? void 0 : speakFullBtn.addEventListener("click", () => {
        const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
        if (!rawSentences.length) {
          this.ui.showToast("Please enter or paste your script first to speak full voice-over.", "error");
          return;
        }
        speakFullBtn.classList.add("btn-primary");
        speakFullBtn.innerHTML = `<span>\u{1F50A} Speaking Full Voice (1/${rawSentences.length})...</span>`;
        const ttsOpts = this.getTtsOptions();
        this.voiceEngine.speakChunks(
          rawSentences,
          ttsOpts,
          (idx) => {
            speakFullBtn.innerHTML = `<span>\u{1F50A} Speaking Full Voice (${idx + 1}/${rawSentences.length})...</span>`;
          },
          () => {
            speakFullBtn.classList.remove("btn-primary");
            speakFullBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            \u25B6\uFE0F Speak Full Voice-Over`;
            this.ui.showToast("Full voice-over playback completed!", "success");
          }
        );
      });
      const generateNeuralBtn = document.getElementById("generateNeuralTtsBtn");
      generateNeuralBtn == null ? void 0 : generateNeuralBtn.addEventListener("click", () => {
        this.generateNeuralVoiceAction();
      });
      recordTtsBtn == null ? void 0 : recordTtsBtn.addEventListener("click", async () => {
        this.ui.showToast('\u26A0\uFE0F Note: Tab capture is unreliable and often silent. Recommend using "Generate Voice File (Natural Hindi/English)" instead.', "info", 5e3);
        const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
        if (!rawSentences.length) {
          this.ui.showToast("Please enter your script first before generating audio.", "error");
          return;
        }
        try {
          this.ui.showToast('In the popup: choose "This Tab" and tick "Share tab audio".', "info", 6e3);
          const stream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
            preferCurrentTab: true
          });
          const audioTracks = stream.getAudioTracks();
          if (!audioTracks.length) {
            stream.getTracks().forEach((t) => t.stop());
            this.ui.showToast('Tab audio was not checked. Please choose "Chrome Tab" / "Edge Tab" and tick "Share tab audio".', "error", 6e3);
            return;
          }
          const audioOnlyStream = new MediaStream(audioTracks);
          stream.getVideoTracks().forEach((t) => t.stop());
          recordTtsBtn.disabled = true;
          recordTtsBtn.innerHTML = `<span>\u{1F399}\uFE0F Recording TTS Audio Track...</span>`;
          let mimeType = "";
          if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
            mimeType = "audio/webm;codecs=opus";
          } else if (MediaRecorder.isTypeSupported("audio/webm")) {
            mimeType = "audio/webm";
          }
          const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : void 0);
          const chunks = [];
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };
          recorder.start(100);
          this.voiceEngine.speakChunks(
            rawSentences,
            this.state.ttsOptions,
            (idx) => {
              recordTtsBtn.innerHTML = `<span>\u{1F399}\uFE0F Recording Chunk (${idx + 1}/${rawSentences.length})...</span>`;
            },
            async () => {
              setTimeout(async () => {
                if (recorder.state !== "inactive") recorder.stop();
                audioTracks.forEach((t) => t.stop());
              }, 600);
            }
          );
          recorder.onstop = async () => {
            try {
              const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const buffer = await this.voiceEngine.loadAudioFile(blob, "generated_tts_voice.webm");
              this.onVoiceLoaded(buffer, "generated_tts_voice.webm");
              this.setVoiceMode("B");
              recordTtsBtn.disabled = false;
              recordTtsBtn.innerHTML = `\u{1F399}\uFE0F Record Full TTS into Audio Track (Tab Capture)`;
              this.ui.showToast("\u{1F389} Full voice-over generated & saved into audio track!", "success", 5e3);
            } catch (err) {
              recordTtsBtn.disabled = false;
              recordTtsBtn.innerHTML = `\u{1F399}\uFE0F Record Full TTS into Audio Track (Tab Capture)`;
              this.ui.showToast(`Failed to process recorded audio: ${err.message}`, "error");
            }
          };
        } catch (err) {
          recordTtsBtn.disabled = false;
          recordTtsBtn.innerHTML = `\u{1F399}\uFE0F Record Full TTS into Audio Track (Tab Capture)`;
          this.ui.showToast(`Tab share cancelled: ${err.message}`, "info");
        }
      });
    }
    async generateNeuralVoiceAction() {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      if (!rawSentences.length) {
        this.ui.showToast("Please enter your script first in Step 2 before generating voice.", "error");
        return null;
      }
      const generateNeuralBtn = document.getElementById("generateNeuralTtsBtn");
      const originalHtml = generateNeuralBtn ? generateNeuralBtn.innerHTML : "";
      if (generateNeuralBtn) {
        generateNeuralBtn.disabled = true;
        generateNeuralBtn.innerHTML = `<span>\u23F3 Generating Voice (Neural TTS)...</span>`;
      }
      try {
        const ttsOpts = this.getTtsOptions();
        let selectedVoice = ttsOpts.voice;
        const isHindi = /[\u0900-\u097F]/.test(this.state.scriptText);
        if (isHindi && (!selectedVoice || selectedVoice.startsWith("en-") || !selectedVoice.includes("hi-IN"))) {
          selectedVoice = "hi-IN-SwaraNeural";
          const voiceSelect = document.getElementById("ttsVoiceSelect");
          if (voiceSelect) voiceSelect.value = selectedVoice;
          ttsOpts.voice = selectedVoice;
        } else if (!selectedVoice || !selectedVoice.includes("Neural")) {
          selectedVoice = isHindi ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
          ttsOpts.voice = selectedVoice;
        }
        const result = await this.voiceEngine.generateVoiceFromScript(rawSentences, {
          voice: selectedVoice,
          rate: ttsOpts.rate,
          pitch: ttsOpts.pitch,
          volume: ttsOpts.volume,
          onProgress: (current, total) => {
            if (generateNeuralBtn) {
              generateNeuralBtn.innerHTML = `<span>\u23F3 Generating Voice (${current}/${total} sentences)...</span>`;
            }
          }
        });
        const voiceDur = Math.max(5, Math.ceil(result.buffer.duration));
        this.state.timelineDuration = voiceDur;
        const durInput = document.getElementById("timelineDurationInput");
        if (durInput) durInput.value = voiceDur;
        this.captionEngine.chunks = result.sentenceTimings.map((st, idx) => ({
          id: `cap_${idx + 1}`,
          index: idx + 1,
          text: st.text,
          start: Number(st.start.toFixed(2)),
          end: Number(st.end.toFixed(2)),
          duration: Number((st.end - st.start).toFixed(2)),
          isManuallyEdited: false
        }));
        this.onVoiceLoaded(result.buffer, "tts_voice.wav", true);
        this.ui.renderCaptionChunks(this.captionEngine.chunks, {
          onUpdateChunk: (idx, data) => {
            if (this.captionEngine.chunks[idx]) {
              Object.assign(this.captionEngine.chunks[idx], data);
              this.captionEngine.chunks[idx].duration = data.end - data.start;
              this.captionEngine.chunks[idx].isManuallyEdited = true;
              this.rebuildTimeline();
            }
          },
          onDeleteChunk: (idx) => {
            this.captionEngine.chunks.splice(idx, 1);
            this.rebuildTimeline();
          }
        });
        this.rebuildTimeline();
        this.updateFastExportButtonLabel();
        this.ui.showToast(`\u{1F389} Generated natural voice file (${result.buffer.duration.toFixed(1)}s)!`, "success", 5e3);
        return result;
      } catch (err) {
        console.error("[Generate Voice Error]", err);
        const is404 = ((_a = err.message) == null ? void 0 : _a.includes("404")) || ((_b = err.message) == null ? void 0 : _b.includes("not found")) || ((_c = err.message) == null ? void 0 : _c.includes("server not running")) || ((_d = err.message) == null ? void 0 : _d.includes("static"));
        const isNetErr = !navigator.onLine || ((_e = err.message) == null ? void 0 : _e.includes("Failed to connect")) || ((_f = err.message) == null ? void 0 : _f.includes("fetch")) || ((_g = err.message) == null ? void 0 : _g.includes("Failed to fetch")) || ((_h = err.message) == null ? void 0 : _h.includes("NetworkError"));
        if (is404) {
          this.ui.showToast("\u26A0\uFE0F Online Neural TTS requires a backend server. Run `npm start` at http://localhost:3000.", "warning", 9e3);
        } else if (isNetErr) {
          this.ui.showToast("Could not reach TTS server. Start the local server with `npm start`, or upload your own voice file.", "error", 7e3);
        } else {
          this.ui.showToast(`Voice generation failed: ${err.message}`, "error", 7e3);
        }
        return null;
      } finally {
        if (generateNeuralBtn) {
          generateNeuralBtn.disabled = false;
          generateNeuralBtn.innerHTML = originalHtml;
        }
      }
    }
    updateTtsVoiceDetails(voice) {
      const detailsEl = document.getElementById("ttsVoiceDetails");
      if (!detailsEl) return;
      if (!voice) {
        detailsEl.textContent = "Default browser speech synthesizer";
        return;
      }
      const name = voice.name || voice.voiceURI || "";
      if (name.includes("Neural")) {
        const isHindi = name.includes("hi-IN") || name.includes("Swara") || name.includes("Madhur");
        const lang = isHindi ? "hi-IN" : name.includes("en-IN") ? "en-IN" : "en-US";
        let friendlyName = name;
        if (name.includes("Swara")) friendlyName = "Swara (Hindi Female - Neural)";
        else if (name.includes("Madhur")) friendlyName = "Madhur (Hindi Male - Neural)";
        else if (name.includes("Neerja")) friendlyName = "Neerja (Indian English Female - Neural)";
        else if (name.includes("Jenny")) friendlyName = "Jenny (US English Female - Neural)";
        detailsEl.textContent = `\u2B50 Microsoft Edge Neural Voice (Studio Quality) \xB7 ${lang} \xB7 ${friendlyName}`;
        return;
      }
      const isEdgeNatural = name.includes("Natural") || name.includes("Online");
      const isGoogle = name.includes("Google");
      let badge = "System Voice";
      if (isEdgeNatural) badge = "\u2B50 Microsoft Edge Natural Voice (High Quality)";
      else if (isGoogle) badge = "\u{1F537} Google TTS Voice";
      detailsEl.textContent = `${badge} \xB7 ${voice.lang || "en"} \xB7 ${name}`;
    }
    recalculateTtsTimelineDuration() {
      if (this.state.voiceMode !== "A") return;
      const words = this.state.scriptText.trim() ? this.state.scriptText.trim().split(/\s+/).length : 0;
      const rate = this.state.ttsOptions.rate || 1;
      const estSec = Math.max(10, Math.round(words / (130 * rate) * 60));
      this.voiceEngine.audioDuration = estSec;
      if (this.state.durationMode === "match-voice") {
        this.state.timelineDuration = estSec;
        this.realignCaptionsWithCurrentVoice();
        if (this.state.currentStep === 3) this.rebuildTimeline();
      }
    }
    populateTtsLanguagesAndVoices(rebuildLanguages = true) {
      var _a;
      const langSelect = document.getElementById("ttsLanguageSelect");
      const voiceSelect = document.getElementById("ttsVoiceSelect");
      const searchInput = document.getElementById("ttsVoiceSearch");
      if (!voiceSelect) return;
      const voices = ((_a = this.voiceEngine) == null ? void 0 : _a.voices) || [];
      const browserLang = navigator.language || "en-US";
      const browserLangPrefix = browserLang.split("-")[0].toLowerCase();
      if (rebuildLanguages && langSelect) {
        const currentSelectedLang = langSelect.value || "browser-default";
        langSelect.innerHTML = "";
        const defOpt = document.createElement("option");
        defOpt.value = "browser-default";
        defOpt.textContent = `\u{1F310} Default Browser Language (${browserLang})`;
        langSelect.appendChild(defOpt);
        const edgOpt = document.createElement("option");
        edgOpt.value = "natural-google";
        edgOpt.textContent = `\u2B50 Microsoft Edge & Google TTS Voices`;
        langSelect.appendChild(edgOpt);
        const hiOpt = document.createElement("option");
        hiOpt.value = "hi";
        hiOpt.textContent = `\u{1F1EE}\u{1F1F3} Hindi (\u0939\u093F\u0928\u094D\u0926\u0940 - hi-IN)`;
        langSelect.appendChild(hiOpt);
        const enInOpt = document.createElement("option");
        enInOpt.value = "en-in";
        enInOpt.textContent = `\u{1F1EE}\u{1F1F3} English (India - en-IN)`;
        langSelect.appendChild(enInOpt);
        const enUsOpt = document.createElement("option");
        enUsOpt.value = "en-us";
        enUsOpt.textContent = `\u{1F1FA}\u{1F1F8} English (US - en-US)`;
        langSelect.appendChild(enUsOpt);
        const enGbOpt = document.createElement("option");
        enGbOpt.value = "en-gb";
        enGbOpt.textContent = `\u{1F1EC}\u{1F1E7} English (UK - en-GB)`;
        langSelect.appendChild(enGbOpt);
        const allOpt = document.createElement("option");
        allOpt.value = "all";
        allOpt.textContent = `\u{1F30D} All Languages (${voices.length} voices)`;
        langSelect.appendChild(allOpt);
        const hasHindi2 = /[\u0900-\u097F]/.test(this.state.scriptText);
        if (hasHindi2) {
          langSelect.value = "hi";
        } else if (currentSelectedLang) {
          langSelect.value = currentSelectedLang;
        }
      }
      const selectedLangFilter = langSelect ? langSelect.value : "browser-default";
      const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : "";
      let filtered = voices.filter((v) => {
        const vLang = (v.lang || "").replace("_", "-").toLowerCase();
        const vName = (v.name || "").toLowerCase();
        if (selectedLangFilter === "browser-default") {
          const matchesBrowser = vLang.startsWith(browserLangPrefix);
          if (!matchesBrowser) return false;
        } else if (selectedLangFilter === "natural-google") {
          const isNatOrGoogle = vName.includes("natural") || vName.includes("online") || vName.includes("google");
          if (!isNatOrGoogle) return false;
        } else if (selectedLangFilter === "hi") {
          if (!vLang.startsWith("hi")) return false;
        } else if (selectedLangFilter === "en-in") {
          if (!vLang.includes("en-in") && !(vLang.startsWith("en") && vName.includes("india"))) return false;
        } else if (selectedLangFilter === "en-us") {
          if (!vLang.includes("en-us") && !vLang.includes("en-") && !vLang.startsWith("en")) return false;
        } else if (selectedLangFilter === "en-gb") {
          if (!vLang.includes("en-gb") && !vLang.includes("en-uk")) return false;
        }
        if (searchQuery) {
          return vName.includes(searchQuery) || vLang.includes(searchQuery);
        }
        return true;
      });
      if (filtered.length === 0 && voices.length > 0) {
        filtered = voices;
      }
      filtered.sort((a, b) => {
        const aNat = a.name.includes("Natural") || a.name.includes("Online") ? 3 : a.name.includes("Google") ? 2 : 1;
        const bNat = b.name.includes("Natural") || b.name.includes("Online") ? 3 : b.name.includes("Google") ? 2 : 1;
        if (bNat !== aNat) return bNat - aNat;
        return a.name.localeCompare(b.name);
      });
      voiceSelect.innerHTML = "";
      const isUp = this.state.isBackendUp !== false;
      const neuralGroup = document.createElement("optgroup");
      neuralGroup.label = isUp ? "\u2B50 Neural Voices (Free msedge-tts - Recommended)" : "\u26A0\uFE0F Neural Voices (Offline - Run npm start)";
      const neuralList = [
        { id: "hi-IN-SwaraNeural", label: "\u2B50 Swara (Hindi Female - Neural Natural)" },
        { id: "hi-IN-MadhurNeural", label: "\u2B50 Madhur (Hindi Male - Neural Natural)" },
        { id: "en-IN-NeerjaNeural", label: "\u2B50 Neerja (Indian English Female - Neural Natural)" },
        { id: "en-US-JennyNeural", label: "\u2B50 Jenny (US English Female - Neural Natural)" }
      ];
      neuralList.forEach((nv) => {
        const opt = document.createElement("option");
        opt.value = nv.id;
        opt.textContent = isUp ? nv.label : `${nv.label.replace("\u2B50 ", "")} (Offline - Requires npm start)`;
        if (!isUp) opt.disabled = true;
        neuralGroup.appendChild(opt);
      });
      voiceSelect.appendChild(neuralGroup);
      if (filtered.length > 0) {
        const systemGroup = document.createElement("optgroup");
        systemGroup.label = "\u{1F310} Browser System Voices (SpeechSynthesis)";
        filtered.forEach((voice) => {
          const opt = document.createElement("option");
          opt.value = voice.voiceURI || voice.name;
          opt.textContent = `${voice.name} (${voice.lang})`;
          systemGroup.appendChild(opt);
        });
        voiceSelect.appendChild(systemGroup);
      } else if (voices.length === 0) {
        const systemGroup = document.createElement("optgroup");
        systemGroup.label = "\u{1F310} Browser System Voices (SpeechSynthesis)";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "System voices loading / unavailable";
        opt.disabled = true;
        systemGroup.appendChild(opt);
        voiceSelect.appendChild(systemGroup);
      }
      const hasHindi = /[\u0900-\u097F]/.test(this.state.scriptText);
      const defaultNeural = hasHindi ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
      if (this.state.ttsOptions.voice) {
        voiceSelect.value = this.state.ttsOptions.voice.voiceURI || this.state.ttsOptions.voice.name || defaultNeural;
      } else {
        voiceSelect.value = defaultNeural;
        this.state.ttsOptions.voice = { name: defaultNeural, voiceURI: defaultNeural };
      }
      this.updateTtsVoiceDetails(this.state.ttsOptions.voice);
    }
    // =========================================================================
    // Step 3: Studio & Formatting
    // =========================================================================
    bindStep3Events() {
      var _a, _b, _c, _d, _e, _f;
      (_a = document.getElementById("ratio16x9Btn")) == null ? void 0 : _a.addEventListener("click", () => this.setAspectRatio("16:9"));
      (_b = document.getElementById("ratio9x16Btn")) == null ? void 0 : _b.addEventListener("click", () => this.setAspectRatio("9:16"));
      (_c = document.getElementById("ratio720pBtn")) == null ? void 0 : _c.addEventListener("click", () => this.setAspectRatio("16:9-720p"));
      (_d = document.getElementById("verticalCropLayoutSelect")) == null ? void 0 : _d.addEventListener("change", (e) => {
        this.state.verticalModeLayout = e.target.value;
        this.renderCurrentPreviewFrame();
      });
      const durSelect = document.getElementById("durationModeSelect");
      const customGroup = document.getElementById("customDurationInputGroup");
      const customInput = document.getElementById("customDurationSeconds");
      durSelect == null ? void 0 : durSelect.addEventListener("change", () => {
        this.state.durationMode = durSelect.value;
        if (durSelect.value === "custom") {
          customGroup == null ? void 0 : customGroup.classList.remove("hidden");
        } else {
          customGroup == null ? void 0 : customGroup.classList.add("hidden");
        }
        this.rebuildTimeline();
      });
      customInput == null ? void 0 : customInput.addEventListener("input", () => {
        this.state.customDuration = Math.max(10, parseInt(customInput.value, 10) || 60);
        this.rebuildTimeline();
      });
      document.querySelectorAll(".settings-tab-nav .tab-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          var _a2;
          document.querySelectorAll(".settings-tab-nav .tab-btn").forEach((b) => b.classList.remove("active"));
          document.querySelectorAll(".settings-tab-panel").forEach((p) => p.classList.remove("active"));
          e.target.classList.add("active");
          const tabId = e.target.dataset.tab;
          (_a2 = document.getElementById(tabId)) == null ? void 0 : _a2.classList.add("active");
        });
      });
      const minDurSlider = document.getElementById("photoMinDurationSlider");
      const maxDurSlider = document.getElementById("photoMaxDurationSlider");
      const zoomSlider = document.getElementById("zoomFactorSlider");
      const timelineSlider = document.getElementById("timelineSlider");
      const zoomInBtn = document.getElementById("timelineZoomInBtn");
      const zoomOutBtn = document.getElementById("timelineZoomOutBtn");
      const transSlider = document.getElementById("transitionDurationSlider");
      const transTypeSelect = document.getElementById("transitionTypeSelect");
      const syncZoom = (newZoom) => {
        const clamped = Math.min(1.5, Math.max(1.05, Math.round(newZoom * 100) / 100));
        this.state.maxZoom = clamped;
        const zoomValStr = `${clamped.toFixed(2)}x`;
        if (zoomSlider) zoomSlider.value = clamped;
        if (timelineSlider) timelineSlider.value = clamped;
        const valEl = document.getElementById("zoomFactorVal");
        if (valEl) valEl.textContent = zoomValStr;
        this.rebuildTimeline();
      };
      zoomSlider == null ? void 0 : zoomSlider.addEventListener("input", (e) => syncZoom(parseFloat(e.target.value)));
      timelineSlider == null ? void 0 : timelineSlider.addEventListener("input", (e) => syncZoom(parseFloat(e.target.value)));
      zoomInBtn == null ? void 0 : zoomInBtn.addEventListener("click", () => syncZoom(this.state.maxZoom + 0.05));
      zoomOutBtn == null ? void 0 : zoomOutBtn.addEventListener("click", () => syncZoom(this.state.maxZoom - 0.05));
      minDurSlider == null ? void 0 : minDurSlider.addEventListener("input", (e) => {
        this.state.photoMinDuration = parseFloat(e.target.value);
        const valEl = document.getElementById("photoMinDurationVal");
        if (valEl) valEl.textContent = `${e.target.value}s`;
        this.rebuildTimeline();
      });
      maxDurSlider == null ? void 0 : maxDurSlider.addEventListener("input", (e) => {
        this.state.photoMaxDuration = parseFloat(e.target.value);
        const valEl = document.getElementById("photoMaxDurationVal");
        if (valEl) valEl.textContent = `${e.target.value}s`;
        this.rebuildTimeline();
      });
      transSlider == null ? void 0 : transSlider.addEventListener("input", (e) => {
        this.state.transitionDuration = parseFloat(e.target.value);
        document.getElementById("transitionDurationVal").textContent = `${e.target.value}s`;
        this.renderCurrentPreviewFrame();
      });
      transTypeSelect == null ? void 0 : transTypeSelect.addEventListener("change", (e) => {
        this.state.transitionType = e.target.value;
        this.renderCurrentPreviewFrame();
      });
      const animCheckboxes = [
        { id: "animZoomIn", val: "zoom-in" },
        { id: "animZoomOut", val: "zoom-out" },
        { id: "animPanLR", val: "pan-lr" },
        { id: "animPanRL", val: "pan-rl" },
        { id: "animPanUp", val: "pan-up" },
        { id: "animPanDown", val: "pan-down" },
        { id: "animDiagonal", val: "diagonal" }
      ];
      const updateEnabledAnims = () => {
        const enabled = [];
        animCheckboxes.forEach((item) => {
          const el = document.getElementById(item.id);
          if (el && el.checked) enabled.push(item.val);
        });
        this.state.enabledAnimations = enabled;
        this.rebuildTimeline();
      };
      animCheckboxes.forEach((item) => {
        var _a2;
        (_a2 = document.getElementById(item.id)) == null ? void 0 : _a2.addEventListener("change", updateEnabledAnims);
      });
      (_e = document.getElementById("selectAllAnimationsBtn")) == null ? void 0 : _e.addEventListener("click", () => {
        animCheckboxes.forEach((item) => {
          const el = document.getElementById(item.id);
          if (el) el.checked = true;
        });
        updateEnabledAnims();
      });
      (_f = document.getElementById("reshuffleTimelineBtn")) == null ? void 0 : _f.addEventListener("click", () => {
        this.rebuildTimeline();
        this.ui.showToast("Re-shuffled photo animation sequence.", "success");
      });
      this.bindCaptionStylingEvents();
      this.bindGradingEvents();
    }
    setAspectRatio(ratio) {
      var _a, _b;
      this.state.aspectRatio = ratio;
      const btn16x9 = document.getElementById("ratio16x9Btn");
      const btn9x16 = document.getElementById("ratio9x16Btn");
      const btn720p = document.getElementById("ratio720pBtn");
      const verticalOpt = document.getElementById("verticalModeLayoutOption");
      const viewport = document.getElementById("canvasViewport");
      const framingGroup = document.getElementById("clipperFramingGroup");
      btn16x9 == null ? void 0 : btn16x9.classList.toggle("active", ratio === "16:9");
      btn9x16 == null ? void 0 : btn9x16.classList.toggle("active", ratio === "9:16");
      btn720p == null ? void 0 : btn720p.classList.toggle("active", ratio === "16:9-720p");
      document.querySelectorAll("#clipperRatioPills .aspect-pill").forEach((p) => {
        p.classList.toggle("active", p.dataset.ratio === ratio || ratio === "16:9-720p" && p.dataset.ratio === "16:9");
      });
      if (framingGroup) {
        if (ratio === "custom") {
          framingGroup.style.opacity = "0.4";
          framingGroup.style.pointerEvents = "none";
        } else {
          framingGroup.style.opacity = "1";
          framingGroup.style.pointerEvents = "auto";
        }
      }
      if (ratio === "custom") {
        verticalOpt == null ? void 0 : verticalOpt.classList.add("hidden");
        if (!this.state.customNorm) {
          this.state.customNorm = this.getNormalizedCropBounds();
        }
        const norm = this.state.customNorm;
        const sourceW = ((_a = this.sourceVideo) == null ? void 0 : _a.videoWidth) || 1920;
        const sourceH = ((_b = this.sourceVideo) == null ? void 0 : _b.videoHeight) || 1080;
        let w = Math.round(norm.w * sourceW);
        let h = Math.round(norm.h * sourceH);
        if (Math.max(w, h) > 1920) {
          const scale = 1920 / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        w = w - w % 2;
        h = h - h % 2;
        this.state.exportWidth = Math.max(128, w);
        this.state.exportHeight = Math.max(128, h);
      } else if (ratio === "9:16") {
        verticalOpt == null ? void 0 : verticalOpt.classList.remove("hidden");
        this.state.exportWidth = 1080;
        this.state.exportHeight = 1920;
      } else if (ratio === "1:1") {
        verticalOpt == null ? void 0 : verticalOpt.classList.add("hidden");
        this.state.exportWidth = 1080;
        this.state.exportHeight = 1080;
      } else if (ratio === "4:5") {
        verticalOpt == null ? void 0 : verticalOpt.classList.add("hidden");
        this.state.exportWidth = 1080;
        this.state.exportHeight = 1350;
      } else if (ratio === "16:9-720p") {
        verticalOpt == null ? void 0 : verticalOpt.classList.add("hidden");
        this.state.exportWidth = 1280;
        this.state.exportHeight = 720;
      } else {
        verticalOpt == null ? void 0 : verticalOpt.classList.add("hidden");
        this.state.exportWidth = 1920;
        this.state.exportHeight = 1080;
      }
      if (viewport) {
        if (ratio === "custom") {
          viewport.classList.remove("aspect-9-16");
          viewport.style.aspectRatio = `${this.state.exportWidth} / ${this.state.exportHeight}`;
          viewport.style.maxHeight = "600px";
        } else if (ratio === "9:16") {
          viewport.classList.add("aspect-9-16");
          viewport.style.aspectRatio = "9 / 16";
          viewport.style.maxHeight = "600px";
        } else if (ratio === "1:1") {
          viewport.classList.remove("aspect-9-16");
          viewport.style.aspectRatio = "1 / 1";
          viewport.style.maxHeight = "540px";
        } else if (ratio === "4:5") {
          viewport.classList.remove("aspect-9-16");
          viewport.style.aspectRatio = "4 / 5";
          viewport.style.maxHeight = "560px";
        } else {
          viewport.classList.remove("aspect-9-16");
          viewport.style.aspectRatio = "16 / 9";
          viewport.style.maxHeight = "";
        }
      }
      this.updateCanvasResolution();
      this.renderCurrentPreviewFrame();
      if (this.state.sourceVideoLoaded) {
        this.updateClipperOverlay();
      }
    }
    updateCanvasResolution() {
      this.previewCanvas.width = this.state.exportWidth;
      this.previewCanvas.height = this.state.exportHeight;
      const badge = document.getElementById("canvasResBadge");
      if (badge) {
        const displayRatio = this.state.aspectRatio === "custom" ? "Custom" : this.state.aspectRatio;
        badge.textContent = `Frame: ${displayRatio} \xB7 ${this.state.exportWidth}x${this.state.exportHeight}`;
      }
    }
    bindCaptionStylingEvents() {
      const fontSelect = document.getElementById("captionFontSelect");
      const sizeSlider = document.getElementById("captionFontSizeSlider");
      const textColor = document.getElementById("captionTextColor");
      const highlightColor = document.getElementById("captionHighlightColor");
      const outlineSlider = document.getElementById("captionOutlineSlider");
      const outlineColor = document.getElementById("captionOutlineColor");
      const boxEnable = document.getElementById("captionBoxEnable");
      const boxOpacity = document.getElementById("captionBoxOpacitySlider");
      const karaokeEnable = document.getElementById("captionKaraokeEnable");
      fontSelect == null ? void 0 : fontSelect.addEventListener("change", (e) => {
        this.state.captionStyle.fontFamily = e.target.value;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      sizeSlider == null ? void 0 : sizeSlider.addEventListener("input", (e) => {
        this.state.captionStyle.fontSize = parseInt(e.target.value, 10);
        document.getElementById("captionFontSizeVal").textContent = `${e.target.value}px`;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      textColor == null ? void 0 : textColor.addEventListener("input", (e) => {
        this.state.captionStyle.textColor = e.target.value;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      highlightColor == null ? void 0 : highlightColor.addEventListener("input", (e) => {
        this.state.captionStyle.highlightColor = e.target.value;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      outlineSlider == null ? void 0 : outlineSlider.addEventListener("input", (e) => {
        this.state.captionStyle.outlineThickness = parseInt(e.target.value, 10);
        document.getElementById("captionOutlineVal").textContent = `${e.target.value}px`;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      outlineColor == null ? void 0 : outlineColor.addEventListener("input", (e) => {
        this.state.captionStyle.outlineColor = e.target.value;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      boxEnable == null ? void 0 : boxEnable.addEventListener("change", (e) => {
        this.state.captionStyle.boxEnabled = e.target.checked;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      boxOpacity == null ? void 0 : boxOpacity.addEventListener("input", (e) => {
        this.state.captionStyle.boxOpacity = parseInt(e.target.value, 10);
        document.getElementById("captionBoxOpacityVal").textContent = `${e.target.value}%`;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      karaokeEnable == null ? void 0 : karaokeEnable.addEventListener("change", (e) => {
        this.state.captionStyle.karaokeEnabled = e.target.checked;
        saveSetting("captionStyle", this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
      document.querySelectorAll(".position-buttons .pos-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          document.querySelectorAll(".position-buttons .pos-btn").forEach((b) => b.classList.remove("active"));
          e.target.classList.add("active");
          this.state.captionStyle.position = e.target.dataset.pos;
          saveSetting("captionStyle", this.state.captionStyle);
          this.renderCurrentPreviewFrame();
        });
      });
    }
    bindGradingEvents() {
      var _a;
      const vigSlider = document.getElementById("vignetteSlider");
      const grainSlider = document.getElementById("filmGrainSlider");
      const brightSlider = document.getElementById("brightnessSlider");
      const contSlider = document.getElementById("contrastSlider");
      const satSlider = document.getElementById("saturationSlider");
      vigSlider == null ? void 0 : vigSlider.addEventListener("input", (e) => {
        this.state.overlays.vignette = parseInt(e.target.value, 10);
        document.getElementById("vignetteVal").textContent = `${e.target.value}%`;
        saveSetting("overlays", this.state.overlays);
        this.renderCurrentPreviewFrame();
      });
      grainSlider == null ? void 0 : grainSlider.addEventListener("input", (e) => {
        this.state.overlays.filmGrain = parseInt(e.target.value, 10);
        document.getElementById("filmGrainVal").textContent = `${e.target.value}%`;
        saveSetting("overlays", this.state.overlays);
        this.renderCurrentPreviewFrame();
      });
      brightSlider == null ? void 0 : brightSlider.addEventListener("input", (e) => {
        this.state.colorGrading.brightness = parseInt(e.target.value, 10);
        document.getElementById("brightnessVal").textContent = `${e.target.value}%`;
        saveSetting("colorGrading", this.state.colorGrading);
        this.renderCurrentPreviewFrame();
      });
      contSlider == null ? void 0 : contSlider.addEventListener("input", (e) => {
        this.state.colorGrading.contrast = parseInt(e.target.value, 10);
        document.getElementById("contrastVal").textContent = `${e.target.value > 0 ? "+" : ""}${e.target.value}%`;
        saveSetting("colorGrading", this.state.colorGrading);
        this.renderCurrentPreviewFrame();
      });
      satSlider == null ? void 0 : satSlider.addEventListener("input", (e) => {
        this.state.colorGrading.saturation = parseInt(e.target.value, 10);
        document.getElementById("saturationVal").textContent = `${e.target.value}%`;
        saveSetting("colorGrading", this.state.colorGrading);
        this.renderCurrentPreviewFrame();
      });
      (_a = document.getElementById("resetGradingBtn")) == null ? void 0 : _a.addEventListener("click", () => {
        this.state.overlays = { vignette: 35, filmGrain: 15 };
        this.state.colorGrading = { brightness: 0, contrast: 5, saturation: 105 };
        vigSlider.value = 35;
        grainSlider.value = 15;
        brightSlider.value = 0;
        contSlider.value = 5;
        satSlider.value = 105;
        document.getElementById("vignetteVal").textContent = "35%";
        document.getElementById("filmGrainVal").textContent = "15%";
        document.getElementById("brightnessVal").textContent = "0%";
        document.getElementById("contrastVal").textContent = "+5%";
        document.getElementById("saturationVal").textContent = "105%";
        this.renderCurrentPreviewFrame();
        this.ui.showToast("Grading reset to default.", "info");
      });
    }
    // =========================================================================
    // Playback & Interactive Scrubber
    // =========================================================================
    getEffectiveTimelineDuration() {
      if (this.state.durationMode === "match-voice") {
        return this.voiceEngine.audioDuration > 0 ? this.voiceEngine.audioDuration : 60;
      }
      if (this.state.durationMode === "custom") {
        return this.state.customDuration;
      }
      return parseFloat(this.state.durationMode) || 60;
    }
    rebuildTimeline() {
      const dur = this.getEffectiveTimelineDuration();
      this.state.timelineDuration = dur;
      let segments = [];
      if (!this.state.shuffleMode && this.state.sceneMatches && this.state.sceneMatches.length > 0 && this.state.scriptLines && this.state.scriptLines.length > 0) {
        segments = this.timelineEngine.generateSceneMatchedTimeline(
          this.state.extractedFrames,
          this.state.scriptLines,
          this.state.sceneMatches,
          dur,
          this.captionEngine.chunks,
          {
            enabledAnimations: this.state.enabledAnimations,
            maxZoom: this.state.maxZoom,
            transitionDuration: this.state.transitionDuration,
            transitionType: this.state.transitionType
          }
        );
      } else {
        segments = this.timelineEngine.generateTimeline(
          this.state.extractedFrames,
          dur,
          {
            minDuration: this.state.photoMinDuration,
            maxDuration: this.state.photoMaxDuration,
            enabledAnimations: this.state.enabledAnimations,
            maxZoom: this.state.maxZoom,
            transitionDuration: this.state.transitionDuration,
            transitionType: this.state.transitionType
          }
        );
      }
      this.ui.renderTimelineTracks(segments, this.captionEngine.chunks, dur);
      document.getElementById("totalDurationDisplay").textContent = this.ui.formatTime(dur);
      this.renderCurrentPreviewFrame();
    }
    bindPlaybackEvents() {
      var _a;
      const playPauseBtn = document.getElementById("playPauseBtn");
      const restartBtn = document.getElementById("restartBtn");
      const skipBackBtn = document.getElementById("skipBack5Btn");
      const skipFwdBtn = document.getElementById("skipForward5Btn");
      const muteBtn = document.getElementById("toggleMutePreviewBtn");
      const volSlider = document.getElementById("previewVolumeSlider");
      const timelineScroll = document.getElementById("timelineScrollArea");
      playPauseBtn == null ? void 0 : playPauseBtn.addEventListener("click", () => this.togglePlayPause());
      restartBtn == null ? void 0 : restartBtn.addEventListener("click", () => this.seekTo(0));
      skipBackBtn == null ? void 0 : skipBackBtn.addEventListener("click", () => this.seekTo(this.state.currentTime - 5));
      skipFwdBtn == null ? void 0 : skipFwdBtn.addEventListener("click", () => this.seekTo(this.state.currentTime + 5));
      window.addEventListener("keydown", (e) => {
        if (e.code === "Space" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
          e.preventDefault();
          this.togglePlayPause();
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          if (this.storyController) {
            this.storyController.markDirtyAndSave();
            this.ui.showToast("\u{1F4BE} Project saved to device!", "success");
          } else {
            this.saveSettings();
            this.ui.showToast("Settings saved!", "success");
          }
        }
      });
      muteBtn == null ? void 0 : muteBtn.addEventListener("click", () => {
        var _a2, _b;
        this.state.isMuted = !this.state.isMuted;
        (_a2 = document.getElementById("unmutedIcon")) == null ? void 0 : _a2.classList.toggle("hidden", this.state.isMuted);
        (_b = document.getElementById("mutedIcon")) == null ? void 0 : _b.classList.toggle("hidden", !this.state.isMuted);
        if (this.voiceEngine.previewGainNode) {
          this.voiceEngine.previewGainNode.gain.value = this.state.isMuted ? 0 : this.state.previewVolume;
        }
      });
      volSlider == null ? void 0 : volSlider.addEventListener("input", (e) => {
        this.state.previewVolume = parseFloat(e.target.value);
      });
      timelineScroll == null ? void 0 : timelineScroll.addEventListener("click", (e) => {
        const rect = timelineScroll.getBoundingClientRect();
        const clickX = e.clientX - rect.left + timelineScroll.scrollLeft;
        const ratio = Math.max(0, Math.min(1, clickX / timelineScroll.scrollWidth));
        const targetTime = ratio * this.state.timelineDuration;
        this.seekTo(targetTime);
      });
      (_a = document.getElementById("fullscreenCanvasBtn")) == null ? void 0 : _a.addEventListener("click", () => {
        const viewport = document.getElementById("canvasViewport");
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          viewport == null ? void 0 : viewport.requestFullscreen();
        }
      });
    }
    togglePlayPause() {
      if (this.state.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    }
    play() {
      var _a, _b;
      if (this.state.isPlaying) return;
      this.state.isPlaying = true;
      (_a = document.getElementById("playIcon")) == null ? void 0 : _a.classList.add("hidden");
      (_b = document.getElementById("pauseIcon")) == null ? void 0 : _b.classList.remove("hidden");
      const audioCtx = this.voiceEngine.getAudioContext();
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {
        });
      }
      const startTimeWall = performance.now() / 1e3;
      this.state.playStartTime = startTimeWall;
      this.state.playStartOffset = this.state.currentTime;
      if (this.voiceEngine.audioBuffer) {
        this.voiceEngine.playPreview(this.state.currentTime, () => {
        });
      } else if (this.state.voiceMode === "A") {
        this.playTtsInSync(this.state.currentTime);
      }
      const loop = async () => {
        if (!this.state.isPlaying) return;
        const now = performance.now() / 1e3;
        const elapsed = now - this.state.playStartTime;
        const t = this.state.playStartOffset + elapsed;
        if (t >= this.state.timelineDuration) {
          this.pause();
          this.seekTo(0);
          return;
        }
        this.state.currentTime = t;
        document.getElementById("currentTimeDisplay").textContent = this.ui.formatTime(t);
        this.ui.updatePlayhead(t, this.state.timelineDuration);
        await this.renderer.renderFrame(
          t,
          this.previewCtx,
          this.state.exportWidth,
          this.state.exportHeight,
          this.state
        );
        this.animationFrameId = requestAnimationFrame(loop);
      };
      this.animationFrameId = requestAnimationFrame(loop);
    }
    playTtsInSync(startTime) {
      if (this.state.voiceMode !== "A") return;
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      if (!rawSentences.length) return;
      let startIdx = 0;
      if (this.captionEngine.chunks && this.captionEngine.chunks.length > 0) {
        const activeChunk = this.captionEngine.getCaptionAtTime(startTime);
        if (activeChunk) {
          startIdx = this.captionEngine.chunks.findIndex((c) => c.id === activeChunk.id);
          if (startIdx === -1) startIdx = 0;
        } else {
          const found = this.captionEngine.chunks.findIndex((c) => c.start >= startTime);
          startIdx = found !== -1 ? found : 0;
        }
      }
      const remainingChunks = rawSentences.slice(startIdx);
      if (!remainingChunks.length) return;
      this.voiceEngine.speakChunks(remainingChunks, this.state.ttsOptions, null, null);
    }
    pause() {
      var _a, _b;
      this.state.isPlaying = false;
      (_a = document.getElementById("playIcon")) == null ? void 0 : _a.classList.remove("hidden");
      (_b = document.getElementById("pauseIcon")) == null ? void 0 : _b.classList.add("hidden");
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.voiceEngine.stopPreview();
      this.voiceEngine.stopSpeaking();
    }
    seekTo(targetTime) {
      this.voiceEngine.stopPreview();
      this.voiceEngine.stopSpeaking();
      const clamped = Math.max(0, Math.min(targetTime, this.state.timelineDuration));
      this.state.currentTime = clamped;
      document.getElementById("currentTimeDisplay").textContent = this.ui.formatTime(clamped);
      this.ui.updatePlayhead(clamped, this.state.timelineDuration);
      if (this.state.isPlaying) {
        this.pause();
        this.play();
      } else {
        this.renderCurrentPreviewFrame();
      }
    }
    async renderCurrentPreviewFrame() {
      await this.renderer.renderFrame(
        this.state.currentTime,
        this.previewCtx,
        this.state.exportWidth,
        this.state.exportHeight,
        this.state
      );
    }
    // =========================================================================
    // Export & Project Deliverables
    // =========================================================================
    bindExportEvents() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
      const progressModal = document.getElementById("exportProgressModal");
      const progressBar = document.getElementById("exportProgressBar");
      const percentDisplay = document.getElementById("exportPercentDisplay");
      const frameDisplay = document.getElementById("exportFrameDisplay");
      const elapsedDisplay = document.getElementById("exportElapsedDisplay");
      const etaDisplay = document.getElementById("exportEtaDisplay");
      const miniCanvas = document.getElementById("exportMiniThumbCanvas");
      const cancelExportBtn = document.getElementById("cancelExportBtn");
      cancelExportBtn == null ? void 0 : cancelExportBtn.addEventListener("click", () => {
        this.exporter.cancel();
        progressModal == null ? void 0 : progressModal.classList.add("hidden");
        this.ui.showToast("Export cancelled.", "info");
      });
      const onExportProgress = (prog) => {
        progressBar.style.width = `${prog.percent}%`;
        percentDisplay.textContent = `${prog.percent}%`;
        frameDisplay.textContent = `${prog.currentFrame} / ${prog.totalFrames}`;
        elapsedDisplay.textContent = prog.elapsedText;
        etaDisplay.textContent = prog.etaText;
      };
      this.state.uiToast = (msg, type, dur) => this.ui.showToast(msg, type, dur);
      this.updateFastExportButtonLabel();
      (_a = document.getElementById("startVoiceExportBtn")) == null ? void 0 : _a.addEventListener("click", async () => {
        if (this.state.extractedFrames.length === 0) {
          this.ui.showToast("Please extract frames in Step 1 first!", "error");
          return;
        }
        if (!this.voiceEngine.audioBuffer) {
          this.ui.showToast("No voice-over loaded. Load or record your voice first.", "error");
          return;
        }
        this.pause();
        progressModal == null ? void 0 : progressModal.classList.remove("hidden");
        document.getElementById("exportProgressTitle").textContent = "Exporting Video with Voice-Over...";
        try {
          const result = await this.exporter.exportWithVoice(this.state, onExportProgress, miniCanvas);
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          if (result && result.hasAudio && !result.audioOk) {
            this.ui.showToast("Exported file has no audible audio. Check your voice file", "error");
          } else if (result && result.hasAudio) {
            this.ui.showToast(`Exported ${result.filename} (with voice)`, "success");
          } else {
            this.ui.showToast(`Exported ${result.filename} (no voice loaded: silent)`, "success");
          }
        } catch (err) {
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          this.ui.showToast(`Export stopped: ${err.message}`, "error");
        }
      });
      const ttsInstructionModal = document.getElementById("ttsExportInstructionModal");
      (_b = document.getElementById("startTtsExportBtn")) == null ? void 0 : _b.addEventListener("click", () => {
        this.exportWithNeuralTts();
      });
      (_c = document.getElementById("cancelTtsExportBtn")) == null ? void 0 : _c.addEventListener("click", () => {
        ttsInstructionModal == null ? void 0 : ttsInstructionModal.classList.add("hidden");
      });
      (_d = document.getElementById("closeTtsModalBtn")) == null ? void 0 : _d.addEventListener("click", () => {
        ttsInstructionModal == null ? void 0 : ttsInstructionModal.classList.add("hidden");
      });
      (_e = document.getElementById("confirmTtsExportBtn")) == null ? void 0 : _e.addEventListener("click", () => {
        ttsInstructionModal == null ? void 0 : ttsInstructionModal.classList.add("hidden");
        this.exportWithNeuralTts();
      });
      (_f = document.getElementById("startFastSilentExportBtn")) == null ? void 0 : _f.addEventListener("click", async () => {
        if (this.state.extractedFrames.length === 0) {
          this.ui.showToast("Please extract frames in Step 1 first!", "error");
          return;
        }
        this.pause();
        progressModal == null ? void 0 : progressModal.classList.remove("hidden");
        const hasVoice2 = !!this.voiceEngine.audioBuffer;
        document.getElementById("exportProgressTitle").textContent = hasVoice2 ? "Fast Encoding Video & Voice (WebCodecs)..." : "Fast Encoding Frames (WebCodecs)...";
        try {
          const result = await this.exporter.exportFastSilent(this.state, onExportProgress, miniCanvas);
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          if (result && result.hasAudio && !result.audioOk) {
            this.ui.showToast("Exported file has no audible audio. Check your voice file", "error");
          } else if (result && result.hasAudio) {
            this.ui.showToast(`Exported ${result.filename} (with voice)`, "success");
          } else {
            this.ui.showToast(`Exported ${result.filename} (no voice loaded: silent)`, "success");
          }
        } catch (err) {
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          this.ui.showToast(`Fast render stopped: ${err.message}`, "error");
        }
      });
      (_g = document.getElementById("downloadSrtBtn")) == null ? void 0 : _g.addEventListener("click", () => {
        const srt = this.captionEngine.generateSRT();
        this.captionEngine.downloadFile(srt, "captions.srt", "text/plain");
      });
      (_h = document.getElementById("downloadVttBtn")) == null ? void 0 : _h.addEventListener("click", () => {
        const vtt = this.captionEngine.generateVTT();
        this.captionEngine.downloadFile(vtt, "captions.vtt", "text/vtt");
      });
      (_i = document.getElementById("downloadTxtBtn")) == null ? void 0 : _i.addEventListener("click", () => {
        const txt = this.captionEngine.generateTXT();
        this.captionEngine.downloadFile(txt, "script.txt", "text/plain");
      });
      (_j = document.getElementById("downloadJsonBtn")) == null ? void 0 : _j.addEventListener("click", () => {
        this.saveProjectFile();
      });
    }
    /**
     * One-click TTS video export flow:
     * (a) generateVoiceFromScript via local neural TTS
     * (b) update timeline and captions
     * (c) run exportFastSilent with WebCodecs audio/video encoding
     */
    async exportWithNeuralTts() {
      if (this.state.extractedFrames.length === 0) {
        this.ui.showToast("Please extract frames in Step 1 first!", "error");
        return;
      }
      const scriptText = (this.state.scriptText || "").trim();
      if (!scriptText) {
        this.ui.showToast("Please enter your script first in Step 2 before exporting.", "error");
        return;
      }
      const rawSentences = this.captionEngine.splitScriptIntoSentences(scriptText);
      if (!rawSentences.length) {
        this.ui.showToast("Please enter your script first in Step 2 before exporting.", "error");
        return;
      }
      this.pause();
      const progressModal = document.getElementById("exportProgressModal");
      const progressBar = document.getElementById("exportProgressBar");
      const percentDisplay = document.getElementById("exportPercentDisplay");
      const frameDisplay = document.getElementById("exportFrameDisplay");
      const elapsedDisplay = document.getElementById("exportElapsedDisplay");
      const etaDisplay = document.getElementById("exportEtaDisplay");
      const miniCanvas = document.getElementById("exportMiniThumbCanvas");
      const progressTitle = document.getElementById("exportProgressTitle");
      progressModal == null ? void 0 : progressModal.classList.remove("hidden");
      if (progressTitle) progressTitle.textContent = "Generating Natural Voice (Neural TTS)...";
      if (progressBar) progressBar.style.width = "0%";
      if (percentDisplay) percentDisplay.textContent = "0%";
      if (frameDisplay) frameDisplay.textContent = "Preparing TTS audio...";
      if (elapsedDisplay) elapsedDisplay.textContent = "0s";
      if (etaDisplay) etaDisplay.textContent = "...";
      const onExportProgress = (prog) => {
        if (progressBar) progressBar.style.width = `${prog.percent}%`;
        if (percentDisplay) percentDisplay.textContent = `${prog.percent}%`;
        if (frameDisplay) frameDisplay.textContent = `${prog.currentFrame} / ${prog.totalFrames}`;
        if (elapsedDisplay) elapsedDisplay.textContent = prog.elapsedText;
        if (etaDisplay) etaDisplay.textContent = prog.etaText;
      };
      try {
        const ttsOpts = this.getTtsOptions();
        let selectedVoice = ttsOpts.voice;
        const isHindi = /[\u0900-\u097F]/.test(scriptText);
        if (isHindi && (!selectedVoice || selectedVoice.startsWith("en-") || !selectedVoice.includes("hi-IN"))) {
          selectedVoice = "hi-IN-SwaraNeural";
          const voiceSelect = document.getElementById("ttsVoiceSelect");
          if (voiceSelect) voiceSelect.value = selectedVoice;
          ttsOpts.voice = selectedVoice;
        } else if (!selectedVoice || !selectedVoice.includes("Neural")) {
          selectedVoice = isHindi ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
          ttsOpts.voice = selectedVoice;
        }
        let ttsResult;
        try {
          ttsResult = await this.voiceEngine.generateVoiceFromScript(rawSentences, {
            voice: selectedVoice,
            rate: ttsOpts.rate,
            pitch: ttsOpts.pitch,
            volume: ttsOpts.volume,
            onProgress: (current, total, sentenceText) => {
              if (frameDisplay) frameDisplay.textContent = `Synthesizing sentence ${current}/${total}...`;
              if (percentDisplay) percentDisplay.textContent = `${Math.round(current / total * 30)}%`;
              if (progressBar) progressBar.style.width = `${Math.round(current / total * 30)}%`;
            }
          });
        } catch (ttsErr) {
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          console.error("[TTS Generation Error in Export]", ttsErr);
          this.ui.showToast(`Voice generation failed: ${ttsErr.message}`, "error", 7e3);
          return;
        }
        if (!ttsResult || !ttsResult.buffer) {
          progressModal == null ? void 0 : progressModal.classList.add("hidden");
          this.ui.showToast("Voice generation failed: No audio buffer returned from TTS service.", "error", 7e3);
          return;
        }
        const voiceDur = Math.ceil(ttsResult.buffer.duration);
        this.state.timelineDuration = voiceDur;
        const durInput = document.getElementById("timelineDurationInput");
        if (durInput) durInput.value = voiceDur;
        const existingChunks = this.captionEngine.chunks || [];
        this.captionEngine.chunks = ttsResult.sentenceTimings.map((st, idx) => {
          const prev = existingChunks[idx];
          if (prev && prev.isManuallyEdited && prev.text.trim() === st.text.trim()) {
            return {
              ...prev,
              start: prev.start,
              end: prev.end,
              duration: prev.duration,
              isManuallyEdited: true
            };
          }
          return {
            id: `cap_${idx + 1}`,
            index: idx + 1,
            text: st.text,
            start: st.start,
            end: st.end,
            duration: st.duration,
            isManuallyEdited: false
          };
        });
        this.onVoiceLoaded(ttsResult.buffer, "tts_voice.wav", true);
        this.ui.renderCaptionChunks(this.captionEngine.chunks, {
          onUpdateChunk: (idx, data) => {
            if (this.captionEngine.chunks[idx]) {
              Object.assign(this.captionEngine.chunks[idx], data);
              this.captionEngine.chunks[idx].duration = data.end - data.start;
              this.captionEngine.chunks[idx].isManuallyEdited = true;
              this.rebuildTimeline();
            }
          },
          onDeleteChunk: (idx) => {
            this.captionEngine.chunks.splice(idx, 1);
            this.rebuildTimeline();
          }
        });
        this.rebuildTimeline();
        this.updateFastExportButtonLabel();
        if (progressTitle) progressTitle.textContent = "Fast Encoding Video & Voice (WebCodecs)...";
        const result = await this.exporter.exportFastSilent(this.state, onExportProgress, miniCanvas);
        progressModal == null ? void 0 : progressModal.classList.add("hidden");
        if (result && result.hasAudio && !result.audioOk) {
          this.ui.showToast("Exported file has no audible audio. Check your voice file", "error");
        } else if (result && result.hasAudio) {
          this.ui.showToast(`Exported ${result.filename} (with voice)`, "success");
        } else {
          this.ui.showToast(`Exported ${result.filename}`, "success");
        }
      } catch (err) {
        progressModal == null ? void 0 : progressModal.classList.add("hidden");
        console.error("[Export Error]", err);
        this.ui.showToast(`Export stopped: ${err.message}`, "error", 7e3);
      } finally {
        progressModal == null ? void 0 : progressModal.classList.add("hidden");
      }
    }
    // =========================================================================
    // Project Serialization & Reset
    // =========================================================================
    bindProjectEvents() {
      var _a, _b;
      (_a = document.getElementById("saveProjectBtn")) == null ? void 0 : _a.addEventListener("click", () => {
        this.saveProjectFile();
      });
      const loadInput = document.getElementById("loadProjectInput");
      loadInput == null ? void 0 : loadInput.addEventListener("change", async (e) => {
        if (e.target.files && e.target.files[0]) {
          try {
            const projectData = await importProjectJson(e.target.files[0]);
            this.restoreProjectFile(projectData);
            this.ui.showToast("Project JSON loaded. Please re-attach source video to re-extract frames.", "info", 5e3);
          } catch (err) {
            this.ui.showToast(`Failed to load project: ${err.message}`, "error");
          }
        }
      });
      (_b = document.getElementById("resetAppBtn")) == null ? void 0 : _b.addEventListener("click", () => {
        if (confirm("Are you sure you want to reset all data and start a new project?")) {
          this.clearAllExtractedFrames();
          location.reload();
        }
      });
    }
    saveProjectFile() {
      const project = {
        version: "1.0",
        savedAt: (/* @__PURE__ */ new Date()).toISOString(),
        scriptText: this.state.scriptText,
        captionChunks: this.captionEngine.chunks,
        settings: {
          aspectRatio: this.state.aspectRatio,
          customNorm: this.state.customNorm,
          durationMode: this.state.durationMode,
          customDuration: this.state.customDuration,
          photoMinDuration: this.state.photoMinDuration,
          photoMaxDuration: this.state.photoMaxDuration,
          enabledAnimations: this.state.enabledAnimations,
          maxZoom: this.state.maxZoom,
          transitionDuration: this.state.transitionDuration,
          transitionType: this.state.transitionType,
          captionStyle: this.state.captionStyle,
          overlays: this.state.overlays,
          colorGrading: this.state.colorGrading
        },
        frameTimestamps: this.state.extractedFrames.map((f) => ({
          timestamp: f.timestamp,
          sourceMinute: f.sourceMinute,
          starred: f.starred
        }))
      };
      exportProjectJson(project);
      this.ui.showToast("Saved project JSON file.", "success");
    }
    restoreProjectFile(project) {
      if (!project || !project.settings) return;
      if (project.scriptText) {
        document.getElementById("scriptTextarea").value = project.scriptText;
        this.handleScriptChange(project.scriptText);
      }
      if (project.captionChunks) {
        this.captionEngine.chunks = project.captionChunks;
      }
      Object.assign(this.state.captionStyle, project.settings.captionStyle || {});
      Object.assign(this.state.overlays, project.settings.overlays || {});
      Object.assign(this.state.colorGrading, project.settings.colorGrading || {});
      if (project.settings.customNorm) {
        this.state.customNorm = project.settings.customNorm;
      }
      if (project.settings.aspectRatio) {
        this.setAspectRatio(project.settings.aspectRatio);
      }
      this.rebuildTimeline();
    }
  };
  function initApp() {
    if (!window.app) {
      const app = new FrameFlowApp();
      window.app = app;
      window.superPower = app;
      app.init();
    }
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
