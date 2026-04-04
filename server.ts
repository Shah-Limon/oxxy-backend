import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────────────────
// CONSTANTS & PATHS
// ─────────────────────────────────────────

const GENERATED_DIR = path.join(process.cwd(), 'generated-content');
const DOWNLOADS_DB  = path.join(GENERATED_DIR, '_downloads.json');
const META_FILE     = path.join(GENERATED_DIR, '_meta.json');
const MAX_FILES_PER_FOLDER = 1000;

if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// ─────────────────────────────────────────
// META / FOLDER MANAGEMENT
// ─────────────────────────────────────────

interface Meta {
  activeFolder: string;   // e.g. "folder_1"
  folderCounts: Record<string, number>;
}

const readMeta = (): Meta => {
  if (!fs.existsSync(META_FILE)) {
    return { activeFolder: 'folder_1', folderCounts: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  } catch {
    return { activeFolder: 'folder_1', folderCounts: {} };
  }
};

const writeMeta = (meta: Meta) => {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
};

/**
 * Returns the path of the currently active sub-folder.
 * If it already has MAX_FILES_PER_FOLDER files, creates the next one.
 */
const getActiveSubFolder = (): string => {
  const meta = readMeta();
  let folderName = meta.activeFolder;
  let folderPath = path.join(GENERATED_DIR, folderName);

  // Ensure the folder physically exists
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    console.log(`[Folders] Created new folder: ${folderName}`);
  }

  // Count current .mdx files in that folder
  const count = fs.readdirSync(folderPath).filter(f => f.endsWith('.mdx')).length;

  if (count >= MAX_FILES_PER_FOLDER) {
    // Parse current folder number and increment
    const currentNum = parseInt(folderName.replace('folder_', ''), 10);
    const nextNum    = isNaN(currentNum) ? 2 : currentNum + 1;
    folderName       = `folder_${nextNum}`;
    folderPath       = path.join(GENERATED_DIR, folderName);

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`[Folders] Reached ${MAX_FILES_PER_FOLDER} files. Created new folder: ${folderName}`);
    }

    meta.activeFolder = folderName;
    writeMeta(meta);
  }

  return folderPath;
};

/**
 * Counts files across all sub-folders.
 */
const getAllSubFolders = (): string[] => {
  return fs.readdirSync(GENERATED_DIR).filter(name => {
    const full = path.join(GENERATED_DIR, name);
    return fs.statSync(full).isDirectory() && /^folder_\d+$/.test(name);
  }).sort((a, b) => {
    const na = parseInt(a.replace('folder_', ''), 10);
    const nb = parseInt(b.replace('folder_', ''), 10);
    return na - nb;
  });
};

/**
 * Flattened list of all .mdx files across all sub-folders.
 */
const getAllMdxFiles = (): Array<{ filename: string; folder: string; fullPath: string }> => {
  const results: Array<{ filename: string; folder: string; fullPath: string }> = [];
  for (const folder of getAllSubFolders()) {
    const folderPath = path.join(GENERATED_DIR, folder);
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.mdx'));
    for (const file of files) {
      results.push({ filename: file, folder, fullPath: path.join(folderPath, file) });
    }
  }
  return results;
};

// ─────────────────────────────────────────
// DOWNLOADS TRACKER
// ─────────────────────────────────────────

const getDownloadedTracker = (): Record<string, boolean> => {
  if (!fs.existsSync(DOWNLOADS_DB)) return {};
  try {
    return JSON.parse(fs.readFileSync(DOWNLOADS_DB, 'utf-8'));
  } catch {
    return {};
  }
};

const markAsDownloaded = (keys: string[]) => {
  const db = getDownloadedTracker();
  keys.forEach(k => (db[k] = true));
  fs.writeFileSync(DOWNLOADS_DB, JSON.stringify(db), 'utf-8');
};

// ─────────────────────────────────────────
// FILENAME HELPER
// ─────────────────────────────────────────

const generateSafeFilename = (originalFilename: string): string => {
  const baseName = path.parse(originalFilename).name.replace(/\.txt$/i, '');
  return (
    baseName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') + '.mdx'
  );
};

