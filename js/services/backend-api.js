async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${errText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

export function getManifest() {
  return request('/api/manifest');
}

export function getHealthSnapshot() {
  return request('/api/health');
}

export function queueBenchmarkJob(payload) {
  return request('/api/pipeline/benchmark', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listPipelineJobs(limit = 8) {
  return request(`/api/pipeline/jobs?limit=${encodeURIComponent(limit)}`);
}

export function getPipelineJob(jobId) {
  return request(`/api/pipeline/jobs/${encodeURIComponent(jobId)}`);
}

export function getAlerts() {
  return request('/api/alerts');
}
