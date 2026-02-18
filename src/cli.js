#!/usr/bin/env node
'use strict';

/**
 * YAMLTest CLI
 *
 * Usage:
 *   YAMLTest -f <file.yaml>
 *   YAMLTest -f -                    # read from stdin
 *   YAMLTest -f <<EOF
 *   - name: test
 *     http: { url: "http://...", method: GET, path: "/" }
 *     source: { type: local }
 *     expect: { statusCode: 200 }
 *   EOF
 *
 * Exit codes:
 *   0  – all tests passed
 *   1  – one or more tests failed / usage error
 */

const fs = require('fs');
const path = require('path');
const { runTests } = require('./runner');

// ── ANSI colours (disabled when NO_COLOR is set or stdout is not a TTY) ──────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
};

// ── Argument parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script
  const opts = { file: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      opts.file = args[i + 1] || null;
      i++;
    } else if (args[i].startsWith('-f=')) {
      opts.file = args[i].slice(3);
    } else if (args[i] === '--help' || args[i] === '-h') {
      opts.help = true;
    }
  }

  return opts;
}

function printUsage() {
  process.stdout.write(
    [
      '',
      c.bold('YAMLTest') + ' – declarative YAML test runner',
      '',
      c.bold('USAGE'),
      '  YAMLTest -f <file.yaml>',
      '  YAMLTest -f -              # read YAML from stdin',
      '  YAMLTest -f <<EOF',
      '  - name: my-test',
      '    http:',
      '      url: "http://example.com"',
      '      method: GET',
      '      path: "/"',
      '    source:',
      '      type: local',
      '    expect:',
      '      statusCode: 200',
      '  EOF',
      '',
      c.bold('OPTIONS'),
      '  -f, --file <path|->   YAML file to run, or - for stdin',
      '  -h, --help            Show this help',
      '',
      c.bold('ENVIRONMENT'),
      '  DEBUG_MODE=true       Enable verbose debug logging',
      '  NO_COLOR=1            Disable ANSI colour output',
      '',
    ].join('\n')
  );
}

// ── Input reading ─────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readInput(filePath) {
  if (filePath === '-') {
    return readStdin();
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  return fs.readFileSync(resolved, 'utf8');
}

// ── Output formatting ─────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printResults(result) {
  const { total, passed, failed, skipped, results } = result;

  process.stdout.write('\n');

  for (const r of results) {
    if (r.skipped) {
      process.stdout.write(
        `  ${c.yellow('○')} ${c.dim(r.name)} ${c.dim('(skipped)')}\n`
      );
    } else if (r.passed) {
      process.stdout.write(
        `  ${c.green('✓')} ${r.name} ${c.dim(formatDuration(r.durationMs))}` +
          (r.attempts > 1 ? c.dim(` [${r.attempts} attempts]`) : '') +
          '\n'
      );
    } else {
      process.stdout.write(
        `  ${c.red('✗')} ${c.bold(r.name)} ${c.dim(formatDuration(r.durationMs))}\n`
      );
      if (r.error) {
        const lines = r.error.split('\n');
        for (const line of lines) {
          process.stdout.write(`      ${c.red(line)}\n`);
        }
      }
    }
  }

  process.stdout.write('\n');

  const summaryParts = [];
  if (passed > 0) summaryParts.push(c.green(`${passed} passed`));
  if (failed > 0) summaryParts.push(c.red(`${failed} failed`));
  if (skipped > 0) summaryParts.push(c.yellow(`${skipped} skipped`));
  summaryParts.push(`${total} total`);

  process.stdout.write(`  ${summaryParts.join(c.dim(' | '))}\n\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  if (!opts.file) {
    process.stderr.write(
      c.red('Error: ') + 'No input specified. Use -f <file> or -f - for stdin.\n\n'
    );
    printUsage();
    process.exit(1);
  }

  let yamlContent;
  try {
    yamlContent = await readInput(opts.file);
  } catch (err) {
    process.stderr.write(c.red('Error: ') + err.message + '\n');
    process.exit(1);
  }

  if (!yamlContent || !yamlContent.trim()) {
    process.stderr.write(c.red('Error: ') + 'Empty input – no YAML content to run.\n');
    process.exit(1);
  }

  let result;
  try {
    result = await runTests(yamlContent);
  } catch (err) {
    process.stderr.write(c.red('Error: ') + err.message + '\n');
    process.exit(1);
  }

  printResults(result);

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(c.red('Fatal: ') + (err.message || String(err)) + '\n');
  process.exit(1);
});
