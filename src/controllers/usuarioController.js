const db = require('../config/db');
const { hashPassword } = require('../utils/auth');

// Listar usuarios del sistema
exports.listar = async (req, res, next) => {
  try {
    const { rows: usuarios } = await db.query(
      `SELECT id, nombre, usuario, correo, rol, activo, created_at FROM usuarios ORDER BY nombre ASC`
    );

    res.render('usuarios/index', {
      usuarios,
      title: 'Gestión de Usuarios y Roles',
    });
  } catch (error) {
    next(error);
  }
};

// Formulario de nuevo usuario
exports.formularioCrear = (req, res) => {
  res.render('usuarios/form', {
    usuario: {},
    esEdicion: false,
    title: 'Crear Nuevo Usuario del Sistema',
  });
};

// Crear usuario con rol asignado y contraseña hasheada
exports.crear = async (req, res, next) => {
  try {
    const { nombre, usuario, correo, contrasena, rol } = req.body;

    if (!nombre || !usuario || !contrasena || !rol) {
      req.flash('error', 'Todos los campos marcados con (*) son obligatorios.');
      return res.redirect('/usuarios/nuevo');
    }

    const usuarioLimpio = usuario.trim().toLowerCase();

    // Comprobar si ya existe el nombre de usuario
    const { rows: existentes } = await db.query(
      `SELECT id FROM usuarios WHERE LOWER(usuario) = $1 OR (correo IS NOT NULL AND LOWER(correo) = $2)`,
      [usuarioLimpio, correo ? correo.trim().toLowerCase() : '']
    );

    if (existentes.length > 0) {
      req.flash('error', `El nombre de usuario "${usuarioLimpio}" o correo ya está registrado.`);
      return res.redirect('/usuarios/nuevo');
    }

    const { hash, salt } = hashPassword(contrasena);

    const insertQuery = `
      INSERT INTO usuarios (nombre, usuario, correo, contrasena, salt, rol, activo, token_version)
      VALUES ($1, $2, $3, $4, $5, $6, true, 1)
    `;

    await db.query(insertQuery, [
      nombre.trim(),
      usuarioLimpio,
      correo ? correo.trim().toLowerCase() : null,
      hash,
      salt,
      rol,
    ]);

    req.flash('success', `Usuario "${usuarioLimpio}" creado exitosamente con rol ${rol}.`);
    res.redirect('/usuarios');
  } catch (error) {
    next(error);
  }
};

// Activar o desactivar usuario
exports.cambiarEstado = async (req, res, next) => {
  try {
    const { id } = req.params;

    // No permitir que el admin se desactive a sí mismo
    if (parseInt(id, 10) === req.session.usuario.id) {
      req.flash('error', 'No puede desactivar su propia cuenta en sesión.');
      return res.redirect('/usuarios');
    }

    const { rows } = await db.query(`SELECT activo FROM usuarios WHERE id = $1`, [id]);
    if (rows.length === 0) {
      req.flash('error', 'Usuario no encontrado.');
      return res.redirect('/usuarios');
    }

    const nuevoEstado = !rows[0].activo;
    await db.query(`UPDATE usuarios SET activo = $1 WHERE id = $2`, [nuevoEstado, id]);

    req.flash('info', `Estado del usuario actualizado a: ${nuevoEstado ? 'Activo' : 'Inactivo'}.`);
    res.redirect('/usuarios');
  } catch (error) {
    next(error);
  }
};
