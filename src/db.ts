import pg from "pg";
const { Pool } = pg;

let pool: pg.Pool;

export async function initDb(): Promise<void> {
  const connectionString =
    process.env.DARABASE_URL ||
    "postgres://postgres:123@localhost:5432/postgres";
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  pool = new Pool({ connectionString });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      name TEXT PRIMARY KEY,
      state BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      document_name TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
      online BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(id, document_name)
    )
  `);

  console.log("Database initialized, documents and users tables ready");
}

export async function fetchDocument(name: string): Promise<Uint8Array | null> {
  const result = await pool.query(
    "SELECT state FROM documents WHERE name = $1",
    [name],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].state;
}

export async function storeDocument(
  name: string,
  state: Uint8Array,
): Promise<void> {
  await pool.query(
    `INSERT INTO documents (name, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (name)
     DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [name, Buffer.from(state)],
  );
}

export async function setUserOnline(
  userId: string,
  documentName: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, document_name, online, updated_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (id, document_name)
     DO UPDATE SET online = TRUE, updated_at = NOW()`,
    [userId, documentName],
  );
}

export async function setUserOffline(
  userId: string,
  documentName: string,
): Promise<void> {
  await pool.query(
    `UPDATE users SET online = FALSE, updated_at = NOW()
     WHERE id = $1 AND document_name = $2`,
    [userId, documentName],
  );
}

export async function fetchUsers(
  documentName: string,
): Promise<{ id: string; online: boolean }[]> {
  const result = await pool.query(
    "SELECT id, online FROM users WHERE document_name = $1",
    [documentName],
  );
  return result.rows;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
