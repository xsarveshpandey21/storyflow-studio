/**
 * FrameFlow Studio — User Interface & DOM Controller
 * Handles stepper navigation, toasts, frame gallery grid, caption chunk editor,
 * multi-track timeline visualization, playhead updates, and modals.
 */

export class UIController {
  constructor() {
    this.toastContainer = document.getElementById('toastContainer');
  }

  /**
   * Displays a modern toast alert
   * @param {string} message 
   * @param {'success'|'error'|'info'} type 
   * @param {number} durationMs 
   */
  showToast(message, type = 'info', durationMs = 3500) {
    if (!this.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✓';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, durationMs);
  }

  /**
   * Sets current wizard step (1 to 8)
   * @param {number} stepNumber 
   * @param {Array<number>} [unlockedSteps] List of unlocked steps
   */
  setStep(stepNumber, unlockedSteps = null) {
    // Update Stepper buttons
    for (let i = 1; i <= 8; i++) {
      const btn = document.getElementById(`stepBtn${i}`);
      const sec = document.getElementById(`step${i}Section`);
      if (btn) {
        btn.classList.toggle('active', i === stepNumber);
        btn.classList.toggle('done', i < stepNumber);
        btn.classList.toggle('completed', i < stepNumber);
        if (unlockedSteps) {
          const isUnlocked = unlockedSteps.includes(i);
          btn.classList.toggle('locked', !isUnlocked);
        }
      }
      if (sec) {
        sec.classList.toggle('active', i === stepNumber);
      }
    }
    const mobileStepName = document.getElementById('mobileStepName');
    if (mobileStepName) {
      const names = [
        'Step 1: Source & Frames',
        'Step 2: Voice & Script',
        'Step 3: Studio & Export',
        'Step 4: Publish Portal'
      ];
      mobileStepName.textContent = names[stepNumber - 1] || `Step ${stepNumber}`;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const frac = Math.floor((remainder % 1) * 10);
    return `${String(m).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${frac}`;
  }

  /**
   * Formats byte counts into human readable strings
   * @param {number} bytes 
   * @returns {string}
   */
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * Renders the Extracted Frames Gallery Grid
   * @param {Array<object>} frames 
   * @param {object} callbacks 
   */
  renderFramesGrid(frames = [], callbacks = {}, filterStarredOnly = false) {
    const grid = document.getElementById('extractedGalleryGrid') || document.getElementById('framesGrid');

    // Update counter badges unconditionally
    const totalBadge = document.getElementById('totalExtractedBadge');
    if (totalBadge) totalBadge.textContent = `${frames.length} Photos`;

    const starredBadge = document.getElementById('starredCountBadge');
    if (starredBadge) {
      const starredCount = frames.filter((f) => f.starred).length;
      starredBadge.textContent = `${starredCount} Starred`;
    }

    if (!grid) return;
    grid.innerHTML = '';

    const list = filterStarredOnly ? frames.filter((f) => f.starred) : frames;

    if (list.length === 0) {
      grid.innerHTML = `<div class="empty-placeholder" style="grid-column: 1 / -1;">
        <span>${filterStarredOnly ? 'No starred photos found. Click ⭐ on any photo to star it!' : 'No photos extracted yet. Upload a video or generate a sample video above.'}</span>
      </div>`;
      return;
    }

    let onToggleStar, onDeleteFrame, onPreviewFrame;
    if (typeof callbacks === 'function') {
      onToggleStar = callbacks;
      onDeleteFrame = arguments[2];
      onPreviewFrame = arguments[3];
    } else if (callbacks && typeof callbacks === 'object') {
      onToggleStar = callbacks.onToggleStar;
      onDeleteFrame = callbacks.onDeleteFrame;
      onPreviewFrame = callbacks.onPreviewFrame;
    }

    list.forEach((frame) => {
      const card = document.createElement('div');
      card.className = `frame-card ${frame.starred ? 'is-starred' : ''}`;
      card.dataset.id = frame.id;

      const mins = Math.floor(frame.timestamp / 60);
      const secs = Math.floor(frame.timestamp % 60);
      const timeTag = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const ratioTag = frame.aspectRatio || '16:9';
      const imgSrc = frame.previewUrl || frame.dataUrl || '';

      card.innerHTML = `
        <div class="frame-thumb-wrapper" title="Click to view full preview">
          <img src="${imgSrc}" alt="Extracted frame at ${timeTag}" class="frame-img" loading="lazy">
          <span class="frame-ts-badge">${timeTag}</span>
          <span class="frame-ratio-badge">${ratioTag}</span>
        </div>
        <div class="frame-actions-bar">
          <button type="button" class="frame-star-btn star-btn ${frame.starred ? 'active' : ''}" title="${frame.starred ? 'Remove star' : 'Star photo (2.5x more appearances)'}">
            ${frame.starred ? '⭐' : '☆'}
          </button>
          <button type="button" class="frame-recrop-btn" title="Adjust Crop & Framing (✂️)">
            ✂️
          </button>
          <button type="button" class="frame-delete-btn" title="Delete photo">
            🗑️
          </button>
        </div>
      `;

      // Event listeners
      const thumb = card.querySelector('.frame-thumb-wrapper');
      thumb?.addEventListener('click', () => {
        if (typeof onPreviewFrame === 'function') onPreviewFrame(frame);
      });

      const starBtn = card.querySelector('.frame-star-btn');
      starBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof onToggleStar === 'function') onToggleStar(frame.id);
      });

      const delBtn = card.querySelector('.frame-delete-btn');
      delBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof onDeleteFrame === 'function') onDeleteFrame(frame.id);
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
  updateClipperFramingOverlay(viewportEl, sourceW, sourceH, targetRatio = '16:9', cropOffsetX = 0.5, cropOffsetY = 0.5, customNorm = null) {
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
    if (targetRatio === '16:9' || targetRatio === '16:9-720p') targetAspect = 16 / 9;
    else if (targetRatio === '9:16') targetAspect = 9 / 16;
    else if (targetRatio === '1:1') targetAspect = 1.0;
    else if (targetRatio === '4:5') targetAspect = 4 / 5;
    else if (targetRatio === 'custom' && customNorm && customNorm.h > 0) targetAspect = (customNorm.w * actualVideoW) / (customNorm.h * actualVideoH);

    let cropW = actualVideoW;
    let cropH = actualVideoH;
    let cropLeft = videoLeft;
    let cropTop = videoTop;

    const maskLeft = document.getElementById('cropMaskLeft');
    const maskRight = document.getElementById('cropMaskRight');
    const maskTop = document.getElementById('cropMaskTop');
    const maskBottom = document.getElementById('cropMaskBottom');
    const cropWindow = document.getElementById('cropWindow');
    const tagEl = document.getElementById('cropWindowRatioTag');

    if (!cropWindow) return;

    if (targetRatio === 'custom' && customNorm) {
      cropLeft = videoLeft + (customNorm.x * actualVideoW);
      cropTop = videoTop + (customNorm.y * actualVideoH);
      cropW = customNorm.w * actualVideoW;
      cropH = customNorm.h * actualVideoH;

      if (maskLeft) {
        maskLeft.style.display = 'block';
        maskLeft.style.left = `${videoLeft}px`;
        maskLeft.style.top = `${videoTop}px`;
        maskLeft.style.width = `${Math.max(0, cropLeft - videoLeft)}px`;
        maskLeft.style.height = `${actualVideoH}px`;
      }
      if (maskRight) {
        maskRight.style.display = 'block';
        maskRight.style.left = `${cropLeft + cropW}px`;
        maskRight.style.top = `${videoTop}px`;
        maskRight.style.width = `${Math.max(0, (videoLeft + actualVideoW) - (cropLeft + cropW))}px`;
        maskRight.style.height = `${actualVideoH}px`;
      }
      if (maskTop) {
        maskTop.style.display = 'block';
        maskTop.style.left = `${cropLeft}px`;
        maskTop.style.top = `${videoTop}px`;
        maskTop.style.width = `${cropW}px`;
        maskTop.style.height = `${Math.max(0, cropTop - videoTop)}px`;
      }
      if (maskBottom) {
        maskBottom.style.display = 'block';
        maskBottom.style.left = `${cropLeft}px`;
        maskBottom.style.top = `${cropTop + cropH}px`;
        maskBottom.style.width = `${cropW}px`;
        maskBottom.style.height = `${Math.max(0, (videoTop + actualVideoH) - (cropTop + cropH))}px`;
      }
    } else if (videoAspect > targetAspect) {
      // Source is wider than target (e.g. 16:9 video -> 9:16 crop)
      cropH = actualVideoH;
      cropW = actualVideoH * targetAspect;
      const excessX = Math.max(0, actualVideoW - cropW);
      cropLeft = videoLeft + (excessX * Math.max(0, Math.min(1, cropOffsetX)));
      cropTop = videoTop;

      if (maskLeft) {
        maskLeft.style.display = 'block';
        maskLeft.style.left = `${videoLeft}px`;
        maskLeft.style.top = `${videoTop}px`;
        maskLeft.style.width = `${Math.max(0, cropLeft - videoLeft)}px`;
        maskLeft.style.height = `${actualVideoH}px`;
      }
      if (maskRight) {
        maskRight.style.display = 'block';
        maskRight.style.left = `${cropLeft + cropW}px`;
        maskRight.style.top = `${videoTop}px`;
        maskRight.style.width = `${Math.max(0, (videoLeft + actualVideoW) - (cropLeft + cropW))}px`;
        maskRight.style.height = `${actualVideoH}px`;
      }
      if (maskTop) maskTop.style.display = 'none';
      if (maskBottom) maskBottom.style.display = 'none';
    } else if (videoAspect < targetAspect) {
      // Source is taller than target (e.g. 9:16 video -> 16:9 crop)
      cropW = actualVideoW;
      cropH = actualVideoW / targetAspect;
      const excessY = Math.max(0, actualVideoH - cropH);
      cropTop = videoTop + (excessY * Math.max(0, Math.min(1, cropOffsetY)));
      cropLeft = videoLeft;

      if (maskTop) {
        maskTop.style.display = 'block';
        maskTop.style.left = `${videoLeft}px`;
        maskTop.style.top = `${videoTop}px`;
        maskTop.style.width = `${actualVideoW}px`;
        maskTop.style.height = `${Math.max(0, cropTop - videoTop)}px`;
      }
      if (maskBottom) {
        maskBottom.style.display = 'block';
        maskBottom.style.left = `${videoLeft}px`;
        maskBottom.style.top = `${cropTop + cropH}px`;
        maskBottom.style.width = `${actualVideoW}px`;
        maskBottom.style.height = `${Math.max(0, (videoTop + actualVideoH) - (cropTop + cropH))}px`;
      }
      if (maskLeft) maskLeft.style.display = 'none';
      if (maskRight) maskRight.style.display = 'none';
    } else {
      // Identical aspect ratio
      if (maskLeft) maskLeft.style.display = 'none';
      if (maskRight) maskRight.style.display = 'none';
      if (maskTop) maskTop.style.display = 'none';
      if (maskBottom) maskBottom.style.display = 'none';
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
    const container = document.getElementById('captionChunksContainer') || document.getElementById('captionsListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!chunks || chunks.length === 0) {
      container.innerHTML = `<div class="empty-placeholder">
        Paste a script above to auto-generate sentence-by-sentence caption chunks.
      </div>`;
      return;
    }

    chunks.forEach((chunk, idx) => {
      const item = document.createElement('div');
      item.className = 'caption-chunk-item';
      item.dataset.id = chunk.id;

      item.innerHTML = `
        <div class="chunk-header-row">
          <span class="badge">#${idx + 1}</span>
          <div class="chunk-timing-inputs">
            <span>Start:</span>
            <input type="number" step="0.1" min="0" class="chunk-time-input chunk-start-input" value="${chunk.start.toFixed(1)}">
            <span>End:</span>
            <input type="number" step="0.1" min="0" class="chunk-time-input chunk-end-input" value="${chunk.end.toFixed(1)}">
            <button type="button" class="btn btn-xs btn-ghost text-danger chunk-del-btn" title="Delete chunk">✕</button>
          </div>
        </div>
        <input type="text" class="chunk-text-input hindi-font" value="${chunk.text.replace(/"/g, '&quot;')}" placeholder="Caption text...">
      `;

      const startInput = item.querySelector('.chunk-start-input');
      const endInput = item.querySelector('.chunk-end-input');
      const textInput = item.querySelector('.chunk-text-input');
      const delBtn = item.querySelector('.chunk-del-btn');

      const triggerUpdate = () => {
        const newStart = parseFloat(startInput.value) || 0;
        const newEnd = Math.max(newStart + 0.2, parseFloat(endInput.value) || 1);
        const newText = textInput.value;
        onUpdateChunk(idx, { start: newStart, end: newEnd, text: newText });
      };

      startInput.addEventListener('change', triggerUpdate);
      endInput.addEventListener('change', triggerUpdate);
      textInput.addEventListener('input', triggerUpdate);
      delBtn.addEventListener('click', () => onDeleteChunk(idx));

      container.appendChild(item);
    });

    const countDisplay = document.getElementById('captionChunksCount');
    if (countDisplay) countDisplay.textContent = chunks.length;
  }

  /**
   * Renders the multi-track visual timeline
   * @param {Array<object>} segments Photo segments
   * @param {Array<object>} captions Captions
   * @param {number} totalDuration Total seconds
   */
  renderTimelineTracks(segments, captions, totalDuration) {
    const photoContent = document.getElementById('photoTrackContent');
    const captionContent = document.getElementById('captionTrackContent');
    const audioContent = document.getElementById('audioTrackContent');

    if (!photoContent || !captionContent) return;
    photoContent.innerHTML = '';
    captionContent.innerHTML = '';
    if (audioContent) audioContent.innerHTML = '';

    const safeDuration = Math.max(1, totalDuration || 60);

    // Track 1: Photo Blocks
    segments.forEach((seg, idx) => {
      const leftPercent = (seg.startTime / safeDuration) * 100;
      const widthPercent = (seg.duration / safeDuration) * 100;

      const block = document.createElement('div');
      block.className = 'photo-block';
      block.style.left = `${leftPercent}%`;
      block.style.width = `${Math.max(0.5, widthPercent)}%`;
      block.title = `Photo #${idx + 1} (${seg.animType}, ${seg.duration.toFixed(1)}s)`;

      let icon = '🔍';
      if (seg.animType.includes('pan')) icon = '↔️';
      if (seg.animType.includes('diagonal')) icon = '↗️';

      block.innerHTML = `<span>${icon} P${idx + 1}</span>`;
      photoContent.appendChild(block);
    });

    // Track 2: Caption Blocks
    captions.forEach((cap, idx) => {
      const leftPercent = (cap.start / safeDuration) * 100;
      const widthPercent = (cap.duration / safeDuration) * 100;

      const block = document.createElement('div');
      block.className = 'caption-block hindi-font';
      block.style.left = `${leftPercent}%`;
      block.style.width = `${Math.max(0.5, widthPercent)}%`;
      block.title = `#${idx + 1}: ${cap.text} (${cap.start.toFixed(1)}s - ${cap.end.toFixed(1)}s)`;
      block.textContent = cap.text;

      captionContent.appendChild(block);
    });

    // Track 3: Voice block
    if (audioContent) {
      const audioBlock = document.createElement('div');
      audioBlock.className = 'audio-block';
      audioBlock.style.left = '0%';
      audioBlock.style.width = '100%';
      audioContent.appendChild(audioBlock);
    }
  }

  /**
   * Updates playhead cursor position
   * @param {number} t Current timestamp
   * @param {number} totalDuration Total duration
   */
  updatePlayhead(t, totalDuration) {
    const playhead = document.getElementById('timelinePlayhead');
    if (!playhead) return;
    const safeDuration = Math.max(0.1, totalDuration || 60);
    const percent = Math.min(100, Math.max(0, (t / safeDuration) * 100));
    playhead.style.left = `${percent}%`;
  }
}
