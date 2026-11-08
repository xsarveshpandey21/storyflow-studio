/**
 * FrameFlow Studio — Step 4: Publish Portal (YouTube & Facebook Metadata Generator)
 * Server-backed via POST /api/generate-meta with GEMINI_API_KEY managed safely in .env.
 * 
 * Features:
 * - Server key proxy: checks GET /api/config; shows setup banner if key is missing.
 * - Read-only "Script used" summary with word count, first 2 lines, and "Edit script" link to Step 2.
 * - Settings row: Language, Tone, Video Type, Niche, Target Audience, and Platform Toggle.
 * - Big "Generate with Gemini" button with loading skeleton & "Regenerate" button.
 * - YouTube Tab:
 *   • 5 curiosity-driven titles (<=70 chars) with radio selection & live counter
 *   • Hook-optimized description (<=5000 chars) with live counter (2-line hook + summary + CTA + 3-5 hashtags)
 *   • Editable hashtag chips (8-12 tags, #Shorts support, space-separated copy)
 *   • Keyword tags (<=450 chars total) with live counter
 *   • Pinned comment for algorithm engagement
 *   • Individual Copy buttons with "Copied ✓" feedback, Copy All, Download .txt, and "Open YouTube Studio"
 * - Facebook Tab:
 *   • 3 caption/headline options (<=100 chars)
 *   • Post text with first-line hook (~125 chars before 'See more'), 2-4 lines/emojis, CTA, 3-5 hashtags
 *   • Video title and description fields for Reels/video uploads
 *   • Editable hashtag chips (5-8 tags) with Copy
 *   • Individual Copy buttons, Copy All, Download .txt, and links to Facebook Composer & Reels
 * - Script alignment & keyword match badge ("Keyword match 8/10").
 * - Script change detection banner ("Script changed - regenerate?").
 * - Persistence in project JSON under settings.publishMeta.
 */

import { exportProjectJson } from './storage.js';

/**
 * Calculates keyword overlap between script and generated metadata
 */
export function calculateKeywordMatch(script, generatedData) {
  if (!script || !generatedData) {
    return { matched: 0, total: 10, percent: 0, badgeText: 'Keyword match 0/10' };
  }

  const words = script
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'have', 'were', 'they', 'will', 'your', 'their', 'about',
    'करते', 'करती', 'किया', 'जाते', 'होते', 'होती', 'लेकिन', 'सकते', 'सकती', 'क्योंकि', 'जिसमें', 'जिसके', 'उनकी', 'उनके', 'उसका', 'उसकी', 'हमारे', 'अपनी', 'अपने'
  ]);

  const freq = {};
  for (const w of words) {
    if (!stopWords.has(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }

  const topKeywords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);

  if (topKeywords.length === 0) {
    return { matched: 10, total: 10, percent: 100, badgeText: 'Keyword match 10/10' };
  }

  const yt = generatedData.youtube || {};
  const fb = generatedData.facebook || {};
  const combinedGenerated = [
    ...(yt.titles || []),
    yt.description || '',
    ...(yt.hashtags || []),
    ...(yt.tags || []),
    yt.pinned_comment || yt.pinnedComment || '',
    ...(fb.headlines || []),
    fb.post_text || '',
    fb.video_title || '',
    fb.video_description || '',
    ...(fb.hashtags || []),
    fb.first_comment || ''
  ].join(' ').toLowerCase();

  let matched = 0;
  for (const kw of topKeywords) {
    if (combinedGenerated.includes(kw)) {
      matched++;
    }
  }

  const total = topKeywords.length;
  const percent = Math.round((matched / total) * 100);
  return {
    matched,
    total,
    percent,
    badgeText: `Keyword match ${matched}/${total}`
  };
}

export const TRENDING_TAGS_YT = [
  '#Trending', '#Viral', '#FYP', '#Shorts', '#ViralVideo',
  '#Explore', '#MustWatch', '#TrendingNow', '#ForYou', '#YouTubeShorts',
  '#ViralShorts', '#DailyShorts', '#ExplorePage', '#Creator', '#StoryTime',
  '#ShortsViral', '#WatchNow', '#TrendingTopic', '#NewVideo', '#Entertainment',
  '#TopTrending', '#VideoOfTheDay'
];

export const TRENDING_TAGS_FB = [
  '#Trending', '#Viral', '#Reels', '#FYP', '#ViralPost',
  '#Explore', '#FacebookReels', '#ViralReels', '#TrendingReels', '#ForYouPage',
  '#MustWatch', '#DailyReels', '#TrendingNow', '#WatchThis', '#ReelsViral',
  '#ViralVideo', '#ReelItFeelIt', '#Shorts', '#VideoOfTheDay', '#TopTrend',
  '#TrendingPost', '#Creators'
];

