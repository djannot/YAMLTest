'use strict';

/**
 * End-to-end tests for all kubectl execution paths in core.js.
 *
 * Requires: kind, kubectl, docker — all on PATH.
 *
 * Cluster lifecycle:
 *   beforeAll  – creates kind cluster "yamltest-e2e", pre-loads node:slim,
 *                deploys nginx pod + ClusterIP service, waits for Ready.
 *   afterAll   – deletes the cluster unconditionally.
 *                Set YAMLTEST_KEEP_CLUSTER=true to skip deletion (dev mode).
 *
 * Paths covered:
 *   1. executeKubectlWait          – wait: test type
 *   2. executePodCommand           – command: + source.type: pod
 *   3. executePodHttpRequestViaPodExec    – http: + usePodExec: true
 *   4. executePodHttpRequestViaPortForward – http: + usePortForward: true
 *   5. debugPodWithHttpRequest     – http: + source.type: pod (default debug)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CLUSTER   = 'yamltest-e2e';
const CONTEXT   = `kind-${CLUSTER}`;
const NS        = 'default';
const POD       = 'yamltest-nginx';
const SVC       = 'yamltest-svc';
const LABEL_KEY = 'app';
const LABEL_VAL = 'yamltest-nginx';
const IMAGE     = 'nginx:alpine';    // small, fast to pull
const NODE_IMG  = 'node:slim';       // needed for kubectl debug path

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function tryRun(cmd) {
  try { return run(cmd); } catch (_) { return null; }
}

/** Build a YAML string for executeTest from a plain object (uses JSON subset). */
function yaml(obj) {
  return JSON.stringify(obj);
}

/** Selector block reused across tests. */
function selectorByName() {
  return {
    kind: 'Pod',
    metadata: { namespace: NS, name: POD },
    context: CONTEXT,
  };
}

function selectorByLabel() {
  return {
    kind: 'Pod',
    metadata: { namespace: NS, labels: { [LABEL_KEY]: LABEL_VAL } },
    context: CONTEXT,
  };
}

