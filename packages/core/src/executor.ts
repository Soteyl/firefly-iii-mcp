import { Schema, Validator } from "@cfworker/json-schema";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { openapiSchemaToJsonSchema } from "@openapi-contrib/openapi-schema-to-json-schema";
import { CallToolRequestArguments, McpServerConfig, McpToolDefinition } from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const RETRY_DELAYS_MS = [300, 1_000];
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const ACCEPT = "application/vnd.api+json, application/json, application/octet-stream, */*";

export const RAW_REQUEST_TOOL_NAME = "firefly_api_request";

export const rawRequestTool: Tool = {
  name: RAW_REQUEST_TOOL_NAME,
  description:
    "Send any request to the Firefly III HTTP API. Use it only for endpoints no dedicated tool covers. " +
    "Write requests are never retried automatically.",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", description: "Path below /api, starting with /v1/, for example /v1/about." },
      query: {
        type: "object",
        description: "Query parameters. Array values for keys ending in [] are sent as repeated parameters.",
      },
      body: { description: "JSON request body." },
    },
    required: ["method", "path"],
  },
};

/** Provider-safe property key: Firefly's PHP-style "accounts[]" is exposed as "accounts". */
export const sanitizePropertyKey = (key: string): string => (key.endsWith("[]") ? key.slice(0, -2) : key);

export const sanitizeInputSchema = (node: any): any => {
  if (Array.isArray(node)) {
    return node.map(sanitizeInputSchema);
  }
  if (node && typeof node === "object") {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value as Record<string, any>).map(([k, v]) => [sanitizePropertyKey(k), sanitizeInputSchema(v)]),
        );
      } else if (key === "required" && Array.isArray(value)) {
        out[key] = (value as string[]).map(sanitizePropertyKey);
      } else {
        out[key] = sanitizeInputSchema(value);
      }
    }
    return out;
  }
  return node;
};

const jsonResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError && { isError: true }),
});

const failure = (message: string, details: Record<string, unknown> = {}): CallToolResult =>
  jsonResult({ error: message, message, ...details }, true);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only the top level is checked here. Firefly validates the body itself and answers with per-field
 * 422 errors before writing anything, so a stale spec can never reject a request Firefly would accept.
 */
const validators = new Map<string, { validator: Validator; properties: Record<string, any> }>();

function topLevelValidator(definition: McpToolDefinition) {
  let entry = validators.get(definition.name);
  if (!entry) {
    const schema = sanitizeInputSchema(openapiSchemaToJsonSchema(definition.inputSchema)) as Record<string, any>;
    const properties: Record<string, any> = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]: [string, any]) => {
        const { format: _format, ...rest } = value;
        return [key, key === "requestBody" ? {} : rest];
      }),
    );
    entry = { validator: new Validator({ ...schema, properties } as Schema, "4"), properties };
    validators.set(definition.name, entry);
  }
  return entry;
}