export class YouTubeMetaGenerator {
  constructor(app) {
    this.app = app;
    this.geminiConfigured = false;
    this.currentData = null;
    this.selectedTitleIndex = 0;
    this.selectedHeadlineIndex = 0;
    this.ytHashtagsList = [];
    this.fbHashtagsList = [];
    this.isLoading = false;
    this.activeTab = 'youtube'; // 'youtube' | 'facebook'
    this.generatedForScriptText = '';
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
    // Top Banners & Script Summary
    this.geminiMissingBanner = document.getElementById('geminiMissingBanner');
    this.scriptEmptyWarning = document.getElementById('portalScriptEmptyWarning');
    this.scriptChangedBanner = document.getElementById('portalScriptChangedBanner');
    this.scriptChangedRegenBtn = document.getElementById('portalScriptChangedRegenBtn');
    this.keywordMatchBadge = document.getElementById('portalKeywordMatchBadge');

    this.scriptWordCountDisplay = document.getElementById('portalScriptWordCount');
    this.scriptSnippetDisplay = document.getElementById('portalScriptSnippet');
    this.editScriptLink = document.getElementById('portalEditScriptLink');

    // Settings Row
    this.langSelect = document.getElementById('portalLangSelect') || document.getElementById('ytLangSelect');
    this.toneSelect = document.getElementById('portalToneSelect') || document.getElementById('ytToneSelect');
    this.videoTypeSelect = document.getElementById('portalVideoTypeSelect') || document.getElementById('ytVideoTypeSelect');
    this.nicheInput = document.getElementById('portalNicheInput') || document.getElementById('ytNicheInput');
    this.audienceInput = document.getElementById('portalAudienceInput') || document.getElementById('ytAudienceInput');
    this.platformToggle = document.getElementById('portalPlatformSelect');

    // Action Buttons
    this.generateBtn = document.getElementById('portalGenerateBtn') || document.getElementById('ytGenerateBtn');
    this.regenerateBtn = document.getElementById('portalRegenerateBtn') || document.getElementById('ytRegenerateBtn');
    this.skeletonLoader = document.getElementById('portalSkeletonLoader');
    this.resultsContainer = document.getElementById('portalResultsContainer') || document.getElementById('ytResultsContainer');

    // Platform Tabs
    this.tabYtBtn = document.getElementById('portalTabYtBtn') || document.getElementById('publishTabYtBtn');
    this.tabFbBtn = document.getElementById('portalTabFbBtn') || document.getElementById('publishTabFbBtn');
    this.panelYt = document.getElementById('portalPanelYt') || document.getElementById('publishPanelYt');
    this.panelFb = document.getElementById('portalPanelFb') || document.getElementById('publishPanelFb');

    // YouTube Fields
    this.ytTitlesList = document.getElementById('ytTitlesList');
    this.descInput = document.getElementById('ytDescInput');
    this.descCounter = document.getElementById('ytDescCounter');
    this.ytHashtagsContainer = document.getElementById('ytHashtagsContainer');
    this.ytAddHashtagInput = document.getElementById('ytAddHashtagInput');
    this.ytAddHashtagBtn = document.getElementById('ytAddHashtagBtn');
    this.ytAddTrendingBtn = document.getElementById('ytAddTrendingBtn');
    this.tagsInput = document.getElementById('ytTagsInput');
    this.tagsCounter = document.getElementById('ytTagsCounter');
    this.pinnedCommentInput = document.getElementById('ytPinnedCommentInput');

    // YouTube Copy & Download Buttons
    this.copyTitleBtn = document.getElementById('ytCopyTitleBtn');
    this.copyDescBtn = document.getElementById('ytCopyDescBtn');
    this.ytFormatDescBtn = document.getElementById('ytFormatDescBtn');
    this.copyHashtagsBtn = document.getElementById('ytCopyHashtagsBtn');
    this.copyTagsBtn = document.getElementById('ytCopyTagsBtn');
    this.copyPinnedBtn = document.getElementById('ytCopyPinnedBtn');
    this.copyAllYtBtn = document.getElementById('ytCopyAllBtn');
    this.downloadYtTxtBtn = document.getElementById('ytDownloadTxtBtn');
    this.openYtStudioBtn = document.getElementById('openYtStudioBtn');

    // Facebook Fields
    this.fbHeadlinesList = document.getElementById('fbHeadlinesList');
    this.fbPostInput = document.getElementById('fbPostInput') || document.getElementById('fbCaptionInput');
    this.fbPostCounter = document.getElementById('fbPostCounter');
    this.fbVideoTitleInput = document.getElementById('fbVideoTitleInput');
    this.fbVideoDescInput = document.getElementById('fbVideoDescInput');
    this.fbHashtagsContainer = document.getElementById('fbHashtagsContainer');
    this.fbAddHashtagInput = document.getElementById('fbAddHashtagInput');
    this.fbAddHashtagBtn = document.getElementById('fbAddHashtagBtn');
    this.fbAddTrendingBtn = document.getElementById('fbAddTrendingBtn');
    this.fbCommentInput = document.getElementById('fbFirstCommentInput');

    // Facebook Copy & Download Buttons
    this.copyFbHeadlineBtn = document.getElementById('copyFbHeadlineBtn');
    this.copyFbPostBtn = document.getElementById('copyFbPostBtn') || document.getElementById('copyFbCaptionBtn');
    this.fbFormatPostBtn = document.getElementById('fbFormatPostBtn');
    this.copyFbTitleBtn = document.getElementById('copyFbTitleBtn');
    this.copyFbDescBtn = document.getElementById('copyFbDescBtn');
    this.copyFbHashtagsBtn = document.getElementById('copyFbHashtagsBtn');
    this.copyFbCommentBtn = document.getElementById('copyFbCommentBtn');
    this.copyAllFbBtn = document.getElementById('copyAllFbBtn');
    this.downloadFbTxtBtn = document.getElementById('downloadFbTxtBtn');
    this.openFbComposerBtn = document.getElementById('openFbComposerBtn');
    this.openFbReelsBtn = document.getElementById('openFbReelsBtn');

    // Navigation buttons
    this.backToStep3Btn = document.getElementById('backToStep3Btn');
  }

