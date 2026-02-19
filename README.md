# YAMLTest

Declarative YAML-based test runner for HTTP endpoints, shell commands, and Kubernetes resources.

Define tests in YAML, run them from the CLI or import them programmatically. No test framework boilerplate required.

---

## Installation

**From npm (once published):**

```bash
npm install -g yamltest
```

**From a local clone (before publishing):**

```bash
# Install globally from the repo directory
npm install -g /path/to/YAMLTest

# Or run directly without installing
node /path/to/YAMLTest/src/cli.js -f your-tests.yaml

# Or link it for development (makes YAMLTest available system-wide, auto-updates)
cd /path/to/YAMLTest && npm link
```

**As a dev dependency in another project:**

```bash
npm install --save-dev /path/to/YAMLTest
```

---

## Quick start

```bash
YAMLTest -f - <<EOF
- name: httpbin returns 200
  http:
    url: "https://httpbin.org"
    method: GET
    path: "/get"
  source:
    type: local
  expect:
    statusCode: 200
    bodyContains: "httpbin.org"
EOF
```

Output:

```
  ✓ httpbin returns 200 312ms

  1 passed | 1 total
```

### Capture a value from a JSON response into a shell variable

```bash
# 1. Run the test and save captured values to a temporary env file
YAMLTest --save-env /tmp/yamltest-env.sh -f - <<EOF
- name: fetch todo and capture ID
  http:
    url: "https://jsonplaceholder.typicode.com"
    method: GET
    path: "/todos/1"
  source:
    type: local
  expect:
    statusCode: 200
  capture:
    TODO_ID: "$.id"
    TODO_TITLE: "$.title"
EOF

# 2. Source the file to bring the variables into your shell
source /tmp/yamltest-env.sh

# 3. Use the captured variables
echo "Todo #${TODO_ID}: ${TODO_TITLE}"
```

---

## CLI

```
USAGE
  YAMLTest -f <file.yaml>
  YAMLTest -f -              # read from stdin (heredoc)

OPTIONS
  -f, --file <path|->        YAML file to run, or - for stdin
  --save-env <path>          Write captured env vars to a file (source it afterwards)
  -h, --help                 Show this help

ENVIRONMENT
  DEBUG_MODE=true            Enable verbose debug logging
  NO_COLOR=1                 Disable ANSI colour output
```

Exit codes: `0` = all passed, `1` = one or more failed.

---

## Programmatic API

```js
const { runTests, executeTest } = require('yamltest');

// Run one or more tests from a YAML string (array or single object)
const result = await runTests(yamlString);
console.log(result.passed, result.failed, result.skipped, result.total);
// result.results → [{name, passed, error, durationMs, attempts}]

// Run a single test (low-level)
await executeTest(yamlString); // returns true or throws
```

---

## Test format

Tests are defined as flat YAML objects (or an array of them). All fields except the test type key (`http`, `command`, `wait`, `httpBodyComparison`) are optional.

```yaml
- name: my-test          # optional display name
  retries: 3             # retry up to N times on failure (default: 0)
  http: ...              # ← test type
  source:
    type: local          # local | pod
  expect:
    statusCode: 200
```

---

## Test types

### HTTP test

Test any HTTP endpoint locally or from within a Kubernetes pod.

```yaml
- name: health check
  http:
    url: "https://api.example.com"   # required (or auto-discovered for Service selectors)
    method: GET                       # GET (default) | POST | PUT | DELETE | PATCH
    path: "/health"                   # default: /
    headers:
      Authorization: "Bearer ${API_TOKEN}"
      Content-Type: application/json
    params:
      key: value                      # query parameters
    body: '{"foo":"bar"}'             # request body (string or object)
    skipSslVerification: true         # disable TLS verification
    maxRedirects: 0                   # redirects to follow (default: 0)
    cert: /path/to/cert.pem           # mTLS client certificate
    key:  /path/to/key.pem
    ca:   /path/to/ca.pem
  source:
    type: local
  expect:
    statusCode: 200                   # or [200, 201, 202]
    body: "exact body match"
    bodyContains: "substring"         # or array, or {value, negate, matchword}
    bodyRegex: "pattern.*"            # or {value, negate}
    bodyJsonPath:
      - path: "$.user.id"
        comparator: equals
        value: 42
    headers:
      - name: content-type
        comparator: contains
        value: application/json
  capture:                            # optional: extract values into env vars
    USER_ID: "$.user.id"
    USER_NAME: "$.user.name"
```

**Runnable example** – fetch a todo and capture fields from the JSON response:

```bash
YAMLTest --save-env /tmp/todo-env.sh -f - <<EOF
- name: fetch todo
  http:
    url: "https://jsonplaceholder.typicode.com"
    method: GET
    path: "/todos/1"
  source:
    type: local
  expect:
    statusCode: 200
    bodyJsonPath:
      - path: "$.userId"
        comparator: equals
        value: 1
  capture:
    TODO_ID: "$.id"
    TODO_TITLE: "$.title"
    TODO_COMPLETED: "$.completed"
EOF

source /tmp/todo-env.sh
echo "Todo ${TODO_ID}: ${TODO_TITLE} (completed: ${TODO_COMPLETED})"
```

#### Environment variable substitution

Any `$VAR` or `${VAR}` in the `url` field is resolved from the environment:

```yaml
http:
  url: "${API_BASE_URL}"
```

#### Pod-based HTTP test

Execute the HTTP request from inside a Kubernetes pod (useful for internal service testing):

```yaml
source:
  type: pod
  selector:
    kind: Pod
    metadata:
      namespace: production
      labels:
        app: test-client
    context: my-cluster          # optional kubectl context
  container: my-container        # optional
  usePortForward: true           # use kubectl port-forward instead of debug pod
  usePodExec: true               # use kubectl exec + curl
```

#### Auto-discovery for Kubernetes Services

Omit `http.url` when `source.selector.kind` is `Service` and the IP/port are discovered automatically from the LoadBalancer status:

```yaml
- name: auto-discover service
  http:
    method: GET
    path: /health
    scheme: https                # optional, defaults to http
    port: 443                    # optional port name/number/index
  source:
    type: local
    selector:
      kind: Service
      metadata:
        namespace: production
        name: my-service
  expect:
    statusCode: 200
```

---

### Command test

Run any shell command and validate its output.

```yaml
- name: check kubectl version
  command:
    command: "kubectl version --short"
    parseJson: false              # parse stdout as JSON (default: false)
    env:
      MY_VAR: value               # extra environment variables
    workingDir: /tmp              # working directory
  source:
    type: local                   # or pod (uses kubectl exec)
  expect:
    exitCode: 0
    stdout:
      contains: "Client Version"  # or: equals, matches/regex, negate
    stderr:
      contains: ""
```

Multiple stdout expectations (all must pass):

```yaml
expect:
  exitCode: 0
  stdout:
    - contains: "Running"
    - matches: "\\d+ pods"
```

JSON output validation:

```yaml
- name: cluster info JSON
  command:
    command: "kubectl cluster-info --output=json"
    parseJson: true
  source:
    type: local
  expect:
    exitCode: 0
    jsonPath:
      - path: "$.Kubernetes"
        comparator: exists
```

---

### Wait test

Poll a Kubernetes resource until a condition is met (or timeout).

```yaml
- name: wait for deployment
  wait:
    target:
      kind: Deployment
      metadata:
        namespace: default
        name: my-app
      context: my-cluster        # optional
    jsonPath: "$.status.readyReplicas"
    jsonPathExpectation:
      comparator: greaterThan
      value: 0
    targetEnv: READY_REPLICAS    # optional: store extracted value in env var
    polling:
      timeoutSeconds: 120        # default: 60
      intervalSeconds: 5         # default: 2
      maxRetries: 24             # optional upper bound
```

The `targetEnv` value is stored inside the YAMLTest process. To use it in your shell, combine it with `--save-env`:

```bash
YAMLTest --save-env /tmp/k8s-env.sh -f - <<EOF
- name: wait for deployment ready
  wait:
    target:
      kind: Deployment
      metadata:
        namespace: default
        name: my-app
    jsonPath: "$.status.readyReplicas"
    jsonPathExpectation:
      comparator: greaterThan
      value: 0
    targetEnv: READY_REPLICAS
    polling:
      timeoutSeconds: 120
      intervalSeconds: 5
EOF

source /tmp/k8s-env.sh
echo "Ready replicas: ${READY_REPLICAS}"
```