// ─────────────────────────────────────────
// GITHUB AUTO-PUSH
// ─────────────────────────────────────────

let isPushInProgress = false;

const configureGitIdentity = () => {
  const name  = process.env.GIT_USER_NAME  || 'OxyyBot';
  const email = process.env.GIT_USER_EMAIL || 'bot@oxyy.ai';
  try {
    execSync(`git config user.name "${name}"`,  { cwd: process.cwd(), stdio: 'pipe' });
    execSync(`git config user.email "${email}"`, { cwd: process.cwd(), stdio: 'pipe' });
  } catch {
    // ignore — may already be set globally
  }
};

const getAuthenticatedRemoteUrl = (): string | null => {
  const token   = process.env.GITHUB_TOKEN;
  const repoUrl = process.env.GITHUB_REPO_URL;
  if (!token || !repoUrl) {
    console.warn('[GitHub] GITHUB_TOKEN or GITHUB_REPO_URL not set. Skipping push.');
    return null;
  }
  // Convert https://github.com/user/repo.git → https://TOKEN@github.com/user/repo.git
  return repoUrl.replace('https://', `https://${token}@`);
};

const pushToGitHub = async (batchSize: number): Promise<void> => {
  if (isPushInProgress) return;
  isPushInProgress = true;

  let stashed = false;

  try {
    const remoteUrl = getAuthenticatedRemoteUrl();
    if (!remoteUrl) return;

    configureGitIdentity();

    const cwd = process.cwd();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Set remote with token auth (update each time in case token changed)
    execSync(`git remote set-url origin "${remoteUrl}"`, { cwd, stdio: 'pipe' });

    // Stage all changes inside generated-content/
    execSync('git add generated-content/', { cwd, stdio: 'pipe' });

    // Check if there's anything to commit
    const status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim();
    if (!status) {
      console.log('[GitHub] Nothing new to push.');
      return;
    }

    const commitMsg = `[auto] Add ${batchSize} generated files — ${timestamp}`;
    execSync(`git commit -m "${commitMsg}"`, { cwd, stdio: 'pipe' });

    // Stash any remaining unstaged changes so pull --rebase doesn't fail
    const stashOut = execSync('git stash', { cwd, stdio: 'pipe' }).toString().trim();
    stashed = !stashOut.includes('No local changes to save');

    // Pull remote changes first (rebase keeps history clean) then push
    console.log('[GitHub] Pulling remote changes before push...');
    execSync('git pull --rebase origin main', { cwd, stdio: 'pipe' });

    execSync('git push origin main', { cwd, stdio: 'pipe' });

    console.log(`[GitHub] ✅ Pushed ${batchSize} file(s) to GitHub.`);
  } catch (err: any) {
    console.error('[GitHub] ❌ Push failed:', err.message);
    // If rebase hit a conflict, abort it so next cycle starts clean
    try {
      execSync('git rebase --abort', { cwd: process.cwd(), stdio: 'pipe' });
    } catch { /* already clean */ }
  } finally {
    // Restore any stashed changes so the worker can continue writing files
    if (stashed) {
      try {
        execSync('git stash pop', { cwd: process.cwd(), stdio: 'pipe' });
      } catch { /* stash pop failed — ignore */ }
    }
    isPushInProgress = false;
  }
};

// ─────────────────────────────────────────
// AI CONTENT GENERATION
// ─────────────────────────────────────────

const getOxyyKey = (): string | undefined => {
  const apiKeys = Object.keys(process.env)
    .filter((key) => key.startsWith('OXYY_API_KEY'))
    .sort()
    .map((key) => process.env[key])
    .filter(Boolean) as string[];

  if (apiKeys.length === 0) return process.env.OXYY_API_KEY;
  return apiKeys[Math.floor(Math.random() * apiKeys.length)];
};

const EXTERNAL_API_URL = 'https://cloud-text-manager-server.vercel.app/api/all-files?limit=150';
let isWorkerRunning = false;

