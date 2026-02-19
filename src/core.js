const axios = require('axios');
const https = require('https');
const fs = require('fs-extra');
const { execSync, spawn } = require('child_process');
const { JSONPath } = require('jsonpath-plus');
const diff = require('deep-diff').diff;
const yaml = require('js-yaml');
const net = require('net');

/**
 * Debug logging helper - only logs when DEBUG_MODE env var is set to 'true'
 */
function debugLog(...args) {
  if (process.env.DEBUG_MODE === 'true') {
    console.debug(...args);
  }
}

/**
 * Builds kubectl command argument parts for resource selection
 * @param {object} selector - The Kubernetes selector
 * @returns {object} - Object containing command argument parts
 */
const buildSelectorArgs = (selector) => {
  // Determine the resource kind
  const kindArg = selector.kind.toLowerCase();

  // Add namespace if specified
  const namespaceArg = selector.metadata.namespace ? `-n ${selector.metadata.namespace}` : '';

  // Add context if specified
  const contextArg = selector.context ? `--context=${resolveEnvVarsInString(selector.context)}` : '';

  // Determine the selection method (name or labels)
  let selectorArg = '';
  if (selector.metadata.name) {
    selectorArg = selector.metadata.name;
  } else if (selector.metadata.labels && Object.keys(selector.metadata.labels).length > 0) {
    const labelSelectors = Object.entries(selector.metadata.labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    selectorArg = `-l ${labelSelectors}`;
  } else {
    throw new Error('Either metadata.name or metadata.labels must be provided in Kubernetes selector');
  }

  return {
    kindArg,
    namespaceArg,
    selectorArg,
    contextArg
  };
}

module.exports = {
  executeTest,
  executeHttpTest,
  executeKubectlWait,
  executeCommandTest,
  executeHttpBodyComparisonTest,
  filterJsonByJsonPath,
  executePodHttpRequestViaPodExec,
  applySetVars
};

/**
 * Generic test executor - parses YAML test definition and dispatches to the appropriate test function
 * @param {string} yamlDefinition - The YAML string containing the test definition
 * @returns {Promise<boolean>} - Promise resolving to true when test passes, rejecting when it fails
 */
async function executeTest(yamlDefinition) {
  let testConfig;
  
  try {
    testConfig = yaml.load(yamlDefinition);
  } catch (parseError) {
    throw new Error(`Failed to parse test YAML definition: ${parseError.message}`);
  }

  if (!testConfig || typeof testConfig !== 'object') {
    throw new Error('Invalid test definition: expected a YAML object');
  }

  // Dispatch to the appropriate test function based on what's defined
  if (testConfig.http) {
    debugLog('Detected HTTP test, dispatching to executeHttpTest');
    return executeHttpTest(testConfig);
  }
  
  if (testConfig.command) {
    debugLog('Detected command test, dispatching to executeCommandTest');
    return executeCommandTest(testConfig);
  }
  
  if (testConfig.wait) {
    debugLog('Detected wait test, dispatching to executeKubectlWait');
    return executeKubectlWait(testConfig.wait, testConfig.setVars);
  }
  
  if (testConfig.httpBodyComparison) {
    debugLog('Detected HTTP body comparison test, dispatching to executeHttpBodyComparisonTest');
    return executeHttpBodyComparisonTest(testConfig);
  }

  throw new Error('Unknown test type: test definition must contain one of: http, command, wait, httpBodyComparison');
}

/**
 * Helper function to get value at a given path array
 * @param {object} obj - The object to navigate
 * @param {Array} pathArray - Array of keys representing the path
 * @returns {any} - The value at the path, or undefined if not found
 */
function getValueAtPath(obj, pathArray) {
  return pathArray.reduce((acc, key) => (acc && acc[key] !== undefined) ? acc[key] : undefined, obj);
}

/**
 * Format differences into a human-readable string for HTTP body comparison
 * @param {Array} differences - Array of differences from deep-diff
 * @param {object} body1 - The first body (previous)
 * @param {object} body2 - The second body (current)
 * @returns {string} - Formatted difference string
 */
function formatHttpBodyDifferences(differences, body1, body2) {
  let output = '';
  const handledArrayPaths = new Set();

  differences.forEach(d => {
    const path = d.path.join('.');
    if (d.kind === 'A') {
      const arrayPath = d.path.join('.');
      if (!handledArrayPaths.has(arrayPath)) {
        const beforeArray = getValueAtPath(body1, d.path);
        const afterArray = getValueAtPath(body2, d.path);

        output += `• ${arrayPath}:\n\nBefore:\n${yaml.dump(beforeArray).trim().split('\n').join('\n')}\nAfter:\n${yaml.dump(afterArray).trim().split('\n').join('\n')}\n\n`;
        handledArrayPaths.add(arrayPath);
      }
    } else {
      // Check if this change is part of an already handled array
      const isPartOfHandledArray = Array.from(handledArrayPaths).some(arrayPath => path.startsWith(arrayPath));

      if (!isPartOfHandledArray) {
        switch (d.kind) {
          case 'E': // Edit
            output += `• ${path}: ${JSON.stringify(d.lhs)} => ${JSON.stringify(d.rhs)}\n`;
            break;
          case 'N': // New
            output += `• ${path}: Added ${JSON.stringify(d.rhs)}\n`;
            break;
          case 'D': // Deleted
            output += `• ${path}: Removed ${JSON.stringify(d.lhs)}\n`;
            break;
          default:
            output += `• ${path}: Changed\n`;
        }
      }
    }
  });

  return output;
}

/**
 * Filter JSON object by removing items specified by JSONPath expressions
 * @param {object} jsonObject - The JSON object to filter
 * @param {string[]} jsonPathsToRemove - Array of JSONPath expressions for items to remove
 * @returns {object} - A new object with specified items removed
 */
function filterJsonByJsonPath(jsonObject, jsonPathsToRemove) {
  if (!Array.isArray(jsonPathsToRemove) || jsonPathsToRemove.length === 0) {
    return jsonObject;
  }

  // Deep clone the object to avoid modifying the original
  let filteredObject = JSON.parse(JSON.stringify(jsonObject));

  for (const jsonPath of jsonPathsToRemove) {
    try {
      // Find all matches for this JSONPath
      const matches = JSONPath({ path: jsonPath, json: filteredObject, resultType: 'pointer' });

      // Sort pointers in reverse order to avoid index shifting issues when deleting
      matches.sort().reverse();

      for (const pointer of matches) {
        // Convert JSONPath pointer to property path array
        const pathSegments = pointer.replace(/^\//, '').split('/').filter(segment => segment !== '');

        if (pathSegments.length === 0) continue;

        // Navigate to parent object/array
        let current = filteredObject;
        let parent = null;
        let lastKey = null;

        for (let i = 0; i < pathSegments.length; i++) {
          parent = current;
          lastKey = pathSegments[i];

          // Handle array indices
          if (Array.isArray(current) && /^\d+$/.test(lastKey)) {
            lastKey = parseInt(lastKey, 10);
          }

          if (i === pathSegments.length - 1) {
            // This is the final key, delete it
            if (Array.isArray(parent) && typeof lastKey === 'number') {
              parent.splice(lastKey, 1);
            } else if (typeof parent === 'object' && parent !== null) {
              delete parent[lastKey];
            }
            break;
          } else {
            current = current[lastKey];
            if (current === undefined || current === null) {
              break;
            }
          }
        }
      }
    } catch (error) {
      debugLog(`Warning: Failed to remove JSONPath "${jsonPath}": ${error.message}`);
    }
  }

  return filteredObject;
}

/**
 * Deep comparison of two values (objects, arrays, primitives)
 */
function deepCompare(obj1, obj2) {
  // Direct equality
  if (obj1 === obj2) return true;

  // If either value is not an object or is null
  if (typeof obj1 !== 'object' || obj1 === null ||
    typeof obj2 !== 'object' || obj2 === null) {
    return false;
  }

  // Check if both are arrays
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) return false;

    for (let i = 0; i < obj1.length; i++) {
      if (!deepCompare(obj1[i], obj2[i])) return false;
    }

    return true;
  }

  // If one is an array but the other isn't
  if (Array.isArray(obj1) || Array.isArray(obj2)) return false;

  // Compare object properties
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key)) return false;
    if (!deepCompare(obj1[key], obj2[key])) return false;
  }

  return true;
}

/**
 * Sleep function for async/await
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find a free port on the local machine
 * @returns {Promise<number>} - A free port number
 */
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Compare a value against an expected value using specified comparator
 * @param {any} actual - The actual value to check
 * @param {object} comparison - The comparison configuration
 * @param {string} description - Optional description for logging
 * @throws {Error} - Throws error if comparison fails
 */
