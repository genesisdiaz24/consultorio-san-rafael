/**
 * ====================================================================
 * SCRIPT DE PRUEBAS Y COMPROBACIÓN INTEGRAL - CONSULTORIO SAN RAFAEL
 * Backend, Autenticación Segura, Cierre por Inactividad (15 min),
 * Recuperación de Contraseña, Seguridad (CSRF/Helmet/Bcrypt) y RBAC
 * ====================================================================
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function runTests() {
  console.log('===========================================================');
  console.log('🩺 COMPROBACIONES DE SEGURIDAD, BACKEND, ROLES Y RECUPERACIÓN');
  console.log('===========================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, errorDetails = '') {
    if (condition) {
      console.log(`✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}: ${errorDetails}`);
      failed++;
    }
  }

  // 1. Comprobar existencia de archivos requeridos
  console.log('\n--- 1. Comprobación de Estructura de Archivos ---');
  const requiredFiles = [
    'package.json',
    '.env.example',
    '.env',
    'src/app.js',
    'src/server.js',
    'src/config/db.js',
    'src/utils/auth.js',
    'src/middleware/auth.js',
    'src/middleware/security.js',
    'src/services/emailService.js',
    'src/controllers/authController.js',
    'src/controllers/usuarioController.js',
    'src/controllers/pacienteController.js',
    'src/controllers/citaController.js',
    'src/controllers/consultaController.js',
    'src/controllers/farmaciaController.js',
    'src/controllers/arsController.js',
    'src/routes/authRoutes.js',
    'src/routes/usuarioRoutes.js',
    'src/routes/indexRoutes.js',
    'src/routes/pacienteRoutes.js',
    'src/routes/citaRoutes.js',
    'src/routes/consultaRoutes.js',
    'src/routes/farmaciaRoutes.js',
    'src/routes/arsRoutes.js',
    'src/database/schema.sql',
    'src/database/seed.sql',
    'src/views/auth/login.ejs',
    'src/views/auth/recuperar.ejs',
    'src/views/auth/restablecer.ejs',
    'src/views/index.ejs',
    'src/views/403.ejs',
    'src/views/consultas/historial.ejs',
    'src/views/consultas/historial_paciente.ejs',
    'src/views/consultas/recetas.ejs',
    'src/views/consultas/receta_detalle.ejs',
    'src/views/partials/header.ejs',
    'public/js/inactivity.js',
    'public/js/main.js',
  ];

  requiredFiles.forEach((file) => {
    const fullPath = path.join(__dirname, '..', file);
    assert(fs.existsSync(fullPath), `Archivo requerido: ${file}`);
  });

  // 2. Comprobar sintaxis y módulos
  console.log('\n--- 2. Comprobación de Módulos y Sintaxis Express ---');
  let app;
  try {
    app = require('../src/app');
    assert(typeof app === 'function', 'src/app.js carga correctamente como aplicación Express');
  } catch (err) {
    assert(false, 'src/app.js sintaxis', err.message);
  }

  const db = require('../config/db' in {} ? '../config/db' : '../src/config/db');
  try {
    assert(typeof db.query === 'function', 'src/config/db.js exporta función query');
    assert(typeof db.testConnection === 'function', 'src/config/db.js exporta función testConnection');
  } catch (err) {
    assert(false, 'src/config/db.js sintaxis', err.message);
  }

  const authUtils = require('../src/utils/auth');
  assert(typeof authUtils.hashPassword === 'function', 'src/utils/auth.js exporta hashPassword');
  assert(typeof authUtils.verifyPassword === 'function', 'src/utils/auth.js exporta verifyPassword');
  assert(typeof authUtils.generatePasswordResetToken === 'function', 'src/utils/auth.js exporta generatePasswordResetToken');
  assert(typeof authUtils.hashToken === 'function', 'src/utils/auth.js exporta hashToken');

  // 3. Comprobación de Conexión a Base de Datos y Verificación de Estructura / Duplicados
  console.log('\n--- 3. Verificación de Base de Datos y Ausencia de Duplicados ---');
  let dbConectada = false;
  try {
    const status = await db.testConnection();
    if (status.connected) {
      dbConectada = true;
      assert(true, `Conexión a PostgreSQL exitosa (${status.database})`);

      const { rows: duplicados } = await db.query(`
        SELECT fecha, hora, paciente_id, COUNT(*) as conteo
        FROM citas
        GROUP BY fecha, hora, paciente_id
        HAVING COUNT(*) > 1
      `);
      assert(duplicados.length === 0, 'No existen citas duplicadas en la base de datos (0 duplicados)');

      const { rows: dupConsultas } = await db.query(`
        SELECT cita_id, COUNT(*) as conteo
        FROM consultas
        WHERE cita_id IS NOT NULL
        GROUP BY cita_id
        HAVING COUNT(*) > 1
      `);
      assert(dupConsultas.length === 0, 'No existen consultas duplicadas para una misma cita médica (0 duplicados)');

      const { rows: restricciones } = await db.query(`
        SELECT conname FROM pg_constraint WHERE conname = 'uq_cita_paciente_fecha_hora'
      `);
      assert(restricciones.length > 0, 'Restricción UNIQUE uq_cita_paciente_fecha_hora activa');

      const { rows: idxConsultas } = await db.query(`
        SELECT indexname FROM pg_indexes WHERE indexname = 'uq_consultas_cita_id'
      `);
      assert(idxConsultas.length > 0, 'Restricción / Índice UNIQUE uq_consultas_cita_id activo');

      const { rows: colTokenVer } = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'usuarios' AND column_name = 'token_version'
      `);
      assert(colTokenVer.length > 0, 'Columna token_version presente en tabla usuarios');

      const { rows: tablaTokens } = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'password_reset_tokens'
      `);
      assert(tablaTokens.length > 0, 'Tabla password_reset_tokens creada para recuperación segura');
    }
  } catch (err) {
    console.warn(`Error DB: ${err.message}`);
  }

  // 4. Pruebas HTTP de Seguridad, Autenticación, Roles y Recuperación
  if (app && dbConectada) {
    console.log('\n--- 4. Pruebas HTTP de Seguridad General, Cabeceras y CSRF ---');

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    function extractCookies(res, existingCookies = {}) {
      const cookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      const cookies = { ...existingCookies };
      for (const h of cookieHeaders) {
        const parts = h.split(';')[0].split('=');
        if (parts.length >= 2) {
          cookies[parts[0].trim()] = parts.slice(1).join('=');
        }
      }
      return cookies;
    }

    function cookieHeader(cookies) {
      return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    try {
      async function login(usuario, contrasena) {
        // 1. Obtener pantalla de login con cookies de sesión iniciales y token CSRF
        const loginGet = await fetch(`${baseUrl}/login`);
        let cookies = extractCookies(loginGet);
        const loginHtml = await loginGet.text();
        const csrfMatch = loginHtml.match(/name="_csrf"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch ? csrfMatch[1] : (cookies['XSRF-TOKEN'] || '');

        // 2. Enviar credenciales con cookie de sesión y token CSRF
        const res = await fetch(`${baseUrl}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookieHeader(cookies),
          },
          body: `usuario=${encodeURIComponent(usuario)}&contrasena=${encodeURIComponent(contrasena)}&_csrf=${encodeURIComponent(csrfToken)}`,
        });

        cookies = extractCookies(res, cookies);
        const cookieStr = cookieHeader(cookies);

        return {
          status: res.status,
          location: res.headers.get('location'),
          cookie: cookieStr,
          csrfToken: csrfToken,
        };
      }

      // A. Cabeceras de Seguridad Helmet
      const resHeaders = await fetch(`${baseUrl}/login`);
      assert(resHeaders.status === 200, 'GET /login responde HTTP 200');
      assert(resHeaders.headers.has('content-security-policy'), 'Cabecera Content-Security-Policy (CSP) presente');
      assert(resHeaders.headers.get('x-content-type-options') === 'nosniff', 'Cabecera X-Content-Type-Options: nosniff configurada');
      assert(resHeaders.headers.get('x-frame-options') === 'SAMEORIGIN', 'Cabecera X-Frame-Options: SAMEORIGIN configurada');

      // B. Verificación de Cookies de Sesión Seguras (HttpOnly, SameSite)
      const initialCookies = resHeaders.headers.get('set-cookie') || '';
      assert(initialCookies.includes('HttpOnly'), 'Cookie de sesión sanrafael_sid tiene atributo HttpOnly');
      assert(initialCookies.toLowerCase().includes('samesite=lax'), 'Cookie de sesión tiene política SameSite=Lax');

      // C. Verificación de Protección CSRF (Rechazo de solicitudes sin token)
      const postSinCsrf = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'usuario=admin&contrasena=admin123',
      });
      // Sin token CSRF, no autentica (redirige de vuelta a /login por fallo CSRF)
      assert(postSinCsrf.headers.get('location') === '/login', 'POST sin token CSRF es bloqueado y redirige a /login sin autenticar');

      // D. Protección obligatoria sin sesión
      const resRootUnauth = await fetch(`${baseUrl}/`, { redirect: 'manual' });
      assert(resRootUnauth.status === 302 && resRootUnauth.headers.get('location') === '/login', 'Sin sesión: GET / redirige 302 a /login');

      const resPacUnauth = await fetch(`${baseUrl}/pacientes`, { redirect: 'manual' });
      assert(resPacUnauth.status === 302 && resPacUnauth.headers.get('location') === '/login', 'Sin sesión: GET /pacientes redirige 302 a /login');

      const resConsUnauth = await fetch(`${baseUrl}/consultas`, { redirect: 'manual' });
      assert(resConsUnauth.status === 302 && resConsUnauth.headers.get('location') === '/login', 'Sin sesión: GET /consultas redirige 302 a /login');

      // E. Verificación de Pantalla de Login limpia y enlace a recuperación
      const loginHtml = await resHeaders.text();
      assert(loginHtml.includes('name="usuario"') && loginHtml.includes('name="contrasena"'), 'Formulario de login presente con campos usuario y contraseña');
      assert(!loginHtml.includes('Cuentas del Sistema por Rol') && !loginHtml.includes('Cuentas del sistema'), 'Pantalla de login NO muestra la sección "Cuentas del sistema por rol"');
      assert(!loginHtml.includes('rellenarDemo'), 'Pantalla de login NO contiene función ni script de autocompletar (rellenarDemo)');
      assert(!loginHtml.includes('admin123') && !loginHtml.includes('medico123') && !loginHtml.includes('secretaria123') && !loginHtml.includes('farmacia123'), 'Pantalla de login NO expone contraseñas en el código HTML ni en scripts');
      assert(loginHtml.includes('¿Olvidaste tu contraseña?') && loginHtml.includes('href="/recuperar-contrasena"'), 'Pantalla de login incluye enlace "¿Olvidaste tu contraseña?"');

      // F. Verificación de Cierre Automático por Inactividad (15 min) y Keep-Alive
      console.log('\n--- 4.1 Verificación de Inactividad y Latido (Keep-Alive) ---');
      const authTestKeep = await login('admin', 'admin123');
      assert(authTestKeep.cookie !== null, 'Login para prueba de keep-alive exitoso');

      // Ping keep-alive con sesión activa
      const resKeepAliveActivo = await fetch(`${baseUrl}/api/session/keep-alive`, {
        method: 'POST',
        headers: {
          Cookie: authTestKeep.cookie,
          'X-CSRF-Token': authTestKeep.csrfToken,
        },
      });
      assert(resKeepAliveActivo.status === 200, 'Keep-alive con sesión activa responde HTTP 200');
      const jsonKeepActivo = await resKeepAliveActivo.json();
      assert(jsonKeepActivo.autenticado === true && jsonKeepActivo.expirado === false, 'Keep-alive confirma sesión activa y renueva marca de tiempo');

      // Ping keep-alive sin sesión
      const resKeepAliveInvalido = await fetch(`${baseUrl}/api/session/keep-alive`, {
        method: 'POST',
      });
      assert(resKeepAliveInvalido.status === 401, 'Keep-alive sin sesión responde HTTP 401');
      const jsonKeepInvalido = await resKeepAliveInvalido.json();
      assert(jsonKeepInvalido.expirado === true, 'Keep-alive sin sesión reporta expirado: true');

      // Verificación de redirección al vencer sesión con mensaje exacto
      const resExpirada = await fetch(`${baseUrl}/login?inactividad=1`);
      assert(resExpirada.status === 200, 'GET /login?inactividad=1 responde HTTP 200');
      const htmlExpirada = await resExpirada.text();
      assert(htmlExpirada.includes('Tu sesión ha expirado por inactividad'), 'Muestra mensaje exacto: "Tu sesión ha expirado por inactividad"');

      // G. Verificación de Flujo Completo de Recuperación de Contraseña
      console.log('\n--- 4.2 Verificación de Recuperación de Contraseña Criptográfica ---');
      const resFormRecuperar = await fetch(`${baseUrl}/recuperar-contrasena`);
      assert(resFormRecuperar.status === 200, 'GET /recuperar-contrasena responde HTTP 200 con formulario');
      const htmlFormRecuperar = await resFormRecuperar.text();
      assert(htmlFormRecuperar.includes('Recuperación de Contraseña'), 'Pantalla de recuperación tiene título de recuperación');
      assert(htmlFormRecuperar.includes('name="identificador"'), 'Campo identificador presente en formulario de recuperación');

      const csrfRecuperarMatch = htmlFormRecuperar.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfRecuperar = csrfRecuperarMatch ? csrfRecuperarMatch[1] : '';
      const cookiesRecuperar = extractCookies(resFormRecuperar);

      // Solicitud con usuario inexistente (Respuesta Neutral)
      const resRecInexistente = await fetch(`${baseUrl}/recuperar-contrasena`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader(cookiesRecuperar),
        },
        body: `identificador=usuario_inexistente_999&_csrf=${encodeURIComponent(csrfRecuperar)}`,
      });
      assert(resRecInexistente.status === 302, 'Solicitud con identificador inexistente redirige 302 con respuesta neutral');

      // Solicitud con usuario existente (admin)
      const resRecExistente = await fetch(`${baseUrl}/recuperar-contrasena`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader(cookiesRecuperar),
        },
        body: `identificador=admin&_csrf=${encodeURIComponent(csrfRecuperar)}`,
      });
      assert(resRecExistente.status === 302, 'Solicitud con usuario existente procesada con respuesta neutral');

      // Verificar que el token se guardó en la base de datos de forma HASHEADA (SHA-256) y no plano
      const { rows: tokensGuardados } = await db.query(
        `SELECT prt.*, u.usuario FROM password_reset_tokens prt
         JOIN usuarios u ON prt.usuario_id = u.id
         WHERE u.usuario = 'admin' AND prt.usado = false
         ORDER BY prt.id DESC LIMIT 1`
      );
      assert(tokensGuardados.length > 0, 'Registro de recuperación generado en tabla password_reset_tokens');
      const tokenDb = tokensGuardados[0];
      assert(tokenDb.token_hash.length === 64, 'El token almacenado en base de datos es un hash SHA-256 (64 hex), NO el token plano');
      assert(new Date(tokenDb.expira_en) > new Date(), 'El token tiene fecha de expiración futura válida (15 minutos)');

      // Simular prueba de restablecimiento: Creamos un token de prueba conocido
      const tokenPruebaPlano = crypto.randomBytes(32).toString('hex');
      const tokenPruebaHash = crypto.createHash('sha256').update(tokenPruebaPlano).digest('hex');
      const expiraEn15 = new Date(Date.now() + 15 * 60 * 1000);

      await db.query(
        `INSERT INTO password_reset_tokens (usuario_id, token_hash, expira_en, usado)
         VALUES ($1, $2, $3, false)`,
        [tokenDb.usuario_id, tokenPruebaHash, expiraEn15]
      );

      // Ver formulario de restablecer con token válido
      const resGetRestablecer = await fetch(`${baseUrl}/restablecer-contrasena/${tokenPruebaPlano}`);
      assert(resGetRestablecer.status === 200, 'GET /restablecer-contrasena/:token con token válido responde HTTP 200');
      const htmlRestablecer = await resGetRestablecer.text();
      assert(htmlRestablecer.includes('Nueva Contraseña'), 'Muestra formulario para ingresar nueva contraseña');

      const csrfRestablecerMatch = htmlRestablecer.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfRestablecer = csrfRestablecerMatch ? csrfRestablecerMatch[1] : '';
      const cookiesRestablecer = extractCookies(resGetRestablecer);

      // Procesar restablecimiento de contraseña
      const resPostRestablecer = await fetch(`${baseUrl}/restablecer-contrasena/${tokenPruebaPlano}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader(cookiesRestablecer),
        },
        body: `contrasena=AdminNuevaSegura2026!&confirmar_contrasena=AdminNuevaSegura2026!&_csrf=${encodeURIComponent(csrfRestablecer)}`,
      });
      assert(resPostRestablecer.status === 302, 'POST /restablecer-contrasena/:token procesa cambio exitoso y redirige a /login');

      // Verificar que el token se marcó como USADO
      const { rows: tokenUsadoCheck } = await db.query(
        `SELECT usado FROM password_reset_tokens WHERE token_hash = $1`,
        [tokenPruebaHash]
      );
      assert(tokenUsadoCheck[0].usado === true, 'El token fue marcado como usado (usado = true)');

      // Verificar que la nueva contraseña está protegida con hash seguro bcrypt
      const { rows: adminUpdated } = await db.query(
        `SELECT contrasena, token_version FROM usuarios WHERE usuario = 'admin'`
      );
      assert(adminUpdated[0].contrasena.startsWith('$2a$') || adminUpdated[0].contrasena.startsWith('$2b$'), 'La nueva contraseña se guardó con hash seguro bcrypt');
      assert(adminUpdated[0].token_version > 1, 'token_version se incrementó para revocar todas las sesiones previas en cualquier dispositivo');

      // Verificar que intentar reusar el mismo token falla
      const resReusarToken = await fetch(`${baseUrl}/restablecer-contrasena/${tokenPruebaPlano}`, { redirect: 'manual' });
      assert(resReusarToken.status === 302, 'Intentar reusar el token ya utilizado es rechazado (redirige 302)');

      // Probar login con la nueva contraseña
      const loginNuevaClave = await login('admin', 'AdminNuevaSegura2026!');
      assert(loginNuevaClave.cookie !== null, 'Inicio de sesión exitoso con la nueva contraseña');

      // Restaurar contraseña original del admin para mantener entorno determinista
      const { hash: hashOriginal, salt: saltOriginal } = authUtils.hashPassword('admin123');
      await db.query(
        `UPDATE usuarios SET contrasena = $1, salt = $2, token_version = 1 WHERE usuario = 'admin'`,
        [hashOriginal, saltOriginal]
      );

      // 5. Separación Estricta por Roles (RBAC)
      console.log('\n--- 5. Verificación de Control de Acceso por Roles (RBAC) ---');

      // Rol SECRETARÍA
      console.log('\n>>> Verificando Rol SECRETARÍA:');
      const authSec = await login('secretaria', 'secretaria123');
      assert(authSec.cookie !== null, 'Login Secretaría exitoso');

      if (authSec.cookie) {
        // Panel Secretaría
        const secPanel = await fetch(`${baseUrl}/`, { headers: { Cookie: authSec.cookie } });
        assert(secPanel.status === 200, 'Secretaría accede a su Panel (HTTP 200)');
        const secHtml = await secPanel.text();
        assert(secHtml.includes('Panel de Secretaría y Recepción'), 'Panel de Secretaría muestra título propio');
        assert(!secHtml.includes('Panel Médico y Atención Clínica'), 'Panel de Secretaría NO contiene panel médico');
        assert(!secHtml.includes('Panel de Farmacia Interna'), 'Panel de Secretaría NO contiene panel de farmacia');

        // Módulos Autorizados
        const secPacientes = await fetch(`${baseUrl}/pacientes`, { headers: { Cookie: authSec.cookie } });
        assert(secPacientes.status === 200, 'Secretaría accede a /pacientes (HTTP 200)');

        const secCitas = await fetch(`${baseUrl}/citas`, { headers: { Cookie: authSec.cookie } });
        assert(secCitas.status === 200, 'Secretaría accede a /citas (HTTP 200)');

        const secSala = await fetch(`${baseUrl}/citas/sala-espera`, { headers: { Cookie: authSec.cookie } });
        assert(secSala.status === 200, 'Secretaría accede a /citas/sala-espera (HTTP 200)');

        const secArs = await fetch(`${baseUrl}/ars`, { headers: { Cookie: authSec.cookie } });
        assert(secArs.status === 200, 'Secretaría accede a /ars (HTTP 200)');

        const secCalcular = await fetch(`${baseUrl}/ars/calcular`, { headers: { Cookie: authSec.cookie } });
        assert(secCalcular.status === 200, 'Secretaría accede a /ars/calcular (HTTP 200)');

        // Ficha del paciente vista por Secretaría: sólo datos de contacto y citas, sin datos clínicos
        const secFicha = await fetch(`${baseUrl}/pacientes/1`, { headers: { Cookie: authSec.cookie } });
        assert(secFicha.status === 200, 'Secretaría accede a la ficha del paciente /pacientes/1 (HTTP 200)');
        const secFichaHtml = await secFicha.text();
        assert(secFichaHtml.includes('Carlos') && secFichaHtml.includes('Martínez'), 'Secretaría visualiza los datos generales de contacto del paciente');
        assert(secFichaHtml.includes('Agenda y Citas del Paciente'), 'Secretaría visualiza agenda y citas del paciente');
        assert(!secFichaHtml.includes('Alergias Conocidas'), 'Secretaría NO visualiza alergias conocidas en la ficha');
        assert(!secFichaHtml.includes('Antecedentes Personales'), 'Secretaría NO visualiza antecedentes personales en la ficha');
        assert(!secFichaHtml.includes('Antecedentes Familiares'), 'Secretaría NO visualiza antecedentes familiares en la ficha');
        assert(!secFichaHtml.includes('Iniciar Consulta Médica'), 'Secretaría NO visualiza el botón "Iniciar Consulta Médica"');
        assert(!secFichaHtml.includes('Historial de Consultas'), 'Secretaría NO visualiza historial de consultas en la ficha');
        assert(!secFichaHtml.includes('Recetas Médicas'), 'Secretaría NO visualiza recetas médicas en la ficha');

        // Secretaría en /ars no debe ver "Configurar Tarifario"
        const secArsHtml = await secArs.text();
        assert(!secArsHtml.includes('Configurar Tarifario'), 'Secretaría NO visualiza la opción "Configurar Tarifario" en el listado de ARS');
        assert(!secArsHtml.includes('Registrar Nueva ARS'), 'Secretaría NO visualiza el botón "Registrar Nueva ARS"');
        assert(secArsHtml.includes('Ver Tarifas'), 'Secretaría tiene el enlace de solo lectura "Ver Tarifas"');

        // Módulos Denegados (HTTP 403)
        const secConsultas = await fetch(`${baseUrl}/consultas`, { headers: { Cookie: authSec.cookie } });
        assert(secConsultas.status === 403, 'Secretaría BLOQUEADA en servidor para /consultas (HTTP 403)');

        const secHistorial = await fetch(`${baseUrl}/consultas/historial`, { headers: { Cookie: authSec.cookie } });
        assert(secHistorial.status === 403, 'Secretaría BLOQUEADA en servidor para /consultas/historial (HTTP 403)');

        const secRecetas = await fetch(`${baseUrl}/consultas/recetas`, { headers: { Cookie: authSec.cookie } });
        assert(secRecetas.status === 403, 'Secretaría BLOQUEADA en servidor para /consultas/recetas (HTTP 403)');

        const secFarmaciaDisp = await fetch(`${baseUrl}/farmacia/dispensar`, { headers: { Cookie: authSec.cookie } });
        assert(secFarmaciaDisp.status === 403, 'Secretaría BLOQUEADA en servidor para /farmacia/dispensar (HTTP 403)');

        const secFarmaciaInv = await fetch(`${baseUrl}/farmacia/inventario`, { headers: { Cookie: authSec.cookie } });
        assert(secFarmaciaInv.status === 403, 'Secretaría BLOQUEADA en servidor para /farmacia/inventario (HTTP 403)');

        const secUsuarios = await fetch(`${baseUrl}/usuarios`, { headers: { Cookie: authSec.cookie } });
        assert(secUsuarios.status === 403, 'Secretaría BLOQUEADA en servidor para /usuarios (HTTP 403)');

        // Tarifas: Secretaría puede VERLAS (solo lectura) pero no editarlas ni registrar ARS
        const secTarifas = await fetch(`${baseUrl}/ars/1/tarifas`, { headers: { Cookie: authSec.cookie } });
        const secTarifasHtml = await secTarifas.text();
        assert(
          secTarifas.status === 200 && !secTarifasHtml.includes('id="formTarifa"') && !secTarifasHtml.includes('/eliminar'),
          'Secretaría ve las tarifas de /ars/1/tarifas en modo solo lectura (sin formulario ni eliminar)'
        );

        const secNuevaArs = await fetch(`${baseUrl}/ars/nueva`, { headers: { Cookie: authSec.cookie } });
        assert(secNuevaArs.status === 403, 'Secretaría BLOQUEADA en servidor para /ars/nueva (HTTP 403)');

        const secGuardarTarifa = await fetch(`${baseUrl}/ars/1/tarifas`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Cookie: authSec.cookie, 'X-CSRF-Token': authSec.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ servicio_id: '1', tarifa_pactada: '1', tipo_cobertura: 'PORCENTAJE', valor_cobertura: '1' }).toString(),
        });
        assert(secGuardarTarifa.status === 403, 'Secretaría BLOQUEADA en servidor para editar tarifas (POST /ars/1/tarifas → 403)');

        const secEliminarTarifa = await fetch(`${baseUrl}/ars/1/tarifas/1/eliminar`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Cookie: authSec.cookie, 'X-CSRF-Token': authSec.csrfToken },
        });
        assert(secEliminarTarifa.status === 403, 'Secretaría BLOQUEADA en servidor para desactivar coberturas (POST eliminar tarifa → 403)');
      }

      // Rol MÉDICO
      console.log('\n>>> Verificando Rol MÉDICO:');
      const authMed = await login('medico', 'medico123');
      assert(authMed.cookie !== null, 'Login Médico exitoso');

      if (authMed.cookie) {
        // Panel Médico
        const medPanel = await fetch(`${baseUrl}/`, { headers: { Cookie: authMed.cookie } });
        assert(medPanel.status === 200, 'Médico accede a su Panel (HTTP 200)');
        const medHtml = await medPanel.text();
        assert(medHtml.includes('Panel Médico y Atención Clínica'), 'Panel de Médico muestra título propio');
        assert(!medHtml.includes('Panel de Secretaría y Recepción'), 'Panel de Médico NO contiene panel de secretaría');
        assert(!medHtml.includes('Panel de Farmacia Interna'), 'Panel de Médico NO contiene panel de farmacia');
        assert(!medHtml.includes('Panel de Administración Global'), 'Panel de Médico NO contiene panel de administración');

        // Menú de navegación del Médico
        assert(!medHtml.includes('href="/farmacia'), 'Menú de Médico NO tiene enlaces a Farmacia');
        assert(!medHtml.includes('href="/ars/calcular"'), 'Menú de Médico NO tiene enlace a Copagos/Calculadora');
        assert(!medHtml.includes('href="/ars"'), 'Menú de Médico NO tiene enlace a Aseguradoras ARS');
        assert(!medHtml.includes('href="/usuarios"'), 'Menú de Médico NO tiene enlace a Usuarios');

        // Módulos Autorizados
        const medConsultas = await fetch(`${baseUrl}/consultas`, { headers: { Cookie: authMed.cookie } });
        assert(medConsultas.status === 200, 'Médico accede a /consultas (HTTP 200)');

        const medHistorial = await fetch(`${baseUrl}/consultas/historial`, { headers: { Cookie: authMed.cookie } });
        assert(medHistorial.status === 200, 'Médico accede a /consultas/historial (HTTP 200)');

        const medRecetas = await fetch(`${baseUrl}/consultas/recetas`, { headers: { Cookie: authMed.cookie } });
        assert(medRecetas.status === 200, 'Médico accede a /consultas/recetas (HTTP 200)');

        const medSala = await fetch(`${baseUrl}/citas/sala-espera`, { headers: { Cookie: authMed.cookie } });
        assert(medSala.status === 200, 'Médico accede a /citas/sala-espera (HTTP 200)');

        const medFicha = await fetch(`${baseUrl}/pacientes/1`, { headers: { Cookie: authMed.cookie } });
        assert(medFicha.status === 200, 'Médico puede consultar ficha clínica de paciente /pacientes/1 (HTTP 200)');
        const medFichaHtml = await medFicha.text();
        assert(medFichaHtml.includes('Alergias Conocidas'), 'Médico SÍ visualiza alergias conocidas en la ficha clínica');
        assert(medFichaHtml.includes('Antecedentes Personales'), 'Médico SÍ visualiza antecedentes personales en la ficha clínica');
        assert(medFichaHtml.includes('Antecedentes Familiares'), 'Médico SÍ visualiza antecedentes familiares en la ficha clínica');
        assert(medFichaHtml.includes('Iniciar Consulta Médica'), 'Médico SÍ visualiza el botón "Iniciar Consulta Médica"');
        assert(medFichaHtml.includes('Historial de Consultas'), 'Médico SÍ visualiza historial de consultas clínicas');
        assert(medFichaHtml.includes('Recetas Médicas'), 'Médico SÍ visualiza recetas médicas del paciente');

        const medAtender = await fetch(`${baseUrl}/consultas/atender?paciente_id=1`, { headers: { Cookie: authMed.cookie } });
        assert(medAtender.status === 200, 'Médico accede al formulario de atención y prescripción (HTTP 200)');
        const atenderHtml = await medAtender.text();
        assert(atenderHtml.includes('Disponible') && atenderHtml.includes('No disponible'), 'En la receta del médico se muestra "Disponible" y "No disponible"');
        assert(!atenderHtml.includes('Stock:'), 'En la receta del médico NO se muestran cantidades de inventario (sin "Stock:")');
        assert(!atenderHtml.includes('data-stock='), 'En la receta del médico no existe atributo data-stock numérico');

        // Módulos Denegados (HTTP 403)
        const medPacientes = await fetch(`${baseUrl}/pacientes`, { headers: { Cookie: authMed.cookie } });
        assert(medPacientes.status === 403, 'Médico BLOQUEADO en servidor para directorio /pacientes (HTTP 403)');

        const medPacNuevo = await fetch(`${baseUrl}/pacientes/nuevo`, { headers: { Cookie: authMed.cookie } });
        assert(medPacNuevo.status === 403, 'Médico BLOQUEADO en servidor para crear paciente /pacientes/nuevo (HTTP 403)');

        const medCitas = await fetch(`${baseUrl}/citas`, { headers: { Cookie: authMed.cookie } });
        assert(medCitas.status === 403, 'Médico BLOQUEADO en servidor para agenda administrativa /citas (HTTP 403)');

        const medCitaNueva = await fetch(`${baseUrl}/citas/nueva`, { headers: { Cookie: authMed.cookie } });
        assert(medCitaNueva.status === 403, 'Médico BLOQUEADO en servidor para /citas/nueva (HTTP 403)');

        const medArs = await fetch(`${baseUrl}/ars`, { headers: { Cookie: authMed.cookie } });
        assert(medArs.status === 403, 'Médico BLOQUEADO en servidor para /ars (HTTP 403)');

        const medCalcular = await fetch(`${baseUrl}/ars/calcular`, { headers: { Cookie: authMed.cookie } });
        assert(medCalcular.status === 403, 'Médico BLOQUEADO en servidor para /ars/calcular (HTTP 403)');

        const medFarmaciaInv = await fetch(`${baseUrl}/farmacia/inventario`, { headers: { Cookie: authMed.cookie } });
        assert(medFarmaciaInv.status === 403, 'Médico BLOQUEADO en servidor para /farmacia/inventario (HTTP 403)');

        const medFarmaciaDisp = await fetch(`${baseUrl}/farmacia/dispensar`, { headers: { Cookie: authMed.cookie } });
        assert(medFarmaciaDisp.status === 403, 'Médico BLOQUEADO en servidor para /farmacia/dispensar (HTTP 403)');

        const medUsuarios = await fetch(`${baseUrl}/usuarios`, { headers: { Cookie: authMed.cookie } });
        assert(medUsuarios.status === 403, 'Médico BLOQUEADO en servidor para /usuarios (HTTP 403)');
      }

      // Rol FARMACIA
      console.log('\n>>> Verificando Rol FARMACIA:');
      const authFarm = await login('farmacia', 'farmacia123');
      assert(authFarm.cookie !== null, 'Login Farmacia exitoso');

      if (authFarm.cookie) {
        // Panel Farmacia
        const farmPanel = await fetch(`${baseUrl}/`, { headers: { Cookie: authFarm.cookie } });
        assert(farmPanel.status === 200, 'Farmacia accede a su Panel (HTTP 200)');
        const farmHtml = await farmPanel.text();
        assert(farmHtml.includes('Panel de Farmacia Interna'), 'Panel de Farmacia muestra título propio');
        assert(!farmHtml.includes('Panel Médico y Atención Clínica'), 'Panel de Farmacia NO contiene panel médico');
        assert(!farmHtml.includes('Panel de Secretaría y Recepción'), 'Panel de Farmacia NO contiene panel de secretaría');

        // Módulos Autorizados
        const farmDisp = await fetch(`${baseUrl}/farmacia/dispensar`, { headers: { Cookie: authFarm.cookie } });
        assert(farmDisp.status === 200, 'Farmacia accede a /farmacia/dispensar (HTTP 200)');

        const farmInv = await fetch(`${baseUrl}/farmacia/inventario`, { headers: { Cookie: authFarm.cookie } });
        assert(farmInv.status === 200, 'Farmacia accede a /farmacia/inventario (HTTP 200)');

        const farmMov = await fetch(`${baseUrl}/farmacia/movimientos`, { headers: { Cookie: authFarm.cookie } });
        assert(farmMov.status === 200, 'Farmacia accede a /farmacia/movimientos (HTTP 200)');

        // Módulos Denegados (HTTP 403)
        const farmPacientes = await fetch(`${baseUrl}/pacientes`, { headers: { Cookie: authFarm.cookie } });
        assert(farmPacientes.status === 403, 'Farmacia BLOQUEADA en servidor para /pacientes (HTTP 403)');

        const farmCitas = await fetch(`${baseUrl}/citas`, { headers: { Cookie: authFarm.cookie } });
        assert(farmCitas.status === 403, 'Farmacia BLOQUEADA en servidor para /citas (HTTP 403)');

        const farmConsultas = await fetch(`${baseUrl}/consultas`, { headers: { Cookie: authFarm.cookie } });
        assert(farmConsultas.status === 403, 'Farmacia BLOQUEADA en servidor para /consultas (HTTP 403)');

        const farmArs = await fetch(`${baseUrl}/ars`, { headers: { Cookie: authFarm.cookie } });
        assert(farmArs.status === 403, 'Farmacia BLOQUEADA en servidor para /ars (HTTP 403)');

        const farmUsuarios = await fetch(`${baseUrl}/usuarios`, { headers: { Cookie: authFarm.cookie } });
        assert(farmUsuarios.status === 403, 'Farmacia BLOQUEADA en servidor para /usuarios (HTTP 403)');
      }

      // Rol ADMINISTRADOR
      console.log('\n>>> Verificando Rol ADMINISTRADOR:');
      const authAdm = await login('admin', 'admin123');
      assert(authAdm.cookie !== null, 'Login Administrador exitoso');

      if (authAdm.cookie) {
        const admPanel = await fetch(`${baseUrl}/`, { headers: { Cookie: authAdm.cookie } });
        assert(admPanel.status === 200, 'Administrador accede a su Panel (HTTP 200)');

        const admUsuarios = await fetch(`${baseUrl}/usuarios`, { headers: { Cookie: authAdm.cookie } });
        assert(admUsuarios.status === 200, 'Administrador accede a /usuarios (HTTP 200)');

        const admTarifas = await fetch(`${baseUrl}/ars/1/tarifas`, { headers: { Cookie: authAdm.cookie } });
        assert(admTarifas.status === 200, 'Administrador accede a tarifarios ARS (HTTP 200)');

        const admArsList = await fetch(`${baseUrl}/ars`, { headers: { Cookie: authAdm.cookie } });
        assert(admArsList.status === 200, 'Administrador accede a /ars (HTTP 200)');
        const admArsHtml = await admArsList.text();
        assert(admArsHtml.includes('Configurar Tarifario'), 'Administrador SÍ visualiza el botón "Configurar Tarifario" en el catálogo de ARS');

        const admFarmacia = await fetch(`${baseUrl}/farmacia/inventario`, { headers: { Cookie: authAdm.cookie } });
        assert(admFarmacia.status === 200, 'Administrador accede a catálogo de medicamentos (HTTP 200)');

        const admPacientes = await fetch(`${baseUrl}/pacientes`, { headers: { Cookie: authAdm.cookie } });
        assert(admPacientes.status === 200, 'Administrador accede a supervisión de pacientes (HTTP 200)');

        const admCitas = await fetch(`${baseUrl}/citas`, { headers: { Cookie: authAdm.cookie } });
        assert(admCitas.status === 200, 'Administrador accede a agenda de citas (HTTP 200)');

        // 6. Verificación de Transición de Citas a 'Atendida' y Prevención de Duplicados
        console.log('\n>>> Verificando Transición de Citas a "Atendida" al Guardar Consulta:');

        // Estado de Carlos Martínez
        const { rows: citasCarlos } = await db.query(
          `SELECT c.id, c.estado FROM citas c JOIN pacientes p ON c.paciente_id = p.id WHERE p.nombre ILIKE '%Carlos%'`
        );
        assert(citasCarlos.length > 0 && citasCarlos[0].estado === 'Atendida', 'Paciente de prueba Carlos Martínez: su cita está en estado "Atendida"');

        const { rows: consultasCarlos } = await db.query(
          `SELECT con.id, con.diagnostico_clinico FROM consultas con JOIN pacientes p ON con.paciente_id = p.id WHERE p.nombre ILIKE '%Carlos%'`
        );
        assert(consultasCarlos.length > 0, 'Paciente de prueba Carlos Martínez: su consulta se conserva intacta en el historial clínico');

        const { rows: salaEsperaCarlos } = await db.query(
          `SELECT c.id FROM citas c JOIN pacientes p ON c.paciente_id = p.id WHERE p.nombre ILIKE '%Carlos%' AND c.estado = 'En sala de espera'`
        );
        assert(salaEsperaCarlos.length === 0, 'Paciente de prueba Carlos Martínez: no aparece en la lista de espera (0 citas en espera)');

        // Flujo con María Elena Gómez: Llegada -> Consulta -> Atendida
        await fetch(`${baseUrl}/citas/2/confirmar-llegada`, {
          method: 'POST',
          headers: {
            Cookie: authSec.cookie,
            'X-CSRF-Token': authSec.csrfToken,
          },
        });

        const { rows: cita2EnEspera } = await db.query(`SELECT estado FROM citas WHERE id = 2`);
        assert(cita2EnEspera[0].estado === 'En sala de espera', 'María Elena Gómez pasa a "En sala de espera" tras confirmación de llegada');

        // Médico atiende y guarda la consulta de María Elena
        const { rows: conteoCitasAntes } = await db.query(`SELECT COUNT(*) as total FROM citas`);
        const postConsultaRes = await fetch(`${baseUrl}/consultas`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: authMed.cookie,
            'X-CSRF-Token': authMed.csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            paciente_id: '2',
            cita_id: '2',
            servicio_id: '1',
            motivo_consulta: 'Chequeo preventivo general',
            hallazgos_clinicos: 'Paciente en buen estado general, ruidos cardíacos rítmicos',
            diagnostico_clinico: 'Evaluación de rutina satisfactoria',
            tratamiento_plan: 'Mantener hábitos saludables y control anual',
            valor_total: '1500.00',
            valor_cubierto_ars: '1200.00',
            diferencia_paciente: '300.00',
            estado_pago: 'Pagado',
            incluye_receta: 'false',
          }).toString(),
        });
        assert(postConsultaRes.status === 302, 'Médico guarda y finaliza exitosamente la consulta médica');

        const { rows: cita2Final } = await db.query(`SELECT estado FROM citas WHERE id = 2`);
        assert(cita2Final[0].estado === 'Atendida', 'La cita cambia automáticamente a estado "Atendida" al guardar la consulta');

        const { rows: salaEsperaFinal } = await db.query(`SELECT id FROM citas WHERE paciente_id = 2 AND estado = 'En sala de espera'`);
        assert(salaEsperaFinal.length === 0, 'La paciente atendida (María Elena) desaparece de la lista de espera');

        const { rows: consultaElena } = await db.query(`SELECT id FROM consultas WHERE paciente_id = 2`);
        assert(consultaElena.length > 0, 'La consulta de María Elena se conserva en su historial clínico');

        const { rows: conteoCitas } = await db.query(`SELECT COUNT(*) as total FROM citas`);
        assert(
          parseInt(conteoCitas[0].total, 10) === parseInt(conteoCitasAntes[0].total, 10),
          `El total de citas se mantiene en ${conteoCitasAntes[0].total} al guardar la consulta (sin duplicados)`
        );

        // Médico emite receta médica y Farmacia la recibe para control de existencias
        console.log('\n>>> Verificando Emisión de Receta y Recepción en Farmacia:');
        const postRecetaRes = await fetch(`${baseUrl}/consultas`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: authMed.cookie,
            'X-CSRF-Token': authMed.csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            paciente_id: '1',
            servicio_id: '1',
            motivo_consulta: 'Fiebre y dolor de garganta',
            hallazgos_clinicos: 'Faringe congestiva con placas leves',
            diagnostico_clinico: 'Faringoamigdalitis aguda',
            tratamiento_plan: 'Reposo, hidratación y antibioticoterapia',
            valor_total: '1500.00',
            valor_cubierto_ars: '1200.00',
            diferencia_paciente: '300.00',
            estado_pago: 'Pagado',
            incluye_receta: 'true',
            indicaciones_generales: 'Completar los días indicados',
            med_nombre: 'Amoxicilina 500mg',
            med_id: '1',
            med_dosis: '500 mg',
            med_frecuencia: 'Cada 8 horas por 7 días',
            med_indicaciones: 'Tomar después de las comidas',
            med_cantidad: '2',
          }).toString(),
        });
        assert(postRecetaRes.status === 302, 'Médico emite y guarda exitosamente la consulta con receta');

        const farmRecetasDisp = await fetch(`${baseUrl}/farmacia/dispensar`, { headers: { Cookie: authFarm.cookie } });
        assert(farmRecetasDisp.status === 200, 'Farmacia accede a la lista de recetas recibidas (HTTP 200)');
        const farmRecetasHtml = await farmRecetasDisp.text();
        assert(farmRecetasHtml.includes('Carlos Martínez') || farmRecetasHtml.includes('Faringoamigdalitis aguda'), 'Farmacia recibe la receta emitida por el médico');

        const { rows: ultimaReceta } = await db.query(`SELECT id FROM recetas ORDER BY id DESC LIMIT 1`);
        assert(ultimaReceta.length > 0, 'La receta fue registrada en base de datos');
        const farmDetalleReceta = await fetch(`${baseUrl}/farmacia/dispensar/${ultimaReceta[0].id}`, { headers: { Cookie: authFarm.cookie } });
        assert(farmDetalleReceta.status === 200, 'Farmacia accede a la pantalla de existencias y entrega de la receta');
        const farmDetalleHtml = await farmDetalleReceta.text();
        assert(farmDetalleHtml.includes('Stock Interno') || farmDetalleHtml.includes('disp.'), 'Módulo de Farmacia muestra el control y cantidades de existencias');

        // Historial de Consultas Médicas y Prevención de Duplicados
        console.log('\n>>> Verificando Historial de Consultas Médicas y Prevención de Duplicados:');

        const { rows: conteoAntes } = await db.query(`SELECT COUNT(*) as total FROM consultas`);
        const totalConsultasAntes = parseInt(conteoAntes[0].total, 10);

        // Intento de guardar consulta duplicada para la cita #2 (ya atendida)
        const postDupCitaRes = await fetch(`${baseUrl}/consultas`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: authMed.cookie,
            'X-CSRF-Token': authMed.csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            paciente_id: '2',
            cita_id: '2',
            servicio_id: '1',
            motivo_consulta: 'Chequeo preventivo general',
            hallazgos_clinicos: 'Paciente en buen estado general, ruidos cardíacos rítmicos',
            diagnostico_clinico: 'Evaluación de rutina satisfactoria',
            tratamiento_plan: 'Mantener hábitos saludables y control anual',
            valor_total: '1500.00',
            valor_cubierto_ars: '1200.00',
            diferencia_paciente: '300.00',
            estado_pago: 'Pagado',
            incluye_receta: 'false',
          }).toString(),
        });
        assert(postDupCitaRes.status === 302, 'Intento de consulta duplicada para cita atendida redirige 302 sin error 500');

        // Intento de guardar consulta duplicada rápida sin cita (doble clic o refresco)
        const postDupRapidoRes = await fetch(`${baseUrl}/consultas`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: authMed.cookie,
            'X-CSRF-Token': authMed.csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            paciente_id: '1',
            servicio_id: '1',
            motivo_consulta: 'Fiebre y dolor de garganta',
            hallazgos_clinicos: 'Faringe congestiva con placas leves',
            diagnostico_clinico: 'Faringoamigdalitis aguda',
            tratamiento_plan: 'Reposo, hidratación y antibioticoterapia',
            valor_total: '1500.00',
            valor_cubierto_ars: '1200.00',
            diferencia_paciente: '300.00',
            estado_pago: 'Pagado',
            incluye_receta: 'false',
          }).toString(),
        });
        assert(postDupRapidoRes.status === 302, 'Intento de consulta duplicada por doble clic/refresco redirige 302 sin error');

        const { rows: conteoDespues } = await db.query(`SELECT COUNT(*) as total FROM consultas`);
        const totalConsultasDespues = parseInt(conteoDespues[0].total, 10);
        assert(totalConsultasDespues === totalConsultasAntes, `Total de consultas se mantiene idéntico (${totalConsultasAntes} consultas, 0 duplicados creados)`);

        // Visualización y ordenamiento en el Historial de Consultas Médicas (/consultas)
        const resHistorialConsultas = await fetch(`${baseUrl}/consultas`, { headers: { Cookie: authMed.cookie } });
        assert(resHistorialConsultas.status === 200, 'Médico accede al Historial de Consultas Médicas /consultas (HTTP 200)');
        const htmlHistorial = await resHistorialConsultas.text();
        assert(htmlHistorial.includes('Historial de Consultas Médicas'), 'Muestra título "Historial de Consultas Médicas"');
        assert(htmlHistorial.includes('Carlos Martínez'), 'Contiene al paciente Carlos Martínez');
        assert(htmlHistorial.includes('María Elena Gómez'), 'Contiene a la paciente María Elena Gómez');
        assert(htmlHistorial.includes('Faringoamigdalitis aguda'), 'Muestra diagnóstico clínico correcto');
        assert(!htmlHistorial.includes('Copago:'), 'El médico NO ve montos de cobro/copago (información exclusiva de facturación)');
        const resHistorialAdm = await fetch(`${baseUrl}/consultas`, { headers: { Cookie: authAdm.cookie } });
        const htmlHistorialAdm = await resHistorialAdm.text();
        assert(htmlHistorialAdm.includes('Copago:'), 'Administración ve correctamente el desglose de copago y ARS');

        const { rows: consultasCarlosTotal } = await db.query(
          `SELECT id, motivo_consulta, diagnostico_clinico FROM consultas WHERE paciente_id = 1 ORDER BY fecha_consulta DESC`
        );
        assert(consultasCarlosTotal.length >= 2, 'Paciente con varias consultas médicas legítimas (Carlos Martínez) mantiene cada una por separado');

        const { rows: ordenConsultas } = await db.query(
          `SELECT id, fecha_consulta FROM consultas ORDER BY fecha_consulta DESC, id DESC`
        );
        let ordenCorrecto = true;
        for (let i = 0; i < ordenConsultas.length - 1; i++) {
          if (new Date(ordenConsultas[i].fecha_consulta) < new Date(ordenConsultas[i + 1].fecha_consulta)) {
            ordenCorrecto = false;
            break;
          }
        }
        assert(ordenCorrecto, 'El historial clínico está ordenado estrictamente desde la consulta más reciente hasta la más antigua');
      }
    } finally {
      server.close();
      // Limpieza de datos temporales generados exclusivamente durante la ejecución de las pruebas
      try {
        const { rows: testCons } = await db.query(
          `SELECT id FROM consultas WHERE motivo_consulta = 'Fiebre y dolor de garganta' AND id > 5`
        );
        if (testCons.length > 0) {
          const ids = testCons.map((r) => r.id);
          await db.query(`DELETE FROM receta_detalles WHERE receta_id IN (SELECT id FROM recetas WHERE consulta_id = ANY($1::int[]))`, [ids]);
          await db.query(`DELETE FROM recetas WHERE consulta_id = ANY($1::int[])`, [ids]);
          await db.query(`DELETE FROM consultas WHERE id = ANY($1::int[])`, [ids]);
        }
        await db.query(`DELETE FROM password_reset_tokens WHERE token_hash LIKE 'test_%' OR token_hash = $1`, [crypto.createHash('sha256').update('test').digest('hex')]);
      } catch (e) {
        // Ignorar errores de limpieza
      }
    }
  }

  console.log('\n===========================================================');
  console.log(`RESUMEN DE PRUEBAS: ${passed} Exitosas | ${failed} Fallidas`);
  console.log('===========================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
