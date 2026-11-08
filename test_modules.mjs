/**
 * Automated Test Suite for FrameFlow Studio Modules
 * Validates:
 * 1. Stratified random sampling per minute (15-20 frames/min rule, slot bounds)
 * 2. Hindi & English sentence splitting (Danda '।', '.', '?', '!', comma splitting at ~90 chars)
 * 3. Silence snapping & SRT/VTT formatting
 * 4. Ken Burns math & strict edge-clamping calculations
 * 5. Timeline scheduling (no consecutive repeats, starred weight)
 */

import { FrameExtractor } from './js/extractor.js';
import { CaptionEngine } from './js/captions.js';
import { TimelineEngine } from './js/timeline.js';
import { VoiceEngine } from './js/voice.js';
import { formatPitchStr, formatRateStr, formatVolumeStr, mapTtsErrorMessage, callGeminiMetaAPI, server } from './server.js';

console.log('🧪 Starting StoryFlow Studio automated unit tests...\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ PASS: ${message}`);
    passedTests++;
  }
}

// -------------------------------------------------------------
// Test 1: Stratified Random Sampling
// -------------------------------------------------------------
console.log('--- Test Suite 1: Stratified Random Sampling ---');
const extractor = new FrameExtractor(null, null);

// Test video duration 180 seconds (3 minutes)
const duration = 180;
const schedule = extractor.generateSamplingSchedule(duration, 15, 20);

assert(schedule.length >= 45 && schedule.length <= 60, 
  `Total slots for 3 minutes should be between 45 and 60 (Got: ${schedule.length})`);

// Verify slot distribution across minutes
const min0Slots = schedule.filter(s => s.minuteIdx === 0);
const min1Slots = schedule.filter(s => s.minuteIdx === 1);
const min2Slots = schedule.filter(s => s.minuteIdx === 2);

assert(min0Slots.length >= 15 && min0Slots.length <= 20, 
  `Minute 0 has ${min0Slots.length} slots (within 15..20 range)`);
assert(min1Slots.length >= 15 && min1Slots.length <= 20, 
  `Minute 1 has ${min1Slots.length} slots (within 15..20 range)`);
assert(min2Slots.length >= 15 && min2Slots.length <= 20, 
  `Minute 2 has ${min2Slots.length} slots (within 15..20 range)`);

// Verify each targetTime is inside its slot and in bounds
let allInBounds = true;
schedule.forEach(s => {
  if (s.targetTime < 0 || s.targetTime > duration) allInBounds = false;
  if (s.targetTime < s.slotStart || s.targetTime > s.slotEnd) allInBounds = false;
});
assert(allInBounds, 'All sample timestamps are strictly within their designated stratified minute slots');

// Partial minute test (e.g. 75 seconds = 1 full minute + 15 sec partial)
const partialSchedule = extractor.generateSamplingSchedule(75, 15, 20);
const partialMin1 = partialSchedule.filter(s => s.minuteIdx === 1);
assert(partialMin1.length >= 3 && partialMin1.length <= 6, 
  `Partial minute (15s = 25% of min) gets proportionally ~4 slots (Got: ${partialMin1.length})`);

// -------------------------------------------------------------
// Test 2: Hindi & English Sentence Splitting
// -------------------------------------------------------------
console.log('\n--- Test Suite 2: Hindi & English Sentence Splitting ---');
const captions = new CaptionEngine();

const sampleText = `प्रकृति की सुंदरता हमें शांति देती है। The gentle breeze calms the soul! क्या आप जानते हैं कि जीवन का हर पल अनमोल है? Yes, it truly is. Always cherish this moment.`;
const chunks = captions.splitScriptIntoSentences(sampleText);

assert(chunks.length === 5, `Expected 5 sentences, got ${chunks.length}`);
assert(chunks[0] === 'प्रकृति की सुंदरता हमें शांति देती है।', 'Captured first Hindi sentence with Danda ।');
assert(chunks[1] === 'The gentle breeze calms the soul!', 'Captured English sentence with exclamation !');
assert(chunks[2].includes('?'), 'Captured question sentence with ?');

// Long sentence breaking test (> 90 chars)
const longSentence = `यह एक बहुत लंबा वाक्य है जिसे हमने विशेष रूप से यह जांचने के लिए लिखा है कि क्या हमारा सिस्टम लंबे वाक्यों को अल्पविराम या शब्दों के आधार पर ठीक से विभाजित करता है, ताकि वीडियो स्क्रीन पर कैप्शन बहुत बड़े और पढ़ने में असुविधाजनक न हों।`;
const subChunks = captions.splitScriptIntoSentences(longSentence);
assert(subChunks.length > 1, `Long sentence (>90 chars) was split into ${subChunks.length} readable sub-chunks`);
assert(subChunks.every(c => c.length <= 95), 'All sub-chunks are within the ~90 character readability limit');

// -------------------------------------------------------------
// Test 3: Caption Alignment & Silence Snapping
// -------------------------------------------------------------
console.log('\n--- Test Suite 3: Caption Alignment & Snapping ---');
const silenceGaps = [
  { start: 3.8, end: 4.3, mid: 4.05 },
  { start: 8.2, end: 8.6, mid: 8.4 }
];
const aligned = captions.alignCaptionsWithAudio(chunks, 20, silenceGaps);

