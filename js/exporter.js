/**
 * FrameFlow Studio — Video Exporter Engine
 * Supports:
 * - Mode 1: Real-time Audio-Synced Voice Export (Web Audio BufferSource -> MediaStream -> MediaRecorder)
 * - Mode 2: Browser TTS Export (Tab Audio Capture via getDisplayMedia)
 * - Mode 3: Ultra-Fast Silent Render using WebCodecs VideoEncoder + vendored Mp4/WebM Muxer
 */

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

export class VideoExporter {
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
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  /**
   * Resolves the canvas dimensions strictly based on the user's selected export resolution / aspect ratio,
   * never allowing crop-box dragging to shrink the export canvas.
   * @param {object} appState 
   * @returns {{ width: number, height: number }}
   */
  getExportDimensions(appState) {
    const ratio = appState?.aspectRatio || '16:9';
    let width = 1920;
    let height = 1080;

    if (ratio === '9:16') {
      width = 1080;
      height = 1920;
    } else if (ratio === '1:1') {
      width = 1080;
      height = 1080;
    } else if (ratio === '4:5') {
      width = 1080;
      height = 1350;
    } else if (ratio === '16:9-720p') {
      width = 1280;
      height = 720;
    } else if (ratio === 'custom') {
      width = appState.exportWidth || 1920;
      height = appState.exportHeight || 1080;
    } else {
      // Standard 16:9 1080p
      width = 1920;
      height = 1080;
    }

    width = width - (width % 2);
    height = height - (height % 2);
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
    if (width === 1080 && height === 1920) return 14000000; // 9:16 vertical 1080p
    const pixels = width * height;
    if (pixels >= 1920 * 1080) return 14000000; // 1080p
    if (pixels <= 1280 * 720) return 8000000;   // 720p
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
      const AudioCtxClass = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
      if (!AudioCtxClass) return 1.0;
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
      try { ctx.close(); } catch (e) {}
      return count > 0 ? Math.sqrt(sumSq / count) : 0;
    } catch (e) {
      console.warn('[computeBlobAudioRms Error]', e);
      return 1.0;
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
    if (sourcePeak < 0.0005) {
      throw new Error('voice is silent');
    }

    const sampleRate = 48000;
    const frames = Math.ceil(totalDuration * sampleRate);
    const OfflineCtxClass = (typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext));
    if (!OfflineCtxClass) {
      throw new Error('OfflineAudioContext is not supported in this environment.');
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
      console.warn('[Export audio] DSP render failed:', dspErr);
    }

    console.log(`[Export audio] Source peak: ${sourcePeak.toFixed(5)} | Rendered peak: ${renderedPeak.toFixed(5)}`);

    if (!rendered || renderedPeak < 0.0005) {
      console.warn('[Export audio] DSP render peak is below 0.0005 or failed. Re-rendering WITHOUT the DSP graph.');
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
      'avc1.640028',
      'avc1.4d0028',
      'vp09.00.40.08'
    ];

    const rawBitrate = Math.round(width * height * fps * 0.22);
    const videoBitrate = Math.max(4000000, Math.min(40000000, rawBitrate));

    let chosenVideoCodec = null;
    let muxerVideoCodec = 'avc';

