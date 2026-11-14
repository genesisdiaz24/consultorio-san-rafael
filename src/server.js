const app = require('./app');
const db = require('./config/db');
const initDatabase = require('./database/init-db');
const { ejecutarMigraciones } = require('./database/migraciones');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

async function startServer() {
  console.log('------------------------------------------------------------');
  console.log('🏥 INICIANDO SISTEMA WEB - CONSULTORIO MÉDICO SAN RAFAEL');
  console.log('------------------------------------------------------------');

  // Comprobar conexión a PostgreSQL
  let status = await db.testConnection();
  if (!status.connected && status.code === '3D000') {
    console.log('⚙️ Base de datos no encontrada. Inicializando esquema y datos iniciales...');
    try {
      await initDatabase();
      status = await db.testConnection();
    } catch (initErr) {
      console.error('⚠️ Error al inicializar automáticamente la base de datos:', initErr.message);
    }
  }

  if (status.connected) {
    try {
      const checkUsers = await db.query('SELECT COUNT(*) AS total FROM usuarios');
      if (parseInt(checkUsers.rows[0].total, 10) === 0) {
        await initDatabase();
      }
    } catch (tableErr) {
      if (tableErr.code === '42P01') {
        console.log('⚙️ Tablas no encontradas. Ejecutando inicialización de base de datos...');
        await initDatabase();
      }
    }
    // Aplicar cambios de esquema nuevos sobre bases de datos ya existentes (idempotente)
    await ejecutarMigraciones();
    console.log(`✔ Conexión a PostgreSQL establecida con éxito.`);
    console.log(`  Base de datos: ${status.database}`);
    console.log(`  Hora del servidor DB: ${status.time}`);
  } else {
    console.warn(`⚠️ AVISO: No se pudo conectar a PostgreSQL aún.`);
    console.warn(`  Causa: ${status.error}`);
    console.warn(`👉 Verifique los parámetros de conexión en el archivo .env (DB_HOST, DB_PORT, DB_USER, DB_NAME).`);
    console.warn(`👉 Para inicializar la base de datos manualmente ejecute: npm run db:init`);
  }

  app.listen(PORT, () => {
    console.log(`------------------------------------------------------------`);
    console.log(`🚀 Servidor en funcionamiento en el puerto: ${PORT}`);
    console.log(`🌐 Acceso web: http://localhost:${PORT}`);
    console.log(`------------------------------------------------------------`);
  });
}

startServer().catch((err) => {
  console.error('Error fatal al iniciar el servidor:', err);
});

