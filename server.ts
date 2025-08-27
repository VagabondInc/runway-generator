// File: src/server.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerRunwayTools, createRunwayClient } from "./src/runwayTools.js";

/**
 * Build an MCP server instance and register tools.
 */
function buildServer() {
  const server = new McpServer({
    name: "runway-mcp",
    version: "0.1.0"
  });

  const runway = createRunwayClient();
  registerRunwayTools(server, runway);

  return server;
}

const app = express();
app.use(express.json());

// CORS (configure appropriately for production)
app.use(
  cors({
    origin: (process.env.ALLOWED_ORIGINS || "*")
      .split(",")
      .map((s) => s.trim()),
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: ["Content-Type", "mcp-session-id"]
  })
);

/**
 * Stateful Streamable HTTP transport with session management.
 * This is compatible with GPT Actions' MCP support.
 */
const sessions: Record<
  string,
  { server: McpServer; transport: StreamableHTTPServerTransport }
> = {};

app.all("/mcp", async (req: Request, res: Response) => {
  const acceptHeader = req.headers.accept || "";

  // Validate that client accepts both required content types
  if (
    !acceptHeader.includes("application/json") ||
    !acceptHeader.includes("text/event-stream")
  ) {
    return res.status(406).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Not Acceptable: Client must accept both application/json and text/event-stream"
      },
      id: null
    });
  }

  try {
    // If this is an initialize request, start a new session.
    const isInit =
      req.method === "POST" &&
      typeof req.body === "object" &&
      req.body &&
      isInitializeRequest(req.body);

    let sessionId = (req.headers["mcp-session-id"] as string) || "";

    if (!sessionId || isInit) {
      sessionId = randomUUID();
      res.setHeader("Mcp-Session-Id", sessionId);
      const server = buildServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableDnsRebindingProtection: false,
        allowedHosts: (process.env.ALLOWED_HOSTS || "127.0.0.1,localhost,runway-generator-liard.vercel.app")
          .split(",")
          .map((s) => s.trim()),
        allowedOrigins: (process.env.ALLOWED_ORIGINS || "*")
          .split(",")
          .map((s) => s.trim())
      });

      // Clean up on connection close
      res.on("close", () => {
        try {
          transport.close();
          server.close();
          delete sessions[sessionId];
        } catch {
          // ignore
        }
      });

      sessions[sessionId] = { server, transport };
      await sessions[sessionId].server.connect(transport);
    }

    // Dispatch the MCP HTTP request to the session transport.
    const { server, transport } = sessions[sessionId];
    await transport.handleRequest(req, res, req.body);

    // If the client issues DELETE /mcp with header mcp-session-id,
    // tear down the session explicitly.
    if (req.method === "DELETE") {
      try {
        transport.close();
        server.close();
        delete sessions[sessionId];
      } catch {
        // ignore
      }
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
          data: err?.message ?? String(err)
        },
        id: null
      });
    }
  }
});