function compareValue(actual, comparison, description = 'Value') {
  // Convert non-string values to string for contains and matches operations
  const actualAsString = typeof actual === 'string' ? actual : JSON.stringify(actual);
  let result = false;

  switch (comparison.comparator) {
    case 'exists':
      result = actual !== undefined && actual !== null;
      debugLog(`${description} ${comparison.negate ? 'should not exist' : 'should exist'}: ${result ? 'exists' : 'does not exist'}`);
      break;

    case 'equals':
      result = deepCompare(actual, comparison.value);
      debugLog(`${description} ${comparison.negate ? 'should not equal' : 'should equal'} ${JSON.stringify(comparison.value)} (found ${actual}): ${result ? 'match' : 'no match'}`);
      break;

    case 'contains':
      result = actualAsString.includes(String(comparison.value));
      debugLog(`${description} ${comparison.negate ? 'should not contain' : 'should contain'} "${comparison.value}" (found ${actual}): ${result ? 'contains' : 'does not contain'}`);
      break;

    case 'matches':
      result = new RegExp(comparison.value).test(actualAsString);
      debugLog(`${description} ${comparison.negate ? 'should not match' : 'should match'} /${comparison.value}/ (found ${actual}): ${result ? 'matches' : 'does not match'}`);
      break;

    case 'greaterThan':
      result = Number(actual) > Number(comparison.value);
      debugLog(`${description} ${comparison.negate ? 'should not be greater than' : 'should be greater than'} ${comparison.value} (found ${actual}): ${result ? 'greater than' : 'not greater than'}`);
      break;

    case 'lessThan':
      result = Number(actual) < Number(comparison.value);
      debugLog(`${description} ${comparison.negate ? 'should not be less than' : 'should be less than'} ${comparison.value} (found ${actual}): ${result ? 'less than' : 'not less than'}`);
      break;

    default:
      throw new Error(`Unknown comparator: ${comparison.comparator}`);
  }

  // If negate is true, invert the result
  const finalResult = comparison.negate ? !result : result;

  if (!finalResult) {
    const operation = comparison.negate ? `not ${comparison.comparator}` : comparison.comparator;
    const valueStr = comparison.comparator !== 'exists' ? ` ${JSON.stringify(comparison.value)}` : '';
    throw new Error(`${description} comparison failed: expected to ${operation}${valueStr}, found ${actualAsString}`);
  }
}

/**
 * Resolve environment variables in a URL
 * @param {*} url
 * @returns
 */
function resolveEnvVarsInString(value) {
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      console.warn(`Warning: Environment variable ${varName} is not set`);
      return match;
    }
    return resolved;
  });
}

function resolveEnvVarsInUrl(url) {
  return resolveEnvVarsInString(url);
}

/**
 * Apply setVars rules to extract values from test response data and store them in process.env.
 *
 * Supported extraction sources by test type:
 *
 *   HTTP:    jsonPath, header, statusCode, body, regex
 *   Command: jsonPath, stdout, stderr, exitCode, regex
 *   Wait:    value
 *
 * @param {object} setVars - Map of variable names to extraction rules
 * @param {object} data    - The response/result data from the test execution
 * @param {string} testType - One of 'http', 'command', 'wait'
 */
function applySetVars(setVars, data, testType) {
  if (!setVars || typeof setVars !== 'object') return;

  for (const [varName, rule] of Object.entries(setVars)) {
    let value;

    if (rule.jsonPath) {
      // HTTP: extract from body; Command: extract from parsed JSON stdout
      if (testType !== 'http' && testType !== 'command') {
        throw new Error(`setVars "${varName}": "jsonPath" source is not valid for ${testType} tests`);
      }
      const jsonData = testType === 'http'
        ? (typeof data.body === 'string' ? JSON.parse(data.body) : data.body)
        : data.json;
      if (!jsonData) {
        throw new Error(`setVars "${varName}": no JSON data available for jsonPath extraction`);
      }
      const results = JSONPath({ path: rule.jsonPath, json: jsonData });
      if (!results.length) {
        throw new Error(`setVars "${varName}": jsonPath "${rule.jsonPath}" returned no results`);
      }
      value = results.length === 1 ? results[0] : results;

    } else if (rule.header) {
      if (testType !== 'http') {
        throw new Error(`setVars "${varName}": "header" source is only valid for http tests`);
      }
      value = data.headers?.[rule.header.toLowerCase()];

    } else if (rule.statusCode === true) {
      if (testType !== 'http') {
        throw new Error(`setVars "${varName}": "statusCode" source is only valid for http tests`);
      }
      value = data.statusCode;

    } else if (rule.body === true) {
      if (testType !== 'http') {
        throw new Error(`setVars "${varName}": "body" source is only valid for http tests`);
      }
      value = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);

    } else if (rule.stdout === true) {
      if (testType !== 'command') {
        throw new Error(`setVars "${varName}": "stdout" source is only valid for command tests`);
      }
      value = data.stdout;

    } else if (rule.stderr === true) {
      if (testType !== 'command') {
        throw new Error(`setVars "${varName}": "stderr" source is only valid for command tests`);
      }
      value = data.stderr;

    } else if (rule.exitCode === true) {
      if (testType !== 'command') {
        throw new Error(`setVars "${varName}": "exitCode" source is only valid for command tests`);
      }
      value = data.exitCode;

    } else if (rule.value === true) {
      if (testType !== 'wait') {
        throw new Error(`setVars "${varName}": "value" source is only valid for wait tests`);
      }
      value = data.extractedValue;

    } else if (rule.regex) {
      if (testType === 'wait') {
        throw new Error(`setVars "${varName}": "regex" source is not valid for wait tests`);
      }

      // Determine the text to search
      let text;
      if (testType === 'http') {
        text = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);
      } else if (testType === 'command') {
        const source = rule.regex.source || 'stdout';
        if (source !== 'stdout' && source !== 'stderr') {
          throw new Error(`setVars "${varName}": regex source must be "stdout" or "stderr", got "${source}"`);
        }
        text = data[source];
      }

      if (text === undefined || text === null) {
        throw new Error(`setVars "${varName}": no text available for regex extraction`);
      }

      const re = new RegExp(rule.regex.pattern);
      const match = re.exec(text);
      if (!match) {
        throw new Error(`setVars "${varName}": regex "${rule.regex.pattern}" did not match`);
      }
      const group = rule.regex.group ?? 1;
      value = match[group];
      if (value === undefined) {
        throw new Error(`setVars "${varName}": regex capture group ${group} not found in match`);
      }

    } else {
      throw new Error(`setVars "${varName}": unknown extraction rule: ${JSON.stringify(rule)}`);
    }

    if (value === undefined || value === null) {
      throw new Error(`setVars "${varName}": extracted value is null or undefined`);
    }

    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    process.env[varName] = strValue.trim();
    debugLog(`setVars: ${varName}=${strValue}`);
  }
}

/**
 * Discover the LoadBalancer IP and port for a Kubernetes service
 * @param {object} selector - The Kubernetes selector for the service
 * @param {number|string} portSpec - Optional port specification (port number, name, or index)
 * @returns {Promise<object>} - Object with { ip, port } properties
 */
async function discoverServiceLoadBalancerIpAndPort(selector, portSpec) {
  if (!selector || selector.kind !== 'Service') {
    throw new Error('Selector must be of kind "Service" for LoadBalancer IP discovery');
  }

  const selectorArgs = buildSelectorArgs(selector);
  const { kindArg, namespaceArg, selectorArg, contextArg } = selectorArgs;

  // Build kubectl command to get the service in JSON format
  const cmd = `kubectl ${contextArg} ${namespaceArg} get ${kindArg} ${selectorArg} -o json`;
  debugLog(`Discovering LoadBalancer IP and port: ${cmd}`);

  try {
    const result = execSync(cmd, { encoding: 'utf8' });
    const service = JSON.parse(result);

    // Extract LoadBalancer IP
    const ip = service.status?.loadBalancer?.ingress?.[0]?.ip ||
      service.status?.loadBalancer?.ingress?.[0]?.hostname;

    if (!ip) {
      throw new Error(`No LoadBalancer IP/hostname found for service ${selector.metadata.namespace || 'default'}/${selector.metadata.name || '<selector>'}`);
    }

    // Extract port
    const ports = service.spec?.ports || [];

    if (ports.length === 0) {
      throw new Error(`No ports defined for service ${selector.metadata.namespace || 'default'}/${selector.metadata.name || '<selector>'}`);
    }

    let port;

    if (portSpec !== undefined) {
      // Port specified - find the matching port
      if (typeof portSpec === 'number') {
        // Port specified as a number - match by port number
        const matchedPort = ports.find(p => p.port === portSpec);
        if (matchedPort) {
          port = matchedPort.port;
        } else {
          // Maybe it's an index?
          if (portSpec >= 0 && portSpec < ports.length) {
            port = ports[portSpec].port;
          } else {
            throw new Error(`Port ${portSpec} not found in service`);
          }
        }
      } else if (typeof portSpec === 'string') {
        // Port specified as a string - match by name
        const matchedPort = ports.find(p => p.name === portSpec);
        if (matchedPort) {
          port = matchedPort.port;
        } else {
          throw new Error(`Port with name "${portSpec}" not found in service`);
        }
      }
    } else {
      // No port specified - use the first port
      port = ports[0].port;
      if (ports.length > 1) {
        debugLog(`Multiple ports available, using first port: ${port}`);
      }
    }

    debugLog(`Discovered LoadBalancer IP: ${ip}, port: ${port}`);
    return { ip, port };
  } catch (error) {
    if (error.message.includes('Port') || error.message.includes('LoadBalancer')) {
      throw error;
    }
    throw new Error(`Failed to discover LoadBalancer IP and port: ${error.message}`);
  }
}

/**
 * HTTP test executor - throws on failure following Mocha conventions
 * @param {object} test - The test configuration
 * @returns {Promise<void>} - Promise resolving when test passes, rejecting when it fails
 */
