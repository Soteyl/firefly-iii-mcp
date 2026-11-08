import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { RAW_REQUEST_TOOL_NAME, executeApiTool, executeRawRequest, rawRequestTool, sanitizeInputSchema } from "./executor.js";
import { DEFAULT_PRESET_TAGS, RAW_TOOL_TAG } from "./presets.js";
import { generatedTools } from "./tools.js";
import { McpServerConfig } from "./types.js";

export { executeApiTool, sanitizeInputSchema, sanitizePropertyKey } from "./executor.js";

const SERVER_INFO = { name: "Firefly III MCP Agent", version: "2.0.0" };

function misconfiguredServer(name: string, error: string): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  const message = "Please check your configuration and restart the server.";
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name, description: `${error}. ${message}`, inputSchema: { type: "object" } } as Tool],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (): Promise<CallToolResult> => ({
    content: [{ type: "text", text: JSON.stringify({ error, message }, null, 2) }],
    isError: true,
  }));
  return server;
}

/**
 * Get the MCP server instance
 * @param serverConfig - The server configuration
 * @returns The MCP server instance
 */
export const getServer = (serverConfig: McpServerConfig): Server => {
  if (!serverConfig.baseUrl) {
    return misconfiguredServer("unavailable", "The base URL is not configured");
  }
  if (!serverConfig.pat) {
    return misconfiguredServer("unauthorized", "The personal access token is not configured");
  }

  const enabledTags = serverConfig.enableToolTags ?? DEFAULT_PRESET_TAGS;
  const isEnabled = (tags: string[]) => enabledTags.length === 0 || enabledTags.some((tag) => tags.includes(tag));
  const tools = generatedTools.filter((definition) => isEnabled(definition.tags));
  const rawEnabled = enabledTags.includes(RAW_TOOL_TAG);

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map(
        (definition) =>
          ({
            name: definition.name,
            description: definition.description,
            inputSchema: { ...sanitizeInputSchema(definition.inputSchema), type: "object" },
          }) as Tool,
      ),
      ...(rawEnabled ? [rawRequestTool] : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (name === RAW_REQUEST_TOOL_NAME && rawEnabled) {
      return executeRawRequest(args ?? {}, serverConfig);
    }
    const definition = tools.find((tool) => tool.name === name);
    if (!definition) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}`, message: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    return executeApiTool(name, definition, args ?? {}, serverConfig);
  });

  return server;
};
