const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const createYtDlpAsProcess = require('@alpacamybags118/yt-dlp-exec');
const sanitizeHtml = require('sanitize-html');

const app = express();
const port = process.env.PORT || 3000; // Use Render's PORT or fallback to 3000

// Middleware
app.use(cors({ origin: ['http://localhost:3000', 'https://tonify-di49.onrender.com'] }));
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Debug logging for static file serving
app.use(express.static(path.join(__dirname), { index: false }));
app.get('/', async (req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  try {
    await fs.access(filePath);
    console.log(`Serving index.html from ${filePath}`);
    res.sendFile(filePath);
  } catch (err) {
    console.error(`Error serving index.html: ${err.message}`);
    res.status(404).send('Cannot GET /: index.html not found');
  }
});

// Create downloads folder if it doesn't exist
async function ensureDownloadsFolder() {
  try {
    await fs.mkdir(path.join(__dirname, 'downloads'), { recursive: true });
    console.log('Downloads folder ready');
  } catch (err) {
    console.error('Error creating downloads folder:', err);
  }
}
ensureDownloadsFolder();

// Check if cookies.txt exists
async function getCookiesOption() {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  try {
    await fs.access(cookiesPath);
    console.log('Cookies file found, will use if needed');
    return cookiesPath;
  } catch {
    console.log('Cookies file not found, proceeding without cookies');
    return null;
  }
}

// Validate and sanitize URL
function isValidUrl(url) {
  const urlPattern = /^(https?:\/\/)(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com)\/.+$/;
  const sanitizedUrl = sanitizeHtml(url, { allowedTags: [], allowedAttributes: {} });
  return urlPattern.test(sanitizedUrl) ? sanitizedUrl : null;
}

// Endpoint for file size estimation
app.post('/size', async (req, res) => {
  let { url, format } = req.body;
  if (!url || !format) {
    return res.status(400).json({ error: 'URL and format are required' });
  }

  url = isValidUrl(url);
  if (!url) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['mp3', 'mp4'].includes(format)) {
    return res.status(400).json({ error: 'Invalid format. Use mp3 or mp4' });
  }

  try {
    const cookies = await getCookiesOption();
    const options = {
      dumpSingleJson: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
    // Try without cookies first
    let proc = createYtDlpAsProcess(url, options);
    let { stdout, stderr } = await proc.catch(async (err) => {
      console.error('Size estimation error without cookies:', err.message, stderr || '');
      if (cookies && err.message.includes('Sign in')) {
        console.log('Retrying with cookies...');
        options.cookies = cookies;
        proc = createYtDlpAsProcess(url, options);
        return await proc;
      }
      throw err;
    });
    const info = JSON.parse(stdout);

    let selectedFormat;
    if (format === 'mp3') {
      selectedFormat = info.formats
        .filter(f => f.vcodec === 'none' && f.abr)
        .sort((a, b) => b.abr - a.abr)[0];
    } else {
      selectedFormat = info.formats
        .filter(f => f.vcodec !== 'none' && f.height)
        .sort((a, b) => b.height - a.height)[0];
    }

    if (!selectedFormat) {
      throw new Error('No suitable format found');
    }

    const size = (selectedFormat.filesize_approx || selectedFormat.filesize || 0) / (1024 * 1024); // Convert to MB
    res.json({ size: size.toFixed(2) });
  } catch (err) {
    console.error('Size estimation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to estimate file size. Try checking URL or updating cookies.txt.' });
  }
});

// Endpoint for getting video URL for preview
app.post('/get-video-url', async (req, res) => {
  let { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  url = isValidUrl(url);
  if (!url) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const cookies = await getCookiesOption();
    const options = {
      getUrl: true,
      f: 'bestvideo[ext=mp4]',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
    let proc = createYtDlpAsProcess(url, options);
    let { stdout, stderr } = await proc.catch(async (err) => {
      console.error('Video URL error without cookies:', err.message, stderr || '');
      if (cookies && err.message.includes('Sign in')) {
        console.log('Retrying with cookies...');
        options.cookies = cookies;
        proc = createYtDlpAsProcess(url, options);
        return await proc;
      }
      throw err;
    });
    const videoUrl = stdout.trim();
    if (!videoUrl) {
      throw new Error('No video URL found');
    }
    res.json({ videoUrl });
  } catch (err) {
    console.error('Video URL error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to retrieve video URL. Try checking URL or updating cookies.txt.' });
  }
});