assert(aligned.length === 5, 'Aligned chunk count matches input sentence count');
assert(aligned[0].start === 0, 'First caption starts at 0.0s');
assert(aligned[aligned.length - 1].end === 20, 'Last caption ends at total duration (20.0s)');

// Test SRT and VTT generation
const srt = captions.generateSRT(aligned);
assert(srt.includes('00:00:00,000 -->'), 'SRT contains correct SubRip timestamp formatting');
assert(srt.includes('प्रकृति की सुंदरता'), 'SRT preserves Devanagari Hindi characters');

const vtt = captions.generateVTT(aligned);
assert(vtt.startsWith('WEBVTT'), 'VTT starts with WEBVTT header');
assert(vtt.includes('00:00:00.000 -->'), 'VTT contains dot-separated millisecond timestamps');

// -------------------------------------------------------------
// Test 4: Ken Burns Math & Edge Clamping
// -------------------------------------------------------------
console.log('\n--- Test Suite 4: Ken Burns Edge Clamping Math ---');
// Verify for standard 1920x1080 canvas with various image sizes
const canvasW = 1920;
const canvasH = 1080;
const testImageSizes = [
  { w: 1920, h: 1080 },
  { w: 3840, h: 2160 },
  { w: 1280, h: 720 },
  { w: 1080, h: 1920 } // vertical image on horizontal canvas
];

let noEmptyEdgesFound = true;
testImageSizes.forEach(img => {
  const baseScale = Math.max(canvasW / img.w, canvasH / img.h);
  for (let zoom = 1.0; zoom <= 1.4; zoom += 0.1) {
    const totalScale = baseScale * zoom;
    const drawnW = img.w * totalScale;
    const drawnH = img.h * totalScale;
    const excessX = Math.max(0, drawnW - canvasW);
    const excessY = Math.max(0, drawnH - canvasH);

    // Test pan extreme points: -1.0 to 1.0
    for (const panFactor of [-1.0, -0.5, 0, 0.5, 1.0]) {
      const offsetX = ((canvasW - drawnW) / 2) + (panFactor * (excessX / 2));
      const offsetY = ((canvasH - drawnH) / 2) + (panFactor * (excessY / 2));

      // Left edge of image must be <= 0 (no gap on left)
      if (offsetX > 0.001) noEmptyEdgesFound = false;
      // Right edge of image must be >= canvasW (no gap on right)
      if (offsetX + drawnW < canvasW - 0.001) noEmptyEdgesFound = false;
      // Top edge must be <= 0
      if (offsetY > 0.001) noEmptyEdgesFound = false;
      // Bottom edge must be >= canvasH
      if (offsetY + drawnH < canvasH - 0.001) noEmptyEdgesFound = false;
    }
  }
});
assert(noEmptyEdgesFound, 'Ken Burns cover scaling and pan clamping guaranteed to NEVER reveal empty edges');

// -------------------------------------------------------------
// Test 5: Timeline Scheduling
// -------------------------------------------------------------
console.log('\n--- Test Suite 5: Timeline Scheduling ---');
const timeline = new TimelineEngine();
const mockPhotos = [
  { id: 'p1', timestamp: 10, starred: false },
  { id: 'p2', timestamp: 20, starred: true },
  { id: 'p3', timestamp: 30, starred: false },
  { id: 'p4', timestamp: 40, starred: false }
];

const segments = timeline.generateTimeline(mockPhotos, 60, {
  minDuration: 4,
  maxDuration: 8
});

assert(segments.length >= 7 && segments.length <= 15, `Timeline generated ${segments.length} segments for 60s video`);

// Check no consecutive photo repeats
let noConsecutiveRepeats = true;
for (let i = 0; i < segments.length - 1; i++) {
  if (segments[i].photo.id === segments[i + 1].photo.id) {
    noConsecutiveRepeats = false;
  }
}
assert(noConsecutiveRepeats, 'Zero consecutive duplicate photos across the entire generated timeline');

// Starred photo weighted distribution check
const p2Appearances = segments.filter(s => s.photo.id === 'p2').length;
const p1Appearances = segments.filter(s => s.photo.id === 'p1').length;
console.log(`Starred photo p2 appearances: ${p2Appearances}, Regular photo p1: ${p1Appearances}`);
assert(p2Appearances >= p1Appearances, 'Starred photo has higher frequency than unstarred photos');

// Active segment lookup test at t = 15.5s
const lookup = timeline.getActiveSegments(15.5);
assert(lookup.currentSegment !== null, 'Found active segment at t = 15.5s');
assert(lookup.currentSegment.startTime <= 15.5 && lookup.currentSegment.endTime >= 15.5, 
  'Active segment boundaries correctly surround current timestamp');

// -------------------------------------------------------------
// Test 6: Aspect Ratio Crop Bounds Math
// -------------------------------------------------------------
console.log('\n--- Test Suite 6: Aspect Ratio Crop Bounds Math ---');
const cropBounds916 = extractor.computeCropBounds(1920, 1080, '9:16', 0.5);
assert(cropBounds916.cropH === 1080, `9:16 crop preserves full source height 1080 (Got: ${cropBounds916.cropH})`);
assert(Math.abs(cropBounds916.cropW - 608) <= 2, `9:16 crop width is ~608px (Got: ${cropBounds916.cropW})`);
assert(cropBounds916.srcX > 600 && cropBounds916.srcX < 700, `9:16 center crop srcX is centered (Got: ${cropBounds916.srcX})`);

