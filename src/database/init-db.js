const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT, 10) || 5432;
const dbUser = process.env.DB_USER || 'postgres';
const dbPassword = process.env.DB_PASSWORD || 'postgres';
const dbTargetName = process.env.DB_NAME || 'consultorio_san_rafael';

async function initDatabase() {
  console.log('===========================================================');
  console.log('🩺 INICIALIZADOR DE BASE DE DATOS - CONSULTORIO SAN RAFAEL');
  console.log('===========================================================');
  console.log(`Conectando como usuario: "${dbUser}" en ${dbHost}:${dbPort}...`);

  // Paso 1: Conectar a la base de datos de mantenimiento 'postgres' para verificar/crear la BD destino
  const adminClient = new Client({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: 'postgres',
  });

  try {
    await adminClient.connect();
    console.log('✔ Conexión inicial con el servidor PostgreSQL exitosa.');

    // Verificar si la base de datos existe
    const checkDb = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbTargetName]
    );

    if (checkDb.rows.length === 0) {
      console.log(`Creando base de datos "${dbTargetName}"...`);
      await adminClient.query(`CREATE DATABASE "${dbTargetName}" ENCODING 'UTF8';`);
      console.log(`✔ Base de datos "${dbTargetName}" creada exitosamente.`);
    } else {
      console.log(`✔ La base de datos "${dbTargetName}" ya existe.`);
    }

    await adminClient.end();
  } catch (err) {
    if (adminClient) {
      try { await adminClient.end(); } catch (_) {}
    }

    if (err.code === '28P01') {
      console.error('\n❌ ERROR DE AUTENTICACIÓN: La contraseña para el usuario PostgreSQL es incorrecta.');
      console.error('👉 Solución: Abre el archivo .env en la raíz del proyecto y actualiza la variable DB_PASSWORD con la clave de tu instalación de PostgreSQL.');
      process.exit(1);
    } else if (err.code === 'ECONNREFUSED') {
      console.error(`\n❌ ERROR DE CONEXIÓN: No se pudo conectar al servidor PostgreSQL en ${dbHost}:${dbPort}.`);
      console.error('👉 Solución: Asegúrate de que el servicio de PostgreSQL esté iniciado en los servicios de Windows.');
      process.exit(1);
    } else {
      console.error('\n❌ Error al verificar/crear la base de datos:', err.message);
      // Continuamos en caso de que el usuario ya tenga permisos directos solo sobre la BD destino
    }
  }

  // Paso 2: Conectar directamente a la base de datos de la clínica y ejecutar esquema y semillas
  console.log(`\nConectando a la base de datos "${dbTargetName}" para ejecutar scripts SQL...`);
  const client = new Client({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbTargetName,
  });

  try {
    await client.connect();

    // Leer y ejecutar schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    console.log('Ejecutando schema.sql (creación de tablas, restricciones e índices)...');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log('✔ Tablas y restricciones creadas correctamente.');

    // Leer y ejecutar seed.sql
    const seedPath = path.join(__dirname, 'seed.sql');
    console.log('Ejecutando seed.sql (datos iniciales de ARS, servicios, farmacia)...');
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await client.query(seedSql);

    // Garantizar integridad de cuentas de prueba existentes sin borrar ni reiniciar datos
    const cuentasBase = [
      {
        usuario: 'admin',
        hash: '$2b$12$yyeCZiUfQJjzvdG5OmUnYumX7cXuzsP/1SnPHi6ombU1RBYP3Hrk6',
        salt: '$2b$12$yyeCZiUfQJjzvdG5OmUnYu',
        rol: 'ADMINISTRADOR',
      },
      {
        usuario: 'medico',
        hash: '$2b$12$JIKMe8W4BgqgepbKDadDhOUGbJlHTNVxZp7wmhjbhTxw0nhzh0ca6',
        salt: '$2b$12$JIKMe8W4BgqgepbKDadDhO',
        rol: 'MEDICO',
      },
      {
        usuario: 'secretaria',
        hash: '$2b$12$JGGXxJVPjqwtFpfRaq1bKuWJTdVRJuDgFj9D4gTAb.g/cO.ywaFt.',
        salt: '$2b$12$JGGXxJVPjqwtFpfRaq1bKu',
        rol: 'SECRETARIA',
      },
      {
        usuario: 'recepcion',
        hash: '$2b$12$L5r.tYHYCSe3zh3L9OLI1./7K5xNajAFK2H152ivv/1rKBHEEkIUK',
        salt: '$2b$12$L5r.tYHYCSe3zh3L9OLI1.',
        rol: 'SECRETARIA',
      },
      {
        usuario: 'farmacia',
        hash: '$2b$12$QYSV/tj.9aQMv755i9ZyQ.xnyGw87GbJQfgbPWAPyAbKTbwH.ZvPe',
        salt: '$2b$12$QYSV/tj.9aQMv755i9ZyQ.',
        rol: 'FARMACIA',
      },
    ];

    for (const cuenta of cuentasBase) {
      await client.query(
        `UPDATE usuarios
         SET contrasena = $1,
             salt = $2,
             rol = $3,
             activo = true,
             token_version = COALESCE(token_version, 1)
         WHERE LOWER(usuario) = $4`,
        [cuenta.hash, cuenta.salt, cuenta.rol, cuenta.usuario]
      );
    }

    console.log('✔ Datos de prueba y catálogos verificados correctamente.');

    console.log('\n===========================================================');
    console.log('🎉 BASE DE DATOS INICIALIZADA SATISFACTORIAMENTE');
    console.log('===========================================================');
  } catch (err) {
    console.error('\n❌ Error al ejecutar los scripts SQL en la base de datos:', err.message);
    if (err.code === '28P01') {
      console.error('👉 Verifica la configuración de conexión en el archivo .env.');
    }
    if (require.main === module) {
      process.exit(1);
    }
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  initDatabase();
}

module.exports = initDatabase;

