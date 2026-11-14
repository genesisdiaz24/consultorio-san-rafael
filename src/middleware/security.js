const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 1. Configuración de Cabeceras de Seguridad con Helmet
const helmetConfig = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.jsdelivr.net',
        'https://www.paypal.com',
        'https://www.sandbox.paypal.com',
        'https://*.paypal.com',
        'https://*.paypalobjects.com',
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:', 'https://*.paypal.com', 'https://*.paypalobjects.com'],
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com', 'https://*.paypal.com'],
      connectSrc: [
        "'self'",
        'https://cdn.jsdelivr.net',
        'https://www.paypal.com',
        'https://www.sandbox.paypal.com',
        'https://*.paypal.com',
      ],
      upgradeInsecureRequests: null,
    },
  },
  strictTransportSecurity: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// 2. Configuración de CORS
const corsConfig = cors({
  origin: (origin, callback) => {
    // Permitir solicitudes del mismo origen o herramientas locales
    if (!origin) return callback(null, true);
    const permitidos = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (permitidos.length === 0 || permitidos.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    return callback(new Error('Bloqueado por política CORS'));
  },
  credentials: true,
});

// 3. Limitador de intentos para inicio de sesión (Protección contra fuerza bruta)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 15, // Máximo 15 intentos FALLIDOS por IP
  skip: () => process.env.NODE_ENV === 'test',
  // Solo contar intentos fallidos: un login correcto redirige al panel; uno fallido vuelve a /login
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => {
    const destino = String(res.getHeader('Location') || '');
    return res.statusCode < 400 && destino !== '' && !destino.endsWith('/login');
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(429).json({
        error: 'Demasiados intentos fallidos. Por favor espere 15 minutos antes de volver a intentar.',
      });
    }
    req.flash('error', 'Demasiados intentos fallidos. Por favor espere 15 minutos antes de intentar de nuevo.');
    res.redirect('/login');
  },
});

// 4. Limitador de intentos para recuperación de contraseña
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 8, // Máximo 8 solicitudes por IP
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(429).json({
        error: 'Demasiadas solicitudes de recuperación. Intente nuevamente en 15 minutos.',
      });
    }
    req.flash('error', 'Demasiadas solicitudes de recuperación. Intente nuevamente en 15 minutos.');
    res.redirect('/recuperar-contrasena');
  },
});

// Extraer cookie específica del encabezado Cookie
function obtenerCookie(req, nombre) {
  const raw = req.headers?.cookie;
  if (!raw) return '';
  const partes = raw.split(';');
  for (const parte of partes) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) {
      try {
        return decodeURIComponent(v.join('='));
      } catch (_) {
        return v.join('=');
      }
    }
  }
  return '';
}

// 5. Middleware de Protección CSRF (Tokens de sesión sincronizados)
function csrfMiddleware(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    // Limpiar cualquier política HSTS previa en caché del navegador para permitir HTTP local sin bloqueo de recursos
    res.setHeader('Strict-Transport-Security', 'max-age=0');
  }

  const cookieXsrf = obtenerCookie(req, 'XSRF-TOKEN');
  const cookieXsrfValida = /^[a-f0-9]{48}$/i.test(cookieXsrf) ? cookieXsrf : '';

  // Inicializar token CSRF en la sesión (reutilizando cookie XSRF válida si la sesión recién se creó)
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = cookieXsrfValida || crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;

    // Configurar cookie legible para librerías frontend (XSRF-TOKEN)
    res.cookie('XSRF-TOKEN', req.session.csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });
  }

  // Métodos seguros (GET, HEAD, OPTIONS) no requieren validación
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Rutas exentas de CSRF de navegador (keep-alive de sesión y receptor de Webhooks firmados por PayPal)
  if (req.path === '/api/session/keep-alive' || req.path === '/api/paypal/webhook') {
    return next();
  }

  // Extraer token de body o cabeceras
  const tokenRecibido =
    req.body?._csrf ||
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    req.headers['x-xsrf-token'];

  const tokenEsperado = req.session?.csrfToken;
  const coincideSesion = Boolean(tokenRecibido && tokenEsperado && tokenRecibido === tokenEsperado);
  const coincideCookie = Boolean(
    tokenRecibido &&
    cookieXsrfValida &&
    tokenRecibido === cookieXsrfValida &&
    /^[a-f0-9]{48}$/i.test(String(tokenRecibido))
  );

  if (coincideCookie && req.session && req.session.csrfToken !== tokenRecibido) {
    req.session.csrfToken = tokenRecibido;
    res.locals.csrfToken = tokenRecibido;
  }

  // Si la petición no incluye un token CSRF válido
  if (!tokenRecibido || (!coincideSesion && !coincideCookie)) {
    // Si es una petición API/AJAX
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Token de seguridad CSRF inválido o ausente.' });
    }

    // Si viene de un formulario web regular
    req.flash('error', 'Su solicitud no pudo ser validada por motivos de seguridad (CSRF). Por favor intente nuevamente.');
    const referer = req.headers.referer || (req.path === '/login' ? '/login' : '/');
    return res.redirect(referer);
  }

  next();
}

module.exports = {
  helmetConfig,
  corsConfig,
  loginLimiter,
  passwordResetLimiter,
  csrfMiddleware,
};
