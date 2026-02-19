const DEFAULT_SLO_TARGETS = {
  apiAvailabilityPct: 99.5,
  apiLatencyP95Ms: 250,
  jobSuccessRatePct: 99,
  queueWaitP95Ms: 2000,
};

function makeCheck(id, metric, actual, target, comparator) {
  const ok = comparator === 'gte' ? actual >= target : actual <= target;
  return {
    id,
    metric,
    comparator,
    target,
    actual,
    ok,
    message: ok
      ? `${metric} within SLO (${actual} vs target ${comparator} ${target})`
      : `${metric} breached SLO (${actual} vs target ${comparator} ${target})`,
  };
}

function evaluateSLO(summary, targets = DEFAULT_SLO_TARGETS) {
  const checks = [
    makeCheck('api_availability', 'api.availabilityPct', summary.api.availabilityPct, targets.apiAvailabilityPct, 'gte'),
    makeCheck('api_latency_p95', 'api.latencyP95Ms', summary.api.latencyP95Ms, targets.apiLatencyP95Ms, 'lte'),
    makeCheck('job_success_rate', 'jobs.successRatePct', summary.jobs.successRatePct, targets.jobSuccessRatePct, 'gte'),
    makeCheck('queue_wait_p95', 'jobs.queueWaitP95Ms', summary.jobs.queueWaitP95Ms, targets.queueWaitP95Ms, 'lte'),
  ];

  return {
    targets,
    checks,
    healthy: checks.every((c) => c.ok),
  };
}

class AlertManager {
  constructor(logger) {
    this.logger = logger;
    this.active = new Map();
    this.history = [];
  }

  reconcile(sloEval) {
    const seen = new Set();

    for (const check of sloEval.checks) {
      seen.add(check.id);
      const existing = this.active.get(check.id);

      if (!check.ok && !existing) {
        const alert = {
          id: check.id,
          status: 'active',
          message: check.message,
          metric: check.metric,
          target: check.target,
          actual: check.actual,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.active.set(check.id, alert);
        this.history.unshift(alert);
        this.logger.warn('slo_alert_opened', alert);
      } else if (!check.ok && existing) {
        existing.actual = check.actual;
        existing.message = check.message;
        existing.updatedAt = new Date().toISOString();
      } else if (check.ok && existing) {
        existing.status = 'resolved';
        existing.resolvedAt = new Date().toISOString();
        existing.updatedAt = existing.resolvedAt;
        this.active.delete(check.id);
        this.logger.info('slo_alert_resolved', existing);
      }
    }

    for (const id of [...this.active.keys()]) {
      if (!seen.has(id)) {
        this.active.delete(id);
      }
    }
  }

  getActive() {
    return [...this.active.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  getHistory(limit = 25) {
    return this.history.slice(0, limit);
  }
}

module.exports = { DEFAULT_SLO_TARGETS, evaluateSLO, AlertManager };
