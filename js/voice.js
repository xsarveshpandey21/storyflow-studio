/**
 * FrameFlow Studio — Voice-Over & Audio Engine
 * Handles microphone recording with live visualizer, audio file upload,
 * Web Audio API processing (80Hz High-Pass, Noise Gate, Normalizer, 3-Band EQ),
 * silence gap detection for caption snapping, and Web Speech API (TTS).
 */

/**
 * Safe API URL resolver across localhost, node, and file:// protocol
 */
export function getApiUrl(endpoint) {
  if (typeof window === 'undefined') {
    const port = (typeof process !== 'undefined' && process.env?.PORT) || 3000;
    return `http://localhost:${port}${endpoint}`;
  }
  if (window.location && window.location.protocol === 'file:') {
    return `http://localhost:3000${endpoint}`;
  }
  return endpoint;
}

export class VoiceEngine {
  constructor() {
    // Lazy AudioContext initialization on first user interaction
    this.audioCtx = null;
    this.audioBuffer = null;
    this.audioFileName = 'voice_audio.wav';
    this.audioDuration = 0;

    // Web Audio preview graph
    this.previewSourceNode = null;
    this.previewGainNode = null;
    this.isAudioPlaying = false;
    this.previewStartTime = 0;
    this.previewPauseOffset = 0;

    // Audio Clean-up settings
    this.settings = {
      reduceNoise: true,
      normalize: true,
      masterGain: 1.0,
      eqLow: 0,
      eqMid: 2,
      eqHigh: 1,
      abCleanedActive: true // A/B test toggle
    };

    // Live Recording state
    this.mediaRecorder = null;
    this.recordStream = null;
    this.recordChunks = [];
    this.recordTimerInterval = null;
    this.recordSeconds = 0;
    this.analyserNode = null;
    this.visualizerAnimationId = null;

    // Mode A: Browser Speech Synthesis state
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
    if (this.audioCtx.state === 'suspended') {
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
  async loadAudioFile(file, filename = 'voice_audio.wav') {
    const ctx = this.getAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    this.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.audioFileName = filename || file.name || 'voice_audio.wav';
    this.audioDuration = this.audioBuffer.duration;
    return this.audioBuffer;
  }

  /**
   * Sets the current AudioBuffer directly
   * @param {AudioBuffer} buffer 
   * @param {string} name 
   */
  setAudioBuffer(buffer, name = 'recorded_voice.wav') {
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
    const windowSize = Math.floor(sampleRate * 0.03); // 30ms window
    const hopSize = Math.floor(sampleRate * 0.015);   // 15ms hop
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

    // Cluster silent frames into continuous intervals
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

    // Check trailing gap
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
      // Clean-up bypassed (Raw audio preview)
      sourceNode.connect(destinationNode);
      return { inputNode: sourceNode, outputNode: destinationNode };
    }

    let currentNode = sourceNode;
    const now = 0;

    // 1. 80Hz High-Pass Filter (removes mic rumble, HVAC hum)
    if (cfg.reduceNoise) {
      const highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 80;
      highPass.Q.value = 0.707;
      currentNode.connect(highPass);
      currentNode = highPass;

      // Dynamic compressor to tame peaks and even out background noise
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-28, now);
      comp.knee.setValueAtTime(8, now);
      comp.ratio.setValueAtTime(4, now);
      comp.attack.setValueAtTime(0.005, now);
      comp.release.setValueAtTime(0.08, now);
      currentNode.connect(comp);
      currentNode = comp;
    }

    // 2. Normalization Gain
    let normFactor = 1.0;
    if (cfg.normalize && this.audioBuffer) {
      const peak = this.getPeakAmplitude(this.audioBuffer);
      if (peak > 0.01) {
        normFactor = Math.min(3.5, 0.94 / peak);
      }
    }
    const safeNorm = Number.isFinite(normFactor) && normFactor > 0 ? normFactor : 1.0;

    const normGain = ctx.createGain();
    normGain.gain.setValueAtTime(safeNorm, now);
    currentNode.connect(normGain);
    currentNode = normGain;

    // 3. 3-Band Equalizer (Low Shelf, Mid Peaking, High Shelf)
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 160;
    eqLow.gain.setValueAtTime(Number.isFinite(cfg.eqLow) ? cfg.eqLow : 0, now);
    currentNode.connect(eqLow);
    currentNode = eqLow;

    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = 1200;
    eqMid.Q.value = 1.0;
    eqMid.gain.setValueAtTime(Number.isFinite(cfg.eqMid) ? cfg.eqMid : 0, now);
    currentNode.connect(eqMid);
    currentNode = eqMid;

    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 4800;
    eqHigh.gain.setValueAtTime(Number.isFinite(cfg.eqHigh) ? cfg.eqHigh : 0, now);
    currentNode.connect(eqHigh);
    currentNode = eqHigh;

    // 4. Master Volume Gain
    const safeMaster = Number.isFinite(cfg.masterGain) && cfg.masterGain > 0 ? cfg.masterGain : 1.0;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(safeMaster, now);
    currentNode.connect(masterGain);
    currentNode = masterGain;

    // Connect to destination
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
  async renderProcessedAudioBuffer(targetDuration, targetSampleRate = 48000) {
    if (!this.audioBuffer) return null;
    const OfflineCtxClass = (typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext));
    if (!OfflineCtxClass) return null;

    const channels = 2; // Always stereo
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
    const windowSize = Math.floor(sampleRate * 0.02); // 20ms window
    const hopSize = Math.floor(sampleRate * 0.01);     // 10ms hop
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
        lastSpeechSec = timeSec + (windowSize / sampleRate);
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
    const sentenceList = rawList
      .map((c) => (c || '').trim())
      .filter((c) => c.length > 0);

    if (sentenceList.length === 0) {
      throw new Error('No script sentences provided for TTS generation.');
    }

    const ctx = this.getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {}
    }