const generateContentWithAI = async (promptText: string): Promise<string | undefined> => {
  const apiKey = getOxyyKey();
  if (!apiKey) throw new Error('No OXYY_API_KEY configured');

  const model = process.env.OXYY_MODEL || 'gemini-2.5-pro';
  let attempt = 0;
  const MAX_RETRIES = 5;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await axios.post(
        'https://api.oxyy.ai/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: promptText }],
          temperature: 0.7,
          max_tokens: 16384,
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
        }
      );

      return await new Promise<string>((resolve, reject) => {
        let fullContent = '';
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              try {
                const data = JSON.parse(trimmed.substring(6));
                if (data.choices?.[0]?.delta?.content) {
                  fullContent += data.choices[0].delta.content;
                }
              } catch { }
            }
          }
        });

        response.data.on('end', () => {
          if (!fullContent) reject(new Error('Stream ended but generated no content.'));
          else resolve(fullContent);
        });

        response.data.on('error', (err: any) => reject(err));
      });
    } catch (error: any) {
      attempt++;
      console.log(`[Worker] Retry ${attempt}/${MAX_RETRIES} (Status: ${error?.response?.status})`);
      if (attempt >= MAX_RETRIES) throw error;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
};

// ─────────────────────────────────────────
// WORKER — PROCESS FILES
// ─────────────────────────────────────────

const CONCURRENCY_LIMIT = 50;
const BATCH_SIZE        = 50;

const processFile = async (file: any): Promise<boolean> => {
  console.log(`[Worker] Generating: ${file.originalFilename}`);
  try {
    const promptResponse = await axios.get(file.secureUrl);
    const promptText = typeof promptResponse.data === 'string'
      ? promptResponse.data
      : JSON.stringify(promptResponse.data);

    const generatedText = await generateContentWithAI(promptText);
    if (!generatedText) throw new Error('No content generated');

    // ── Folder rotation: pick (or create) the right sub-folder ──
    const activeFolder  = getActiveSubFolder();
    const safeFilename  = generateSafeFilename(file.originalFilename);
    const filePath      = path.join(activeFolder, safeFilename);

    fs.writeFileSync(filePath, generatedText, 'utf-8');
    const folderName = path.basename(activeFolder);
    console.log(`[Worker] ✅ Saved: ${folderName}/${safeFilename}`);

    await axios.put(
      `https://cloud-text-manager-server.vercel.app/api/all-files/${file._id}`,
      { status: 'AlreadyCopy', completedTimestamp: Date.now() }
    );

    return true;
  } catch (err: any) {
    console.error(`[Worker] ❌ Error for ${file.originalFilename}: ${err.message}`);
    return false;
  }
};

const runQueue = async (files: any[]): Promise<number> => {
  let index = 0;
  let successCount = 0;

  async function worker() {
    while (true) {
      if (index >= files.length) break;
      const currentIndex = index++;
      const ok = await processFile(files[currentIndex]);
      if (ok) successCount++;
    }
  }

  const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
  await Promise.all(workers);
  return successCount;
};

// ── Main polling loop ──
setInterval(async () => {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  try {
    console.log('[Worker] Checking for new topics...');
    const response     = await axios.get(EXTERNAL_API_URL);
    const pendingFiles = response.data
      .filter((f: any) => f.status === 'Pending')
      .slice(0, BATCH_SIZE);

    if (pendingFiles.length > 0) {
      console.log(`[Worker] Processing ${pendingFiles.length} files (concurrency: ${CONCURRENCY_LIMIT})...`);
      const saved = await runQueue(pendingFiles);

      // Push to GitHub after each batch
      if (saved > 0) {
        await pushToGitHub(saved);
      }
    } else {
      console.log('[Worker] No pending files found.');
    }
  } catch (error: any) {
    console.error('[Worker] Polling failed:', error.message);
  } finally {
    isWorkerRunning = false;
  }
}, 60000);

// ─────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────

