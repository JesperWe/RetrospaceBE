import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import * as Y from "yjs";
import type { Server as HpServer } from "@hocuspocus/server";
import { incrementVote } from "./db.js";

type OpenRouterChoice = {
  logprobs: any;
  finish_reason: string;
  native_finish_reason: string;
  index: number;
  message: {
    role: string;
    content: string;
    refusal: any;
    reasoning: any;
  };
};

type OpenRouterResponse = {
  id: string;
  provider: string;
  model: string;
  object: string;
  created: number;
  choices: Array<OpenRouterChoice>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

let hpServer: HpServer | null = null;

const clients = new Set<WebSocket>();
let timerInterval: NodeJS.Timeout | null = null;
let timerStart = 0;
let timerDuration = 0;

function broadcast(message: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function toPlain(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[k] = toPlain(v);
    }
    return obj;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map(toPlain);
  }
  return value;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/timer") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: clients.size }));
    return;
  }

  if (url.pathname === "/summarize") {
    const documentName = url.searchParams.get("document");
    if (!documentName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "document query parameter is required" }),
      );
      return;
    }

    // Get the live Hocuspocus document so changes propagate to clients
    const doc = hpServer!.hocuspocus.documents.get(documentName);
    if (!doc) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "document not found or not loaded" }));
      return;
    }

    const objects = doc.getArray("objects");

    const result = [];
    for (let i = 0; i < objects.length; i++) {
      const obj = objects.get(i) as Y.Map<unknown>;
      if (obj.get("type") === "postit") {
        result.push(toPlain(obj));
      }
    }

    console.log(
      `Document "${documentName}" objects:`,
      JSON.stringify(result, null, 2),
    );

    const idTextMap = result.map((obj: any) => ({
      id: obj.id,
      text: obj.text,
    }));

    const orResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.OPENROUTER_API_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "system",
              content:
                "here is an array of json objects. look at the text in each item and group them together in groups with similar text content. output a js object with an array of arrays (the groups) of object ids",
            },
            {
              role: "user",
              content: JSON.stringify(idTextMap),
            },
          ],
        }),
      },
    );

    if (!orResponse.ok) {
      const body = await orResponse.text();
      console.error(`OpenRouter failed (${orResponse.status}):`, body);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "OpenRouter request failed",
          status: orResponse.status,
        }),
      );
      return;
    }

    const orJson = (await orResponse.json()) as OpenRouterResponse;
    const resultContent = orJson?.choices?.[0]?.message?.content;

    if (!resultContent) {
      console.error(
        "No content in OpenRouter response:",
        JSON.stringify(orJson, null, 2),
      );
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No result found in LLM response" }));
      return;
    }

    // Strip single-line // comments that LLMs sometimes add to JSON
    const stripComments = (s: string) =>
      s.replace(/\/\/[^\n]*/g, "");

    let parsed: any;
    try {
      // Try parsing the whole response as JSON first
      parsed = JSON.parse(stripComments(resultContent));
    } catch {
      // Extract the first JSON code fence if present
      const fenceMatch = resultContent.match(
        /```(?:json)?\s*\n([\s\S]*?)\n```/,
      );
      if (fenceMatch) {
        try {
          parsed = JSON.parse(stripComments(fenceMatch[1]));
        } catch {
          // fall through
        }
      }
      // Try finding the first { ... } or [ ... ] in the response
      if (!parsed) {
        const jsonMatch = resultContent.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(stripComments(jsonMatch[1]));
          } catch {
            // fall through
          }
        }
      }
      if (!parsed) {
        console.warn("Failed to parse JSON from LLM response:", resultContent);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ raw: resultContent }));
        return;
      }
    }

    console.log(
      `OpenRouter response for "${documentName}":`,
      JSON.stringify(parsed, null, 2),
    );

    // Extract groups array — handle both { groups: [[...]] } and [[...]] formats
    const groups: string[][] = Array.isArray(parsed) ? parsed : parsed.groups;
    if (!Array.isArray(groups)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed, null, 2));
      return;
    }

    // Build id → Y.Map lookup
    const objById = new Map<string, Y.Map<unknown>>();
    for (let i = 0; i < objects.length; i++) {
      const obj = objects.get(i) as Y.Map<unknown>;
      const id = obj.get("id") as string;
      if (id) objById.set(id, obj);
    }

    // Reposition items by group
    doc.transact(() => {
      let x = 0;
      let y = 1;
      const z = 0;

      for (const group of groups) {
        x = 0;
        for (const id of group) {
          const obj = objById.get(id);
          if (!obj) continue;

          const pos = obj.get("position");
          if (pos instanceof Y.Map) {
            pos.set("x", x);
            pos.set("y", y);
            pos.set("z", z);
          } else {
            obj.set("position", new Y.Map(Object.entries({ x, y, z })));
          }

          x += 1.2;
        }
        y += 1.2;
      }
    });

    console.log(`Repositioned objects in "${documentName}"`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ groups, repositioned: true }, null, 2));
    return;
  }

  if (url.pathname === "/vote") {
    const documentName = url.searchParams.get("document");
    const userId = url.searchParams.get("user");
    if (!documentName || !userId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "document and user query parameters are required" }));
      return;
    }

    const count = await incrementVote(documentName, userId);

    if (count < 3) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count }));
    } else {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/timer" });

wss.on("connection", (ws) => {
  clients.add(ws);

  ws.on("message", (data) => {
    const msg = data.toString();

    if (msg.startsWith("start ")) {
      const duration = parseInt(msg.split(" ")[1], 10);
      if (isNaN(duration) || duration <= 0) return;

      if (timerInterval) clearInterval(timerInterval);
      timerDuration = duration;
      timerStart = Date.now();
      timerInterval = setInterval(() => {
        const elapsed = Date.now() - timerStart;
        const remaining = timerDuration - elapsed;
        if (remaining <= 0) {
          clearInterval(timerInterval!);
          timerInterval = null;
          broadcast(JSON.stringify({ type: "done" }));
        } else {
          broadcast(JSON.stringify({ type: "timer", value: remaining }));
        }
      }, 1000);
    }

    if (msg === "stop") {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      broadcast(JSON.stringify({ type: "stop" }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

export function startTimerServer(port: number, server: HpServer): void {
  hpServer = server;
  httpServer.listen(port, () => {
    console.log(`Timer server listening on port ${port}`);
  });
}
