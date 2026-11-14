const db = require('../config/db');
const { verifyPassword, hashPassword, generatePasswordResetToken, hashToken } = require('../utils/auth');
const emailService = require('../services/emailService');

// 1. Mostrar pantalla de inicio de sesión
exports.formularioLogin = (req, res) => {
  // Manejo de mensaje si la sesión expiró por inactividad
  if (req.query.inactividad === '1' || req.query.expirada === '1') {
    const msg = 'Tu sesión ha expirado por inactividad';
    req.flash('warning', msg);
    if (!res.locals.mensajes) res.locals.mensajes = {};
    if (!res.locals.mensajes.warning) res.locals.mensajes.warning = [];
    if (!res.locals.mensajes.warning.includes(msg)) {
      res.locals.mensajes.warning.push(msg);
    }
  }

  res.render('auth/login', {
    title: 'Iniciar Sesión - Consultorio Médico San Rafael',
    layout: false,
  });
};

// 2. Procesar credenciales de inicio de sesión
exports.iniciarSesion = async (req, res, next) => {
  try {
    const { usuario, contrasena } = req.body;

    if (!usuario || !contrasena) {
      req.flash('error', 'Por favor ingrese su nombre de usuario y contraseña.');
      return req.session ? req.session.save(() => res.redirect('/login')) : res.redirect('/login');
    }

    const usuarioLimpio = String(usuario).trim().toLowerCase();
    const usuarioSinTildes = usuarioLimpio.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Buscar usuario activo en la base de datos (por usuario o correo, tolerando tildes)
    const { rows } = await db.query(
      `SELECT * FROM usuarios
       WHERE (LOWER(TRIM(usuario)) = $1 OR LOWER(TRIM(usuario)) = $2 OR LOWER(TRIM(correo)) = $1)
         AND activo = true
       ORDER BY id ASC
       LIMIT 1`,
      [usuarioLimpio, usuarioSinTildes]
    );

    if (rows.length === 0) {
      req.flash('error', 'Credenciales incorrectas o usuario inactivo.');
      return req.session ? req.session.save(() => res.redirect('/login')) : res.redirect('/login');
    }

    const usuarioDb = rows[0];

    // Verificar contraseña con hash seguro (bcrypt o PBKDF2 previo)
    const verificacion = verifyPassword(contrasena, usuarioDb.contrasena, usuarioDb.salt);

    if (!verificacion.esValida) {
      req.flash('error', 'Credenciales incorrectas o usuario inactivo.');
      return req.session ? req.session.save(() => res.redirect('/login')) : res.redirect('/login');
    }

    const tokenVersion = usuarioDb.token_version || 1;

    // Si la contraseña estaba en formato PBKDF2 previo o token_version era NULL, actualizar transparente a bcrypt
    if (!verificacion.esBcrypt || !usuarioDb.token_version) {
      const { hash: nuevoHash, salt: nuevoSalt } = verificacion.esBcrypt
        ? { hash: usuarioDb.contrasena, salt: usuarioDb.salt || '' }
        : hashPassword(String(contrasena).trim() || contrasena);
      await db.query(
        `UPDATE usuarios SET contrasena = $1, salt = $2, token_version = COALESCE(token_version, 1) WHERE id = $3`,
        [nuevoHash, nuevoSalt, usuarioDb.id]
      );
    }

    // Establecer sesión del usuario autenticado
    req.session.usuario = {
      id: usuarioDb.id,
      nombre: usuarioDb.nombre,
      usuario: usuarioDb.usuario,
      correo: usuarioDb.correo,
      rol: (usuarioDb.rol || '').toUpperCase(),
      tokenVersion,
    };
    req.session.ultimoAcceso = Date.now();

    req.flash('success', `¡Bienvenido(a), ${usuarioDb.nombre}! Sesión iniciada.`);

    let destino = req.session.returnTo || '/';
    delete req.session.returnTo;

    // Validación defensiva: asegurar que sea una ruta interna válida y no un archivo estático ni favicon
    if (
      !destino ||
      typeof destino !== 'string' ||
      !destino.startsWith('/') ||
      destino.startsWith('//') ||
      destino.startsWith('/.well-known') ||
      destino.includes('favicon') ||
      /\.(ico|png|jpg|jpeg|gif|svg|css|js|json|map|woff2?|ttf|eot)$/i.test(destino) ||
      destino === '/login' ||
      destino === '/logout'
    ) {
      destino = '/';
    }

    if (destino !== '/') {
      req.session.destinoPostLogin = destino;
    }

    return req.session.save(() => {
      res.redirect(destino);
    });
  } catch (error) {
    if (error.code === '42P01' || error.code === '3D000' || error.code === 'ECONNREFUSED' || error.code === '28P01') {
      return res.render('db-error', {
        error,
        title: 'Configuración de Base de Datos Requerida',
      });
    }
    next(error);
  }
};