async function executeHttpTest(test) {
  if (!test.http) {
    throw new Error('HTTP configuration missing for HTTP test');
  }

  // setVars requires expect to be present
  if (test.setVars && !test.expect) {
    throw new Error('setVars requires "expect" to be defined on the test');
  }

  // Auto-discover LoadBalancer IP and port if URL is not set, source type is local, and kind is Service
  if (!test.http.url && test.source.type === 'local' && test.source.selector && test.source.selector.kind === 'Service') {
    debugLog('Auto-discovering LoadBalancer IP and port for Service');
    const { ip, port } = await discoverServiceLoadBalancerIpAndPort(test.source.selector, test.http.port);
    const scheme = test.http.scheme || 'http';
    test.http.url = `${scheme}://${ip}:${port}`;
    debugLog(`Auto-discovered URL: ${test.http.url}`);
  }

  test.http.url = resolveEnvVarsInUrl(test.http.url);// Resolve environment variables in URL
  test.http.method = test.http.method || 'GET';
  test.http.path = test.http.path || '/';

  // Resolve environment variables in headers
  if (test.http.headers && typeof test.http.headers === 'object') {
    for (const [key, value] of Object.entries(test.http.headers)) {
      if (typeof value === 'string') {
        test.http.headers[key] = resolveEnvVarsInString(value);
      }
    }
  }

  // Create a descriptive test name
  let testName = `${test.http.method} ${test.http.url}${test.http.path}`;
  if (test.source.type === 'pod' && test.source.selector) {
    testName += ` (via pod ${test.source.selector.metadata.namespace || 'default'}/${test.source.selector.metadata.name || '<selector>'})`;
  }

  try {
    debugLog(`Executing HTTP test: ${testName}`);
    debugLog(`Request details: ${JSON.stringify({
      method: test.http.method,
      url: test.http.url + test.http.path,
      headers: test.http.headers || {},
      params: test.http.params || {},
      body: test.http.body || null,
      sourceType: test.source.type
    }, null, 2)}`);

    let response;

    if (test.source.type === 'local') {
      debugLog('Using local HTTP client');
      response = await executeLocalHttpRequest(test.http);
    } else if (test.source.type === 'pod') {
      if (!test.source.selector) {
        throw new Error('Kubernetes selector is required for pod-based tests');
      }

      debugLog(`Using kubectl debug to access pod ${JSON.stringify(test.source.selector)}`);
      response = await executePodHttpRequest(test);
    } else {
      throw new Error(`Unsupported source type: ${test.source.type}`);
    }

    // Log the response details at debug level
    debugLog(`Response received: ${JSON.stringify({
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body
    }, null, 2)}`);

    // Validate expectations - this will throw if validation fails
    validateHttpExpectations(response, test.expect, testName);

    // Apply setVars after successful validation
    if (test.setVars) {
      applySetVars(test.setVars, response, 'http');
    }

    debugLog(`Test passed: ${testName}`);
  } catch (error) {
    debugLog(`Test failed: ${testName}`);
    debugLog(error?.message || String(error));
    throw error; // Re-throw to ensure Mocha catches the failure
  }
  return true;
}

/**
 * Execute an HTTP request locally
 * @param {object} httpConfig - The HTTP request configuration
 * @returns {Promise<object>} - The response object
 */
async function executeLocalHttpRequest(httpConfig) {
  debugLog(`Executing local HTTP request: ${httpConfig.method} ${httpConfig.url}${httpConfig.path}`);

  // Configure HTTPS Agent with certificates if provided
  let httpsAgent;
  if (httpConfig.url.startsWith('https://')) {
    const agentOptions = {
      rejectUnauthorized: !httpConfig.skipSslVerification
    };

    // Add certificate and key if provided
    if (httpConfig.cert || httpConfig.key || httpConfig.ca) {
      debugLog('Using SSL certificates for HTTPS request');

      if (httpConfig.cert) {
        try {
          agentOptions.cert = fs.readFileSync(httpConfig.cert);
          debugLog(`Loaded certificate from ${httpConfig.cert}`);
        } catch (error) {
          debugLog(`Failed to read certificate file: ${error}`);
          throw new Error(`Failed to read certificate file: ${error}`);
        }
      }

      if (httpConfig.key) {
        try {
          agentOptions.key = fs.readFileSync(httpConfig.key);
          debugLog(`Loaded key from ${httpConfig.key}`);
        } catch (error) {
          debugLog(`Failed to read key file: ${error}`);
          throw new Error(`Failed to read key file: ${error}`);
        }
      }

      if (httpConfig.ca) {
        try {
          agentOptions.ca = fs.readFileSync(httpConfig.ca);
          debugLog(`Loaded CA certificate from ${httpConfig.ca}`);
        } catch (error) {
          debugLog(`Failed to read CA certificate file: ${error}`);
          throw new Error(`Failed to read CA certificate file: ${error}`);
        }
      }
    }

    httpsAgent = new https.Agent(agentOptions);
  }

  if (httpConfig.skipSslVerification) {
    debugLog(`SSL certificate verification is disabled`);
  }

  try {
    const response = await axios({
      method: httpConfig.method.toLowerCase(),
      url: `${httpConfig.url}${httpConfig.path}`,
      headers: httpConfig.headers || {},
      params: httpConfig.params || {},
      maxRedirects: httpConfig.maxRedirects || 0,
      data: httpConfig.body,
      httpsAgent,
      validateStatus: () => true // Don't throw error on non-2xx status codes
    });

    debugLog(`Response received with status code: ${response.status}`);

    return {
      statusCode: response.status,
      headers: response.headers,
      body: response.data,
    };
  } catch (error) {
    debugLog(`Request failed: ${error.message}`);
    throw error;
  }
}

/**
 * Execute an HTTP request from within a Kubernetes pod
 * @param {object} test - The test configuration
 * @returns {Promise<object>} - The response object
 */
async function executePodHttpRequest(test) {
  if (!test.source.selector || !test.http) {
    throw new Error('Kubernetes selector and HTTP configuration are required for pod tests');
  }

  // Check if port-forward mode is requested
  if (test.source.usePortForward) {
    debugLog('Using port-forward mode for pod HTTP request');
    return executePodHttpRequestViaPortForward(test);
  }

  // Check if pod-exec mode is requested
  if (test.source.usePodExec) {
    debugLog('Using pod-exec mode for pod HTTP request');
    return executePodHttpRequestViaPodExec(test);
  }

  const selector = test.source.selector;
  const container = test.source.container;
  const httpConfig = test.http;

  try {
    debugLog(`Executing HTTP request via pod: ${httpConfig.method} ${httpConfig.url}${httpConfig.path}`);

    // Execute the Node.js HTTP request in the pod
    const stdout = await debugPodWithHttpRequest(
      { ...selector, kind: 'Pod' }, // Ensure kind is set to Pod
      httpConfig,
      container
    );

    debugLog(`Debug output raw length: ${stdout.length} bytes`);

    try {
      // Find the JSON response in the output using regex to be more robust
      const responseRegex = /HTTP_RESPONSE_START\s+([\s\S]*?)\s+HTTP_RESPONSE_END/;
      const match = stdout.match(responseRegex);

      if (!match || !match[1]) {
        debugLog(`Full pod debug output:\n${stdout}`);
        throw new Error('Could not find HTTP response markers in the output');
      }

      const jsonResponse = match[1].trim();
      debugLog(`Extracted JSON response (${jsonResponse.length} bytes)`);

      try {
        const response = JSON.parse(jsonResponse);
        debugLog(`Successfully parsed response from pod execution`);
        return response;
      } catch (jsonError) {
        debugLog(`Failed to parse JSON: ${jsonError.message}`);
        debugLog(`JSON content: ${jsonResponse}`);
        throw new Error(`Failed to parse JSON response: ${jsonError.message}`);
      }
    } catch (parseError) {
      debugLog(`Failed to parse response: ${parseError.message || String(parseError)}`);
      throw new Error(`Failed to parse response: ${parseError.message || String(parseError)}`);
    }
  } catch (error) {
    debugLog(`Failed to execute pod-based request: ${error?.message || String(error)}`);
    throw new Error(`Failed to execute pod-based request: ${error?.message || String(error)}`);
  }
}

/**
 * Execute an HTTP request via kubectl port-forward
 * This avoids creating ephemeral containers and is more reliable for repeated calls
 * @param {object} test - The test configuration
 * @returns {Promise<object>} - The response object
 */