// ── Cluster setup / teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create cluster if it doesn't exist
  const clusters = tryRun('kind get clusters') || '';
  if (!clusters.split('\n').map(s => s.trim()).includes(CLUSTER)) {
    console.log(`[kubectl-e2e] Creating kind cluster "${CLUSTER}"…`);
    run(`kind create cluster --name ${CLUSTER}`);
  } else {
    console.log(`[kubectl-e2e] Cluster "${CLUSTER}" already exists, reusing.`);
  }

  // 2. Pull nginx:alpine locally and load into kind (fast, ~8 MB)
  console.log(`[kubectl-e2e] Loading ${IMAGE} into kind…`);
  tryRun(`docker pull ${IMAGE}`);
  run(`kind load docker-image ${IMAGE} --name ${CLUSTER}`);

  // 3. Pull node:slim locally and load into kind (needed for kubectl debug path)
  console.log(`[kubectl-e2e] Loading ${NODE_IMG} into kind (this may take a moment)…`);
  tryRun(`docker pull ${NODE_IMG}`);
  run(`kind load docker-image ${NODE_IMG} --name ${CLUSTER}`);

  // 4. Deploy nginx Pod
  const podManifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: POD, namespace: NS, labels: { [LABEL_KEY]: LABEL_VAL } },
    spec: {
      containers: [{
        name: 'nginx',
        image: IMAGE,
        ports: [{ containerPort: 80 }],
        // Pre-pulled image – never go to registry from inside the cluster
        imagePullPolicy: 'Never',
      }],
    },
  });

  // 5. Deploy ClusterIP Service
  const svcManifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: SVC, namespace: NS },
    spec: {
      selector: { [LABEL_KEY]: LABEL_VAL },
      ports: [{ port: 80, targetPort: 80 }],
      type: 'ClusterIP',
    },
  });

  // Write manifests to temp files and apply (idempotent)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-e2e-'));
  const podFile = path.join(tmpDir, 'pod.json');
  const svcFile = path.join(tmpDir, 'svc.json');
  fs.writeFileSync(podFile, podManifest);
  fs.writeFileSync(svcFile, svcManifest);
  run(`kubectl --context=${CONTEXT} apply -f ${podFile}`);
  run(`kubectl --context=${CONTEXT} apply -f ${svcFile}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 6. Wait for the pod to be Ready
  console.log(`[kubectl-e2e] Waiting for pod ${POD} to be Ready…`);
  run(
    `kubectl --context=${CONTEXT} -n ${NS} wait pod/${POD} ` +
    `--for=condition=Ready --timeout=120s`
  );

  console.log('[kubectl-e2e] Cluster ready.');
}, 210_000);

afterAll(() => {
  if (process.env.YAMLTEST_KEEP_CLUSTER === 'true') {
    console.log(`[kubectl-e2e] YAMLTEST_KEEP_CLUSTER=true – skipping cluster deletion.`);
    return;
  }
  console.log(`[kubectl-e2e] Deleting kind cluster "${CLUSTER}"…`);
  tryRun(`kind delete cluster --name ${CLUSTER}`);
});

// ── 1. kubectl wait ───────────────────────────────────────────────────────────

describe('kubectl wait', () => {
  it('waits for pod to be Running by name', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: '$.status.phase',
        jsonPathExpectation: { comparator: 'equals', value: 'Running' },
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
    }))).resolves.toBe(true);
  });

  it('waits for pod to be Running by label selector', async () => {
    // Label selectors return a List object; use $.items[0].status.phase
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, labels: { [LABEL_KEY]: LABEL_VAL } },
          context: CONTEXT,
        },
        jsonPath: '$.items[0].status.phase',
        jsonPathExpectation: { comparator: 'equals', value: 'Running' },
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
    }))).resolves.toBe(true);
  });

  it('stores an extracted jsonPath value in targetEnv', async () => {
    delete process.env.YAMLTEST_POD_PHASE;
    await executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: '$.status.phase',
        jsonPathExpectation: { comparator: 'equals', value: 'Running' },
        targetEnv: 'YAMLTEST_POD_PHASE',
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
    }));
    expect(process.env.YAMLTEST_POD_PHASE).toBe('Running');
    delete process.env.YAMLTEST_POD_PHASE;
  });

  it('uses equals comparator on a boolean jsonPath value (containerStatus ready)', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        // Check that the first container is ready (boolean true)
        jsonPath: '$.status.containerStatuses[0].ready',
        jsonPathExpectation: { comparator: 'equals', value: true },
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
    }))).resolves.toBe(true);
  });

  it('throws when condition is never met (short timeout)', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: '$.status.phase',
        jsonPathExpectation: { comparator: 'equals', value: 'Terminating' },
        polling: { timeoutSeconds: 4, intervalSeconds: 1 },
      },
    }))).rejects.toThrow(/[Tt]imed.out|[Mm]aximum retries/);
  });

  it('throws when maxRetries is exhausted before timeout', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: '$.status.phase',
        jsonPathExpectation: { comparator: 'equals', value: 'Terminating' },
        polling: { timeoutSeconds: 60, intervalSeconds: 1, maxRetries: 2 },
      },
    }))).rejects.toThrow(/[Mm]aximum retries/);
  });
});

// ── 2. command – pod exec ────────────────────────────────────────────────────

describe('command – pod exec', () => {
  it('runs a command in the pod by name and validates stdout', async () => {
    await expect(executeTest(yaml({
      command: { command: 'echo hello-from-pod' },
      source: { type: 'pod', selector: selectorByName() },
      expect: { exitCode: 0, stdout: { contains: 'hello-from-pod' } },
    }))).resolves.toBe(true);
  });

  it('runs a command in the pod by label selector', async () => {
    await expect(executeTest(yaml({
      command: { command: 'echo label-test' },
      source: { type: 'pod', selector: selectorByLabel() },
      expect: { exitCode: 0, stdout: { contains: 'label-test' } },
    }))).resolves.toBe(true);
  });

  it('injects env vars into the pod command', async () => {
    await expect(executeTest(yaml({
      command: {
        // Use printenv to avoid shell-expansion issues with `echo $MY_VAR`
        // when the var is injected via `env KEY="val" sh -c "echo $MY_VAR"`.
        command: 'printenv MY_VAR',
        env: { MY_VAR: 'injected-value' },
      },
      source: { type: 'pod', selector: selectorByName() },
      expect: { exitCode: 0, stdout: { contains: 'injected-value' } },
    }))).resolves.toBe(true);
  });

  it('parses JSON output from a pod command', async () => {
    // executePodCommand now wraps the command in sh -c '...' (single quotes),
    // so double quotes in the command are safe. Single quotes are escaped via
    // the standard '\'' POSIX trick.
    await expect(executeTest(yaml({
      command: {
        command: "printf '{\"status\":\"ok\",\"version\":\"1.0\"}'",
        parseJson: true,
      },
      source: { type: 'pod', selector: selectorByName() },
      expect: {
        exitCode: 0,
        jsonPath: [{ path: '$.status', comparator: 'equals', value: 'ok' }],
      },
    }))).resolves.toBe(true);
  });

  it('validates negated stdout (no "error" in output)', async () => {
    await expect(executeTest(yaml({
      command: { command: 'echo all-good' },
      source: { type: 'pod', selector: selectorByName() },
      expect: {
        exitCode: 0,
        stdout: { contains: 'error', negate: true },
      },
    }))).resolves.toBe(true);
  });
});

// ── 3. http – pod exec + curl (usePodExec: true) ─────────────────────────────

describe('http – pod exec (curl)', () => {
  // nginx inside the pod listens on 127.0.0.1:80 from the pod's perspective.
  // We target the ClusterIP service DNS, which is resolvable inside the pod.
  const internalUrl = `http://${SVC}.${NS}.svc.cluster.local`;

  it('makes a GET request via kubectl exec curl by pod name', async () => {
    await expect(executeTest(yaml({
      http: {
        url: internalUrl,
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePodExec: true,
        selector: selectorByName(),
      },
      expect: { statusCode: 200, bodyContains: 'nginx' },
    }))).resolves.toBe(true);
  });

  it('makes a GET request via kubectl exec curl by label selector', async () => {
    await expect(executeTest(yaml({
      http: {
        url: internalUrl,
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePodExec: true,
        selector: selectorByLabel(),
      },
      expect: { statusCode: 200 },
    }))).resolves.toBe(true);
  });

  it('sends a custom header via kubectl exec curl', async () => {
    await expect(executeTest(yaml({
      http: {
        url: internalUrl,
        method: 'GET',
        path: '/',
        headers: { 'X-Test-Header': 'yamltest' },
      },
      source: {
        type: 'pod',
        usePodExec: true,
        selector: selectorByName(),
      },
      expect: { statusCode: 200 },
    }))).resolves.toBe(true);
  });
});

