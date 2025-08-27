# File: README.md
# Runway MCP Server

An MCP server that exposes RunwayML image/video generation tools for use with GPT Actions (via MCP Streamable HTTP).

## Tools

- `runway.text_to_image`
- `runway.image_to_video`
- `runway.video_upscale`
- `runway.tasks.retrieve`
- `runway.tasks.cancel`

## Quick Start

```bash
pnpm i    # or npm i / yarn
cp .env.example .env
# put RUNWAYML_API_SECRET in .env
pnpm dev