async function executePodHttpRequestViaPortForward(test) {
  const selector = test.source.selector;
  const httpConfig = test.http;
  const namespace = selector.metadata.namespace;
  const context = selector.context ? resolveEnvVarsInString(selector.context) : selector.context;

  // Parse the URL to extract the target port
  const url = require('url');
  const parsedUrl = url.parse(httpConfig.url);
  const targetPort = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);

  debugLog(`Executing HTTP request via port-forward: ${httpConfig.method} ${httpConfig.url}${httpConfig.path}`);

  // Find the resource to port-forward to
  // kubectl port-forward supports: pod/name, deployment/name, service/name, etc.
  let portForwardTarget;
  const kind = selector.kind ? selector.kind.toLowerCase() : 'pod';
  
  if (selector.metadata.name) {
    // Use the kind prefix for non-pod resources (deployment/, service/, etc.)
    if (kind === 'pod') {
      portForwardTarget = selector.metadata.name;
    } else {
      portForwardTarget = `${kind}/${selector.metadata.name}`;
    }
    debugLog(`Using port-forward target: ${portForwardTarget}`);
  } else if (selector.metadata.labels && Object.keys(selector.metadata.labels).length > 0) {
    // For label selectors, we need to find an actual pod name
    const labelSelector = labelsToSelectorString(selector.metadata.labels);
    const getPodCmd = `kubectl ${context ? `--context=${context}` : ''} -n ${namespace} get pods -l ${labelSelector} -o jsonpath='{.items[0].metadata.name}'`;
    debugLog(`Pod finder command: ${getPodCmd}`);

    try {
      const podOutput = execSync(getPodCmd, { encoding: 'utf8' });
      portForwardTarget = podOutput.trim().replace(/^'|'$/g, '');
    } catch (e) {
      throw new Error(`Failed to find pod with labels ${labelSelector} in namespace ${namespace}: ${e.message}`);
    }

    if (!portForwardTarget) {
      throw new Error(`No pods found matching labels ${labelSelector} in namespace ${namespace}`);
    }

    debugLog(`Found pod ${portForwardTarget} for port-forward`);
  } else {
    throw new Error('Either metadata.name or metadata.labels must be provided in Kubernetes selector');
  }

  // Find a free local port
  const localPort = await findFreePort();
  debugLog(`Using local port ${localPort} for port-forward to ${targetPort}`);

  // Build port-forward command arguments
  const args = [];
  if (context) {
    args.push(`--context=${context}`);
  }
  args.push('-n', namespace, 'port-forward', portForwardTarget, `${localPort}:${targetPort}`);

  debugLog(`Starting port-forward: kubectl ${args.join(' ')}`);

  // Start port-forward process
  const portForward = spawn('kubectl', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let portForwardReady = false;
  let portForwardError = null;

  // Wait for port-forward to be ready
  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!portForwardReady) {
        reject(new Error('Port-forward timed out waiting to become ready'));
      }
    }, 30000);

    portForward.stdout.on('data', (data) => {
      const output = data.toString();
      debugLog(`Port-forward stdout: ${output}`);
      if (output.includes('Forwarding from')) {
        portForwardReady = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    portForward.stderr.on('data', (data) => {
      const output = data.toString();
      debugLog(`Port-forward stderr: ${output}`);
      // Some kubectl versions output "Forwarding from" to stderr
      if (output.includes('Forwarding from')) {
        portForwardReady = true;
        clearTimeout(timeout);
        resolve();
      }
      if (output.includes('error') || output.includes('Error')) {
        portForwardError = output;
      }
    });

    portForward.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Port-forward process error: ${err.message}`));
    });

    portForward.on('close', (code) => {
      if (!portForwardReady) {
        clearTimeout(timeout);
        reject(new Error(`Port-forward exited with code ${code}${portForwardError ? `: ${portForwardError}` : ''}`));
      }
    });
  });

  try {
    await readyPromise;
    debugLog('Port-forward is ready');

    // Small delay to ensure port-forward is fully established
    await sleep(100);

    // Modify the URL to use localhost with the forwarded port
    const localUrl = `${parsedUrl.protocol}//localhost:${localPort}`;
    const modifiedHttpConfig = {
      ...httpConfig,
      url: localUrl
    };

    debugLog(`Executing local HTTP request to ${localUrl}${httpConfig.path}`);

    // Execute the request locally
    const response = await executeLocalHttpRequest(modifiedHttpConfig);

    debugLog('Successfully executed HTTP request via port-forward');
    return response;

  } finally {
    // Clean up port-forward process
    debugLog('Cleaning up port-forward process');
    try {
      portForward.kill('SIGTERM');
      // Give it a moment to clean up gracefully
      await sleep(100);
      if (!portForward.killed) {
        portForward.kill('SIGKILL');
      }
    } catch (killError) {
      debugLog(`Error killing port-forward process: ${killError.message}`);
    }
  }
}

/**
 * Execute an HTTP request via kubectl exec from a pod using curl
 * @param {object} test - The test configuration
 * @returns {Promise<object>} - The response object
 */
async function executePodHttpRequestViaPodExec(test) {
  const sourceSelector = test.source.selector;
  const httpConfig = test.http;

  if (!sourceSelector) {
    throw new Error('Source selector is required for pod-exec mode');
  }

  debugLog(`Executing HTTP request via pod-exec: ${httpConfig.method} ${httpConfig.url}${httpConfig.path}`);

  try {
    // Get source pod name
    const sourceSelectorArgs = buildSelectorArgs(sourceSelector);
    const { kindArg: sourceKindArg, namespaceArg: sourceNamespaceArg, selectorArg: sourceSelectorArg, contextArg: sourceContextArg } = sourceSelectorArgs;

    let sourcePodName;
    if (sourceSelector.metadata.name) {
      sourcePodName = `${sourceKindArg}/${sourceSelector.metadata.name}`;
    } else {
      const getSourcePodCmd = `kubectl ${sourceContextArg} ${sourceNamespaceArg} get ${sourceKindArg} ${sourceSelectorArg} -o jsonpath='{.items[0].metadata.name}'`;
      debugLog(`Getting source pod name: ${getSourcePodCmd}`);
      try {
        const result = execSync(getSourcePodCmd, { encoding: 'utf8' });
        sourcePodName = result.trim();
        if (!sourcePodName) {
          throw new Error('No source pod found matching the selector');
        }
      } catch (error) {
        throw new Error(`Failed to find source pod: ${error.message}`);
      }
    }

    // Construct the curl command - use -i to include headers in response
    let curlCmd = `curl -s -i -w '\\n---RESPONSE_END---\\n'`;

    // Add method if not GET
    if (httpConfig.method && httpConfig.method.toUpperCase() !== 'GET') {
      curlCmd += ` -X ${httpConfig.method.toUpperCase()}`;
    }

    // Add headers
    if (httpConfig.headers) {
      Object.entries(httpConfig.headers).forEach(([key, value]) => {
        curlCmd += ` -H '${key}: ${value}'`;
      });
    }

    // Add request body if present
    if (httpConfig.body) {
      const bodyData = typeof httpConfig.body === 'string' ? httpConfig.body : JSON.stringify(httpConfig.body);
      curlCmd += ` -d '${bodyData.replace(/'/g, "\\'")}'`;
    }

    // Add skip SSL verification if requested
    if (httpConfig.skipSslVerification) {
      curlCmd += ' -k';
    }

    // Construct the target URL - use the http.url directly like local requests
    let targetUrl = httpConfig.url;
    if (httpConfig.path) {
      targetUrl += httpConfig.path;
    }

    curlCmd += ` '${targetUrl}'`;

    // Build kubectl exec command
    let kubectlCmd = `kubectl ${sourceContextArg} ${sourceNamespaceArg} exec ${sourcePodName}`;
    if (test.source.container) {
      kubectlCmd += ` -c ${test.source.container}`;
    }
    kubectlCmd += ` -- sh -c "${curlCmd}"`;

    debugLog(`Executing curl via pod-exec: ${kubectlCmd}`);

    try {
      const stdout = execSync(kubectlCmd, { encoding: 'utf8' });
      debugLog(`Pod-exec curl command completed successfully`);
      debugLog(`Raw output: ${stdout}`);

      // Parse the curl response (with -i for headers)
      const responseParts = parseCurlResponse(stdout);
      const { statusCode, headers, body } = responseParts;

      // Try to parse body as JSON
      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        parsedBody = body;
      }

      const response = {
        statusCode,
        headers,
        body: parsedBody
      };

      debugLog(`Parsed response: status=${statusCode}, headers=${Object.keys(headers).length}, body length=${JSON.stringify(parsedBody).length}`);
      return response;

    } catch (error) {
      debugLog(`Pod-exec curl command failed: ${error.message}`);

      // Try to parse response from stdout even on error
      let statusCode = 500;
      let headers = {};
      let body = '';

      if (error.stdout) {
        const stdout = error.stdout.toString();
        try {
          const responseParts = parseCurlResponse(stdout);
          statusCode = responseParts.statusCode;
          headers = responseParts.headers;
          body = responseParts.body;
        } catch (parseError) {
          debugLog(`Failed to parse curl response from error output: ${parseError.message}`);
          body = stdout.trim();
        }
      }

      if (error.stderr) {
        body += '\n' + error.stderr.toString();
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        parsedBody = body;
      }

      const response = {
        statusCode,
        headers,
        body: parsedBody
      };

      debugLog(`Parsed error response: status=${statusCode}, headers=${Object.keys(headers).length}`);
      return response;
    }

  } catch (error) {
    debugLog(`Failed to execute pod-exec HTTP request: ${error?.message || String(error)}`);
    throw new Error(`Failed to execute pod-exec HTTP request: ${error?.message || String(error)}`);
  }
}

/**
 * Parse curl response output with headers (-i flag)
 * @param {string} curlOutput - Raw curl output
 * @returns {object} - Parsed response with statusCode, headers, and body
 */
function parseCurlResponse(curlOutput) {
  // Split by our custom marker
  const parts = curlOutput.split('---RESPONSE_END---');
  const responseData = parts[0].trim();

  if (!responseData) {
    throw new Error('No response data found in curl output');
  }

  const lines = responseData.split('\n');
  let statusCode = 200;
  const headers = {};
  let bodyStartIndex = -1;

  // Parse status line
  if (lines.length > 0 && lines[0].startsWith('HTTP/')) {
    const statusMatch = lines[0].match(/HTTP\/\d+\.\d+\s+(\d+)/);
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1], 10);
    }
  }

  // Parse headers
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Empty line separates headers from body
    if (line.trim() === '') {
      bodyStartIndex = i + 1;
      break;
    }

    // Parse header line (key: value)
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const headerName = line.substring(0, colonIndex).trim().toLowerCase();
      const headerValue = line.substring(colonIndex + 1).trim();
      headers[headerName] = headerValue;
    }
  }

  // Extract body
  let body = '';
  if (bodyStartIndex >= 0 && bodyStartIndex < lines.length) {
    body = lines.slice(bodyStartIndex).join('\n');
  }

  return {
    statusCode,
    headers,
    body: body.trim()
  };
}

/**
 * Execute a kubectl debug with a Node.js HTTP request
 * @param {object} selector - The Kubernetes selector
 * @param {object} httpConfig - The HTTP configuration
 * @param {string} container - Optional target container name
 * @returns {Promise<string>} - The command output
 */
