'use strict';

const yaml = require('js-yaml');
const { executeTest } = require('./core');
const { validateTestDefinitions } = require('./validate');

/**
 * Parse a YAML string into an array of test definitions.
 * Accepts either a single test object or an array of test objects.
 *
 * @param {string} yamlString - Raw YAML content
 * @returns {Array<object>} - Array of test definition objects
 */
function parseTestDefinitions(yamlString) {
  let parsed;

  try {
    parsed = yaml.load(yamlString);
  } catch (err) {
    throw new Error(`Failed to parse YAML: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML: expected an object or array of test definitions');
  }

  const definitions = Array.isArray(parsed) ? parsed : [parsed];

  if (definitions.length === 0) {
    throw new Error('No test definitions found in YAML');
  }

  return definitions;
}

/**
 * Normalise a raw test definition object.
 *
 * The flat format (http / command / wait / expect at the top level) is the
 * canonical format expected by executeTest in v2.js.  This function is a
 * no-op on already-flat objects but could be extended later.
 *
 * @param {object} def - A single test definition
 * @returns {object} - Normalised test definition
 */
function normaliseDefinition(def) {
  return def;
}

/**
 * Serialise a normalised test definition back to a YAML string so that
 * executeTest (which accepts a YAML string) can consume it.
 *
 * @param {object} def - A normalised test definition object
 * @returns {string} - YAML representation of the definition
 */
function serialiseDefinition(def) {
  return yaml.dump(def);
}

// ── Runtime defaults (env-overridable) ──────────────────────────────────────
// These mirror the historical procgen mocha harness: retry up to 120 times with
// a 1s pause, give each attempt 10s, and cap the whole retry loop at 3m. They can
// be tuned per run via env vars without changing any test definition.
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Resolved per call (not at module load) so tests and callers can override via
// env without re-importing. Fallbacks mirror the historical procgen harness.
const MAXTIME_BUFFER_MS = 60000;
function defaults() {
  return {
    retries: intFromEnv('YAMLTEST_RETRIES', 120),
    retryIntervalMs: intFromEnv('YAMLTEST_RETRY_INTERVAL_MS', 1000),
    timeoutMs: intFromEnv('YAMLTEST_TIMEOUT_MS', 10000),
    maxtimeFloorMs: intFromEnv('YAMLTEST_MAXTIME_MS', 180000),
  };
}

/**
 * Parse a duration value into milliseconds.
 * Accepts a plain number (already ms) or a duration string: "500ms", "30s",
 * "3m", "1h" (no unit ⇒ ms). Returns null when the value is absent/unparseable.
 */
function parseDuration(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'ms').toLowerCase();
    const mult = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
    return Math.round(n * mult);
  }
  return null;
}

/**
 * Race a promise against a timeout. The original promise is allowed to settle
 * later (its result is ignored) but we attach a no-op handler so a late
 * rejection never becomes an unhandledRejection.
 */
function withTimeout(promise, ms, label) {
  promise.then(() => {}, () => {}); // swallow late settle
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One attempt = `consecutive` successful executeTest runs in a row. Any failure
 * rejects (and carries the innermost error's `observed` snapshot) so the whole
 * attempt is retried.
 */
async function runConsecutive(yamlStr, consecutive) {
  for (let c = 0; c < consecutive; c++) {
    await executeTest(yamlStr);
  }
}

/**
 * Run a single test definition with retry, consecutive, per-attempt timeout and
 * an overall wall-clock budget (maxtime).
 *
 * Knobs (all optional, read from the definition):
 *   retries      - max retry attempts after the first        (default 120)
 *   consecutive  - successful runs required per attempt       (default 1)
 *   timeout      - per-attempt cap in ms                      (default 10000)
 *   maxtime      - wall-clock cap on the whole retry loop;    (default max(180s, timeout+60s))
 *                  number ⇒ ms, or duration string "3m"/"420s"
 *
 * @param {object} def - Normalised test definition
 * @param {number} index - 0-based index in the test array (for labelling)
 * @returns {Promise<TestResult>}
 */
async function runSingleTest(def, index) {
  const cfg = defaults();
  const retries = typeof def.retries === 'number' ? def.retries : cfg.retries;
  const consecutive = typeof def.consecutive === 'number' && def.consecutive >= 1 ? def.consecutive : 1;
  const perAttemptTimeout = typeof def.timeout === 'number' ? def.timeout : cfg.timeoutMs;
  const retryIntervalMs = cfg.retryIntervalMs;
  const explicitMaxtime = parseDuration(def.maxtime);
  const maxtimeMs = explicitMaxtime != null
    ? explicitMaxtime
    : Math.max(cfg.maxtimeFloorMs, perAttemptTimeout + MAXTIME_BUFFER_MS);

  const name = def.name || def.test_title || `test-${index + 1}`;
  const yamlStr = serialiseDefinition(def);

  let lastError = null;
  let timedOut = false;
  let attemptsMade = 0;
  const start = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Circuit-breaker: stop retrying once the wall-clock budget is spent.
    if (attempt > 0 && Date.now() - start > maxtimeMs) {
      timedOut = true;
      break;
    }
    attemptsMade++;
    try {
      await withTimeout(runConsecutive(yamlStr, consecutive), perAttemptTimeout, 'attempt');
      return {
        name,
        passed: true,
        error: null,
        observed: null,
        durationMs: Date.now() - start,
        attempts: attemptsMade,
        timedOut: false,
      };
    } catch (err) {
      lastError = err;
      if (attempt < retries && Date.now() - start <= maxtimeMs) {
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }
  }

  let error;
  if (lastError) {
    error = lastError.message;
  } else if (timedOut) {
    error = `Exceeded maxtime budget (${maxtimeMs}ms) after ${attemptsMade} attempt(s)`;
  } else {
    error = 'Unknown error';
  }

  return {
    name,
    passed: false,
    error,
    observed: lastError && lastError.observed ? lastError.observed : null,
    durationMs: Date.now() - start,
    attempts: attemptsMade,
    timedOut,
  };
}

/**
 * Run all tests defined in the YAML string sequentially.
 * Stops at the first failure (fail-fast).
 *
 * @param {string} yamlString - Raw YAML content (single object or array)
 * @returns {Promise<RunResult>}
 *
 * @typedef {object} RunResult
 * @property {number} total   - Total number of tests defined
 * @property {number} passed  - Number of tests that passed
 * @property {number} failed  - Number of tests that failed (0 or 1 with fail-fast)
 * @property {number} skipped - Number of tests skipped due to fail-fast
 * @property {TestResult[]} results - Per-test outcome
 *
 * @typedef {object} TestResult
 * @property {string}      name       - Test name/title
 * @property {boolean}     passed     - Whether the test passed
 * @property {string|null} error      - Error message on failure
 * @property {number}      durationMs - Wall-clock time in milliseconds
 * @property {number}      attempts   - Number of attempts made (retry support)
 */
async function runTests(yamlString) {
  const definitions = parseTestDefinitions(yamlString);

  // Validate all definitions before executing any test
  validateTestDefinitions(definitions);

  const total = definitions.length;
  const results = [];

  for (let i = 0; i < definitions.length; i++) {
    const def = normaliseDefinition(definitions[i]);
    const result = await runSingleTest(def, i);
    results.push(result);

    if (!result.passed) {
      // Fail-fast: record the rest as skipped
      for (let j = i + 1; j < definitions.length; j++) {
        const skippedDef = definitions[j];
        results.push({
          name: skippedDef.name || skippedDef.test_title || `test-${j + 1}`,
          passed: false,
          error: 'Skipped due to previous failure',
          durationMs: 0,
          attempts: 0,
          skipped: true,
        });
      }
      break;
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  return { total, passed, failed, skipped, results };
}

module.exports = { runTests, parseTestDefinitions, runSingleTest, parseDuration };
