import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const production = process.env.NODE_ENV === 'production';
const poolMax = Number(process.env.DB_POOL_MAX || (production ? 5 : 10));
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isFinite(poolMax) ? Math.max(1, Math.min(poolMax, 10)) : 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

// El pooler de Neon inicia con search_path vacío. Cada conexión se prepara
// antes de ejecutar una consulta, sin depender de parámetros no soportados.
export const connect = async () => {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
};

export const query = async (sql, values) => {
  const client = await connect();
  try {
    return await client.query(sql, values);
  } finally {
    client.release();
  }
};
