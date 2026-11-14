const db = require('../src/config/db');

async function createPasswordResetTable() {
  const client = await db.pool.connect();
  try {
    console.log('--- Creando tabla de tokens de recuperación de contraseña ---');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL,
        expira_en TIMESTAMP NOT NULL,
        usado BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_usuario ON password_reset_tokens(usuario_id);
    `);

    await client.query('COMMIT');
    console.log('✔ Tabla password_reset_tokens e índices creados con éxito.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear tabla password_reset_tokens:', error);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

createPasswordResetTable();

