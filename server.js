'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// ─── yt-dlp-wrap supports both ESM and CJS exports ───────────────────────────
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;

// Point fluent-ffmpeg at the bundled static binary
ffmpeg.setFfmpegPath(ffmpegPath);

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const MAX_DURATION  = 2700;          // 45 minutes in seconds
const FILE_TTL_MS   = 30 * 60 * 1000; // 30 minutes safety-net expiry

// yt-dlp binary path (cross-platform)
const YT_DLP_BIN = path.join(
  os.tmpdir(),
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store: id → { outputFile, title, expiresAt }
const pendingDownloads = new Map();

// ─── HTML helper ─────────────────────────────────────────────────────────────
function renderPage(pageTitle, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Convert YouTube videos to 3GP audio files for old phones — no JavaScript required.">
  <title>${pageTitle}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="page">
    <div class="container">
      ${bodyContent}
    </div>
  </div>
</body>
</html>`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET / — Home form page
app.get('/', (req, res) => {
  const error   = req.query.error   ? decodeURIComponent(req.query.error)   : null;

  const errorBlock = error
    ? `<div class="alert alert--error" role="alert">
         <span class="alert__icon">⚠</span>
         <span>${escapeHtml(error)}</span>
       </div>`
    : '';

  const body = `
    <div class="card">
      <div class="card__header">
        <div class="logo-icon">▶</div>
        <h1 class="card__title">YouTube <span class="arrow">→</span> 3GP</h1>
        <p class="card__subtitle">Audio converter for your phone</p>
      </div>

      ${errorBlock}

      <form method="POST" action="/convert" class="form" id="convert-form">
        <div class="field">
          <label class="field__label" for="url">YouTube URL</label>
          <input
            class="field__input"
            type="url"
            id="url"
            name="url"
            placeholder="https://youtube.com/watch?v=..."
            required
            autocomplete="off"
            spellcheck="false"
          >
        </div>

        <p class="form__hint">Max 45 minutes &nbsp;·&nbsp; Audio only &nbsp;·&nbsp; 3GP / AAC 128 kbps</p>

        <button class="btn btn--primary" type="submit" id="submit-btn" onclick="var b=this; setTimeout(function(){ b.disabled=true; b.style.opacity='0.6'; b.style.cursor='not-allowed'; b.innerHTML='Converting... ⏳'; }, 10)">
          <span class="btn__icon">⬇</span>
          Convert &amp; Download
        </button>
      </form>

      <p class="footer-note">
        Processing takes 20–60 seconds.<br>
        Please wait after clicking the button.
      </p>
    </div>`;

  res.send(renderPage('YouTube → 3GP Audio Converter', body));
});

// POST /convert — Validate, download, convert, redirect to ready page
app.post('/convert', async (req, res) => {
  const rawUrl = (req.body.url || '').trim();

  const bail = (msg) =>
    res.redirect('/?error=' + encodeURIComponent(msg));

  // ── 1. Basic validation ────────────────────────────────────────────────────
  if (!rawUrl) {
    return bail('Please enter a YouTube URL.');
  }

  const ytPattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?.*v=[\w-]{11}|youtu\.be\/[\w-]{11})/;
  if (!ytPattern.test(rawUrl)) {
    return bail('Invalid YouTube URL. Please use a youtube.com or youtu.be link.');
  }

  let ytDlp;
  try {
    ytDlp = new YTDlpWrap(YT_DLP_BIN);
  } catch {
    return bail('Server not ready yet. Please try again in a few seconds.');
  }

  // ── 2. Fetch metadata (no download) ───────────────────────────────────────
  let info;
  try {
    info = await ytDlp.getVideoInfo(rawUrl);
  } catch (err) {
    console.error('getVideoInfo error:', err.message);
    return bail('Could not fetch video info. The video may be private, age-restricted, or unavailable.');
  }

  // ── 3. Duration guard ─────────────────────────────────────────────────────
  if (info.duration > MAX_DURATION) {
    const mins = Math.ceil(info.duration / 60);
    return bail(`Video is too long (${mins} min). Maximum is 45 minutes.`);
  }

  // ── 4. Prepare temp paths ─────────────────────────────────────────────────
  const id        = crypto.randomBytes(10).toString('hex');
  const safeTitle = sanitizeTitle(info.title || 'audio');
  const inputBase = path.join(os.tmpdir(), `yt_in_${id}`);
  const outputFile = path.join(os.tmpdir(), `yt_out_${id}.3gp`);

  // ── 5. Download best audio stream ─────────────────────────────────────────
  try {
    await ytDlp.execPromise([
      rawUrl,
      '-f', 'worstaudio',
      '-o', `${inputBase}.%(ext)s`,
      '--no-playlist',
      '--quiet',
      '--no-warnings'
    ]);
  } catch (err) {
    console.error('yt-dlp download error:', err.message);
    return bail('Download failed. The video might be unavailable in your region.');
  }

  // Find the file yt-dlp created (extension varies: webm, m4a, opus…)
  const tmpContents   = fs.readdirSync(os.tmpdir());
  const downloadedName = tmpContents.find((f) => f.startsWith(`yt_in_${id}.`));

  if (!downloadedName) {
    return bail('Download produced no file. Please try again.');
  }

  const inputFile = path.join(os.tmpdir(), downloadedName);

  // ── 6. Convert to 3GP (AAC, medium quality) ───────────────────────────────
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .noVideo()
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .audioChannels(1)
        .format('3gp')
        .on('end', resolve)
        .on('error', reject)
        .save(outputFile);
    });
  } catch (err) {
    console.error('ffmpeg error:', err.message);
    fs.unlink(inputFile, () => {});
    return bail('Audio conversion failed. Please try again.');
  }

  // Clean up input file immediately — output stays until downloaded
  fs.unlink(inputFile, () => {});

  // ── 7. Register in pending store + auto-expiry ────────────────────────────
  pendingDownloads.set(id, { outputFile, title: safeTitle });

  setTimeout(() => {
    const entry = pendingDownloads.get(id);
    if (entry) {
      fs.unlink(entry.outputFile, () => {});
      pendingDownloads.delete(id);
    }
  }, FILE_TTL_MS);

  // ── 8. Redirect to "ready" page ───────────────────────────────────────────
  res.redirect(`/ready?id=${id}&title=${encodeURIComponent(safeTitle)}`);
});

// GET /ready — "Your file is ready" page with a plain <a> download link
app.get('/ready', (req, res) => {
  const { id, title } = req.query;

  if (!id || !pendingDownloads.has(id)) {
    return res.redirect('/?error=Download+link+not+found+or+expired.+Please+convert+again.');
  }

  const displayTitle = title ? decodeURIComponent(title).replace(/_/g, ' ') : 'audio';

  const body = `
    <div class="card card--success">
      <div class="card__header">
        <div class="logo-icon logo-icon--success">✓</div>
        <h1 class="card__title">Ready!</h1>
        <p class="card__subtitle">${escapeHtml(displayTitle)}</p>
      </div>

      <div class="badges">
        <span class="badge">3GP</span>
        <span class="badge">AAC Audio</span>
        <span class="badge">128 kbps</span>
      </div>

      <a
        class="btn btn--primary btn--download"
        href="/download?id=${encodeURIComponent(id)}"
        id="download-link"
      >
        <span class="btn__icon">⬇</span>
        Download 3GP File
      </a>

      <div class="divider"></div>

      <a class="btn btn--secondary" href="/" id="back-link">
        ← Convert another video
      </a>

      <p class="footer-note">Link expires in 30 minutes.</p>
    </div>`;

  res.send(renderPage('Download Ready — YouTube 3GP Converter', body));
});

// GET /download — Stream the file, then delete it
app.get('/download', (req, res) => {
  const { id } = req.query;

  if (!id || !pendingDownloads.has(id)) {
    return res.redirect('/?error=Download+not+found+or+expired.+Please+convert+again.');
  }

  const entry = pendingDownloads.get(id);

  if (!fs.existsSync(entry.outputFile)) {
    pendingDownloads.delete(id);
    return res.redirect('/?error=File+missing+from+server.+Please+convert+again.');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${entry.title}.3gp"`);
  res.setHeader('Content-Type', 'audio/3gpp');

  const stream = fs.createReadStream(entry.outputFile);
  stream.pipe(res);

  const cleanup = () => {
    fs.unlink(entry.outputFile, () => {});
    pendingDownloads.delete(id);
  };

  stream.on('close', cleanup);
  stream.on('error', cleanup);
});

// ─── Utility helpers ─────────────────────────────────────────────────────────

function sanitizeTitle(raw) {
  return raw
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 60) || 'audio';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Startup: download yt-dlp binary, then listen ───────────────────────────
async function init() {
  try {
    if (!fs.existsSync(YT_DLP_BIN)) {
      console.log('⏳ Downloading yt-dlp binary…');
      await YTDlpWrap.downloadFromGithub(YT_DLP_BIN);
      console.log('✅ yt-dlp binary downloaded.');
    } else {
      console.log('✅ yt-dlp binary found.');
    }

    // Ensure executable on Linux/macOS
    if (process.platform !== 'win32') {
      fs.chmodSync(YT_DLP_BIN, '755');
    }
  } catch (err) {
    console.error('❌ Failed to initialise yt-dlp:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
}

init();
