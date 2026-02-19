import {
  getAlerts,
  getHealthSnapshot,
  getPipelineJob,
  listPipelineJobs,
  queueBenchmarkJob,
} from '../services/backend-api.js';

const POLL_INTERVAL_MS = 4000;

let pollTimer = null;
let activeJobId = null;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = byId(id);
  if (el) {
    el.textContent = value;
  }
}

function statusTone(value, thresholds) {
  if (value >= thresholds.good) {
    return 'ok';
  }
  if (value >= thresholds.warn) {
    return 'warn';
  }
  return 'bad';
}

function renderSloPill(healthy) {
  const pill = byId('ops-slo-pill');
  if (!pill) {
    return;
  }
  pill.textContent = healthy ? 'SLO: Healthy' : 'SLO: Breach';
  pill.className = `ops-pill ${healthy ? 'ok' : 'bad'}`;
}

function renderHealth(health) {
  setText('ops-queue-depth', String(health.queue.pending));
  setText('ops-workers', `${health.queue.running}/${health.queue.concurrency}`);
  setText('ops-api-p95', `${health.metrics.api.latencyP95Ms} ms`);
  setText('ops-job-success', `${health.metrics.jobs.successRatePct}%`);
  setText('ops-job-retries', String(health.metrics.jobs.retried));

  renderSloPill(health.slo.healthy);

  const apiBadge = byId('ops-api-badge');
  if (apiBadge) {
    apiBadge.className = `ops-badge ${statusTone(health.metrics.api.availabilityPct, { good: 99.5, warn: 99 })}`;
    apiBadge.textContent = `API ${health.metrics.api.availabilityPct}%`;
  }

  const jobBadge = byId('ops-job-badge');
  if (jobBadge) {
    jobBadge.className = `ops-badge ${statusTone(health.metrics.jobs.successRatePct, { good: 99, warn: 97 })}`;
    jobBadge.textContent = `Jobs ${health.metrics.jobs.successRatePct}%`;
  }
}

function renderAlerts(alertPayload) {
  const list = byId('ops-alert-list');
  if (!list) {
    return;
  }

  const active = alertPayload.active || [];
  if (active.length === 0) {
    list.innerHTML = '<div class="ops-alert ok">No active alerts</div>';
    return;
  }

  list.innerHTML = active
    .map((alert) => `<div class="ops-alert bad">${alert.metric}: ${alert.actual} (target ${alert.target})</div>`)
    .join('');
}

function summarizeJob(job) {
  const base = `Job ${job.id.slice(0, 8)} • ${job.status} • attempt ${job.attempt}/${job.maxAttempts}`;
  if (job.status === 'completed' && job.result) {
    return `${base} • ${job.result.processedModels} models in ${job.result.durationMs}ms`;
  }
  if (job.status === 'failed' && job.errorHistory.length > 0) {
    const lastError = job.errorHistory[job.errorHistory.length - 1];
    return `${base} • ${lastError.message}`;
  }
  return base;
}

function renderRecentJobs(jobsPayload) {
  const container = byId('ops-recent-jobs');
  if (!container) {
    return;
  }

  const jobs = jobsPayload.jobs || [];
  if (jobs.length === 0) {
    container.innerHTML = '<div class="ops-recent-empty">No jobs yet</div>';
    return;
  }

  container.innerHTML = jobs
    .slice(0, 4)
    .map((job) => `<div class="ops-recent-item">${summarizeJob(job)}</div>`)
    .join('');
}

async function refreshActiveJob() {
  if (!activeJobId) {
    return;
  }

  try {
    const payload = await getPipelineJob(activeJobId);
    const job = payload.job;
    setText('ops-active-job', summarizeJob(job));
    if (job.status === 'completed' || job.status === 'failed') {
      activeJobId = null;
    }
  } catch (err) {
    setText('ops-active-job', `Failed to refresh job: ${err.message}`);
  }
}

async function refreshPanel() {
  try {
    const [health, alerts, jobs] = await Promise.all([
      getHealthSnapshot(),
      getAlerts(),
      listPipelineJobs(8),
    ]);

    renderHealth(health);
    renderAlerts(alerts);
    renderRecentJobs(jobs);
  } catch (err) {
    setText('ops-active-job', `Ops API unavailable: ${err.message}`);
    renderSloPill(false);
  }

  await refreshActiveJob();
}

async function submitBenchmarkJob() {
  const category = byId('ops-category')?.value || 'all';
  const maxModels = Number(byId('ops-max-models')?.value || 50);
  const shards = Number(byId('ops-shards')?.value || 4);
  const injectTransientFailure = Boolean(byId('ops-inject-failure')?.checked);

  const categories = category === 'all' ? undefined : [category];

  const runButton = byId('ops-run-benchmark');
  if (runButton) {
    runButton.disabled = true;
    runButton.textContent = 'Submitting...';
  }

  try {
    const result = await queueBenchmarkJob({
      categories,
      maxModels,
      shards,
      injectTransientFailure,
    });

    activeJobId = result.job.id;
    setText('ops-active-job', `Queued ${summarizeJob(result.job)}`);
  } catch (err) {
    setText('ops-active-job', `Queue submit failed: ${err.message}`);
  } finally {
    if (runButton) {
      runButton.disabled = false;
      runButton.textContent = 'Queue Backend Benchmark';
    }
  }
}

export function initOpsPanel() {
  const panel = byId('ops-panel');
  if (!panel) {
    return;
  }

  const runButton = byId('ops-run-benchmark');
  if (runButton) {
    runButton.addEventListener('click', submitBenchmarkJob);
  }

  refreshPanel();
  pollTimer = window.setInterval(refreshPanel, POLL_INTERVAL_MS);

  window.addEventListener('beforeunload', () => {
    if (pollTimer) {
      window.clearInterval(pollTimer);
    }
  });
}