async function debugPodWithHttpRequest(selector, httpConfig, container) {
  if (!selector.metadata.namespace) {
    throw new Error('Namespace is required in the Kubernetes selector');
  }

  const namespace = selector.metadata.namespace;
  const context = selector.context ? resolveEnvVarsInString(selector.context) : selector.context;

  try {
    // Get a human-readable resource description for logs
    const resourceDescription = getResourceDescription(selector);
    debugLog(`Finding pod for ${resourceDescription}`);

    let podName;

    // If a specific pod name is given
    if (selector.metadata.name) {
      podName = selector.metadata.name;
      debugLog(`Using specified pod name: ${podName}`);
    }
    // Otherwise, use label selectors to find a pod
    else if (selector.metadata.labels && Object.keys(selector.metadata.labels).length > 0) {
      // Build kubectl command to get pod name
      const labelSelector = labelsToSelectorString(selector.metadata.labels);
      const getPodCmd = `kubectl ${context ? `--context=${context}` : ''} -n ${namespace} get pods -l ${labelSelector} -o jsonpath='{.items[0].metadata.name}'`;
      debugLog(`Pod finder command: ${getPodCmd}`);

      try {
        const podOutput = execSync(getPodCmd, { encoding: 'utf8' });
        podName = podOutput.trim().replace(/^'|'$/g, ''); // Remove any quotes
      } catch (e) {
        throw new Error(`Failed to find pod with labels ${labelSelector} in namespace ${namespace}: ${e.message}`);
      }

      if (!podName) {
        throw new Error(`No pods found matching labels ${labelSelector} in namespace ${namespace}`);
      }

      debugLog(`Found pod ${podName} for ${resourceDescription}`);
    } else {
      throw new Error('Either metadata.name or metadata.labels must be provided in Kubernetes selector for pod debug');
    }

    // Create a temporary file with the Node.js HTTP request script
    const tempScriptPath = `/tmp/pod-http-request-${Date.now()}.js`;
    const script = createHttpRequestScript(httpConfig);

    fs.writeFileSync(tempScriptPath, script, 'utf8');
    debugLog(`Created temporary script at ${tempScriptPath}`);

    try {
      // Execute debug command on the found pod with the script
      return await debugPodWithScript(namespace, podName, tempScriptPath, context, container);
    } finally {
      // Clean up the temporary file
      try {
        fs.unlinkSync(tempScriptPath);
        debugLog(`Removed temporary script ${tempScriptPath}`);
      } catch (cleanupError) {
        debugLog(`Failed to clean up temporary script: ${cleanupError.message}`);
      }
    }
  } catch (error) {
    debugLog(`Failed to debug pod for selector ${selector.kind}/${selector.metadata.namespace || 'default'}: ${error?.message || String(error)}`);
    throw new Error(`Failed to debug pod for selector: ${error?.message || String(error)}`);
  }
}

/**
 * Create a Node.js script for HTTP request
 * @param {object} httpConfig - The HTTP configuration
 * @returns {string} - The script content
 */
function createHttpRequestScript(httpConfig) {
  return `
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

// Debug logging helper - only logs when DEBUG_MODE env var is set to 'true'
function debugLog(...args) {
  if (process.env.DEBUG_MODE === 'true') {
    console.log(...args);
  }
}

// Process URL
const fullUrl = "${httpConfig.url}${httpConfig.path}";
const parsedUrl = url.parse(fullUrl);
const isHttps = parsedUrl.protocol === 'https:';

// Prepare request options
const options = {
  hostname: parsedUrl.hostname,
  port: parsedUrl.port || (isHttps ? 443 : 80),
  path: parsedUrl.pathname + (parsedUrl.search || ''),
  method: "${httpConfig.method.toUpperCase()}",
  headers: ${JSON.stringify(httpConfig.headers || {})},
  params: ${JSON.stringify(httpConfig.params || {})},
};

${httpConfig.skipSslVerification ? 'options.rejectUnauthorized = false;' : ''}

${httpConfig.cert ? `// Certificate handling would go here in production code` : ''}
${httpConfig.key ? `// Key handling would go here in production code` : ''}
${httpConfig.ca ? `// CA certificate handling would go here in production code` : ''}

debugLog("Starting HTTP request to " + fullUrl);

// Create request
const req = (isHttps ? https : http).request(options, (res) => {
  let data = "";

  // Collect response data
  res.on("data", (chunk) => {
    data += chunk;
  });

  // Process complete response
  res.on("end", () => {
    const headers = res.headers;
    let body;

    // Try to parse as JSON
    try {
      body = JSON.parse(data);
      debugLog("Parsed response as JSON");
    } catch (e) {
      body = data;
      debugLog("Keeping response as string");
    }

    // Create response object
    const response = {
      statusCode: res.statusCode,
      headers: headers,
      body: body
    };

    // Output the response with markers for easy extraction
    console.log("HTTP_RESPONSE_START");
    console.log(JSON.stringify(response));
    console.log("HTTP_RESPONSE_END");
  });
});

// Handle errors
req.on("error", (error) => {
  console.error("Error making request:", error.message);
  console.log("HTTP_RESPONSE_START");
  console.log(JSON.stringify({
    error: true,
    message: error.message,
    statusCode: 0,
    headers: {},
    body: null
  }));
  console.log("HTTP_RESPONSE_END");
});

// Add body if applicable
${httpConfig.body ?
      `const bodyData = ${JSON.stringify(typeof httpConfig.body === 'string' ?
        httpConfig.body :
        JSON.stringify(httpConfig.body))};
req.write(bodyData);
debugLog("Added request body");` :
      '// No body to add'}

// Send the request
req.end();
debugLog("Request sent, waiting for response...");
`;
}

/**
 * Execute a kubectl debug command on a pod with the provided script
 * @param {string} namespace - The namespace of the pod
 * @param {string} podName - The name of the pod
 * @param {string} scriptPath - Path to the script file
 * @param {string} context - Optional Kubernetes context
 * @param {string} container - Optional target container name
 * @returns {Promise<string>} - The command output
 */
async function debugPodWithScript(namespace, podName, scriptPath, context, container) {
  try {
    debugLog(`Debugging pod ${namespace}/${podName} to execute HTTP request`);

    // Copy the script to the pod using kubectl cp
    const tempPodScript = '/tmp/http-request.js';

    // Build debug command
    let debugCmd = `kubectl debug -it`;

    if (context) {
      debugCmd += ` --context=${context}`;
    }

    debugCmd += ` -n ${namespace} ${podName}`;
    debugCmd += ` --image=node:slim`;
    debugCmd += ` --profile=general`;

    if (container) {
      debugCmd += ` --target=${container}`;
    }

    // Create a safe command that copies our script into the pod and runs it
    debugCmd += ` -- /bin/bash -c "cat > ${tempPodScript} << 'EOFSCRIPT'
$(cat ${scriptPath})
EOFSCRIPT
node ${tempPodScript}"`;

    debugLog(`Executing debug command with script`);

    const stdout = execSync(debugCmd, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for potentially large responses
    });

    return stdout;
  } catch (error) {
    debugLog(`Failed to debug pod ${namespace}/${podName}: ${error?.message || String(error)}`);
    throw new Error(`Failed to debug pod ${namespace}/${podName}: ${error?.message || String(error)}`);
  }
}

/**
 * Validate HTTP expectations against a response - throws on failure
 * @param {object} response - The HTTP response
 * @param {object} expect - The expectations
 * @param {string} testName - The test name for logging
 * @throws {Error} - Throws error if any expectation fails
 */
