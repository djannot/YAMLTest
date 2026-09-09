'use strict';

// The runner's production defaults (120 retries, 1s pause) would make every
// failing-path test take minutes. For the test suite we pin fast defaults unless
// a test (or CI) overrides them. Individual tests that exercise retry/maxtime/
// consecutive behaviour set the relevant fields or env vars explicitly.
if (!process.env.YAMLTEST_RETRIES) process.env.YAMLTEST_RETRIES = '0';
if (!process.env.YAMLTEST_RETRY_INTERVAL_MS) process.env.YAMLTEST_RETRY_INTERVAL_MS = '0';
