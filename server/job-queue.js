const { randomUUID } = require('crypto');

class JobQueue {
  constructor(options) {
    this.worker = options.worker;
    this.store = options.store;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.concurrency = options.concurrency;
    this.maxAttempts = options.maxAttempts;
    this.baseRetryMs = options.baseRetryMs;

    this.pendingIds = [];
    this.running = 0;
  }

  snapshot() {
    return {
      pending: this.pendingIds.length,
      running: this.running,
      concurrency: this.concurrency,
      maxAttempts: this.maxAttempts,
      baseRetryMs: this.baseRetryMs,
    };
  }

  async enqueue(type, payload) {
    const now = Date.now();
    const job = {
      id: randomUUID(),
      type,
      payload,
      status: 'queued',
      attempt: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      errorHistory: [],
      result: null,
    };

    await this.store.save(job);
    this.pendingIds.push(job.id);
    this.metrics.recordJobSubmitted();
    this.logger.info('job_enqueued', { jobId: job.id, type });
    this.drain().catch((err) => {
      this.logger.error('queue_drain_failed', { error: String(err) });
    });
    return job;
  }

  async drain() {
    while (this.running < this.concurrency && this.pendingIds.length > 0) {
      const nextId = this.pendingIds.shift();
      const job = this.store.get(nextId);
      if (!job || job.status !== 'queued') {
        continue;
      }
      this.executeJob(job).catch((err) => {
        this.logger.error('job_execution_crashed', { jobId: job.id, error: String(err) });
      });
    }
  }

  async executeJob(job) {
    this.running += 1;
    const start = Date.now();
    const queueWaitMs = start - (job.queuedAt || job.createdAt);

    job.status = 'running';
    job.attempt += 1;
    job.startedAt = start;
    job.updatedAt = start;
    await this.store.save(job);

    this.metrics.recordJobStarted(queueWaitMs);

    try {
      this.logger.info('job_started', { jobId: job.id, attempt: job.attempt, type: job.type });
      const result = await this.worker(job);
      const finishedAt = Date.now();
      job.status = 'completed';
      job.result = result;
      job.completedAt = finishedAt;
      job.updatedAt = finishedAt;
      await this.store.save(job);

      this.metrics.recordJobCompleted(finishedAt - start);
      this.logger.info('job_completed', { jobId: job.id, durationMs: finishedAt - start, attempt: job.attempt });
    } catch (err) {
      const failedAt = Date.now();
      const errorMessage = String(err?.message || err || 'unknown_error');
      job.errorHistory.push({ attempt: job.attempt, at: failedAt, message: errorMessage });

      if (job.attempt < job.maxAttempts) {
        const delayMs = this.baseRetryMs * (2 ** (job.attempt - 1));
        job.status = 'retrying';
        job.nextRetryAt = failedAt + delayMs;
        job.updatedAt = failedAt;
        await this.store.save(job);

        this.metrics.recordJobRetried();
        this.logger.warn('job_retry_scheduled', { jobId: job.id, attempt: job.attempt, delayMs, error: errorMessage });

        setTimeout(async () => {
          const queued = this.store.get(job.id);
          if (!queued) {
            return;
          }
          queued.status = 'queued';
          queued.queuedAt = Date.now();
          queued.updatedAt = queued.queuedAt;
          queued.nextRetryAt = null;
          await this.store.save(queued);
          this.pendingIds.push(queued.id);
          this.drain().catch((queueErr) => {
            this.logger.error('queue_drain_failed_after_retry', { error: String(queueErr) });
          });
        }, delayMs);
      } else {
        job.status = 'failed';
        job.completedAt = failedAt;
        job.updatedAt = failedAt;
        job.nextRetryAt = null;
        await this.store.save(job);

        this.metrics.recordJobFailed(failedAt - start);
        this.logger.error('job_failed_terminal', { jobId: job.id, attempt: job.attempt, error: errorMessage });
      }
    } finally {
      this.running -= 1;
      this.drain().catch((err) => {
        this.logger.error('queue_drain_failed_finally', { error: String(err) });
      });
    }
  }
}

module.exports = { JobQueue };