function coerceValue(value: unknown, schema: any): unknown {
  const types: string[] = [schema?.type].flat().filter(Boolean);
  if (types.includes("array")) {
    return (Array.isArray(value) ? value : [value]).map((item) => coerceValue(item, schema.items));
  }
  if (typeof value !== "string" || types.includes("string")) {
    return value;
  }
  if ((types.includes("integer") || types.includes("number")) && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (types.includes("boolean") && (value === "true" || value === "false")) {
    return value === "true";
  }
  return value;
}

function appendQuery(params: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (name.endsWith("[]")) {
      value.forEach((item) => params.append(name, String(item)));
    } else {
      params.append(name, value.join(","));
    }
  } else {
    params.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

interface PreparedRequest {
  label: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

async function fetchWithRetry(url: string, init: RequestInit, retryable: boolean): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const canRetry = retryable && attempt < RETRY_DELAYS_MS.length;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!canRetry || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (!canRetry) {
        throw error;
      }
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

async function readSuccess(response: Response): Promise<CallToolResult> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 204 || bytes.length === 0) {
    return jsonResult({ success: true, status: response.status });
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (contentType.includes("json")) {
    return { content: [{ type: "text", text: new TextDecoder().decode(bytes) }] };
  }
  if (bytes.length > MAX_BINARY_BYTES) {
    return failure(`Response is too large to return: ${bytes.length} bytes`, { status: response.status, contentType });
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\u0000")) {
      return { content: [{ type: "text", text }] };
    }
  } catch {
    // not text, falls through to base64
  }
  return jsonResult({ contentType, size: bytes.length, encoding: "base64", data: Buffer.from(bytes).toString("base64") });
}

async function send(request: PreparedRequest, config: McpServerConfig): Promise<CallToolResult> {
  const queryString = request.query.toString();
  const url = `${config.baseUrl.replace(/\/+$/, "")}/api${request.path}${queryString ? `?${queryString}` : ""}`;
  const isRead = request.method === "GET";
  const headers: Record<string, string> = { ...request.headers, Accept: ACCEPT, Authorization: `Bearer ${config.pat}` };
  if (!isRead && request.method !== "DELETE" && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  console.debug(`Executing "${request.label}": ${request.method} ${request.path}`);
  let response: Response;
  try {
    response = await fetchWithRetry(url, { method: request.method, headers, body: request.body as RequestInit["body"] }, isRead);
  } catch (error) {
    return failure(`Request to Firefly III failed for '${request.label}': ${String(error)}`, {
      ...(!isRead && { warning: "The outcome is unknown. Check the current state before repeating this write." }),
    });
  }

  if (response.ok) {
    return readSuccess(response);
  }
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return failure(`Error executing '${request.label}': ${response.status} ${response.statusText}`, {
    status: response.status,
    firefly: parsed,
    ...(parsed?.errors && { errors: parsed.errors }),
  });
}

export const executeApiTool = async (
  toolName: string,
  definition: McpToolDefinition,
  toolArgs: CallToolRequestArguments,
  serverConfig: McpServerConfig,
): Promise<CallToolResult> => {
  const { validator, properties } = topLevelValidator(definition);
  const args: CallToolRequestArguments = Object.fromEntries(
    Object.entries(toolArgs ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, key === "requestBody" ? value : coerceValue(value, properties[key])]),
  );
  const validation = validator.validate(args);
  if (!validation.valid) {
    return failure(`Invalid arguments for tool '${toolName}'`, {
      errors: validation.errors
        .filter((e) => e.keyword !== "properties")
        .map((e) => ({ path: e.instanceLocation, error: e.error })),
    });
  }

  let path = definition.pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  for (const param of definition.executionParameters) {
    const value = args[sanitizePropertyKey(param.name)];
    if (value === undefined) {
      continue;
    }
    if (param.in === "path") {
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    } else if (param.in === "query") {
      appendQuery(query, param.name, value);
    } else {
      headers[param.name.toLowerCase()] = String(value);
    }
  }
  if (path.includes("{")) {
    return failure(`Missing path parameters for tool '${toolName}': ${path}`);
  }

  let body: string | Uint8Array | undefined;
  const contentType = definition.requestBodyContentType;
  if (contentType && args.requestBody !== undefined) {
    headers["content-type"] = contentType;
    if (contentType.includes("json")) {
      body = JSON.stringify(args.requestBody);
    } else if (contentType === "application/octet-stream") {
      body = Buffer.from(String(args.requestBody), "base64");
    } else {
      body = String(args.requestBody);
    }
  }

  return send({ label: toolName, method: definition.method.toUpperCase(), path, query, headers, body }, serverConfig);
};

export const executeRawRequest = async (
  toolArgs: CallToolRequestArguments,
  serverConfig: McpServerConfig,
): Promise<CallToolResult> => {
  const method = String(toolArgs.method ?? "").toUpperCase();
  const path = String(toolArgs.path ?? "");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return failure(`Unsupported method: ${method}`);
  }
  if (!path.startsWith("/v1/") || path.includes("..") || path.includes("?")) {
    return failure("path must start with /v1/, must not contain '..', and query parameters belong in 'query'");
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries((toolArgs.query as Record<string, unknown>) ?? {})) {
    if (value !== null && value !== undefined) {
      appendQuery(query, name, value);
    }
  }
  const hasBody = toolArgs.body !== undefined && toolArgs.body !== null;
  return send(
    {
      label: RAW_REQUEST_TOOL_NAME,
      method,
      path,
      query,
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: hasBody ? JSON.stringify(toolArgs.body) : undefined,
    },
    serverConfig,
  );
};
