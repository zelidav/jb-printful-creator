import { randomUUID } from 'crypto';

const jobs = new Map();
const TTL_MS = 60 * 60 * 1000;

export function createJob(spec) {
  const id = randomUUID();
  const job = {
    id,
    spec,
    status: 'pending',
    items: [],
    log: [],
    listeners: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function emit(job, event) {
  job.log.push({ t: Date.now(), ...event });
  for (const l of job.listeners) {
    try { l(event); } catch {}
  }
}

export function subscribe(job, listener) {
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}, 5 * 60 * 1000).unref();
