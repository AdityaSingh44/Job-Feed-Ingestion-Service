import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase, closeDatabase } from './src/server/db.js';
import { createApp } from './src/server/app.js';
import { WorkerPool } from './src/server/worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // AI Studio environment constraint: Dev server must run on port 3000
  const PORT = 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // 1. Connect to MongoDB (or embedded MongoMemoryServer)
  await connectDatabase();

  // 2. Initialize worker pool with 2 competing workers
  const workerPool = new WorkerPool({
    workerCount: 2,
    pollIntervalMs: 100,
    leaseDurationMs: 5000,
    baseBackoffMs: 300
  });
  workerPool.start();

  // 3. Create Express app with all job-feed endpoints
  const app = createApp(workerPool);

  // 4. Mount Vite or static assets for preview dashboard
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Job-feed ingestion service listening on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handling
  const shutdown = async () => {
    console.log('[Server] Gracefully shutting down...');
    server.close();
    await workerPool.stop();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { app, server, workerPool };
}

// Start server if executed directly
if (process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  });
}
