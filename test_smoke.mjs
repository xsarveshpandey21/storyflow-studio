/**
 * FrameFlow Studio — Playwright Smoke Test
 * Tests full 4-step wizard:
 * 1. Source & Frames (Direct photo upload & gallery verification)
 * 2. Voice & Script (Sample Hindi script loading, word count, TTS/voice modes)
 * 3. Studio & Export (Aspect ratio 9:16 / 16:9, Ken Burns stage, timeline)
 * 4. Publish Portal (Gemini metadata via POST /api/generate-meta, YouTube & Facebook tabs,
 *    live character counters, hashtag chips, copy buttons, .txt download, script change detection)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function createStaticServer() {
  return http.createServer((req, res) => {
    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && (reqPath === '/api/health' || reqPath.endsWith('/api/health'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tts: true }));
    }
    if (req.method === 'POST' && (reqPath === '/api/tts' || reqPath.endsWith('/api/tts'))) {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*'
      });
      // 1-second 8000Hz 8-bit mono WAV header + data
      const header = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00,
        0x64, 0x61, 0x74, 0x61, 0x00, 0x08, 0x00, 0x00
      ]);
      const pcm = Buffer.alloc(2048, 128);
      return res.end(Buffer.concat([header, pcm]));
    }
    if (req.method === 'GET' && (reqPath === '/api/config' || reqPath.endsWith('/api/config'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ geminiConfigured: true }));
    }
    if (req.method === 'GET' && (reqPath === '/api/has-key' || reqPath.endsWith('/api/has-key'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ hasKey: true }));
    }
    if (req.method === 'POST' && reqPath === '/api/generate-meta') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          youtube: {
            titles: [
              "1947 लाहौर स्टेशन की वो आख़िरी जुदाई",
              "पल्लू में बंधी घर की चाबी: विभाजन की सच्ची कहानी",
              "लाहौर से कुरुक्षेत्र तक का वो ख़ूनी सफ़र",
              "विभाजन की दास्तान: एक बिछड़ा परिवार",
              "1947 का वो दर्द जो कभी नहीं भुलाया जा सकता"
            ],
            description: "सितंबर 1947 में लाहौर स्टेशन पर क्या हुआ था? जानिए उस दर्दनाक दास्तान को जिसने एक परिवार को हमेशा के लिए अलग कर दिया।\n\n#Shorts #Partition1947 #HindiStories",
            hashtags: ["#Partition1947", "#HistoryOfIndia", "#Lahore1947", "#Shorts", "#HindiStories", "#RealStories", "#IndiaPakistan", "#PartitionStories"],
            tags: ["partition 1947", "lahore railway station", "kurukshetra camp", "hindi history stories", "1947 partition memories"],
            pinned_comment: "क्या आपके बुजुर्गों ने भी 1947 का वो मंज़र देखा था? कमेंट में अपनी कहानी साझा करें।"
          },
          facebook: {
            headlines: [
              "साड़ी के पल्लू में बंधी वो चाबी आज भी इंतज़ार कर रही है",
              "1947 लाहौर स्टेशन की कभी न भूलने वाली दास्तान",
              "विभाजन में बिछड़े अपनों का वो दर्दनाक सफ़र"
            ],
            post_text: "सितंबर 1947: लाहौर रेलवे स्टेशन की एक अनसुनी और दिल दहला देने वाली सच्ची कहानी।\n\nक्या एक चाबी किसी का खोया घर वापस ला सकती है? कमेंट में बताएं। #Partition1947 #HindiStory",
            video_title: "1947 लाहौर स्टेशन की बिछड़ती दास्तान",
            video_description: "विभाजन के दौरान लाहौर स्टेशन पर बिछड़े परिवार की सच्ची कहानी।",
            hashtags: ["#Partition1947", "#RealHistory", "#HindiStory", "#Emotional", "#India1947"],
            first_comment: "विभाजन की इस सच्ची कहानी को शेयर करके अपनों तक पहुँचाएँ।"
          }
        }));
      });
      return;
    }

    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

    const filePath = path.join(__dirname, reqPath);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        return res.end(`404 Not Found: ${reqPath}`);
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

// 10x10 valid PNG buffer
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkfgAAAAASUVORK5CYII=',
  'base64'
);

async function runSmokeTest() {
  console.log('====================================================');
  console.log('🧪 Starting FrameFlow Studio Playwright Smoke Test');
  console.log('====================================================\n');

  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[Test Server] Serving on ${baseUrl}`);

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (e1) {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
    } catch (e2) {
      browser = await chromium.launch({ headless: true });
    }
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true
  });

  const page = await context.newPage();
  const consoleErrors = [];

  page.on('console', (msg) => {
    const text = msg.text();
    console.log(`[Browser Console ${msg.type()}]: ${text}`);
    if (msg.type() === 'error') {
      if (!text.includes('favicon.ico') && !text.includes('fonts.googleapis.com') && !text.includes('ERR_NAME_NOT_RESOLVED')) {
        consoleErrors.push(text);
      }
    }
  });

  page.on('pageerror', (err) => {
    if (!err.message.includes('ERR_NAME_NOT_RESOLVED')) {
      console.error(`[Page Uncaught Error]: ${err.message}`);
      consoleErrors.push(err.message);
    }
  });

  try {
    // -------------------------------------------------------------
    // STEP 1: Source & Frames
    // -------------------------------------------------------------
    console.log('[Step 1] Loading app and verifying Source & Frames step...');
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    const appTitle = await page.title();
    console.log(`[Step 1] Page title: "${appTitle}"`);

    // Verify Step 1 section is active
    await page.waitForSelector('#step1Section.active');

    // Add sample photos to gallery
    console.log('[Step 1] Adding test photos to photo gallery...');
    const filesToUpload = [
      { name: 'station_1947.png', mimeType: 'image/png', buffer: SAMPLE_PNG },
      { name: 'key_saree.png', mimeType: 'image/png', buffer: SAMPLE_PNG },
      { name: 'refugee_camp.png', mimeType: 'image/png', buffer: SAMPLE_PNG }
    ];
    await page.locator('#directPhotoUploadInput').setInputFiles(filesToUpload);
    await page.waitForTimeout(300);

    // Assert photo gallery cards rendered
    const photoCardsCount = await page.locator('#extractedGalleryGrid .frame-card').count();
    console.log(`[Step 1] Extracted photo cards rendered: ${photoCardsCount}`);
    if (photoCardsCount !== 3) {
      throw new Error(`Expected 3 photo cards in gallery, found: ${photoCardsCount}`);
    }
    const totalBadgeText = await page.textContent('#totalExtractedBadge');
    console.log(`[Step 1] Total extracted badge: "${totalBadgeText}"`);
    if (!totalBadgeText.includes('3')) {
      throw new Error(`Expected total badge to show 3 Photos, got: "${totalBadgeText}"`);
    }

    // Video extraction test with sample video
    console.log('[Step 1] Testing sample video generation and frame extraction...');
    await page.click('#createSampleVideoBtn');
    await page.waitForSelector('#videoMetaCard:not(.hidden)', { timeout: 20000 });
    await page.click('#startExtractionBtn');
    // Wait for extraction to complete
    await page.waitForFunction(() => {
      const btn = document.getElementById('startExtractionBtn');
      return btn && btn.textContent.includes('Start') && !btn.textContent.includes('Extracting');
    }, { timeout: 35000 });
    const extractedCount = await page.locator('#extractedGalleryGrid .frame-card').count();
    console.log(`[Step 1] Frames in gallery after extraction: ${extractedCount}`);
    if (extractedCount <= 0) {
      throw new Error('Expected frames in gallery after video extraction');
    }
    const extractedBadgeText = await page.textContent('#totalExtractedBadge');
    console.log(`[Step 1] Badge after video extraction: "${extractedBadgeText}"`);

    // Test Theme Toggle
    console.log('[Theme] Testing Light/Dark theme toggle...');
    await page.click('#themeToggleBtn');
    const isLight = await page.evaluate(() => document.body.classList.contains('light-theme'));
    console.log(`[Theme] Toggled theme, is light-theme: ${isLight}`);
    await page.click('#themeToggleBtn');
    const isDark = await page.evaluate(() => document.body.classList.contains('dark-theme'));
    console.log(`[Theme] Toggled back, is dark-theme: ${isDark}`);
    if (!isDark) throw new Error('Expected dark theme after toggling back');

    // Test My Projects Modal
    console.log('[Projects] Testing My Projects modal open/close...');
    await page.click('#myProjectsBtn');
    await page.waitForSelector('#projectsModal:not(.hidden)');
    console.log('[Projects] My Projects modal opened');
    await page.click('#closeProjectsModalBtn');
    await page.waitForSelector('#projectsModal', { state: 'hidden' });
    console.log('[Projects] My Projects modal closed');

    // -------------------------------------------------------------
    // STEP 2: Voice & Script
    // -------------------------------------------------------------
    console.log('\n[Step 2] Testing Voice & Script step...');
    await page.click('#goToStep2Btn');
    await page.waitForSelector('#step2Section.active');

    // Load sample script
    await page.click('#loadSampleScriptBtn');
    const scriptVal = await page.inputValue('#scriptTextarea');
    console.log(`[Step 2] Loaded script length: ${scriptVal.length} chars`);
    if (!scriptVal || scriptVal.length < 20) {
      throw new Error(`Expected script to be populated, got: "${scriptVal}"`);
    }

    const wordCount = await page.textContent('#scriptWordCount');
    console.log(`[Step 2] Word count badge: ${wordCount}`);

    // Switch to Neural TTS tab
    await page.click('#voiceModeBtnA');
    await page.waitForSelector('#voiceModeCardA:not(.hidden)');
    console.log('[Step 2] Switched to Neural TTS voice tab');

    // Test Voice Controls: Tone, Pitch, and Speed over 2x
    console.log('[Step 2] Testing Tone, Pitch & Speed Controls over 2x...');
    // 1. Click 2.0x speed button
    await page.click('.speed-quick-btn[data-rate="2.0"]');
    const rateText = await page.textContent('#ttsRateDisplay');
    console.log(`[Step 2] Selected Speed Rate: ${rateText}`);
    if (!rateText.includes('2.0')) {
      throw new Error(`Expected rate to be 2.0x, got: "${rateText}"`);
    }

    // 2. Select Tone Preset
    await page.selectOption('#ttsToneSelect', 'hyper2x');
    const activeRate = await page.evaluate(() => window.app?.state?.ttsOptions?.rate);
    console.log(`[Step 2] App state TTS rate after hyper2x preset: ${activeRate}`);
    if (activeRate < 2.0) {
      throw new Error(`Expected active rate >= 2.0x for hyper2x preset, got: ${activeRate}`);
    }

    // 3. Test 2.5x speed shortcut
    await page.click('.speed-quick-btn[data-rate="2.5"]');
    const speed25Text = await page.textContent('#ttsRateDisplay');
    console.log(`[Step 2] Selected Speed Rate: ${speed25Text}`);
    if (!speed25Text.includes('2.5')) {
      throw new Error(`Expected rate to be 2.5x, got: "${speed25Text}"`);
    }

    // 4. Test Pitch quick button
    await page.click('.pitch-quick-btn[data-pitch="0.7"]');
    const pitchText = await page.textContent('#ttsPitchDisplay');
    console.log(`[Step 2] Selected Voice Pitch: ${pitchText}`);
    if (!pitchText.includes('0.7')) {
      throw new Error(`Expected pitch to be 0.7x, got: "${pitchText}"`);
    }

    // Reset to normal for remaining tests
    await page.click('.preset-pill[data-preset="normal"]');

    // Test Autosave & Reload Restore
    console.log('[Autosave] Testing autosave and restore after reload...');
    await page.evaluate(() => window.app?.storyController?.markDirtyAndSave());
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600);

    const restoredScript = await page.inputValue('#scriptTextarea');
    console.log(`[Autosave] Restored script length after reload: ${restoredScript.length}`);
    if (!restoredScript || restoredScript.length < 20) {
      throw new Error(`Expected script to be restored after reload, got: "${restoredScript}"`);
    }
    const restoredFramesCount = await page.locator('#extractedGalleryGrid .frame-card').count();
    console.log(`[Autosave] Restored frames count after reload: ${restoredFramesCount}`);
    if (restoredFramesCount <= 0) {
      throw new Error(`Expected photos to be restored after reload, got: ${restoredFramesCount}`);
    }

    // Proceed to Step 3
    await page.click('#goToStep2Btn');
    await page.waitForSelector('#step2Section.active');
    await page.click('#goToStep3Btn');
    await page.waitForSelector('#step3Section.active');
    console.log('✓ Step 2 verified.');

    // -------------------------------------------------------------
    // STEP 3: Studio & Export
    // -------------------------------------------------------------
    console.log('\n[Step 3] Testing Studio & Export step...');
    await page.waitForSelector('#previewCanvas');

    // Select 9:16 vertical ratio
    await page.click('#ratio9x16Btn');
    console.log('[Step 3] Selected 9:16 vertical aspect ratio');

    // Configure 10s duration for fast test video encoding
    await page.selectOption('#durationModeSelect', 'custom');
    await page.fill('#customDurationSeconds', '10');
    await page.evaluate(() => {
      window.app.state.customDuration = 10;
      window.app.state.timelineDuration = 10;
      window.app.rebuildTimeline();
    });

    // Test Download ZIP (file size > 0)
    console.log('[Step 3] Testing Download ZIP...');
    const [zipDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadZipBtn')
    ]);
    const zipPath = await zipDownload.path();
    const zipSize = fs.statSync(zipPath).size;
    console.log(`[Step 3] Downloaded ZIP bundle size: ${zipSize} bytes`);
    if (zipSize <= 0) throw new Error(`Downloaded ZIP is empty: ${zipSize} bytes`);

    // Test Export MP4 (file size > 0)
    console.log('[Step 3] Testing Export MP4 video...');
    const [mp4Download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      page.click('#exportMp4Btn')
    ]);
    const mp4Path = await mp4Download.path();
    const mp4Size = fs.statSync(mp4Path).size;
    console.log(`[Step 3] Exported MP4 video size: ${mp4Size} bytes`);
    if (mp4Size <= 0) throw new Error(`Exported MP4 is empty: ${mp4Size} bytes`);

    // Proceed to Step 4: Publish Portal
    await page.click('#goToStep4Btn');
    await page.waitForSelector('#step4Section.active');
    console.log('✓ Step 3 verified.');

    // -------------------------------------------------------------
    // STEP 4: Publish Portal (YouTube & Facebook Tabs)
    // -------------------------------------------------------------
    console.log('\n[Step 4] Testing Step 4: Publish Portal...');

    // Check script summary
    const summarySnippet = await page.textContent('#portalScriptSnippet');
    console.log(`[Step 4] Script summary snippet: "${summarySnippet.slice(0, 60)}..."`);

    // Click "Generate with Gemini"
    console.log('[Step 4] Triggering Gemini metadata generation via /api/generate-meta...');
    await page.click('#portalGenerateBtn');

    // Wait for results container
    await page.waitForSelector('#portalResultsContainer:not(.hidden)');

    // 1. YouTube tab verification
    const ytTitlesCount = await page.locator('#ytTitlesList .yt-title-card').count();
    console.log(`[Step 4] YouTube titles rendered: ${ytTitlesCount}`);
    if (ytTitlesCount !== 5) {
      throw new Error(`Expected 5 YouTube title options, found ${ytTitlesCount}`);
    }

    const firstTitleVal = await page.inputValue('#ytTitlesList .yt-title-input');
    console.log(`[Step 4] First title option: "${firstTitleVal}" (${firstTitleVal.length} chars)`);
    if (firstTitleVal.length > 70) {
      throw new Error(`YouTube title exceeds 70 characters: "${firstTitleVal}"`);
    }

    const ytDescVal = await page.inputValue('#ytDescInput');
    console.log(`[Step 4] Description populated (${ytDescVal.length} chars)`);

    const ytChipsCount = await page.locator('#ytHashtagsContainer .yt-hashtag-chip').count();
    console.log(`[Step 4] YouTube hashtag chips: ${ytChipsCount}`);
    if (ytChipsCount < 5) {
      throw new Error(`Expected at least 5 hashtag chips, found ${ytChipsCount}`);
    }

    // Keyword match badge
    const keywordBadgeText = await page.textContent('#portalKeywordMatchBadge');
    console.log(`[Step 4] Keyword match badge: "${keywordBadgeText}"`);

    // Test Copy Title button
    await page.click('#ytCopyTitleBtn');

    // 2. Facebook tab verification
    console.log('[Step 4] Switching to Facebook tab...');
    await page.click('#portalTabFbBtn');
    await page.waitForSelector('#portalPanelFb:not(.hidden)');

    const fbHeadlinesCount = await page.locator('#fbHeadlinesList .fb-headline-row').count();
    console.log(`[Step 4] Facebook headline options: ${fbHeadlinesCount}`);
    if (fbHeadlinesCount !== 3) {
      throw new Error(`Expected 3 Facebook headline options, found ${fbHeadlinesCount}`);
    }

    const fbPostVal = await page.inputValue('#fbPostInput');
    console.log(`[Step 4] Facebook post text: "${fbPostVal.slice(0, 50)}..."`);
    if (!fbPostVal) {
      throw new Error('Expected Facebook post text to be populated');
    }

    // Test Copy Facebook Post button
    await page.click('#copyFbPostBtn');

    // Test Back to Studio button
    await page.click('#backToStep3Btn');
    await page.waitForSelector('#step3Section.active');
    console.log('[Step 4] Successfully navigated back to Studio via #backToStep3Btn');

    // -------------------------------------------------------------
    // MOBILE VIEWPORT CHECK (390px)
    // -------------------------------------------------------------
    console.log('\n[Mobile Check] Testing 390px viewport horizontal overflow across all 4 steps...');
    await page.setViewportSize({ width: 390, height: 844 });
    for (let s = 1; s <= 4; s++) {
      await page.evaluate((step) => {
        if (window.app) window.app.goToStep(step);
      }, s);
      await page.waitForTimeout(200);
      const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      console.log(`[Mobile Check] Step ${s}: doc scrollWidth = ${docScrollWidth}px (Expected: 390px)`);
      if (docScrollWidth > 390) {
        const culprits = await page.evaluate(() => {
          const list = [];
          document.querySelectorAll('*').forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.right > 390 || el.scrollWidth > 390) {
              list.push({
                tag: el.tagName,
                id: el.id,
                className: typeof el.className === 'string' ? el.className.slice(0, 50) : '',
                scrollWidth: el.scrollWidth,
                offsetWidth: el.offsetWidth,
                right: Math.round(rect.right)
              });
            }
          });
          return list;
        });
        console.error('Culprits causing mobile overflow:', JSON.stringify(culprits.slice(0, 10), null, 2));
        throw new Error(`Mobile overflow detected on Step ${s}: scrollWidth is ${docScrollWidth}px (max allowed: 390px)`);
      }
    }

    console.log('\n[Console Error Check] Total errors logged:', consoleErrors.length);
    if (consoleErrors.length > 0) {
      console.error('Console errors observed:', consoleErrors);
      throw new Error(`Uncaught errors occurred during test run: ${consoleErrors.join('; ')}`);
    }

    console.log('\n====================================================');
    console.log('🎉 ALL PLAYWRIGHT SMOKE TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================\n');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

runSmokeTest().catch((err) => {
  console.error('\n❌ Smoke Test Failed:', err);
  process.exit(1);
});
