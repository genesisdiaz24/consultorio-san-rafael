const db = require('../src/config/db');
const { hashPassword } = require('../src/utils/auth');

async function updateRoles() {
  await db.query(`
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('ADMINISTRADOR', 'MEDICO', 'SECRETARIA', 'FARMACIA', 'RECEPCION'));
  `);

  const { hash, salt } = hashPassword('secretaria123');
  await db.query(`
    INSERT INTO usuarios (nombre, usuario, correo, contrasena, salt, rol, activo)
    VALUES ('Laura Gómez (Secretaría)', 'secretaria', 'secretaria@sanrafael.com', $1, $2, 'SECRETARIA', true)
    ON CONFLICT (usuario) DO NOTHING
  `, [hash, salt]);

  // Actualizar también recepcion al rol SECRETARIA
  await db.query(`
    UPDATE usuarios SET rol = 'SECRETARIA' WHERE usuario = 'recepcion' OR rol = 'RECEPCION';
  `);

  const users = await db.query('SELECT id, nombre, usuario, rol, activo FROM usuarios ORDER BY id');
  console.log('--- Usuarios en Base de Datos ---');
  console.table(users.rows);
  process.exit(0);
}

updateRoles().catch(err => {
  console.error('Error al actualizar roles en DB:', err);
  process.exit(1);
});