function validateHttpExpectations(response, expect, testName) {
  debugLog(`Validating expectations for: ${testName}`);

  // 1) Status code
  if (expect.statusCode !== undefined && expect.statusCode !== response.statusCode && !Array.isArray(expect.statusCode)
    || Array.isArray(expect.statusCode) && !expect.statusCode.includes(response.statusCode)) {
    throw new Error(`Status code mismatch: expected ${expect.statusCode}, got ${response.statusCode}`);
  }
  debugLog(`✓ Status code matches: ${response.statusCode}`);

  const rawBody = typeof response.body === 'string'
    ? response.body
    : JSON.stringify(response.body);

  // 2) Exact body
  if (expect.body !== undefined) {
    if (!deepCompare(response.body, expect.body)) {
      throw new Error(`Body mismatch: expected ${JSON.stringify(expect.body)}, got ${JSON.stringify(response.body)}`);
    }
    debugLog(`✓ Body exactly matches`);
  }

  // 3) Substring
  if (expect.bodyContains) {

    const validateBodyContains = (bodyContainsItem) => {
      debugLog(`Validating bodyContains item: ${JSON.stringify(bodyContainsItem)}`);
      const containsNegate = typeof bodyContainsItem === 'object' && 'negate' in bodyContainsItem && bodyContainsItem.negate;
      const matchWord = typeof bodyContainsItem === 'object' && 'matchword' in bodyContainsItem && bodyContainsItem.matchword;
      let containsValue = bodyContainsItem.value || bodyContainsItem;
      debugLog(`negate: ${containsNegate}, matchWord: ${matchWord}, containsValue: ${containsValue}`);
      if (containsValue.startsWith('$')) {
        containsValue = process.env[containsValue.replace('$', '')];
      }

      const negate = containsNegate ? bodyContainsItem.negate : false;
      const contains = matchWord ? RegExp(`\\b${containsValue}\\b`).test(rawBody) : rawBody.includes(containsValue);

      if (negate ? contains : !contains) {
        const message = negate
          ? `Body should not contain substring but does: "${containsValue}"`
          : `Body does not contain substring: "${containsValue}"`;
        throw new Error(message);
      }

      const successMsg = negate
        ? `✓ Body does not contain "${containsValue}"`
        : `✓ Body contains "${containsValue}"`;
      debugLog(successMsg);
    }

    if (Array.isArray(expect.bodyContains)) {
      expect.bodyContains.forEach(validateBodyContains);
    } else {
      validateBodyContains(expect.bodyContains);
    }
  }

  // 4) Regex
  if (expect.bodyRegex) {
    const validateBodyRegex = (bodyRegexItem) => {
      debugLog(`Validating bodyRegex item: ${JSON.stringify(bodyRegexItem)}`);
      const regexNegate = typeof bodyRegexItem === 'object' && 'negate' in bodyRegexItem && bodyRegexItem.negate;
      const regexValue = bodyRegexItem.value || bodyRegexItem;
      const negate = regexNegate ? bodyRegexItem.negate : false;

      const re = new RegExp(regexValue);
      const matches = re.test(rawBody);

      if (negate ? matches : !matches) {
        const message = negate
          ? `Body should not match regex but does: ${regexValue}`
          : `Body does not match regex: ${regexValue}`;
        throw new Error(message);
      }

      const successMsg = negate
        ? `✓ Body does not match regex ${regexValue}`
        : `✓ Body matches regex ${regexValue}`;
      debugLog(successMsg);
    }

    if (Array.isArray(expect.bodyRegex)) {
      expect.bodyRegex.forEach(validateBodyRegex);
    } else {
      validateBodyRegex(expect.bodyRegex);
    }
  }

  // 5) JSONPath expectations
  if (expect.bodyJsonPath) {
    for (const jp of expect.bodyJsonPath) {
      const results = JSONPath({ path: jp.path, json: response.body });
      if (results.length === 0) {
        if (jp.negate && jp.comparator === 'exists') {
          debugLog(`✓ JSONPath "${jp.path}" does not exist, as expected`);
          continue;
        }
        throw new Error(`JSONPath "${jp.path}" did not return any results`);
      }

      // Use the comparison utility (which now throws on failure)
      compareValue(results[0], jp, `JSONPath ${jp.path}`);

      const successMsg = jp.negate
        ? `✓ JSONPath ${jp.path} ${jp.comparator} NOT ${jp.value}`
        : `✓ JSONPath ${jp.path} ${jp.comparator} ${jp.value}`;
      debugLog(successMsg);
    }
  }

  // 6) Header validation with operators
  if (expect.headers && expect.headers.length > 0) {
    for (const headerExp of expect.headers) {
      const headerName = headerExp.name.toLowerCase(); // Headers are case-insensitive
      const headerValue = response.headers[headerName];

      // For 'exists' comparator, check if the header exists
      if (headerExp.comparator === 'exists') {
        compareValue(headerValue, headerExp, `Header "${headerExp.name}"`);

        const existsSuccessMsg = headerExp.negate
          ? `✓ Header "${headerExp.name}" does not exist, as expected`
          : `✓ Header "${headerExp.name}" exists`;
        debugLog(existsSuccessMsg);
        continue;
      }

      // For other comparators, first check if the header exists
      if (headerValue === undefined) {
        throw new Error(`Header "${headerExp.name}" not found in response`);
      }

      // Use the comparison utility (which now throws on failure)
      compareValue(headerValue, headerExp, `Header "${headerExp.name}"`);

      const opString = headerExp.negate ? `does not ${headerExp.comparator}` : headerExp.comparator;
      debugLog(`✓ Header "${headerExp.name}" ${opString} "${headerExp.value}"`);
    }
  }

  debugLog(`✓ All expectations validated successfully for: ${testName}`);
}

/**
 * Converts labels to a selector string for kubectl
 * @param {object} labels - The labels object
 * @returns {string} - The selector string
 */
function labelsToSelectorString(labels) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * Gets a human-readable description of the resource being selected
 * @param {object} selector - The Kubernetes selector
 * @returns {string} - The resource description
 */
function getResourceDescription(selector) {
  const kind = selector.kind;
  const namespace = selector.metadata.namespace || 'default';
  const name = selector.metadata.name ||
    (selector.metadata.labels ?
      `with labels ${Object.entries(selector.metadata.labels)
        .map(([k, v]) => `${k}=${v}`).join(',')}` :
      'unknown');

  return `${kind}/${namespace}/${name}`;
}

/**
 * Waits for a Kubernetes resource to match a condition - throws on failure/timeout
 * @param {object} config - Configuration for the wait operation
 * @returns {Promise<void>} - Promise that resolves when the condition is met or rejects with an error
 */
async function executeKubectlWait(config, setVars) {
  if (!config.target) throw new Error('target block required for kubectl-wait');

  const { target, jsonPath, jsonPathExpectation, polling } = config;

  // Validate setVars for wait: value extraction requires jsonPath
  if (setVars) {
    for (const [varName, rule] of Object.entries(setVars)) {
      if (rule.value === true && !jsonPath) {
        throw new Error(`setVars "${varName}": "value" extraction requires "jsonPath" to be defined in the wait config`);
      }
    }
  }

  // Get kubectl selector args
  const selectorArgs = buildSelectorArgs(target);
  const { kindArg, namespaceArg, selectorArg, contextArg } = selectorArgs;

  const timeout = polling?.timeoutSeconds ?? 60;
  const interval = polling?.intervalSeconds ?? 2;
  const maxRetries = polling?.maxRetries; // undefined means unlimited retries

  // Get a human-readable description of the resource
  const resourceDescription = getResourceDescription(target);

  // Log what we're waiting for
  if (jsonPathExpectation) {
    const compareStr = jsonPathExpectation.negate
      ? `not ${jsonPathExpectation.comparator}`
      : jsonPathExpectation.comparator;
    const valueStr = jsonPathExpectation.comparator !== 'exists'
      ? ` ${JSON.stringify(jsonPathExpectation.value)}`
      : '';

    // Include retry info in log message if specified
    const retryInfo = maxRetries !== undefined ? ` (max ${maxRetries} retries)` : '';
    console.info(`Waiting for ${resourceDescription} until ${jsonPath} ${compareStr}${valueStr}${retryInfo}`);
  } else {
    const retryInfo = maxRetries !== undefined ? ` (max ${maxRetries} retries)` : '';
    console.info(`Waiting for ${resourceDescription}${retryInfo}`);
  }

  const deadline = Date.now() + timeout * 1000;
  let retryCount = 0;

  while (Date.now() < deadline) {
    // Check if we've exceeded max retries
    if (maxRetries !== undefined && retryCount >= maxRetries) {
      throw new Error(`Maximum retries (${maxRetries}) exceeded while waiting for ${resourceDescription}`);
    }

    try {
      // Build kubectl command with the selector args
      const cmd = `kubectl ${contextArg} ${namespaceArg} get ${kindArg} ${selectorArg} -o json`;
      debugLog(`kubectl-get: ${cmd}`);

      // Execute the command
      const stdout = execSync(cmd, { encoding: 'utf8' });

      if (!stdout.trim()) {
        debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: No output from kubectl command`);
        retryCount++;
        await sleep(interval * 1000);
        continue;
      }

      const json = JSON.parse(stdout);
      if (!json) {
        debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: Invalid JSON response`);
        retryCount++;
        await sleep(interval * 1000);
        continue;
      }

      // Only extract the value if jsonPath is provided
      if (jsonPath) {
        let matches = JSONPath({ path: jsonPath, json: json });
        if (!matches.length) {
          matches = JSONPath({ path: `$${jsonPath}`, json: json }); // this will allow jq-style jsonPath
        }
        if (!matches.length || matches[0] === null || matches[0] === undefined) {
          debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: jsonPath ${jsonPath} not found yet, retrying…`);
          retryCount++;
          await sleep(interval * 1000);
          continue;
        }

        const extractedValue = matches[0];

        // Check against expected conditions if provided
        if (jsonPathExpectation) {
          try {
            // Use the compare value function (which now throws on failure)
            compareValue(
              extractedValue,
              jsonPathExpectation,
              `JSONPath ${jsonPath}`
            );

            debugLog(`Value meets expectation: ${JSON.stringify(extractedValue)}`);
          } catch (comparisonError) {
            debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: ${comparisonError.message}, retrying...`);
            retryCount++;
            await sleep(interval * 1000);
            continue;
          }
        } else {
          // No expectation - just checking if the value exists and is not empty
          if (extractedValue === '') {
            debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: Value is empty string, retrying...`);
            retryCount++;
            await sleep(interval * 1000);
            continue;
          }
          debugLog(`Found value for ${jsonPath}: ${typeof extractedValue === 'string' ? extractedValue : JSON.stringify(extractedValue)}`);
        }

        // Apply setVars if provided
        if (setVars) {
          applySetVars(setVars, { extractedValue }, 'wait');
        }
      } else {
        // If no jsonPath is provided, we just wait for the resource to exist
        debugLog(`Resource ${resourceDescription} exists`);
      }

      return true;
    } catch (err) {
      debugLog(`Attempt ${retryCount + 1}${maxRetries !== undefined ? `/${maxRetries}` : ''}: lookup failed, will retry: ${err.message}`);
      retryCount++;
      await sleep(interval * 1000);
    }
  }

  // Format a helpful error message for timeout
  let errorMessage = `Timed-out (${timeout}s) waiting for ${resourceDescription}`;
  if (jsonPath) {
    errorMessage += ` → ${jsonPath}`;
    if (jsonPathExpectation) {
      const op = jsonPathExpectation.negate ? `not ${jsonPathExpectation.comparator}` : jsonPathExpectation.comparator;
      const valueStr = jsonPathExpectation.comparator !== 'exists'
        ? ` ${JSON.stringify(jsonPathExpectation.value)}`
        : '';
      errorMessage += ` to ${op}${valueStr}`;
    }
  }

  throw new Error(errorMessage);
}

/**
 * Command test executor - throws on failure following Mocha conventions
 * @param {object} test - The test configuration
 * @returns {Promise<boolean>} - Promise resolving to true when test passes, rejecting when it fails
 */
async function executeCommandTest(test) {
  if (!test.command) {
    throw new Error('Command configuration missing for command test');
  }

  // setVars requires expect to be present
  if (test.setVars && !test.expect) {
    throw new Error('setVars requires "expect" to be defined on the test');
  }

  // Only support object format
  if (typeof test.command === 'string') {
    throw new Error('Command must be an object with a "command" property. Use: { command: "your command here" }');
  }

  const commandConfig = test.command;

  if (!commandConfig.command) {
    throw new Error('Command object must have a "command" property with the command string');
  }

  // Create a descriptive test name
  let testName = `Command: ${commandConfig.command}`;
  if (test.source.type === 'pod' && test.source.selector) {
    testName += ` (via pod ${test.source.selector.metadata.namespace || 'default'}/${test.source.selector.metadata.name || '<selector>'})`;
  }

  try {
    debugLog(`Executing command test: ${testName}`);
    debugLog(`Command details: ${JSON.stringify({
      command: commandConfig.command,
      env: commandConfig.env || {},
      workingDir: commandConfig.workingDir,
      sourceType: test.source.type,
      parseJson: commandConfig.parseJson || false
    }, null, 2)}`);

    let result;

    if (test.source.type === 'local') {
      debugLog('Using local command execution');
      result = await executeLocalCommand(commandConfig);
    } else if (test.source.type === 'pod') {
      if (!test.source.selector) {
        throw new Error('Kubernetes selector is required for pod-based command tests');
      }

      debugLog(`Using kubectl exec to run command in pod ${JSON.stringify(test.source.selector)}`);
      result = await executePodCommand(test, commandConfig);
    } else {
      throw new Error(`Unsupported source type: ${test.source.type}. Use 'local' or 'pod'`);
    }

    // Validate expectations if provided
    if (test.expect) {
      validateCommandExpectations(result, test.expect, testName);
    }

    // Apply setVars after successful validation
    if (test.setVars) {
      applySetVars(test.setVars, result, 'command');
    }

    debugLog(`✓ Command test passed: ${testName}`);
    return true;

  } catch (error) {
    debugLog(`✗ Command test failed: ${testName}`);
    debugLog(`Error: ${error.message}`);
    throw error;
  }
}

/**
 * Execute command locally using child_process
 * @param {object} commandConfig - The command configuration
 * @returns {Promise<object>} - Promise resolving to command result with stdout, stderr, exitCode
 */
async function executeLocalCommand(commandConfig) {
  const { spawn } = require('child_process');

  const env = { ...process.env, ...(commandConfig.env || {}) };
  const cwd = commandConfig.workingDir || process.cwd();

  // Execute command through shell to support pipes and other shell features
  const cmd = process.platform === 'win32' ? 'cmd' : 'sh';
  const args = process.platform === 'win32' ? ['/c', commandConfig.command] : ['-c', commandConfig.command];

  debugLog(`Executing shell command: ${commandConfig.command}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      debugLog(`Command completed with exit code: ${exitCode}`);
      debugLog(`stdout: ${stdout}`);
      debugLog(`stderr: ${stderr}`);

      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        output: stdout.trim() // alias for backwards compatibility
      };

      // Parse JSON if requested and stdout is not empty
      if (commandConfig.parseJson && result.stdout) {
        try {
          result.json = JSON.parse(result.stdout);
          debugLog('Successfully parsed JSON output');
        } catch (parseError) {
          debugLog(`Failed to parse JSON: ${parseError.message}`);
          // Don't throw here - let the test decide if JSON parsing failure is an error
          result.jsonParseError = parseError.message;
        }
      }

      resolve(result);
    });

    child.on('error', (error) => {
      debugLog(`Command execution error: ${error.message}`);
      reject(new Error(`Failed to execute command: ${error.message}`));
    });
  });
}

