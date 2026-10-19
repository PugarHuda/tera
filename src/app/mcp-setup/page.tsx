import type { Metadata } from "next";
import { ToolList } from "./tool-list";

export const metadata: Metadata = { title: "MCP server · Tera" };

const URL = "https://tera-orpin-three.vercel.app/api/mcp";

export default function McpSetup() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Use Tera from your AI agent</h1>
        <p className="opacity-70">
          Tera is also a Model Context Protocol server. Ask Claude, Cursor or any MCP client &ldquo;what will this customer pay if they
          upgrade on the 17th with SAVE20?&rdquo; and it runs the same engine the tests verify.
        </p>
      </div>

      <section className="card space-y-3">
        <h2 className="font-semibold">Connect</h2>
        <p className="text-sm">Claude Code</p>
        <pre className="overflow-x-auto rounded bg-black/80 p-3 text-xs text-white">claude mcp add --transport http tera {URL}</pre>
        <p className="text-sm">Cursor / Claude Desktop (mcp.json)</p>
        <pre className="overflow-x-auto rounded bg-black/80 p-3 text-xs text-white">{JSON.stringify({ mcpServers: { tera: { url: URL } } }, null, 2)}</pre>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Live tools, resources and prompts on this deployment</h2>
        <p className="text-sm opacity-70">Fetched right now from this deployment&apos;s /api/mcp endpoint with JSON-RPC list calls.</p>
        <ToolList />
      </section>
    </div>
  );
}
