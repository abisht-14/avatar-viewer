const fs = require('fs/promises');
const path = require('path');

class JobStore {
  constructor(dataRoot, logger) {
    this.dataRoot = dataRoot;
    this.jobsDir = path.join(dataRoot, 'jobs');
    this.jobs = new Map();
    this.logger = logger;
  }

  async init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    const files = await fs.readdir(this.jobsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(this.jobsDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const job = JSON.parse(raw);
        this.jobs.set(job.id, job);
      } catch (err) {
        this.logger.warn('failed_to_load_job_file', { file, error: String(err) });
      }
    }
  }

  async save(job) {
    this.jobs.set(job.id, job);
    const filePath = path.join(this.jobsDir, `${job.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(job, null, 2));
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 25) {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

module.exports = { JobStore };
