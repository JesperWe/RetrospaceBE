# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript-based real-time collaboration server using Hocuspocus (WebSocket server) and Yjs (CRDT library) with PostgreSQL persistence. The server enables multiple clients to collaborate on shared documents in real-time, with automatic conflict resolution through CRDTs.

**Key Technology Stack:**
- **Hocuspocus**: WebSocket server for Yjs collaboration
- **Yjs**: Conflict-free Replicated Data Type (CRDT) library
- **PostgreSQL**: Document persistence storage
- **TypeScript**: ES Modules with NodeNext module resolution

## Development Commands

```bash
# Development mode with auto-reload
npm run dev

# Type-check without building
npx tsc --noEmit

# Build for production
npm run build

# Run production build
npm start
```

## Architecture

### Document Model

Documents are identified by **name** (provided in the WebSocket URL path). Each document contains a Y.Array of objects with this structure:
- `type`: string
- `position`: {x, y, z} (3D coordinates)
- `size`: {width, height, depth} (3D dimensions)
- `rotation`: {x, y, z} (3D rotation)
- `color`: string
- `comments`: string[] (array of comment strings)

### Persistence Layer

The server stores **Yjs binary state** as opaque BYTEA blobs in PostgreSQL. The CRDT state itself is the source of truth—the server doesn't parse or validate the document structure.

**Database Schema:**
```sql
CREATE TABLE documents (
  name TEXT PRIMARY KEY,
  state BYTEA NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Persistence Flow:**
1. Client connects → `onLoadDocument` hook fires → fetch binary state from DB → apply to Yjs Doc via `applyUpdate()`
2. Client makes changes → Hocuspocus debounces (2s default, 10s max) → `onStoreDocument` hook fires → encode full state via `encodeStateAsUpdate()` → upsert to DB
3. Server shutdown → `onDestroy` hook closes DB pool

### Module Structure

- **`src/index.ts`**: Main server—defines Hocuspocus lifecycle hooks (`onConnect`, `onLoadDocument`, `onStoreDocument`, `onDestroy`)
- **`src/db.ts`**: PostgreSQL abstraction—connection pool, table initialization, fetch/store operations

### Critical Implementation Details

**ESM + CommonJS interop:**
- The project uses `"type": "module"` with `"module": "NodeNext"` TypeScript config
- Import `pg` package as: `import pg from "pg"; const { Pool } = pg;` (default import required for CJS compatibility)
- Use `.js` extensions in relative imports (`./db.js`) even though the source file is `.ts`—this is required by NodeNext module resolution

**Top-level await:**
- `await initDb()` runs at module top level before server starts
- Supported by ESM + tsx runtime

**Yjs state handling:**
- `encodeStateAsUpdate(doc)` returns the full document state as `Uint8Array` (not a delta)
- `applyUpdate(doc, state)` mutates the Yjs Doc in place
- PostgreSQL `pg` library returns BYTEA as Node.js `Buffer` (which extends `Uint8Array`), so it works directly with `applyUpdate()`

**Debouncing:**
- Hocuspocus handles `onStoreDocument` debouncing internally—do NOT implement custom debounce logic
- Documents are stored at most once per 2 seconds, guaranteed to persist at least once per 10 seconds during active editing

## Environment Configuration

**Required:**
- `DATABASE_URL`: PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/dbname`)

**Note:** The codebase currently has a fallback hardcoded connection string in `src/db.ts` for local development—remove before production deployment.

## Client Connection Pattern

Clients connect via WebSocket URL with document name in the path:
```
ws://localhost:8081/my-document-name
```

The path component (`my-document-name`) becomes the `documentName` in server hooks, which is used as the primary key for database persistence.

## Deployment Context

This server is intended for deployment on **Encore.dev**. The Encore platform provisions PostgreSQL and provides `DATABASE_URL` automatically. The server uses standard `pg` client rather than Encore's SDK to remain framework-agnostic.