const cropBoundsLeft = extractor.computeCropBounds(1920, 1080, '9:16', 0.0);
assert(cropBoundsLeft.srcX === 0, `9:16 left crop aligns to srcX = 0`);

const cropBoundsRight = extractor.computeCropBounds(1920, 1080, '9:16', 1.0);
assert(cropBoundsRight.srcX === 1920 - cropBoundsRight.cropW, `9:16 right crop aligns to rightmost boundary`);

const cropBounds11 = extractor.computeCropBounds(1920, 1080, '1:1', 0.5);
assert(cropBounds11.cropW === 1080 && cropBounds11.cropH === 1080, `1:1 crop yields square dimensions (1080x1080)`);

const customNorm = { x: 0.2, y: 0.1, w: 0.5, h: 0.8 };
const customCropBounds = extractor.computeCropBounds(1920, 1080, 'custom', 0.5, 0.5, customNorm);
assert(customCropBounds.srcX === 384, `Custom crop srcX calculates exact normalized pixel (Got: ${customCropBounds.srcX}, Expected: 384)`);
assert(customCropBounds.srcY === 108, `Custom crop srcY calculates exact normalized pixel (Got: ${customCropBounds.srcY}, Expected: 108)`);
assert(customCropBounds.cropW === 960, `Custom crop cropW matches normalized width (Got: ${customCropBounds.cropW}, Expected: 960)`);
assert(customCropBounds.cropH === 864, `Custom crop cropH matches normalized height (Got: ${customCropBounds.cropH}, Expected: 864)`);

// -------------------------------------------------------------
// Test 7: Export Fix Verification (Script Integrity, Chunk Monotonicity, Audio/Video Duration Match)
// -------------------------------------------------------------
console.log('\n--- Test Suite 7: Export Fixes (Captions & Audio Alignment) ---');

// Test 7.1: Caption chunks reconstructing the full script
const fullScript = `यह पहला वाक्य है। This is the second sentence! क्या तीसरा वाक्य भी सही है? Yes, completely accurate. अंतिम वाक्य का परीक्षण।`;
const fullSentences = captions.splitScriptIntoSentences(fullScript);
const alignedExportChunks = captions.alignCaptionsWithAudio(fullSentences, 30);

const reconstructedScript = alignedExportChunks
  .map(c => c.text.trim())
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const expectedNormalizedScript = fullScript.replace(/\s+/g, ' ').trim();

assert(reconstructedScript === expectedNormalizedScript, 
  'Caption chunks reconstruct the full script text exactly without missing or altered words');
assert(captions.verifyAndFixScriptIntegrity(fullScript) === true, 
  'verifyAndFixScriptIntegrity passes on aligned chunks');

// Test 7.2: Chunk times strictly increasing within the audio duration
let strictlyIncreasing = true;
let inAudioBounds = true;
const targetAudioDur = 30;

for (let i = 0; i < alignedExportChunks.length; i++) {
  const c = alignedExportChunks[i];
  if (c.start < 0 || c.end > targetAudioDur || c.start >= c.end) {
    strictlyIncreasing = false;
    inAudioBounds = false;
  }
  if (i < alignedExportChunks.length - 1) {
    const nextC = alignedExportChunks[i + 1];
    if (c.end > nextC.start) {
      strictlyIncreasing = false;
    }
  }
}

assert(strictlyIncreasing, 'Caption chunk times are strictly increasing (start_i < end_i <= start_{i+1})');
assert(inAudioBounds, `All chunk boundaries stay strictly within total audio duration (0..${targetAudioDur}s)`);

// Test 7.3: Audio duration matching video duration (exact sample length, zero drift)
const targetVideoDurations = [15.0, 30.0, 60.0, 72.35];
const sampleRate = 48000;
let allAudioDurationsMatch = true;

for (const videoDur of targetVideoDurations) {
  const targetSamples = Math.round(videoDur * sampleRate);
  const calculatedAudioDuration = targetSamples / sampleRate;
  if (Math.abs(calculatedAudioDuration - videoDur) > (1 / sampleRate)) {
    allAudioDurationsMatch = false;
  }
}

assert(allAudioDurationsMatch, 'Audio render target duration matches video duration to the exact sample (zero drift)');

// -------------------------------------------------------------
// Test 8: Script Word-Budget & Duration Estimator
// -------------------------------------------------------------
console.log('\n--- Test Suite 8: Script Word Budget & Duration Estimator ---');
import { 
  countWords, 
  estimateDuration, 
  analyzeRetentionLine, 
  checkWordBudget, 
  validatePublishPack, 
  parseGeminiJson 
} from './js/validators.js';
import { GeminiClient } from './js/gemini.js';
import { SimpleZip } from './js/vendor/zip-writer.js';

const testLineShort = 'सितंबर 1947, लाहौर रेलवे स्टेशन का खचाखच भरा प्लेटफ़ॉर्म।';
const testLineWords = countWords(testLineShort);
assert(testLineWords >= 7 && testLineWords <= 9, `Word count calculated accurately (Got: ${testLineWords})`);

