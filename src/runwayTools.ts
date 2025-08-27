// File: src/runwayTools.ts
import RunwayML, { TaskFailedError, type RunwayMLOptions } from "@runwayml/sdk";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Create a single shared Runway client.
 */
export function createRunwayClient(): RunwayML {
  const options: RunwayMLOptions = {};
  // The SDK defaults to process.env['RUNWAYML_API_SECRET']
  // Allow overriding the base URL if provided.
  if (process.env.RUNWAY_BASE_URL && process.env.RUNWAY_BASE_URL.trim() !== "") {
    // @ts-expect-error: baseURL is supported by Stainless SDKs
    options.baseURL = process.env.RUNWAY_BASE_URL.trim();
  }
  return new RunwayML(options);
}

/**
 * Register tools on an MCP server that wrap RunwayML SDK calls.
 * Tools are designed to be safe to call by GPT Actions via MCP.
 */
export function registerRunwayTools(server: McpServer, runway: RunwayML) {
  // Utility to format output links in MCP result payloads.
  const toResourceLinks = (urls: string[]) =>
    urls.map((u, i) => ({
      type: "resource_link" as const,
      resource: u,
      name: `output_${String(i + 1).padStart(2, "0")}`
    }));

  /**
   * Text → Image
   */
  server.registerTool(
    "runway.text_to_image",
    {
      title: "Runway: Text to Image",
      description:
        "Generate an image from a text prompt using Runway Gen-4 Image.",
      inputSchema: {
        promptText: z.string().min(1, "promptText is required"),
        model: z
          .string()
          .default("gen4_image")
          .describe("Runway model id. Defaults to gen4_image."),
        ratio: z
          .string()
          .optional()
          .describe(
            "Aspect ratio string. Examples: '1024:1024', '1360:768', '768:1360'."
          ),
        seed: z.number().int().optional(),
        wait: z
          .boolean()
          .default(true)
          .describe(
            "If true, wait for task to finish and return output URLs; otherwise return a task id."
          ),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Optional wait timeout (ms); default ~10 minutes.")
      }
    },
    async ({ promptText, model, ratio, seed, wait, timeoutMs }) => {
      try {
        const createPromise = runway.textToImage.create({
          model,
          promptText,
          ...(ratio ? { ratio } : {}),
          ...(seed !== undefined ? { seed } : {})
        });

        if (!wait) {
          const task = await createPromise;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { taskId: task.id, status: "PENDING" },
                  null,
                  2
                )
              }
            ]
          };
        }

        const result = await createPromise.waitForTaskOutput({
          timeout: timeoutMs ?? undefined
        });

        const outputs = Array.isArray(result.output) ? result.output : [];
        if (outputs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { taskId: result.id, status: result.status, output: [] },
                  null,
                  2
                )
              }
            ]
          };
        }

        return {
          content: [
            ...toResourceLinks(outputs),
            {
              type: "text",
              text: JSON.stringify(
                {
                  taskId: result.id,
                  status: result.status,
                  output: outputs
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: unknown) {
        if (err instanceof TaskFailedError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "TaskFailed", details: err.taskDetails },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` }
          ],
          isError: true
        };
      }
    }
  );

  /**
   * Image → Video
   */
  server.registerTool(
    "runway.image_to_video",
    {
      title: "Runway: Image to Video",
      description:
        "Generate a video from an input image and text prompt using Runway Gen-4 Turbo.",
      inputSchema: {
        promptImage: z
          .string()
          .url("promptImage must be a URL or data URI")
          .describe(
            "URL (or data URI) to the source image (first frame / style image)."
          ),
        promptText: z
          .string()
          .min(1, "promptText is required")
          .describe("Describe motion, subject, camera, style, etc."),
        model: z
          .string()
          .default("gen4_turbo")
          .describe("Runway model id. Defaults to gen4_turbo."),
        ratio: z
          .string()
          .optional()
          .describe("Aspect ratio string like '1280:720' or '720:1280'."),
        wait: z.boolean().default(true),
        timeoutMs: z.number().int().optional()
      }
    },
    async ({ promptImage, promptText, model, ratio, wait, timeoutMs }) => {
      try {
        const createPromise = runway.imageToVideo.create({
          model,
          promptImage,
          promptText,
          ...(ratio ? { ratio } : {})
        });

        if (!wait) {
          const task = await createPromise;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { taskId: task.id, status: "PENDING" },
                  null,
                  2
                )
              }
            ]
          };
        }

        const result = await createPromise.waitForTaskOutput({
          timeout: timeoutMs ?? undefined
        });

        const outputs = Array.isArray(result.output) ? result.output : [];
        return {
          content: [
            ...toResourceLinks(outputs),
            {
              type: "text",
              text: JSON.stringify(
                {
                  taskId: result.id,
                  status: result.status,
                  output: outputs
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: unknown) {
        if (err instanceof TaskFailedError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "TaskFailed", details: err.taskDetails },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` }
          ],
          isError: true
        };
      }
    }
  );

  /**
   * Video Upscale (e.g., 720p → 4K)
   */
  server.registerTool(
    "runway.video_upscale",
    {
      title: "Runway: Video Upscale",
      description:
        "Upscale a video output to a higher resolution using Runway's video_upscale endpoint.",
      inputSchema: {
        video: z
          .string()
          .url("video must be a URL (or data URI if supported)")
          .describe("URL of the source video to upscale."),
        // Many clients simply require the source video; exposing optional params for forward-compat:
        model: z
          .string()
          .default("gen4_turbo")
          .describe("Model used for upscaling; default works for most cases."),
        wait: z.boolean().default(true),
        timeoutMs: z.number().int().optional()
      }
    },
    async ({ video, model, wait, timeoutMs }) => {
      try {
        const createPromise = runway.videoUpscale.create({
          model,
          // The SDK param name is 'video' for source asset.
          video
        } as any);

        if (!wait) {
          const task = await createPromise;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { taskId: task.id, status: "PENDING" },
                  null,
                  2
                )
              }
            ]
          };
        }

        const result = await createPromise.waitForTaskOutput({
          timeout: timeoutMs ?? undefined
        });

        const outputs = Array.isArray(result.output) ? result.output : [];
        return {
          content: [
            ...toResourceLinks(outputs),
            {
              type: "text",
              text: JSON.stringify(
                {
                  taskId: result.id,
                  status: result.status,
                  output: outputs
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: unknown) {
        if (err instanceof TaskFailedError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "TaskFailed", details: err.taskDetails },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` }
          ],
          isError: true
        };
      }
    }
  );

  /**
   * Task: retrieve (poll by id)
   */
  server.registerTool(
    "runway.tasks.retrieve",
    {
      title: "Runway: Get Task",
      description: "Retrieve task status/output by id.",
      inputSchema: {
        id: z.string().min(1, "task id is required"),
        wait: z.boolean().default(false),
        timeoutMs: z.number().int().optional()
      }
    },
    async ({ id, wait, timeoutMs }) => {
      try {
        const promise = runway.tasks.retrieve(id as string);

        const result = wait
          ? await promise.waitForTaskOutput({ timeout: timeoutMs ?? undefined })
          : await promise;

        const outputs = Array.isArray((result as any).output)
          ? ((result as any).output as string[])
          : [];

        return {
          content: [
            ...toResourceLinks(outputs),
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: unknown) {
        return {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` }
          ],
          isError: true
        };
      }
    }
  );

  /**
   * Task: cancel (best-effort)
   */
  server.registerTool(
    "runway.tasks.cancel",
    {
      title: "Runway: Cancel Task",
      description: "Cancel or delete a task by id (best-effort).",
      inputSchema: {
        id: z.string().min(1, "task id is required")
      }
    },
    async ({ id }) => {
      try {
        // The SDK exposes cancellation via tasks.cancel / delete depending on version.
        // Use generic POST fallback if needed.
        // @ts-expect-error: some SDK versions expose cancel()
        const cancelled = await (runway.tasks.cancel?.(id) ??
          runway.post?.(`/v1/tasks/${id}/cancel`, {}));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cancelled ?? { id, cancelled: true }, null, 2)
            }
          ]
        };
      } catch (err: unknown) {
        return {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` }
          ],
          isError: true
        };
      }
    }
  );
}