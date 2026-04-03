import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GENERATED_DIR = path.join(process.cwd(), 'generated-content');
const DOWNLOADS_DB = path.join(GENERATED_DIR, '_downloads.json');

if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

const getDownloadedTracker = (): Record<string, boolean> => {
  if (!fs.existsSync(DOWNLOADS_DB)) return {};
  try {
    return JSON.parse(fs.readFileSync(DOWNLOADS_DB, 'utf-8'));
  } catch (e) {
    return {};
  }
};

const markAsDownloaded = (filenames: string[]) => {
  const db = getDownloadedTracker();
  filenames.forEach(f => db[f] = true);
  fs.writeFileSync(DOWNLOADS_DB, JSON.stringify(db), 'utf-8');
};

const generateSafeFilename = (originalFilename: string): string => {
  // Fix parsing to strip inner extensions if they exist like best-electric.txt.md
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


const getOxyyKey = () => {
  const apiKeys = Object.keys(process.env)
    .filter((key) => key.startsWith('OXYY_API_KEY'))
    .sort()
    .map((key) => process.env[key])
    .filter(Boolean) as string[];

  if (apiKeys.length === 0) {
    return process.env.OXYY_API_KEY; 
  }
  return apiKeys[Math.floor(Math.random() * apiKeys.length)];
};


const EXTERNAL_API_URL = 'https://cloud-text-manager-server.vercel.app/api/all-files?section=General';
let isWorkerRunning = false;

const generateContentWithAI = async (promptText: string) => {
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
          model: model,
          messages: [{ role: 'user', content: promptText }],
          temperature: 0.7,
          max_tokens: 16384,
          stream: true
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream'
        }
      );

      return await new Promise<string>((resolve, reject) => {
        let fullContent = '';
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let lines = buffer.split('\n');
          buffer = lines.pop() || ''; 
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              try {
                const data = JSON.parse(trimmed.substring(6));
                if (data.choices?.[0]?.delta?.content) {
                  fullContent += data.choices[0].delta.content;
                }
              } catch (e) { }
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
      console.log(`[Worker] Retry ${attempt}/${MAX_RETRIES} for AI Generation (Status: ${error?.response?.status})`);
      if (attempt >= MAX_RETRIES) throw error;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
};


const CONCURRENCY_LIMIT = 10;
const BATCH_SIZE = 50;

const processFile = async (file: any) => {
  console.log(`[Worker] Generating content for: ${file.originalFilename}`);
  try {
    const promptResponse = await axios.get(file.secureUrl);
    const promptText = typeof promptResponse.data === 'string' ? promptResponse.data : JSON.stringify(promptResponse.data);
    
    // Add prompt processing through AI
    const generatedText = await generateContentWithAI(promptText);
    
    const safeFilename = generateSafeFilename(file.originalFilename);
    const filePath = path.join(GENERATED_DIR, safeFilename);
    
    fs.writeFileSync(filePath, generatedText, 'utf-8');
    console.log(`[Worker] Saved physical file: ${safeFilename}`);
    
    await axios.put(`https://cloud-text-manager-server.vercel.app/api/all-files/${file._id}`, {
      status: 'AlreadyCopy',
      completedTimestamp: Date.now(),
    });
  } catch (err: any) {
    console.error(`[Worker] Error generating for ${file.originalFilename}: ${err.message}`);
  }
}

const runQueue = async (files: any[]) => {
  let index = 0;
  async function worker() {
    while (true) {
      if (index >= files.length) break;
      const currentIndex = index++;
      await processFile(files[currentIndex]);
    }
  }
  const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
  await Promise.all(workers);
}

const workerInterval = setInterval(async () => {
    if (isWorkerRunning) return;
    isWorkerRunning = true;
    try {
      console.log('[Worker] Checking for new topics...');
      const response = await axios.get(EXTERNAL_API_URL);
      const pendingFiles = response.data.filter((f: any) => f.status === 'Pending').slice(0, BATCH_SIZE);
      
      if (pendingFiles.length > 0) {
        console.log(`[Worker] Identified ${pendingFiles.length} files. Running queue with concurrency ${CONCURRENCY_LIMIT}.`);
        await runQueue(pendingFiles);
      }
    } catch (error: any) {
      console.error('[Worker] Polling failed:', error.message);
    } finally {
      isWorkerRunning = false;
    }
}, 60000); // Check every minute


// API Endpoints for physical files

app.get('/api/stats', (req, res) => {
  try {
    const files = fs.readdirSync(GENERATED_DIR).filter(f => f.endsWith('.mdx'));
    const db = getDownloadedTracker();
    const totalDownloaded = files.filter(f => db[f]).length;

    res.json({
      totalGenerated: files.length,
      totalDownloaded,
      remaining: files.length - totalDownloaded
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


app.get('/api/contents', (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const db = getDownloadedTracker();
    let files = fs.readdirSync(GENERATED_DIR).filter(f => f.endsWith('.mdx'));

    let items = files.map(f => {
      const stats = fs.statSync(path.join(GENERATED_DIR, f));
      return {
        _id: f, 
        title: f,
        isDownloaded: !!db[f],
        createdAt: stats.mtime
      }
    });

    // Optional filter by status
    if (req.query.status === 'downloaded') items = items.filter(i => i.isDownloaded);
    if (req.query.status === 'pending') items = items.filter(i => !i.isDownloaded);

    const searchStr = req.query.search as string;
    if (searchStr) {
      const s = searchStr.toLowerCase();
      items = items.filter(i => i.title.toLowerCase().includes(s));
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    
    const paginatedItems = items.slice(skip, skip + limit);

    res.json({
      data: paginatedItems,
      total: items.length,
      page,
      totalPages: Math.ceil(items.length / limit)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
});

app.get('/api/contents/:id', (req, res) => {
  try {
    const { id } = req.params;
    const safeId = path.basename(id);
    const filePath = path.join(GENERATED_DIR, safeId);
    
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Content not found' });
    const content = fs.readFileSync(filePath, 'utf-8');
    
    res.json({ success: true, content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read content' });
  }
});


app.post('/api/download/batch', (req, res) => {
  try {
    const { count } = req.body;
    const limit = parseInt(count) || 10;
    
    const db = getDownloadedTracker();
    let files = fs.readdirSync(GENERATED_DIR).filter(f => f.endsWith('.mdx') && !db[f]);
    
    const selectedFiles = files.slice(0, limit);
    const items = selectedFiles.map(f => {
      const content = fs.readFileSync(path.join(GENERATED_DIR, f), 'utf-8');
      const stats = fs.statSync(path.join(GENERATED_DIR, f));
      return {
        _id: f,
        title: f,
        content,
        isDownloaded: false,
        createdAt: stats.mtime
      }
    });

    markAsDownloaded(selectedFiles);

    res.json({ success: true, items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to batch download', details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend continuously running on port ${PORT}`);
});
