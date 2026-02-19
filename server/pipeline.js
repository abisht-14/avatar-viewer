const fs = require('fs/promises');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');

const CATEGORIES = ['rigs', 'clothing', 'cage_deformers'];
const BUDGETS = {
  triangles: { green: 8000, yellow: 15000 },
  vertices: { green: 10000, yellow: 20000 },
  joints: { green: 50, yellow: 75 },
  gpuMemKB: { green: 500, yellow: 1000 },
};

let manifestCache = null;
let manifestMtimeMs = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function thresholdColor(value, { green, yellow }) {
  if (value <= green) {
    return 'green';
  }
  if (value <= yellow) {
    return 'yellow';
  }
  return 'red';
}

function budgetScore(entry) {
  const joints = entry.real_joint_count >= 0 ? entry.real_joint_count : entry.node_count;
  const checks = [
    thresholdColor(entry.total_faces || 0, BUDGETS.triangles),
    thresholdColor(entry.total_vertices || 0, BUDGETS.vertices),
    thresholdColor(joints || 0, BUDGETS.joints),
    thresholdColor(entry.total_gpu_memory_kb || 0, BUDGETS.gpuMemKB),
  ];

  const red = checks.filter((c) => c === 'red').length;
  const yellow = checks.filter((c) => c === 'yellow').length;
  const status = red > 0 ? 'fail' : yellow > 0 ? 'warn' : 'pass';

  const score = Math.max(0, 100 - (red * 30) - (yellow * 10));
  return {
    status,
    score,
    checks,
  };
}

async function loadManifest() {
  const stat = await fs.stat(MANIFEST_PATH);
  if (!manifestCache || stat.mtimeMs !== manifestMtimeMs) {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    manifestCache = JSON.parse(raw);
    manifestMtimeMs = stat.mtimeMs;
  }
  return manifestCache;
}

function selectedEntries(manifest, params) {
  const categories = Array.isArray(params.categories) && params.categories.length > 0
    ? params.categories.filter((cat) => CATEGORIES.includes(cat))
    : CATEGORIES;

  const all = [];
  for (const category of categories) {
    for (const entry of manifest[category] || []) {
      all.push(entry);
    }
  }

  const maxModels = Math.max(1, Math.min(Number(params.maxModels || all.length), all.length));
  return all.slice(0, maxModels);
}

async function processShard(shard, delayMs) {
  const shardResults = [];
  for (const entry of shard) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const budget = budgetScore(entry);
    shardResults.push({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      triangles: entry.total_faces,
      vertices: entry.total_vertices,
      joints: entry.real_joint_count >= 0 ? entry.real_joint_count : entry.node_count,
      gpuMemKB: entry.total_gpu_memory_kb,
      materials: entry.material_count,
      budgetStatus: budget.status,
      score: budget.score,
      warningCount: (entry.warnings || []).length,
    });
  }
  return shardResults;
}

async function runBenchmarkPipeline(payload, job) {
  const manifest = await loadManifest();

  if (payload.injectTransientFailure && job.attempt === 1) {
    throw new Error('Injected transient pipeline failure for retry validation');
  }

  const entries = selectedEntries(manifest, payload);
  if (entries.length === 0) {
    throw new Error('No entries selected for pipeline run');
  }

  const shards = Math.max(1, Math.min(Number(payload.shards || 4), entries.length));
  const shardBuckets = Array.from({ length: shards }, () => []);
  for (let i = 0; i < entries.length; i += 1) {
    shardBuckets[i % shards].push(entries[i]);
  }

  const start = Date.now();
  const perModelDelayMs = Math.max(0, Math.min(Number(payload.perModelDelayMs || 2), 25));
  const shardResults = await Promise.all(shardBuckets.map((bucket) => processShard(bucket, perModelDelayMs)));
  const models = shardResults.flat();

  const durationMs = Date.now() - start;
  const pass = models.filter((m) => m.budgetStatus === 'pass').length;
  const warn = models.filter((m) => m.budgetStatus === 'warn').length;
  const fail = models.filter((m) => m.budgetStatus === 'fail').length;
  const avgScore = models.reduce((acc, m) => acc + m.score, 0) / models.length;

  const worstOffenders = [...models]
    .sort((a, b) => a.score - b.score || b.triangles - a.triangles)
    .slice(0, 5);

  return {
    mode: 'backend_benchmark_pipeline',
    processedModels: models.length,
    shardCount: shards,
    durationMs,
    throughputModelsPerSec: Number((models.length / Math.max(durationMs / 1000, 0.001)).toFixed(2)),
    summary: {
      pass,
      warn,
      fail,
      avgScore: Number(avgScore.toFixed(2)),
    },
    worstOffenders,
    models,
  };
}

module.exports = { loadManifest, runBenchmarkPipeline };
