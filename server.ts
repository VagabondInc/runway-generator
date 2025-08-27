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

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Runway MCP Server running",
    endpoints: ["/mcp"]
  });
});

const port = Number(process.env.PORT || 3030);
app.listen(port, () => {
  console.log(`Runway MCP Streamable HTTP server listening on :${port}`);
});