const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'consultorio_san_rafael',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err.message);
});

// Helper para ejecutar consultas con manejo estándar
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development' && duration > 500) {
      console.log(`[DB SLOW QUERY] ${text} - Tomó ${duration}ms`);
    }
    return res;
  } catch (error) {
    console.error(`[DB ERROR] Error ejecutando consulta: ${text}`);
    console.error(`[DB ERROR MENSAJE]:`, error.message);
    throw error;
  }
}

// Probar conexión inicial
async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW() as now, current_database() as db');
    return {
      connected: true,
      time: res.rows[0].now,
      database: res.rows[0].db,
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      code: error.code,
    };
  }
}

module.exports = {
  pool,
  query,
  testConnection,
};