> **Kubernetes setup:** To run k8s examples locally, create a cluster with [kind](https://kind.sigs.k8s.io/):
> ```bash
> kind create cluster --name my-cluster
> kubectl --context kind-my-cluster create deployment my-app --image=nginx
> ```

Selector by labels:

```yaml
wait:
  target:
    kind: Pod
    metadata:
      namespace: production
      labels:
        app: web-server
        version: v1.2.0
  jsonPath: "$.status.phase"
  jsonPathExpectation:
    comparator: equals
    value: Running
```

---

### HTTP body comparison test

Compare the response bodies of two HTTP calls and assert they are identical (useful for canary / shadow traffic validation).

```yaml
- name: compare two backends
  httpBodyComparison:
    request1:
      http:
        url: "http://service-v1"
        method: GET
        path: /api/data
      source:
        type: local
    request2:
      http:
        url: "http://service-v2"
        method: GET
        path: /api/data
      source:
        type: local
    parseAsJson: true            # parse bodies as JSON before comparing
    delaySeconds: 1              # wait between requests
    removeJsonPaths:             # ignore dynamic fields
      - "$.timestamp"
      - "$.requestId"
```

---

## Expectation operators

All comparators can be negated with `negate: true`.

| Comparator    | Description                          | Types          |
|---------------|--------------------------------------|----------------|
| `equals`      | Deep equality                        | any            |
| `contains`    | Substring / JSON-stringified search  | string, object |
| `matches`     | Regular expression test              | string         |
| `exists`      | Value is not null/undefined          | any            |
| `greaterThan` | Numeric `>`                          | number         |
| `lessThan`    | Numeric `<`                          | number         |

### Negation example

```yaml
expect:
  bodyContains:
    value: "error"
    negate: true        # assert the body does NOT contain "error"
```

### Word-boundary match

```yaml
expect:
  bodyContains:
    value: "ok"
    matchword: true     # uses \bok\b regex (whole word only)
```

---

## Advanced features

### Capturing values into shell environment variables

YAMLTest can extract values from test responses and make them available in your shell after the run.

**HTTP tests** use a `capture` map at the test level:

```bash
YAMLTest --save-env /tmp/env.sh -f - <<EOF
- name: fetch user
  http:
    url: "https://jsonplaceholder.typicode.com"
    method: GET
    path: "/users/1"
  source:
    type: local
  expect:
    statusCode: 200
  capture:
    USER_NAME: "$.name"
    USER_EMAIL: "$.email"
    USER_CITY: "$.address.city"
EOF

source /tmp/env.sh
echo "Name: ${USER_NAME}, Email: ${USER_EMAIL}, City: ${USER_CITY}"
```

**Kubernetes wait tests** use `targetEnv` (a single variable):

```bash
YAMLTest --save-env /tmp/k8s-env.sh -f - <<EOF
- name: wait for deployment
  wait:
    target:
      kind: Deployment
      metadata:
        namespace: default
        name: my-app
    jsonPath: "$.status.readyReplicas"
    jsonPathExpectation:
      comparator: greaterThan
      value: 0
    targetEnv: READY_REPLICAS
    polling:
      timeoutSeconds: 60
EOF

source /tmp/k8s-env.sh
echo "Ready replicas: ${READY_REPLICAS}"
```

The `--save-env <path>` flag writes `export VAR='value'` lines to the given file. Source it in your shell to make the variables available. The file is only written when at least one variable was captured.

### Retry on failure

```yaml
- name: flaky service
  retries: 5            # retry up to 5 times, 500ms between attempts
  http:
    url: "http://flaky-service"
    method: GET
    path: /api
  source:
    type: local
  expect:
    statusCode: 200
```

### Multiple tests in one file

Tests run **sequentially** and stop at the first failure (fail-fast).

```yaml
- name: first test
  http: { url: "http://svc", method: GET, path: /ready }
  source: { type: local }
  expect: { statusCode: 200 }

- name: second test
  command: { command: "kubectl get pods -n default" }
  source: { type: local }
  expect: { exitCode: 0, stdout: { contains: "Running" } }
```

### Environment variables in URL

```yaml
http:
  url: "$API_BASE_URL"          # $VAR or ${VAR}
  headers:
    Authorization: "Bearer ${API_TOKEN}"
```

---

## Debug logging

```bash
DEBUG_MODE=true YAMLTest -f tests.yaml
```

Prints full request/response details, comparison results, and kubectl commands.

---

## Project structure

```
src/
  core.js       # Test execution engine (HTTP, command, wait, comparison)
  runner.js     # Multi-test orchestration (YAML parsing, fail-fast, retry)
  index.js      # Public API
  cli.js        # YAMLTest binary entry point
test/
  unit/         # Pure function tests (compareValue, filterJson, parseCurl, ...)
  integration/  # Real HTTP server + real shell command tests
  e2e/          # CLI binary spawned end-to-end
```

---

## Running the test suite

```bash
npm test                    # all tests
npm run test:unit           # unit tests only
npm run test:integration    # integration tests only
npm run test:e2e            # end-to-end CLI tests only
npm run test:coverage       # with coverage report
```

---

## CI/CD

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm test
```

---

## License

MIT