/**
 * Execute command in a Kubernetes pod using kubectl exec
 * @param {object} test - The test configuration
 * @param {object} commandConfig - The command configuration
 * @returns {Promise<object>} - Promise resolving to command result
 */
async function executePodCommand(test, commandConfig) {
  const { selector } = test.source;

  // Build kubectl selector args
  const selectorArgs = buildSelectorArgs(selector);
  const { kindArg, namespaceArg, selectorArg, contextArg } = selectorArgs;

  // For pod execution, we need to get the actual pod name if using label selectors
  let podName;
  if (selector.metadata.name) {
    podName = selector.metadata.name;
  } else {
    // Use label selector to get pod name
    const listCmd = `kubectl ${contextArg} ${namespaceArg} get ${kindArg} ${selectorArg} -o jsonpath='{.items[0].metadata.name}'`;
    debugLog(`Getting pod name: ${listCmd}`);

    try {
      const result = execSync(listCmd, { encoding: 'utf8' });
      podName = result.trim();
      if (!podName) {
        throw new Error('No pod found matching the selector');
      }
      debugLog(`Found pod: ${podName}`);
    } catch (error) {
      throw new Error(`Failed to find pod: ${error.message}`);
    }
  }

  // Use the command string directly
  const fullCommand = commandConfig.command;

  // Prepare environment variables as export statements prepended to the command.
  // Values are single-quote escaped to survive the outer sh -c wrapping safely.
  let envPrefix = '';
  if (commandConfig.env && Object.keys(commandConfig.env).length > 0) {
    const envVars = Object.entries(commandConfig.env)
      .map(([key, value]) => {
        // Escape single quotes inside the value: ' → '\''
        const escaped = String(value).replace(/'/g, "'\\''");
        return `export ${key}='${escaped}'`;
      })
      .join('; ');
    envPrefix = `${envVars}; `;
  }

  // Prepare working directory
  let cdPrefix = '';
  if (commandConfig.workingDir) {
    // Single-quote escape the working dir path
    const escapedDir = commandConfig.workingDir.replace(/'/g, "'\\''");
    cdPrefix = `cd '${escapedDir}' && `;
  }

  const finalCommand = `${cdPrefix}${envPrefix}${fullCommand}`;

  // Wrap finalCommand in single quotes for `sh -c '...'` so that any double
  // quotes, dollar signs, or special characters in the command or env values
  // are passed through verbatim.  Any literal single quotes inside
  // finalCommand are escaped as '\''.
  const escapedFinalCommand = finalCommand.replace(/'/g, "'\\''");

  // Build kubectl exec command
  let kubectlCmd = `kubectl ${contextArg} ${namespaceArg} exec ${podName}`;
  if (test.source.container) {
    kubectlCmd += ` -c ${test.source.container}`;
  }
  kubectlCmd += ` -- sh -c '${escapedFinalCommand}'`;

  debugLog(`Executing pod command: ${kubectlCmd}`);

  try {
    const stdout = execSync(kubectlCmd, { encoding: 'utf8' });
    const result = {
      stdout: stdout.trim(),
      stderr: '', // kubectl exec combines stderr with stdout
      exitCode: 0,
      output: stdout.trim()
    };

    debugLog(`Pod command completed successfully`);
    debugLog(`stdout: ${result.stdout}`);

    // Parse JSON if requested and stdout is not empty
    if (commandConfig.parseJson && result.stdout) {
      try {
        result.json = JSON.parse(result.stdout);
        debugLog('Successfully parsed JSON output');
      } catch (parseError) {
        debugLog(`Failed to parse JSON: ${parseError.message}`);
        result.jsonParseError = parseError.message;
      }
    }

    return result;

  } catch (error) {
    debugLog(`Pod command failed: ${error.message}`);

    // Extract exit code from error if available
    let exitCode = 1;
    let stderr = '';

    if (error.status !== undefined) {
      exitCode = error.status;
    }

    if (error.stderr) {
      stderr = error.stderr.toString();
    }

    const result = {
      stdout: error.stdout ? error.stdout.toString().trim() : '',
      stderr: stderr.trim(),
      exitCode,
      output: error.stdout ? error.stdout.toString().trim() : ''
    };

    // Parse JSON if requested, even for failed commands
    if (commandConfig.parseJson && result.stdout) {
      try {
        result.json = JSON.parse(result.stdout);
        debugLog('Successfully parsed JSON output from failed command');
      } catch (parseError) {
        debugLog(`Failed to parse JSON from failed command: ${parseError.message}`);
        result.jsonParseError = parseError.message;
      }
    }

    return result;
  }
}

/**
 * Validate command test expectations
 * @param {object} result - The command execution result
 * @param {object} expect - The expectations configuration
 * @param {string} testName - The test name for error messages
 */
function validateCommandExpectations(result, expect, testName) {
  debugLog(`Validating expectations for: ${testName}`);

  // Validate exit code
  if (expect.exitCode !== undefined) {
    debugLog(`Checking exit code: expected=${expect.exitCode}, actual=${result.exitCode}`);
    if (result.exitCode !== expect.exitCode) {
      throw new Error(`Exit code mismatch: expected ${expect.exitCode}, got ${result.exitCode}`);
    }
    debugLog(`✓ Exit code matches: ${result.exitCode}`);
  }

  // Validate stdout expectations
  if (expect.stdout) {
    validateOutputExpectations(result.stdout, expect.stdout, 'stdout', testName);
  }

  // Validate stderr expectations
  if (expect.stderr) {
    validateOutputExpectations(result.stderr, expect.stderr, 'stderr', testName);
  }

  // Validate output expectations (alias for stdout)
  if (expect.output) {
    validateOutputExpectations(result.output, expect.output, 'output', testName);
  }

  // Validate JSON expectations
  if (expect.json) {
    if (!result.json) {
      if (result.jsonParseError) {
        throw new Error(`JSON parsing failed: ${result.jsonParseError}`);
      } else {
        throw new Error('No JSON output available for validation');
      }
    }
    validateJsonExpectations(result.json, expect.json, testName);
  }

  // Validate JSON path expectations
  if (expect.jsonPath && Array.isArray(expect.jsonPath)) {
    if (!result.json) {
      if (result.jsonParseError) {
        throw new Error(`JSON parsing failed, cannot validate jsonPath: ${result.jsonParseError}`);
      } else {
        throw new Error('No JSON output available for jsonPath validation');
      }
    }

    for (const pathExp of expect.jsonPath) {
      const matches = JSONPath({ path: pathExp.path, json: result.json });
      if (!matches.length) {
        throw new Error(`JSONPath "${pathExp.path}" not found in output`);
      }

      const extractedValue = matches[0];
      compareValue(extractedValue, pathExp, `JSONPath "${pathExp.path}"`);

      debugLog(`✓ JSONPath "${pathExp.path}" ${pathExp.comparator} "${pathExp.value}"`);
    }
  }

  debugLog(`✓ All expectations validated successfully for: ${testName}`);
}

/**
 * Validate output expectations (stdout/stderr/output)
 * @param {string} actualOutput - The actual output
 * @param {object|string} expectations - The output expectations
 * @param {string} outputType - Type of output (stdout/stderr/output)
 * @param {string} testName - The test name for error messages
 */
function validateOutputExpectations(actualOutput, expectations, outputType, testName) {
  // Handle simple string expectation (backwards compatibility)
  if (typeof expectations === 'string') {
    expectations = { contains: expectations };
  }

  // Handle array of expectations
  if (Array.isArray(expectations)) {
    for (const exp of expectations) {
      validateSingleOutputExpectation(actualOutput, exp, outputType);
    }
    return;
  }

  // Handle single expectation object
  validateSingleOutputExpectation(actualOutput, expectations, outputType);
}

/**
 * Validate a single output expectation
 * @param {string} actualOutput - The actual output
 * @param {object} expectation - The expectation configuration
 * @param {string} outputType - Type of output (stdout/stderr/output)
 */
function validateSingleOutputExpectation(actualOutput, expectation, outputType) {
  debugLog(`Validating ${outputType} expectation: ${JSON.stringify(expectation)}`);

  // Support different ways to specify the expectation
  if (expectation.contains !== undefined) {
    compareValue(actualOutput, { comparator: 'contains', value: expectation.contains, negate: expectation.negate }, `${outputType} contains`);
  } else if (expectation.matches !== undefined || expectation.regex !== undefined) {
    const pattern = expectation.matches || expectation.regex;
    compareValue(actualOutput, { comparator: 'matches', value: pattern, negate: expectation.negate }, `${outputType} matches`);
  } else if (expectation.equals !== undefined) {
    compareValue(actualOutput, { comparator: 'equals', value: expectation.equals, negate: expectation.negate }, `${outputType} equals`);
  } else if (expectation.exists !== undefined) {
    compareValue(actualOutput, { comparator: 'exists', negate: expectation.negate }, `${outputType} exists`);
  } else {
    // Support direct comparator format
    compareValue(actualOutput, expectation, outputType);
  }
}

/**
 * Validate JSON expectations
 * @param {object} actualJson - The parsed JSON output
 * @param {object} expectations - The JSON expectations
 * @param {string} testName - The test name for error messages
 */
function validateJsonExpectations(actualJson, expectations, testName) {
  debugLog(`Validating JSON expectations for: ${testName}`);

  if (Array.isArray(expectations)) {
    for (const exp of expectations) {
      validateSingleJsonExpectation(actualJson, exp);
    }
  } else {
    validateSingleJsonExpectation(actualJson, expectations);
  }
}

/**
 * Validate a single JSON expectation
 * @param {object} actualJson - The parsed JSON output
 * @param {object} expectation - The expectation configuration
 */
function validateSingleJsonExpectation(actualJson, expectation) {
  if (expectation.path) {
    // JSON path expectation
    const matches = JSONPath({ path: expectation.path, json: actualJson });
    if (!matches.length) {
      throw new Error(`JSONPath "${expectation.path}" not found in output`);
    }

    const extractedValue = matches[0];
    compareValue(extractedValue, expectation, `JSONPath "${expectation.path}"`);
  } else {
    // Direct JSON comparison
    compareValue(actualJson, expectation, 'JSON output');
  }
}

/**
 * HTTP body comparison test executor - compares bodies of two HTTP calls
 * @param {object} test - The test configuration
 * @returns {Promise<boolean>} - Promise resolving to true when test passes, rejecting when it fails
 */
async function executeHttpBodyComparisonTest(test) {
  if (!test.httpBodyComparison) {
    throw new Error('HTTP body comparison configuration missing for body comparison test');
  }

  const config = test.httpBodyComparison;

  if (!config.request1 || !config.request2) {
    throw new Error('Both request1 and request2 are required for HTTP body comparison');
  }

  // Create descriptive test name
  const testName = `HTTP Body Comparison: ${config.request1.http.method} ${config.request1.http.url}${config.request1.http.path} vs ${config.request2.http.method} ${config.request2.http.url}${config.request2.http.path}`;

  try {
    debugLog(`Executing HTTP body comparison test: ${testName}`);

    // Execute both HTTP requests using the existing HTTP request logic
    debugLog('Executing first HTTP request...');
    const response1 = await executeHttpRequestInternal(config.request1);

    // Apply delay between requests if specified
    if (config.delaySeconds && config.delaySeconds > 0) {
      debugLog(`Waiting ${config.delaySeconds} seconds before executing second request...`);
      await sleep(config.delaySeconds * 1000);
    }

    debugLog('Executing second HTTP request...');
    const response2 = await executeHttpRequestInternal(config.request2);

    // Get the bodies
    let body1 = response1.body;
    let body2 = response2.body;

    // Apply JSON filtering if specified
    if (config.parseAsJson) {
      debugLog('Parsing responses as JSON for comparison');

      // Parse bodies as JSON if they're strings
      if (typeof body1 === 'string') {
        try {
          body1 = JSON.parse(body1);
        } catch (error) {
          throw new Error(`Failed to parse response1 body as JSON: ${error.message}`);
        }
      }

      if (typeof body2 === 'string') {
        try {
          body2 = JSON.parse(body2);
        } catch (error) {
          throw new Error(`Failed to parse response2 body as JSON: ${error.message}`);
        }
      }

      // Apply JSONPath filtering to remove specified items
      if (config.removeJsonPaths && Array.isArray(config.removeJsonPaths)) {
        debugLog(`Applying JSONPath filtering to remove: ${config.removeJsonPaths.join(', ')}`);
        body1 = filterJsonByJsonPath(body1, config.removeJsonPaths);
        body2 = filterJsonByJsonPath(body2, config.removeJsonPaths);
      }
    }

    // Compare the bodies
    debugLog('Comparing response bodies...');
    const bodiesMatch = deepCompare(body1, body2);

    if (!bodiesMatch) {
      // Calculate differences using deep-diff
      const differences = diff(body1, body2);
      let errorMessage = 'HTTP response bodies do not match';

      if (differences && differences.length > 0) {
        const diffOutput = formatHttpBodyDifferences(differences, body1, body2);
        errorMessage += `:\n\nDifferences:\n${diffOutput}`;
      } else {
        // Fallback to showing both bodies if diff calculation fails
        const body1Str = typeof body1 === 'string' ? body1 : JSON.stringify(body1, null, 2);
        const body2Str = typeof body2 === 'string' ? body2 : JSON.stringify(body2, null, 2);
        errorMessage += `:\n\nResponse 1 body:\n${body1Str}\n\nResponse 2 body:\n${body2Str}`;
      }

      throw new Error(errorMessage);
    }

    debugLog(`✓ HTTP body comparison test passed: bodies match`);
    return true;

  } catch (error) {
    debugLog(`✗ HTTP body comparison test failed: ${testName}`);
    debugLog(`Error: ${error.message}`);
    throw error;
  }
}

/**
 * Execute a single HTTP request for body comparison (reuses existing HTTP test logic)
 * @param {object} requestConfig - The request configuration
 * @returns {Promise<object>} - The HTTP response
 */
async function executeHttpRequestInternal(requestConfig) {
  if (!requestConfig.http) {
    throw new Error('HTTP configuration missing in request config');
  }

  // Resolve environment variables in URL
  requestConfig.http.url = resolveEnvVarsInUrl(requestConfig.http.url);

  let response;

  if (requestConfig.source.type === 'local') {
    debugLog('Executing local HTTP request');
    response = await executeLocalHttpRequest(requestConfig.http);
  } else if (requestConfig.source.type === 'pod') {
    if (!requestConfig.source.selector) {
      throw new Error('Kubernetes selector is required for pod-based requests');
    }
    debugLog(`Executing HTTP request via pod ${JSON.stringify(requestConfig.source.selector)}`);
    response = await executePodHttpRequest(requestConfig);
  } else {
    throw new Error(`Unsupported source type: ${requestConfig.source.type}`);
  }

  return response;
}