/**
 * FrameFlow Studio — Main Application Controller (ES Module)
 * Orchestrates all modules, handles user interactions, manages reactive state,
 * runs the live preview loop, and wires up exporters.
 */

import { FrameExtractor } from './extractor.js';
import { VoiceEngine } from './voice.js';
import { CaptionEngine } from './captions.js';
import { TimelineEngine } from './timeline.js';
import { FrameRenderer } from './renderer.js';
import { VideoExporter } from './exporter.js';
import { UIController } from './ui.js';
import { saveSetting, loadSetting, exportProjectJson, importProjectJson } from './storage.js';
import { YouTubeMetaGenerator } from './youtube.js';
import { GeminiClient } from './gemini.js';
import { StoryFlowController } from './story_controller.js';

export const TONE_PRESETS = {
  normal: { rate: 1.0, pitch: 1.0, label: 'Normal / Default' },
  storytelling: { rate: 0.95, pitch: 0.95, label: 'Storytelling / Narrative' },
  dramatic: { rate: 0.85, pitch: 0.85, label: 'Dramatic / Cinema' },
  serious: { rate: 0.90, pitch: 0.85, label: 'Serious / Documentary' },
  energetic: { rate: 1.30, pitch: 1.10, label: 'High Energy / Reels' },
  fastreels: { rate: 1.60, pitch: 1.05, label: 'Fast Narration / Shorts' },
  hyper2x: { rate: 2.00, pitch: 1.00, label: 'Ultra Speed 2.0x' },
  max25x: { rate: 2.50, pitch: 1.05, label: 'Maximum Speed 2.5x' },
  deep: { rate: 0.90, pitch: 0.75, label: 'Deep Voice / Radio Host' },
  calm: { rate: 0.80, pitch: 0.90, label: 'Calm & Meditative' },
  soft: { rate: 0.85, pitch: 0.90, label: 'Soft / Emotional' },
  news: { rate: 1.15, pitch: 1.05, label: 'News Anchor / Broadcast' },
  casual: { rate: 1.10, pitch: 1.00, label: 'Casual Conversation' }
};

