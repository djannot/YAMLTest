'use strict';

/**
 * YAMLTest – public API
 *
 * Programmatic usage:
 *
 *   const { runTests, executeTest } = require('yamltest');
 *
 *   // Run one or more tests from a YAML string
 *   const result = await runTests(yamlString);
 *   console.log(result.passed, result.failed);
 *
 *   // Run a single test object (low-level, v2.js API)
 *   await executeTest(yamlString);
 */

// Multi-test orchestration layer
const { runTests, parseTestDefinitions, runSingleTest } = require('./runner');

// Schema validation
const { validateTestDefinitions } = require('./validate');

// Low-level core exports (single-test API)
const {
  executeTest,
  executeHttpTest,
  executeKubectlWait,
  executeCommandTest,
  executeHttpBodyComparisonTest,
  filterJsonByJsonPath,
  executePodHttpRequestViaPodExec,
  applySetVars,
} = require('./core');

module.exports = {
  // High-level runner
  runTests,
  parseTestDefinitions,
  runSingleTest,
  validateTestDefinitions,

  // Low-level single-test API (v2.js re-exports)
  executeTest,
  executeHttpTest,
  executeKubectlWait,
  executeCommandTest,
  executeHttpBodyComparisonTest,
  filterJsonByJsonPath,
  executePodHttpRequestViaPodExec,
  applySetVars,
};