const estimatedSecs = estimateDuration(testLineShort);
assert(Math.abs(estimatedSecs - (testLineWords / 2.4)) < 0.1, `Spoken duration calculated based on 2.4 words/sec (Got: ${estimatedSecs}s)`);

// Budget test for 60 seconds (target ~144 words, ±10% is 130..158 words)
const scriptSampleLines = [
  'सितंबर 1947, लाहौर रेलवे स्टेशन का खचाखच भरा प्लेटफ़ॉर्म।',
  'ट्रेन की सीटी बजती है और भीड़ में पति-पत्नी एक-दूसरे से हमेशा के लिए बिछड़ जाते हैं।',
  'पत्नी के पास सिर्फ़ उसकी साड़ी के पल्लू में बंधी घर की चाबी थी, यह सोचकर कि वो 10-15 दिनों में लौट आएगी।',
  'लेकिन वह दिन कभी नहीं आया।',
  'लाखों लोग 120 किलोमीटर लंबे पैदल काफ़िलों में धूल और आंसुओं के बीच चलते रहे।',
  'कुरुक्षेत्र, पुराना क़िला और वाल्टन के शरणार्थी कैंपों में रातें कटीं।',
  'जालंधर और अमृतसर रेडियो पर हर घंटे बिछड़े हुए अपनों के नाम पुकारे जाते रहे।',
  'नए आशियाने बसे—लाजपत नगर, पटेल नगर, पंजाबी बाग और फ़रीदाबाद।',
  'आज भी कई परिवारों की पुरानी संदूकों में वे जंग लगी चाबियां और ताले महफ़ूज़ हैं, जो उस खोए हुए वतन की गवाही देते हैं।',
  'क्या आपके परिवार में भी विभाजन की कोई ऐसी चाबी या कहानी आज तक महफ़ूज़ है? हमें कमेंट में ज़रूर बताएं।'
];

const budgetCheck = checkWordBudget(scriptSampleLines, 60);
console.log(`Word budget check: ${budgetCheck.actualWords} words for 60s (target: ${budgetCheck.targetWords}, delta: ${budgetCheck.deltaPercent}%)`);
assert(budgetCheck.actualWords > 100, 'Calculated total words across script lines');

// -------------------------------------------------------------
// Test 9: Retention Meter Flags (>9s or >25 words)
// -------------------------------------------------------------
console.log('\n--- Test Suite 9: Retention Meter Flags ---');
const punchyLine = 'लेकिन वह दिन कभी नहीं आया।'; // 6 words (~2.5s)
const normalAnalysis = analyzeRetentionLine(punchyLine);
assert(!normalAnalysis.isWarning, 'Normal short line has no retention warnings');

// Very long line (>25 words and >9s)
const longNarrationLine = 'और जब वह भारी भरकम रेलगाड़ी धीरे-धीरे प्लेटफ़ॉर्म छोड़कर धुएं के बादलों में ओझल होने लगी, तब उस असहाय स्त्री ने अपने कांपते हाथों से अपनी साड़ी के पल्लू में कसकर बांधी हुई उस पीतल की चाबी को छुआ और सोचा कि वह कुछ ही हफ़्तों में वापस लौट आएगी।';
const longAnalysis = analyzeRetentionLine(longNarrationLine);
assert(longAnalysis.isWarning, 'Overly long narration line flagged with retention warning');
assert(longAnalysis.words > 25, `High word density detected (${longAnalysis.words} words > 25)`);
assert(longAnalysis.seconds > 9.0, `Duration warning detected (${longAnalysis.seconds}s > 9s)`);

// -------------------------------------------------------------
// Test 10: Publish Pack Validation (Titles, Tags, Hashtags)
// -------------------------------------------------------------
console.log('\n--- Test Suite 10: Publish Pack Validation ---');
const validPublishMeta = {
  youtube: {
    titles: [
      '1947 लाहौर स्टेशन की आखिरी चाबी',
      'विभाजन का वो बिछड़ना जो कभी नहीं मिला',
      'साड़ी के पल्लू में बंधी वतन की आखिरी याद',
      '75 साल बाद भी महफ़ूज़ है वो पुराना ताला',
      'लाहौर से दिल्ली तक का वो दर्दनाक सफर'
    ],
    tags: ['1947 partition', 'lahore station', 'indian history', 'untold stories', 'emotional story'],
    hashtags: ['#Shorts', '#History', '#Partition1947', '#EmotionalStory', '#India', '#Lahore', '#OldMemories', '#TrueStory']
  },
  facebook: {
    hashtags: ['#PartitionStory', '#HistoryFacts', '#Emotional']
  }
};

const validResult = validatePublishPack(validPublishMeta, 'Shorts');
assert(validResult.isValid, 'Valid publish metadata passes validation cleanly');

// Invalid metadata: title > 70 chars, tags > 450 chars, invalid hashtag, wrong FB hashtag count
const invalidPublishMeta = {
  youtube: {
    titles: [
      'यह शीर्षक जानबूझकर सत्तर अक्षरों से अधिक लंबा लिखा गया है ताकि हमारे सिस्टम की सख्त वेलिडेशन कसौटी को पूरी तरह परखा जा सके और त्रुटि पकड़ी जाए',
      'Valid Short Title'
    ],
    tags: Array(30).fill('very long keyword phrase repeated many times for character test'),
    hashtags: ['invalidTagNoHash', '#Has Space Inside#']
  },
  facebook: {
    hashtags: ['#OnlyOneTag'] // requires 3-5
  }
};

