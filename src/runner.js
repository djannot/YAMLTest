'use strict';

const yaml = require('js-yaml');
const { executeTest } = require('./core');

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

/**
 * Run a single test definition with optional retry support.
 *
 * @param {object} def - Normalised test definition
 * @param {number} index - 0-based index in the test array (for labelling)
 * @returns {Promise<{name: string, passed: boolean, error: string|null, durationMs: number}>}
 */
async function runSingleTest(def, index) {
  const retries = typeof def.retries === 'number' ? def.retries : 0;
  const name = def.name || def.test_title || `test-${index + 1}`;
  const yamlStr = serialiseDefinition(def);

  let lastError = null;
  const start = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await executeTest(yamlStr);
      return {
        name,
        passed: true,
        error: null,
        durationMs: Date.now() - start,
        attempts: attempt + 1,
      };
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Brief pause between retries so transient failures can recover
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  return {
    name,
    passed: false,
    error: lastError ? lastError.message : 'Unknown error',
    durationMs: Date.now() - start,
    attempts: retries + 1,
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

module.exports = { runTests, parseTestDefinitions, runSingleTest };