// GPT Actions compatible endpoint - returns JSON instead of SSE
app.post("/gpt-action", async (req: Request, res: Response) => {
  try {
    // Handle MCP tools/call method
    if (req.body.method === "tools/call" && req.body.params) {
      const { name, arguments: args } = req.body.params;
      
      // Import the runway tools directly
      const { createRunwayClient } = await import('./src/runwayTools.js');
      const runway = createRunwayClient();
      
      // Call the appropriate runway tool
      let result;
      
      if (name === "runway.text_to_image") {
        const { promptText, model = "gen4_image", ratio, seed, wait = true, timeoutMs } = args;
        
        try {
          const createPromise = runway.textToImage.create({
            model,
            promptText,
            ...(ratio ? { ratio } : {}),
            ...(seed !== undefined ? { seed } : {})
          });

          if (!wait) {
            const task = await createPromise;
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ taskId: task.id, status: "PENDING" }, null, 2)
                }
              ]
            };
          } else {
            const taskResult = await createPromise.waitForTaskOutput({
              timeout: timeoutMs ?? undefined
            });

            const outputs = Array.isArray(taskResult.output) ? taskResult.output : [];
            const resourceLinks = outputs.map((u, i) => ({
              type: "resource_link",
              resource: u,
              name: `output_${String(i + 1).padStart(2, "0")}`
            }));

            result = {
              content: [
                ...resourceLinks,
                {
                  type: "text",
                  text: JSON.stringify({
                    taskId: taskResult.id,
                    status: taskResult.status,
                    output: outputs
                  }, null, 2)
                }
              ]
            };
          }
        } catch (error: any) {
          result = {
            content: [
              { type: "text", text: `Error: ${error.message}` }
            ],
            isError: true
          };
        }
      } else {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32601, message: `Tool ${name} not implemented yet` },
          id: req.body.id
        });
      }
      
      return res.json({
        jsonrpc: "2.0",
        result: result,
        id: req.body.id
      });
    }
    
    res.status(400).json({
      jsonrpc: "2.0", 
      error: { code: -32602, message: "Invalid params" },
      id: req.body.id
    });
    
  } catch (err: any) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { 
        code: -32603, 
        message: "Internal server error", 
        data: err?.message 
      },
      id: req.body.id || null
    });
  }
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Runway MCP Server running",
    endpoints: ["/mcp", "/gpt-action", "/openapi.yaml"]
  });
});

// Serve OpenAPI spec for GPT Actions
app.get("/openapi.yaml", (req, res) => {
  res.setHeader('Content-Type', 'application/x-yaml');
  res.send(`openapi: 3.1.0
info:
  title: Runway MCP Server
  description: Generate images and videos using Runway ML via MCP protocol
  version: 1.0.0
servers:
  - url: https://runway-generator-liard.vercel.app

paths:
  /mcp:
    post:
      operationId: callRunwayMCP
      summary: Call Runway MCP server methods
      description: Execute Runway ML operations through MCP protocol
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                jsonrpc:
                  type: string
                  enum: ["2.0"]
                  description: JSON-RPC version
                id:
                  type: string
                  description: Unique request identifier
                method:
                  type: string
                  enum: ["tools/call"]
                  description: MCP method to call
                params:
                  type: object
                  properties:
                    name:
                      type: string
                      enum: 
                        - "runway.text_to_image"
                        - "runway.image_to_video"  
                        - "runway.video_upscale"
                        - "runway.tasks.retrieve"
                        - "runway.tasks.cancel"
                      description: Runway tool to execute
                    arguments:
                      type: object
                      description: Tool-specific arguments
                      additionalProperties: true
                  required: ["name", "arguments"]
              required: ["jsonrpc", "id", "method", "params"]
            examples:
              text_to_image:
                summary: Generate an image from text
                value:
                  jsonrpc: "2.0"
                  id: "1"
                  method: "tools/call"
                  params:
                    name: "runway.text_to_image"
                    arguments:
                      promptText: "a beautiful sunset over mountains"
                      model: "gen4_image"
                      ratio: "1024:1024"
                      wait: true
              image_to_video:
                summary: Generate a video from an image
                value:
                  jsonrpc: "2.0"
                  id: "2"
                  method: "tools/call"
                  params:
                    name: "runway.image_to_video"
                    arguments:
                      promptImage: "https://example.com/image.jpg"
                      promptText: "camera pans left, gentle movement"
                      model: "gen4_turbo"
                      wait: true
      responses:
        "200":
          description: MCP response with generated media
          content:
            text/event-stream:
              schema:
                type: string
                description: Server-sent events containing MCP response
        "400":
          description: Invalid request format
        "500":
          description: Server error`);
});

const port = Number(process.env.PORT || 3030);
app.listen(port, () => {
  console.log(`Runway MCP Streamable HTTP server listening on :${port}`);
});