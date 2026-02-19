const fs = require('fs');
const fsPromises = require('fs/promises');
const http = require('http');
const path = require('path');
const { performance } = require('perf_hooks');

const { Logger } = require('./logger');
const { JobStore } = require('./job-store');
const { JobQueue } = require('./job-queue');
const { MetricsCollector } = require('./metrics');
const { loadManifest, runBenchmarkPipeline } = require('./pipeline');
const { evaluateSLO, AlertManager } = require('./slo');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'ops.log');

const PORT = Number(process.env.PORT || 8090);
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY || 2));
const JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.JOB_MAX_ATTEMPTS || 3));
const JOB_BASE_RETRY_MS = Math.max(100, Number(process.env.JOB_BASE_RETRY_MS || 600));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) {
        reject(new Error('request_body_too_large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch (err) {
        reject(new Error('invalid_json'));
      }
    });

    req.on('error', reject);
  });
}

function publicJob(job, includeResult = false) {
  const payload = {
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    nextRetryAt: job.nextRetryAt ? new Date(job.nextRetryAt).toISOString() : null,
    errorHistory: job.errorHistory,
    payload: job.payload,
  };

  if (includeResult) {
    payload.result = job.result;
  }

  return payload;
}

async function serveStaticFile(reqPath, res) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  const resolvedPath = path.normalize(path.join(ROOT_DIR, cleanPath));

  if (!resolvedPath.startsWith(ROOT_DIR)) {
    sendText(res, 403, 'Forbidden');
    return 403;
  }

  try {
    const stat = await fsPromises.stat(resolvedPath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return 404;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
    });

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    return 200;
  } catch (err) {
    sendText(res, 404, 'Not Found');
    return 404;
  }
}

async function bootstrap() {
  const logger = new Logger(LOG_FILE);
  const jobStore = new JobStore(DATA_DIR, logger);
  await jobStore.init();

  const metrics = new MetricsCollector();
  const alerts = new AlertManager(logger);

  const queue = new JobQueue({
    worker: async (job) => runBenchmarkPipeline(job.payload, job),
    store: jobStore,
    metrics,
    logger,
    concurrency: QUEUE_CONCURRENCY,
    maxAttempts: JOB_MAX_ATTEMPTS,
    baseRetryMs: JOB_BASE_RETRY_MS,
  });

  function refreshSLO() {
    const snapshot = queue.snapshot();
    const summary = metrics.buildSummary(snapshot);
    const sloEval = evaluateSLO(summary);
    alerts.reconcile(sloEval);
    return { summary, sloEval };
  }

  setInterval(() => {
    refreshSLO();
  }, 10000).unref();

  const server = http.createServer(async (req, res) => {
    const start = performance.now();
    let statusCode = 500;

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if (pathname === '/api/health' && method === 'GET') {
        const snapshot = queue.snapshot();
        const { summary, sloEval } = refreshSLO();
        statusCode = 200;
        sendJson(res, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptimeSec: Number(process.uptime().toFixed(1)),
          queue: snapshot,
          metrics: summary,
          slo: sloEval,
          alerts: alerts.getActive(),
          recentJobs: jobStore.list(5).map((job) => publicJob(job, false)),
        });
      } else if (pathname === '/api/manifest' && method === 'GET') {
        const manifest = await loadManifest();
        statusCode = 200;
        sendJson(res, 200, manifest);
      } else if (pathname === '/api/pipeline/benchmark' && method === 'POST') {
        const body = await parseJsonBody(req);
        const payload = {
          categories: body.categories,
          maxModels: body.maxModels,
          shards: body.shards,
          perModelDelayMs: body.perModelDelayMs,
          injectTransientFailure: Boolean(body.injectTransientFailure),
        };
        const job = await queue.enqueue('benchmark', payload);
        statusCode = 202;
        sendJson(res, 202, {
          job: publicJob(job, false),
          statusUrl: `/api/pipeline/jobs/${job.id}`,
        });
      } else if (pathname === '/api/pipeline/jobs' && method === 'GET') {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), 100));
        statusCode = 200;
        sendJson(res, 200, {
          jobs: jobStore.list(limit).map((job) => publicJob(job, false)),
        });
      } else if (pathname.startsWith('/api/pipeline/jobs/') && method === 'GET') {
        const id = pathname.split('/').pop();
        const job = jobStore.get(id);
        if (!job) {
          statusCode = 404;
          sendJson(res, 404, { error: 'job_not_found' });
        } else {
          statusCode = 200;
          sendJson(res, 200, { job: publicJob(job, true) });
        }
      } else if (pathname === '/api/alerts' && method === 'GET') {
        refreshSLO();
        statusCode = 200;
        sendJson(res, 200, {
          active: alerts.getActive(),
          history: alerts.getHistory(25),
        });
      } else if (pathname === '/api/slo' && method === 'GET') {
        const { summary, sloEval } = refreshSLO();
        statusCode = 200;
        sendJson(res, 200, { summary, slo: sloEval });
      } else if (pathname === '/api/metrics' && method === 'GET') {
        const snapshot = queue.snapshot();
        const { sloEval } = refreshSLO();
        statusCode = 200;
        sendText(res, 200, metrics.toPrometheus(snapshot, sloEval));
      } else {
        statusCode = await serveStaticFile(pathname, res);
      }
    } catch (err) {
      logger.error('request_failed', { error: String(err) });
      statusCode = 500;
      sendJson(res, 500, { error: 'internal_server_error' });
    } finally {
      metrics.recordApi(statusCode, performance.now() - start);
    }
  });

  server.listen(PORT, () => {
    logger.info('server_started', {
      port: PORT,
      queueConcurrency: QUEUE_CONCURRENCY,
      maxAttempts: JOB_MAX_ATTEMPTS,
      baseRetryMs: JOB_BASE_RETRY_MS,
    });
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