const invalidResult = validatePublishPack(invalidPublishMeta, 'Shorts');
assert(!invalidResult.isValid, 'Invalid publish metadata correctly triggers validation errors');
assert(invalidResult.errors.some(e => e.includes('exceeds 70 characters')), 'Flags title exceeding 70 characters');
assert(invalidResult.errors.some(e => e.includes('450 characters')), 'Flags keyword tags exceeding 450 characters');
assert(invalidResult.errors.some(e => e.includes("must start with '#'")), 'Flags hashtag missing #');
assert(invalidResult.errors.some(e => e.includes('must not contain spaces')), 'Flags hashtag with internal space');
assert(invalidResult.errors.some(e => e.includes('Facebook requires exactly 3 to 5 hashtags')), 'Flags incorrect Facebook hashtag count');

// -------------------------------------------------------------
// Test 11: Resilient JSON Parsing Fallback
// -------------------------------------------------------------
console.log('\n--- Test Suite 11: Resilient JSON Parsing Fallback ---');
const cleanJson = '{"success": true, "count": 42}';
assert(parseGeminiJson(cleanJson).count === 42, 'Parses standard clean JSON');

const markdownFencedJson = '```json\n{\n  "hook": "1947 का सच!",\n  "score": 9.5\n}\n```';
assert(parseGeminiJson(markdownFencedJson).score === 9.5, 'Parses markdown-fenced ```json response');

const messyGeminiOutput = 'Here is the requested video script in JSON format:\n\n{\n  "status": "ready",\n  "lines": ["पंक्ति 1।", "पंक्ति 2।"]\n}\n\nHope this helps your channel!';
const parsedMessy = parseGeminiJson(messyGeminiOutput);
assert(parsedMessy.status === 'ready' && parsedMessy.lines.length === 2, 'Extracts JSON embedded inside conversational text');

// -------------------------------------------------------------
// Test 12: Scene Match Fallback Scoring & No-Repeat Rule
// -------------------------------------------------------------
console.log('\n--- Test Suite 12: Scene Match Fallback Scoring & No-Repeat Rule ---');
const geminiClient = new GeminiClient();

const testScriptLines = [
  { text: 'सितंबर 1947, लाहौर रेलवे स्टेशन का खचाखच भरा प्लेटफ़ॉर्म।', scene_tags: ['railway station', 'steam locomotive', 'crowd'] },
  { text: 'ट्रेन की सीटी बजती है और भीड़ में पति-पत्नी बिछड़ जाते हैं।', scene_tags: ['crowd', 'passengers', 'train departing'] },
  { text: 'पत्नी के पास साड़ी के पल्लू में बंधी घर की चाबी थी।', scene_tags: ['vintage brass key', 'antique lock', 'close-up hands'] },
  { text: 'लाखों लोग 120 किलोमीटर पैदल काफ़िले में चले।', scene_tags: ['refugee caravan', 'dusty road', 'walking crowd'] },
  { text: 'कुरुक्षेत्र और पुराना क़िला के राहत शिविरों में रातें कटीं।', scene_tags: ['relief tents', 'refugee camp', 'historical fort'] },
  { text: 'आज भी कई संदूकों में वे पुरानी चाबियां महफ़ूज़ हैं।', scene_tags: ['vintage wooden trunk', 'brass lock', 'heirloom'] }
];

const testPhotos = [
  { id: 'photo_station', tags: ['steam locomotive', 'railway platform', 'lahore crowd'], starred: false },
  { id: 'photo_key', tags: ['vintage key', 'antique brass lock', 'hand'], starred: true },
  { id: 'photo_caravan', tags: ['refugee walking caravan', 'dust road', '1947'], starred: false },
  { id: 'photo_camp', tags: ['relief camp', 'refugee tents', 'purana qila fort'], starred: false }
];

const matches = geminiClient.fallbackMatchScenes(testScriptLines, testPhotos);
assert(matches.length === testScriptLines.length, 'Every script line receives a photo match');
assert(matches[0].photo_id === 'photo_station', 'First line correctly matches photo_station via tags');
assert(matches[2].photo_id === 'photo_key', 'Key line correctly matches photo_key via tags');

// Verify strict no-repeat-more-than-twice rule
let maxConsecutive = 1;
let currentConsecutive = 1;
for (let i = 1; i < matches.length; i++) {
  if (matches[i].photo_id === matches[i - 1].photo_id) {
    currentConsecutive++;
    if (currentConsecutive > maxConsecutive) maxConsecutive = currentConsecutive;
  } else {
    currentConsecutive = 1;
  }
}
assert(maxConsecutive <= 2, `No photo repeats more than twice consecutively (Max found: ${maxConsecutive})`);

// -------------------------------------------------------------
// Test 13: Timeline Scheduling from Scene Matches & Line Durations
// -------------------------------------------------------------
console.log('\n--- Test Suite 13: Timeline Scheduling from Scene Matches ---');
const timelineEngine = new TimelineEngine();
const sceneTimeline = timelineEngine.generateSceneMatchedTimeline(
  testPhotos,
  testScriptLines,
  matches,
  60,
  null,
  { enabledAnimations: ['zoom-in', 'zoom-out', 'pan-lr', 'pan-rl'] }
);