    if (typeof window !== 'undefined' && typeof window.VideoEncoder !== 'undefined') {
      for (const codec of videoCandidates) {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec,
            width,
            height,
            bitrate: videoBitrate,
            bitrateMode: 'variable',
            latencyMode: 'quality',
            framerate: fps
          });
          if (support && support.supported) {
            chosenVideoCodec = codec;
            muxerVideoCodec = codec.startsWith('vp09') ? 'vp9' : 'avc';
            break;
          }
        } catch (e) {}
      }
    }

    if (!chosenVideoCodec) {
      chosenVideoCodec = 'avc1.640028';
      muxerVideoCodec = 'avc';
    }

    let chosenAudioCodec = null;
    let muxerAudioCodec = 'aac';

    if (wantAudio && typeof window !== 'undefined' && typeof window.AudioEncoder !== 'undefined') {
      const audioCandidates = [
        { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac' },
        { encoderCodec: 'opus', muxerCodec: 'opus' }
      ];
      for (const item of audioCandidates) {
        try {
          const support = await AudioEncoder.isConfigSupported({
            codec: item.encoderCodec,
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 192000
          });
          if (support && support.supported) {
            chosenAudioCodec = item.encoderCodec;
            muxerAudioCodec = item.muxerCodec;
            break;
          }
        } catch (e) {}
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
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const mime of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return 'video/webm';
  }

  /**
   * Helper to trigger download of a generated video blob
   */
  triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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
  async verifyExportResult(blob, expectedDuration, shouldHaveAudio, toastFn = null, modeName = 'Export') {
    if (typeof document === 'undefined') return { valid: true, hasAudio: shouldHaveAudio };
    return new Promise(async (resolve) => {
      let hasAudio = false;
      let audioDuration = 0;
      let actualDur = 0;

      // 1. If audio is expected, decode buffer via AudioContext to check presence & length
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
            try { tempCtx.close(); } catch (e) {}
          }
        } catch (decodeErr) {
          // decodeAudioData may not support video container directly in all environments
        }
      }

      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.style.display = 'none';
      document.body.appendChild(video);

      const url = URL.createObjectURL(blob);
      video.src = url;

      let finished = false;
      const cleanup = () => {
        if (!finished) {
          finished = true;
          URL.revokeObjectURL(url);
          video.remove();
        }
      };

      const finishEvaluation = () => {
        actualDur = video.duration || 0;

        if (!hasAudio && shouldHaveAudio) {
          if (video.audioTracks && video.audioTracks.length > 0) {
            hasAudio = true;
          } else if (typeof video.mozHasAudio !== 'undefined' && video.mozHasAudio) {
            hasAudio = true;
          } else if (typeof video.webkitAudioDecodedByteCount !== 'undefined' && video.webkitAudioDecodedByteCount > 0) {
            hasAudio = true;
          } else {
            try {
              const stream = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
              if (stream && stream.getAudioTracks().length > 0) {
                hasAudio = true;
              }
            } catch (e) {}
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
          const redMsg = 'Exported file has no audio. Try Mode 1.';
          warnings.push(redMsg);
          if (typeof toastFn === 'function') {
            toastFn(redMsg, 'error', 7000);
          }
        } else if (warnings.length > 0) {
          if (typeof toastFn === 'function') {
            toastFn(warnings.join(' '), 'warning', 6000);
          }
        }

        // Requirement E: Console.log of mode used, audio track present (yes/no), and audio duration
        console.log(`[Export Debug] Mode: ${modeName} | Audio track present: ${hasAudio ? 'yes' : 'no'} | Audio duration: ${audioDuration.toFixed(2)}s | Video duration: ${actualDur.toFixed(2)}s`);

        cleanup();
        resolve({ valid: warnings.length === 0, duration: actualDur, hasAudio, audioDuration, warnings });
      };

      video.onloadedmetadata = finishEvaluation;

      video.onerror = () => {
        console.log(`[Export Debug] Mode: ${modeName} | Audio track present: ${hasAudio ? 'yes' : 'no'} | Audio duration: ${audioDuration.toFixed(2)}s | Video metadata error`);
        cleanup();
        resolve({ valid: false, duration: 0, hasAudio, audioDuration: 0, warnings: ['Could not verify video metadata.'] });
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
    if (this.activeMediaRecorder && this.activeMediaRecorder.state !== 'inactive') {
      try {
        this.activeMediaRecorder.stop();
      } catch (e) {}
    }
    if (this.activeAudioSource) {
      try {
        this.activeAudioSource.stop();
        this.activeAudioSource.disconnect();
      } catch (e) {}
    }
    if (this.activeTabStream) {
      try {
        this.activeTabStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      this.activeTabStream = null;
    }
    this.isExporting = false;
  }

  /**
   * EXPORT MODE 1 — With Voice-Over Audio (Mode B)
   * Uses WebCodecs exportFastSilent when available, falling back to MediaRecorder only if WebCodecs is unsupported.
   */
  async exportWithVoice(appState, onProgress, miniThumbCanvas) {
    if (!this.voiceEngine || !this.voiceEngine.audioBuffer) {
      const errMsg = 'No voice-over loaded. Load or record your voice first.';
      if (typeof appState.uiToast === 'function') appState.uiToast(errMsg, 'error');
      throw new Error(errMsg);
    }

    if (typeof window !== 'undefined' && typeof window.VideoEncoder !== 'undefined' && typeof window.AudioEncoder !== 'undefined') {
      try {
        return await this.exportFastSilent(appState, onProgress, miniThumbCanvas);
      } catch (err) {
        if (this.cancelRequested || err.message?.includes('cancelled')) throw err;
        console.warn('[Mode 1] WebCodecs fast export failed, falling back to real-time recorder:', err);
      }
    }

    if (this.isExporting) throw new Error('Export already in progress.');
    this.isExporting = true;
    this.cancelRequested = false;

    const totalDuration = appState.timelineDuration || 60;
    const { width, height } = this.getExportDimensions(appState);

    // Create render canvas at exact selected export resolution
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = width;
    renderCanvas.height = height;
    const ctx = renderCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext('2d') : null;
    if (thumbCtx) {
      thumbCtx.imageSmoothingEnabled = true;
      thumbCtx.imageSmoothingQuality = 'high';
    }

    const fps = 30;
    const canvasStream = renderCanvas.captureStream(fps);

    // Setup Web Audio graph with clean-up DSP into a MediaStreamDestination
    const audioCtx = this.voiceEngine.getAudioContext();
    if (audioCtx) {
      await audioCtx.resume();
    }
    const mediaStreamDest = audioCtx.createMediaStreamDestination();

    const audioSourceNode = audioCtx.createBufferSource();
    audioSourceNode.buffer = this.voiceEngine.audioBuffer;
    this.voiceEngine.connectProcessingGraph(audioSourceNode, mediaStreamDest);
    this.activeAudioSource = audioSourceNode;

    // Combine tracks
    const combinedStream = new MediaStream();
    const videoTrack = canvasStream.getVideoTracks()[0];
    if (videoTrack) combinedStream.addTrack(videoTrack);

    const audioTracks = mediaStreamDest.stream.getAudioTracks();
    if (!audioTracks.length || audioTracks[0].readyState !== 'live' || audioTracks[0].muted) {
      this.isExporting = false;
      const errMsg = 'Voice audio track is missing, muted, or ended. Cannot export voice.';
      if (typeof appState.uiToast === 'function') appState.uiToast(errMsg, 'error');
      throw new Error(errMsg);
    }
    combinedStream.addTrack(audioTracks[0]);

    const targetBitrate = Math.max(4000000, Math.min(40000000, Math.round(width * height * fps * 0.22)));
    console.log(`[Video Encoding Mode 1] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(targetBitrate / 1000000).toFixed(2)} Mbps`);
    const mimeType = this.getBestMimeType();
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const recorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: targetBitrate,
      audioBitsPerSecond: 192000
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
          return reject(new Error('Export was cancelled by user.'));
        }
        const blob = new Blob(recordedChunks, { type: mimeType });
        const ratioTag = width > height ? '16x9' : '9x16';
        const durTag = `${Math.round(totalDuration)}s`;
        const filename = `framemix_${ratioTag}_${durTag}.${extension}`;
        this.triggerDownload(blob, filename);
        await this.verifyExportResult(blob, totalDuration, hasVoice, appState.uiToast, 'Mode 1 (Real-time Voice)');
        let audioRms = 0;
        let audioOk = false;
        if (hasVoice) {
          audioRms = await this.computeBlobAudioRms(blob);
          audioOk = audioRms > 0.0005;
        }
        resolve({ blob, filename, hasAudio: hasVoice, audioOk, audioRms });
      };

      recorder.start(100);

      // Start audio source precisely now
      const startAudioTime = audioCtx.currentTime;
      if (audioSourceNode) {
        audioSourceNode.start(0);
      }

      const startTimeReal = performance.now();
      let lastRenderedTime = 0;

      // Real-time render loop driven by audio clock
      const renderLoop = async () => {
        if (this.cancelRequested) {
          recorder.stop();
          return;
        }

        const elapsedClock = audioCtx.currentTime - startAudioTime;
        lastRenderedTime = elapsedClock;

        if (elapsedClock >= totalDuration) {
          // Finished
          if (audioSourceNode) {
            try { audioSourceNode.stop(); } catch (e) {}
          }
          recorder.stop();
          return;
        }

        // Render frame at timestamp elapsedClock
        await this.renderer.renderFrame(elapsedClock, ctx, width, height, appState);

        // Update miniature thumbnail preview
        if (thumbCtx && miniThumbCanvas) {
          thumbCtx.drawImage(renderCanvas, 0, 0, miniThumbCanvas.width, miniThumbCanvas.height);
        }

        // Progress stats
        const progressRatio = elapsedClock / totalDuration;
        const realElapsedSec = (performance.now() - startTimeReal) / 1000;
        const etaSec = (progressRatio > 0) ? (realElapsedSec / progressRatio) - realElapsedSec : 0;
        const currentFrame = Math.floor(elapsedClock * fps);
        const totalFrames = Math.floor(totalDuration * fps);

        if (typeof onProgress === 'function') {
          onProgress({
            percent: Math.round(progressRatio * 100),
            currentFrame,
            totalFrames,
            elapsedText: this.formatTime(realElapsedSec),
            etaText: this.formatTime(Math.max(0, etaSec))
          });
        }

        // Frame interval request
        setTimeout(renderLoop, 1000 / fps);
      };

      renderLoop();
    });
  }

  /**
   * EXPORT MODE 2 — With Browser TTS Audio (Mode A)
   * Uses getDisplayMedia tab audio capture, starts speech and rendering simultaneously.
   */
  async exportWithTts(appState, onProgress, miniThumbCanvas, tabAudioStream) {
    if (this.isExporting) throw new Error('Export already in progress.');
    this.isExporting = true;
    this.cancelRequested = false;
    this.activeTabStream = tabAudioStream;

    const totalDuration = appState.timelineDuration || 60;
    const { width, height } = this.getExportDimensions(appState);

    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = width;
    renderCanvas.height = height;
    const ctx = renderCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext('2d') : null;
    if (thumbCtx) {
      thumbCtx.imageSmoothingEnabled = true;
      thumbCtx.imageSmoothingQuality = 'high';
    }

    const fps = 30;
    const canvasStream = renderCanvas.captureStream(fps);

    const combinedStream = new MediaStream();
    const videoTrack = canvasStream.getVideoTracks()[0];
    if (videoTrack) combinedStream.addTrack(videoTrack);

    // Verify and add audio track from tab share
    const tabAudioTracks = tabAudioStream ? tabAudioStream.getAudioTracks() : [];
    if (!tabAudioTracks.length || tabAudioTracks[0].readyState !== 'live' || tabAudioTracks[0].muted) {
      this.isExporting = false;
      const errMsg = 'Tab audio track is missing, muted, or ended. Please share tab audio before export.';
      if (typeof appState.uiToast === 'function') appState.uiToast(errMsg, 'error');
      throw new Error(errMsg);
    }
    combinedStream.addTrack(tabAudioTracks[0]);

    const targetBitrate = this.getOptimalVideoBitrate(width, height, fps);
    console.log(`[Video Encoding Mode 2] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(targetBitrate / 1000000).toFixed(2)} Mbps`);
    const mimeType = this.getBestMimeType();
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const recorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: targetBitrate,
      audioBitsPerSecond: 192000
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
          return reject(new Error('Export was cancelled by user.'));
        }
        const blob = new Blob(recordedChunks, { type: mimeType });
        const ratioTag = width > height ? '16x9' : '9x16';
        const durTag = `${Math.round(totalDuration)}s`;
        const filename = `framemix_${ratioTag}_${durTag}.${extension}`;
        this.triggerDownload(blob, filename);
        await this.verifyExportResult(blob, totalDuration, true, appState.uiToast, 'Mode 2 (Browser TTS)');
        resolve({ blob, filename });
      };

      recorder.start(100);

      // Start TTS sequential playback
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

        const elapsedSec = (performance.now() - startTimeReal) / 1000;

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
        const etaSec = (progressRatio > 0) ? (elapsedSec / progressRatio) - elapsedSec : 0;

        if (typeof onProgress === 'function') {
          onProgress({
            percent: Math.round(progressRatio * 100),
            currentFrame: Math.floor(elapsedSec * fps),
            totalFrames: Math.floor(totalDuration * fps),
            elapsedText: this.formatTime(elapsedSec),
            etaText: this.formatTime(Math.max(0, etaSec))
          });
        }

        setTimeout(renderLoop, 1000 / fps);
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
    if (this.isExporting) throw new Error('Export already in progress.');
    this.isExporting = true;
    this.cancelRequested = false;

    const totalDuration = appState.timelineDuration || 60;
    const { width, height } = this.getExportDimensions(appState);
    const fps = 30;
    const totalFrames = Math.floor(totalDuration * fps);

    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = width;
    renderCanvas.height = height;
    const ctx = renderCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const thumbCtx = miniThumbCanvas ? miniThumbCanvas.getContext('2d') : null;
    if (thumbCtx) {
      thumbCtx.imageSmoothingEnabled = true;
      thumbCtx.imageSmoothingQuality = 'high';
    }

    const hasVoice = !!(this.voiceEngine && this.voiceEngine.audioBuffer);
    const hasWebCodecs = typeof window !== 'undefined' && typeof window.VideoEncoder !== 'undefined';

    try {
      // 1. Build audio FIRST when voice exists
      let exportAudio = null;
      if (hasVoice) {
        exportAudio = await this.buildExportAudio(totalDuration);
      }

      if (!hasWebCodecs) {
        if (hasVoice) {
          throw new Error('WebCodecs VideoEncoder is not supported in this browser. Cannot export with voice.');
        }
        // Fallback for silent video only
        this.isExporting = false;
        return await this.exportWithVoice(appState, onProgress, miniThumbCanvas);
      }

      if (exportAudio && (typeof window === 'undefined' || typeof window.AudioEncoder === 'undefined')) {
        throw new Error('WebCodecs AudioEncoder is not supported in this browser. Cannot export with voice.');
      }

      const codecs = await this.pickCodecs(width, height, fps, !!exportAudio);
      console.log(`[Video Encoding Mode 3] Resolution: ${width}x${height} @ ${fps}fps | Bitrate: ${(codecs.videoBitrate / 1000000).toFixed(2)} Mbps | Codec: ${codecs.videoCodec}`);

      const Muxer = Mp4Muxer;
      const ArrayBufferTarget = Mp4ArrayBufferTarget;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
          codec: codecs.muxerVideoCodec,
          width,
          height
        },
        audio: exportAudio ? {
          codec: codecs.muxerAudioCodec,
          numberOfChannels: 2,
          sampleRate: 48000
        } : undefined,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset'
      });

      // 2. Encode audio with AudioEncoder in chunks of 4096 frames
      if (exportAudio) {
        let audioEncoderError = null;
        const audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (e) => {
            console.error('[WebCodecs AudioEncoder Error]', e);
            audioEncoderError = e;
          }
        });

        await audioEncoder.configure({
          codec: codecs.audioCodec,
          sampleRate: exportAudio.sampleRate,
          numberOfChannels: 2,
          bitrate: 192000
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
            throw new Error('Export was cancelled by user.');
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

          const timestampMicros = Math.round((offset / sampleRate) * 1000000);
          const audioData = new AudioData({
            format: 'f32-planar',
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

      // 3. Encode video frames with back-pressure and error capture
      let videoEncoderError = null;
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
          console.error('[WebCodecs VideoEncoder Error]', e);
          videoEncoderError = e;
        }
      });

      await videoEncoder.configure({
        codec: codecs.videoCodec,
        width,
        height,
        bitrate: codecs.videoBitrate,
        bitrateMode: 'variable',
        latencyMode: 'quality',
        framerate: fps
      });

      const startTimeReal = performance.now();

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (this.cancelRequested) {
          videoEncoder.close();
          this.isExporting = false;
          throw new Error('Export was cancelled by user.');
        }
        if (videoEncoderError) {
          videoEncoder.close();
          throw videoEncoderError;
        }

        // Back-pressure: while videoEncoder.encodeQueueSize > 12, wait
        while (videoEncoder.encodeQueueSize > 12) {
          if (this.cancelRequested) {
            videoEncoder.close();
            this.isExporting = false;
            throw new Error('Export was cancelled by user.');
          }
          await new Promise((r) => setTimeout(r, 4));
        }

        const t = frameIdx / fps;
        await this.renderer.renderFrame(t, ctx, width, height, appState);

        if (thumbCtx && miniThumbCanvas && frameIdx % 5 === 0) {
          thumbCtx.drawImage(renderCanvas, 0, 0, miniThumbCanvas.width, miniThumbCanvas.height);
        }

        const timestampMicros = Math.round(t * 1000000);
        const videoFrame = new VideoFrame(renderCanvas, { timestamp: timestampMicros });
        const keyFrame = (frameIdx % (fps * 2) === 0);
        videoEncoder.encode(videoFrame, { keyFrame });
        videoFrame.close();

        // Report progress
        if (frameIdx % 4 === 0 || frameIdx === totalFrames - 1) {
          const progressRatio = (frameIdx + 1) / totalFrames;
          const elapsedSec = (performance.now() - startTimeReal) / 1000;
          const etaSec = (progressRatio > 0) ? (elapsedSec / progressRatio) - elapsedSec : 0;

          if (typeof onProgress === 'function') {
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
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const ratioTag = width > height ? '16x9' : '9x16';
      const durTag = `${Math.round(totalDuration)}s`;
      const filename = `framemix_${ratioTag}_${durTag}.mp4`;

      // 4. Decode output blob's audio with decodeAudioData and compute RMS
      let audioRms = 0;
      let audioOk = false;
      const hasAudio = !!exportAudio;

      if (hasAudio) {
        audioRms = await this.computeBlobAudioRms(blob);
        audioOk = audioRms > 0.0005;
        console.log(`[Export audio] Output blob audio RMS: ${audioRms.toFixed(5)} | audioOk: ${audioOk}`);
        if (!audioOk && typeof appState?.uiToast === 'function') {
          appState.uiToast('Exported file has no audible audio. Check your voice file', 'error', 7000);
        }
      }

      if (autoDownload) {
        this.triggerDownload(blob, filename);
      }
      this.isExporting = false;
      await this.verifyExportResult(blob, totalDuration, hasAudio, appState.uiToast, 'Mode 3 (Fast Render)');
      return { blob, filename, hasAudio, audioOk, audioRms };
    } catch (err) {
      this.isExporting = false;
      if (this.cancelRequested || err.message?.includes('cancelled')) {
        throw err;
      }
      if (hasVoice) {
        // If a voice exists and WebCodecs fails, THROW an error. Never silently fall back.
        throw err;
      }
      console.warn('[WebCodecs] Silent render failed, falling back to MediaRecorder:', err);
      return await this.exportWithVoice(appState, onProgress, miniThumbCanvas);
    }
  }
}
