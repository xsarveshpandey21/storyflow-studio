# StoryFlow Studio 🎬

> **Hindi-First Video Storytelling & Publish Portal Studio**  
> Transform raw stories and video footage into narrated, captioned, Ken Burns-animated videos in 16:9 and 9:16 formats, with ready-to-post YouTube and Facebook metadata generated securely via Google Gemini.

**Client-Side ES Modules &middot; WebCodecs & Web Audio &middot; Node.js Backend &middot; Secure .env Gemini Integration**  
Target Browsers: **Microsoft Edge** (Recommended) and **Google Chrome** on Desktop, Laptop, and Mobile.

---

## 🌟 4-Step Guided Creation Workflow

1. **Step 1: Source & Frames:** Upload footage (.mp4, .webm), generate 1-minute test sample videos, extract stratified frames (15–20/min), or upload photo files directly.
2. **Step 2: Voice & Script:** Write or paste your Hindi/English story script, record your voice, upload audio, or synthesize realistic speech using Microsoft Edge Neural TTS (`hi-IN-SwaraNeural`).
3. **Step 3: Studio & Export:** Review the live canvas player with Ken Burns motion, customize subtitle typography, aspect ratios (16:9 Landscape / 9:16 Vertical), and export high-resolution WebCodecs MP4 video or an all-in-one ZIP.
4. **Step 4: Publish Portal:** One-click generation of viral, copy-paste-ready metadata for YouTube and Facebook powered by Gemini from your script.

---

## 🚀 How to Run

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup (.env)
Copy `.env.example` to `.env` and set your Google Gemini API key:
```bash
cp .env.example .env
```

Edit `.env`:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```
> **Security Note:** The Gemini API key remains strictly on the server in `.env`. The client browser never receives or exposes the key.

### 3. Build the Application
```bash
npm run build
```

### 4. Start the Server
Run the app using `npm start` (do **not** run via `python -m http.server`, as Node is required for Neural TTS and server-side metadata generation):
```bash
npm start
```
This runs `node server.js` which:
- Serves the application at: **`http://localhost:3000`**
- Exposes `GET /api/config` (reports `{ geminiConfigured: true|false }` without leaking keys)
- Exposes `POST /api/generate-meta` (proxies requests to Gemini REST API with schema validation, retries, and error mapping)
- Exposes `POST /api/tts` (high-quality Microsoft Edge Neural TTS)

### 5. Run Tests
```bash
# Run unit tests (sampling, math, limits, hashtag normalization, key safety)
npm test

# Run full end-to-end browser smoke test (Playwright)
npm run test:smoke

# Run all test suites
npm run test:all
```

---

## 📱 Step 4: Publish Portal Features

- **Script Used Summary:** Read-only summary showing word count, first 2 lines snippet, and a one-click *"Edit script"* link navigating back to Step 2. If the script is empty, generation is disabled with a friendly notice.
- **Script Changed Detection:** If you edit your narration in Step 2 after generating, Step 4 flags *"Script changed - regenerate?"* with an instant Regenerate button.
- **Script Keyword Match Badge:** Calculates overlap between script keywords and generated output (e.g. `🎯 Keyword match 8/10 (80% match)`).
- **Settings Row:**
  - Language: Hindi (Devanagari), English, Hinglish, Auto-detect from script
  - Tone: Curious / Viral, Emotional, Educational, Dramatic, Funny
  - Video Type: Shorts / Reel (Vertical) or Long video (16:9)
  - Niche / Topic and Target Audience inputs
  - Platform Toggle: YouTube, Facebook, or Both
- **YouTube Tab:**
  - 5 curiosity-driven titles (each $\le$ 70 chars) with radio selection and live counter
  - Description ($\le$ 5000 chars) with 2-line hook before "Show more", summary, CTA, and 3-5 hashtags at end
  - Editable hashtag chips (8-12 tags, space-separated copy, includes `#Shorts` for Shorts)
  - Keyword tags ($\le$ 450 chars combined) with live counter
  - Pinned comment for viewer engagement
  - Individual Copy buttons with "Copied ✓" feedback, "Copy All", Download `.txt`, and direct link to YouTube Studio Upload
- **Facebook Tab:**
  - 3 headline options ($\le$ 100 chars)
  - Post text with first-line hook (~125 chars before "See more"), emojis, CTA, 3-5 hashtags
  - Video title and description fields for Reels/video uploads
  - Editable hashtag chips (5-8 tags)
  - First comment for link sharing and reach
  - Individual Copy buttons, "Copy All", Download `.txt`, and direct links to Facebook Composer & Creator Studio

---

## 🔒 Security Architecture
- **Server-Managed Key:** `GEMINI_API_KEY` is loaded on the Node server and never sent to client JavaScript or stored in `localStorage`.
- **Key Safety Endpoint:** `GET /api/config` returns only `{ geminiConfigured: true|false }` and never outputs the key string.
- **Project Export Sanitization:** Project JSON files and ZIP bundles contain only public metadata, never secrets.
- **Strict Error Handling:** 500 when key is missing in `.env`, 401/403 for invalid keys, 429 for rate limits, 502 for upstream failures.
- **Request Body Capping:** Request payloads to `/api/generate-meta` are capped at 1 MB.