// ── 4. http – port-forward (usePortForward: true) ────────────────────────────

describe('http – port-forward', () => {
  it('port-forwards to a pod by name and makes a GET request', async () => {
    await expect(executeTest(yaml({
      http: {
        url: 'http://localhost',   // overwritten with forwarded port at runtime
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePortForward: true,
        selector: selectorByName(),
      },
      expect: { statusCode: 200, bodyContains: 'nginx' },
    }))).resolves.toBe(true);
  });

  it('port-forwards to a Service by name and makes a GET request', async () => {
    await expect(executeTest(yaml({
      http: {
        url: 'http://localhost',
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePortForward: true,
        selector: {
          kind: 'Service',
          metadata: { namespace: NS, name: SVC },
          context: CONTEXT,
        },
      },
      expect: { statusCode: 200, bodyContains: 'nginx' },
    }))).resolves.toBe(true);
  });

  it('port-forwards to a pod by label selector and makes a GET request', async () => {
    await expect(executeTest(yaml({
      http: {
        url: 'http://localhost',
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePortForward: true,
        selector: selectorByLabel(),
      },
      expect: { statusCode: 200 },
    }))).resolves.toBe(true);
  });

  it('validates bodyRegex via port-forward', async () => {
    await expect(executeTest(yaml({
      http: {
        url: 'http://localhost',
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        usePortForward: true,
        selector: selectorByName(),
      },
      expect: { statusCode: 200, bodyRegex: 'nginx|Welcome' },
    }))).resolves.toBe(true);
  });
});

// ── 5. http – kubectl debug (default pod path) ────────────────────────────────

describe('http – kubectl debug (ephemeral node:slim container)', () => {
  // The debug container runs node:slim and makes an HTTP request to the
  // ClusterIP service. node:slim is pre-loaded into kind in beforeAll.
  const internalUrl = `http://${SVC}.${NS}.svc.cluster.local`;

  it('makes a GET request via debug container by pod name', async () => {
    await expect(executeTest(yaml({
      http: {
        url: internalUrl,
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        selector: selectorByName(),
        // no usePortForward, no usePodExec → debug path
      },
      expect: { statusCode: 200, bodyContains: 'nginx' },
    }))).resolves.toBe(true);
  });

  it('makes a GET request via debug container by label selector', async () => {
    await expect(executeTest(yaml({
      http: {
        url: internalUrl,
        method: 'GET',
        path: '/',
      },
      source: {
        type: 'pod',
        selector: selectorByLabel(),
      },
      expect: { statusCode: 200 },
    }))).resolves.toBe(true);
  });
});
