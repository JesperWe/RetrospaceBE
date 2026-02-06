import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const clients = new Set<WebSocket>();
let timerInterval: NodeJS.Timeout | null = null;
let timerStart = 0;

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

    if (msg === "start") {
      if (timerInterval) clearInterval(timerInterval);
      timerStart = Date.now();
      timerInterval = setInterval(() => {
        const elapsed = Date.now() - timerStart;
        const message = JSON.stringify({ type: "timer", value: elapsed });
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      }, 100);
    }

    if (msg === "stop") {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      const message = JSON.stringify({ type: "stop" });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
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