// 3. Cerrar sesión e invalidar estado en el servidor
exports.cerrarSesion = (req, res) => {
  const finalizarCierre = () => {
    res.clearCookie('sanrafael_sid', { path: '/' });
    res.clearCookie('XSRF-TOKEN', { path: '/' });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Clear-Site-Data', '"cache", "storage"');
    res.redirect('/login');
  };

  if (req.session) {
    req.session.destroy(() => {
      finalizarCierre();
    });
  } else {
    finalizarCierre();
  }
};

// 4. Endpoint de latido / keep-alive para detección de actividad del usuario
exports.keepAlive = (req, res) => {
  if (!req.session || !req.session.usuario) {
    return res.status(401).json({
      autenticado: false,
      expirado: true,
      mensaje: 'Tu sesión ha expirado por inactividad',
    });
  }

  // Renovar marca de tiempo de actividad en el servidor
  req.session.ultimoAcceso = Date.now();
  return res.json({
    autenticado: true,
    expirado: false,
    tiempoRestanteMs: 15 * 60 * 1000,
  });
};

// 5. Mostrar formulario "¿Olvidaste tu contraseña?"
exports.formularioRecuperar = (req, res) => {
  res.render('auth/recuperar', {
    title: 'Recuperar Contraseña - Consultorio Médico San Rafael',
    layout: false,
  });
};

// 6. Procesar solicitud de recuperación con respuesta neutral
exports.solicitarRecuperacion = async (req, res, next) => {
  try {
    const { identificador } = req.body;

    if (!identificador || identificador.trim() === '') {
      req.flash('error', 'Por favor ingrese su usuario o correo electrónico.');
      return res.redirect('/recuperar-contrasena');
    }

    const valorLimpio = identificador.trim().toLowerCase();

    // Buscar si existe un usuario activo con ese correo o usuario
    const { rows } = await db.query(
      `SELECT id, nombre, usuario, correo FROM usuarios WHERE (LOWER(usuario) = $1 OR LOWER(correo) = $1) AND activo = true`,
      [valorLimpio]
    );

    if (rows.length > 0 && rows[0].correo) {
      const usuario = rows[0];

      // 1. Generar token criptográficamente seguro válido por 15 minutos
      const { tokenPlano, tokenHash, expiraEn } = generatePasswordResetToken();

      // 2. Invalidar cualquier token previo activo para este usuario
      await db.query(
        `UPDATE password_reset_tokens SET usado = true WHERE usuario_id = $1 AND usado = false`,
        [usuario.id]
      );

      // 3. Guardar el hash del token en la base de datos (nunca el token plano)
      await db.query(
        `INSERT INTO password_reset_tokens (usuario_id, token_hash, expira_en, usado)
         VALUES ($1, $2, $3, false)`,
        [usuario.id, tokenHash, expiraEn]
      );

      // 4. Enviar correo o mostrar enlace en consola de desarrollo
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      await emailService.enviarRecuperacionContrasena(usuario.correo, usuario.nombre, tokenPlano, baseUrl);
    }

    // Respuesta neutral para prevenir enumeración de usuarios
    req.flash(
      'info',
      'Si los datos ingresados coinciden con una cuenta registrada, se ha enviado un enlace para restablecer la contraseña (válido por 15 minutos).'
    );
    res.redirect('/recuperar-contrasena');
  } catch (error) {
    next(error);
  }
};

