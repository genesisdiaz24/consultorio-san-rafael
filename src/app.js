const express = require('express');
const path = require('path');
const morgan = require('morgan');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
require('dotenv').config();

const { helmetConfig, corsConfig, csrfMiddleware } = require('./middleware/security');
const { verificarInactividad, requiereAutenticacion } = require('./middleware/auth');
const { liquidarArs } = require('../public/js/liquidacion-ars');
const { tieneAlergias, calcularEdad, TIPOS_SANGRE } = require('./utils/clinica');

const app = express();
const esProduccion = process.env.NODE_ENV === 'production';

// Cloud Run (y cualquier balanceador) termina HTTPS en un proxy: confiar en él para que
// req.secure / req.ip sean correctos (cookies "secure" de sesión y límite de intentos por IP real).
if (esProduccion || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Comprobación de salud (no requiere sesión ni base de datos).
// No usar /healthz: Cloud Run reserva las rutas que terminan en "z" y responde 404.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// 1. Cabeceras de Seguridad y Control de Origen
app.use(helmetConfig);
app.use(corsConfig);

// 2. Configuración de Motor de Plantillas EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); 

// 3. Middleware de archivos estáticos y Favicon
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'favicon.ico'), (err) => {
    if (err) res.status(204).end();
  });
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// 4. Cabeceras estrictas Anti-Caché para proteger páginas dinámicas y datos clínicos (BFCache / Botón Atrás)
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// 4. Parseo de solicitudes
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// 5. Logging en desarrollo
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// 6. Configuración de Sesión Segura y Cierre Automático (15 minutos de inactividad)
if (esProduccion && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET es obligatorio en producción (configúrelo como secreto en Cloud Run).');
}

// En producción las sesiones se guardan en PostgreSQL: Cloud Run puede reiniciar o
// ejecutar varias instancias, y la memoria del proceso no se comparte entre ellas.
let sessionStore;
if (esProduccion || process.env.SESSION_STORE === 'pg') {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({
    pool: require('./config/db').pool,
    tableName: 'sesiones_usuario',
    createTableIfMissing: true,
    pruneSessionInterval: 15 * 60, // limpiar sesiones vencidas cada 15 min
  });
}

app.use(
  session({
    name: 'sanrafael_sid',
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'consultorio_san_rafael_seguro_clave_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // Protege contra robo de sesión por XSS
      secure: esProduccion, // Solo HTTPS en producción
      sameSite: 'lax', // Protección contra ataques CSRF
      maxAge: 15 * 60 * 1000, // 15 minutos exactos de inactividad
    },
  })
);

app.use(flash());

// 7. Verificación de Inactividad en el Servidor (independiente del navegador)
app.use(verificarInactividad);

// 8. Protección CSRF para peticiones mutantes y tokens en vistas
app.use(csrfMiddleware);

// 9. Variables globales para todas las vistas EJS
app.use((req, res, next) => {
  res.locals.mensajes = {
    success: req.flash('success'),
    error: req.flash('error'),
    warning: req.flash('warning'),
    info: req.flash('info'),
  };
  res.locals.usuarioActual = req.session && req.session.usuario ? req.session.usuario : null;
  res.locals.pathActual = req.path || '';
  res.locals.csrfToken = req.session ? req.session.csrfToken : '';
  res.locals.clinicName = process.env.CLINIC_NAME || 'Consultorio Médico San Rafael';
  res.locals.clinicPhone = process.env.CLINIC_PHONE || '(809) 555-0199';
  res.locals.clinicAddress = process.env.CLINIC_ADDRESS || 'Av. San Rafael #102, Santiago de los Caballeros';

  // Helper para formatear montos en moneda dominicana RD$
  res.locals.formatoMoneda = (monto) => {
    const num = parseFloat(monto) || 0;
    return 'RD$ ' + num.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Regla única de liquidación ARS (para cálculos dentro de las plantillas)
  res.locals.liquidarArs = liquidarArs;

  // Utilidades clínicas para las vistas (alergias reales, edad, tipos de sangre)
  res.locals.tieneAlergias = tieneAlergias;
  res.locals.calcularEdad = calcularEdad;
  res.locals.TIPOS_SANGRE = TIPOS_SANGRE;

  // Helper para formatear fechas
  res.locals.formatoFecha = (fecha) => {
    if (!fecha) return 'N/A';
    try {
      const d = new Date(fecha);
      return d.toLocaleDateString('es-DO', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return String(fecha);
    }
  };

  res.locals.formatoFechaHora = (fecha) => {
    if (!fecha) return 'N/A';
    try {
      const d = new Date(fecha);
      return d.toLocaleString('es-DO', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return String(fecha);
    }
  };

  next();
});

// 10. Rutas Públicas de Autenticación y Receptor de Webhooks Firmados de PayPal
const authRoutes = require('./routes/authRoutes');
const paypalController = require('./controllers/paypalController');
app.post('/api/paypal/webhook', paypalController.recibirWebhook);
app.use('/', authRoutes);

// 11. Middleware de Autenticación Obligatoria para Todas las Rutas Internas
app.use(requiereAutenticacion);

// 12. Rutas Protegidas del Consultorio con Control de Acceso por Rol (RBAC)
const indexRoutes = require('./routes/indexRoutes');
const usuarioRoutes = require('./routes/usuarioRoutes');
const pacienteRoutes = require('./routes/pacienteRoutes');
const citaRoutes = require('./routes/citaRoutes');
const consultaRoutes = require('./routes/consultaRoutes');
const farmaciaRoutes = require('./routes/farmaciaRoutes');
const arsRoutes = require('./routes/arsRoutes');
const ecfRoutes = require('./routes/ecfRoutes');
const paypalRoutes = require('./routes/paypalRoutes');
const reporteRoutes = require('./routes/reporteRoutes');

app.use('/', indexRoutes);
app.use('/usuarios', usuarioRoutes);
app.use('/pacientes', pacienteRoutes);
app.use('/citas', citaRoutes);
app.use('/consultas', consultaRoutes);
app.use('/farmacia', farmaciaRoutes);
app.use('/ars', arsRoutes);
app.use('/ecf', ecfRoutes);
app.use('/pagos/paypal', paypalRoutes);
app.use('/reportes', reporteRoutes);

// 13. Manejo de Ruta No Encontrada (404)
app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Página no encontrada - Consultorio Médico San Rafael',
    usuarioActual: req.session && req.session.usuario ? req.session.usuario : null,
    pathActual: req.path || '',
  });
});

// 14. Manejador Global de Errores (500) Seguro sin fugas de credenciales ni detalles internos
app.use((err, req, res, next) => {
  console.error('[ERROR NO CONTROLADO]:', err.message || err);
  if (err.stack && process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // Respuesta segura según el tipo de cliente
  if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.path.startsWith('/api/')) {
    return res.status(500).json({
      error: 'Ha ocurrido un error inesperado al procesar su solicitud. Intente nuevamente más tarde.',
    });
  }

  res.status(500).render('500', {
    error: {
      message: 'Ha ocurrido un inconveniente al procesar su solicitud. El equipo técnico ha sido notificado.',
    },
    title: 'Error del Servidor - Consultorio Médico San Rafael',
    usuarioActual: req.session && req.session.usuario ? req.session.usuario : null,
    pathActual: req.path || '',
  });
});

module.exports = app;
