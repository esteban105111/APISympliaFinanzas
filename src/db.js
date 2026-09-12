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
