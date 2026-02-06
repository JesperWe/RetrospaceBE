import { Server } from "@hocuspocus/server";
import { encodeStateAsUpdate, applyUpdate } from "yjs";
import { initDb, fetchDocument, storeDocument, closeDb } from "./db.js";

await initDb();

const server = new Server({
  port: 8081,

  async onConnect() {
    console.log("A user connected!");
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

  async onDestroy() {
    await closeDb();
    console.log("Database connection closed");
  },
});

server.listen();
