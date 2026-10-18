"use client";

import { useEffect, useState } from "react";

type Tool = { name: string; title?: string; description?: string };

// Streamable HTTP may answer as JSON or as a single SSE "data:" frame.
async function rpc(method: string, params: object = {}) {
  const res = await fetch("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  if (!res.ok || !json) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
  const body = JSON.parse(json);
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export function ToolList() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc("tools/list")
      .then((r) => setTools(r.tools))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>;
  if (!tools) return <p className="opacity-60">Loading tools…</p>;
  return (
    <ul className="space-y-2" data-testid="mcp-tools">
      {tools.map((t) => (
        <li key={t.name} className="break-words">
          <code className="font-semibold break-all">{t.name}</code>
          {t.title && <span className="ml-2">{t.title}</span>}
          {t.description && <p className="text-xs opacity-70">{t.description}</p>}
        </li>
      ))}
    </ul>
  );
}