// 7. Mostrar formulario para ingresar nueva contraseña
exports.formularioRestablecer = async (req, res, next) => {
  try {
    const { token } = req.params;

    if (!token) {
      req.flash('error', 'Token de recuperación no proporcionado.');
      return res.redirect('/login');
    }

    const tokenHash = hashToken(token);

    // Validar token en la base de datos (no usado y no expirado)
    const { rows } = await db.query(
      `SELECT prt.*, u.nombre, u.usuario
       FROM password_reset_tokens prt
       INNER JOIN usuarios u ON prt.usuario_id = u.id
       WHERE prt.token_hash = $1
         AND prt.usado = false
         AND prt.expira_en > CURRENT_TIMESTAMP`,
      [tokenHash]
    );

    if (rows.length === 0) {
      req.flash('error', 'El enlace de recuperación es inválido, ha expirado (más de 15 minutos) o ya fue utilizado.');
      return res.redirect('/recuperar-contrasena');
    }

    res.render('auth/restablecer', {
      token,
      usuario: rows[0],
      title: 'Restablecer Contraseña - Consultorio Médico San Rafael',
      layout: false,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Procesar cambio de contraseña e invalidar sesiones anteriores
exports.procesarRestablecer = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const { contrasena, confirmar_contrasena } = req.body;

    if (!token) {
      req.flash('error', 'Token no válido.');
      return res.redirect('/recuperar-contrasena');
    }

    if (!contrasena || contrasena.length < 6) {
      req.flash('error', 'La nueva contraseña debe tener al menos 6 caracteres.');
      return res.redirect(`/restablecer-contrasena/${encodeURIComponent(token)}`);
    }

    if (contrasena !== confirmar_contrasena) {
      req.flash('error', 'Las contraseñas no coinciden.');
      return res.redirect(`/restablecer-contrasena/${encodeURIComponent(token)}`);
    }

    await client.query('BEGIN');

    const tokenHash = hashToken(token);

    // 1. Verificar validez del token dentro de la transacción
    const { rows } = await client.query(
      `SELECT prt.*, u.id as user_id, u.nombre, u.usuario
       FROM password_reset_tokens prt
       INNER JOIN usuarios u ON prt.usuario_id = u.id
       WHERE prt.token_hash = $1
         AND prt.usado = false
         AND prt.expira_en > CURRENT_TIMESTAMP
       FOR UPDATE`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'El enlace de recuperación es inválido, ha expirado o ya fue utilizado.');
      return res.redirect('/recuperar-contrasena');
    }

    const resetData = rows[0];

    // 2. Generar nuevo hash con bcrypt
    const { hash, salt } = hashPassword(contrasena);

    // 3. Actualizar contraseña e incrementar token_version para invalidar sesiones activas en cualquier dispositivo
    await client.query(
      `UPDATE usuarios 
       SET contrasena = $1, salt = $2, token_version = token_version + 1 
       WHERE id = $3`,
      [hash, salt, resetData.user_id]
    );

    // 4. Marcar token actual como usado
    await client.query(
      `UPDATE password_reset_tokens SET usado = true WHERE id = $1`,
      [resetData.id]
    );

    // 5. Invalidar cualquier otro token pendiente para este usuario
    await client.query(
      `UPDATE password_reset_tokens SET usado = true WHERE usuario_id = $1`,
      [resetData.user_id]
    );

    await client.query('COMMIT');

    // 6. Limpiar datos de usuario de la sesión actual si existieran
    if (req.session) {
      delete req.session.usuario;
      delete req.session.returnTo;
    }

    req.flash('success', 'Su contraseña ha sido restablecida exitosamente. Todas las sesiones activas han sido cerradas. Por favor inicie sesión.');
    res.redirect('/login');
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};
