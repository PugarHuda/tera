"use client";

import { useEffect, useState } from "react";

type Item = { name: string; title?: string; description?: string; uri?: string; uriTemplate?: string };
type Lists = { tools: Item[]; resources: Item[]; prompts: Item[] };

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
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([rpc("tools/list"), rpc("resources/list"), rpc("resources/templates/list"), rpc("prompts/list")])
      .then(([t, r, rt, p]) => setLists({ tools: t.tools, resources: [...r.resources, ...rt.resourceTemplates], prompts: p.prompts }))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>;
  if (!lists) return <p className="opacity-60">Loading tools…</p>;
  const list = (items: Item[], testid: string, label: (i: Item) => string) => (
    <ul className="space-y-2" data-testid={testid}>
      {items.map((t) => (
        <li key={label(t)} className="break-words">
          <code className="font-semibold break-all">{label(t)}</code>
          {t.title && <span className="ml-2">{t.title}</span>}
          {t.description && <p className="text-xs opacity-70">{t.description}</p>}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Tools ({lists.tools.length})</h3>
        {list(lists.tools, "mcp-tools", (t) => t.name)}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Resources ({lists.resources.length})</h3>
        {list(lists.resources, "mcp-resources", (t) => t.uri ?? t.uriTemplate ?? t.name)}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Prompts ({lists.prompts.length})</h3>
        {list(lists.prompts, "mcp-prompts", (t) => t.name)}
      </div>
    </div>
  );
}
