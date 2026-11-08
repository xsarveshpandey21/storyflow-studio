/**
 * StoryFlow Studio — Complete Story Workflow Controller
 * Orchestrates the 8-step wizard:
 * 1. Story (Text, .txt upload, Sample)
 * 2. Script / Story Studio (Gemini generation, Retention Meter, Hook Lab, Version History)
 * 3. Photos (Video extraction, Direct photo upload, Gallery)
 * 4. Scene Match (Gemini Vision tagging, Tag overlap matcher, Locks, Confidence dots)
 * 5. Voice (Pre-filled script lines, silence snapping, caption editor)
 * 6. Animation & Captions (Scene matched timeline, Ken Burns, styling)
 * 7. Thumbnail Maker (1280x720 & 9:16, 4 styles, Gemini suggestions, draggable)
 * 8. Publish Pack (YouTube & Facebook tabs, Dual format export, Download .ZIP)
 * Plus: IndexedDB Autosave (5s), My Projects modal, Light/Dark theme toggle.
 */

import { GeminiClient } from './gemini.js';
import { ProjectStore } from './project_store.js';
import { ThumbnailMaker } from './thumbnail.js';
import { SimpleZip } from './vendor/zip-writer.js';
import { 
  countWords, 
  estimateDuration, 
  analyzeRetentionLine, 
  checkWordBudget, 
  validatePublishPack 
} from './validators.js';
import { saveSetting, loadSetting } from './storage.js';

export const SAMPLE_STORY = `सितंबर 1947, लाहौर रेलवे स्टेशन का खचाखच भरा प्लेटफ़ॉर्म। ट्रेन की सीटी बजती है और भीड़ में पति-पत्नी एक-दूसरे से हमेशा के लिए बिछड़ जाते हैं। पत्नी के पास सिर्फ़ उसकी साड़ी के पल्लू में बंधी घर की चाबी थी, यह सोचकर कि वो 10-15 दिनों में लौट आएगी। लेकिन वह दिन कभी नहीं आया।
लाखों लोग 120 किलोमीटर लंबे पैदल काफ़िलों में धूल और आंसुओं के बीच चलते रहे। कुरुक्षेत्र, पुराना क़िला और वाल्टन के शरणार्थी कैंपों में रातें कटीं। जालंधर और अमृतसर रेडियो पर हर घंटे बिछड़े हुए अपनों के नाम पुकारे जाते रहे। नए आशियाने बसे—लाजपत नगर, पटेल नगर, पंजाबी बाग और फ़रीदाबाद। आज भी कई परिवारों की पुरानी संदूकों में वे जंग लगी चाबियां और ताले महफ़ूज़ हैं, जो उस खोए हुए वतन की गवाही देते हैं।`;

export class StoryFlowController {
  constructor(app) {
    this.app = app;
    this.gemini = app.gemini || new GeminiClient({
      onCallCountChange: (count) => this.updateGeminiCallCount(count)
    });
    this.thumbnailMaker = null;
    this.autosaveTimer = null;
    this.isDirty = false;
    this.currentProjectId = loadSetting('last_project_id', `proj_${Date.now()}`);
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

    // Attach backward-compatible frame methods to app
    this.app.toggleFrameStarred = (id) => this.togglePhotoStarred(id);
    this.app.deleteExtractedFrame = (id) => this.deletePhoto(id);
    this.app.previewLargeFrame = (id) => {
      const f = (this.app.state.extractedFrames || []).find((p) => p.id === id);
      if (f) this.previewLargePhoto(f);
    };

    // Check project store or load initial sample
    await this.loadInitialProject();
  }

  cacheDom() {
    // Stepper
    this.stepper = document.getElementById('wizardStepper');
    this.mobileActionBar = document.getElementById('mobileActionBar');
    this.mobileBackBtn = document.getElementById('mobileBackBtn');
    this.mobileNextBtn = document.getElementById('mobileNextBtn');
    this.mobileStepName = document.getElementById('mobileStepName');

    // Header items
    this.themeToggleBtn = document.getElementById('themeToggleBtn');
    this.themeIconDark = this.themeToggleBtn?.querySelector('.theme-icon-dark');
    this.themeIconLight = this.themeToggleBtn?.querySelector('.theme-icon-light');
    this.autosaveBadge = document.getElementById('autosaveBadge');
    this.autosaveText = document.getElementById('autosaveText');
    this.geminiCallCount = document.getElementById('geminiCallCount');

    // Step 1: Story
    this.storyTextarea = document.getElementById('storyTextarea');
    this.storyFileInput = document.getElementById('storyFileInput');
    this.loadSampleStoryBtn = document.getElementById('loadSampleStoryBtn');
    this.startSampleBtn = document.getElementById('startSampleBtn');
    this.goToScriptBtn = document.getElementById('goToScriptBtn');
    this.storyWordCountBadge = document.getElementById('storyWordCountBadge');
    this.storyCharCountBadge = document.getElementById('storyCharCountBadge');
    this.storyEstReadBadge = document.getElementById('storyEstReadBadge');

    // Step 2: Script (Story Studio)
    this.scriptLangSelect = document.getElementById('scriptLangSelect');
    this.scriptDurationSlider = document.getElementById('scriptDurationSlider');
    this.scriptDurationBudgetDisplay = document.getElementById('scriptDurationBudgetDisplay');
    this.scriptToneSelect = document.getElementById('scriptToneSelect');
    this.scriptOpeningSelect = document.getElementById('scriptOpeningSelect');
    this.skipPoliticsCheck = document.getElementById('skipPoliticsCheck');
    this.skipHistoryCheck = document.getElementById('skipHistoryCheck');
    this.trendingKeywordsToggle = document.getElementById('trendingKeywordsToggle');
    this.customInstructionsInput = document.getElementById('customInstructionsInput');
    this.generateScriptBtn = document.getElementById('generateScriptBtn');
    this.scriptHistorySelect = document.getElementById('scriptHistorySelect');
    this.restoreScriptVersionBtn = document.getElementById('restoreScriptVersionBtn');
    this.scriptLinesContainer = document.getElementById('scriptLinesContainer');
    this.addScriptLineBtn = document.getElementById('addScriptLineBtn');
    this.retentionTotalDuration = document.getElementById('retentionTotalDuration');
    this.retentionDurationBand = document.getElementById('retentionDurationBand');
    this.hookLabCardsContainer = document.getElementById('hookLabCardsContainer');
    this.moreHooksBtn = document.getElementById('moreHooksBtn');
    this.backToStoryBtn = document.getElementById('backToStoryBtn');
    this.goToPhotosBtn = document.getElementById('goToPhotosBtn');

    // Step 3: Photos
    this.directPhotoUploadInput = document.getElementById('directPhotoUploadInput');
    this.goToSceneMatchBtn = document.getElementById('goToSceneMatchBtn');
    this.backToScriptBtn = document.getElementById('backToScriptBtn');

    // Step 4: Scene Match
    this.autoMatchScenesBtn = document.getElementById('autoMatchScenesBtn');
    this.shuffleModeCheck = document.getElementById('shuffleModeCheck');
    this.sceneMatchStatus = document.getElementById('sceneMatchStatus');
    this.sceneMatchBoard = document.getElementById('sceneMatchBoard');
    this.goToVoiceBtn = document.getElementById('goToVoiceBtn');
    this.backToPhotosBtn = document.getElementById('backToPhotosBtn');

    // Step 5: Voice
    this.goToAnimationBtn = document.getElementById('goToAnimationBtn');
    this.backToSceneMatchBtn = document.getElementById('backToSceneMatchBtn');

    // Step 6: Animation & Captions
    this.goToThumbnailBtn = document.getElementById('goToThumbnailBtn');
    this.backToVoiceBtn = document.getElementById('backToVoiceBtn');

    // Step 7: Thumbnail Maker
    this.thumbFormat16x9Btn = document.getElementById('thumbFormat16x9Btn');
    this.thumbFormat9x16Btn = document.getElementById('thumbFormat9x16Btn');
    this.downloadThumbPngBtn = document.getElementById('downloadThumbPngBtn');
    this.thumbnailCanvas = document.getElementById('thumbnailCanvas');
    this.thumbPhotoStrip = document.getElementById('thumbPhotoStrip');
    this.suggestHeadlinesBtn = document.getElementById('suggestHeadlinesBtn');
    this.headlineSuggestionsContainer = document.getElementById('headlineSuggestionsContainer');
    this.headlineChips = document.getElementById('headlineChips');
    this.thumbTextLine1 = document.getElementById('thumbTextLine1');
    this.thumbTextLine2 = document.getElementById('thumbTextLine2');
    this.thumbTextYSlider = document.getElementById('thumbTextYSlider');
    this.thumbContrastSlider = document.getElementById('thumbContrastSlider');
    this.thumbVignetteSlider = document.getElementById('thumbVignetteSlider');
    this.styleCardRedBox = document.getElementById('styleCardRedBox');
    this.styleCardYellow = document.getElementById('styleCardYellow');
    this.styleCardBoldWhite = document.getElementById('styleCardBoldWhite');
    this.styleCardMinimal = document.getElementById('styleCardMinimal');
    this.goToPublishBtn = document.getElementById('goToPublishBtn');
    this.backToAnimationBtn = document.getElementById('backToAnimationBtn');

    // Step 8: Export & Publish Pack
    this.exportBothFormatsBtn = document.getElementById('exportBothFormatsBtn');
    this.downloadZipBtn = document.getElementById('downloadZipBtn');
    this.publishTabYtBtn = document.getElementById('publishTabYtBtn');
    this.publishTabFbBtn = document.getElementById('publishTabFbBtn');
    this.publishPanelYt = document.getElementById('publishPanelYt');
    this.publishPanelFb = document.getElementById('publishPanelFb');
    this.backToThumbnailBtn = document.getElementById('backToThumbnailBtn');

    // Facebook Inputs
    this.fbCaptionInput = document.getElementById('fbCaptionInput');
    this.fbHookInput = document.getElementById('fbHookInput');
    this.fbHashtagsContainer = document.getElementById('fbHashtagsContainer');
    this.fbAddHashtagInput = document.getElementById('fbAddHashtagInput');
    this.fbAddHashtagBtn = document.getElementById('fbAddHashtagBtn');
    this.fbFirstCommentInput = document.getElementById('fbFirstCommentInput');
    this.copyFbCaptionBtn = document.getElementById('copyFbCaptionBtn');
    this.copyFbHookBtn = document.getElementById('copyFbHookBtn');
    this.copyFbHashtagsBtn = document.getElementById('copyFbHashtagsBtn');
    this.copyFbCommentBtn = document.getElementById('copyFbCommentBtn');
    this.copyAllFbBtn = document.getElementById('copyAllFbBtn');

    // Modals
    this.projectsModal = document.getElementById('projectsModal');
    this.myProjectsBtn = document.getElementById('myProjectsBtn');
    this.closeProjectsModalBtn = document.getElementById('closeProjectsModalBtn');
    this.newProjectBtn = document.getElementById('newProjectBtn');
    this.projectsListContainer = document.getElementById('projectsListContainer');

    this.settingsModal = document.getElementById('settingsModal');
    this.openSettingsBtn = document.getElementById('openSettingsBtn');
    this.closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
    this.globalApiKeyInput = document.getElementById('globalApiKeyInput');
    this.toggleGlobalKeyVisBtn = document.getElementById('toggleGlobalKeyVisBtn');
    this.globalModelSelect = document.getElementById('globalModelSelect');
    this.globalCustomModelGroup = document.getElementById('globalCustomModelGroup');
    this.globalCustomModelInput = document.getElementById('globalCustomModelInput');
    this.saveSettingsBtn = document.getElementById('saveSettingsBtn');

    this.confirmModal = document.getElementById('confirmModal');
    this.confirmModalTitle = document.getElementById('confirmModalTitle');
    this.confirmModalMsg = document.getElementById('confirmModalMsg');
    this.confirmModalCancelBtn = document.getElementById('confirmModalCancelBtn');
    this.confirmModalActionBtn = document.getElementById('confirmModalActionBtn');
  }

