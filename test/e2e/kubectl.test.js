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
 *   6. large bodies (bodyFile, bodyGenerate, bodySize) through modes 3–5,
 *      against an echo server pod (node:slim) that hashes what it receives
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';
import { bodyEchoHandler } from '../fixtures/body-echo-server.js';

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
const ECHO_POD  = 'yamltest-echo';   // body echo server (node:slim)
const ECHO_SVC  = 'yamltest-echo';
const ECHO_PORT = 8080;

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

  // 6. Body echo server for the large-body tests: the same handler as the
  //    integration suite, run by node:slim (already loaded for kubectl debug)
  const echoPodManifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: ECHO_POD, namespace: NS, labels: { app: ECHO_POD } },
    spec: {
      containers: [{
        name: 'echo',
        image: NODE_IMG,
        imagePullPolicy: 'Never',
        command: ['node', '-e', `require('http').createServer(${bodyEchoHandler.toString()}).listen(${ECHO_PORT})`],
        ports: [{ containerPort: ECHO_PORT }],
        readinessProbe: { tcpSocket: { port: ECHO_PORT }, periodSeconds: 1 },
      }],
    },
  });
  const echoSvcManifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: ECHO_SVC, namespace: NS },
    spec: {
      selector: { app: ECHO_POD },
      ports: [{ port: ECHO_PORT, targetPort: ECHO_PORT }],
      type: 'ClusterIP',
    },
  });

  // Write manifests to temp files and apply (idempotent)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-e2e-'));
  const manifests = { pod: podManifest, svc: svcManifest, echoPod: echoPodManifest, echoSvc: echoSvcManifest };
  for (const [name, manifest] of Object.entries(manifests)) {
    const file = path.join(tmpDir, `${name}.json`);
    fs.writeFileSync(file, manifest);
    run(`kubectl --context=${CONTEXT} apply -f ${file}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 7. Wait for the pods to be Ready
  console.log(`[kubectl-e2e] Waiting for pods ${POD} and ${ECHO_POD} to be Ready…`);
  run(
    `kubectl --context=${CONTEXT} -n ${NS} wait pod/${POD} pod/${ECHO_POD} ` +
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

  it('stores an extracted jsonPath value via setVars', async () => {
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
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
      setVars: { YAMLTEST_POD_PHASE: { value: true } },
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

  it('asserts several jsonPath entries against one resource', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: [
          { path: '$.status.phase', comparator: 'equals', value: 'Running' },
          { path: '$.status.containerStatuses[0].ready', comparator: 'equals', value: true },
          { path: '$.metadata.name', comparator: 'contains', value: 'nginx' },
          { path: `$.metadata.labels['${LABEL_KEY}']`, comparator: 'equals', value: LABEL_VAL },
          { path: '$.spec.containers[?(@.name=="nginx")].image', comparator: 'contains', value: 'nginx' },
          { path: '$.status.phase', comparator: 'equals', value: 'Failed', negate: true },
        ],
        polling: { timeoutSeconds: 30, intervalSeconds: 2 },
      },
    }))).resolves.toBe(true);
  });

  it('throws when one entry of the array never matches, naming that path', async () => {
    await expect(executeTest(yaml({
      wait: {
        target: {
          kind: 'Pod',
          metadata: { namespace: NS, name: POD },
          context: CONTEXT,
        },
        jsonPath: [
          { path: '$.status.phase', comparator: 'equals', value: 'Running' },
          { path: '$.status.phase', comparator: 'equals', value: 'Terminating' },
        ],
        polling: { timeoutSeconds: 4, intervalSeconds: 1 },
      },
    }))).rejects.toThrow(/[Tt]imed.out[\s\S]*\$\.status\.phase/);
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

// ── 6. Large bodies: bodyFile, bodyGenerate, bodySize ─────────────────────────

describe('http – large bodies', () => {
  const echoUrl = `http://${ECHO_SVC}.${NS}.svc.cluster.local:${ECHO_PORT}`;
  const KiB = 1024;
  const MiB = 1024 * KiB;
  let tmpDir;
  let bodyFile;
  let bodySha;

  const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  // Assertions on the echo server's JSON summary of the body it received
  const received = (fields) =>
    Object.entries(fields).map(([key, value]) => ({ path: `$.${key}`, comparator: 'equals', value }));
  const podExec = () => ({ type: 'pod', usePodExec: true, selector: selectorByName() });
  const portForwardToEcho = () => ({
    type: 'pod',
    usePortForward: true,
    selector: { kind: 'Pod', metadata: { namespace: NS, name: ECHO_POD }, context: CONTEXT },
  });

  beforeAll(() => {
    // 300 KiB, well above the 128 KiB a single argv string may hold on Linux,
    // made of every byte value plus quotes, $ and backticks, which the
    // `sh -c "..."` command line would mangle.
    const tricky = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.from('"double" \'single\' $HOME ${HOME} `tick` \\ \r\n'),
    ]);
    const content = Buffer.alloc(300 * KiB, tricky);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-e2e-bodies-'));
    bodyFile = path.join(tmpDir, 'tricky-300k.bin');
    fs.writeFileSync(bodyFile, content);
    bodySha = sha256(content);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('usePodExec: sends a 300 KiB binary bodyFile through stdin, byte for byte', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'POST', path: '/upload', bodyFile },
      source: podExec(),
      expect: {
        statusCode: 200,
        bodyJsonPath: received({ method: 'POST', bytes: 300 * KiB, sha256: bodySha, contentLength: String(300 * KiB) }),
      },
    }))).resolves.toBe(true);
  });

  it('usePodExec: sends a 3 MiB bodyGenerate (curl sends Expect: 100-continue)', async () => {
    await expect(executeTest(yaml({
      http: {
        url: echoUrl, method: 'PUT', path: '/upload',
        headers: { 'Content-Type': 'text/plain' },
        bodyGenerate: { size: 3 * MiB, suffix: 'blocked-request-body' },
      },
      source: podExec(),
      expect: {
        statusCode: 200,   // the final status, not the interim 100 Continue
        bodyJsonPath: received({
          method: 'PUT',
          bytes: 3 * MiB,
          expect: '100-continue',
          tail: `${'a'.repeat(44)}blocked-request-body`,
        }),
      },
    }))).resolves.toBe(true);
  });

  it('usePodExec: counts a response body with bodySize (dropped in the pod)', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'GET', path: `/bytes/${5 * MiB}` },
      source: podExec(),
      expect: {
        statusCode: 200,
        bodySize: 5 * MiB,
        headers: [{ name: 'content-length', comparator: 'equals', value: String(5 * MiB) }],
      },
    }))).resolves.toBe(true);
  });

  it('usePodExec: bodySize alongside a body assertion', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'GET', path: '/bytes/2000' },
      source: podExec(),
      expect: { statusCode: 200, bodySize: 2000, bodyRegex: '^x{2000}$' },
    }))).resolves.toBe(true);
  });

  it('usePodExec: fails a bodySize mismatch', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'GET', path: '/bytes/2000' },
      source: podExec(),
      expect: { statusCode: 200, bodySize: 1999 },
    }))).rejects.toThrow('Body size mismatch: expected 1999 bytes, got 2000 bytes');
  });

  it('usePodExec: still sends an inline body on the command line, as before', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'POST', path: '/form', body: 'hello=world' },
      source: podExec(),
      expect: { statusCode: 200, bodyJsonPath: received({ method: 'POST', bytes: 11, sha256: sha256(Buffer.from('hello=world')) }) },
    }))).resolves.toBe(true);
  });

  it('usePodExec: a missing bodyFile fails before any kubectl call', async () => {
    const missing = path.join(tmpDir, 'missing.bin');
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'POST', path: '/upload', bodyFile: missing },
      source: podExec(),
      expect: { statusCode: 200 },
    }))).rejects.toThrow(`http.bodyFile not found: ${missing}`);
  });

  it('usePortForward: streams a bodyFile through the tunnel', async () => {
    await expect(executeTest(yaml({
      http: { url: `http://localhost:${ECHO_PORT}`, method: 'POST', path: '/upload', bodyFile },
      source: portForwardToEcho(),
      expect: { statusCode: 200, bodyJsonPath: received({ bytes: 300 * KiB, sha256: bodySha }) },
    }))).resolves.toBe(true);
  });

  it('usePortForward: counts a response body with bodySize', async () => {
    await expect(executeTest(yaml({
      http: { url: `http://localhost:${ECHO_PORT}`, method: 'GET', path: `/bytes/${8 * MiB}` },
      source: portForwardToEcho(),
      expect: { statusCode: 200, bodySize: 8 * MiB },
    }))).resolves.toBe(true);
  });

  it('kubectl debug: counts a response body with bodySize', async () => {
    await expect(executeTest(yaml({
      http: { url: echoUrl, method: 'GET', path: `/bytes/${2 * MiB}` },
      source: { type: 'pod', selector: selectorByName() },
      expect: { statusCode: 200, bodySize: 2 * MiB },
    }))).resolves.toBe(true);
  });
});
