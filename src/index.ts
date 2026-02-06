import { Server } from "@hocuspocus/server";
import { encodeStateAsUpdate, applyUpdate } from "yjs";
import {
  initDb,
  fetchDocument,
  storeDocument,
  setUserOnline,
  setUserOffline,
  fetchUsers,
  closeDb,
} from "./db.js";

await initDb();

const server = new Server({
  port: 8081,

  async onConnect({ requestParameters, documentName, context }) {
    const userId = requestParameters.get("userId");
    if (!userId) {
      throw new Error("userId query parameter is required");
    }
    context.userId = userId;
    await setUserOnline(userId, documentName);
    console.log(`User ${userId} connected to "${documentName}"`);
  },

  async onDisconnect({ documentName, context }) {
    const userId = context.userId as string;
    if (userId) {
      await setUserOffline(userId, documentName);
      console.log(`User ${userId} disconnected from "${documentName}"`);
    }
  },

  async onLoadDocument({ document, documentName }) {
    console.log(`Loading document: ${documentName}`);

    const state = await fetchDocument(documentName);
    if (state) {
      applyUpdate(document, state);
      console.log(`Restored document "${documentName}" from database`);
    } else {
      console.log(`New document "${documentName}", no stored state found`);
    }
  },

  async onStoreDocument({ document, documentName }) {
    const state = encodeStateAsUpdate(document);
    await storeDocument(documentName, state);
    console.log(`Stored document "${documentName}" (${state.byteLength} bytes)`);
  },

  async onRequest({ request, response }) {
    const url = new URL(request.url ?? "", "http://localhost");

    if (url.pathname === "/api/users") {
      const documentName = url.searchParams.get("documentName");
      if (!documentName) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "documentName query parameter is required" }));
        throw null;
      }

      const users = await fetchUsers(documentName);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(users));
      throw null;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    throw null;
  },

  async onDestroy() {
    await closeDb();
    console.log("Database connection closed");
  },
});

server.listen();