  // =========================================================================
  // Theme & App State
  // =========================================================================

  initTheme() {
    const savedTheme = loadSetting('theme', null);
    // StoryFlow Studio is dark-theme by default; switch only if explicitly set to 'light'
    const isLight = savedTheme === 'light';

    this.applyTheme(isLight);

    this.themeToggleBtn?.addEventListener('click', () => {
      const currentLight = document.body.classList.contains('light-theme');
      this.applyTheme(!currentLight);
      saveSetting('theme', !currentLight ? 'light' : 'dark');
    });
  }

  applyTheme(isLight) {
    if (isLight) {
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
      this.themeIconDark?.classList.add('hidden');
      this.themeIconLight?.classList.remove('hidden');
    } else {
      document.body.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
      this.themeIconDark?.classList.remove('hidden');
      this.themeIconLight?.classList.add('hidden');
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
    // Mobile Action Bar (4 Steps)
    this.mobileBackBtn?.addEventListener('click', () => {
      const cur = this.app.state.currentStep || 1;
      if (cur > 1) this.app.goToStep(cur - 1);
    });
    this.mobileNextBtn?.addEventListener('click', () => {
      const cur = this.app.state.currentStep || 1;
      if (cur < 4) {
        this.app.goToStep(cur + 1);
      }
    });
  }

  canReachStep(stepNumber) {
    if (stepNumber === 1) return true;
    const hasStory = Boolean((this.storyTextarea?.value || '').trim());
    if (stepNumber === 2) return hasStory;
    const hasLines = (this.app.state.scriptLines || []).length > 0;
    if (stepNumber === 3) return true; // Can always load photos
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

    // Update mobile action bar
    const stepNames = [
      'Step 1: Story',
      'Step 2: Script (Story Studio)',
      'Step 3: Photos',
      'Step 4: Scene Match',
      'Step 5: Voice & Audio',
      'Step 6: Animation & Captions',
      'Step 7: Thumbnail Maker',
      'Step 8: Publish Pack'
    ];
    if (this.mobileStepName) {
      this.mobileStepName.textContent = stepNames[stepNumber - 1] || `Step ${stepNumber}`;
    }
    if (this.mobileBackBtn) {
      this.mobileBackBtn.style.visibility = stepNumber === 1 ? 'hidden' : 'visible';
    }
    if (this.mobileNextBtn) {
      this.mobileNextBtn.style.visibility = stepNumber === 8 ? 'hidden' : 'visible';
    }

    // Step-specific reactive hooks
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
    this.storyTextarea?.addEventListener('input', () => {
      this.updateStoryStats();
      this.markDirty();
    });

    this.loadSampleStoryBtn?.addEventListener('click', () => {
      if (this.storyTextarea) {
        this.storyTextarea.value = SAMPLE_STORY;
        this.updateStoryStats();
        this.app?.ui?.showToast('Loaded September 1947 sample story.', 'success');
        this.markDirty();
      }
    });

    this.startSampleBtn?.addEventListener('click', async () => {
      if (this.storyTextarea) {
        this.storyTextarea.value = SAMPLE_STORY;
        this.updateStoryStats();
      }
      this.goToStep(2);
      // Auto-trigger generation for instant user delight
      await this.generateScriptWithGemini();
    });

    this.storyFileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (this.storyTextarea) {
          this.storyTextarea.value = evt.target.result || '';
          this.updateStoryStats();
          this.app?.ui?.showToast(`Loaded ${file.name}`, 'success');
          this.markDirty();
        }
      };
      reader.readAsText(file);
    });
  }

  updateStoryStats() {
    const text = (this.storyTextarea?.value || '').trim();
    const words = countWords(text);
    const chars = text.length;
    const estSec = estimateDuration(text);

    if (this.storyWordCountBadge) this.storyWordCountBadge.textContent = words;
    if (this.storyCharCountBadge) this.storyCharCountBadge.textContent = chars;
    if (this.storyEstReadBadge) this.storyEstReadBadge.textContent = `${estSec}s`;

    if (this.app?.state) {
      this.app.state.story = text;
    }
  }

  // =========================================================================
  // Step 2: Script (Story Studio)
  // =========================================================================

  bindScriptStudioEvents() {
    this.scriptDurationSlider?.addEventListener('input', (e) => {
      const secs = parseInt(e.target.value, 10);
      const words = Math.round(secs * 2.4);
      if (this.scriptDurationBudgetDisplay) {
        this.scriptDurationBudgetDisplay.textContent = `${secs}s · ~${words} words`;
      }
      this.renderRetentionSummary();
    });

    this.generateScriptBtn?.addEventListener('click', () => this.generateScriptWithGemini());
    this.addScriptLineBtn?.addEventListener('click', () => this.addNewScriptLine());
    this.moreHooksBtn?.addEventListener('click', () => this.requestMoreHooks());

    this.restoreScriptVersionBtn?.addEventListener('click', () => {
      const idx = parseInt(this.scriptHistorySelect?.value, 10);
      if (!isNaN(idx) && this.app.state.scriptHistory?.[idx]) {
        this.app.state.scriptLines = [...this.app.state.scriptHistory[idx].lines];
        this.renderScriptLines();
        this.app?.ui?.showToast('Restored script version.', 'success');
        this.markDirty();
      }
    });
  }

  async generateScriptWithGemini() {
    const story = (this.storyTextarea?.value || this.app.state.story || '').trim();
    if (!story) {
      this.app?.ui?.showToast('Please enter a story in Step 1 first.', 'error');
      this.goToStep(1);
      return;
    }

    const key = this.gemini.getApiKey();
    if (!key) {
      this.openSettingsModal();
      this.app?.ui?.showToast('Please enter your Gemini API key to generate scripts.', 'info');
      return;
    }

    const targetSec = parseInt(this.scriptDurationSlider?.value, 10) || 75;
    const language = this.scriptLangSelect?.value || 'Hindi';
    const tone = this.scriptToneSelect?.value || 'Emotional';
    const openingStyle = this.scriptOpeningSelect?.value || 'Scene';
    const skipPolitics = Boolean(this.skipPoliticsCheck?.checked);
    const skipHistory = Boolean(this.skipHistoryCheck?.checked);
    const customInstructions = (this.customInstructionsInput?.value || '').trim();
    const useSearch = Boolean(this.trendingKeywordsToggle?.checked);

    if (this.generateScriptBtn) {
      this.generateScriptBtn.disabled = true;
      this.generateScriptBtn.innerHTML = `⏳ <span class="yt-spinner"></span> Generating Script with Gemini...`;
    }

    try {
      let trendingKeywords = '';
      if (useSearch) {
        try {
          this.app?.ui?.showToast('🔍 Searching Google for trending keywords...', 'info', 2500);
          trendingKeywords = await this.gemini.trendingResearch({ topic: story.slice(0, 100) });
          this.app.state.trendingResearch = trendingKeywords;
        } catch (sErr) {
          console.warn('[Search Tool]', sErr);
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

      // Validation
      const budgetCheck = checkWordBudget(result.script_lines, targetSec);
      if (!budgetCheck.isWithinBudget) {
        console.warn(`[Validation] Script budget delta is ${budgetCheck.deltaPercent}%`);
      }

      // Map lines
      this.app.state.scriptLines = (result.script_lines || []).map((line, idx) => ({
        text: line,
        scene_tags: result.scene_tags?.[idx] || ['history', 'scene'],
        estimatedSeconds: estimateDuration(line)
      }));

      // History
      if (!this.app.state.scriptHistory) this.app.state.scriptHistory = [];
      this.app.state.scriptHistory.unshift({
        timestamp: new Date().toLocaleTimeString(),
        lines: JSON.parse(JSON.stringify(this.app.state.scriptLines)),
        note: `${this.app.state.scriptLines.length} lines · ${targetSec}s target`
      });
      if (this.app.state.scriptHistory.length > 10) this.app.state.scriptHistory.pop();
      this.updateHistorySelect();

      // Hook Lab & Publish metadata
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
      this.app?.ui?.showToast('✨ High-retention Hindi narration generated!', 'success');
      this.markDirtyAndSave();
    } catch (err) {
      console.error('[Script Gen Error]', err);
      this.app?.ui?.showToast(`Script generation failed: ${err.message}`, 'error', 6000);
    } finally {
      if (this.generateScriptBtn) {
        this.generateScriptBtn.disabled = false;
        this.generateScriptBtn.innerHTML = `✨ Generate Script with Gemini`;
      }
    }
  }

  updateHistorySelect() {
    if (!this.scriptHistorySelect) return;
    this.scriptHistorySelect.innerHTML = '<option value="">Version History (Current)</option>';
    (this.app.state.scriptHistory || []).forEach((v, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = `v${idx + 1} (${v.timestamp}) — ${v.note}`;
      this.scriptHistorySelect.appendChild(opt);
    });
  }

  renderScriptLines() {
    if (!this.scriptLinesContainer) return;
    this.scriptLinesContainer.innerHTML = '';

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

      const card = document.createElement('div');
      card.className = `script-line-card ${analysis.isWarning ? 'has-warning' : ''}`;

      // Header row
      const header = document.createElement('div');
      header.className = 'script-line-header';

      const meta = document.createElement('div');
      meta.className = 'line-meta-badge';
      meta.innerHTML = `<strong>Line ${idx + 1}</strong> &middot; <span>${analysis.words} words</span> &middot; <span>~${analysis.seconds}s</span>`;
      
      if (analysis.isWarning) {
        const warnBadge = document.createElement('span');
        warnBadge.className = 'warning-pill';
        warnBadge.textContent = analysis.reasons.join(' · ');
        meta.appendChild(warnBadge);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'line-delete-btn';
      delBtn.title = 'Delete line';
      delBtn.textContent = '🗑️';
      delBtn.addEventListener('click', () => {
        this.app.state.scriptLines.splice(idx, 1);
        this.renderScriptLines();
        this.markDirty();
      });

      header.appendChild(meta);
      header.appendChild(delBtn);

      // Textarea
      const ta = document.createElement('textarea');
      ta.className = 'script-line-textarea hindi-font';
      ta.rows = 2;
      ta.value = lineObj.text;
      ta.addEventListener('input', (e) => {
        lineObj.text = e.target.value;
        const newAnalysis = analyzeRetentionLine(lineObj.text);
        lineObj.estimatedSeconds = newAnalysis.seconds;
        card.classList.toggle('has-warning', newAnalysis.isWarning);
        this.renderRetentionSummary();
        this.markDirty();
      });

      // Visual line duration bar
      const track = document.createElement('div');
      track.className = 'line-retention-track';
      const fill = document.createElement('div');
      fill.className = 'line-retention-fill';
      const pct = Math.min(100, (analysis.seconds / 10) * 100);
      fill.style.width = `${pct}%`;
      if (analysis.seconds > 9.0) fill.style.background = '#ef4444';
      else if (analysis.seconds > 7.0) fill.style.background = '#f59e0b';
      track.appendChild(fill);

      // Footer with 1-click shorten line
      const footer = document.createElement('div');
      footer.className = 'script-line-footer';

      const tagsSpan = document.createElement('span');
      tagsSpan.className = 'subtext';
      tagsSpan.textContent = `Visual: ${(lineObj.scene_tags || []).join(', ')}`;

      const shortenBtn = document.createElement('button');
      shortenBtn.type = 'button';
      shortenBtn.className = 'btn-shorten-line';
      shortenBtn.innerHTML = `⚡ Shorten this line`;
      shortenBtn.addEventListener('click', () => this.shortenScriptLine(idx));

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
    const lines = this.app.state.scriptLines || [];
    if (!lines[lineIndex]) return;

    const originalText = lines[lineIndex].text;
    this.app?.ui?.showToast(`Shortening line ${lineIndex + 1} with Gemini...`, 'info', 3000);

    try {
      const res = await this.gemini.shortenLine({
        lineText: originalText,
        targetSeconds: 4.5,
        storyContext: this.app.state.story
      });

      if (res?.shortened_line) {
        lines[lineIndex].text = res.shortened_line;
        this.renderScriptLines();
        this.app?.ui?.showToast(`Line ${lineIndex + 1} shortened successfully!`, 'success');
        this.markDirty();
      }
    } catch (err) {
      this.app?.ui?.showToast(`Failed to shorten line: ${err.message}`, 'error');
    }
  }

  addNewScriptLine() {
    if (!this.app.state.scriptLines) this.app.state.scriptLines = [];
    this.app.state.scriptLines.push({
      text: 'नई पंक्ति यहाँ लिखें।',
      scene_tags: ['history', 'scene'],
      estimatedSeconds: 2.5
    });
    this.renderScriptLines();
    this.markDirty();
  }

  renderRetentionSummary() {
    const lines = this.app.state.scriptLines || [];
    const totalWords = lines.reduce((acc, l) => acc + countWords(l.text || ''), 0);
    const totalSec = Number((totalWords / 2.4).toFixed(1));
    const targetSec = parseInt(this.scriptDurationSlider?.value, 10) || 75;

    if (this.retentionTotalDuration) {
      this.retentionTotalDuration.textContent = `Total: ${totalSec}s (~${totalWords} words) / ${targetSec}s Target`;
    }

    if (this.retentionDurationBand) {
      const pct = Math.min(100, (totalSec / (targetSec * 1.3)) * 100);
      this.retentionDurationBand.style.width = `${pct}%`;

      const delta = Math.abs(totalSec - targetSec);
      const deltaPct = (delta / targetSec) * 100;

      this.retentionDurationBand.className = 'retention-progress-bar';
      if (deltaPct <= 10) {
        this.retentionDurationBand.classList.add('band-green');
      } else if (deltaPct <= 25) {
        this.retentionDurationBand.classList.add('band-amber');
      } else {
        this.retentionDurationBand.classList.add('band-red');
      }
    }
  }

  renderHookLab() {
    if (!this.hookLabCardsContainer) return;
    this.hookLabCardsContainer.innerHTML = '';

    const hooks = this.app.state.hookOptions || [];
    if (hooks.length === 0) {
      this.hookLabCardsContainer.innerHTML = `
        <span class="subtext">Generate a script to preview high-retaining alternative hooks.</span>`;
      return;
    }

    hooks.forEach((h, idx) => {
      const card = document.createElement('div');
      card.className = 'hook-option-card';

      card.innerHTML = `
        <div class="hook-score-badge">★ ${h.score || 9}/10 Score</div>
        <div class="hook-text hindi-font">${h.text}</div>
        <div class="hook-why">${h.why || 'Attention grabbing opening'}</div>
      `;

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'btn btn-xs btn-primary';
      useBtn.textContent = 'Use this hook for Line 1';
      useBtn.addEventListener('click', () => {
        if (this.app.state.scriptLines && this.app.state.scriptLines.length > 0) {
          this.app.state.scriptLines[0].text = h.text;
          this.renderScriptLines();
          this.app?.ui?.showToast('Applied hook to Line 1!', 'success');
          this.markDirty();
        }
      });

      card.appendChild(useBtn);
      this.hookLabCardsContainer.appendChild(card);
    });
  }

  async requestMoreHooks() {
    this.app?.ui?.showToast('Generating more hooks with Gemini...', 'info', 2500);
    try {
      const res = await this.gemini.moreHooks({
        story: this.app.state.story,
        currentHooks: this.app.state.hookOptions,
        openingStyle: this.scriptOpeningSelect?.value || 'Scene'
      });
      if (res?.hook_options) {
        this.app.state.hookOptions = res.hook_options;
        this.renderHookLab();
        this.app?.ui?.showToast('Fresh hooks generated!', 'success');
        this.markDirty();
      }
    } catch (e) {
      this.app?.ui?.showToast(`Failed to generate hooks: ${e.message}`, 'error');
    }
  }

  // =========================================================================
  // Step 3: Photos (Direct Upload + Video Extractor)
  // =========================================================================

  bindPhotoEvents() {
    this.directPhotoUploadInput?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      this.app?.ui?.showToast(`Loading ${files.length} photos...`, 'info', 2000);
      let count = 0;
      const wm = this.app?.getWatermarkConfig?.();

      for (const file of files) {
        try {
          let dataUrl = await this.readFileAsDataUrl(file);
          let finalBlob = file;

          if (wm && wm.enabled && this.app?.extractor?.applyWatermark) {
            try {
              const img = await new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = dataUrl;
              });
              const cvs = document.createElement('canvas');
              cvs.width = img.naturalWidth || img.width;
              cvs.height = img.naturalHeight || img.height;
              const c = cvs.getContext('2d');
              c.drawImage(img, 0, 0);
              this.app.extractor.applyWatermark(c, cvs.width, cvs.height, wm);
              dataUrl = cvs.toDataURL('image/jpeg', 0.95);
              finalBlob = await new Promise((r) => cvs.toBlob((b) => r(b), 'image/jpeg', 0.95));
            } catch (wErr) {
              console.warn('[Direct Photo Watermark]', wErr);
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
            caption: file.name.replace(/\.[^/.]+$/, ''),
            mood: 'neutral'
          };
          this.app.state.extractedFrames.push(photoRecord);
          // Save blob into IndexedDB
          await ProjectStore.saveBlob(photoId, finalBlob);
          count++;
        } catch (err) {
          console.warn('[Direct Photo Upload]', err);
        }
      }

      this.renderPhotoGallery();
      this.app?.ui?.showToast(`Added ${count} photos to gallery!`, 'success');
      this.markDirtyAndSave();
    });
  }

  renderPhotoGallery() {
    if (typeof this.app.refreshGallery === 'function') {
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
      if (removed && removed.previewUrl && typeof removed.previewUrl === 'string' && removed.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(removed.previewUrl); } catch (e) {}
      }
      this.renderPhotoGallery();
      this.markDirty();
    }
  }

  previewLargePhoto(frame) {
    const modal = document.getElementById('framePreviewModal');
    const img = document.getElementById('modalPreviewImg');
    const meta = document.getElementById('modalMetaRow');
    if (modal && img) {
      img.src = frame.previewUrl || frame.dataUrl || '';
      if (meta) {
        meta.textContent = `Timestamp: ${Math.floor(frame.timestamp / 60)}:${String(Math.floor(frame.timestamp % 60)).padStart(2, '0')} · Aspect: ${frame.aspectRatio || '16:9'}`;
      }
      modal.classList.remove('hidden');
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
    this.autoMatchScenesBtn?.addEventListener('click', () => this.autoMatchScenes());
    this.shuffleModeCheck?.addEventListener('change', (e) => {
      this.app.state.shuffleMode = e.target.checked;
      this.rebuildSceneTimeline();
      this.markDirty();
    });
  }

  async autoMatchScenes() {
    const photos = this.app.state.extractedFrames || [];
    const scriptLines = this.app.state.scriptLines || [];

    if (photos.length === 0) {
      this.app?.ui?.showToast('Please add photos in Step 3 first.', 'error');
      return;
    }
    if (scriptLines.length === 0) {
      this.app?.ui?.showToast('Please create script lines in Step 2 first.', 'error');
      return;
    }

    if (this.autoMatchScenesBtn) {
      this.autoMatchScenesBtn.disabled = true;
      this.autoMatchScenesBtn.innerHTML = `⏳ <span class="yt-spinner"></span> Vision Tagging & Matching...`;
    }

    // One-time privacy notice for photos sent to Gemini
    const noticeSeen = loadSetting('vision_notice_acknowledged', false);
    if (!noticeSeen) {
      this.app?.ui?.showToast('Notice: Photos are sent to Gemini Vision only for tag extraction and matching.', 'info', 6000);
      saveSetting('vision_notice_acknowledged', true);
    }

    try {
      // 1. Tag photos with Gemini Vision in batches of 8, with IndexedDB cache
      const untaggedPhotos = [];
      for (const p of photos) {
        if (!p.tags || p.tags.length === 0) {
          const cached = await ProjectStore.getCachedPhotoTags(p.id);
          if (cached) {
            p.tags = cached.tags || [];
            p.caption = cached.caption || '';
            p.mood = cached.mood || 'neutral';
          } else {
            untaggedPhotos.push(p);
          }
        }
      }

      if (untaggedPhotos.length > 0) {
        if (this.sceneMatchStatus) {
          this.sceneMatchStatus.textContent = `Analyzing ${untaggedPhotos.length} photos in batches of 8 with Gemini Vision...`;
        }

        // Process in batches of 8 downscaled JPEGs
        for (let i = 0; i < untaggedPhotos.length; i += 8) {
          const batch = untaggedPhotos.slice(i, i + 8);
          const payloadPhotos = [];

          for (const bp of batch) {
            const base64 = await this.getDownscaledJpegBase64(bp);
            payloadPhotos.push({ id: bp.id, base64, mimeType: 'image/jpeg' });
          }

          const visionResults = await this.gemini.tagPhotos(payloadPhotos);
          for (const vr of visionResults) {
            const targetP = photos.find((p) => p.id === vr.id);
            if (targetP) {
              targetP.tags = vr.tags || [];
              targetP.caption = vr.caption || '';
              targetP.mood = vr.mood || 'neutral';
              await ProjectStore.setCachedPhotoTags(targetP.id, vr);
            }
          }
        }
      }

      if (this.sceneMatchStatus) {
        this.sceneMatchStatus.textContent = `Matching ${scriptLines.length} script lines with ${photos.length} photos...`;
      }

      // 2. Scene matching (respecting locks)
      const existingLocks = (this.app.state.sceneMatches || []).filter((m) => m.locked);
      const matches = await this.gemini.matchScenes({ scriptLines, photos });

      // Merge locked pairs
      const finalMatches = matches.map((m) => {
        const lockedMatch = existingLocks.find((l) => l.line_index === m.line_index);
        return lockedMatch || { ...m, locked: false };
      });

      this.app.state.sceneMatches = finalMatches;
      this.renderSceneMatchBoard();
      this.rebuildSceneTimeline();
      this.app?.ui?.showToast('✨ Scenes matched to photos successfully!', 'success');
      this.markDirtyAndSave();
    } catch (err) {
      console.error('[Scene Match Error]', err);
      // Fallback
      const fallback = this.gemini.fallbackMatchScenes(scriptLines, photos);
      this.app.state.sceneMatches = fallback;
      this.renderSceneMatchBoard();
      this.rebuildSceneTimeline();
      this.app?.ui?.showToast(`Local tag matcher used: ${err.message}`, 'warning');
      this.markDirty();
    } finally {
      if (this.autoMatchScenesBtn) {
        this.autoMatchScenesBtn.disabled = false;
        this.autoMatchScenesBtn.innerHTML = `✨ Auto-Match Scenes with Gemini`;
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
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = () => resolve('');
      img.src = photo.dataUrl;
    });
  }

  renderSceneMatchBoard() {
    if (!this.sceneMatchBoard) return;
    this.sceneMatchBoard.innerHTML = '';

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
      const match = matches.find((m) => m.line_index === idx) || {
        line_index: idx,
        photo_id: photos[idx % photos.length]?.id,
        confidence: 'medium',
        locked: false
      };

      const photo = photos.find((p) => p.id === match.photo_id) || photos[0];

      const row = document.createElement('div');
      row.className = 'scene-match-row';

      // Left Column: Script Line
      const leftCol = document.createElement('div');
      leftCol.className = 'match-line-col';
      leftCol.innerHTML = `
        <div class="line-num">Line #${idx + 1} &middot; ~${line.estimatedSeconds || 3}s</div>
        <div class="line-text hindi-font">${line.text}</div>
        <div class="match-tags-row">
          ${(line.scene_tags || []).map((t) => `<span class="scene-tag-chip">🏷️ ${t}</span>`).join('')}
        </div>
      `;

      // Right Column: Assigned Photo
      const rightCol = document.createElement('div');
      rightCol.className = 'match-photo-col';

      const thumbImg = document.createElement('img');
      thumbImg.className = 'match-thumb-img';
      thumbImg.src = photo.previewUrl || photo.dataUrl || '';
      thumbImg.alt = 'Matched photo';

      const metaInfo = document.createElement('div');
      metaInfo.className = 'match-meta-info';

      const confLevel = match.confidence || 'high';
      metaInfo.innerHTML = `
        <div class="match-confidence">
          <span class="confidence-dot ${confLevel}"></span>
          <span>${confLevel.toUpperCase()} MATCH</span>
        </div>
        <div class="subtext" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;">
          ${(photo.tags || []).slice(0, 3).join(', ') || 'Archival Photo'}
        </div>
      `;

      // Photo selector dropdown
      const sel = document.createElement('select');
      sel.className = 'form-select form-select-xs';
      sel.style.marginTop = '0.25rem';
      photos.forEach((p, pIdx) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `Photo #${pIdx + 1}${p.starred ? ' ⭐' : ''} (${(p.tags || []).slice(0, 2).join(', ')})`;
        if (p.id === photo.id) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', (e) => {
        match.photo_id = e.target.value;
        const newP = photos.find((p) => p.id === e.target.value);
        if (newP) thumbImg.src = newP.previewUrl || newP.dataUrl || '';
        this.rebuildSceneTimeline();
        this.markDirty();
      });
      metaInfo.appendChild(sel);

      // Lock button
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = `btn-lock-match ${match.locked ? 'locked' : ''}`;
      lockBtn.title = match.locked ? 'Locked (survives auto-match)' : 'Click to lock';
      lockBtn.textContent = match.locked ? '🔒' : '🔓';
      lockBtn.addEventListener('click', () => {
        match.locked = !match.locked;
        lockBtn.textContent = match.locked ? '🔒' : '🔓';
        lockBtn.classList.toggle('locked', match.locked);
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
        this.app.captionEngine?.chunks,
        {
          enabledAnimations: this.app.state.enabledAnimations,
          maxZoom: this.app.state.maxZoom,
          transitionDuration: this.app.state.transitionDuration,
          transitionType: this.app.state.transitionType
        }
      );

      this.app.ui.renderTimelineTracks(segments, this.app.captionEngine?.chunks, dur);
      const totalDisplay = document.getElementById('totalDurationDisplay');
      if (totalDisplay) totalDisplay.textContent = this.app.ui.formatTime(dur);
      this.app.renderCurrentPreviewFrame();
    } else {
      this.app.rebuildTimeline();
    }
  }

  prefillVoiceScript() {
    const lines = (this.app.state.scriptLines || []).map((l) => l.text);
    if (lines.length > 0) {
      const fullText = lines.join(' ');
      const scriptTa = document.getElementById('scriptTextarea');
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
    if (!this.thumbnailCanvas) return;
    this.thumbnailMaker = new ThumbnailMaker(this.thumbnailCanvas);

    // Format buttons
    this.thumbFormat16x9Btn?.addEventListener('click', () => {
      this.thumbFormat16x9Btn.classList.add('active');
      this.thumbFormat9x16Btn.classList.remove('active');
      this.thumbnailMaker.setFormat('16:9');
    });

    this.thumbFormat9x16Btn?.addEventListener('click', () => {
      this.thumbFormat9x16Btn.classList.add('active');
      this.thumbFormat16x9Btn.classList.remove('active');
      this.thumbnailMaker.setFormat('9:16');
    });

    // Text inputs
    this.thumbTextLine1?.addEventListener('input', (e) => {
      this.thumbnailMaker.setText(e.target.value, undefined);
      this.markDirty();
    });
    this.thumbTextLine2?.addEventListener('input', (e) => {
      this.thumbnailMaker.setText(undefined, e.target.value);
      this.markDirty();
    });

    // Style cards
    const styleCards = [
      { el: this.styleCardRedBox, style: 'red-box' },
      { el: this.styleCardYellow, style: 'yellow-highlight' },
      { el: this.styleCardBoldWhite, style: 'bold-white' },
      { el: this.styleCardMinimal, style: 'minimal' }
    ];

    styleCards.forEach(({ el, style }) => {
      el?.addEventListener('click', () => {
        styleCards.forEach((c) => c.el?.classList.remove('selected'));
        el.classList.add('selected');
        this.thumbnailMaker.setStyle(style);
        this.markDirty();
      });
    });

    // Sliders
    this.thumbTextYSlider?.addEventListener('input', (e) => {
      const normY = parseInt(e.target.value, 10) / 100;
      this.thumbnailMaker.setPositionY(normY);
    });

    this.thumbContrastSlider?.addEventListener('input', (e) => {
      this.thumbnailMaker.contrast = parseInt(e.target.value, 10) / 100;
      this.thumbnailMaker.render();
    });

    this.thumbVignetteSlider?.addEventListener('input', (e) => {
      this.thumbnailMaker.vignetteIntensity = parseInt(e.target.value, 10) / 100;
      this.thumbnailMaker.render();
    });

    // Download PNG
    this.downloadThumbPngBtn?.addEventListener('click', () => {
      this.thumbnailMaker.downloadPng();
      this.app?.ui?.showToast('💾 Thumbnail downloaded as PNG!', 'success');
    });

    // Headline Suggestions
    this.suggestHeadlinesBtn?.addEventListener('click', () => this.suggestHeadlines());
  }

  renderThumbnailStudio() {
    if (!this.thumbnailMaker) return;
    const photos = this.app.state.extractedFrames || [];

    // Populate photo strip
    if (this.thumbPhotoStrip) {
      this.thumbPhotoStrip.innerHTML = '';
      photos.forEach((p, idx) => {
        const img = document.createElement('img');
        img.className = `thumb-strip-item ${idx === 0 ? 'selected' : ''}`;
        img.src = p.dataUrl;
        img.alt = `Photo ${idx + 1}`;
        img.addEventListener('click', () => {
          this.thumbPhotoStrip?.querySelectorAll('.thumb-strip-item').forEach((i) => i.classList.remove('selected'));
          img.classList.add('selected');
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
    this.app?.ui?.showToast('Generating headline ideas with Gemini...', 'info', 2500);
    try {
      const suggestions = await this.gemini.thumbnailTexts({
        story: this.app.state.story,
        scriptLines: this.app.state.scriptLines
      });

      if (this.headlineSuggestionsContainer && this.headlineChips) {
        this.headlineSuggestionsContainer.classList.remove('hidden');
        this.headlineChips.innerHTML = '';

        suggestions.forEach((text) => {
          const chip = document.createElement('div');
          chip.className = 'headline-chip hindi-font';
          chip.textContent = text;
          chip.addEventListener('click', () => {
            if (this.thumbTextLine1) {
              this.thumbTextLine1.value = text;
              this.thumbnailMaker.setText(text, undefined);
              this.markDirty();
            }
          });
          this.headlineChips.appendChild(chip);
        });
      }
      this.app?.ui?.showToast('Click a headline to apply to thumbnail!', 'success');
    } catch (e) {
      this.app?.ui?.showToast(`Headline suggestion failed: ${e.message}`, 'error');
    }
  }

  // =========================================================================
  // Step 8: Publish Pack & Dual Export
  // =========================================================================

  bindPublishEvents() {
    // Standalone render current format
    this.exportMp4Btn = document.getElementById('exportMp4Btn');
    this.exportMp4Btn?.addEventListener('click', async () => {
      if ((this.app.state.extractedFrames || []).length === 0) {
        this.app?.ui?.showToast('Please add photos or extract frames in Step 1 first!', 'warning');
        return;
      }

      const progressModal = document.getElementById('exportProgressModal');
      const progressTitle = document.getElementById('exportProgressTitle');
      progressModal?.classList.remove('hidden');

      // If Neural TTS is active and script exists, synthesize voice first (with silent fallback if TTS unavailable)
      if (this.app.state.voiceMode === 'A' && (this.app.state.scriptText || '').trim() && !this.app.voiceEngine?.audioBuffer) {
        try {
          if (progressTitle) progressTitle.textContent = 'Generating Neural Voice (Neural TTS)...';
          const sentences = this.app.captionEngine.splitScriptIntoSentences(this.app.state.scriptText);
          const ttsOpts = this.app.getTtsOptions();
          const ttsResult = await this.app.voiceEngine.generateVoiceFromScript(sentences, {
            voice: ttsOpts.voice,
            rate: ttsOpts.rate,
            pitch: ttsOpts.pitch,
            volume: ttsOpts.volume
          });
          if (ttsResult?.buffer) {
            this.app.onVoiceLoaded(ttsResult.buffer, 'tts_voice.wav', true);
          }
        } catch (ttsErr) {
          console.warn('[Neural TTS Export fallback]', ttsErr);
        }
      }

      if (progressTitle) {
        const hasVoice = Boolean(this.app.voiceEngine?.audioBuffer);
        progressTitle.textContent = hasVoice
          ? 'Fast Encoding Video & Voice (WebCodecs)...'
          : 'Fast Encoding Video (WebCodecs)...';
      }

      try {
        const blob = await this.renderVideoBlob();
        if (this.app.state.aspectRatio === '9:16') {
          this.cachedBlob916 = blob;
        } else {
          this.cachedBlob169 = blob;
        }
        const ratioTag = this.app.state.aspectRatio === '9:16' ? '9x16' : '16x9';
        this.app.exporter.triggerDownload(blob, `storyflow_${ratioTag}.mp4`);
        this.app?.ui?.showToast('Export completed successfully!', 'success');
      } catch (err) {
        this.app?.ui?.showToast(`Export failed: ${err.message}`, 'error');
      } finally {
        progressModal?.classList.add('hidden');
      }
    });

    // Export both formats
    this.exportBothFormatsBtn = document.getElementById('exportBothFormatsBtn');
    this.exportBothFormatsBtn?.addEventListener('click', () => this.exportBothFormats());

    // Download .ZIP bundle
    this.downloadZipBtn = document.getElementById('downloadZipBtn');
    this.downloadZipBtn?.addEventListener('click', () => this.downloadAllInZip());
  }

  renderPublishPack() {
    const pack = this.app.state.publishPack;
    if (!pack) return;

    // YouTube fields
    if (pack.youtube && this.app.youtubeGenerator) {
      this.app.youtubeGenerator.renderResults(pack.youtube);
    }

    // Facebook fields
    if (pack.facebook) {
      if (this.fbCaptionInput) this.fbCaptionInput.value = pack.facebook.caption || '';
      if (this.fbHookInput) this.fbHookInput.value = pack.facebook.hook_line || '';
      if (this.fbFirstCommentInput) this.fbFirstCommentInput.value = pack.facebook.first_comment || '';

      if (this.fbHashtagsContainer) {
        this.fbHashtagsContainer.innerHTML = '';
        (pack.facebook.hashtags || []).forEach((tag, idx) => {
          const chip = document.createElement('span');
          chip.className = 'yt-hashtag-chip';
          chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove">&times;</button>`;
          chip.querySelector('.yt-chip-remove').addEventListener('click', () => {
            pack.facebook.hashtags.splice(idx, 1);
            this.renderPublishPack();
          });
          this.fbHashtagsContainer.appendChild(chip);
        });
      }
    }
  }

  async copyToClipboard(text, label = 'Content') {
    if (!text) {
      this.app?.ui?.showToast(`Nothing to copy for ${label}`, 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.app?.ui?.showToast(`📋 Copied ${label} to clipboard!`, 'success');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.app?.ui?.showToast(`📋 Copied ${label} to clipboard!`, 'success');
    }
  }

  copyAllFacebook() {
    const caption = this.fbCaptionInput?.value || '';
    const hook = this.fbHookInput?.value || '';
    const hashtags = (this.app.state.publishPack?.facebook?.hashtags || []).join(' ');
    const comment = this.fbFirstCommentInput?.value || '';

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
    this.copyToClipboard(bundle, 'Facebook Post Pack');
  }

  async exportBothFormats() {
    if (this.exportingDual) return;
    if ((this.app.state.extractedFrames || []).length === 0) {
      this.app?.ui?.showToast('Please add photos or extract frames in Step 1 first!', 'warning');
      return;
    }
    this.exportingDual = true;

    const progressModal = document.getElementById('exportProgressModal');
    const progressTitle = document.getElementById('exportProgressTitle');
    progressModal?.classList.remove('hidden');

    try {
      // 1. Synthesize Neural TTS if in Mode A and audio buffer not yet loaded
      if (this.app.state.voiceMode === 'A' && !this.app.voiceEngine?.audioBuffer) {
        const scriptText = (this.app.state.scriptText || '').trim();
        if (scriptText) {
          if (progressTitle) progressTitle.textContent = 'Generating Neural Voice for Dual Export...';
          const sentences = this.app.captionEngine.splitScriptIntoSentences(scriptText);
          const ttsOpts = this.app.getTtsOptions();
          const ttsResult = await this.app.voiceEngine.generateVoiceFromScript(sentences, {
            voice: ttsOpts.voice,
            rate: ttsOpts.rate,
            pitch: ttsOpts.pitch,
            volume: ttsOpts.volume
          });
          if (ttsResult?.buffer) {
            this.app.onVoiceLoaded(ttsResult.buffer, 'tts_voice.wav', true);
          }
        }
      }

      // 2. Format 1 of 2: 16:9 Landscape
      if (progressTitle) progressTitle.textContent = 'Rendering Format 1 of 2: 16:9 Landscape...';
      this.app.setAspectRatio('16:9');
      this.rebuildSceneTimeline();
      
      const blob169 = await this.renderVideoBlob();
      this.cachedBlob169 = blob169;
      this.app.exporter.triggerDownload(blob169, 'storyflow_16x9.mp4');

      // 3. Format 2 of 2: 9:16 Vertical (Shorts/Reels)
      if (progressTitle) progressTitle.textContent = 'Rendering Format 2 of 2: 9:16 Vertical (Shorts/Reels)...';
      this.app.setAspectRatio('9:16');
      this.app.state.verticalModeLayout = 'blur-bg';
      this.rebuildSceneTimeline();

      const blob916 = await this.renderVideoBlob();
      this.cachedBlob916 = blob916;
      this.app.exporter.triggerDownload(blob916, 'storyflow_9x16.mp4');

      this.app?.ui?.showToast('🎉 Both 16:9 and 9:16 videos rendered successfully!', 'success', 6000);
    } catch (err) {
      this.app?.ui?.showToast(`Dual export failed: ${err.message}`, 'error', 6000);
    } finally {
      progressModal?.classList.add('hidden');
      this.exportingDual = false;
      this.app.setAspectRatio('16:9');
      this.rebuildSceneTimeline();
    }
  }

  async renderVideoBlob() {
    return new Promise(async (resolve, reject) => {
      try {
        const bar = document.getElementById('exportProgressBar');
        const pct = document.getElementById('exportPercentDisplay');
        const frameDisplay = document.getElementById('exportFrameDisplay');
        const miniCanvas = document.getElementById('exportMiniThumbCanvas');

        const onProgress = (p) => {
          if (bar) bar.style.width = `${p.percent}%`;
          if (pct) pct.textContent = `${p.percent}%`;
          if (frameDisplay) frameDisplay.textContent = `${p.currentFrame} / ${p.totalFrames}`;
        };
        const result = await this.app.exporter.exportFastSilent(this.app.state, onProgress, miniCanvas, false);
        resolve(result?.blob || result);
      } catch (err) {
        reject(err);
      }
    });
  }

  async downloadAllInZip() {
    this.app?.ui?.showToast('Building in-browser ZIP bundle...', 'info', 4000);
    const zip = new SimpleZip();

    try {
      // 1. Script
      const scriptText = this.app.state.scriptText ||
        (this.app.state.scriptLines || []).map((l) => l.text).join('\n') ||
        this.storyTextarea?.value ||
        document.getElementById('scriptTextarea')?.value ||
        '';
      await zip.addFile('script.txt', scriptText);

      // 2. Captions
      if (this.app.captionEngine?.chunks?.length > 0) {
        const srt = this.app.captionEngine.generateSRT(this.app.captionEngine.chunks);
        await zip.addFile('captions.srt', srt);
        const vtt = this.app.captionEngine.generateVTT(this.app.captionEngine.chunks);
        await zip.addFile('captions.vtt', vtt);
      }

      // 3. Thumbnails
      if (this.thumbnailMaker) {
        this.thumbnailMaker.setFormat('16:9');
        const thumbBlob169 = await this.thumbnailMaker.toBlob('image/png');
        if (thumbBlob169) await zip.addFile('thumbnail_16x9.png', thumbBlob169);

        this.thumbnailMaker.setFormat('9:16');
        const thumbBlob916 = await this.thumbnailMaker.toBlob('image/png');
        if (thumbBlob916) await zip.addFile('cover_9x16.png', thumbBlob916);
      }

      // 4. Metadata
      const meta = this.app.state.publishPack || this.app.youtubeGenerator?.cachedResults || {};
      const metaJson = JSON.stringify(meta, null, 2);
      await zip.addFile('metadata.json', metaJson);

      const yt = meta.youtube || {};
      const fb = meta.facebook || {};
      const metaTxt = `=== STORYFLOW STUDIO PUBLISH PACK ===
Generated: ${new Date().toLocaleString()}

-------------------------------------------------------
1. YOUTUBE VIDEO METADATA
-------------------------------------------------------
TITLES:
${(yt.titles || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}

DESCRIPTION:
${yt.description || ''}

HASHTAGS:
${(yt.hashtags || []).join(' ')}

TAGS:
${Array.isArray(yt.tags) ? yt.tags.join(', ') : yt.tags || ''}

PINNED COMMENT:
${yt.pinned_comment || ''}

-------------------------------------------------------
2. FACEBOOK VIDEO METADATA
-------------------------------------------------------
HEADLINES:
${(fb.headlines || []).map((h, i) => `${i + 1}. ${h}`).join('\n')}

POST:
${fb.post_text || fb.caption || ''}

VIDEO TITLE:
${fb.video_title || ''}

VIDEO DESCRIPTION:
${fb.video_description || ''}

HASHTAGS:
${(fb.hashtags || []).join(' ')}

FIRST COMMENT:
${fb.first_comment || ''}
`;
      await zip.addFile('publish_pack.txt', metaTxt);

      // 5. Project State
      const sanitizedProject = {
        version: '2.0',
        product: 'StoryFlow Studio',
        savedAt: new Date().toISOString(),
        script: scriptText,
        photosCount: (this.app.state.extractedFrames || []).length,
        settings: {
          currentStep: this.app.state.currentStep || 1,
          aspectRatio: this.app.state.aspectRatio || '16:9',
          timelineDuration: this.app.state.timelineDuration || 60
        }
      };
      await zip.addFile('project.json', JSON.stringify(sanitizedProject, null, 2));

      // 6. Videos if rendered
      if (this.cachedBlob169) {
        await zip.addFile('storyflow_16x9.mp4', this.cachedBlob169);
      }
      if (this.cachedBlob916) {
        await zip.addFile('storyflow_9x16.mp4', this.cachedBlob916);
      }

      // Trigger download
      const zipBlob = zip.generateBlob('application/zip');
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `storyflow_bundle_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      this.app?.ui?.showToast('🎉 Downloaded storyflow_bundle.zip!', 'success');
    } catch (e) {
      console.error('[Zip Error]', e);
      this.app?.ui?.showToast(`ZIP export failed: ${e.message}`, 'error');
    }
  }

  // =========================================================================
  // Settings & Projects Modal
  // =========================================================================

  bindSettingsEvents() {
    this.openSettingsBtn?.addEventListener('click', () => this.openSettingsModal());
    this.closeSettingsModalBtn?.addEventListener('click', () => this.closeSettingsModal());

    this.toggleGlobalKeyVisBtn?.addEventListener('click', () => {
      const isPwd = this.globalApiKeyInput?.type === 'password';
      if (this.globalApiKeyInput) {
        this.globalApiKeyInput.type = isPwd ? 'text' : 'password';
      }
      if (this.toggleGlobalKeyVisBtn) {
        this.toggleGlobalKeyVisBtn.textContent = isPwd ? '🙈' : '👁️';
      }
    });

    this.globalModelSelect?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'custom') {
        this.globalCustomModelGroup?.classList.remove('hidden');
      } else {
        this.globalCustomModelGroup?.classList.add('hidden');
        this.gemini.setModel(val);
      }
    });

    this.saveSettingsBtn?.addEventListener('click', () => {
      const key = (this.globalApiKeyInput?.value || '').trim();
      this.gemini.setApiKey(key);
      const model = this.globalModelSelect?.value === 'custom'
        ? (this.globalCustomModelInput?.value || '').trim()
        : this.globalModelSelect?.value;
      this.gemini.setModel(model);
      this.closeSettingsModal();
      this.app?.ui?.showToast('Saved Gemini API settings.', 'success');
    });
  }

  openSettingsModal() {
    if (!this.settingsModal) return;
    const key = this.gemini.getApiKey();
    if (this.globalApiKeyInput) this.globalApiKeyInput.value = key;
    this.settingsModal.classList.remove('hidden');
  }

  closeSettingsModal() {
    this.settingsModal?.classList.add('hidden');
  }

  bindProjectsEvents() {
    this.myProjectsBtn?.addEventListener('click', () => this.openProjectsModal());
    this.closeProjectsModalBtn?.addEventListener('click', () => this.projectsModal?.classList.add('hidden'));

    this.newProjectBtn?.addEventListener('click', () => {
      this.createNewProject();
      this.projectsModal?.classList.add('hidden');
    });

    this.confirmModalCancelBtn?.addEventListener('click', () => {
      this.confirmModal?.classList.add('hidden');
    });
  }

  async openProjectsModal() {
    if (!this.projectsModal) return;
    this.projectsModal.classList.remove('hidden');
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

      this.projectsListContainer.innerHTML = '';
      list.forEach((proj) => {
        const card = document.createElement('div');
        card.className = 'project-item-card';

        const info = document.createElement('div');
        info.className = 'project-info';
        const d = new Date(proj.updatedAt || Date.now());
        info.innerHTML = `
          <h5>${proj.name}</h5>
          <div class="project-meta-stats">
            <span>Updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>&middot;</span>
            <span>${proj.photoCount} photos</span>
            <span>&middot;</span>
            <span>${proj.scriptLineCount} lines</span>
          </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'project-actions';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn btn-xs btn-primary';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', async () => {
          await this.loadProjectById(proj.id);
          this.projectsModal?.classList.add('hidden');
        });

        const dupBtn = document.createElement('button');
        dupBtn.type = 'button';
        dupBtn.className = 'btn btn-xs btn-secondary';
        dupBtn.textContent = 'Duplicate';
        dupBtn.addEventListener('click', async () => {
          await ProjectStore.duplicateProject(proj.id);
          await this.renderProjectsList();
          this.app?.ui?.showToast('Project duplicated.', 'success');
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-xs btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
          this.showInPageConfirm(
            'Delete Project?',
            `Are you sure you want to permanently delete "${proj.name}"?`,
            async () => {
              await ProjectStore.deleteProject(proj.id);
              await this.renderProjectsList();
              this.app?.ui?.showToast('Project deleted.', 'info');
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
    if (!this.confirmModal) return;
    if (this.confirmModalTitle) this.confirmModalTitle.textContent = title;
    if (this.confirmModalMsg) this.confirmModalMsg.textContent = msg;

    const handleAction = async () => {
      this.confirmModalActionBtn?.removeEventListener('click', handleAction);
      this.confirmModal?.classList.add('hidden');
      await onConfirm();
    };

    this.confirmModalActionBtn?.addEventListener('click', handleAction);
    this.confirmModal.classList.remove('hidden');
  }

  // =========================================================================
  // IndexedDB Autosave & Project Serialization
  // =========================================================================

  startAutosaveLoop() {
    this.autosaveTimer = setInterval(() => {
      if (this.isDirty) {
        this.saveCurrentProject();
      }
    }, 5000);
  }

  markDirty() {
    this.isDirty = true;
    if (this.autosaveText) this.autosaveText.textContent = 'Unsaved changes...';
  }

  async markDirtyAndSave() {
    this.markDirty();
    await this.saveCurrentProject();
  }

  async saveCurrentProject() {
    try {
      if (this.autosaveText) this.autosaveText.textContent = 'Saving...';
      const scriptText = this.app.state.scriptText || document.getElementById('scriptTextarea')?.value || '';
      const projectData = {
        id: this.currentProjectId,
        name: this.getProjectName(),
        updatedAt: new Date().toISOString(),
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
          caption: f.caption || '',
          mood: f.mood || 'neutral'
        })),
        line_to_photo_assignment: this.app.state.sceneMatches || [],
        publish_pack: this.app.state.publishPack || this.app.youtubeGenerator?.cachedResults || {},
        settings: {
          currentStep: this.app.state.currentStep || 1,
          aspectRatio: this.app.state.aspectRatio || '16:9',
          timelineDuration: this.app.state.timelineDuration || 60
        }
      };

      await ProjectStore.saveProject(projectData);
      saveSetting('last_project_id', this.currentProjectId);
      this.isDirty = false;
      if (this.autosaveText) this.autosaveText.textContent = 'Saved ✓';
    } catch (e) {
      console.warn('[Autosave]', e);
      if (this.autosaveText) this.autosaveText.textContent = 'Autosave paused';
    }
  }

  getProjectName() {
    const script = this.app.state.scriptText || document.getElementById('scriptTextarea')?.value || '';
    const firstLine = script.split('\n')[0]?.trim().slice(0, 30);
    return firstLine ? `${firstLine}...` : 'Untitled Story';
  }

  async loadInitialProject() {
    const hasExistingPhotos = (this.app.state.extractedFrames || []).length > 0;
    const hasExistingScript = Boolean(this.app.state.scriptText || document.getElementById('scriptTextarea')?.value);

    const lastId = loadSetting('last_project_id', null);
    if (lastId) {
      const proj = await ProjectStore.loadProject(lastId);
      if (proj) {
        this.currentProjectId = proj.id;
        // Do not overwrite user's photos or script if already present
        if (!hasExistingPhotos && proj.photo_records && proj.photo_records.length > 0) {
          this.app.state.extractedFrames = proj.photo_records.map(p => ({
            ...p,
            previewUrl: p.dataUrl || p.previewUrl
          }));
          this.app.refreshGallery();
        }
        if (!hasExistingScript && (proj.script || proj.story)) {
          const text = proj.script || proj.story || '';
          this.app.state.scriptText = text;
          const ta = document.getElementById('scriptTextarea');
          if (ta) ta.value = text;
          this.app.handleScriptChange?.(text);
        }
        if (proj.publish_pack) {
          this.app.state.publishPack = proj.publish_pack;
        }
        return;
      }
    }
  }

  async loadProjectById(id) {
    const proj = await ProjectStore.loadProject(id);
    if (proj) {
      this.currentProjectId = proj.id;
      this.restoreProject(proj);
      this.app?.ui?.showToast(`Loaded "${proj.name}"`, 'success');
    }
  }

  restoreProject(proj) {
    if (!proj) return;
    this.currentProjectId = proj.id;

    const scriptText = proj.script || proj.story || '';
    if (scriptText) {
      this.app.state.scriptText = scriptText;
      const ta = document.getElementById('scriptTextarea');
      if (ta) ta.value = scriptText;
      this.app.handleScriptChange?.(scriptText);
    }
    if (this.storyTextarea) {
      this.storyTextarea.value = scriptText;
      this.updateStoryStats();
    }

    if (proj.script_lines) {
      this.app.state.scriptLines = proj.script_lines.map((text, idx) => ({
        text,
        scene_tags: ['history', 'scene'],
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
      this.app.state.extractedFrames = proj.photo_records.map(p => ({
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

    const step = proj.settings?.currentStep || 1;
    if (step >= 1 && step <= 4) {
      this.app.goToStep(step);
    }
  }

  createNewProject() {
    this.currentProjectId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    saveSetting('last_project_id', this.currentProjectId);

    this.app.clearAllExtractedFrames();
    const ta = document.getElementById('scriptTextarea');
    if (ta) ta.value = '';
    this.app.state.scriptText = '';
    this.app.handleScriptChange?.('');

    if (this.storyTextarea) {
      this.storyTextarea.value = '';
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
    this.app?.ui?.showToast('Started new project.', 'info');
    this.markDirtyAndSave();
  }
}
