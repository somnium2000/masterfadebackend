import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// NUEVO:
// PORQUE: Centralizar la conexión PostgreSQL (Supabase) en un solo lugar.
// IMPACTO: Cualquier módulo puede reutilizar el mismo pool; credenciales van en .env.

const pool = new Pool({
  host: process.env.DB_HOST || 'aws-1-us-east-1.pooler.supabase.com',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, // ***REDACTED***
  database: process.env.DB_NAME || 'postgres',
  ssl: {
    rejectUnauthorized: false
  },
  // NUEVO:
  // PORQUE: Evita que el arranque se quede colgado si la red/DB no responde.
  // IMPACTO: Si la DB no responde en el tiempo configurado, verás el error rápido.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
  max: Number(process.env.DB_POOL_MAX || 10)
});

// NUEVO:
// PORQUE: Prueba opcional de conexión en arranque.
// IMPACTO: Solo se ejecuta si DB_TEST_CONNECTION=true.
if (process.env.DB_TEST_CONNECTION === 'true') {
  pool.connect((err, client, release) => {
    if (err) {
      console.error('Error al conectar con la base de datos:', err.stack);
    } else {
      console.log('¡Conexión exitosa a la base de datos!');
      release();
    }
  });
}

export default pool;