// Endpoint for download with SSE progress
app.get('/api/download', async (req, res) => {
  let { url, format = 'mp4' } = req.query;
  if (!url) {
    res.write(`data: ${JSON.stringify({ error: 'URL is required' })}\n\n`);
    return res.end();
  }

  url = isValidUrl(url);
  if (!url) {
    res.write(`data: ${JSON.stringify({ error: 'Invalid URL' })}\n\n`);
    return res.end();
  }
  if (!['mp3', 'mp4'].includes(format)) {
    res.write(`data: ${JSON.stringify({ error: 'Invalid format. Use mp3 or mp4' })}\n\n`);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const fileName = `${Date.now()}.${format}`;
  const filePath = path.join(__dirname, 'downloads', fileName);

  const ytFormat = format === 'mp3' ? 'bestaudio' : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  const cookies = await getCookiesOption();
  const options = {
    o: filePath,
    f: ytFormat,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  };
  if (format === 'mp3') {
    options.extractAudio = true;
    options.audioFormat = 'mp3';
  }

  try {
    // Try download without cookies first
    let proc = createYtDlpAsProcess(url, options, { stdio: ['ignore', 'pipe', 'pipe'] });
    let isRetryingWithCookies = false;

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/\[download\]\s*(\d+\.\d+)%(?:\s*of\s*[\d.]+\w+)?(?:\s*at\s*[\d.]+\w+)?/i) ||
                     line.match(/(\d+\.\d+)%\s*of\s*[\d.]+\w+/i) ||
                     line.match(/\[download\]\s*(\d+\.\d+)%/i);
        if (match) {
          const progress = parseFloat(match[1]);
          console.log(`Progress: ${progress}%`);
          res.write(`data: ${JSON.stringify({ progress })}\n\n`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error('yt-dlp stderr:', chunk.toString());
    });

    proc.on('error', async (err) => {
      if (cookies && !isRetryingWithCookies && err.message.includes('Sign in')) {
        console.log('Download failed without cookies, retrying with cookies...');
        isRetryingWithCookies = true;
        options.cookies = cookies;
        proc = createYtDlpAsProcess(url, options, { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const match = line.match(/\[download\]\s*(\d+\.\d+)%(?:\s*of\s*[\d.]+\w+)?(?:\s*at\s*[\d.]+\w+)?/i) ||
                         line.match(/(\d+\.\d+)%\s*of\s*[\d.]+\w+/i) ||
                         line.match(/\[download\]\s*(\d+\.\d+)%/i);
            if (match) {
              const progress = parseFloat(match[1]);
              console.log(`Progress (with cookies): ${progress}%`);
              res.write(`data: ${JSON.stringify({ progress })}\n\n`);
            }
          }
        });

        proc.stderr.on('data', (chunk) => {
          console.error('yt-dlp stderr (with cookies):', chunk.toString());
        });

        proc.on('close', async (code) => {
          if (code === 0) {
            res.write(`data: ${JSON.stringify({ status: 'completed', file: `/downloads/${fileName}` })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ error: 'Download failed with cookies. Check cookies or URL.' })}\n\n`);
          }
          res.end();
        });

        proc.on('error', (err) => {
          console.error('Download error with cookies:', err.message);
          res.write(`data: ${JSON.stringify({ error: err.message || 'Download process error with cookies.' })}\n\n`);
          res.end();
        });
      } else {
        console.error('Download error:', err.message);
        res.write(`data: ${JSON.stringify({ error: err.message || 'Download process error. Try checking URL.' })}\n\n`);
        res.end();
      }
    });

    proc.on('close', async (code) => {
      if (code === 0 && !isRetryingWithCookies) {
        res.write(`data: ${JSON.stringify({ status: 'completed', file: `/downloads/${fileName}` })}\n\n`);
        res.end();
      }
    });
  } catch (err) {
    console.error('Download initialization error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Failed to start download. Try checking URL.' })}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