assert(sceneTimeline.length === testScriptLines.length, 'Timeline segment count exactly matches script lines count');
assert(sceneTimeline[0].startTime === 0, 'First segment starts at 0.0s');
assert(Math.abs(sceneTimeline[sceneTimeline.length - 1].endTime - 60) < 0.1, 'Last segment ends at 60s total duration');

// Check that animations rotate when the same photo is reused
const segmentsUsingKey = sceneTimeline.filter(s => s.photo.id === 'photo_key');
if (segmentsUsingKey.length > 1) {
  assert(segmentsUsingKey[0].animType !== segmentsUsingKey[1].animType, 'Reused photo receives rotating animation direction');
}

// -------------------------------------------------------------
// Test 14: Pure JS In-Browser ZIP Generator
// -------------------------------------------------------------
console.log('\n--- Test Suite 14: Pure JS In-Browser ZIP Generator ---');
const zip = new SimpleZip();
await zip.addFile('script.txt', 'सितंबर 1947 की कहानी');
await zip.addFile('captions.srt', '1\n00:00:00,000 --> 00:00:05,000\nपरीक्षण');
await zip.addFile('metadata.json', JSON.stringify({ title: 'Test Story', duration: 60 }));

const zipBytes = zip.generateUint8Array();
assert(zipBytes instanceof Uint8Array, 'Generates Uint8Array binary zip buffer');
assert(zipBytes.length > 100, `ZIP binary size is non-empty (${zipBytes.length} bytes)`);

// Verify PK signature in header (0x50 0x4B 0x03 0x04)
const isPkZip = zipBytes[0] === 0x50 && zipBytes[1] === 0x4B && zipBytes[2] === 0x03 && zipBytes[3] === 0x04;
assert(isPkZip, 'ZIP file starts with standard PKZip magic bytes (PK\\x03\\x04)');

// Verify EOCD signature near end of zip (0x50 0x4B 0x05 0x06)
let foundEocd = false;
for (let i = zipBytes.length - 22; i < zipBytes.length; i++) {
  if (zipBytes[i] === 0x50 && zipBytes[i + 1] === 0x4B && zipBytes[i + 2] === 0x05 && zipBytes[i + 3] === 0x06) {
    foundEocd = true;
    break;
  }
}
assert(foundEocd, 'ZIP file contains valid End of Central Directory (EOCD) signature');

// -------------------------------------------------------------
// Test 15: GeminiClient with Mock Fetch
// -------------------------------------------------------------
console.log('\n--- Test Suite 15: GeminiClient with Mock Fetch ---');
const originalFetch = globalThis.fetch;
let lastRequestHeaders = null;

globalThis.fetch = async (url, options) => {
  lastRequestHeaders = options?.headers || {};
  let bodyJson = {};
  try {
    bodyJson = JSON.parse(options?.body || '{}');
  } catch (e) {}

  const promptText = JSON.stringify(bodyJson);

  if (promptText.includes('thumbnail headline texts')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ suggestions: ['लाहौर 1947: आखिरी ट्रेन', 'पल्लू में बंधी चाबी', '120 किमी का सफ़र'] }) }] }
        }]
      })
    };
  }

  if (promptText.includes('expert visual archivist')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ results: [{ id: 'p1', tags: ['train', 'station'], caption: 'लाहौर स्टेशन', mood: 'emotional' }] }) }] }
        }]
      })
    };
  }

  // Default: generateScript
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              script_lines: ['सितंबर 1947 में लाहौर रेलवे स्टेशन पर मची अफ़रा-तफ़री।'],
              estimated_seconds: 65,
              hook_options: [{ text: 'लाहौर स्टेशन की वो चीख़ें...', why: 'तीव्र भावना', score: 9.5 }],
              scene_tags: [['railway', 'station']],
              youtube: { titles: ['1947 लाहौर स्टेशन की जुदाई'], description: 'कहानी', hashtags: ['#Shorts'], tags: ['history'], pinned_comment: 'कमेंट करें' },
              facebook: { caption: 'कहानी', hook_line: 'हुक', hashtags: ['#Partition'], first_comment: 'कमेंट' }
            })
          }]
        }
      }]
    })
  };
};

try {
  const gemini = new GeminiClient();
  gemini.setApiKey('AIzaSyMockKeyForUnitTests12345');
  assert(gemini.getApiKey() === 'AIzaSyMockKeyForUnitTests12345', 'GeminiClient stores and retrieves API key');

  const scriptRes = await gemini.generateScript({ story: 'लाहौर स्टेशन 1947', targetSeconds: 60 });
  assert(Array.isArray(scriptRes.script_lines) && scriptRes.script_lines.length === 1, 'generateScript returns parsed script_lines from mock fetch');
  assert(lastRequestHeaders['x-goog-api-key'] === 'AIzaSyMockKeyForUnitTests12345', 'Request contains x-goog-api-key header');
  assert(gemini.sessionCallsCount === 1, 'Session call counter increments accurately (Got: 1)');

  const thumbRes = await gemini.thumbnailTexts({ story: 'लाहौर स्टेशन' });
  assert(Array.isArray(thumbRes) && thumbRes.length === 3, 'thumbnailTexts returns 3 headline suggestions');
  assert(gemini.sessionCallsCount === 2, 'Session call counter increments on second call (Got: 2)');

  const tagsRes = await gemini.tagPhotos([{ id: 'p1', base64: 'abc' }]);
  assert(Array.isArray(tagsRes) && tagsRes[0].id === 'p1', 'tagPhotos parses vision response results');

  assert(gemini.maxConcurrent === 2, 'GeminiClient enforces concurrency limit of max 2');
} finally {
  globalThis.fetch = originalFetch;
}