  async checkBackendConfig() {
    try {
      const res = await fetch('/api/config');
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
      this.geminiMissingBanner.classList.toggle('hidden', this.geminiConfigured);
    }
  }

  bindEvents() {
    // Edit script link navigates to Step 2
    this.editScriptLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.app?.goToStep(2);
    });

    // Navigation
    this.backToStep3Btn?.addEventListener('click', () => {
      this.app?.goToStep(3);
    });

    // Tab Switchers
    this.tabYtBtn?.addEventListener('click', () => this.switchTab('youtube'));
    this.tabFbBtn?.addEventListener('click', () => this.switchTab('facebook'));

    // Generation triggers
    this.generateBtn?.addEventListener('click', () => this.generate());
    this.regenerateBtn?.addEventListener('click', () => this.generate());
    this.scriptChangedRegenBtn?.addEventListener('click', () => this.generate());

    // Character counters
    this.descInput?.addEventListener('input', () => this.updateCounters());
    this.tagsInput?.addEventListener('input', () => this.updateCounters());
    this.fbPostInput?.addEventListener('input', () => this.updateCounters());

    // Hashtags addition
    this.ytAddHashtagBtn?.addEventListener('click', () => this.addCustomYtHashtag());
    this.ytAddTrendingBtn?.addEventListener('click', () => this.addTrendingPack('yt'));
    this.ytAddHashtagInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addCustomYtHashtag();
      }
    });

    this.fbAddHashtagBtn?.addEventListener('click', () => this.addCustomFbHashtag());
    this.fbAddTrendingBtn?.addEventListener('click', () => this.addTrendingPack('fb'));
    this.fbAddHashtagInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addCustomFbHashtag();
      }
    });

    // YouTube Copy handlers
    this.copyTitleBtn?.addEventListener('click', () => this.copySelectedTitle());
    this.copyDescBtn?.addEventListener('click', () => this.copyToClipboard(this.descInput?.value || '', 'YouTube Description'));
    this.ytFormatDescBtn?.addEventListener('click', () => this.autoFormatYouTubeDescription());
    this.copyHashtagsBtn?.addEventListener('click', () => this.copyToClipboard(this.ytHashtagsList.join(' '), 'YouTube Hashtags'));
    this.copyTagsBtn?.addEventListener('click', () => this.copyToClipboard(this.tagsInput?.value || '', 'YouTube Keyword Tags'));
    this.copyPinnedBtn?.addEventListener('click', () => this.copyToClipboard(this.pinnedCommentInput?.value || '', 'Pinned Comment'));
    this.copyAllYtBtn?.addEventListener('click', () => this.copyAllYouTube());
    this.downloadYtTxtBtn?.addEventListener('click', () => this.downloadYouTubeTxt());
    this.openYtStudioBtn?.addEventListener('click', () => {
      window.open('https://studio.youtube.com', '_blank', 'noopener,noreferrer');
    });

    // Facebook Copy handlers
    this.copyFbHeadlineBtn?.addEventListener('click', () => this.copySelectedHeadline());
    this.copyFbPostBtn?.addEventListener('click', () => this.copyToClipboard(this.fbPostInput?.value || '', 'Facebook Post'));
    this.fbFormatPostBtn?.addEventListener('click', () => this.autoFormatFacebookPost());
    this.copyFbTitleBtn?.addEventListener('click', () => this.copyToClipboard(this.fbVideoTitleInput?.value || '', 'Facebook Video Title'));
    this.copyFbDescBtn?.addEventListener('click', () => this.copyToClipboard(this.fbVideoDescInput?.value || '', 'Facebook Video Description'));
    this.copyFbHashtagsBtn?.addEventListener('click', () => this.copyToClipboard(this.fbHashtagsList.join(' '), 'Facebook Hashtags'));
    this.copyFbCommentBtn?.addEventListener('click', () => this.copyToClipboard(this.fbCommentInput?.value || '', 'Facebook First Comment'));
    this.copyAllFbBtn?.addEventListener('click', () => this.copyAllFacebook());
    this.downloadFbTxtBtn?.addEventListener('click', () => this.downloadFacebookTxt());
    this.openFbComposerBtn?.addEventListener('click', () => {
      window.open('https://www.facebook.com', '_blank', 'noopener,noreferrer');
    });
    this.openFbReelsBtn?.addEventListener('click', () => {
      window.open('https://business.facebook.com/creatorstudio', '_blank', 'noopener,noreferrer');
    });
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    if (tabName === 'youtube') {
      this.tabYtBtn?.classList.add('active');
      this.tabFbBtn?.classList.remove('active');
      this.panelYt?.classList.remove('hidden');
      this.panelFb?.classList.add('hidden');
    } else {
      this.tabFbBtn?.classList.add('active');
      this.tabYtBtn?.classList.remove('active');
      this.panelFb?.classList.remove('hidden');
      this.panelYt?.classList.add('hidden');
    }
  }

  updateScriptSummary() {
    const script = this.getSourceText();
    const words = script ? script.trim().split(/\s+/).filter(Boolean).length : 0;

    if (this.scriptWordCountDisplay) {
      this.scriptWordCountDisplay.textContent = `${words} words`;
    }

    if (this.scriptSnippetDisplay) {
      if (script) {
        const lines = script.trim().split('\n').filter((l) => l.trim().length > 0);
        const snippet = lines.slice(0, 2).join(' / ');
        this.scriptSnippetDisplay.textContent = snippet.length > 140 ? `${snippet.slice(0, 140)}...` : snippet;
      } else {
        this.scriptSnippetDisplay.textContent = 'No script added yet.';
      }
    }

    const isEmpty = words === 0;
    if (this.scriptEmptyWarning) {
      this.scriptEmptyWarning.classList.toggle('hidden', !isEmpty);
    }
    if (this.generateBtn) {
      this.generateBtn.disabled = isEmpty || this.isLoading;
    }

    // Check script changed notice
    if (this.currentData && this.generatedForScriptText && script !== this.generatedForScriptText) {
      this.scriptChangedBanner?.classList.remove('hidden');
    } else {
      this.scriptChangedBanner?.classList.add('hidden');
    }
  }

  getSourceText() {
    const script = (this.app?.state?.scriptText || '').trim();
    if (script) return script;

    const textarea = document.getElementById('scriptTextarea');
    if (textarea && textarea.value.trim()) return textarea.value.trim();

    const storyTextarea = document.getElementById('storyTextarea');
    if (storyTextarea && storyTextarea.value.trim()) return storyTextarea.value.trim();

    const chunksText = (this.app?.captionEngine?.chunks || [])
      .map((c) => (c.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    return chunksText || '';
  }

  detectLanguageFromScript(text) {
    if (!text) return 'Hindi';
    const hasDevanagari = /[\u0900-\u097F]/.test(text);
    if (hasDevanagari) return 'Hindi';
    // Hinglish keywords heuristic
    const lower = text.toLowerCase();
    const hinglishMatches = (lower.match(/\b(hai|ki|ke|ka|ko|se|mein|aur|nahi|tha|thi|the|kuch|bhi|yeh|woh|raha|rahi|aaj)\b/g) || []).length;
    if (hinglishMatches >= 3) return 'Hinglish';
    return 'English';
  }

  async generate() {
    const sourceText = this.getSourceText();
    if (!sourceText) {
      this.app?.ui?.showToast('Please add your script in Step 2 first.', 'error');
      this.updateScriptSummary();
      return;
    }

    if (!navigator.onLine) {
      this.app?.ui?.showToast('You appear to be offline. Check your internet connection.', 'error');
      return;
    }

    await this.checkBackendConfig();
    if (!this.geminiConfigured) {
      this.app?.ui?.showToast('GEMINI_API_KEY is not configured in .env on the server.', 'error', 6000);
      this.geminiMissingBanner?.classList.remove('hidden');
      return;
    }

    this.setLoading(true);

    let language = this.langSelect?.value || 'Hindi';
    if (language === 'auto' || language === 'Auto-detect') {
      language = this.detectLanguageFromScript(sourceText);
    }
    const tone = this.toneSelect?.value || 'Curious';
    const videoType = this.videoTypeSelect?.value || 'Shorts';
    const niche = (this.nicheInput?.value || '').trim();
    const audience = (this.audienceInput?.value || '').trim();
    const platforms = this.platformToggle?.value || 'both';

    try {
      const res = await fetch('/api/generate-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      this.scriptChangedBanner?.classList.add('hidden');

      // Process and structure result
      const ytData = data.youtube || {};
      const fbData = data.facebook || {};

      this.currentData = {
        youtube: {
          titles: Array.isArray(ytData.titles) ? ytData.titles.slice(0, 5) : [],
          description: (ytData.description || '').trim(),
          hashtags: Array.isArray(ytData.hashtags)
            ? ytData.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`).replace(/\s+/g, ''))
            : [],
          tags: Array.isArray(ytData.tags)
            ? ytData.tags
            : typeof ytData.tags === 'string'
            ? ytData.tags.split(',').map((t) => t.trim()).filter(Boolean)
            : [],
          pinned_comment: (ytData.pinned_comment || ytData.pinnedComment || '').trim()
        },
        facebook: {
          headlines: Array.isArray(fbData.headlines) ? fbData.headlines.slice(0, 3) : [],
          post_text: (fbData.post_text || fbData.postText || fbData.caption || '').trim(),
          video_title: (fbData.video_title || fbData.videoTitle || '').trim(),
          video_description: (fbData.video_description || fbData.videoDescription || '').trim(),
          hashtags: Array.isArray(fbData.hashtags)
            ? fbData.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`).replace(/\s+/g, ''))
            : [],
          first_comment: (fbData.first_comment || fbData.firstComment || '').trim()
        },
        generatedAt: new Date().toISOString(),
        settings: { language, tone, videoType, niche, audience, platforms }
      };

      if (this.app?.state) {
        this.app.state.publishMeta = this.currentData;
        this.app.state.youtubeMeta = this.currentData.youtube;
        if (!this.app.state.publishPack) this.app.state.publishPack = {};
        this.app.state.publishPack.youtube = this.currentData.youtube;
        this.app.state.publishPack.facebook = {
          caption: this.currentData.facebook.post_text,
          hook_line: this.currentData.facebook.headlines[0] || '',
          hashtags: this.currentData.facebook.hashtags,
          first_comment: this.currentData.facebook.first_comment
        };
      }

      this.renderResults(this.currentData);
      this.app?.ui?.showToast('✨ Publish Portal metadata generated successfully!', 'success');
    } catch (err) {
      console.error('[PublishPortal Error]', err);
      this.app?.ui?.showToast(`Metadata generation failed: ${err.message}`, 'error', 6000);
    } finally {
      this.setLoading(false);
      this.updateScriptSummary();
    }
  }

  renderResults(data) {
    if (!data) return;
    this.currentData = data;
    this.resultsContainer?.classList.remove('hidden');

    const yt = data.youtube || {};
    const fb = data.facebook || {};

    // 1. YouTube Titles
    if (this.ytTitlesList && Array.isArray(yt.titles)) {
      this.ytTitlesList.innerHTML = '';
      this.selectedTitleIndex = 0;

      yt.titles.forEach((title, idx) => {
        const item = document.createElement('div');
        item.className = `yt-title-card yt-title-row ${idx === 0 ? 'selected' : ''}`;

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'portalYtTitleRadio';
        radio.id = `portalYtTitleRadio_${idx}`;
        radio.checked = (idx === 0);

        const content = document.createElement('div');
        content.className = 'yt-title-content';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'form-input form-input-sm yt-title-input';
        textInput.value = title;
        textInput.maxLength = 120;

        const countBadge = document.createElement('span');
        countBadge.className = 'yt-char-badge';
        countBadge.textContent = `${title.length}/70`;
        if (title.length > 70) countBadge.classList.add('over-limit');

        textInput.addEventListener('input', (e) => {
          const val = e.target.value;
          countBadge.textContent = `${val.length}/70`;
          countBadge.classList.toggle('over-limit', val.length > 70);
          if (this.currentData?.youtube?.titles) {
            this.currentData.youtube.titles[idx] = val;
          }
        });

        const selectThis = () => {
          radio.checked = true;
          this.selectedTitleIndex = idx;
          this.ytTitlesList?.querySelectorAll('.yt-title-card').forEach((c) => c.classList.remove('selected'));
          item.classList.add('selected');
        };

        radio.addEventListener('change', selectThis);
        item.addEventListener('click', (e) => {
          if (e.target !== textInput) selectThis();
        });

        content.appendChild(textInput);
        content.appendChild(countBadge);

        item.appendChild(radio);
        item.appendChild(content);
        this.ytTitlesList.appendChild(item);
      });
    }

    // 2. YouTube Description
    if (this.descInput) {
      this.descInput.value = yt.description || '';
    }

    // 3. YouTube Hashtags
    this.ytHashtagsList = [...(yt.hashtags || [])];
    this.renderYtHashtagChips();

    // 4. YouTube Tags
    if (this.tagsInput) {
      this.tagsInput.value = Array.isArray(yt.tags) ? yt.tags.join(', ') : (yt.tags || '');
    }

    // 5. YouTube Pinned Comment
    if (this.pinnedCommentInput) {
      this.pinnedCommentInput.value = yt.pinned_comment || yt.pinnedComment || '';
    }

    // 6. Facebook Headlines
    if (this.fbHeadlinesList && Array.isArray(fb.headlines)) {
      this.fbHeadlinesList.innerHTML = '';
      this.selectedHeadlineIndex = 0;

      fb.headlines.forEach((hl, idx) => {
        const item = document.createElement('div');
        item.className = `yt-title-card fb-headline-row ${idx === 0 ? 'selected' : ''}`;

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'portalFbHeadlineRadio';
        radio.id = `portalFbHeadlineRadio_${idx}`;
        radio.checked = (idx === 0);

        const content = document.createElement('div');
        content.className = 'yt-title-content';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'form-input form-input-sm fb-headline-input';
        textInput.value = hl;
        textInput.maxLength = 150;

        const countBadge = document.createElement('span');
        countBadge.className = 'yt-char-badge';
        countBadge.textContent = `${hl.length}/100`;
        if (hl.length > 100) countBadge.classList.add('over-limit');

        textInput.addEventListener('input', (e) => {
          const val = e.target.value;
          countBadge.textContent = `${val.length}/100`;
          countBadge.classList.toggle('over-limit', val.length > 100);
          if (this.currentData?.facebook?.headlines) {
            this.currentData.facebook.headlines[idx] = val;
          }
        });

        const selectThis = () => {
          radio.checked = true;
          this.selectedHeadlineIndex = idx;
          this.fbHeadlinesList?.querySelectorAll('.yt-title-card').forEach((c) => c.classList.remove('selected'));
          item.classList.add('selected');
        };

        radio.addEventListener('change', selectThis);
        item.addEventListener('click', (e) => {
          if (e.target !== textInput) selectThis();
        });

        content.appendChild(textInput);
        content.appendChild(countBadge);

        item.appendChild(radio);
        item.appendChild(content);
        this.fbHeadlinesList.appendChild(item);
      });
    }

    // 7. Facebook Post Text
    if (this.fbPostInput) {
      this.fbPostInput.value = fb.post_text || fb.postText || fb.caption || '';
    }

    // 8. Facebook Video Title & Description
    if (this.fbVideoTitleInput) {
      this.fbVideoTitleInput.value = fb.video_title || fb.videoTitle || '';
    }
    if (this.fbVideoDescInput) {
      this.fbVideoDescInput.value = fb.video_description || fb.videoDescription || '';
    }

    // 9. Facebook Hashtags
    this.fbHashtagsList = [...(fb.hashtags || [])];
    this.renderFbHashtagChips();

    // 10. Facebook Comment
    if (this.fbCommentInput) {
      this.fbCommentInput.value = fb.first_comment || fb.firstComment || '';
    }

    this.updateCounters();
    this.updateKeywordMatchBadge();
  }

  renderYtHashtagChips() {
    if (!this.ytHashtagsContainer) return;
    this.ytHashtagsContainer.innerHTML = '';

    this.ytHashtagsList.forEach((tag, idx) => {
      const chip = document.createElement('span');
      chip.className = 'yt-hashtag-chip';
      chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove" title="Remove">&times;</button>`;
      chip.querySelector('.yt-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        this.ytHashtagsList.splice(idx, 1);
        if (this.currentData?.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
        this.renderYtHashtagChips();
      });
      this.ytHashtagsContainer.appendChild(chip);
    });
  }

  addCustomYtHashtag() {
    if (!this.ytAddHashtagInput) return;
    let val = this.ytAddHashtagInput.value.trim().replace(/\s+/g, '');
    if (!val) return;
    if (!val.startsWith('#')) val = `#${val}`;

    if (!this.ytHashtagsList.includes(val)) {
      this.ytHashtagsList.push(val);
      if (this.currentData?.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
      this.renderYtHashtagChips();
    }
    this.ytAddHashtagInput.value = '';
  }

  renderFbHashtagChips() {
    if (!this.fbHashtagsContainer) return;
    this.fbHashtagsContainer.innerHTML = '';

    this.fbHashtagsList.forEach((tag, idx) => {
      const chip = document.createElement('span');
      chip.className = 'yt-hashtag-chip';
      chip.innerHTML = `<span>${tag}</span><button type="button" class="yt-chip-remove" title="Remove">&times;</button>`;
      chip.querySelector('.yt-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        this.fbHashtagsList.splice(idx, 1);
        if (this.currentData?.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
        this.renderFbHashtagChips();
      });
      this.fbHashtagsContainer.appendChild(chip);
    });
  }

  addCustomFbHashtag() {
    if (!this.fbAddHashtagInput) return;
    let val = this.fbAddHashtagInput.value.trim().replace(/\s+/g, '');
    if (!val) return;
    if (!val.startsWith('#')) val = `#${val}`;

    if (!this.fbHashtagsList.includes(val)) {
      this.fbHashtagsList.push(val);
      if (this.currentData?.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
      this.renderFbHashtagChips();
    }
    this.fbAddHashtagInput.value = '';
  }

  addTrendingPack(type = 'yt') {
    const list = type === 'yt' ? this.ytHashtagsList : this.fbHashtagsList;
    const defaults = type === 'yt' ? TRENDING_TAGS_YT : TRENDING_TAGS_FB;
    let added = 0;
    defaults.forEach((tag) => {
      if (!list.includes(tag)) {
        list.push(tag);
        added++;
      }
    });
    if (type === 'yt') {
      if (this.currentData?.youtube) this.currentData.youtube.hashtags = [...this.ytHashtagsList];
      this.renderYtHashtagChips();
      this.showToast(`🔥 Added ${added} trending tags! Total: ${this.ytHashtagsList.length}`, 'success');
    } else {
      if (this.currentData?.facebook) this.currentData.facebook.hashtags = [...this.fbHashtagsList];
      this.renderFbHashtagChips();
      this.showToast(`🔥 Added ${added} trending tags! Total: ${this.fbHashtagsList.length}`, 'success');
    }
  }

  autoFormatYouTubeDescription() {
    if (!this.descInput) return;
    const current = this.descInput.value.trim();
    if (!current) {
      this.showToast('Please generate or enter a description first.', 'warning');
      return;
    }

    const script = (this.app?.state?.scriptText || '').trim();
    const hasHindi = /[\u0900-\u097F]/.test(current || script);
    const tags = this.ytHashtagsList.slice(0, 10).join(' ') || '#Trending #Viral #Shorts';

    // Parse existing lines
    const paragraphs = current.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const hook = paragraphs[0] || (hasHindi ? '📌 इस वीडियो में जानिए पूरी दास्तान...' : '📌 In this video, discover the full story...');
    const body = paragraphs.slice(1).filter((p) => !p.startsWith('#') && !p.includes('Subscribe')).join('\n\n') || current;

    const formatted = hasHindi
? `${hook}

📖 कहानी के बारे में (About This Video):
${body}

✨ मुख्य बिंदु (Key Highlights):
🔹 दास्तान की अनसुनी सच्चाई
🔹 ऐतिहासिक और भावनात्मक पल
🔹 सीख और गहरा संदेश

⏱️ महत्वपूर्ण अध्याय (Timestamps):
00:00 - प्रस्तावना (Introduction)
00:30 - कहानी का मोड़ (Turning Point)
01:00 - अंतिम निष्कर्ष (Conclusion)

🔔 जुड़ें और समर्थन करें (Join & Support):
अगर आपको यह वीडियो पसंद आया तो कृपया LIKE 👍, SHARE 📲 और SUBSCRIBE 🔔 करें!
💬 आपकी इस कहानी पर क्या राय है? कमेंट में ज़रूर बताएं!

${tags}`
: `${hook}

📖 About This Video:
${body}

✨ Key Highlights:
🔹 Untold facts & key moments
🔹 Emotional journey & insights
🔹 Lessons & takeaways

⏱️ Chapters:
00:00 - Introduction
00:30 - The Story Unfolds
01:00 - Conclusion & Summary

🔔 Connect & Support:
If you enjoyed this video, please LIKE 👍, SHARE 📲, and SUBSCRIBE 🔔 for more!
💬 What do you think about this story? Let us know in the comments below!

${tags}`;

    this.descInput.value = formatted;
    if (this.currentData?.youtube) {
      this.currentData.youtube.description = formatted;
    }
    this.updateCounters();
    this.showToast('✨ Formatted description applied!', 'success');
  }

  autoFormatFacebookPost() {
    if (!this.fbPostInput) return;
    const current = this.fbPostInput.value.trim();
    if (!current) {
      this.showToast('Please generate or enter Facebook post text first.', 'warning');
      return;
    }

    const script = (this.app?.state?.scriptText || '').trim();
    const hasHindi = /[\u0900-\u097F]/.test(current || script);
    const tags = this.fbHashtagsList.slice(0, 8).join(' ') || '#Trending #Viral #Reels';

    const paragraphs = current.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const hook = paragraphs[0] || (hasHindi ? '🎯 एक ऐसी कहानी जो दिल छू ले...' : '🎯 A story that will touch your heart...');
    const body = paragraphs.slice(1).filter((p) => !p.startsWith('#')).join('\n\n') || current;

    const formatted = hasHindi
? `${hook}

📜 पूरी दास्तान:
${body}

💡 मुख्य सीख:
👉 हर कहानी हमें कुछ नया सिखाती है।
👉 अपने विचार कमेंट में साझा करें!

📢 शेयर करें और फॉलो करना न भूलें! 📲

${tags}`
: `${hook}

📜 The Story:
${body}

💡 Key Insight:
👉 Every story leaves an impact.
👉 What are your thoughts? Share below!

📢 Share this reel and follow for more! 📲

${tags}`;

    this.fbPostInput.value = formatted;
    if (this.currentData?.facebook) {
      this.currentData.facebook.post_text = formatted;
    }
    this.updateCounters();
    this.showToast('✨ Formatted Facebook post applied!', 'success');
  }

  updateCounters() {
    if (this.descInput && this.descCounter) {
      const len = this.descInput.value.length;
      this.descCounter.textContent = `${len} / 5000 characters`;
      this.descCounter.classList.toggle('over-limit', len > 5000);
    }

    if (this.tagsInput && this.tagsCounter) {
      const len = this.tagsInput.value.length;
      this.tagsCounter.textContent = `${len} / 450 characters`;
      this.tagsCounter.classList.toggle('over-limit', len > 450);
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
    this.keywordMatchBadge.textContent = `🎯 ${match.badgeText} (${match.percent}% match)`;
    this.keywordMatchBadge.classList.remove('hidden');
    if (match.percent >= 70) {
      this.keywordMatchBadge.className = 'badge badge-success';
    } else {
      this.keywordMatchBadge.className = 'badge badge-accent';
    }
  }

  getSelectedTitle() {
    if (!this.ytTitlesList) return '';
    const selectedInput = this.ytTitlesList.querySelector('.yt-title-card.selected .yt-title-input');
    if (selectedInput) return selectedInput.value.trim();
    const firstInput = this.ytTitlesList.querySelector('.yt-title-input');
    return firstInput ? firstInput.value.trim() : '';
  }

  copySelectedTitle() {
    const title = this.getSelectedTitle();
    this.copyToClipboard(title, 'YouTube Title');
  }

  getSelectedHeadline() {
    if (!this.fbHeadlinesList) return '';
    const selectedInput = this.fbHeadlinesList.querySelector('.yt-title-card.selected .fb-headline-input');
    if (selectedInput) return selectedInput.value.trim();
    const firstInput = this.fbHeadlinesList.querySelector('.fb-headline-input');
    return firstInput ? firstInput.value.trim() : '';
  }

  copySelectedHeadline() {
    const headline = this.getSelectedHeadline();
    this.copyToClipboard(headline, 'Facebook Headline');
  }

  async copyToClipboard(text, label = 'Content') {
    if (!text) {
      this.app?.ui?.showToast(`Nothing to copy for ${label}`, 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.app?.ui?.showToast(`📋 Copied ${label} to clipboard! ✓`, 'success');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.app?.ui?.showToast(`📋 Copied ${label} to clipboard! ✓`, 'success');
    }
  }

  copyAllYouTube() {
    const title = this.getSelectedTitle();
    const desc = this.descInput?.value || '';
    const hashtags = this.ytHashtagsList.join(' ');
    const tags = this.tagsInput?.value || '';
    const pinned = this.pinnedCommentInput?.value || '';

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
    this.copyToClipboard(bundle, 'All YouTube Details');
  }

  downloadYouTubeTxt() {
    const title = this.getSelectedTitle();
    const desc = this.descInput?.value || '';
    const hashtags = this.ytHashtagsList.join(' ');
    const tags = this.tagsInput?.value || '';
    const pinned = this.pinnedCommentInput?.value || '';

    const textContent = `StoryFlow Studio — YouTube Video Deliverable
Generated: ${new Date().toLocaleString()}

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

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `youtube_metadata_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.app?.ui?.showToast('💾 Downloaded youtube_metadata.txt', 'success');
  }

  copyAllFacebook() {
    const headline = this.getSelectedHeadline();
    const post = this.fbPostInput?.value || '';
    const videoTitle = this.fbVideoTitleInput?.value || '';
    const videoDesc = this.fbVideoDescInput?.value || '';
    const hashtags = this.fbHashtagsList.join(' ');
    const comment = this.fbCommentInput?.value || '';

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
    this.copyToClipboard(bundle, 'All Facebook Details');
  }

  downloadFacebookTxt() {
    const headline = this.getSelectedHeadline();
    const post = this.fbPostInput?.value || '';
    const videoTitle = this.fbVideoTitleInput?.value || '';
    const videoDesc = this.fbVideoDescInput?.value || '';
    const hashtags = this.fbHashtagsList.join(' ');
    const comment = this.fbCommentInput?.value || '';

    const textContent = `StoryFlow Studio — Facebook Video Deliverable
Generated: ${new Date().toLocaleString()}

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

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facebook_metadata_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.app?.ui?.showToast('💾 Downloaded facebook_metadata.txt', 'success');
  }

  setLoading(isLoading) {
    this.isLoading = isLoading;
    if (this.generateBtn) {
      this.generateBtn.disabled = isLoading;
      this.generateBtn.innerHTML = isLoading
        ? `<span class="yt-spinner"></span> Generating with Gemini...`
        : `✨ Generate with Gemini`;
    }
    if (this.regenerateBtn) {
      this.regenerateBtn.disabled = isLoading;
    }
    if (this.skeletonLoader) {
      this.skeletonLoader.classList.toggle('hidden', !isLoading);
    }
    if (this.resultsContainer) {
      if (isLoading) {
        this.resultsContainer.classList.add('opacity-50');
      } else {
        this.resultsContainer.classList.remove('opacity-50');
      }
    }
  }

  hookProjectSerialization() {
    if (!this.app) return;

    this.app.saveProjectFile = () => {
      const meta = this.getData();
      if (meta && this.app.state) {
        this.app.state.publishMeta = meta;
        this.app.state.youtubeMeta = meta.youtube;
      }

      const project = {
        version: '1.0',
        savedAt: new Date().toISOString(),
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
          ...(meta?.youtube ? { youtubeMeta: meta.youtube } : {})
        },
        frameTimestamps: (this.app.state.extractedFrames || []).map((f) => ({
          timestamp: f.timestamp,
          sourceMinute: f.sourceMinute,
          starred: f.starred
        }))
      };

      exportProjectJson(project);
      this.app.ui?.showToast('Saved project JSON file with Publish Portal metadata.', 'success');
    };

    const originalRestore = this.app.restoreProjectFile?.bind(this.app);
    if (originalRestore) {
      this.app.restoreProjectFile = (project) => {
        originalRestore(project);
        if (project?.settings?.publishMeta) {
          this.restoreData(project.settings.publishMeta);
        } else if (project?.settings?.youtubeMeta) {
          this.restoreData({ youtube: project.settings.youtubeMeta });
        } else if (project?.publish_pack) {
          this.restoreData({ youtube: project.publish_pack.youtube, facebook: project.publish_pack.facebook });
        }
      };
    }
  }

  getData() {
    if (!this.currentData) return null;
    return {
      youtube: {
        titles: this.currentData?.youtube?.titles || (this.getSelectedTitle() ? [this.getSelectedTitle()] : []),
        selectedTitle: this.getSelectedTitle(),
        description: this.descInput?.value || this.currentData?.youtube?.description || '',
        hashtags: this.ytHashtagsList.length ? [...this.ytHashtagsList] : [...(this.currentData?.youtube?.hashtags || [])],
        tags: this.tagsInput?.value
          ? this.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean)
          : Array.isArray(this.currentData?.youtube?.tags)
          ? [...this.currentData.youtube.tags]
          : [],
        pinned_comment: this.pinnedCommentInput?.value || this.currentData?.youtube?.pinned_comment || ''
      },
      facebook: {
        headlines: this.currentData?.facebook?.headlines || (this.getSelectedHeadline() ? [this.getSelectedHeadline()] : []),
        selectedHeadline: this.getSelectedHeadline(),
        post_text: this.fbPostInput?.value || this.currentData?.facebook?.post_text || '',
        video_title: this.fbVideoTitleInput?.value || this.currentData?.facebook?.video_title || '',
        video_description: this.fbVideoDescInput?.value || this.currentData?.facebook?.video_description || '',
        hashtags: this.fbHashtagsList.length ? [...this.fbHashtagsList] : [...(this.currentData?.facebook?.hashtags || [])],
        first_comment: this.fbCommentInput?.value || this.currentData?.facebook?.first_comment || ''
      },
      generatedAt: this.currentData?.generatedAt || new Date().toISOString(),
      settings: this.currentData?.settings || {}
    };
  }

  restoreData(meta) {
    if (!meta) return;
    this.currentData = {
      youtube: meta.youtube || meta,
      facebook: meta.facebook || {},
      generatedAt: meta.generatedAt || new Date().toISOString(),
      settings: meta.settings || {}
    };
    this.renderResults(this.currentData);
  }
}
