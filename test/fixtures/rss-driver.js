'use strict';

/**
 * Runs YAMLTest definitions in a process of its own and reports its memory, for
 * the large-body tests. Reads JSON { warmup, yaml } on stdin: `warmup` (optional)
 * runs first so modules and code paths are loaded before the baseline is taken,
 * then `yaml` runs while memory is sampled. Prints one JSON line (sizes in bytes):
 *
 *   result        runTests() result for `yaml`
 *   durationMs    wall time of the `yaml` run
 *   baselineRss   RSS just before the run
 *   peakRss       highest RSS sampled during the run (every 10ms)
 *   maxRss        OS high-water mark of RSS for the whole process (getrusage)
 *   footprint     macOS only: { baseline, peak } physical footprint (vmmap)
 *   growth        how much the run grew memory: footprint.peak - baseline on
 *                 macOS, otherwise max(peakRss, maxRss) - baselineRss
 *
 * Why footprint on macOS: there RSS keeps counting pages that malloc has
 * freed but marked reusable (MADV_FREE_REUSABLE) until the system needs them,
 * so after streaming 1 GiB through 64 KiB socket reads RSS reads a few hundred
 * MiB even though the live memory stays flat. The physical footprint (what
 * Activity Monitor and the OOM killer go by) leaves those pages out. On Linux
 * freed memory is returned or reused, and RSS is accurate.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { runTests } = require(path.join(__dirname, '../../src/index.js'));

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const UNITS = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

// { current, peak } physical footprint of this process, from `vmmap --summary`.
function physicalFootprint() {
  const out = execFileSync('vmmap', ['--summary', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const parse = (label) => {
    const match = new RegExp(`^${label}:\\s+([\\d.]+)([BKMG])`, 'm').exec(out);
    if (!match) throw new Error(`vmmap output has no "${label}" line`);
    return Math.round(parseFloat(match[1]) * UNITS[match[2]]);
  };
  return { current: parse('Physical footprint'), peak: parse('Physical footprint \\(peak\\)') };
}

(async () => {
  const { warmup, yaml } = JSON.parse(await readStdin());
  if (warmup) {
    await runTests(warmup, { retries: 0 });
  }

  const darwin = process.platform === 'darwin';
  const footprintBefore = darwin ? physicalFootprint() : null;
  const baselineRss = process.memoryUsage.rss();
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 10);

  const started = Date.now();
  const result = await runTests(yaml, { retries: 0 });
  const durationMs = Date.now() - started;
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  const maxRss = process.resourceUsage().maxRSS * 1024;

  const report = { result, durationMs, baselineRss, peakRss, maxRss };
  if (darwin) {
    const footprintAfter = physicalFootprint();
    report.footprint = { baseline: footprintBefore.current, peak: footprintAfter.peak };
    report.growth = footprintAfter.peak - footprintBefore.current;
  } else {
    report.growth = Math.max(peakRss, maxRss) - baselineRss;
  }

  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
