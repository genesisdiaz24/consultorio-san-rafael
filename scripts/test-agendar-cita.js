const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const { normalizarFecha } = require('../src/controllers/citaController');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✔ ${message}`);
  } else {
    failed++;
    console.error(`  ✘ FALLÓ: ${message}`);
  }
}

function request(baseUrl, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = { ...headers };
    let payloadStr = null;

    if (body !== null) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        payloadStr = JSON.stringify(body);
        if (!reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      } else {
        payloadStr = String(body);
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payloadStr);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: data,
          json,
        });
      });
    });
    req.on('error', reject);
    if (payloadStr !== null) req.write(payloadStr);
    req.end();
  });
}

async function loginSession(baseUrl, usuario, contrasena) {
  const getLogin = await request(baseUrl, '/login');
  const setCookies = getLogin.headers['set-cookie'] || [];
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
  const csrfMatch = getLogin.text.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  const formBody = new URLSearchParams({
    _csrf: csrfToken,
    usuario,
    contrasena,
  }).toString();

  const postLogin = await request(baseUrl, '/login', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  });

  const newCookies = postLogin.headers['set-cookie'] || [];
  const mergedCookies = [...setCookies, ...newCookies]
    .map((c) => c.split(';')[0])
    .reduce((acc, curr) => {
      const [k, v] = curr.split('=');
      acc[k] = v;
      return acc;
    }, {});

  const finalCookieStr = Object.entries(mergedCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const dash = await request(baseUrl, '/', {
    headers: { Cookie: finalCookieStr },
  });
  const dashCsrfMatch = dash.text.match(/meta name="csrf-token" content="([^"]+)"/);
  const activeCsrf = dashCsrfMatch ? dashCsrfMatch[1] : mergedCookies['XSRF-TOKEN'] || csrfToken;

  return { cookie: finalCookieStr, csrfToken: activeCsrf, body: dash.text };
}

async function runTests() {
  console.log('========================================================================');
  console.log('📅 VERIFICACIÓN: FORMULARIO AGENDAR CITA (BÚSQUEDA PACIENTE Y FECHAS)');
  console.log('========================================================================\n');

  process.env.NODE_ENV = 'test';

  const appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${appServer.address().port}`;

  let testCitaIdA = null;
  let testCitaIdB = null;

  try {
    // =========================================================================
    // 1. VERIFICAR FUNCIÓN NORMALIZAR FECHA (AAAA-MM-DD, DD/MM/AAAA)
    // =========================================================================
    console.log('1. Verificando normalización y validación de formatos de fechas...');
    assert(normalizarFecha('2026-10-25') === '2026-10-25', 'Valida formato ISO AAAA-MM-DD');
    assert(normalizarFecha('25/10/2026') === '2026-10-25', 'Normaliza formato DD/MM/AAAA a AAAA-MM-DD');
    assert(normalizarFecha('5/5/2026') === '2026-05-05', 'Normaliza formato D/M/AAAA con ceros a la izquierda');
    assert(normalizarFecha('15-08-1992') === '1992-08-15', 'Normaliza formato DD-MM-AAAA');
    assert(normalizarFecha('31/02/2026') === null, 'Rechaza fecha inválida (31 de febrero)');
    assert(normalizarFecha('fecha-invalida') === null, 'Rechaza texto no numérico');
    assert(normalizarFecha('') === null, 'Rechaza cadena vacía');

    // =========================================================================
    // 2. VERIFICAR INTERFAZ HTML DEL FORMULARIO /citas/nueva
    // =========================================================================
    console.log('\n2. Verificando interfaz del formulario Agendar Cita (/citas/nueva)...');
    const secAuth = await loginSession(appUrl, 'secretaria', 'secretaria123');

    const resForm = await request(appUrl, '/citas/nueva', {
      headers: { Cookie: secAuth.cookie },
    });

    assert(resForm.status === 200, 'Acceso exitoso al formulario /citas/nueva (HTTP 200)');
    assert(
      !resForm.text.includes('<select name="paciente_id"') &&
        !resForm.text.includes('<select id="paciente_id"'),
      'La lista desplegable tradicional (<select name="paciente_id">) fue eliminada'
    );
    assert(
      resForm.text.includes('id="buscar_paciente"') &&
        resForm.text.includes('id="paciente_id"') &&
        resForm.text.includes('id="lista_pacientes_sugerencias"'),
      'Se implementó el campo de búsqueda con teclado y lista de sugerencias en tiempo real para pacientes'
    );
    assert(
      resForm.text.includes('id="fecha"') &&
        resForm.text.includes('id="fecha_picker"') &&
        resForm.text.includes('data-input-id="fecha"'),
      'El campo Fecha de la Cita permite escritura manual con teclado y selección en calendario'
    );
    assert(
      resForm.text.includes('id="fecha_nacimiento"') &&
        resForm.text.includes('id="fecha_nacimiento_picker"') &&
        resForm.text.includes('data-input-id="fecha_nacimiento"'),
      'El campo Fecha de Nacimiento permite escritura manual con teclado y selección en calendario'
    );

    // =========================================================================
    // 3. GUARDAR CITA ESCRIBIENDO FECHAS MANUALMENTE EN FORMATO DD/MM/AAAA
    // =========================================================================
    console.log('\n3. Guardando cita con fecha manual DD/MM/AAAA y fecha de nacimiento manual...');
    const { rows: pRows } = await db.query(`SELECT id, fecha_nacimiento FROM pacientes ORDER BY id ASC LIMIT 1`);
    const paciente = pRows[0];

    const formCitaManual = new URLSearchParams({
      _csrf: secAuth.csrfToken,
      paciente_id: String(paciente.id),
      canal_solicitud: 'Presencial',
      fecha: '25/11/2026', // Fecha escrita manualmente en formato latinoamericano
      hora: '09:00:00',
      telefono_contacto: '809-555-4321',
      correo_contacto: 'paciente.test@sanrafael.com',
      fecha_nacimiento: '18/06/1994', // Fecha de nacimiento escrita manualmente
      motivo: 'Evaluación general y chequeo preventivo anual',
    }).toString();

    const resGuardarManual = await request(appUrl, '/citas', {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formCitaManual,
    });

    assert(
      resGuardarManual.status === 302 && resGuardarManual.headers.location.startsWith('/citas'),
      'Cita guardada correctamente y redirige a la agenda (HTTP 302)'
    );

    // Verificar en la Base de Datos que la fecha de la cita se guardó en formato canónico 2026-11-25
    const { rows: citaDb } = await db.query(
      `SELECT * FROM citas WHERE paciente_id = $1 AND fecha = '2026-11-25' AND hora = '09:00:00'`,
      [paciente.id]
    );
    assert(
      citaDb.length === 1 && citaDb[0].fecha.toISOString().startsWith('2026-11-25'),
      'La fecha de la cita escrita manualmente (25/11/2026) se validó y conservó como 2026-11-25 en PostgreSQL'
    );
    testCitaIdA = citaDb[0].id;

    // Verificar que la fecha de nacimiento se actualizó y conservó en el paciente como 1994-06-18
    const { rows: pacienteActualizado } = await db.query(
      `SELECT fecha_nacimiento FROM pacientes WHERE id = $1`,
      [paciente.id]
    );
    assert(
      pacienteActualizado.length === 1 &&
        pacienteActualizado[0].fecha_nacimiento.toISOString().startsWith('1994-06-18'),
      'La fecha de nacimiento escrita manualmente (18/06/1994) se validó y conservó como 1994-06-18 en la ficha del paciente'
    );

    // =========================================================================
    // 4. GUARDAR CITA USANDO FORMATO ISO AAAA-MM-DD (CALENDARIO O ESCRITURA)
    // =========================================================================
    console.log('\n4. Guardando cita con formato ISO AAAA-MM-DD...');
    const formCitaIso = new URLSearchParams({
      _csrf: secAuth.csrfToken,
      paciente_id: String(paciente.id),
      canal_solicitud: 'Teléfono',
      fecha: '2026-11-26', // Formato ISO devuelto por el selector de calendario
      hora: '10:30:00',
      telefono_contacto: '809-555-9876',
      fecha_nacimiento: '1994-06-18',
      motivo: 'Revisión de resultados de laboratorio',
    }).toString();

    const resGuardarIso = await request(appUrl, '/citas', {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formCitaIso,
    });

    assert(resGuardarIso.status === 302, 'Cita con fecha ISO guardada correctamente (HTTP 302)');

    const { rows: citaIsoDb } = await db.query(
      `SELECT * FROM citas WHERE paciente_id = $1 AND fecha = '2026-11-26' AND hora = '10:30:00'`,
      [paciente.id]
    );
    assert(
      citaIsoDb.length === 1,
      'La fecha de la cita elegida con calendario (2026-11-26) se guardó correctamente'
    );
    testCitaIdB = citaIsoDb[0].id;

    // =========================================================================
    // 5. VALIDACIÓN DE FECHAS INVÁLIDAS Y RECHAZO
    // =========================================================================
    console.log('\n5. Verificando rechazo de formatos de fechas inválidos...');

    // 5A. Fecha de la cita inválida
    const formFechaInvalida = new URLSearchParams({
      _csrf: secAuth.csrfToken,
      paciente_id: String(paciente.id),
      canal_solicitud: 'Presencial',
      fecha: '31/02/2026', // 31 de febrero no existe
      hora: '14:00:00',
      telefono_contacto: '809-555-1111',
      motivo: 'Consulta de control',
    }).toString();

    const resFechaInvalida = await request(appUrl, '/citas', {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formFechaInvalida,
    });

    assert(
      resFechaInvalida.status === 302 && resFechaInvalida.headers.location === '/citas/nueva',
      'El servidor rechaza fecha de cita inexistente (31/02/2026) y redirige a /citas/nueva con alerta'
    );

    // 5B. Fecha de nacimiento inválida
    const formNacInvalido = new URLSearchParams({
      _csrf: secAuth.csrfToken,
      paciente_id: String(paciente.id),
      canal_solicitud: 'Presencial',
      fecha: '2026-11-27',
      hora: '14:00:00',
      telefono_contacto: '809-555-1111',
      fecha_nacimiento: '99/99/9999',
      motivo: 'Consulta de control',
    }).toString();

    const resNacInvalido = await request(appUrl, '/citas', {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formNacInvalido,
    });

    assert(
      resNacInvalido.status === 302 && resNacInvalido.headers.location === '/citas/nueva',
      'El servidor rechaza fecha de nacimiento con formato incorrecto y redirige a /citas/nueva con alerta'
    );

    // 5C. Intento sin paciente_id
    const formSinPaciente = new URLSearchParams({
      _csrf: secAuth.csrfToken,
      paciente_id: '',
      canal_solicitud: 'Presencial',
      fecha: '2026-11-27',
      hora: '15:00:00',
      telefono_contacto: '809-555-1111',
      motivo: 'Consulta de control',
    }).toString();

    const resSinPaciente = await request(appUrl, '/citas', {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formSinPaciente,
    });

    assert(
      resSinPaciente.status === 302 && resSinPaciente.headers.location === '/citas/nueva',
      'El servidor exige obligatoriamente la selección de un paciente válido'
    );

  } finally {
    // Limpieza
    if (testCitaIdA) await db.query(`DELETE FROM citas WHERE id = $1`, [testCitaIdA]);
    if (testCitaIdB) await db.query(`DELETE FROM citas WHERE id = $1`, [testCitaIdB]);
    try { appServer.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }

  console.log('\n========================================================================');
  console.log(`📊 RESULTADO FINAL: ${passed} pruebas superadas, ${failed} fallidas`);
  console.log('========================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Error fatal durante la prueba:', err);
  process.exit(1);
});