    const voice = options.voice || 'hi-IN-SwaraNeural';
    const rate = options.rate !== undefined ? options.rate : 1.0;
    const pitch = options.pitch !== undefined ? options.pitch : 1.0;
    const volume = options.volume !== undefined ? options.volume : 1.0;

    const decodedItems = [];

    // 1. Synthesize and decode each chunk
    for (let i = 0; i < sentenceList.length; i++) {
      const sentenceText = sentenceList[i];
      let resp = null;
      let lastErrMsg = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (i > 0 && attempt === 0) {
            await new Promise((r) => setTimeout(r, 280));
          } else if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
          const ttsUrl = getApiUrl('/api/tts');
          resp = await fetch(ttsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: sentenceText,
              voice,
              rate,
              pitch,
              volume
            })
          });
          if (resp.status === 404) {
            throw new Error('server not running – open the app via `npm start` at http://localhost:3000');
          }
          if (resp.ok) break;
          try {
            const errData = await resp.json();
            if (errData && errData.error) lastErrMsg = errData.error;
          } catch (e) {}
          if (!resp.ok) {
            throw new Error(lastErrMsg || `TTS request failed with status ${resp.status}`);
          }
        } catch (netErr) {
          lastErrMsg = netErr.message;
          const msg = (netErr.message || '').toLowerCase();
          if (msg.includes('404') || msg.includes('server not running') || msg.includes('no internet')) {
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

      if (typeof options.onProgress === 'function') {
        options.onProgress(i + 1, sentenceList.length, sentenceText);
      }
    }

    // 2. Concatenate into one AudioBuffer with short pauses and record exact timings
    const sampleRate = decodedItems[0].audioBuffer.sampleRate || 48000;
    let totalSamples = 0;
    const pauses = [];

    for (let i = 0; i < decodedItems.length; i++) {
      const item = decodedItems[i];
      totalSamples += item.audioBuffer.length;

      // Pause calculation: 0.25s after । . ? !, 0.1s after commas, 0.15s otherwise
      let pauseSec = 0.20;
      if (/[।\.\?!]/.test(item.text)) {
        pauseSec = 0.25;
      } else if (/[,;،]/.test(item.text)) {
        pauseSec = 0.10;
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

      // Advance by pause samples
      currentSample += pauses[i];
    }

    // Apply volume scaling to the generated AudioBuffer
    const vol = options.volume !== undefined ? Math.max(0, Math.min(1, Number(options.volume))) : 1.0;
    if (!isNaN(vol) && vol !== 1.0) {
      for (let s = 0; s < combinedBuffer.length; s++) {
        ch0[s] *= vol;
        ch1[s] *= vol;
      }
    }

    this.setAudioBuffer(combinedBuffer, 'tts_voice.wav');
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
      if (typeof onEnded === 'function') onEnded();
    };

    if (offsetSeconds >= this.audioBuffer.duration) {
      this.isAudioPlaying = false;
      if (typeof onEnded === 'function') onEnded();
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
        // Already stopped
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
        noiseSuppression: false, // We provide clean in-app DSP
        autoGainControl: false
      }
    });

    this.recordStream = stream;
    this.recordChunks = [];

    // Setup visualizer graph
    const ctx = this.getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {}
    }
    const sourceNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    sourceNode.connect(analyser);
    this.analyserNode = analyser;

    // Start drawing waveform
    this.drawLiveVisualizer(visualizerCanvas, dbMeterFill);

    // Setup MediaRecorder
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    }

    const options = mimeType ? { mimeType } : undefined;
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
      if (typeof onTimerTick === 'function') {
        onTimerTick(this.recordSeconds);
      }
    }, 1000);
  }

  /**
   * Pauses recording
   */
  pauseRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
  }

  /**
   * Resumes recording
   */
  resumeRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
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
        return reject(new Error('No active recorder found.'));
      }

      this.mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this.recordChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
          if (this.recordStream) {
            this.recordStream.getTracks().forEach((track) => track.stop());
            this.recordStream = null;
          }
          const buffer = await this.loadAudioFile(blob, 'recorded_voice.wav');
          resolve(buffer);
        } catch (err) {
          reject(err);
        }
      };

      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    });
  }

  /**
   * Renders the live audio visualizer loop on canvas
   */
  drawLiveVisualizer(canvas, dbMeterFill) {
    if (!canvas || !this.analyserNode) return;
    const ctx = canvas.getContext('2d');
    const analyser = this.analyserNode;
    const bufferLength = analyser.frequencyBinCount;
    const timeData = new Uint8Array(bufferLength);

    const render = () => {
      this.visualizerAnimationId = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(timeData);

      ctx.fillStyle = '#05080f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#6366f1';
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      let sumSq = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = timeData[i] / 128.0; // 0..2
        const y = (v * canvas.height) / 2;
        const centered = v - 1.0;
        sumSq += centered * centered;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.stroke();

      // Compute RMS decibel level for meter bar
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
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.fillStyle = '#6366f1';
    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
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
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      if (!synth) return resolve([]);

      const updateVoices = () => {
        const voices = synth.getVoices();
        if (voices && voices.length > 0) {
          this.voices = voices;
          if (typeof this.onVoicesChangedCallback === 'function') {
            this.onVoicesChangedCallback(this.voices);
          }
          resolve(voices);
        }
      };

      updateVoices();

      if (synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = () => {
          updateVoices();
        };
      }

      // Multiple retries for browsers that populate voices asynchronously
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
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      let timer = null;
      if (controller) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const healthUrl = getApiUrl('/api/health');
      const resp = await fetch(healthUrl, {
        method: 'GET',
        signal: controller ? controller.signal : undefined
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
    if (typeof onStart === 'function') onStart();

    const errCallback = typeof onError === 'function' ? onError : (typeof ttsOptions?.onError === 'function' ? ttsOptions.onError : null);

    try {
      const v = ttsOptions.voice;
      let voiceName = (v && (v.voiceURI || v.name)) || (typeof v === 'string' ? v : '');
      const isHindi = /[\u0900-\u097F]/.test(text);
      if (!voiceName || (!voiceName.includes('Neural') && isHindi)) {
        voiceName = 'hi-IN-SwaraNeural';
      } else if (!voiceName) {
        voiceName = 'en-IN-NeerjaNeural';
      }

      const rate = ttsOptions.rate !== undefined ? ttsOptions.rate : 1.0;
      const pitch = ttsOptions.pitch !== undefined ? ttsOptions.pitch : 1.0;
      const volume = ttsOptions.volume !== undefined ? Number(ttsOptions.volume) : 1.0;

      const ttsUrl = getApiUrl('/api/tts');
      const resp = await fetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voiceName,
          rate,
          pitch,
          volume
        })
      });

      if (resp.status === 404) {
        throw new Error('server not running – open the app via `npm start` at http://localhost:3000');
      }

      if (!resp.ok) {
        let serverErr = `TTS server returned status ${resp.status}`;
        try {
          const errBody = await resp.json();
          if (errBody && errBody.error) {
            serverErr = errBody.error;
          }
        } catch (e) {}
        throw new Error(serverErr);
      }

      const blob = await resp.blob();
      const audioUrl = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : 'mock-audio-url';

      if (typeof Audio !== 'undefined') {
        const audio = new Audio(audioUrl);
        const validVol = Math.max(0, Math.min(1, isNaN(volume) ? 1.0 : volume));
        audio.volume = validVol;
        this.currentAudioPreview = audio;

        audio.onended = () => {
          if (!this.isSpeakingChunks) {
            this.ttsIsSpeaking = false;
          }
          this.currentAudioPreview = null;
          if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(audioUrl);
          if (typeof onEnd === 'function') onEnd();
        };

        audio.onerror = (err) => {
          console.warn('[TTS] Neural audio playback error:', err);
          if (!this.isSpeakingChunks) {
            this.ttsIsSpeaking = false;
          }
          this.currentAudioPreview = null;
          if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(audioUrl);
          if (typeof onEnd === 'function') onEnd();
        };

        await audio.play();
      } else {
        // Safe path for non-DOM environments like headless unit tests
        if (!this.isSpeakingChunks) {
          this.ttsIsSpeaking = false;
        }
        if (typeof onEnd === 'function') onEnd();
      }
    } catch (err) {
      const isAbort = err.name === 'AbortError' || (err.message && err.message.includes('interrupted'));
      if (isAbort) {
        this.ttsIsSpeaking = false;
        return;
      }
      console.warn('[TTS] Neural preview failed, calling onError before browser fallback:', err.message || err);
      if (typeof errCallback === 'function') {
        try {
          errCallback(err);
        } catch (cbErr) {
          console.error('[TTS] Error in onError callback:', cbErr);
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
    const v = ttsOptions?.voice;
    const vStr = typeof v === 'string' ? v : (v?.voiceURI || v?.name || '');
    const isNeural = vStr.includes('Neural');
    const isHindi = /[\u0900-\u097F]/.test(text);

    // If neural voice selected or Hindi text with neural default, preview via high-quality Neural TTS
    if (isNeural || (isHindi && !this.voices.some((bv) => (bv.lang || '').toLowerCase().startsWith('hi')))) {
      return this.previewNeuralVoice(text, ttsOptions, onStart, onEnd, onError);
    }

    return this.speakSingleBrowser(text, ttsOptions, onStart, onEnd);
  }

  /**
   * Browser SpeechSynthesis fallback for system voices
   */
  speakSingleBrowser(text, ttsOptions, onStart = null, onEnd = null) {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text) {
      if (typeof onEnd === 'function') onEnd();
      return;
    }
    this.stopSpeaking();

    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();

    const utterance = new SpeechSynthesisUtterance(text);
    const isHindi = /[\u0900-\u097F]/.test(text);
    if (ttsOptions.voice && typeof ttsOptions.voice === 'object' && ttsOptions.voice.voiceURI && !ttsOptions.voice.voiceURI.includes('Neural')) {
      utterance.voice = ttsOptions.voice;
      utterance.lang = ttsOptions.voice.lang || (isHindi ? 'hi-IN' : 'en-US');
    } else {
      const matchVoice = this.voices.find((v) => (v.lang || '').toLowerCase().startsWith(isHindi ? 'hi' : 'en'));
      if (matchVoice) {
        utterance.voice = matchVoice;
        utterance.lang = matchVoice.lang;
      } else {
        utterance.lang = isHindi ? 'hi-IN' : (navigator.language || 'en-US');
      }
    }

    utterance.rate = ttsOptions.rate || 1.0;
    utterance.pitch = ttsOptions.pitch || 1.0;
    utterance.volume = (ttsOptions.volume !== undefined) ? ttsOptions.volume : 1.0;

    this.currentUtterance = utterance;

    utterance.onstart = () => {
      this.ttsIsSpeaking = true;
      if (typeof onStart === 'function') onStart();
    };

    utterance.onend = () => {
      this.ttsIsSpeaking = false;
      this.currentUtterance = null;
      if (typeof onEnd === 'function') onEnd();
    };

    utterance.onerror = (err) => {
      console.warn('[TTS] Single speech error:', err);
      this.ttsIsSpeaking = false;
      this.currentUtterance = null;
      if (typeof onEnd === 'function') onEnd();
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
    const v = ttsOptions?.voice;
    const vStr = typeof v === 'string' ? v : (v?.voiceURI || v?.name || '');
    const isNeural = vStr.includes('Neural');

    if (isNeural) {
      this.stopSpeaking();
      this.isSpeakingChunks = true;
      this.ttsIsSpeaking = true;
      let currentIndex = 0;

      const speakNextNeural = async () => {
        if (!this.isSpeakingChunks || currentIndex >= chunks.length) {
          this.stopSpeaking();
          if (typeof onFinished === 'function') onFinished();
          return;
        }

        const text = chunks[currentIndex];
        if (typeof onChunkStart === 'function') {
          onChunkStart(currentIndex, text);
        }

        await this.previewNeuralVoice(
          text,
          ttsOptions,
          null,
          () => {
            if (this.isSpeakingChunks) {
              currentIndex++;
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

    // Keep-alive timer to prevent Chrome/Edge ~15s pause bug
    this.ttsKeepAliveTimer = setInterval(() => {
      if (synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 10000);

    const speakNext = () => {
      if (!this.ttsIsSpeaking || currentIndex >= chunks.length) {
        this.stopSpeaking();
        if (typeof onFinished === 'function') onFinished();
        return;
      }

      const text = chunks[currentIndex];
      const utterance = new SpeechSynthesisUtterance(text);
      const isHindi = /[\u0900-\u097F]/.test(text);

      if (ttsOptions.voice && typeof ttsOptions.voice === 'object' && ttsOptions.voice.voiceURI && !ttsOptions.voice.voiceURI.includes('Neural')) {
        utterance.voice = ttsOptions.voice;
        utterance.lang = ttsOptions.voice.lang || (isHindi ? 'hi-IN' : 'en-US');
      } else {
        const matchVoice = this.voices.find((v) => (v.lang || '').toLowerCase().startsWith(isHindi ? 'hi' : 'en'));
        if (matchVoice) {
          utterance.voice = matchVoice;
          utterance.lang = matchVoice.lang;
        } else {
          utterance.lang = isHindi ? 'hi-IN' : (navigator.language || 'en-US');
        }
      }

      utterance.rate = ttsOptions.rate || 1.0;
      utterance.pitch = ttsOptions.pitch || 1.0;
      utterance.volume = (ttsOptions.volume !== undefined) ? ttsOptions.volume : 1.0;

      if (typeof onChunkStart === 'function') {
        onChunkStart(currentIndex, text);
      }

      utterance.onend = () => {
        currentIndex++;
        // Small pause between sentences
        setTimeout(speakNext, 120);
      };

      utterance.onerror = (err) => {
        console.warn('[TTS] Speech error:', err);
        currentIndex++;
        setTimeout(speakNext, 100);
      };

      this.currentUtterance = utterance; // Prevent GC
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
      } catch (e) {}
      this.currentAudioPreview = null;
    }
    if (this.ttsKeepAliveTimer) {
      clearInterval(this.ttsKeepAliveTimer);
      this.ttsKeepAliveTimer = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }
    this.currentUtterance = null;
  }
}

