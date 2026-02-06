import WebSocket, { WebSocketServer } from "ws";
import http from "http";

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

const httpServer = http.createServer((req, res) => {
  if (req.url === "/timer") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: clients.size }));
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
