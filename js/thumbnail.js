/**
 * StoryFlow Studio — Thumbnail Maker Module
 * Renders high-CTR YouTube thumbnails (1280x720) and Instagram/Reels covers (1080x1920).
 * Features:
 * - Center-bias auto-crop cover
 * - Contrast boost & cinematic vignette for text legibility
 * - 4 distinct high-converting text styles (Bold White, Yellow Highlight, Red Box, Minimal)
 * - 2 lines of Hindi typography in Noto Sans Devanagari bold
 * - Interactive canvas drag for text positioning
 * - Live PNG export and Zip export integration
 */

export class ThumbnailMaker {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    this.format = '16:9'; // '16:9' (1280x720) or '9:16' (1080x1920)
    this.width = 1280;
    this.height = 720;

    this.selectedPhoto = null; // { id, imgElement, bitmap, dataUrl }
    this.textLine1 = 'आखिरी ट्रेन की चाबी!';
    this.textLine2 = '1947 का वो दर्दनाक सच';
    this.textStyle = 'red-box'; // 'bold-white' | 'yellow-highlight' | 'red-box' | 'minimal'

    // Text position normalized (0..1)
    this.textX = 0.5; // center
    this.textY = 0.72; // lower-third default

    this.contrast = 1.15;
    this.vignetteIntensity = 0.45;

    // Dragging state
    this.isDragging = false;
    this.dragStartY = 0;
    this.dragStartX = 0;

    this.initEvents();
  }

  setFormat(format) {
    this.format = format;
    if (format === '9:16') {
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
    if (line1 !== undefined) this.textLine1 = line1;
    if (line2 !== undefined) this.textLine2 = line2;
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

    this.canvas.addEventListener('mousedown', (e) => onPointerDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) onPointerMove(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', onPointerUp);

    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0) {
        onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (this.isDragging && e.touches.length > 0) {
        onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    window.addEventListener('touchend', onPointerUp);
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

    // 1. Draw Photo / Background
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
          await new Promise((r) => { img.onload = r; img.onerror = r; });
          this.selectedPhoto._cachedImg = img;
        }
        imgSource = this.selectedPhoto._cachedImg;
      }
    }

    if (imgSource) {
      // Auto-crop with center bias
      const srcW = imgSource.width || 1920;
      const srcH = imgSource.height || 1080;
      const scale = Math.max(W / srcW, H / srcH);
      const drawnW = srcW * scale;
      const drawnH = srcH * scale;
      const offsetX = (W - drawnW) / 2;
      const offsetY = (H - drawnH) / 2;

      ctx.drawImage(imgSource, offsetX, offsetY, drawnW, drawnH);

      // Contrast enhancement filter
      if (this.contrast !== 1.0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, (this.contrast - 1.0) * 0.4)})`;
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      // Fallback cinematic gradient background
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#2b170c');
      grad.addColorStop(0.5, '#170e08');
      grad.addColorStop(1, '#0c0704');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Cinematic Vignette (darken corners & bottom for text legibility)
    if (this.vignetteIntensity > 0) {
      const vignette = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.35,
        W / 2, H / 2, Math.max(W, H) * 0.75
      );
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, `rgba(0, 0, 0, ${this.vignetteIntensity})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);

      // Bottom darkening gradient
      const bottomGrad = ctx.createLinearGradient(0, H * 0.4, 0, H);
      bottomGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      bottomGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
      ctx.fillStyle = bottomGrad;
      ctx.fillRect(0, H * 0.4, W, H * 0.6);
    }

    // 3. Render 2 Lines of Hindi Typography
    const lines = [this.textLine1, this.textLine2].filter(Boolean);
    if (lines.length > 0) {
      const baseFontSize = this.format === '9:16' ? 76 : 58;
      const font = `800 ${baseFontSize}px 'Noto Sans Devanagari', -apple-system, sans-serif`;
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lineSpacing = baseFontSize * 1.35;
      const totalBlockHeight = (lines.length - 1) * lineSpacing;
      const centerY = this.textY * H;
      const startY = centerY - (totalBlockHeight / 2);
      const centerX = this.textX * W;

      lines.forEach((line, idx) => {
        const y = startY + (idx * lineSpacing);
        const textMetrics = ctx.measureText(line);
        const textW = textMetrics.width;

        // Render Style Variations
        switch (this.textStyle) {
          case 'red-box': {
            // Vivid red box with padding
            const padX = baseFontSize * 0.45;
            const padY = baseFontSize * 0.22;
            const boxW = textW + (padX * 2);
            const boxH = baseFontSize * 1.25;
            const boxX = centerX - (boxW / 2);
            const boxY = y - (boxH / 2);

            // Red box background with slight rotation for punchy energy
            ctx.save();
            ctx.translate(centerX, y);
            const rot = idx === 0 ? -0.015 : 0.01;
            ctx.rotate(rot);

            ctx.fillStyle = '#dc2626';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
            ctx.shadowBlur = 16;
            ctx.shadowOffsetY = 4;
            this.roundRect(ctx, -(boxW / 2), -(boxH / 2), boxW, boxH, 8);
            ctx.fill();

            // Text inside box
            ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            ctx.shadowBlur = 4;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(line, 0, 2);
            ctx.restore();
            break;
          }

          case 'yellow-highlight': {
            // Glowing champagne yellow text with thick black outline
            ctx.save();
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.lineWidth = baseFontSize * 0.22;
            ctx.strokeStyle = '#120a05';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 4;
            ctx.strokeText(line, centerX, y);

            ctx.fillStyle = '#ffd466';
            ctx.fillText(line, centerX, y);
            ctx.restore();
            break;
          }

          case 'minimal': {
            // Crisp clean white with subtle elegant drop shadow
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
            ctx.shadowBlur = 18;
            ctx.shadowOffsetY = 4;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(line, centerX, y);
            ctx.restore();
            break;
          }

          case 'bold-white':
          default: {
            // Classic high-contrast white text with thick black stroke
            ctx.save();
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.lineWidth = baseFontSize * 0.24;
            ctx.strokeStyle = '#000000';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
            ctx.shadowBlur = 14;
            ctx.shadowOffsetY = 5;
            ctx.strokeText(line, centerX, y);

            ctx.fillStyle = '#ffffff';
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
  async toBlob(mimeType = 'image/png') {
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
    const blob = await this.toBlob('image/png');
    if (!blob) return;
    const defaultName = this.format === '9:16' ? 'cover_9x16.png' : 'thumbnail_16x9.png';
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename || defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