class FrameFlowApp {
  constructor() {
    // DOM Elements
    this.sourceVideo = document.getElementById('sourceVideo');
    this.offscreenCanvas = document.getElementById('offscreenCanvas');
    this.previewCanvas = document.getElementById('previewCanvas');
    this.previewCtx = this.previewCanvas.getContext('2d');

    // Engine Modules
    this.ui = new UIController();
    this.extractor = new FrameExtractor(this.sourceVideo, this.offscreenCanvas);
    this.voiceEngine = new VoiceEngine();
    this.captionEngine = new CaptionEngine();
    this.timelineEngine = new TimelineEngine();
    this.renderer = new FrameRenderer(this.extractor);
    this.exporter = new VideoExporter(this.renderer, this.voiceEngine, this.captionEngine);
    this.gemini = new GeminiClient();
    this.storyController = new StoryFlowController(this);

    // Application State
    this.state = {
      currentStep: 1,
      sourceVideoLoaded: false,
      extractedFrames: [],
      filterStarredOnly: false,

      // Extraction Resolution & Watermark
      extractResolutionMode: '1080p',
      customExtractWidth: 1920,
      customExtractHeight: 1080,
      watermark: {
        enabled: false,
        type: 'text',
        text: '@StoryFlow',
        style: 'dark-pill',
        imageElement: null,
        position: 'bottom-right',
        size: 'medium',
        opacity: 0.85
      },

      // Voice & Script
      voiceMode: 'B', // 'B' (My voice) or 'A' (TTS)
      scriptText: '',
      silenceGaps: [],

      // Timeline & Duration
      durationMode: 'match-voice', // 'match-voice' | '600' | '720' | '900' | '960' | '1200' | 'custom'
      customDuration: 60,
      timelineDuration: 60,
      photoMinDuration: 4.0,
      photoMaxDuration: 8.0,
      enabledAnimations: ['zoom-in', 'zoom-out', 'pan-lr', 'pan-rl', 'pan-up', 'pan-down', 'diagonal'],
      maxZoom: 1.25,
      transitionDuration: 0.6,
      transitionType: 'crossfade',

      // Aspect Ratio & Layout
      aspectRatio: '16:9',
      exportWidth: 1920,
      exportHeight: 1080,
      customNorm: null,
      verticalModeLayout: 'crop', // 'crop' | 'blur-bg'

      // Captions Styling
      captionStyle: {
        fontFamily: "'Noto Sans Devanagari', sans-serif",
        fontSize: 42,
        textColor: '#ffffff',
        highlightColor: '#fbbf24',
        outlineThickness: 4,
        outlineColor: '#000000',
        boxEnabled: true,
        boxOpacity: 65,
        position: 'bottom',
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
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0
      },

      // Playback
      isPlaying: false,
      currentTime: 0,
      playStartTime: 0,
      playStartOffset: 0,
      isMuted: false,
      previewVolume: 1.0,

      // Engines references for renderer
      timelineEngine: this.timelineEngine,
      captionEngine: this.captionEngine,
      uiToast: (msg, type, dur) => this.ui?.showToast(msg, type, dur)
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

    // Populate TTS Voices & Languages with reactive reload
    await this.voiceEngine.loadVoices(() => {
      this.populateTtsLanguagesAndVoices(true);
    });
    this.populateTtsLanguagesAndVoices(true);

    // Initial check of local backend availability
    this.updateBackendVoiceStatus();

    // Initial render of empty canvas
    this.updateCanvasResolution();
    this.renderCurrentPreviewFrame();

    console.log('[FrameFlow Studio] Initialized successfully.');
  }

  /**
   * Restores user preferences from localStorage
   */
  loadSavedSettings() {
    const savedCaptions = loadSetting('captionStyle', null);
    if (savedCaptions) Object.assign(this.state.captionStyle, savedCaptions);

    const savedGrading = loadSetting('colorGrading', null);
    if (savedGrading) Object.assign(this.state.colorGrading, savedGrading);

    const savedOverlays = loadSetting('overlays', null);
    if (savedOverlays) Object.assign(this.state.overlays, savedOverlays);
  }

  // =========================================================================
  // Navigation & Step Switching (4-Step Flow)
  // =========================================================================

  bindNavigationEvents() {
    document.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = parseInt(btn.dataset.step, 10);
        this.goToStep(step);
      });
    });

    document.getElementById('goToStep2Btn')?.addEventListener('click', () => this.goToStep(2));
    document.getElementById('backToStep1Btn')?.addEventListener('click', () => this.goToStep(1));
    document.getElementById('goToStep3Btn')?.addEventListener('click', () => this.goToStep(3));
    document.getElementById('backToStep2Btn')?.addEventListener('click', () => this.goToStep(2));
    document.getElementById('goToStep4Btn')?.addEventListener('click', () => this.goToStep(4));
    document.getElementById('backToStep3Btn')?.addEventListener('click', () => this.goToStep(3));
  }

  async goToStep(step) {
    this.state.currentStep = step;
    this.ui.setStep(step);
    if (step === 2) {
      this.updateBackendVoiceStatus();
    }
    if (step === 3) {
      this.rebuildTimeline();
      this.renderCurrentPreviewFrame();
      if (this.state.voiceMode === 'A' && (this.state.scriptText || '').trim() && !this.voiceEngine?.audioBuffer) {
        this.generateNeuralVoiceAction().catch(() => {});
      }
    }
    if (step === 4) {
      this.youtubeGenerator?.updateScriptSummary();
    }
  }

  // =========================================================================
  // Step 1: Upload & Frame Extraction
  // =========================================================================

  bindStep1Events() {
    const dropzone = document.getElementById('videoDropzone');
    const fileInput = document.getElementById('videoFileInput');

    // Drag and Drop
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        this.handleSourceVideoFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleSourceVideoFile(e.target.files[0]);
      }
    });

    document.getElementById('changeVideoBtn')?.addEventListener('click', () => {
      fileInput.click();
    });

    document.getElementById('directPhotoUploadBtn')?.addEventListener('click', () => {
      document.getElementById('directPhotoUploadInput')?.click();
    });

    // Generate 1-Min Sample Video helper for testing
    document.getElementById('createSampleVideoBtn')?.addEventListener('click', () => {
      this.generateTestSampleVideo();
    });

    // Dual Range Sliders for photos per minute
    const minSlider = document.getElementById('photosPerMinMin');
    const maxSlider = document.getElementById('photosPerMinMax');
    const displaySpan = document.getElementById('photosPerMinDisplay');
    const minValSpan = document.getElementById('photosPerMinMinVal');
    const maxValSpan = document.getElementById('photosPerMinMaxVal');

    const updateSliderVals = () => {
      let minVal = parseInt(minSlider.value, 10);
      let maxVal = parseInt(maxSlider.value, 10);
      if (minVal > maxVal) {
        minVal = maxVal;
        minSlider.value = minVal;
      }
      displaySpan.textContent = `${minVal} – ${maxVal}`;
      minValSpan.textContent = minVal;
      maxValSpan.textContent = maxVal;
      this.updateEstimatedPhotosCount();
    };

    minSlider?.addEventListener('input', updateSliderVals);
    maxSlider?.addEventListener('input', updateSliderVals);

    // Extraction CTA (Auto Sampler)
    document.getElementById('startExtractionBtn')?.addEventListener('click', () => {
      this.startExtractionProcess();
    });

    document.getElementById('cancelExtractionBtn')?.addEventListener('click', () => {
      this.extractor.cancel();
      this.ui.showToast('Extraction cancelled.', 'info');
    });

    // Toggle batch sampler card
    document.getElementById('toggleSamplingSettingsBtn')?.addEventListener('click', () => {
      document.getElementById('extractionConfigCard')?.classList.toggle('hidden');
    });
    document.getElementById('openBatchSamplerBtn')?.addEventListener('click', () => {
      const card = document.getElementById('extractionConfigCard');
      card?.classList.remove('hidden');
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Custom Resolution & Sticker/Watermark Controls
    this.bindExtractionResolutionEvents();
    this.bindWatermarkEvents();

    // =======================================================================
    // Video Clipper Player & Framing Studio Controls
    // =======================================================================

    const clipperPlayBtn = document.getElementById('clipperPlayPauseBtn');
    const playIcon = document.getElementById('clipperPlayIcon');
    const pauseIcon = document.getElementById('clipperPauseIcon');
    const scrubber = document.getElementById('videoScrubberSlider');
    const speedSelect = document.getElementById('clipperPlaybackSpeedSelect');
    const framingSlider = document.getElementById('clipperFramingSlider');
    const framingVal = document.getElementById('clipperFramingVal');

    // Video click: toggle play/pause
    this.sourceVideo?.addEventListener('click', () => {
      if (this.sourceVideo.paused) this.sourceVideo.play();
      else this.sourceVideo.pause();
    });

    // Play/Pause button
    clipperPlayBtn?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      if (this.sourceVideo.paused) this.sourceVideo.play();
      else this.sourceVideo.pause();
    });

    this.sourceVideo?.addEventListener('play', () => {
      playIcon?.classList.add('hidden');
      pauseIcon?.classList.remove('hidden');
    });

    this.sourceVideo?.addEventListener('pause', () => {
      playIcon?.classList.remove('hidden');
      pauseIcon?.classList.add('hidden');
    });

    this.sourceVideo?.addEventListener('ended', () => {
      playIcon?.classList.remove('hidden');
      pauseIcon?.classList.add('hidden');
    });

    // Time update: sync scrubber & badges
    this.sourceVideo?.addEventListener('timeupdate', () => {
      if (!this.state.isScrubbingClipper && scrubber) {
        scrubber.value = this.sourceVideo.currentTime;
      }
      const t = this.sourceVideo.currentTime;
      const tStr = this.ui.formatTime(t);
      const curEl = document.getElementById('videoCurrentTimeDisplay');
      if (curEl) curEl.textContent = tStr;

      const tcBadge = document.getElementById('clipperTimecodeBadge');
      if (tcBadge) tcBadge.textContent = tStr;

      const frameBadge = document.getElementById('clipperFrameNumBadge');
      if (frameBadge) frameBadge.textContent = `Frame #${Math.floor(t * 30)}`;
    });

    // Scrubber interaction
    scrubber?.addEventListener('mousedown', () => { this.state.isScrubbingClipper = true; });
    scrubber?.addEventListener('touchstart', () => { this.state.isScrubbingClipper = true; }, { passive: true });

    scrubber?.addEventListener('input', (e) => {
      if (!this.sourceVideo) return;
      const t = parseFloat(e.target.value);
      this.sourceVideo.currentTime = t;
      const curEl = document.getElementById('videoCurrentTimeDisplay');
      if (curEl) curEl.textContent = this.ui.formatTime(t);
      const tcBadge = document.getElementById('clipperTimecodeBadge');
      if (tcBadge) tcBadge.textContent = this.ui.formatTime(t);
    });

    const finishScrub = () => { this.state.isScrubbingClipper = false; };
    scrubber?.addEventListener('mouseup', finishScrub);
    scrubber?.addEventListener('touchend', finishScrub);
    scrubber?.addEventListener('change', finishScrub);

    // Frame-by-frame and jump buttons
    document.getElementById('clipperPrevFrameBtn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.pause();
      this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - (1 / 30));
    });

    document.getElementById('clipperNextFrameBtn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.pause();
      this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + (1 / 30));
    });

    document.getElementById('clipperJumpBack1Btn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - 1);
    });

    document.getElementById('clipperJumpForward1Btn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + 1);
    });

    document.getElementById('clipperJumpBack5Btn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - 5);
    });

    document.getElementById('clipperJumpForward5Btn')?.addEventListener('click', () => {
      if (!this.sourceVideo) return;
      this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + 5);
    });

    speedSelect?.addEventListener('change', (e) => {
      if (this.sourceVideo) this.sourceVideo.playbackRate = parseFloat(e.target.value);
    });

    // Aspect Ratio Pills on Clipper
    document.querySelectorAll('#clipperRatioPills .aspect-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('#clipperRatioPills .aspect-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        const ratio = pill.dataset.ratio;
        this.setAspectRatio(ratio);
        this.updateClipperOverlay();
      });
    });

    // Framing Alignment Presets & Slider
    const updateFramingOffset = (val) => {
      this.state.clipperCropOffset = val / 100;
      if (framingSlider) framingSlider.value = val;
      if (framingVal) {
        if (val < 30) framingVal.textContent = `Left (${val}%)`;
        else if (val > 70) framingVal.textContent = `Right (${val}%)`;
        else framingVal.textContent = `Center (${val}%)`;
      }
      document.getElementById('frameAlignLeftBtn')?.classList.toggle('active', val === 0);
      document.getElementById('frameAlignCenterBtn')?.classList.toggle('active', val === 50);
      document.getElementById('frameAlignRightBtn')?.classList.toggle('active', val === 100);
      this.updateClipperOverlay();
    };

    framingSlider?.addEventListener('input', (e) => {
      updateFramingOffset(parseInt(e.target.value, 10));
    });

    document.getElementById('frameAlignLeftBtn')?.addEventListener('click', () => updateFramingOffset(0));
    document.getElementById('frameAlignCenterBtn')?.addEventListener('click', () => updateFramingOffset(50));
    document.getElementById('frameAlignRightBtn')?.addEventListener('click', () => updateFramingOffset(100));

    // Helper to get actual displayed video dimensions within clipper viewport
    const getVideoDisplayDims = () => {
      const viewport = document.getElementById('clipperVideoViewport');
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

    // Interactive Direct Drag & Drop for Crop Window & Corner Resize Handles
    const cropWindow = document.getElementById('cropWindow');
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
      if (!isResizingCorner || !resizeStartNorm) return;
      const dx = (e.clientX - resizeStartX) / resizeVideoW;
      const dy = (e.clientY - resizeStartY) / resizeVideoH;
      const minNorm = 0.08;

      let { x, y, w, h } = resizeStartNorm;
      const right = x + w;
      const bottom = y + h;

      if (activeCorner === 'top-left') {
        const newX = Math.max(0, Math.min(right - minNorm, x + dx));
        const newY = Math.max(0, Math.min(bottom - minNorm, y + dy));
        x = newX;
        y = newY;
        w = right - newX;
        h = bottom - newY;
      } else if (activeCorner === 'top-right') {
        const newY = Math.max(0, Math.min(bottom - minNorm, y + dy));
        y = newY;
        h = bottom - newY;
        w = Math.max(minNorm, Math.min(1 - x, w + dx));
      } else if (activeCorner === 'bottom-left') {
        const newX = Math.max(0, Math.min(right - minNorm, x + dx));
        x = newX;
        w = right - newX;
        h = Math.max(minNorm, Math.min(1 - y, h + dy));
      } else if (activeCorner === 'bottom-right') {
        w = Math.max(minNorm, Math.min(1 - x, w + dx));
        h = Math.max(minNorm, Math.min(1 - y, h + dy));
      }

      this.state.customNorm = { x, y, w, h };
      const sourceW = this.sourceVideo?.videoWidth || 1920;
      const sourceH = this.sourceVideo?.videoHeight || 1080;
      let expW = Math.round(w * sourceW);
      let expH = Math.round(h * sourceH);
      if (Math.max(expW, expH) > 1920) {
        const scale = 1920 / Math.max(expW, expH);
        expW = Math.round(expW * scale);
        expH = Math.round(expH * scale);
      }
      expW = expW - (expW % 2);
      expH = expH - (expH % 2);
      this.state.exportWidth = Math.max(128, expW);
      this.state.exportHeight = Math.max(128, expH);

      const canvasVp = document.getElementById('canvasViewport');
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
      cropWindow?.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onCornerResizeMove);
      window.removeEventListener('pointerup', onCornerResizeEnd);
      window.removeEventListener('pointercancel', onCornerResizeEnd);
      this.renderCurrentPreviewFrame();
    };

    // Attach resize listeners to all 4 corner handles
    document.querySelectorAll('#cropWindow .crop-corner').forEach((cornerEl) => {
      cornerEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Switch to custom mode if not already
        if (this.state.aspectRatio !== 'custom') {
          this.state.customNorm = this.getNormalizedCropBounds();
          this.setAspectRatio('custom');
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

        cropWindow?.classList.add('is-dragging');

        window.addEventListener('pointermove', onCornerResizeMove);
        window.addEventListener('pointerup', onCornerResizeEnd);
        window.addEventListener('pointercancel', onCornerResizeEnd);
      });
    });

    const getExcessWidth = () => {
      const dims = getVideoDisplayDims();
      let targetAspect = (this.sourceVideo?.videoWidth || 1920) / (this.sourceVideo?.videoHeight || 1080);
      const ratio = this.state.aspectRatio || '16:9';
      if (ratio === '16:9' || ratio === '16:9-720p') targetAspect = 16 / 9;
      else if (ratio === '9:16') targetAspect = 9 / 16;
      else if (ratio === '1:1') targetAspect = 1.0;
      else if (ratio === '4:5') targetAspect = 4 / 5;

      const videoAspect = (this.sourceVideo?.videoWidth || 1920) / (this.sourceVideo?.videoHeight || 1080);
      if (videoAspect > targetAspect) {
        const cropW = dims.actualVideoH * targetAspect;
        return Math.max(0, dims.actualVideoW - cropW);
      }
      return 0;
    };

    const onCropDragMove = (e) => {
      if (!isDraggingCrop) return;

      if (this.state.aspectRatio === 'custom' && dragStartCustomNorm) {
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
      const newOffset = Math.max(0, Math.min(1, dragStartOffset + (deltaX / excess)));
      updateFramingOffset(Math.round(newOffset * 100));
    };

    const onCropDragEnd = () => {
      if (!isDraggingCrop) return;
      isDraggingCrop = false;
      dragStartCustomNorm = null;
      cropWindow?.classList.remove('is-dragging');
      document.querySelectorAll('.crop-mask').forEach(m => m.classList.remove('is-dragging'));
      window.removeEventListener('pointermove', onCropDragMove);
      window.removeEventListener('pointerup', onCropDragEnd);
      window.removeEventListener('pointercancel', onCropDragEnd);
      if (this.state.aspectRatio === 'custom') {
        this.renderCurrentPreviewFrame();
      }
    };

    const startCropDrag = (e) => {
      if (isResizingCorner) return;

      if (this.state.aspectRatio === 'custom') {
        if (!this.state.customNorm) {
          this.state.customNorm = this.getNormalizedCropBounds();
        }
        isDraggingCrop = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartCustomNorm = { ...this.state.customNorm };
        cropWindow?.classList.add('is-dragging');
        document.querySelectorAll('.crop-mask').forEach(m => m.classList.add('is-dragging'));
        window.addEventListener('pointermove', onCropDragMove);
        window.addEventListener('pointerup', onCropDragEnd);
        window.addEventListener('pointercancel', onCropDragEnd);
        return;
      }

      const excess = getExcessWidth();
      if (excess <= 1) return;

      isDraggingCrop = true;
      dragStartX = e.clientX;
      dragStartOffset = this.state.clipperCropOffset !== undefined ? this.state.clipperCropOffset : 0.5;

      cropWindow?.classList.add('is-dragging');
      document.querySelectorAll('.crop-mask').forEach(m => m.classList.add('is-dragging'));

      // If clicking directly on side mask, jump crop box toward click position
      if (e.target.id === 'cropMaskLeft' || e.target.id === 'cropMaskRight') {
        const dims = getVideoDisplayDims();
        const viewport = document.getElementById('clipperVideoViewport');
        const rect = viewport.getBoundingClientRect();
        const clickXInVideo = (e.clientX - rect.left) - dims.videoLeft;

        let targetAspect = 16 / 9;
        const ratio = this.state.aspectRatio || '16:9';
        if (ratio === '9:16') targetAspect = 9 / 16;
        else if (ratio === '1:1') targetAspect = 1.0;
        else if (ratio === '4:5') targetAspect = 4 / 5;
        const cropW = dims.actualVideoH * targetAspect;

        const targetCropLeft = clickXInVideo - (cropW / 2);
        const newOffset = Math.max(0, Math.min(1, targetCropLeft / excess));
        dragStartOffset = newOffset;
        dragStartX = e.clientX;
        updateFramingOffset(Math.round(newOffset * 100));
      }

      window.addEventListener('pointermove', onCropDragMove);
      window.addEventListener('pointerup', onCropDragEnd);
      window.addEventListener('pointercancel', onCropDragEnd);
    };

    cropWindow?.addEventListener('pointerdown', startCropDrag);
    document.getElementById('cropMaskLeft')?.addEventListener('pointerdown', startCropDrag);
    document.getElementById('cropMaskRight')?.addEventListener('pointerdown', startCropDrag);
    document.getElementById('cropMaskTop')?.addEventListener('pointerdown', startCropDrag);
    document.getElementById('cropMaskBottom')?.addEventListener('pointerdown', startCropDrag);

    // Primary Manual Clip Button
    document.getElementById('clipCurrentFrameBtn')?.addEventListener('click', () => {
      this.clipCurrentFrame();
    });

    // Quick Interval Clipper
    document.getElementById('quickIntervalClipBtn')?.addEventListener('click', () => {
      this.quickIntervalClip(5, 3);
    });

    // Global keyboard shortcuts for video clipping
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'c' || e.key === 'C') {
        if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
          e.preventDefault();
          this.clipCurrentFrame();
        }
      } else if (e.key === ' ') {
        if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
          e.preventDefault();
          if (this.sourceVideo.paused) this.sourceVideo.play();
          else this.sourceVideo.pause();
        }
      } else if (e.key === 'ArrowLeft') {
        if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
          e.preventDefault();
          this.sourceVideo.currentTime = Math.max(0, this.sourceVideo.currentTime - (e.shiftKey ? 1 : 1 / 30));
        }
      } else if (e.key === 'ArrowRight') {
        if (this.state.currentStep === 1 && this.state.sourceVideoLoaded) {
          e.preventDefault();
          this.sourceVideo.currentTime = Math.min(this.sourceVideo.duration || 0, this.sourceVideo.currentTime + (e.shiftKey ? 1 : 1 / 30));
        }
      }
    });

    window.addEventListener('resize', () => {
      if (this.state.sourceVideoLoaded) {
        this.updateClipperOverlay();
      }
    });

    // Gallery Filter & Bulk Actions
    document.getElementById('filterAllFramesBtn')?.addEventListener('click', (e) => {
      this.state.filterStarredOnly = false;
      e.target.classList.add('active');
      document.getElementById('filterStarredFramesBtn')?.classList.remove('active');
      this.refreshGallery();
    });

    document.getElementById('filterStarredFramesBtn')?.addEventListener('click', (e) => {
      this.state.filterStarredOnly = true;
      e.target.classList.add('active');
      document.getElementById('filterAllFramesBtn')?.classList.remove('active');
      this.refreshGallery();
    });

    document.getElementById('starAllFramesBtn')?.addEventListener('click', () => {
      this.state.extractedFrames.forEach((f) => (f.starred = true));
      this.refreshGallery();
      this.ui.showToast('Starred all extracted frames.', 'success');
    });

    document.getElementById('reExtractBtn')?.addEventListener('click', () => {
      this.startExtractionProcess();
    });

    document.getElementById('clearFramesBtn')?.addEventListener('click', () => {
      if (confirm('Clear all extracted frames?')) {
        this.clearAllExtractedFrames();
      }
    });

    // Close preview modal
    document.getElementById('closeFrameModalBtn')?.addEventListener('click', () => {
      document.getElementById('framePreviewModal')?.classList.add('hidden');
    });
  }

  /**
   * Initializes the video player and framing overlay inside the Clipper Studio
   */
  initVideoClipperPlayer() {
    if (!this.sourceVideo || !this.sourceVideo.duration) return;
    const dur = this.sourceVideo.duration;

    const scrubber = document.getElementById('videoScrubberSlider');
    if (scrubber) {
      scrubber.min = 0;
      scrubber.max = dur;
      scrubber.value = 0;
    }

    const totalEl = document.getElementById('videoTotalTimeDisplay');
    if (totalEl) totalEl.textContent = this.ui.formatTime(dur);

    const curEl = document.getElementById('videoCurrentTimeDisplay');
    if (curEl) curEl.textContent = '00:00.00';

    this.updateClipperOverlay();
  }

  /**
   * Returns normalized crop bounds { x, y, w, h } in [0, 1] for current frame setting
   */
  getNormalizedCropBounds() {
    if (this.state.customNorm) {
      return { ...this.state.customNorm };
    }
    const sourceW = this.sourceVideo?.videoWidth || 1920;
    const sourceH = this.sourceVideo?.videoHeight || 1080;
    const ratio = (this.state.aspectRatio === '16:9-720p') ? '16:9' : (this.state.aspectRatio || '16:9');
    const offset = this.state.clipperCropOffset !== undefined ? this.state.clipperCropOffset : 0.5;
    if (this.extractor && typeof this.extractor.computeCropBounds === 'function') {
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
    const viewport = document.getElementById('clipperVideoViewport');
    const sourceW = this.sourceVideo?.videoWidth || 1920;
    const sourceH = this.sourceVideo?.videoHeight || 1080;
    const targetRatio = (this.state.aspectRatio === '16:9-720p') ? '16:9' : (this.state.aspectRatio || '16:9');
    const cropOffsetX = this.state.clipperCropOffset !== undefined ? this.state.clipperCropOffset : 0.5;

    this.ui.updateClipperFramingOverlay(
      viewport,
      sourceW,
      sourceH,
      targetRatio,
      cropOffsetX,
      0.5,
      this.state.customNorm
    );

    const tagEl = document.getElementById('cropWindowRatioTag');
    if (tagEl) {
      const displayRatio = this.state.aspectRatio === 'custom' ? 'Custom' : this.state.aspectRatio;
      tagEl.textContent = `Frame: ${displayRatio} · ${this.state.exportWidth}x${this.state.exportHeight}`;
    }
  }

  /**
   * Clips a single frame from the video at current timestamp
   */
  async clipCurrentFrame() {
    if (!this.sourceVideo || !this.state.sourceVideoLoaded) {
      this.ui.showToast('Please upload a video first!', 'error');
      return;
    }

    const flash = document.getElementById('clipperFlashEffect');
    if (flash) {
      flash.classList.add('flash-active');
      setTimeout(() => flash.classList.remove('flash-active'), 120);
    }

    const applyCrop = document.getElementById('clipperApplyCropCheck')?.checked ?? true;

    try {
      const frameItem = await this.extractor.clipCurrentFrame({
        aspectRatio: this.state.aspectRatio,
        cropOffsetX: this.state.clipperCropOffset,
        customNorm: this.state.customNorm,
        applyCrop,
        watermark: this.getWatermarkConfig(),
        targetWidth: applyCrop ? this.state.exportWidth : undefined,
        targetHeight: applyCrop ? this.state.exportHeight : undefined
      });

      this.state.extractedFrames.push(frameItem);
      this.refreshGallery();
      document.getElementById('framesGallerySection')?.classList.remove('hidden');

      const timeStr = this.ui.formatTime(this.sourceVideo.currentTime);
      if (!applyCrop) {
        this.ui.showToast("Photo doesn't match frame size", 'info');
      } else {
        const displayRatio = this.state.aspectRatio === 'custom' ? 'Custom' : this.state.aspectRatio;
        this.ui.showToast(`📸 Clipped frame at ${timeStr} (${displayRatio})`, 'success');
      }
    } catch (err) {
      this.ui.showToast(`Failed to clip frame: ${err.message}`, 'error');
    }
  }

  /**
   * Fast interval clipper: captures count frames spaced stepSec apart
   */
  async quickIntervalClip(count = 5, stepSec = 3) {
    if (!this.sourceVideo || !this.state.sourceVideoLoaded) return;
    this.ui.showToast(`⚡ Clipping ${count} frames spaced ${stepSec}s apart...`, 'info', 3000);
    const startT = this.sourceVideo.currentTime;
    const dur = this.sourceVideo.duration;
    const applyCrop = document.getElementById('clipperApplyCropCheck')?.checked ?? true;

    for (let i = 0; i < count; i++) {
      const targetT = Math.min(dur - 0.05, startT + (i * stepSec));
      await this.extractor.seekVideo(targetT);
      const frameItem = await this.extractor.clipCurrentFrame({
        timestamp: targetT,
        aspectRatio: this.state.aspectRatio,
        cropOffsetX: this.state.clipperCropOffset,
        customNorm: this.state.customNorm,
        applyCrop,
        targetWidth: applyCrop ? this.state.exportWidth : undefined,
        targetHeight: applyCrop ? this.state.exportHeight : undefined
      });
      this.state.extractedFrames.push(frameItem);
    }

    this.refreshGallery();
    document.getElementById('framesGallerySection')?.classList.remove('hidden');
    if (!applyCrop) {
      this.ui.showToast("Photo doesn't match frame size", 'info');
    } else {
      this.ui.showToast(`🎉 Captured ${count} frames!`, 'success');
    }
  }

  /**
   * Loads a source video file into the muted video element
   */
  handleSourceVideoFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      this.ui.showToast('Please select a valid video file (.mp4, .webm, .mov).', 'error');
      return;
    }

    const fileUrl = URL.createObjectURL(file);
    this.sourceVideo.src = fileUrl;
    this.sourceVideo.muted = true; // STRICTLY MUTED

    this.sourceVideo.onloadedmetadata = () => {
      this.state.sourceVideoLoaded = true;

      // Update Meta Card
      document.getElementById('videoFileName').textContent = file.name;
      document.getElementById('videoDurationBadge').textContent = `Duration: ${this.ui.formatTime(this.sourceVideo.duration)}`;
      document.getElementById('videoResolutionBadge').textContent = `Resolution: ${this.sourceVideo.videoWidth}x${this.sourceVideo.videoHeight}`;
      document.getElementById('videoSizeBadge').textContent = `Size: ${this.ui.formatBytes(file.size)}`;

      document.getElementById('videoMetaCard')?.classList.remove('hidden');
      document.getElementById('videoClipperCard')?.classList.remove('hidden');
      document.getElementById('videoDropzone')?.classList.add('hidden');

      this.initVideoClipperPlayer();
      this.updateEstimatedPhotosCount();
      this.ui.showToast(`Loaded video (${this.ui.formatTime(this.sourceVideo.duration)})`, 'success');
    };
  }

  /**
   * Generates a 1-minute test video on the fly inside the browser
   */
  async generateTestSampleVideo() {
    this.ui.showToast('Generating 1-Minute sample video with smooth motion...', 'info', 4000);
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    const fps = 30;
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);

    recorder.start();

    const durationSec = 60; // 1 minute
    const totalFrames = durationSec * fps;

    // Draw procedural cinematic patterns with high contrast and colors
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      // Vibrant animated gradient background
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      const hue1 = (t * 20) % 360;
      const hue2 = (hue1 + 120) % 360;
      grad.addColorStop(0, `hsl(${hue1}, 70%, 25%)`);
      grad.addColorStop(1, `hsl(${hue2}, 80%, 45%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Moving geometrical shapes
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      const circleX = (canvas.width / 2) + Math.cos(t * 1.5) * 350;
      const circleY = (canvas.height / 2) + Math.sin(t * 1.5) * 180;
      ctx.beginPath();
      ctx.arc(circleX, circleY, 90, 0, Math.PI * 2);
      ctx.fill();

      // Timestamp watermark
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 48px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`FrameFlow Test Scene — ${this.ui.formatTime(t)}`, canvas.width / 2, canvas.height / 2);

      ctx.font = '500 24px sans-serif';
      ctx.fillText(`Stratified Sampling Test &middot; Frame ${f + 1}/${totalFrames}`, canvas.width / 2, canvas.height / 2 + 60);

      if (f % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    recorder.stop();

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const testFile = new File([blob], 'sample_scenery_1min.webm', { type: 'video/webm' });
      this.handleSourceVideoFile(testFile);
    };
  }

  updateEstimatedPhotosCount() {
    if (!this.sourceVideo || !this.sourceVideo.duration) return;
    const minEl = document.getElementById('photosPerMinMin');
    const maxEl = document.getElementById('photosPerMinMax');
    const minVal = parseInt(minEl?.value || '15', 10);
    const maxVal = parseInt(maxEl?.value || '20', 10);
    const avgPerMin = (minVal + maxVal) / 2;
    const durationMinutes = this.sourceVideo.duration / 60;
    const estTotal = Math.round(avgPerMin * durationMinutes);
    const estBadge = document.getElementById('estimatedPhotosCount');
    if (estBadge) {
      estBadge.textContent = `~${estTotal}`;
    }
    const displaySpan = document.getElementById('photosPerMinDisplay');
    if (displaySpan) {
      displaySpan.textContent = `${minVal} – ${maxVal} photos/min (~${estTotal} total)`;
    }
  }

  bindExtractionResolutionEvents() {
    const select = document.getElementById('extractResolutionSelect');
    const hiddenInput = document.getElementById('extractResolution');
    const resTag = document.getElementById('extractionResTag');
    const customGroup = document.getElementById('customResolutionInputs');
    const customW = document.getElementById('customExtractWidth');
    const customH = document.getElementById('customExtractHeight');

    const updateResState = () => {
      const mode = select?.value || '1080p';
      this.state.extractResolutionMode = mode;

      if (mode === '1080p') {
        customGroup?.classList.add('hidden');
        if (hiddenInput) hiddenInput.value = '1080';
        if (resTag) resTag.textContent = '1920 × 1080 (1080p Full HD)';
      } else if (mode === '720p') {
        customGroup?.classList.add('hidden');
        if (hiddenInput) hiddenInput.value = '720';
        if (resTag) resTag.textContent = '1280 × 720 (720p HD)';
      } else if (mode === '4k') {
        customGroup?.classList.add('hidden');
        if (hiddenInput) hiddenInput.value = '2160';
        if (resTag) resTag.textContent = '3840 × 2160 (4K UHD)';
      } else if (mode === 'original') {
        customGroup?.classList.add('hidden');
        if (hiddenInput) hiddenInput.value = '3840';
        const srcW = this.sourceVideo?.videoWidth || 'Native';
        const srcH = this.sourceVideo?.videoHeight || 'Native';
        if (resTag) resTag.textContent = `Match Source (${srcW} × ${srcH})`;
      } else if (mode === 'custom') {
        customGroup?.classList.remove('hidden');
        const w = parseInt(customW?.value || '1920', 10);
        const h = parseInt(customH?.value || '1080', 10);
        this.state.customExtractWidth = w;
        this.state.customExtractHeight = h;
        if (hiddenInput) hiddenInput.value = Math.max(w, h).toString();
        if (resTag) resTag.textContent = `Custom (${w} × ${h})`;
      }
    };

    select?.addEventListener('change', updateResState);

    const onCustomChange = () => {
      const w = parseInt(customW?.value || '1920', 10);
      const h = parseInt(customH?.value || '1080', 10);
      this.state.customExtractWidth = w;
      this.state.customExtractHeight = h;
      if (resTag && select?.value === 'custom') resTag.textContent = `Custom (${w} × ${h})`;
      if (hiddenInput) hiddenInput.value = Math.max(w, h).toString();
    };

    customW?.addEventListener('input', onCustomChange);
    customH?.addEventListener('input', onCustomChange);

    document.querySelectorAll('.res-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = parseInt(btn.dataset.w || '1920', 10);
        const h = parseInt(btn.dataset.h || '1080', 10);
        if (customW) customW.value = w;
        if (customH) customH.value = h;
        onCustomChange();
      });
    });
  }

  bindWatermarkEvents() {
    const enableCheck = document.getElementById('enableWatermarkCheck');
    const panel = document.getElementById('watermarkControlsPanel');
    const badge = document.getElementById('watermarkActiveBadge');
    const tabBtns = document.querySelectorAll('.wm-tab-btn');
    const textPanel = document.getElementById('wmTextPanel');
    const imagePanel = document.getElementById('wmImagePanel');
    const presetPanel = document.getElementById('wmPresetPanel');
    const textInput = document.getElementById('watermarkTextInput');
    const styleSelect = document.getElementById('watermarkTextStyle');
    const fileInput = document.getElementById('watermarkFileInput');
    const selectStickerBtn = document.getElementById('selectStickerBtn');
    const removeStickerBtn = document.getElementById('removeStickerBtn');
    const stickerNameSpan = document.getElementById('stickerFileName');
    const stickerPreviewBox = document.getElementById('stickerThumbPreview');
    const stickerPreviewImg = document.getElementById('stickerPreviewImg');
    const posSelect = document.getElementById('watermarkPositionSelect');
    const sizeSelect = document.getElementById('watermarkSizeSelect');
    const opacitySlider = document.getElementById('watermarkOpacitySlider');
    const opacityVal = document.getElementById('watermarkOpacityVal');

    // Toggle
    enableCheck?.addEventListener('change', () => {
      const isEnabled = enableCheck.checked;
      this.state.watermark.enabled = isEnabled;
      if (isEnabled) {
        panel?.classList.remove('hidden');
        badge?.classList.remove('hidden');
      } else {
        panel?.classList.add('hidden');
        badge?.classList.add('hidden');
      }
      this.updateWatermarkLivePreview();
    });

    // Mode tabs
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.wmMode;
        this.state.watermark.type = mode;

        textPanel?.classList.toggle('hidden', mode !== 'text');
        imagePanel?.classList.toggle('hidden', mode !== 'image');
        presetPanel?.classList.toggle('hidden', mode !== 'preset');

        this.updateWatermarkLivePreview();
      });
    });

    // Text & Style
    textInput?.addEventListener('input', () => {
      this.state.watermark.text = textInput.value;
      this.updateWatermarkLivePreview();
    });

    styleSelect?.addEventListener('change', () => {
      this.state.watermark.style = styleSelect.value;
      this.updateWatermarkLivePreview();
    });

    // Custom Sticker Image Upload
    selectStickerBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
          this.state.watermark.imageElement = img;
          if (stickerPreviewImg) stickerPreviewImg.src = dataUrl;
          stickerPreviewBox?.classList.remove('hidden');
          if (stickerNameSpan) stickerNameSpan.textContent = file.name;
          this.updateWatermarkLivePreview();
          this.ui?.showToast('Sticker logo uploaded!', 'success');
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });

    removeStickerBtn?.addEventListener('click', () => {
      this.state.watermark.imageElement = null;
      if (fileInput) fileInput.value = '';
      if (stickerPreviewImg) stickerPreviewImg.src = '';
      stickerPreviewBox?.classList.add('hidden');
      if (stickerNameSpan) stickerNameSpan.textContent = 'No file chosen';
      this.updateWatermarkLivePreview();
    });

    // Preset Badges
    document.querySelectorAll('.preset-badge-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-badge-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const presetText = btn.dataset.preset;
        this.state.watermark.text = presetText;
        this.updateWatermarkLivePreview();
      });
    });

    // Position, Size, Opacity
    posSelect?.addEventListener('change', () => {
      this.state.watermark.position = posSelect.value;
      if (posSelect.value !== 'custom') {
        this.state.watermark.customNorm = null;
      }
      this.updateWatermarkLivePreview();
    });

    sizeSelect?.addEventListener('change', () => {
      this.state.watermark.size = sizeSelect.value;
      this.updateWatermarkLivePreview();
    });

    opacitySlider?.addEventListener('input', () => {
      const val = parseInt(opacitySlider.value, 10);
      if (opacityVal) opacityVal.textContent = `${val}%`;
      this.state.watermark.opacity = val / 100;
      this.updateWatermarkLivePreview();
    });

    // Interactive Drag and Drop of Sticker directly over Video Crop Window
    const draggableWatermark = document.getElementById('draggableCropWatermark');
    let isDraggingSticker = false;
    let stickerStartX = 0;
    let stickerStartY = 0;
    let stickerStartLeft = 0;
    let stickerStartTop = 0;

    const onStickerPointerMove = (e) => {
      if (!isDraggingSticker || !draggableWatermark) return;
      const cropWindow = document.getElementById('cropWindow');
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
      draggableWatermark.style.right = 'auto';
      draggableWatermark.style.bottom = 'auto';

      const relX = cropRect.width > 0 ? newLeft / cropRect.width : 0;
      const relY = cropRect.height > 0 ? newTop / cropRect.height : 0;

      this.state.watermark.customNorm = { relX, relY };
      this.state.watermark.position = 'custom';

      if (posSelect) {
        posSelect.value = 'custom';
      }
    };

    const onStickerPointerUp = () => {
      if (!isDraggingSticker) return;
      isDraggingSticker = false;
      draggableWatermark?.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onStickerPointerMove);
      window.removeEventListener('pointerup', onStickerPointerUp);
      window.removeEventListener('pointercancel', onStickerPointerUp);
    };

    draggableWatermark?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingSticker = true;
      stickerStartX = e.clientX;
      stickerStartY = e.clientY;

      const parentRect = document.getElementById('cropWindow')?.getBoundingClientRect() || { left: 0, top: 0 };
      const elRect = draggableWatermark.getBoundingClientRect();
      stickerStartLeft = elRect.left - parentRect.left;
      stickerStartTop = elRect.top - parentRect.top;

      draggableWatermark.classList.add('is-dragging');
      window.addEventListener('pointermove', onStickerPointerMove);
      window.addEventListener('pointerup', onStickerPointerUp);
      window.addEventListener('pointercancel', onStickerPointerUp);
    });

    this.updateWatermarkLivePreview();
  }

  updateWatermarkLivePreview() {
    const box = document.getElementById('wmLivePreviewBox');
    const tag = document.getElementById('wmLivePreviewText');
    const draggableCropWm = document.getElementById('draggableCropWatermark');
    const cropWmContent = document.getElementById('cropWatermarkContent');
    const wm = this.state.watermark;

    if (box && tag) {
      const opacity = wm.opacity || 0.85;
      tag.style.opacity = opacity.toString();

      // Alignment in box
      if (wm.position === 'bottom-left' || wm.position === 'top-left') {
        box.style.justifyContent = 'flex-start';
      } else if (wm.position === 'center') {
        box.style.justifyContent = 'center';
      } else {
        box.style.justifyContent = 'flex-end';
      }

      if (wm.type === 'image' && wm.imageElement) {
        tag.innerHTML = `<img src="${wm.imageElement.src}" style="height: 22px; vertical-align: middle; max-width: 60px; object-fit: contain;">`;
        tag.style.background = 'transparent';
        tag.style.border = 'none';
      } else {
        const displayTxt = (wm.text || '@StoryFlow').trim();
        tag.textContent = displayTxt;

        if (wm.style === 'gold-pill') {
          tag.style.background = 'rgba(46, 32, 22, 0.9)';
          tag.style.border = '1px solid #f5d97a';
          tag.style.color = '#f5d97a';
        } else if (wm.style === 'red-box') {
          tag.style.background = 'rgba(214, 40, 40, 0.92)';
          tag.style.border = '1px solid rgba(255, 255, 255, 0.6)';
          tag.style.color = '#ffffff';
        } else if (wm.style === 'clean-text') {
          tag.style.background = 'transparent';
          tag.style.border = 'none';
          tag.style.color = '#ffffff';
        } else {
          // dark-pill
          tag.style.background = 'rgba(15, 10, 8, 0.85)';
          tag.style.border = '1px solid rgba(255, 255, 255, 0.25)';
          tag.style.color = '#ffffff';
        }
      }
    }

    // Sync on-video draggable sticker
    if (draggableCropWm && cropWmContent) {
      if (!wm.enabled) {
        draggableCropWm.classList.add('hidden');
      } else {
        draggableCropWm.classList.remove('hidden');
        draggableCropWm.style.opacity = (wm.opacity || 0.85).toString();

        if (wm.type === 'image' && wm.imageElement) {
          cropWmContent.innerHTML = `<img src="${wm.imageElement.src}" style="height: 28px; max-width: 80px; object-fit: contain; pointer-events: none;">`;
          cropWmContent.style.background = 'transparent';
          cropWmContent.style.border = 'none';
          cropWmContent.style.boxShadow = 'none';
        } else {
          cropWmContent.textContent = (wm.text || '@StoryFlow').trim();
          if (wm.style === 'gold-pill') {
            cropWmContent.style.background = 'rgba(46, 32, 22, 0.9)';
            cropWmContent.style.border = '1px solid #f5d97a';
            cropWmContent.style.color = '#f5d97a';
          } else if (wm.style === 'red-box') {
            cropWmContent.style.background = 'rgba(214, 40, 40, 0.92)';
            cropWmContent.style.border = '1px solid rgba(255, 255, 255, 0.6)';
            cropWmContent.style.color = '#ffffff';
          } else if (wm.style === 'clean-text') {
            cropWmContent.style.background = 'transparent';
            cropWmContent.style.border = 'none';
            cropWmContent.style.color = '#ffffff';
          } else {
            cropWmContent.style.background = 'rgba(15, 10, 8, 0.85)';
            cropWmContent.style.border = '1px solid rgba(255, 255, 255, 0.25)';
            cropWmContent.style.color = '#ffffff';
          }
        }

        // Positioning within cropWindow
        if (wm.position === 'custom' && wm.customNorm) {
          const cropW = document.getElementById('cropWindow')?.clientWidth || 100;
          const cropH = document.getElementById('cropWindow')?.clientHeight || 100;
          draggableCropWm.style.left = `${Math.round(wm.customNorm.relX * cropW)}px`;
          draggableCropWm.style.top = `${Math.round(wm.customNorm.relY * cropH)}px`;
          draggableCropWm.style.right = 'auto';
          draggableCropWm.style.bottom = 'auto';
        } else if (wm.position === 'bottom-left') {
          draggableCropWm.style.left = '12px';
          draggableCropWm.style.bottom = '12px';
          draggableCropWm.style.right = 'auto';
          draggableCropWm.style.top = 'auto';
        } else if (wm.position === 'top-right') {
          draggableCropWm.style.right = '12px';
          draggableCropWm.style.top = '12px';
          draggableCropWm.style.left = 'auto';
          draggableCropWm.style.bottom = 'auto';
        } else if (wm.position === 'top-left') {
          draggableCropWm.style.left = '12px';
          draggableCropWm.style.top = '12px';
          draggableCropWm.style.right = 'auto';
          draggableCropWm.style.bottom = 'auto';
        } else if (wm.position === 'center') {
          draggableCropWm.style.left = '50%';
          draggableCropWm.style.top = '50%';
          draggableCropWm.style.transform = 'translate(-50%, -50%)';
          draggableCropWm.style.right = 'auto';
          draggableCropWm.style.bottom = 'auto';
        } else {
          // default bottom-right
          draggableCropWm.style.right = '12px';
          draggableCropWm.style.bottom = '12px';
          draggableCropWm.style.left = 'auto';
          draggableCropWm.style.top = 'auto';
        }
      }
    }
  }

  getWatermarkConfig() {
    return { ...this.state.watermark };
  }

  async startExtractionProcess() {
    if (!this.state.sourceVideoLoaded) return;

    const minPhotos = parseInt(document.getElementById('photosPerMinMin')?.value || '15', 10);
    const maxPhotos = parseInt(document.getElementById('photosPerMinMax')?.value || '20', 10);
    const filterBlackWhite = document.getElementById('filterBlackWhite')?.checked ?? false;
    const filterDuplicates = document.getElementById('filterDuplicates')?.checked ?? true;
    const maxResolution = parseInt(document.getElementById('extractResolution')?.value || '1080', 10);

    const progressPanel = document.getElementById('extractionProgressPanel');
    const progressBar = document.getElementById('extractionProgressBar');
    const percentDisplay = document.getElementById('extractProgressPercent');
    const framesCountDisplay = document.getElementById('extractFramesCount');
    const currentMinDisplay = document.getElementById('extractCurrentMinute');
    const etaDisplay = document.getElementById('extractEta');
    const startBtn = document.getElementById('startExtractionBtn');
    const originalBtnText = startBtn ? startBtn.textContent : '';

    progressPanel?.classList.remove('hidden');
    const applyCrop = document.getElementById('clipperApplyCropCheck')?.checked ?? true;

    try {
      if (startBtn) startBtn.textContent = 'Extracting (0%)...';
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
          resolutionMode: this.state.extractResolutionMode || '1080p',
          customWidth: this.state.customExtractWidth || 1920,
          customHeight: this.state.customExtractHeight || 1080,
          watermark: this.getWatermarkConfig(),
          targetWidth: applyCrop ? this.state.exportWidth : undefined,
          targetHeight: applyCrop ? this.state.exportHeight : undefined
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
      progressPanel?.classList.add('hidden');
      if (startBtn && originalBtnText) startBtn.textContent = originalBtnText;
      document.getElementById('framesGallerySection')?.classList.remove('hidden');

      this.refreshGallery();
      this.storyController?.markDirtyAndSave();
      if (this.extractor.cancelRequested) {
        this.ui.showToast(`Extraction cancelled. Kept ${frames.length} photos.`, 'info');
      } else {
        this.ui.showToast(`Extracted ${frames.length} photos successfully!`, 'success');
      }
    } catch (err) {
      progressPanel?.classList.add('hidden');
      if (startBtn && originalBtnText) startBtn.textContent = originalBtnText;
      this.ui.showToast(`Extraction stopped: ${err.message}`, 'error');
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
            if (removed && removed.previewUrl && typeof removed.previewUrl === 'string' && removed.previewUrl.startsWith('blob:')) {
              try { URL.revokeObjectURL(removed.previewUrl); } catch (e) { }
            }
            this.refreshGallery();
          }
        },
        onPreviewFrame: (frame) => {
          const modal = document.getElementById('framePreviewModal');
          const img = document.getElementById('modalPreviewImg');
          const meta = document.getElementById('modalMetaRow');
          if (modal && img) {
            img.src = frame.previewUrl || frame.dataUrl || '';
            meta.textContent = `Timestamp: ${this.ui.formatTime(frame.timestamp || 0)} · Resolution: ${frame.width || 1280}x${frame.height || 720}`;
            modal.classList.remove('hidden');
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
    const modal = document.getElementById('recropFrameModal');
    const canvas = document.getElementById('recropPreviewCanvas');
    const slider = document.getElementById('modalFramingSlider');
    const valSpan = document.getElementById('modalFramingVal');

    if (!modal || !canvas) return;

    const initialVal = Math.round((frame.cropOffsetX ?? 0.5) * 100);
    if (slider) slider.value = initialVal;
    if (valSpan) valSpan.textContent = `${initialVal}%`;

    const renderPreview = async () => {
      const bmp = await this.extractor.getBitmap(frame);
      if (!bmp) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const ratio = frame.aspectRatio || this.state.aspectRatio || '16:9';
      const offset = (slider ? parseFloat(slider.value) : 50) / 100;
      const bounds = this.extractor.computeCropBounds(bmp.width, bmp.height, ratio, offset);

      // Draw dimmed background
      ctx.globalAlpha = 0.3;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

      // Draw highlighted crop window in center of preview
      ctx.globalAlpha = 1.0;
      const scale = Math.min((canvas.width * 0.9) / bounds.cropW, (canvas.height * 0.9) / bounds.cropH);
      const destW = bounds.cropW * scale;
      const destH = bounds.cropH * scale;
      const destX = (canvas.width - destW) / 2;
      const destY = (canvas.height - destH) / 2;

      ctx.save();
      ctx.strokeStyle = '#6366f1';
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

    // Direct drag on recrop preview canvas
    let isModalDragging = false;
    let modalStartX = 0;
    let modalStartVal = 50;
    canvas.style.cursor = 'grab';
    canvas.onpointerdown = (e) => {
      isModalDragging = true;
      modalStartX = e.clientX;
      modalStartVal = slider ? parseFloat(slider.value) : 50;
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e) => {
      if (!isModalDragging) return;
      const deltaX = e.clientX - modalStartX;
      const sensitivity = 0.35;
      const newVal = Math.max(0, Math.min(100, Math.round(modalStartVal + (deltaX * sensitivity))));
      if (slider) slider.value = newVal;
      if (valSpan) valSpan.textContent = `${newVal}%`;
      renderPreview();
    };
    const stopModalDrag = (e) => {
      if (isModalDragging) {
        isModalDragging = false;
        canvas.style.cursor = 'grab';
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) { }
      }
    };
    canvas.onpointerup = stopModalDrag;
    canvas.onpointercancel = stopModalDrag;

    const leftBtn = document.getElementById('modalAlignLeftBtn');
    const centerBtn = document.getElementById('modalAlignCenterBtn');
    const rightBtn = document.getElementById('modalAlignRightBtn');

    if (leftBtn) leftBtn.onclick = () => { if (slider) slider.value = 0; if (valSpan) valSpan.textContent = '0%'; renderPreview(); };
    if (centerBtn) centerBtn.onclick = () => { if (slider) slider.value = 50; if (valSpan) valSpan.textContent = '50%'; renderPreview(); };
    if (rightBtn) rightBtn.onclick = () => { if (slider) slider.value = 100; if (valSpan) valSpan.textContent = '100%'; renderPreview(); };

    const saveBtn = document.getElementById('saveRecropBtn');
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
              targetWidth: (frame.isCropped !== false && reCropRatio === this.state.aspectRatio) ? this.state.exportWidth : undefined,
              targetHeight: (frame.isCropped !== false && reCropRatio === this.state.aspectRatio) ? this.state.exportHeight : undefined
            });
            if (frame.previewUrl) this.extractor.revokeBlobUrl(frame.previewUrl);
            frame.blob = reFrame.blob;
            frame.previewUrl = reFrame.previewUrl;
            frame.width = reFrame.width;
            frame.height = reFrame.height;
          } catch (e) {
            console.warn('Re-crop capture error:', e);
          }
        }
        this.refreshGallery();
        modal.classList.add('hidden');
        this.ui.showToast('Framing changes saved.', 'success');
      };
    }

    const cancelBtn = document.getElementById('cancelRecropBtn');
    if (cancelBtn) cancelBtn.onclick = () => { modal.classList.add('hidden'); };
    const closeBtn = document.getElementById('closeRecropModalBtn');
    if (closeBtn) closeBtn.onclick = () => { modal.classList.add('hidden'); };

    modal.classList.remove('hidden');
    renderPreview();
  }

  clearAllExtractedFrames() {
    this.state.extractedFrames.forEach((f) => {
      if (f.previewUrl && typeof f.previewUrl === 'string' && f.previewUrl.startsWith('blob:')) {
        this.extractor.revokeBlobUrl(f.previewUrl);
      }
    });
    this.state.extractedFrames = [];
    this.extractor.clearCache();
    this.refreshGallery();
    document.getElementById('framesGallerySection')?.classList.remove('hidden');
    this.storyController?.markDirtyAndSave();
  }

  // =========================================================================
  // Step 2: Script & Voice-Over
  // =========================================================================

  bindStep2Events() {
    const scriptTextarea = document.getElementById('scriptTextarea');

    scriptTextarea.addEventListener('input', () => {
      this.handleScriptChange(scriptTextarea.value);
    });

    document.getElementById('loadSampleScriptBtn')?.addEventListener('click', () => {
      const hindiSample = `प्रकृति की सुंदरता हमें शांति और नई ऊर्जा देती है।
The sound of gentle breeze and flowing streams calms our mind.
हर नया दिन एक नई शुरुआत और नई उम्मीद लेकर आता है।
Life moves forward with small, beautiful moments that stay with us forever.
अपने सपनों पर विश्वास रखें और निरंतर आगे बढ़ते रहें।`;
      scriptTextarea.value = hindiSample;
      this.handleScriptChange(hindiSample);
      this.ui.showToast('Loaded sample Hindi + English script.', 'success');
    });

    document.getElementById('realignCaptionsBtn')?.addEventListener('click', () => {
      this.realignCaptionsWithCurrentVoice();
      this.ui.showToast('Captions realigned with audio timing.', 'success');
    });

    // Voice Mode Tabs (Mode B: My own voice vs Mode A: TTS)
    const btnB = document.getElementById('voiceModeBtnB') || document.getElementById('tabModeB');
    const btnA = document.getElementById('voiceModeBtnA') || document.getElementById('tabModeA');
    btnB?.addEventListener('click', () => {
      this.setVoiceMode('B');
    });
    btnA?.addEventListener('click', () => {
      this.setVoiceMode('A');
    });

    // Sub-tabs in Mode B (Upload vs Record)
    document.getElementById('subTabUpload')?.addEventListener('click', (e) => {
      e.target.classList.add('active');
      document.getElementById('subTabRecord')?.classList.remove('active');
      document.getElementById('audioUploadArea')?.classList.remove('hidden');
      document.getElementById('audioRecordArea')?.classList.add('hidden');
    });

    document.getElementById('subTabRecord')?.addEventListener('click', (e) => {
      e.target.classList.add('active');
      document.getElementById('subTabUpload')?.classList.remove('active');
      document.getElementById('audioRecordArea')?.classList.remove('hidden');
      document.getElementById('audioUploadArea')?.classList.add('hidden');
    });

    // Audio File Upload
    const audioFileInput = document.getElementById('audioFileInput');
    const audioDropzone = document.getElementById('audioDropzone');

    audioDropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      audioDropzone.style.borderColor = 'var(--accent-primary)';
    });
    audioDropzone?.addEventListener('dragleave', () => {
      audioDropzone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    });
    audioDropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      audioDropzone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        this.handleAudioFile(e.dataTransfer.files[0]);
      }
    });

    audioFileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleAudioFile(e.target.files[0]);
      }
    });

    // Live Recording
    const recordVoiceBtn = document.getElementById('recordVoiceBtn') || document.getElementById('startRecordBtn');
    const stopRecordBtn = document.getElementById('stopRecordBtn');

    recordVoiceBtn?.addEventListener('click', async () => {
      try {
        await this.voiceEngine.startRecording(null, null, (sec) => {
          if (recordVoiceBtn) recordVoiceBtn.textContent = `🔴 Recording (${this.ui.formatTime(sec)})...`;
        });
        recordVoiceBtn.classList.add('hidden');
        stopRecordBtn?.classList.remove('hidden');
        this.ui.showToast('Microphone recording started. Speak now!', 'info');
      } catch (err) {
        this.ui.showToast(`Microphone access error: ${err.message}`, 'error');
      }
    });

    stopRecordBtn?.addEventListener('click', async () => {
      try {
        const buffer = await this.voiceEngine.stopRecording();
        recordVoiceBtn?.classList.remove('hidden');
        if (recordVoiceBtn) recordVoiceBtn.textContent = '🔴 Record Microphone';
        stopRecordBtn?.classList.add('hidden');
        this.onVoiceLoaded(buffer, 'recorded_voice.wav');
        this.ui.showToast('Voice recording saved successfully!', 'success');
      } catch (err) {
        this.ui.showToast(`Failed to save recording: ${err.message}`, 'error');
      }
    });

    // Voice preview buttons
    const playAudioBtn = document.getElementById('playAudioPreviewBtn');
    const stopAudioBtn = document.getElementById('stopAudioPreviewBtn');

    playAudioBtn?.addEventListener('click', () => {
      if (this.voiceEngine.isAudioPlaying) {
        this.voiceEngine.stopPreview();
        playAudioBtn.textContent = '▶ Play Voice';
        stopAudioBtn?.classList.add('hidden');
      } else {
        playAudioBtn.textContent = '⏸ Pause';
        stopAudioBtn?.classList.remove('hidden');
        this.voiceEngine.playPreview(0, () => {
          playAudioBtn.textContent = '▶ Play Voice';
          stopAudioBtn?.classList.add('hidden');
        });
      }
    });

    stopAudioBtn?.addEventListener('click', () => {
      this.voiceEngine.stopPreview();
      if (playAudioBtn) playAudioBtn.textContent = '▶ Play Voice';
      stopAudioBtn?.classList.add('hidden');
    });

    // TTS generated audio preview buttons (Mode A)
    const playTtsBtn = document.getElementById('playTtsPreviewAudioBtn');
    const stopTtsBtn = document.getElementById('stopTtsPreviewAudioBtn');

    playTtsBtn?.addEventListener('click', () => {
      if (this.voiceEngine.isAudioPlaying) {
        this.voiceEngine.stopPreview();
        playTtsBtn.textContent = '▶ Play Voice';
        stopTtsBtn?.classList.add('hidden');
      } else {
        playTtsBtn.textContent = '⏸ Pause';
        stopTtsBtn?.classList.remove('hidden');
        this.voiceEngine.playPreview(0, () => {
          playTtsBtn.textContent = '▶ Play Voice';
          stopTtsBtn?.classList.add('hidden');
        });
      }
    });

    stopTtsBtn?.addEventListener('click', () => {
      this.voiceEngine.stopPreview();
      if (playTtsBtn) playTtsBtn.textContent = '▶ Play Voice';
      stopTtsBtn?.classList.add('hidden');
    });

    document.getElementById('reRecordBtn')?.addEventListener('click', () => {
      this.voiceEngine.stopPreview();
      document.getElementById('audioPlayerPanel')?.classList.add('hidden');
      document.getElementById('subTabUpload')?.click();
    });

    // Audio Clean-up Controls
    document.getElementById('toggleAbTestBtn')?.addEventListener('click', (e) => {
      this.voiceEngine.settings.abCleanedActive = !this.voiceEngine.settings.abCleanedActive;
      const on = this.voiceEngine.settings.abCleanedActive;
      e.target.textContent = on ? '🔊 Test: Cleaned (ON)' : '🔇 Test: Raw Audio (OFF)';
      this.ui.showToast(on ? 'Audio DSP clean-up active' : 'Audio DSP bypassed (Raw)', 'info');
    });

    document.getElementById('enableNoiseReduction')?.addEventListener('change', (e) => {
      this.voiceEngine.settings.reduceNoise = e.target.checked;
    });

    document.getElementById('enableNormalize')?.addEventListener('change', (e) => {
      this.voiceEngine.settings.normalize = e.target.checked;
    });

    // EQ Sliders
    const lowSlider = document.getElementById('eqLowSlider');
    const midSlider = document.getElementById('eqMidSlider');
    const highSlider = document.getElementById('eqHighSlider');
    const volSlider = document.getElementById('voiceVolumeSlider');

    lowSlider?.addEventListener('input', (e) => {
      this.voiceEngine.settings.eqLow = parseFloat(e.target.value);
      document.getElementById('eqLowVal').textContent = `${e.target.value} dB`;
    });
    midSlider?.addEventListener('input', (e) => {
      this.voiceEngine.settings.eqMid = parseFloat(e.target.value);
      document.getElementById('eqMidVal').textContent = `${e.target.value} dB`;
    });
    highSlider?.addEventListener('input', (e) => {
      this.voiceEngine.settings.eqHigh = parseFloat(e.target.value);
      document.getElementById('eqHighVal').textContent = `${e.target.value} dB`;
    });
    volSlider?.addEventListener('input', (e) => {
      this.voiceEngine.settings.masterGain = parseFloat(e.target.value) / 100;
      document.getElementById('voiceVolumeVal').textContent = `${e.target.value}%`;
    });

    // Mode A: TTS Controls
    this.bindTtsEvents();
  }

  setVoiceMode(mode, skipRealign = false) {
    this.state.voiceMode = mode;
    const tabB = document.getElementById('voiceModeBtnB') || document.getElementById('tabModeB');
    const tabA = document.getElementById('voiceModeBtnA') || document.getElementById('tabModeA');
    const contB = document.getElementById('voiceModeCardB') || document.getElementById('modeBContainer');
    const contA = document.getElementById('voiceModeCardA') || document.getElementById('modeAContainer');
    const exp1 = document.getElementById('exportMode1Block');
    const exp2 = document.getElementById('exportMode2Block');

    if (mode === 'B') {
      tabB?.classList.add('active');
      tabA?.classList.remove('active');
      contB?.classList.remove('hidden');
      contB?.classList.add('active');
      contA?.classList.add('hidden');
      contA?.classList.remove('active');
      exp1?.classList.remove('hidden');
      exp2?.classList.add('hidden');
      if (!skipRealign) this.realignCaptionsWithCurrentVoice();
    } else {
      tabA?.classList.add('active');
      tabB?.classList.remove('active');
      contA?.classList.remove('hidden');
      contA?.classList.add('active');
      contB?.classList.add('hidden');
      contB?.classList.remove('active');
      exp2?.classList.remove('hidden');
      exp1?.classList.add('hidden');
      this.updateBackendVoiceStatus();
      this.recalculateTtsTimelineDuration();
      if (!skipRealign) this.realignCaptionsWithCurrentVoice();
    }
  }

  /**
   * Reads current rate, pitch, volume and voice as single source of truth
   */
  getTtsOptions() {
    const rateSlider = document.getElementById('ttsRateSlider');
    const pitchSlider = document.getElementById('ttsPitchSlider');
    const volSlider = document.getElementById('ttsVolumeSlider');
    const voiceSelect = document.getElementById('ttsVoiceSelect');

    const rate = rateSlider ? parseFloat(rateSlider.value) : (this.state.ttsOptions.rate ?? 1.0);
    const pitch = pitchSlider ? parseFloat(pitchSlider.value) : (this.state.ttsOptions.pitch ?? 1.0);
    const volume = volSlider ? parseFloat(volSlider.value) : (this.state.ttsOptions.volume ?? 1.0);

    let voice = (voiceSelect && voiceSelect.value) ? voiceSelect.value : (this.state.ttsOptions.voice || 'hi-IN-SwaraNeural');
    if (typeof voice === 'object' && voice) {
      voice = voice.voiceURI || voice.name || 'hi-IN-SwaraNeural';
    }

    const finalRate = isNaN(rate) ? 1.0 : rate;
    const finalPitch = isNaN(pitch) ? 1.0 : pitch;
    const finalVolume = isNaN(volume) ? 1.0 : volume;

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
    const banner = document.getElementById('ttsBackendBanner');
    if (banner) {
      if (isUp) {
        banner.classList.add('hidden');
      } else {
        banner.classList.remove('hidden');
      }
    }
    const voiceSelect = document.getElementById('ttsVoiceSelect');
    if (voiceSelect) {
      Array.from(voiceSelect.options).forEach((opt) => {
        if (opt.value && opt.value.includes('Neural')) {
          if (!isUp) {
            opt.disabled = true;
            if (!opt.textContent.includes('(Offline')) {
              opt.textContent = `${opt.textContent.replace('⭐ ', '')} (Offline - Requires npm start)`;
            }
          } else {
            opt.disabled = false;
            opt.textContent = opt.textContent.replace(' (Offline - Requires npm start)', '');
            if (!opt.textContent.startsWith('⭐ ')) {
              opt.textContent = `⭐ ${opt.textContent}`;
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
      this.ui.showToast(`Loaded voice file: ${file.name}`, 'success');
    } catch (err) {
      this.ui.showToast(`Failed to decode audio file: ${err.message}`, 'error');
    }
  }

  onVoiceLoaded(buffer, filename, skipRealign = false) {
    this.voiceEngine.setAudioBuffer(buffer, filename);

    // Update Mode B bar
    const nameEl = document.getElementById('audioFileNameDisplay');
    if (nameEl) nameEl.textContent = filename;
    const durEl = document.getElementById('audioDurationDisplay');
    if (durEl) durEl.textContent = this.ui.formatTime(buffer?.duration || 0);
    document.getElementById('audioPlayerPanel')?.classList.remove('hidden');

    // Update Mode A bar
    const ttsNameEl = document.getElementById('ttsAudioFileNameDisplay');
    if (ttsNameEl) ttsNameEl.textContent = filename;
    const ttsDurEl = document.getElementById('ttsAudioDurationDisplay');
    if (ttsDurEl) ttsDurEl.textContent = this.ui.formatTime(buffer?.duration || 0);
    if (this.state.voiceMode === 'A' || filename === 'tts_voice.wav') {
      document.getElementById('ttsAudioPlayerPanel')?.classList.remove('hidden');
    }

    // Set timeline duration to match voice duration if match-voice is selected
    const durMode = document.getElementById('durationModeSelect')?.value;
    if (!durMode || durMode === 'match-voice') {
      const voiceSec = Math.max(5, Math.ceil(buffer?.duration || 60));
      this.state.timelineDuration = voiceSec;
      const durInput = document.getElementById('timelineDurationInput');
      if (durInput) durInput.value = voiceSec;
    }

    // Draw waveform bar
    const canvas = document.getElementById('waveformBarCanvas');
    if (canvas) this.voiceEngine.drawWaveform(canvas, buffer);

    // Detect pauses / silence gaps for snapping
    this.state.silenceGaps = this.voiceEngine.detectSilenceGaps();

    // Update Mode 3 button text to reflect voice
    this.updateFastExportButtonLabel();

    // Realign captions unless caller preserves exact sentence timings
    if (!skipRealign) {
      this.realignCaptionsWithCurrentVoice();
    }
  }


  handleScriptChange(text) {
    this.state.scriptText = text;

    // Stats
    const charCount = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    // Average speech rate: 130 words/min adjusted by current rate multiplier
    const rate = this.state.ttsOptions?.rate || 1.0;
    const estSec = Math.round((words / (130 * rate)) * 60);

    document.getElementById('scriptCharCount').textContent = charCount;
    document.getElementById('scriptWordCount').textContent = words;
    document.getElementById('scriptEstTime').textContent = this.ui.formatTime(estSec);

    // Sentence splitting
    const rawSentences = this.captionEngine.splitScriptIntoSentences(text);
    document.getElementById('scriptChunksCount').textContent = rawSentences.length;

    // Auto-detect Hindi script and switch language filter if needed
    const hasHindi = /[\u0900-\u097F]/.test(text);
    const langSelect = document.getElementById('ttsLanguageSelect');
    if (hasHindi && langSelect && langSelect.value !== 'hi') {
      langSelect.value = 'hi';
      this.populateTtsLanguagesAndVoices(false);
    }

    if (this.state.voiceMode === 'A') {
      this.recalculateTtsTimelineDuration();
    }
    this.realignCaptionsWithCurrentVoice();
    this.youtubeGenerator?.updateScriptSummary();
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
    const btn = document.getElementById('startFastSilentExportBtn');
    if (!btn) return;
    const span = btn.querySelector('span');
    const label = 'Fast Render with Voice (WebCodecs)';
    if (span) span.textContent = label;
    else btn.textContent = label;

    const heading = btn.closest('.export-mode-block')?.querySelector('h5');
    if (heading) {
      heading.textContent = 'Mode 3: Ultra-Fast Video (adds your voice if loaded)';
    }
  }

  // TTS Setup
  bindTtsEvents() {
    const langSelect = document.getElementById('ttsLanguageSelect');
    const voiceSelect = document.getElementById('ttsVoiceSelect');
    const searchInput = document.getElementById('ttsVoiceSearch');
    const toneSelect = document.getElementById('ttsToneSelect');
    const rateSlider = document.getElementById('ttsRateSlider');
    const pitchSlider = document.getElementById('ttsPitchSlider');
    const volSlider = document.getElementById('ttsVolumeSlider');
    const previewBtn = document.getElementById('previewTtsVoiceBtn') || document.getElementById('previewTts10sBtn') || document.getElementById('previewTtsBtn');
    const stopBtn = document.getElementById('stopVoicePreviewBtn') || document.getElementById('stopTtsPreviewBtn');

    langSelect?.addEventListener('change', () => {
      this.populateTtsLanguagesAndVoices(false);
    });

    voiceSelect?.addEventListener('change', () => {
      const selectedVal = voiceSelect.value;
      if (selectedVal.includes('Neural')) {
        this.state.ttsOptions.voice = { name: selectedVal, voiceURI: selectedVal, lang: selectedVal.startsWith('hi-') ? 'hi-IN' : 'en' };
      } else {
        const found = this.voiceEngine.voices.find(
          (v) => (v.voiceURI && v.voiceURI === selectedVal) || v.name === selectedVal
        );
        this.state.ttsOptions.voice = found || { name: selectedVal, voiceURI: selectedVal, lang: 'en' };
      }
      this.updateTtsVoiceDetails(this.state.ttsOptions.voice);
    });

    searchInput?.addEventListener('input', () => {
      this.populateTtsLanguagesAndVoices(false);
    });

    // Helper to synchronize rate, pitch, badges and quick button states
    const updateRateAndPitchUI = (rate, pitch, syncTone = true) => {
      const finalRate = Number(rate).toFixed(2).replace(/\.00$/, '.0').replace(/\.([1-9])0$/, '.$1');
      const finalPitch = Number(pitch).toFixed(2).replace(/\.00$/, '.0').replace(/\.([1-9])0$/, '.$1');

      if (rateSlider) rateSlider.value = rate;
      const rateVal = document.getElementById('ttsRateVal');
      const rateDisp = document.getElementById('ttsRateDisplay');
      if (rateVal) rateVal.textContent = `${finalRate}x`;
      if (rateDisp) rateDisp.textContent = `${finalRate}x`;

      const speedBadge = document.getElementById('speedBadge');
      if (speedBadge) {
        if (rate < 0.85) speedBadge.textContent = 'Slow & Clear';
        else if (rate <= 1.15) speedBadge.textContent = 'Normal Speed';
        else if (rate <= 1.5) speedBadge.textContent = 'Fast Pace';
        else if (rate < 2.0) speedBadge.textContent = 'Very Fast';
        else if (rate < 2.3) speedBadge.textContent = '⚡ Double Speed (2x)';
        else speedBadge.textContent = '🚀 Hyper Speed (2.5x)';
      }

      if (pitchSlider) pitchSlider.value = pitch;
      const pitchVal = document.getElementById('ttsPitchVal');
      const pitchDisp = document.getElementById('ttsPitchDisplay');
      if (pitchVal) pitchVal.textContent = `${finalPitch}x`;
      if (pitchDisp) pitchDisp.textContent = `${finalPitch}x`;

      const pitchBadge = document.getElementById('pitchBadge');
      if (pitchBadge) {
        if (pitch < 0.8) pitchBadge.textContent = 'Deep Voice';
        else if (pitch < 0.95) pitchBadge.textContent = 'Warm & Low';
        else if (pitch <= 1.05) pitchBadge.textContent = 'Natural Tone';
        else if (pitch <= 1.25) pitchBadge.textContent = 'Bright & Crisp';
        else pitchBadge.textContent = 'High Pitch';
      }

      // Sync active state on speed quick buttons
      document.querySelectorAll('.speed-quick-btn').forEach((btn) => {
        const bRate = parseFloat(btn.dataset.rate);
        btn.classList.toggle('active', Math.abs(bRate - rate) < 0.03);
      });

      // Sync active state on pitch quick buttons
      document.querySelectorAll('.pitch-quick-btn').forEach((btn) => {
        const bPitch = parseFloat(btn.dataset.pitch);
        btn.classList.toggle('active', Math.abs(bPitch - pitch) < 0.03);
      });

      if (syncTone && toneSelect) {
        const matched = Object.entries(TONE_PRESETS).find(
          ([key, p]) => Math.abs(p.rate - rate) < 0.03 && Math.abs(p.pitch - pitch) < 0.03
        );
        if (matched) {
          toneSelect.value = matched[0];
          const toneBadge = document.getElementById('activeToneBadge');
          if (toneBadge) toneBadge.textContent = matched[1].label;
          document.querySelectorAll('.preset-pill').forEach((p) => {
            p.classList.toggle('active', p.dataset.preset === matched[0]);
          });
        } else {
          toneSelect.value = 'custom';
          const toneBadge = document.getElementById('activeToneBadge');
          if (toneBadge) toneBadge.textContent = 'Custom Tuned';
          document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
        }
      }

      if (this.state.voiceMode === 'A') {
        this.recalculateTtsTimelineDuration();
      }
    };

    // Tone Preset Dropdown
    toneSelect?.addEventListener('change', (e) => {
      const preset = TONE_PRESETS[e.target.value];
      if (!preset) return;

      this.state.ttsOptions.rate = preset.rate;
      this.state.ttsOptions.pitch = preset.pitch;

      const toneBadge = document.getElementById('activeToneBadge');
      if (toneBadge) toneBadge.textContent = preset.label;

      document.querySelectorAll('.preset-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.preset === e.target.value);
      });

      updateRateAndPitchUI(preset.rate, preset.pitch, false);
    });

    rateSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      const safeRate = isNaN(val) ? 1.0 : val;
      this.state.ttsOptions.rate = safeRate;
      updateRateAndPitchUI(safeRate, this.state.ttsOptions.pitch, true);
    });

    pitchSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      const safePitch = isNaN(val) ? 1.0 : val;
      this.state.ttsOptions.pitch = safePitch;
      updateRateAndPitchUI(this.state.ttsOptions.rate, safePitch, true);
    });

    // Speed Quick Buttons (0.75x to 2.5x)
    document.querySelectorAll('.speed-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = parseFloat(btn.dataset.rate);
        if (!isNaN(r)) {
          this.state.ttsOptions.rate = r;
          updateRateAndPitchUI(r, this.state.ttsOptions.pitch, true);
        }
      });
    });

    // Pitch Quick Buttons
    document.querySelectorAll('.pitch-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = parseFloat(btn.dataset.pitch);
        if (!isNaN(p)) {
          this.state.ttsOptions.pitch = p;
          updateRateAndPitchUI(this.state.ttsOptions.rate, p, true);
        }
      });
    });

    volSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.state.ttsOptions.volume = isNaN(val) ? 1.0 : val;
      const volVal = document.getElementById('ttsVolumeVal');
      if (volVal) volVal.textContent = `${Math.round(val * 100)}%`;
    });

    // Preset Tone Pills
    document.querySelectorAll('.preset-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        const presetKey = pill.dataset.preset;
        const preset = TONE_PRESETS[presetKey];
        const rate = preset ? preset.rate : parseFloat(pill.dataset.rate);
        const pitch = preset ? preset.pitch : parseFloat(pill.dataset.pitch);

        this.state.ttsOptions.rate = rate;
        this.state.ttsOptions.pitch = pitch;

        if (toneSelect && presetKey) toneSelect.value = presetKey;
        const toneBadge = document.getElementById('activeToneBadge');
        if (toneBadge && preset) toneBadge.textContent = preset.label;

        document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');

        updateRateAndPitchUI(rate, pitch, false);
      });
    });

    // Preview Voice Button (Speaks sample or script sentences)
    previewBtn?.addEventListener('click', () => {
      let previewText = '';
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      if (rawSentences.length > 0) {
        previewText = rawSentences.slice(0, 2).join(' ');
      } else {
        const isHindi = /[\u0900-\u097F]/.test(this.state.scriptText || '');
        if (isHindi) {
          previewText = 'नमस्ते, यह स्टोरीफ्लो स्टूडियो का वॉयस टेस्ट है। हम आपके वीडियो के लिए सुंदर एनीमーション बनाते हैं।';
        } else {
          previewText = 'Hello! This is a voice-over preview test in StoryFlow Studio. Your story will come alive with cinematic photo animation.';
        }
      }

      previewBtn?.classList.add('hidden');
      stopBtn?.classList.remove('hidden');

      const onDone = () => {
        previewBtn?.classList.remove('hidden');
        stopBtn?.classList.add('hidden');
      };

      const ttsOpts = this.getTtsOptions();

      this.voiceEngine.speakSingle(
        previewText,
        ttsOpts,
        () => { },
        onDone,
        (err) => {
          console.warn('[TTS Preview Fallback]', err);
          this.ui.showToast(`Neural voice unavailable (${err.message}). Using browser speech synthesis fallback.`, 'warning', 6000);
          onDone();
        }
      );
    });

    const speakFullBtn = document.getElementById('speakFullTtsBtn');
    const recordTtsBtn = document.getElementById('recordTtsToAudioBtn');

    stopBtn?.addEventListener('click', () => {
      this.voiceEngine.stopPreview();
      this.voiceEngine.stopSpeaking();
      previewBtn?.classList.remove('hidden');
      stopBtn?.classList.add('hidden');
      if (speakFullBtn) {
        speakFullBtn.classList.remove('btn-primary');
        speakFullBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          ▶️ Speak Full Voice-Over`;
      }
    });

    // 1. Speak Full Voice-Over
    speakFullBtn?.addEventListener('click', () => {
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      if (!rawSentences.length) {
        this.ui.showToast('Please enter or paste your script first to speak full voice-over.', 'error');
        return;
      }

      speakFullBtn.classList.add('btn-primary');
      speakFullBtn.innerHTML = `<span>🔊 Speaking Full Voice (1/${rawSentences.length})...</span>`;

      const ttsOpts = this.getTtsOptions();

      this.voiceEngine.speakChunks(
        rawSentences,
        ttsOpts,
        (idx) => {
          speakFullBtn.innerHTML = `<span>🔊 Speaking Full Voice (${idx + 1}/${rawSentences.length})...</span>`;
        },
        () => {
          speakFullBtn.classList.remove('btn-primary');
          speakFullBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            ▶️ Speak Full Voice-Over`;
          this.ui.showToast('Full voice-over playback completed!', 'success');
        }
      );
    });

    // 2. One-Click Option to Generate Voice File (Natural Hindi/English) via msedge-tts
    const generateNeuralBtn = document.getElementById('generateNeuralTtsBtn');
    generateNeuralBtn?.addEventListener('click', () => {
      this.generateNeuralVoiceAction();
    });

    // 3. Record Full TTS into an Audio Track (Tab Capture) - Legacy / Unreliable
    recordTtsBtn?.addEventListener('click', async () => {
      this.ui.showToast('⚠️ Note: Tab capture is unreliable and often silent. Recommend using "Generate Voice File (Natural Hindi/English)" instead.', 'info', 5000);
      const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
      if (!rawSentences.length) {
        this.ui.showToast('Please enter your script first before generating audio.', 'error');
        return;
      }

      try {
        this.ui.showToast('In the popup: choose "This Tab" and tick "Share tab audio".', 'info', 6000);
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
          preferCurrentTab: true
        });

        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          stream.getTracks().forEach((t) => t.stop());
          this.ui.showToast('Tab audio was not checked. Please choose "Chrome Tab" / "Edge Tab" and tick "Share tab audio".', 'error', 6000);
          return;
        }

        // Isolate audio stream only and stop video tracks to prevent MediaRecorder mimeType errors
        const audioOnlyStream = new MediaStream(audioTracks);
        stream.getVideoTracks().forEach((t) => t.stop());

        recordTtsBtn.disabled = true;
        recordTtsBtn.innerHTML = `<span>🎙️ Recording TTS Audio Track...</span>`;

        let mimeType = '';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        }
        const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.start(100);

        // Speak all sentences
        this.voiceEngine.speakChunks(
          rawSentences,
          this.state.ttsOptions,
          (idx) => {
            recordTtsBtn.innerHTML = `<span>🎙️ Recording Chunk (${idx + 1}/${rawSentences.length})...</span>`;
          },
          async () => {
            setTimeout(async () => {
              if (recorder.state !== 'inactive') recorder.stop();
              audioTracks.forEach((t) => t.stop());
            }, 600);
          }
        );

        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            const buffer = await this.voiceEngine.loadAudioFile(blob, 'generated_tts_voice.webm');
            this.onVoiceLoaded(buffer, 'generated_tts_voice.webm');
            this.setVoiceMode('B');
            recordTtsBtn.disabled = false;
            recordTtsBtn.innerHTML = `🎙️ Record Full TTS into Audio Track (Tab Capture)`;
            this.ui.showToast('🎉 Full voice-over generated & saved into audio track!', 'success', 5000);
          } catch (err) {
            recordTtsBtn.disabled = false;
            recordTtsBtn.innerHTML = `🎙️ Record Full TTS into Audio Track (Tab Capture)`;
            this.ui.showToast(`Failed to process recorded audio: ${err.message}`, 'error');
          }
        };
      } catch (err) {
        recordTtsBtn.disabled = false;
        recordTtsBtn.innerHTML = `🎙️ Record Full TTS into Audio Track (Tab Capture)`;
        this.ui.showToast(`Tab share cancelled: ${err.message}`, 'info');
      }
    });
  }

  async generateNeuralVoiceAction() {
    const rawSentences = this.captionEngine.splitScriptIntoSentences(this.state.scriptText);
    if (!rawSentences.length) {
      this.ui.showToast('Please enter your script first in Step 2 before generating voice.', 'error');
      return null;
    }

    const generateNeuralBtn = document.getElementById('generateNeuralTtsBtn');
    const originalHtml = generateNeuralBtn ? generateNeuralBtn.innerHTML : '';
    if (generateNeuralBtn) {
      generateNeuralBtn.disabled = true;
      generateNeuralBtn.innerHTML = `<span>⏳ Generating Voice (Neural TTS)...</span>`;
    }

    try {
      const ttsOpts = this.getTtsOptions();
      let selectedVoice = ttsOpts.voice;
      const isHindi = /[\u0900-\u097F]/.test(this.state.scriptText);
      if (isHindi && (!selectedVoice || selectedVoice.startsWith('en-') || !selectedVoice.includes('hi-IN'))) {
        selectedVoice = 'hi-IN-SwaraNeural';
        const voiceSelect = document.getElementById('ttsVoiceSelect');
        if (voiceSelect) voiceSelect.value = selectedVoice;
        ttsOpts.voice = selectedVoice;
      } else if (!selectedVoice || !selectedVoice.includes('Neural')) {
        selectedVoice = isHindi ? 'hi-IN-SwaraNeural' : 'en-IN-NeerjaNeural';
        ttsOpts.voice = selectedVoice;
      }

      const result = await this.voiceEngine.generateVoiceFromScript(rawSentences, {
        voice: selectedVoice,
        rate: ttsOpts.rate,
        pitch: ttsOpts.pitch,
        volume: ttsOpts.volume,
        onProgress: (current, total) => {
          if (generateNeuralBtn) {
            generateNeuralBtn.innerHTML = `<span>⏳ Generating Voice (${current}/${total} sentences)...</span>`;
          }
        }
      });

      // Updates timelineDuration to the voice duration
      const voiceDur = Math.max(5, Math.ceil(result.buffer.duration));
      this.state.timelineDuration = voiceDur;
      const durInput = document.getElementById('timelineDurationInput');
      if (durInput) durInput.value = voiceDur;

      // Set captionEngine.chunks directly from exact sentenceTimings
      this.captionEngine.chunks = result.sentenceTimings.map((st, idx) => ({
        id: `cap_${idx + 1}`,
        index: idx + 1,
        text: st.text,
        start: Number(st.start.toFixed(2)),
        end: Number(st.end.toFixed(2)),
        duration: Number((st.end - st.start).toFixed(2)),
        isManuallyEdited: false
      }));

      // Re-renders the waveform and mounts the audio player panel without wiping captions
      this.onVoiceLoaded(result.buffer, 'tts_voice.wav', true);
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

      // Shows a toast with the duration
      this.ui.showToast(`🎉 Generated natural voice file (${result.buffer.duration.toFixed(1)}s)!`, 'success', 5000);
      return result;
    } catch (err) {
      console.error('[Generate Voice Error]', err);

      const is404 = err.message?.includes('404') || err.message?.includes('not found') || err.message?.includes('server not running') || err.message?.includes('static');
      const isNetErr = !navigator.onLine || err.message?.includes('Failed to connect') || err.message?.includes('fetch') || err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError');

      if (is404) {
        this.ui.showToast('⚠️ Online Neural TTS requires a backend server. Run `npm start` at http://localhost:3000.', 'warning', 9000);
      } else if (isNetErr) {
        this.ui.showToast('Could not reach TTS server. Start the local server with `npm start`, or upload your own voice file.', 'error', 7000);
      } else {
        this.ui.showToast(`Voice generation failed: ${err.message}`, 'error', 7000);
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
    const detailsEl = document.getElementById('ttsVoiceDetails');
    if (!detailsEl) return;
    if (!voice) {
      detailsEl.textContent = 'Default browser speech synthesizer';
      return;
    }
    const name = voice.name || voice.voiceURI || '';
    if (name.includes('Neural')) {
      const isHindi = name.includes('hi-IN') || name.includes('Swara') || name.includes('Madhur');
      const lang = isHindi ? 'hi-IN' : (name.includes('en-IN') ? 'en-IN' : 'en-US');
      let friendlyName = name;
      if (name.includes('Swara')) friendlyName = 'Swara (Hindi Female - Neural)';
      else if (name.includes('Madhur')) friendlyName = 'Madhur (Hindi Male - Neural)';
      else if (name.includes('Neerja')) friendlyName = 'Neerja (Indian English Female - Neural)';
      else if (name.includes('Jenny')) friendlyName = 'Jenny (US English Female - Neural)';
      detailsEl.textContent = `⭐ Microsoft Edge Neural Voice (Studio Quality) · ${lang} · ${friendlyName}`;
      return;
    }
    const isEdgeNatural = name.includes('Natural') || name.includes('Online');
    const isGoogle = name.includes('Google');
    let badge = 'System Voice';
    if (isEdgeNatural) badge = '⭐ Microsoft Edge Natural Voice (High Quality)';
    else if (isGoogle) badge = '🔷 Google TTS Voice';

    detailsEl.textContent = `${badge} · ${voice.lang || 'en'} · ${name}`;
  }

  recalculateTtsTimelineDuration() {
    if (this.state.voiceMode !== 'A') return;
    const words = this.state.scriptText.trim() ? this.state.scriptText.trim().split(/\s+/).length : 0;
    const rate = this.state.ttsOptions.rate || 1.0;
    // Base speaking rate: ~130 words per minute
    const estSec = Math.max(10, Math.round((words / (130 * rate)) * 60));
    this.voiceEngine.audioDuration = estSec;
    if (this.state.durationMode === 'match-voice') {
      this.state.timelineDuration = estSec;
      this.realignCaptionsWithCurrentVoice();
      if (this.state.currentStep === 3) this.rebuildTimeline();
    }
  }

  populateTtsLanguagesAndVoices(rebuildLanguages = true) {
    const langSelect = document.getElementById('ttsLanguageSelect');
    const voiceSelect = document.getElementById('ttsVoiceSelect');
    const searchInput = document.getElementById('ttsVoiceSearch');
    if (!voiceSelect) return;

    const voices = this.voiceEngine?.voices || [];
    const browserLang = navigator.language || 'en-US';
    const browserLangPrefix = browserLang.split('-')[0].toLowerCase();

    // 1. Rebuild Language Dropdown if requested
    if (rebuildLanguages && langSelect) {
      const currentSelectedLang = langSelect.value || 'browser-default';

      langSelect.innerHTML = '';

      // Default browser option
      const defOpt = document.createElement('option');
      defOpt.value = 'browser-default';
      defOpt.textContent = `🌐 Default Browser Language (${browserLang})`;
      langSelect.appendChild(defOpt);

      // Edge Natural & Google option
      const edgOpt = document.createElement('option');
      edgOpt.value = 'natural-google';
      edgOpt.textContent = `⭐ Microsoft Edge & Google TTS Voices`;
      langSelect.appendChild(edgOpt);

      // Hindi option
      const hiOpt = document.createElement('option');
      hiOpt.value = 'hi';
      hiOpt.textContent = `🇮🇳 Hindi (हिन्दी - hi-IN)`;
      langSelect.appendChild(hiOpt);

      // English India
      const enInOpt = document.createElement('option');
      enInOpt.value = 'en-in';
      enInOpt.textContent = `🇮🇳 English (India - en-IN)`;
      langSelect.appendChild(enInOpt);

      // English US
      const enUsOpt = document.createElement('option');
      enUsOpt.value = 'en-us';
      enUsOpt.textContent = `🇺🇸 English (US - en-US)`;
      langSelect.appendChild(enUsOpt);

      // English UK
      const enGbOpt = document.createElement('option');
      enGbOpt.value = 'en-gb';
      enGbOpt.textContent = `🇬🇧 English (UK - en-GB)`;
      langSelect.appendChild(enGbOpt);

      // All languages option
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = `🌍 All Languages (${voices.length} voices)`;
      langSelect.appendChild(allOpt);

      // Auto-select Hindi if script has Hindi characters
      const hasHindi = /[\u0900-\u097F]/.test(this.state.scriptText);
      if (hasHindi) {
        langSelect.value = 'hi';
      } else if (currentSelectedLang) {
        langSelect.value = currentSelectedLang;
      }
    }

    // 2. Filter voices based on Language Select and Search Query
    const selectedLangFilter = langSelect ? langSelect.value : 'browser-default';
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

    let filtered = voices.filter((v) => {
      const vLang = (v.lang || '').replace('_', '-').toLowerCase();
      const vName = (v.name || '').toLowerCase();

      // Language filter
      if (selectedLangFilter === 'browser-default') {
        const matchesBrowser = vLang.startsWith(browserLangPrefix);
        if (!matchesBrowser) return false;
      } else if (selectedLangFilter === 'natural-google') {
        const isNatOrGoogle = vName.includes('natural') || vName.includes('online') || vName.includes('google');
        if (!isNatOrGoogle) return false;
      } else if (selectedLangFilter === 'hi') {
        if (!vLang.startsWith('hi')) return false;
      } else if (selectedLangFilter === 'en-in') {
        if (!vLang.includes('en-in') && !(vLang.startsWith('en') && vName.includes('india'))) return false;
      } else if (selectedLangFilter === 'en-us') {
        if (!vLang.includes('en-us') && !vLang.includes('en-') && !vLang.startsWith('en')) return false;
      } else if (selectedLangFilter === 'en-gb') {
        if (!vLang.includes('en-gb') && !vLang.includes('en-uk')) return false;
      }

      // Search query
      if (searchQuery) {
        return vName.includes(searchQuery) || vLang.includes(searchQuery);
      }
      return true;
    });

    if (filtered.length === 0 && voices.length > 0) {
      // Fallback to all voices if filter produced 0 results
      filtered = voices;
    }

    // 3. Sort voices smartly: Edge Online Natural first, then Google TTS, then system voices
    filtered.sort((a, b) => {
      const aNat = (a.name.includes('Natural') || a.name.includes('Online')) ? 3 : (a.name.includes('Google') ? 2 : 1);
      const bNat = (b.name.includes('Natural') || b.name.includes('Online')) ? 3 : (b.name.includes('Google') ? 2 : 1);
      if (bNat !== aNat) return bNat - aNat;
      return a.name.localeCompare(b.name);
    });

    // 4. Populate Voice Select Dropdown
    voiceSelect.innerHTML = '';

    const isUp = this.state.isBackendUp !== false;
    const neuralGroup = document.createElement('optgroup');
    neuralGroup.label = isUp ? '⭐ Neural Voices (Free msedge-tts - Recommended)' : '⚠️ Neural Voices (Offline - Run npm start)';
    const neuralList = [
      { id: 'hi-IN-SwaraNeural', label: '⭐ Swara (Hindi Female - Neural Natural)' },
      { id: 'hi-IN-MadhurNeural', label: '⭐ Madhur (Hindi Male - Neural Natural)' },
      { id: 'en-IN-NeerjaNeural', label: '⭐ Neerja (Indian English Female - Neural Natural)' },
      { id: 'en-US-JennyNeural', label: '⭐ Jenny (US English Female - Neural Natural)' }
    ];
    neuralList.forEach((nv) => {
      const opt = document.createElement('option');
      opt.value = nv.id;
      opt.textContent = isUp ? nv.label : `${nv.label.replace('⭐ ', '')} (Offline - Requires npm start)`;
      if (!isUp) opt.disabled = true;
      neuralGroup.appendChild(opt);
    });
    voiceSelect.appendChild(neuralGroup);

    if (filtered.length > 0) {
      const systemGroup = document.createElement('optgroup');
      systemGroup.label = '🌐 Browser System Voices (SpeechSynthesis)';
      filtered.forEach((voice) => {
        const opt = document.createElement('option');
        opt.value = voice.voiceURI || voice.name;
        opt.textContent = `${voice.name} (${voice.lang})`;
        systemGroup.appendChild(opt);
      });
      voiceSelect.appendChild(systemGroup);
    } else if (voices.length === 0) {
      const systemGroup = document.createElement('optgroup');
      systemGroup.label = '🌐 Browser System Voices (SpeechSynthesis)';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'System voices loading / unavailable';
      opt.disabled = true;
      systemGroup.appendChild(opt);
      voiceSelect.appendChild(systemGroup);
    }

    // 5. Select active voice
    const hasHindi = /[\u0900-\u097F]/.test(this.state.scriptText);
    const defaultNeural = hasHindi ? 'hi-IN-SwaraNeural' : 'en-IN-NeerjaNeural';

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
    // Aspect Ratio format buttons
    document.getElementById('ratio16x9Btn')?.addEventListener('click', () => this.setAspectRatio('16:9'));
    document.getElementById('ratio9x16Btn')?.addEventListener('click', () => this.setAspectRatio('9:16'));
    document.getElementById('ratio720pBtn')?.addEventListener('click', () => this.setAspectRatio('16:9-720p'));

    // 9:16 Layout Sub-Option
    document.getElementById('verticalCropLayoutSelect')?.addEventListener('change', (e) => {
      this.state.verticalModeLayout = e.target.value;
      this.renderCurrentPreviewFrame();
    });

    // Duration Selector
    const durSelect = document.getElementById('durationModeSelect');
    const customGroup = document.getElementById('customDurationInputGroup');
    const customInput = document.getElementById('customDurationSeconds');

    durSelect?.addEventListener('change', () => {
      this.state.durationMode = durSelect.value;
      if (durSelect.value === 'custom') {
        customGroup?.classList.remove('hidden');
      } else {
        customGroup?.classList.add('hidden');
      }
      this.rebuildTimeline();
    });

    customInput?.addEventListener('input', () => {
      this.state.customDuration = Math.max(10, parseInt(customInput.value, 10) || 60);
      this.rebuildTimeline();
    });

    // Studio Customizer Tabs (Animation, Captions, Grading, Export)
    document.querySelectorAll('.settings-tab-nav .tab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.settings-tab-nav .tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.settings-tab-panel').forEach((p) => p.classList.remove('active'));
        e.target.classList.add('active');
        const tabId = e.target.dataset.tab;
        document.getElementById(tabId)?.classList.add('active');
      });
    });

    // Tab 1: Animations
    const minDurSlider = document.getElementById('photoMinDurationSlider');
    const maxDurSlider = document.getElementById('photoMaxDurationSlider');
    const zoomSlider = document.getElementById('zoomFactorSlider');
    const timelineSlider = document.getElementById('timelineSlider');
    const zoomInBtn = document.getElementById('timelineZoomInBtn');
    const zoomOutBtn = document.getElementById('timelineZoomOutBtn');
    const transSlider = document.getElementById('transitionDurationSlider');
    const transTypeSelect = document.getElementById('transitionTypeSelect');

    const syncZoom = (newZoom) => {
      const clamped = Math.min(1.5, Math.max(1.05, Math.round(newZoom * 100) / 100));
      this.state.maxZoom = clamped;
      const zoomValStr = `${clamped.toFixed(2)}x`;
      if (zoomSlider) zoomSlider.value = clamped;
      if (timelineSlider) timelineSlider.value = clamped;
      const valEl = document.getElementById('zoomFactorVal');
      if (valEl) valEl.textContent = zoomValStr;
      this.rebuildTimeline();
    };

    zoomSlider?.addEventListener('input', (e) => syncZoom(parseFloat(e.target.value)));
    timelineSlider?.addEventListener('input', (e) => syncZoom(parseFloat(e.target.value)));
    zoomInBtn?.addEventListener('click', () => syncZoom(this.state.maxZoom + 0.05));
    zoomOutBtn?.addEventListener('click', () => syncZoom(this.state.maxZoom - 0.05));

    minDurSlider?.addEventListener('input', (e) => {
      this.state.photoMinDuration = parseFloat(e.target.value);
      const valEl = document.getElementById('photoMinDurationVal');
      if (valEl) valEl.textContent = `${e.target.value}s`;
      this.rebuildTimeline();
    });

    maxDurSlider?.addEventListener('input', (e) => {
      this.state.photoMaxDuration = parseFloat(e.target.value);
      const valEl = document.getElementById('photoMaxDurationVal');
      if (valEl) valEl.textContent = `${e.target.value}s`;
      this.rebuildTimeline();
    });

    transSlider?.addEventListener('input', (e) => {
      this.state.transitionDuration = parseFloat(e.target.value);
      document.getElementById('transitionDurationVal').textContent = `${e.target.value}s`;
      this.renderCurrentPreviewFrame();
    });

    transTypeSelect?.addEventListener('change', (e) => {
      this.state.transitionType = e.target.value;
      this.renderCurrentPreviewFrame();
    });

    // Enabled Animations Checkboxes
    const animCheckboxes = [
      { id: 'animZoomIn', val: 'zoom-in' },
      { id: 'animZoomOut', val: 'zoom-out' },
      { id: 'animPanLR', val: 'pan-lr' },
      { id: 'animPanRL', val: 'pan-rl' },
      { id: 'animPanUp', val: 'pan-up' },
      { id: 'animPanDown', val: 'pan-down' },
      { id: 'animDiagonal', val: 'diagonal' }
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
      document.getElementById(item.id)?.addEventListener('change', updateEnabledAnims);
    });

    document.getElementById('selectAllAnimationsBtn')?.addEventListener('click', () => {
      animCheckboxes.forEach((item) => {
        const el = document.getElementById(item.id);
        if (el) el.checked = true;
      });
      updateEnabledAnims();
    });

    document.getElementById('reshuffleTimelineBtn')?.addEventListener('click', () => {
      this.rebuildTimeline();
      this.ui.showToast('Re-shuffled photo animation sequence.', 'success');
    });

    // Tab 2: Captions Styling
    this.bindCaptionStylingEvents();

    // Tab 3: Overlays & Grading
    this.bindGradingEvents();
  }

  setAspectRatio(ratio) {
    this.state.aspectRatio = ratio;
    const btn16x9 = document.getElementById('ratio16x9Btn');
    const btn9x16 = document.getElementById('ratio9x16Btn');
    const btn720p = document.getElementById('ratio720pBtn');
    const verticalOpt = document.getElementById('verticalModeLayoutOption');
    const viewport = document.getElementById('canvasViewport');
    const framingGroup = document.getElementById('clipperFramingGroup');

    btn16x9?.classList.toggle('active', ratio === '16:9');
    btn9x16?.classList.toggle('active', ratio === '9:16');
    btn720p?.classList.toggle('active', ratio === '16:9-720p');

    // Sync Step 1 clipper pills
    document.querySelectorAll('#clipperRatioPills .aspect-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.ratio === ratio || (ratio === '16:9-720p' && p.dataset.ratio === '16:9'));
    });

    if (framingGroup) {
      if (ratio === 'custom') {
        framingGroup.style.opacity = '0.4';
        framingGroup.style.pointerEvents = 'none';
      } else {
        framingGroup.style.opacity = '1';
        framingGroup.style.pointerEvents = 'auto';
      }
    }

    if (ratio === 'custom') {
      verticalOpt?.classList.add('hidden');
      if (!this.state.customNorm) {
        this.state.customNorm = this.getNormalizedCropBounds();
      }
      const norm = this.state.customNorm;
      const sourceW = this.sourceVideo?.videoWidth || 1920;
      const sourceH = this.sourceVideo?.videoHeight || 1080;
      let w = Math.round(norm.w * sourceW);
      let h = Math.round(norm.h * sourceH);
      if (Math.max(w, h) > 1920) {
        const scale = 1920 / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      w = w - (w % 2);
      h = h - (h % 2);
      this.state.exportWidth = Math.max(128, w);
      this.state.exportHeight = Math.max(128, h);
    } else if (ratio === '9:16') {
      verticalOpt?.classList.remove('hidden');
      this.state.exportWidth = 1080;
      this.state.exportHeight = 1920;
    } else if (ratio === '1:1') {
      verticalOpt?.classList.add('hidden');
      this.state.exportWidth = 1080;
      this.state.exportHeight = 1080;
    } else if (ratio === '4:5') {
      verticalOpt?.classList.add('hidden');
      this.state.exportWidth = 1080;
      this.state.exportHeight = 1350;
    } else if (ratio === '16:9-720p') {
      verticalOpt?.classList.add('hidden');
      this.state.exportWidth = 1280;
      this.state.exportHeight = 720;
    } else {
      // 16:9 1080p
      verticalOpt?.classList.add('hidden');
      this.state.exportWidth = 1920;
      this.state.exportHeight = 1080;
    }

    if (viewport) {
      if (ratio === 'custom') {
        viewport.classList.remove('aspect-9-16');
        viewport.style.aspectRatio = `${this.state.exportWidth} / ${this.state.exportHeight}`;
        viewport.style.maxHeight = '600px';
      } else if (ratio === '9:16') {
        viewport.classList.add('aspect-9-16');
        viewport.style.aspectRatio = '9 / 16';
        viewport.style.maxHeight = '600px';
      } else if (ratio === '1:1') {
        viewport.classList.remove('aspect-9-16');
        viewport.style.aspectRatio = '1 / 1';
        viewport.style.maxHeight = '540px';
      } else if (ratio === '4:5') {
        viewport.classList.remove('aspect-9-16');
        viewport.style.aspectRatio = '4 / 5';
        viewport.style.maxHeight = '560px';
      } else {
        viewport.classList.remove('aspect-9-16');
        viewport.style.aspectRatio = '16 / 9';
        viewport.style.maxHeight = '';
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
    const badge = document.getElementById('canvasResBadge');
    if (badge) {
      const displayRatio = this.state.aspectRatio === 'custom' ? 'Custom' : this.state.aspectRatio;
      badge.textContent = `Frame: ${displayRatio} · ${this.state.exportWidth}x${this.state.exportHeight}`;
    }
  }

  bindCaptionStylingEvents() {
    const fontSelect = document.getElementById('captionFontSelect');
    const sizeSlider = document.getElementById('captionFontSizeSlider');
    const textColor = document.getElementById('captionTextColor');
    const highlightColor = document.getElementById('captionHighlightColor');
    const outlineSlider = document.getElementById('captionOutlineSlider');
    const outlineColor = document.getElementById('captionOutlineColor');
    const boxEnable = document.getElementById('captionBoxEnable');
    const boxOpacity = document.getElementById('captionBoxOpacitySlider');
    const karaokeEnable = document.getElementById('captionKaraokeEnable');

    fontSelect?.addEventListener('change', (e) => {
      this.state.captionStyle.fontFamily = e.target.value;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    sizeSlider?.addEventListener('input', (e) => {
      this.state.captionStyle.fontSize = parseInt(e.target.value, 10);
      document.getElementById('captionFontSizeVal').textContent = `${e.target.value}px`;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    textColor?.addEventListener('input', (e) => {
      this.state.captionStyle.textColor = e.target.value;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    highlightColor?.addEventListener('input', (e) => {
      this.state.captionStyle.highlightColor = e.target.value;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    outlineSlider?.addEventListener('input', (e) => {
      this.state.captionStyle.outlineThickness = parseInt(e.target.value, 10);
      document.getElementById('captionOutlineVal').textContent = `${e.target.value}px`;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    outlineColor?.addEventListener('input', (e) => {
      this.state.captionStyle.outlineColor = e.target.value;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    boxEnable?.addEventListener('change', (e) => {
      this.state.captionStyle.boxEnabled = e.target.checked;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    boxOpacity?.addEventListener('input', (e) => {
      this.state.captionStyle.boxOpacity = parseInt(e.target.value, 10);
      document.getElementById('captionBoxOpacityVal').textContent = `${e.target.value}%`;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    karaokeEnable?.addEventListener('change', (e) => {
      this.state.captionStyle.karaokeEnabled = e.target.checked;
      saveSetting('captionStyle', this.state.captionStyle);
      this.renderCurrentPreviewFrame();
    });

    // Position buttons
    document.querySelectorAll('.position-buttons .pos-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.position-buttons .pos-btn').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
        this.state.captionStyle.position = e.target.dataset.pos;
        saveSetting('captionStyle', this.state.captionStyle);
        this.renderCurrentPreviewFrame();
      });
    });
  }

  bindGradingEvents() {
    const vigSlider = document.getElementById('vignetteSlider');
    const grainSlider = document.getElementById('filmGrainSlider');
    const brightSlider = document.getElementById('brightnessSlider');
    const contSlider = document.getElementById('contrastSlider');
    const satSlider = document.getElementById('saturationSlider');

    vigSlider?.addEventListener('input', (e) => {
      this.state.overlays.vignette = parseInt(e.target.value, 10);
      document.getElementById('vignetteVal').textContent = `${e.target.value}%`;
      saveSetting('overlays', this.state.overlays);
      this.renderCurrentPreviewFrame();
    });

    grainSlider?.addEventListener('input', (e) => {
      this.state.overlays.filmGrain = parseInt(e.target.value, 10);
      document.getElementById('filmGrainVal').textContent = `${e.target.value}%`;
      saveSetting('overlays', this.state.overlays);
      this.renderCurrentPreviewFrame();
    });

    brightSlider?.addEventListener('input', (e) => {
      this.state.colorGrading.brightness = parseInt(e.target.value, 10);
      document.getElementById('brightnessVal').textContent = `${e.target.value}%`;
      saveSetting('colorGrading', this.state.colorGrading);
      this.renderCurrentPreviewFrame();
    });

    contSlider?.addEventListener('input', (e) => {
      this.state.colorGrading.contrast = parseInt(e.target.value, 10);
      document.getElementById('contrastVal').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`;
      saveSetting('colorGrading', this.state.colorGrading);
      this.renderCurrentPreviewFrame();
    });

    satSlider?.addEventListener('input', (e) => {
      this.state.colorGrading.saturation = parseInt(e.target.value, 10);
      document.getElementById('saturationVal').textContent = `${e.target.value}%`;
      saveSetting('colorGrading', this.state.colorGrading);
      this.renderCurrentPreviewFrame();
    });

    document.getElementById('resetGradingBtn')?.addEventListener('click', () => {
      this.state.overlays = { vignette: 35, filmGrain: 15 };
      this.state.colorGrading = { brightness: 0, contrast: 5, saturation: 105 };
      vigSlider.value = 35;
      grainSlider.value = 15;
      brightSlider.value = 0;
      contSlider.value = 5;
      satSlider.value = 105;
      document.getElementById('vignetteVal').textContent = '35%';
      document.getElementById('filmGrainVal').textContent = '15%';
      document.getElementById('brightnessVal').textContent = '0%';
      document.getElementById('contrastVal').textContent = '+5%';
      document.getElementById('saturationVal').textContent = '105%';
      this.renderCurrentPreviewFrame();
      this.ui.showToast('Grading reset to default.', 'info');
    });
  }

  // =========================================================================
  // Playback & Interactive Scrubber
  // =========================================================================

  getEffectiveTimelineDuration() {
    if (this.state.durationMode === 'match-voice') {
      return this.voiceEngine.audioDuration > 0 ? this.voiceEngine.audioDuration : 60;
    }
    if (this.state.durationMode === 'custom') {
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

    // Update timeline tracks
    this.ui.renderTimelineTracks(segments, this.captionEngine.chunks, dur);
    document.getElementById('totalDurationDisplay').textContent = this.ui.formatTime(dur);

    this.renderCurrentPreviewFrame();
  }

  bindPlaybackEvents() {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const restartBtn = document.getElementById('restartBtn');
    const skipBackBtn = document.getElementById('skipBack5Btn');
    const skipFwdBtn = document.getElementById('skipForward5Btn');
    const muteBtn = document.getElementById('toggleMutePreviewBtn');
    const volSlider = document.getElementById('previewVolumeSlider');
    const timelineScroll = document.getElementById('timelineScrollArea');

    playPauseBtn?.addEventListener('click', () => this.togglePlayPause());
    restartBtn?.addEventListener('click', () => this.seekTo(0));
    skipBackBtn?.addEventListener('click', () => this.seekTo(this.state.currentTime - 5));
    skipFwdBtn?.addEventListener('click', () => this.seekTo(this.state.currentTime + 5));

    // Keyboard shortcuts (Space: play/pause, Ctrl+S: save)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        this.togglePlayPause();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (this.storyController) {
          this.storyController.markDirtyAndSave();
          this.ui.showToast('💾 Project saved to device!', 'success');
        } else {
          this.saveSettings();
          this.ui.showToast('Settings saved!', 'success');
        }
      }
    });

    // Mute / Volume
    muteBtn?.addEventListener('click', () => {
      this.state.isMuted = !this.state.isMuted;
      document.getElementById('unmutedIcon')?.classList.toggle('hidden', this.state.isMuted);
      document.getElementById('mutedIcon')?.classList.toggle('hidden', !this.state.isMuted);
      if (this.voiceEngine.previewGainNode) {
        this.voiceEngine.previewGainNode.gain.value = this.state.isMuted ? 0 : this.state.previewVolume;
      }
    });

    volSlider?.addEventListener('input', (e) => {
      this.state.previewVolume = parseFloat(e.target.value);
    });

    // Timeline Scrubbing
    timelineScroll?.addEventListener('click', (e) => {
      const rect = timelineScroll.getBoundingClientRect();
      const clickX = e.clientX - rect.left + timelineScroll.scrollLeft;
      const ratio = Math.max(0, Math.min(1, clickX / timelineScroll.scrollWidth));
      const targetTime = ratio * this.state.timelineDuration;
      this.seekTo(targetTime);
    });

    // Fullscreen Preview
    document.getElementById('fullscreenCanvasBtn')?.addEventListener('click', () => {
      const viewport = document.getElementById('canvasViewport');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        viewport?.requestFullscreen();
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
    if (this.state.isPlaying) return;
    this.state.isPlaying = true;
    document.getElementById('playIcon')?.classList.add('hidden');
    document.getElementById('pauseIcon')?.classList.remove('hidden');

    const audioCtx = this.voiceEngine.getAudioContext();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const startTimeWall = performance.now() / 1000;
    this.state.playStartTime = startTimeWall;
    this.state.playStartOffset = this.state.currentTime;

    // Start voice audio in sync
    if (this.voiceEngine.audioBuffer) {
      this.voiceEngine.playPreview(this.state.currentTime, () => {
        // Voice ended
      });
    } else if (this.state.voiceMode === 'A') {
      this.playTtsInSync(this.state.currentTime);
    }

    const loop = async () => {
      if (!this.state.isPlaying) return;

      const now = performance.now() / 1000;
      const elapsed = now - this.state.playStartTime;
      const t = this.state.playStartOffset + elapsed;

      if (t >= this.state.timelineDuration) {
        this.pause();
        this.seekTo(0);
        return;
      }

      this.state.currentTime = t;
      document.getElementById('currentTimeDisplay').textContent = this.ui.formatTime(t);
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
    if (this.state.voiceMode !== 'A') return;
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
    this.state.isPlaying = false;
    document.getElementById('playIcon')?.classList.remove('hidden');
    document.getElementById('pauseIcon')?.classList.add('hidden');
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
    document.getElementById('currentTimeDisplay').textContent = this.ui.formatTime(clamped);
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
    const progressModal = document.getElementById('exportProgressModal');
    const progressBar = document.getElementById('exportProgressBar');
    const percentDisplay = document.getElementById('exportPercentDisplay');
    const frameDisplay = document.getElementById('exportFrameDisplay');
    const elapsedDisplay = document.getElementById('exportElapsedDisplay');
    const etaDisplay = document.getElementById('exportEtaDisplay');
    const miniCanvas = document.getElementById('exportMiniThumbCanvas');
    const cancelExportBtn = document.getElementById('cancelExportBtn');

    cancelExportBtn?.addEventListener('click', () => {
      this.exporter.cancel();
      progressModal?.classList.add('hidden');
      this.ui.showToast('Export cancelled.', 'info');
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

    // Mode 1: Voice Export
    document.getElementById('startVoiceExportBtn')?.addEventListener('click', async () => {
      if (this.state.extractedFrames.length === 0) {
        this.ui.showToast('Please extract frames in Step 1 first!', 'error');
        return;
      }
      if (!this.voiceEngine.audioBuffer) {
        this.ui.showToast('No voice-over loaded. Load or record your voice first.', 'error');
        return;
      }
      this.pause();
      progressModal?.classList.remove('hidden');
      document.getElementById('exportProgressTitle').textContent = 'Exporting Video with Voice-Over...';

      try {
        const result = await this.exporter.exportWithVoice(this.state, onExportProgress, miniCanvas);
        progressModal?.classList.add('hidden');
        if (result && result.hasAudio && !result.audioOk) {
          this.ui.showToast('Exported file has no audible audio. Check your voice file', 'error');
        } else if (result && result.hasAudio) {
          this.ui.showToast(`Exported ${result.filename} (with voice)`, 'success');
        } else {
          this.ui.showToast(`Exported ${result.filename} (no voice loaded: silent)`, 'success');
        }
      } catch (err) {
        progressModal?.classList.add('hidden');
        this.ui.showToast(`Export stopped: ${err.message}`, 'error');
      }
    });

    // Mode 2: TTS Export — 1-Click Neural Voice Generation & WebCodecs Export
    const ttsInstructionModal = document.getElementById('ttsExportInstructionModal');
    document.getElementById('startTtsExportBtn')?.addEventListener('click', () => {
      this.exportWithNeuralTts();
    });

    document.getElementById('cancelTtsExportBtn')?.addEventListener('click', () => {
      ttsInstructionModal?.classList.add('hidden');
    });
    document.getElementById('closeTtsModalBtn')?.addEventListener('click', () => {
      ttsInstructionModal?.classList.add('hidden');
    });

    document.getElementById('confirmTtsExportBtn')?.addEventListener('click', () => {
      ttsInstructionModal?.classList.add('hidden');
      this.exportWithNeuralTts();
    });

    // Mode 3: Ultra-Fast Render
    document.getElementById('startFastSilentExportBtn')?.addEventListener('click', async () => {
      if (this.state.extractedFrames.length === 0) {
        this.ui.showToast('Please extract frames in Step 1 first!', 'error');
        return;
      }
      this.pause();
      progressModal?.classList.remove('hidden');
      const hasVoice = !!this.voiceEngine.audioBuffer;
      document.getElementById('exportProgressTitle').textContent = hasVoice
        ? 'Fast Encoding Video & Voice (WebCodecs)...'
        : 'Fast Encoding Frames (WebCodecs)...';

      try {
        const result = await this.exporter.exportFastSilent(this.state, onExportProgress, miniCanvas);
        progressModal?.classList.add('hidden');
        if (result && result.hasAudio && !result.audioOk) {
          this.ui.showToast('Exported file has no audible audio. Check your voice file', 'error');
        } else if (result && result.hasAudio) {
          this.ui.showToast(`Exported ${result.filename} (with voice)`, 'success');
        } else {
          this.ui.showToast(`Exported ${result.filename} (no voice loaded: silent)`, 'success');
        }
      } catch (err) {
        progressModal?.classList.add('hidden');
        this.ui.showToast(`Fast render stopped: ${err.message}`, 'error');
      }
    });

    // Extra Deliverable Downloads
    document.getElementById('downloadSrtBtn')?.addEventListener('click', () => {
      const srt = this.captionEngine.generateSRT();
      this.captionEngine.downloadFile(srt, 'captions.srt', 'text/plain');
    });

    document.getElementById('downloadVttBtn')?.addEventListener('click', () => {
      const vtt = this.captionEngine.generateVTT();
      this.captionEngine.downloadFile(vtt, 'captions.vtt', 'text/vtt');
    });

    document.getElementById('downloadTxtBtn')?.addEventListener('click', () => {
      const txt = this.captionEngine.generateTXT();
      this.captionEngine.downloadFile(txt, 'script.txt', 'text/plain');
    });

    document.getElementById('downloadJsonBtn')?.addEventListener('click', () => {
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
      this.ui.showToast('Please extract frames in Step 1 first!', 'error');
      return;
    }
    const scriptText = (this.state.scriptText || '').trim();
    if (!scriptText) {
      this.ui.showToast('Please enter your script first in Step 2 before exporting.', 'error');
      return;
    }

    const rawSentences = this.captionEngine.splitScriptIntoSentences(scriptText);
    if (!rawSentences.length) {
      this.ui.showToast('Please enter your script first in Step 2 before exporting.', 'error');
      return;
    }

    this.pause();
    const progressModal = document.getElementById('exportProgressModal');
    const progressBar = document.getElementById('exportProgressBar');
    const percentDisplay = document.getElementById('exportPercentDisplay');
    const frameDisplay = document.getElementById('exportFrameDisplay');
    const elapsedDisplay = document.getElementById('exportElapsedDisplay');
    const etaDisplay = document.getElementById('exportEtaDisplay');
    const miniCanvas = document.getElementById('exportMiniThumbCanvas');
    const progressTitle = document.getElementById('exportProgressTitle');

    progressModal?.classList.remove('hidden');
    if (progressTitle) progressTitle.textContent = 'Generating Natural Voice (Neural TTS)...';
    if (progressBar) progressBar.style.width = '0%';
    if (percentDisplay) percentDisplay.textContent = '0%';
    if (frameDisplay) frameDisplay.textContent = 'Preparing TTS audio...';
    if (elapsedDisplay) elapsedDisplay.textContent = '0s';
    if (etaDisplay) etaDisplay.textContent = '...';

    const onExportProgress = (prog) => {
      if (progressBar) progressBar.style.width = `${prog.percent}%`;
      if (percentDisplay) percentDisplay.textContent = `${prog.percent}%`;
      if (frameDisplay) frameDisplay.textContent = `${prog.currentFrame} / ${prog.totalFrames}`;
      if (elapsedDisplay) elapsedDisplay.textContent = prog.elapsedText;
      if (etaDisplay) etaDisplay.textContent = prog.etaText;
    };

    try {
      // (a) generateVoiceFromScript
      const ttsOpts = this.getTtsOptions();
      let selectedVoice = ttsOpts.voice;
      const isHindi = /[\u0900-\u097F]/.test(scriptText);
      if (isHindi && (!selectedVoice || selectedVoice.startsWith('en-') || !selectedVoice.includes('hi-IN'))) {
        selectedVoice = 'hi-IN-SwaraNeural';
        const voiceSelect = document.getElementById('ttsVoiceSelect');
        if (voiceSelect) voiceSelect.value = selectedVoice;
        ttsOpts.voice = selectedVoice;
      } else if (!selectedVoice || !selectedVoice.includes('Neural')) {
        selectedVoice = isHindi ? 'hi-IN-SwaraNeural' : 'en-IN-NeerjaNeural';
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
            if (percentDisplay) percentDisplay.textContent = `${Math.round((current / total) * 30)}%`;
            if (progressBar) progressBar.style.width = `${Math.round((current / total) * 30)}%`;
          }
        });
      } catch (ttsErr) {
        progressModal?.classList.add('hidden');
        console.error('[TTS Generation Error in Export]', ttsErr);
        this.ui.showToast(`Voice generation failed: ${ttsErr.message}`, 'error', 7000);
        return;
      }

      if (!ttsResult || !ttsResult.buffer) {
        progressModal?.classList.add('hidden');
        this.ui.showToast('Voice generation failed: No audio buffer returned from TTS service.', 'error', 7000);
        return;
      }

      // (b) update timeline and captions
      const voiceDur = Math.ceil(ttsResult.buffer.duration);
      this.state.timelineDuration = voiceDur;
      const durInput = document.getElementById('timelineDurationInput');
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

      this.onVoiceLoaded(ttsResult.buffer, 'tts_voice.wav', true);
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

      // (c) run exportFastSilent (WebCodecs, voice embedded)
      if (progressTitle) progressTitle.textContent = 'Fast Encoding Video & Voice (WebCodecs)...';
      const result = await this.exporter.exportFastSilent(this.state, onExportProgress, miniCanvas);
      progressModal?.classList.add('hidden');

      if (result && result.hasAudio && !result.audioOk) {
        this.ui.showToast('Exported file has no audible audio. Check your voice file', 'error');
      } else if (result && result.hasAudio) {
        this.ui.showToast(`Exported ${result.filename} (with voice)`, 'success');
      } else {
        this.ui.showToast(`Exported ${result.filename}`, 'success');
      }
    } catch (err) {
      progressModal?.classList.add('hidden');
      console.error('[Export Error]', err);
      this.ui.showToast(`Export stopped: ${err.message}`, 'error', 7000);
    } finally {
      progressModal?.classList.add('hidden');
    }
  }

  // =========================================================================
  // Project Serialization & Reset
  // =========================================================================

  bindProjectEvents() {
    document.getElementById('saveProjectBtn')?.addEventListener('click', () => {
      this.saveProjectFile();
    });

    const loadInput = document.getElementById('loadProjectInput');
    loadInput?.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files[0]) {
        try {
          const projectData = await importProjectJson(e.target.files[0]);
          this.restoreProjectFile(projectData);
          this.ui.showToast('Project JSON loaded. Please re-attach source video to re-extract frames.', 'info', 5000);
        } catch (err) {
          this.ui.showToast(`Failed to load project: ${err.message}`, 'error');
        }
      }
    });

    document.getElementById('resetAppBtn')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all data and start a new project?')) {
        this.clearAllExtractedFrames();
        location.reload();
      }
    });
  }

  saveProjectFile() {
    const project = {
      version: '1.0',
      savedAt: new Date().toISOString(),
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
    this.ui.showToast('Saved project JSON file.', 'success');
  }

  restoreProjectFile(project) {
    if (!project || !project.settings) return;

    if (project.scriptText) {
      document.getElementById('scriptTextarea').value = project.scriptText;
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
}

// Instantiate and start app on window load
function initApp() {
  if (!window.app) {
    const app = new FrameFlowApp();
    window.app = app;
    window.superPower = app;
    app.init();
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
