function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

class MetricsCollector {
  constructor(windowMs = 15 * 60 * 1000) {
    this.windowMs = windowMs;
    this.apiSamples = [];
    this.jobDurationSamples = [];
    this.queueWaitSamples = [];
    this.counters = {
      apiRequests: 0,
      apiErrors: 0,
      jobsSubmitted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsRetried: 0,
    };
  }

  prune(now = Date.now()) {
    const minTs = now - this.windowMs;
    this.apiSamples = this.apiSamples.filter((s) => s.ts >= minTs);
    this.jobDurationSamples = this.jobDurationSamples.filter((s) => s.ts >= minTs);
    this.queueWaitSamples = this.queueWaitSamples.filter((s) => s.ts >= minTs);
  }

  recordApi(statusCode, durationMs) {
    const sample = { ts: Date.now(), statusCode, durationMs };
    this.apiSamples.push(sample);
    this.counters.apiRequests += 1;
    if (statusCode >= 500) {
      this.counters.apiErrors += 1;
    }
    this.prune(sample.ts);
  }

  recordJobSubmitted() {
    this.counters.jobsSubmitted += 1;
  }

  recordJobRetried() {
    this.counters.jobsRetried += 1;
  }

  recordJobStarted(queueWaitMs) {
    this.queueWaitSamples.push({ ts: Date.now(), value: queueWaitMs });
    this.prune();
  }

  recordJobCompleted(durationMs) {
    this.counters.jobsCompleted += 1;
    this.jobDurationSamples.push({ ts: Date.now(), value: durationMs });
    this.prune();
  }

  recordJobFailed(durationMs) {
    this.counters.jobsFailed += 1;
    this.jobDurationSamples.push({ ts: Date.now(), value: durationMs });
    this.prune();
  }

  buildSummary(queueSnapshot) {
    this.prune();

    const apiCount = this.apiSamples.length;
    const apiErrors = this.apiSamples.filter((s) => s.statusCode >= 500).length;
    const apiAvailabilityPct = apiCount > 0 ? ((apiCount - apiErrors) / apiCount) * 100 : 100;
    const apiLatencyP95Ms = percentile(this.apiSamples.map((s) => s.durationMs), 95);

    const completed = this.counters.jobsCompleted;
    const failed = this.counters.jobsFailed;
    const terminalJobs = completed + failed;
    const jobSuccessRatePct = terminalJobs > 0 ? (completed / terminalJobs) * 100 : 100;

    const queueWaitP95Ms = percentile(this.queueWaitSamples.map((s) => s.value), 95);
    const jobDurationP95Ms = percentile(this.jobDurationSamples.map((s) => s.value), 95);

    return {
      windowMinutes: Math.round(this.windowMs / 60000),
      api: {
        requests: apiCount,
        errors: apiErrors,
        availabilityPct: Number(apiAvailabilityPct.toFixed(2)),
        latencyP95Ms: Number(apiLatencyP95Ms.toFixed(2)),
      },
      jobs: {
        submitted: this.counters.jobsSubmitted,
        completed,
        failed,
        retried: this.counters.jobsRetried,
        successRatePct: Number(jobSuccessRatePct.toFixed(2)),
        durationP95Ms: Number(jobDurationP95Ms.toFixed(2)),
        queueWaitP95Ms: Number(queueWaitP95Ms.toFixed(2)),
      },
      queue: queueSnapshot,
    };
  }

  toPrometheus(queueSnapshot, sloEval) {
    const summary = this.buildSummary(queueSnapshot);
    const lines = [
      '# HELP avatar_api_requests_total Total API requests in process lifetime',
      '# TYPE avatar_api_requests_total counter',
      `avatar_api_requests_total ${this.counters.apiRequests}`,
      '# HELP avatar_api_errors_total Total API 5xx responses in process lifetime',
      '# TYPE avatar_api_errors_total counter',
      `avatar_api_errors_total ${this.counters.apiErrors}`,
      '# HELP avatar_api_latency_p95_ms API p95 latency over rolling window',
      '# TYPE avatar_api_latency_p95_ms gauge',
      `avatar_api_latency_p95_ms ${summary.api.latencyP95Ms}`,
      '# HELP avatar_api_availability_pct API availability percentage over rolling window',
      '# TYPE avatar_api_availability_pct gauge',
      `avatar_api_availability_pct ${summary.api.availabilityPct}`,
      '# HELP avatar_jobs_submitted_total Total submitted jobs in process lifetime',
      '# TYPE avatar_jobs_submitted_total counter',
      `avatar_jobs_submitted_total ${this.counters.jobsSubmitted}`,
      '# HELP avatar_jobs_completed_total Total completed jobs in process lifetime',
      '# TYPE avatar_jobs_completed_total counter',
      `avatar_jobs_completed_total ${this.counters.jobsCompleted}`,
      '# HELP avatar_jobs_failed_total Total failed jobs in process lifetime',
      '# TYPE avatar_jobs_failed_total counter',
      `avatar_jobs_failed_total ${this.counters.jobsFailed}`,
      '# HELP avatar_jobs_retried_total Total retried jobs in process lifetime',
      '# TYPE avatar_jobs_retried_total counter',
      `avatar_jobs_retried_total ${this.counters.jobsRetried}`,
      '# HELP avatar_job_success_rate_pct Job success rate percentage over rolling window',
      '# TYPE avatar_job_success_rate_pct gauge',
      `avatar_job_success_rate_pct ${summary.jobs.successRatePct}`,
      '# HELP avatar_queue_wait_p95_ms Queue wait p95 over rolling window',
      '# TYPE avatar_queue_wait_p95_ms gauge',
      `avatar_queue_wait_p95_ms ${summary.jobs.queueWaitP95Ms}`,
      '# HELP avatar_queue_depth Current queue depth',
      '# TYPE avatar_queue_depth gauge',
      `avatar_queue_depth ${queueSnapshot.pending}`,
      '# HELP avatar_workers_active Current active workers',
      '# TYPE avatar_workers_active gauge',
      `avatar_workers_active ${queueSnapshot.running}`,
      '# HELP avatar_slo_healthy SLO health (1 healthy, 0 unhealthy)',
      '# TYPE avatar_slo_healthy gauge',
      `avatar_slo_healthy ${sloEval.healthy ? 1 : 0}`,
    ];

    return `${lines.join('\n')}\n`;
  }
}

module.exports = { MetricsCollector };