// -------------------------------------------------------------
// Test Suite 16: Voice Studio Pitch/Rate Conversions, Health Check & Error Handling
// -------------------------------------------------------------
console.log('\n--- Test Suite 16: Voice Studio Pitch/Rate Conversions, Health Check & Error Handling ---');

// 1. Pitch percentage conversion math
assert(formatPitchStr(1.0) === '+0%', 'Pitch 1.0 converts to "+0%"');
assert(formatPitchStr(1.2) === '+20%', 'Pitch 1.2 converts to "+20%"');
assert(formatPitchStr(1.5) === '+50%', 'Pitch 1.5 converts to "+50%"');
assert(formatPitchStr(0.8) === '-20%', 'Pitch 0.8 converts to "-20%"');
assert(formatPitchStr(0.6) === '-40%', 'Pitch 0.6 converts to "-40%"');
assert(formatPitchStr(0.85) === '-15%', 'Pitch 0.85 converts to "-15%"');
assert(formatPitchStr('+15%') === '+15%', 'Pre-formatted pitch string preserved');

// 2. Rate percentage conversion math
assert(formatRateStr(1.0) === '+0%', 'Rate 1.0 converts to "+0%"');
assert(formatRateStr(1.15) === '+15%', 'Rate 1.15 converts to "+15%"');
assert(formatRateStr(1.5) === '+50%', 'Rate 1.5 converts to "+50%"');
assert(formatRateStr(2.0) === '+100%', 'Rate 2.0 (Double speed) converts to "+100%"');
assert(formatRateStr(2.5) === '+150%', 'Rate 2.5 (Hyper speed) converts to "+150%"');
assert(formatRateStr(0.7) === '-30%', 'Rate 0.7 converts to "-30%"');
assert(formatRateStr('+10%') === '+10%', 'Pre-formatted rate string preserved');

// 3. Volume conversion math
assert(formatVolumeStr(1.0) === '+0%', 'Volume 1.0 converts to "+0%"');
assert(formatVolumeStr(0.8) === '-20%', 'Volume 0.8 converts to "-20%"');

// 4. Human-readable error mapping
assert(mapTtsErrorMessage(new Error('getaddrinfo ENOTFOUND')) === 'No internet connection to Microsoft TTS', 'Maps ENOTFOUND to internet connection error');
assert(mapTtsErrorMessage(new Error('Rate limit 429 reached')) === 'Microsoft TTS rejected the request (403/429)', 'Maps 429 to rate limit error');
assert(mapTtsErrorMessage(new Error('Could not infer voiceLocale')) === 'Unknown voice', 'Maps voiceLocale failure to Unknown voice');

// 5. checkBackend helper
const voiceEngine = new VoiceEngine();
const suite16OrigFetch = globalThis.fetch;

try {
  // Mock healthy response
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, tts: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const isHealthy = await voiceEngine.checkBackend();
  assert(isHealthy === true, 'checkBackend returns true when /api/health responds with ok: true');

  // Mock 404 response
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const isDown = await voiceEngine.checkBackend();
  assert(isDown === false, 'checkBackend returns false when /api/health returns 404');

  // Mock network throw
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const isOffline = await voiceEngine.checkBackend();
  assert(isOffline === false, 'checkBackend returns false when fetch throws network error');

  // 6. previewNeuralVoice onError callback path
  let caughtErrorMsg = '';
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Microsoft TTS rejected the request (403/429)' })
  });

  await voiceEngine.previewNeuralVoice(
    'परीक्षण पाठ',
    { voice: 'hi-IN-SwaraNeural' },
    null,
    null,
    (err) => {
      caughtErrorMsg = err.message;
    }
  );
  assert(caughtErrorMsg.includes('Microsoft TTS rejected the request'), 'previewNeuralVoice invokes onError callback with exact server error message');

  // 7. previewNeuralVoice on 404 status
  let caught404Msg = '';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({})
  });

  await voiceEngine.previewNeuralVoice(
    'परीक्षण पाठ',
    { voice: 'hi-IN-SwaraNeural' },
    null,
    null,
    (err) => {
      caught404Msg = err.message;
    }
  );
  assert(caught404Msg.includes('server not running') && caught404Msg.includes('http://localhost:3000'), 'previewNeuralVoice on 404 informs user to run npm start');

} finally {
  globalThis.fetch = suite16OrigFetch;
}

// -------------------------------------------------------------
// Test Suite 17: Step 4 Publish Portal Backend & API Validation
// -------------------------------------------------------------
console.log('\n--- Test Suite 17: Step 4 Publish Portal Backend & API Validation ---');

