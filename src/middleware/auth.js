/**
 * Middlewares de Autenticación, Control de Inactividad (15 min) y Roles (RBAC)
 * Consultorio Médico San Rafael
 */

const db = require('../config/db');

// Límite de inactividad de sesión: 15 minutos en milisegundos
const INACTIVIDAD_MAXIMA_MS = 15 * 60 * 1000;

// 1. Verificación de inactividad de sesión y validez del token en el servidor
async function verificarInactividad(req, res, next) {
  if (req.session && req.session.usuario) {
    const ahora = Date.now();
    const ultimoAcceso = req.session.ultimoAcceso || ahora;
    const tiempoInactivo = ahora - ultimoAcceso;

    // A. Si han transcurrido más de 15 minutos sin actividad registrada
    if (tiempoInactivo > INACTIVIDAD_MAXIMA_MS) {
      return req.session.destroy(() => {
        res.clearCookie('sanrafael_sid');
        if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
          return res.status(401).json({
            error: 'Tu sesión ha expirado por inactividad',
            expirada: true,
            redirect: '/login',
          });
        }
        return res.redirect('/login?inactividad=1');
      });
    }

    // B. Validar integridad de sesión contra la base de datos (invalida sesiones si se cambió la clave o el usuario fue desactivado)
    try {
      const { rows } = await db.query(
        `SELECT id, activo, token_version FROM usuarios WHERE id = $1`,
        [req.session.usuario.id]
      );

      if (
        rows.length === 0 ||
        !rows[0].activo ||
        (rows[0].token_version || 1) !== (req.session.usuario.tokenVersion || 1)
      ) {
        return req.session.destroy(() => {
          res.clearCookie('sanrafael_sid');
          if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
            return res.status(401).json({
              error: 'Sesión invalidada. Por favor inicie sesión nuevamente.',
              redirect: '/login',
            });
          }
          req.flash('warning', 'Su sesión ha sido invalidada (cambio de contraseña o permisos).');
          return res.redirect('/login');
        });
      }
    } catch (err) {
      console.error('[AUTH ERROR] Verificación de integridad de sesión:', err.message);
    }

    // Actualizar marca de tiempo de última actividad válida en el servidor
    req.session.ultimoAcceso = ahora;
  }

  next();
}

// 2. Protección obligatoria: Requiere inicio de sesión válido
function requiereAutenticacion(req, res, next) {
  if (req.session && req.session.usuario) {
    // La marca de "destino tras login" solo vale para la primera página después de iniciar sesión
    if (req.session.destinoPostLogin && req.session.destinoPostLogin !== req.originalUrl) {
      delete req.session.destinoPostLogin;
    }
    return next();
  }

  // Si es una petición AJAX/API, responder con código HTTP 401
  if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autorizado. Inicio de sesión obligatorio.' });
  }

  // Guardar la URL a la que intentaba ingresar para redirigirlo luego del login únicamente si es una página web válida
  const urlDestino = req.originalUrl || '';
  const esRecursoEstatico = urlDestino.includes('favicon') || 
                            urlDestino.startsWith('/.well-known') ||
                            /\.(ico|css|js|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|map|json)$/i.test(urlDestino);
  const esRutaIgnorada = urlDestino === '/login' || 
                         urlDestino === '/logout' || 
                         urlDestino.startsWith('/api/') || 
                         urlDestino.startsWith('/recuperar-contrasena') || 
                         urlDestino.startsWith('/restablecer-contrasena');

  if (req.method === 'GET' && urlDestino && !esRecursoEstatico && !esRutaIgnorada) {
    req.session.returnTo = urlDestino;
  }

  req.flash('warning', 'Inicio de sesión obligatorio. Por favor ingrese sus credenciales para continuar.');
  return res.redirect('/login');
}

// 3. Control de Acceso basado en Roles (RBAC)
function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.session || !req.session.usuario) {
      req.flash('warning', 'Inicio de sesión obligatorio.');
      return res.redirect('/login');
    }

    const { rol } = req.session.usuario;

    // El rol ADMINISTRADOR siempre tiene acceso total a todos los módulos
    if (rol === 'ADMINISTRADOR' || rolesPermitidos.includes(rol)) {
      return next();
    }

    // Si acaba de iniciar sesión y fue enviado a una página recordada de otra sesión/perfil
    // que su rol no puede ver, llevarlo a su panel de inicio en vez de mostrar el error 403
    if (req.method === 'GET' && req.session.destinoPostLogin === req.originalUrl) {
      delete req.session.destinoPostLogin;
      return req.session.save(() => res.redirect('/'));
    }

    // Si el usuario no tiene el rol necesario, denegar acceso
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Acceso denegado. Permisos insuficientes.' });
    }

    res.status(403).render('403', {
      title: 'Acceso Denegado - Consultorio Médico San Rafael',
      mensaje: `Su rol actual (${rol}) no tiene autorización para acceder a esta sección.`,
    });
  };
}

// 4. Si ya está autenticado, no mostrar pantalla de login y enviar al panel
function yaAutenticado(req, res, next) {
  if (req.session && req.session.usuario) {
    return res.redirect('/');
  }
  next();
}

module.exports = {
  verificarInactividad,
  requiereAutenticacion,
  requiereRol,
  yaAutenticado,
  INACTIVIDAD_MAXIMA_MS,
};