// GET /api/stats — Overview of all folders
app.get('/api/stats', (_req, res) => {
  try {
    const subFolders = getAllSubFolders();
    const db         = getDownloadedTracker();
    const allFiles   = getAllMdxFiles();

    const folderStats: Record<string, number> = {};
    for (const folder of subFolders) {
      const folderPath = path.join(GENERATED_DIR, folder);
      folderStats[folder] = fs.readdirSync(folderPath).filter(f => f.endsWith('.mdx')).length;
    }

    const totalGenerated  = allFiles.length;
    const totalDownloaded = allFiles.filter(f => db[`${f.folder}/${f.filename}`]).length;

    res.json({
      totalGenerated,
      totalDownloaded,
      remaining: totalGenerated - totalDownloaded,
      folders: folderStats,
      activeFolder: readMeta().activeFolder,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/contents — Paginated list across all folders
app.get('/api/contents', (req, res) => {
  try {
    const page   = parseInt(req.query.page as string)  || 1;
    const limit  = parseInt(req.query.limit as string) || 10;
    const skip   = (page - 1) * limit;
    const db     = getDownloadedTracker();

    let items = getAllMdxFiles().map(f => {
      const stats = fs.statSync(f.fullPath);
      const key   = `${f.folder}/${f.filename}`;
      return {
        _id:         key,
        title:       f.filename,
        folder:      f.folder,
        isDownloaded: !!db[key],
        createdAt:   stats.mtime,
      };
    });

    // Filters
    if (req.query.folder) {
      items = items.filter(i => i.folder === req.query.folder);
    }
    if (req.query.status === 'downloaded') items = items.filter(i =>  i.isDownloaded);
    if (req.query.status === 'pending')    items = items.filter(i => !i.isDownloaded);

    const searchStr = req.query.search as string;
    if (searchStr) {
      const s = searchStr.toLowerCase();
      items = items.filter(i => i.title.toLowerCase().includes(s));
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const paginatedItems = items.slice(skip, skip + limit);

    res.json({
      data:       paginatedItems,
      total:      items.length,
      page,
      totalPages: Math.ceil(items.length / limit),
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
});

// GET /api/contents/:folder/:id — Read single file
app.get('/api/contents/:folder/:id', (req, res) => {
  try {
    const { folder, id } = req.params;
    const safeFolder = path.basename(folder);
    const safeId     = path.basename(id);
    const filePath   = path.join(GENERATED_DIR, safeFolder, safeId);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Content not found' });

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ success: true, folder: safeFolder, filename: safeId, content });
  } catch {
    res.status(500).json({ error: 'Failed to read content' });
  }
});

// POST /api/download/batch — Download N undownloaded files
app.post('/api/download/batch', (req, res) => {
  try {
    const { count, folder } = req.body;
    const limit = parseInt(count) || 10;
    const db    = getDownloadedTracker();

    let allFiles = getAllMdxFiles();
    if (folder) allFiles = allFiles.filter(f => f.folder === folder);

    const pending = allFiles.filter(f => !db[`${f.folder}/${f.filename}`]);
    const selected = pending.slice(0, limit);

    const items = selected.map(f => {
      const content = fs.readFileSync(f.fullPath, 'utf-8');
      const stats   = fs.statSync(f.fullPath);
      return {
        _id:       `${f.folder}/${f.filename}`,
        title:     f.filename,
        folder:    f.folder,
        content,
        createdAt: stats.mtime,
      };
    });

    markAsDownloaded(selected.map(f => `${f.folder}/${f.filename}`));

    res.json({ success: true, items, count: items.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to batch download', details: String(error) });
  }
});

// POST /api/github/push — Manually trigger a push
app.post('/api/github/push', async (_req, res) => {
  try {
    const allFiles = getAllMdxFiles();
    await pushToGitHub(allFiles.length);
    res.json({ success: true, message: 'Push initiated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Push failed', details: err.message });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Oxxy Backend running on port ${PORT}`);
  console.log(`📁 Content dir : ${GENERATED_DIR}`);
  console.log(`📂 Active folder: ${readMeta().activeFolder}`);
  console.log(`🐙 GitHub push : ${process.env.GITHUB_REPO_URL || '⚠️  GITHUB_REPO_URL not set'}\n`);
});
