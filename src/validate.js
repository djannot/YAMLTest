'use strict';

const Ajv = require('ajv');
const ajvErrors = require('ajv-errors');

// ── Reusable sub-schemas ─────────────────────────────────────────────

const comparatorEnum = {
  type: 'string',
  enum: ['equals', 'contains', 'matches', 'exists', 'greaterThan', 'lessThan'],
};

const jsonPathExpectationItem = {
  type: 'object',
  required: ['path', 'comparator'],
  properties: {
    path: { type: 'string' },
    comparator: comparatorEnum,
    value: {},               // any type
    negate: { type: 'boolean' },
  },
  additionalProperties: false,
};

const headerExpectationItem = {
  type: 'object',
  required: ['name', 'comparator'],
  properties: {
    name: { type: 'string' },
    comparator: { type: 'string', enum: ['equals', 'contains', 'matches', 'exists', 'greaterThan', 'lessThan'] },
    value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    negate: { type: 'boolean' },
  },
  additionalProperties: false,
};

// bodyContains / bodyRegex accept: string | object | array of (string|object)
const bodyContainsItem = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' },
        negate: { type: 'boolean' },
        matchword: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
};

const bodyContainsSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' },
        negate: { type: 'boolean' },
        matchword: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    {
      type: 'array',
      items: bodyContainsItem,
      minItems: 1,
    },
  ],
};

const bodyRegexItem = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' },
        negate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
};

const bodyRegexSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' },
        negate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    {
      type: 'array',
      items: bodyRegexItem,
      minItems: 1,
    },
  ],
};

// Output expectation for command stdout/stderr/output
const outputExpectationItem = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        contains: { type: 'string' },
        equals: { type: 'string' },
        matches: { type: 'string' },
        regex: { type: 'string' },
        exists: { type: 'boolean' },
        negate: { type: 'boolean' },
        comparator: comparatorEnum,
        value: {},
      },
      additionalProperties: false,
    },
    {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              contains: { type: 'string' },
              equals: { type: 'string' },
              matches: { type: 'string' },
              regex: { type: 'string' },
              exists: { type: 'boolean' },
              negate: { type: 'boolean' },
              comparator: comparatorEnum,
              value: {},
            },
            additionalProperties: false,
          },
        ],
      },
      minItems: 1,
    },
  ],
};

// ── K8s selector ─────────────────────────────────────────────────────

const k8sSelector = {
  type: 'object',
  required: ['kind', 'metadata'],
  properties: {
    kind: { type: 'string' },
    context: { type: 'string' },
    metadata: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        name: { type: 'string' },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
      anyOf: [
        { required: ['name'] },
        { required: ['labels'] },
      ],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ── Source ────────────────────────────────────────────────────────────

const sourceSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['local', 'pod'] },
    selector: k8sSelector,
    container: { type: 'string' },
    usePortForward: { type: 'boolean' },
    usePodExec: { type: 'boolean' },
  },
  if: { properties: { type: { const: 'pod' } } },
  then: { required: ['selector'] },
  additionalProperties: false,
};

// ── HTTP config ──────────────────────────────────────────────────────

const httpConfigSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get', 'post', 'put', 'delete', 'patch', 'options'] },
    path: { type: 'string' },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    params: {
      type: 'object',
      additionalProperties: {},
    },
    body: {},   // string or object
    skipSslVerification: { type: 'boolean' },
    maxRedirects: { type: 'number' },
    cert: { type: 'string' },
    key: { type: 'string' },
    ca: { type: 'string' },
    scheme: { type: 'string', enum: ['http', 'https'] },
    port: { oneOf: [{ type: 'number' }, { type: 'string' }] },
  },
  additionalProperties: false,
};

// ── HTTP expect ──────────────────────────────────────────────────────

const httpExpectSchema = {
  type: 'object',
  properties: {
    statusCode: {
      oneOf: [
        { type: 'number' },
        { type: 'array', items: { type: 'number' }, minItems: 1 },
      ],
    },
    body: {},   // any type for exact match
    bodyContains: bodyContainsSchema,
    bodyRegex: bodyRegexSchema,
    bodyJsonPath: {
      type: 'array',
      items: jsonPathExpectationItem,
      minItems: 1,
    },
    headers: {
      type: 'array',
      items: headerExpectationItem,
      minItems: 1,
    },
  },
  additionalProperties: false,
};

// ── HTTP setVars ─────────────────────────────────────────────────────

