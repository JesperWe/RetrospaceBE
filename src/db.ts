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

  console.log("Database initialized, documents table ready");
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

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
