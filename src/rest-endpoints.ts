import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import * as Y from "yjs";
import { fetchDocument } from "./db.js";

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

    const state = await fetchDocument(documentName);
    if (!state) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "document not found" }));
      return;
    }

    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const objects = doc.getArray("objects");

    const result = [];
    for (let i = 0; i < objects.length; i++) {
      result.push(toPlain(objects.get(i)));
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

    const orData = await orResponse.json();
    console.log(
      `OpenRouter response for "${documentName}":`,
      JSON.stringify(orData, null, 2),
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(orData, null, 2));
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

export function startTimerServer(port: number): void {
  httpServer.listen(port, () => {
    console.log(`Timer server listening on port ${port}`);
  });
}