const httpSetVarRule = {
  type: 'object',
  properties: {
    jsonPath: { type: 'string' },
    header: { type: 'string' },
    statusCode: { const: true },
    body: { const: true },
    regex: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        group: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const httpSetVarsSchema = {
  type: 'object',
  additionalProperties: httpSetVarRule,
};

// ── Command config ───────────────────────────────────────────────────

const commandConfigSchema = {
  type: 'object',
  required: ['command'],
  properties: {
    command: { type: 'string' },
    parseJson: { type: 'boolean' },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    workingDir: { type: 'string' },
  },
  additionalProperties: false,
};

// ── Command expect ───────────────────────────────────────────────────

const commandExpectSchema = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    stdout: outputExpectationItem,
    stderr: outputExpectationItem,
    output: outputExpectationItem,
    json: {},   // any type for direct comparison
    jsonPath: {
      type: 'array',
      items: jsonPathExpectationItem,
      minItems: 1,
    },
  },
  additionalProperties: false,
};

// ── Command setVars ──────────────────────────────────────────────────

const commandSetVarRule = {
  type: 'object',
  properties: {
    jsonPath: { type: 'string' },
    stdout: { const: true },
    stderr: { const: true },
    exitCode: { const: true },
    regex: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        group: { type: 'number' },
        source: { type: 'string', enum: ['stdout', 'stderr'] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const commandSetVarsSchema = {
  type: 'object',
  additionalProperties: commandSetVarRule,
};

// ── Wait config ──────────────────────────────────────────────────────

const waitConfigSchema = {
  type: 'object',
  required: ['target'],
  properties: {
    target: k8sSelector,
    jsonPath: { type: 'string' },
    jsonPathExpectation: {
      type: 'object',
      required: ['comparator'],
      properties: {
        comparator: comparatorEnum,
        value: {},
        negate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    polling: {
      type: 'object',
      properties: {
        timeoutSeconds: { type: 'number' },
        intervalSeconds: { type: 'number' },
        maxRetries: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ── Wait setVars ─────────────────────────────────────────────────────

const waitSetVarRule = {
  type: 'object',
  properties: {
    value: { const: true },
  },
  additionalProperties: false,
};

const waitSetVarsSchema = {
  type: 'object',
  additionalProperties: waitSetVarRule,
};

// ── HTTP body comparison config ──────────────────────────────────────

const httpBodyComparisonRequestSchema = {
  type: 'object',
  required: ['http', 'source'],
  properties: {
    http: httpConfigSchema,
    source: sourceSchema,
  },
  additionalProperties: false,
};

const httpBodyComparisonConfigSchema = {
  type: 'object',
  required: ['request1', 'request2'],
  properties: {
    request1: httpBodyComparisonRequestSchema,
    request2: httpBodyComparisonRequestSchema,
    parseAsJson: { type: 'boolean' },
    delaySeconds: { type: 'number' },
    removeJsonPaths: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
};

// ── Main test definition schema ──────────────────────────────────────

const testDefinitionSchema = {
  type: 'object',
  required: [],
  properties: {
    name: { type: 'string' },
    retries: { type: 'integer', minimum: 0 },
    source: sourceSchema,
    http: httpConfigSchema,
    command: commandConfigSchema,
    wait: waitConfigSchema,
    httpBodyComparison: httpBodyComparisonConfigSchema,
    expect: {},     // validated conditionally per test type
    setVars: {},    // validated conditionally per test type
  },
  // Exactly one test type must be present
  oneOf: [
    {
      required: ['http'],
      not: { anyOf: [{ required: ['command'] }, { required: ['wait'] }, { required: ['httpBodyComparison'] }] },
    },
    {
      required: ['command'],
      not: { anyOf: [{ required: ['http'] }, { required: ['wait'] }, { required: ['httpBodyComparison'] }] },
    },
    {
      required: ['wait'],
      not: { anyOf: [{ required: ['http'] }, { required: ['command'] }, { required: ['httpBodyComparison'] }] },
    },
    {
      required: ['httpBodyComparison'],
      not: { anyOf: [{ required: ['http'] }, { required: ['command'] }, { required: ['wait'] }] },
    },
  ],
  // Conditional validation of expect and setVars per test type
  allOf: [
    // HTTP: validate expect and setVars shapes
    {
      if: { required: ['http'] },
      then: {
        required: ['source', 'expect'],
        properties: {
          expect: httpExpectSchema,
          setVars: httpSetVarsSchema,
        },
      },
    },
    // HTTP: url is required unless source is a local Service (auto-discovery)
    {
      if: { required: ['http'] },
      then: {
        anyOf: [
          { type: 'object', properties: { http: { type: 'object', required: ['url'] } } },
          {
            type: 'object',
            properties: {
              source: {
                type: 'object',
                properties: {
                  type: { const: 'local' },
                  selector: { type: 'object', properties: { kind: { const: 'Service' } }, required: ['kind'] },
                },
                required: ['type', 'selector'],
              },
            },
          },
        ],
        errorMessage: 'http.url is required (or use source.selector.kind: Service for auto-discovery)',
      },
    },
    // Command: validate expect and setVars shapes
    {
      if: { required: ['command'] },
      then: {
        required: ['source', 'expect'],
        properties: {
          expect: commandExpectSchema,
          setVars: commandSetVarsSchema,
        },
      },
    },
    // Wait: no expect, setVars uses wait-specific rules
    {
      if: { required: ['wait'] },
      then: {
        properties: {
          setVars: waitSetVarsSchema,
        },
        not: { required: ['expect'] },
      },
    },
    // HTTP body comparison: no expect, no setVars
    {
      if: { required: ['httpBodyComparison'] },
      then: {
        not: { anyOf: [{ required: ['expect'] }, { required: ['setVars'] }] },
      },
    },
    // setVars requires expect (for http and command)
    {
      if: {
        required: ['setVars'],
        anyOf: [{ required: ['http'] }, { required: ['command'] }],
      },
      then: {
        required: ['expect'],
      },
    },
  ],
  additionalProperties: true,
};

const rootSchema = {
  type: 'array',
  items: testDefinitionSchema,
  minItems: 1,
};

// ── Compile schema ───────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, verbose: true });
ajvErrors(ajv);

const validate = ajv.compile(rootSchema);

// ── Error formatting ─────────────────────────────────────────────────

/**
 * Format Ajv validation errors into human-readable messages.
 * @param {Array} errors - Ajv error objects
 * @param {Array} definitions - The original test definitions array
 * @returns {string} - Formatted error message
 */
function formatValidationErrors(errors, definitions) {
  // Deduplicate and filter out noise from oneOf/anyOf wrappers
  const seen = new Set();
  const meaningful = [];

  // Collect instance paths that have a custom errorMessage so we can suppress
  // the raw sub-errors from their anyOf branches (they are noise).
  const errorMessagePaths = errors
    .filter(e => e.keyword === 'errorMessage')
    .map(e => e.instancePath);

  // Returns true when a custom errorMessage covers this instancePath (exact or ancestor).
  const coveredByErrorMessage = (instancePath) =>
    errorMessagePaths.some(p => instancePath === p || instancePath.startsWith(p + '/'));

  for (const err of errors) {
    // Skip generic wrapper messages that aren't actionable
    if (err.keyword === 'if' || err.keyword === 'ifThen') continue;

    // Skip raw sub-errors that originate inside an anyOf branch when a custom
    // errorMessage already covers the same instance path — the errorMessage is
    // the actionable line; the branch sub-errors are misleading noise.
    if (err.schemaPath.includes('/anyOf/') && coveredByErrorMessage(err.instancePath)) continue;

    const key = `${err.instancePath}|${err.keyword}|${err.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    meaningful.push(err);
  }

  const lines = [];

  for (const err of meaningful) {
    // Extract test index from path like /0/http/method
    const pathMatch = err.instancePath.match(/^\/(\d+)(\/.*)?$/);
    let prefix;
    if (pathMatch) {
      const idx = parseInt(pathMatch[0].split('/')[1], 10);
      const name = definitions[idx]?.name;
      const subPath = pathMatch[2] || '';
      prefix = name ? `Test #${idx + 1} ("${name}")` : `Test #${idx + 1}`;
      prefix += subPath ? ` ${subPath}` : '';
    } else {
      prefix = err.instancePath || '(root)';
    }

    let message;
    switch (err.keyword) {
      case 'oneOf': {
        // Check context: is this about test type selection?
        if (err.instancePath.match(/^\/\d+$/) || err.instancePath === '') {
          message = 'must define exactly one of: http, command, wait, httpBodyComparison';
        } else {
          message = err.message;
        }
        break;
      }
      case 'enum':
        message = `must be one of: ${err.params.allowedValues.join(', ')}`;
        break;
      case 'required':
        message = `missing required property "${err.params.missingProperty}"`;
        break;
      case 'additionalProperties':
        message = `unknown property "${err.params.additionalProperty}"`;
        break;
      case 'type':
        message = `must be ${err.params.type}`;
        break;
      case 'anyOf':
        // Often comes from metadata needing name or labels
        if (err.instancePath.includes('metadata')) {
          message = 'must have either "name" or "labels"';
        } else {
          message = err.message;
        }
        break;
      case 'not':
        // Comes from forbidden combinations
        if (err.instancePath.match(/^\/\d+$/)) {
          message = 'must define exactly one of: http, command, wait, httpBodyComparison';
        } else {
          message = err.message;
        }
        break;
      default:
        message = err.message;
    }

    lines.push(`  ${prefix}: ${message}`);
  }

  // Deduplicate final lines
  const uniqueLines = [...new Set(lines)];
  return `Validation failed:\n\n${uniqueLines.join('\n')}`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Validate an array of parsed test definitions against the schema.
 * Throws an Error with a descriptive multi-line message if validation fails.
 *
 * @param {Array<object>} definitions - Array of parsed test definition objects
 * @throws {Error} If any definition fails validation
 */
function validateTestDefinitions(definitions) {
  const valid = validate(definitions);
  if (!valid) {
    const message = formatValidationErrors(validate.errors, definitions);
    throw new Error(message);
  }
}

module.exports = { validateTestDefinitions };