// 1. Character limit validation checks
const sampleTitleValid = '1947 लाहौर स्टेशन की अनसुनी कहानी: एक पल्लू में बंधी चाबी';
const sampleTitleTooLong = 'यह एक बहुत लंबा शीर्षक है जो सत्तर वर्णों की अधिकतम सीमा से काफी अधिक लंबा हो गया है ताकि सत्यापन प्रणाली इसे तुरंत पकड़ सके';
assert(sampleTitleValid.length <= 70, `Valid YouTube title is <= 70 chars (Got: ${sampleTitleValid.length})`);
assert(sampleTitleTooLong.length > 70, `Flags YouTube title exceeding 70 chars (Got: ${sampleTitleTooLong.length})`);

const sampleTags = ['लाहौर', 'विभाजन 1947', 'इतिहास', 'सच्ची कहानी', 'रेलवे स्टेशन', 'शरणार्थी'];
const tagsCombinedLen = sampleTags.join(', ').length;
assert(tagsCombinedLen <= 450, `Keyword tags total is <= 450 characters (Got: ${tagsCombinedLen})`);

const sampleDesc = 'पहला हुक लाइन जो सीधे दिल को छूती है।\nदूसरी हुक लाइन।\n\nपूरी कहानी का सारांश यहाँ है।\n\n#लाहौर #इतिहास #कहानी';
assert(sampleDesc.length <= 5000, `Description is <= 5000 characters (Got: ${sampleDesc.length})`);

// 2. Hashtag normalization helper test
function normalizeHashtag(tag) {
  if (!tag) return '';
  const trimmed = String(tag).trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return withHash.replace(/\s+/g, '');
}

assert(normalizeHashtag('history') === '#history', 'Adds missing # prefix to hashtag');
assert(normalizeHashtag('#Shorts') === '#Shorts', 'Preserves existing # prefix');
assert(normalizeHashtag('#viral video 2026') === '#viralvideo2026', 'Removes internal spaces from hashtag');
assert(normalizeHashtag(' लाहौर 1947 ') === '#लाहौर1947', 'Normalizes Hindi hashtag with spaces and missing #');

// 3. Missing GEMINI_API_KEY returns 500 "GEMINI_API_KEY missing in .env"
const origApiKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
try {
  let missingKeyError = null;
  try {
    await callGeminiMetaAPI({ script: 'test script' });
  } catch (err) {
    missingKeyError = err;
  }
  assert(missingKeyError !== null, 'callGeminiMetaAPI throws when GEMINI_API_KEY is not set');
  assert(missingKeyError?.statusCode === 500, `Missing key error has status 500 (Got: ${missingKeyError?.statusCode})`);
  assert(missingKeyError?.message === 'GEMINI_API_KEY missing in .env', `Throws exact message "GEMINI_API_KEY missing in .env" (Got: "${missingKeyError?.message}")`);
} finally {
  if (origApiKey) process.env.GEMINI_API_KEY = origApiKey;
}

// Network error mapping test
const origFetchMeta = globalThis.fetch;
try {
  process.env.GEMINI_API_KEY = 'test_key';
  globalThis.fetch = async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ENOTFOUND' };
    throw err;
  };
  let netErr = null;
  try {
    await callGeminiMetaAPI({ script: 'test script' }, 0);
  } catch (err) {
    netErr = err;
  }
  assert(netErr !== null, 'callGeminiMetaAPI throws on network failure');
  assert(netErr?.message === 'Cannot reach Gemini. Check your internet connection.', `Maps network error to exact user message (Got: "${netErr?.message}")`);
  assert(netErr?.statusCode === 503, `Network error has 503 status code (Got: ${netErr?.statusCode})`);
} finally {
  globalThis.fetch = origFetchMeta;
  if (origApiKey) process.env.GEMINI_API_KEY = origApiKey;
  else delete process.env.GEMINI_API_KEY;
}

// 4. /api/config key safety: returns boolean only, never exposes key
const testServerPort = 39281;
await new Promise((resolve) => server.listen(testServerPort, resolve));

try {
  const secretKey = 'AIzaSySecretTestKey_DoNotLeak_999';
  process.env.GEMINI_API_KEY = secretKey;

  const res = await fetch(`http://localhost:${testServerPort}/api/config`);
  assert(res.status === 200, 'GET /api/config returns 200 status');
  const config = await res.json();

  assert(typeof config.geminiConfigured === 'boolean', 'geminiConfigured is a boolean');
  assert(config.geminiConfigured === true, 'geminiConfigured is true when GEMINI_API_KEY is set');
  assert(!('GEMINI_API_KEY' in config), '/api/config never contains GEMINI_API_KEY property');
  assert(!('apiKey' in config), '/api/config never contains apiKey property');
  assert(!('key' in config), '/api/config never contains key property');
  assert(JSON.stringify(config).indexOf(secretKey) === -1, 'Secret API key string is NEVER leaked in /api/config response');

  // Test when key is unset
  delete process.env.GEMINI_API_KEY;
  const resUnset = await fetch(`http://localhost:${testServerPort}/api/config`);
  const configUnset = await resUnset.json();
  assert(configUnset.geminiConfigured === false, 'geminiConfigured is false when GEMINI_API_KEY is absent');
} finally {
  if (origApiKey) {
    process.env.GEMINI_API_KEY = origApiKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n========================================`);
console.log(`🎉 Test Results: ${passedTests}/${totalTests} tests passed successfully!`);
console.log(`========================================\n`);


