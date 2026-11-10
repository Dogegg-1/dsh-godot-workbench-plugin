import { fault } from './storage.mjs';

// Nearest-rank quantiles retain the long tail; never infer a playability verdict.
export function summarizeFrameTimes(samples) {
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 600 || samples.some(value => !Number.isFinite(value) || value <= 0)) throw fault('INVALID_TIMING', '帧间隔样本缺失或无效');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  const bins = [{ label: '≤16.7ms', upper: 16.7 }, { label: '16.7–33.3ms', upper: 33.3 }, { label: '33.3–50ms', upper: 50 }, { label: '50–100ms', upper: 100 }, { label: '>100ms', upper: Infinity }];
  return {
    count: samples.length, durationMs: samples.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1),
    over33Ms: samples.filter(value => value > 33.3).length, over50Ms: samples.filter(value => value > 50).length,
    histogram: bins.map((bin, index) => ({ label: bin.label, count: samples.filter(value => value > (index ? bins[index - 1].upper : 0) && value <= bin.upper).length })),
    measure: 'monotonic-process-frame-interval', performanceVerdict: 'not-assessed',
  };
}
