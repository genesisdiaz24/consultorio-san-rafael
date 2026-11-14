const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');

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
  console.log('🏥 VERIFICACIÓN: MÓDULO ARS & COBROS -> COBRAR Y REGLAS DE INTEGRIDAD');
  console.log('========================================================================\n');

  process.env.NODE_ENV = 'test';

  const appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${appServer.address().port}`;

  let testCitaId = null;
  let testConsultaId = null;
  let testPacienteId = null;

  try {
    // 1. Obtener paciente de prueba
    const { rows: pRows } = await db.query(`SELECT id FROM pacientes LIMIT 1`);
    testPacienteId = pRows[0].id;

    // =========================================================================
    // 1. VERIFICAR OPCIÓN "COBRAR" EN EL MENÚ ARS & COBROS
    // =========================================================================
    console.log('1. Verificando que "Cobrar" aparece en el menú "ARS & Cobros" para Secretaría y Admin...');
    const secAuth = await loginSession(appUrl, 'secretaria', 'secretaria123');
    assert(
      secAuth.body.includes('ARS &amp; Cobros') && secAuth.body.includes('href="/ars/cobrar"'),
      'Secretaría visualiza en la barra de navegación el menú "ARS & Cobros" con la opción "Cobrar" (/ars/cobrar)'
    );

    const adminAuth = await loginSession(appUrl, 'admin', 'admin123');
    assert(
      adminAuth.body.includes('ARS &amp; Cobros') && adminAuth.body.includes('href="/ars/cobrar"'),
      'Administrador visualiza en la barra de navegación el menú "ARS & Cobros" con la opción "Cobrar" (/ars/cobrar)'
    );

    // =========================================================================
    // 2. VERIFICAR PERMISOS POR ROL EN EL BACKEND (RBAC)
    // =========================================================================
    console.log('\n2. Verificando restricciones por rol en el backend (Médico bloqueado con HTTP 403)...');
    const medAuth = await loginSession(appUrl, 'medico', 'medico123');

    const resMedGetCobrar = await request(appUrl, '/ars/cobrar', {
      headers: { Cookie: medAuth.cookie },
    });
    assert(
      resMedGetCobrar.status === 403,
      'Médico queda bloqueado con HTTP 403 al intentar acceder a GET /ars/cobrar por URL'
    );

    const resMedPostCobrar = await request(appUrl, '/ars/cobrar/1', {
      method: 'POST',
      headers: {
        Cookie: medAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _csrf: medAuth.csrfToken }).toString(),
    });
    assert(
      resMedPostCobrar.status === 403,
      'Médico queda bloqueado con HTTP 403 al intentar enviar POST /ars/cobrar/:id'
    );

    const resSecGetCobrar = await request(appUrl, '/ars/cobrar', {
      headers: { Cookie: secAuth.cookie },
    });
    assert(
      resSecGetCobrar.status === 200 &&
        resSecGetCobrar.text.includes('Liquidación, Cobertura ARS y Cobro al Paciente'),
      'Secretaría accede exitosamente a /ars/cobrar (HTTP 200) y visualiza la sección de liquidación y cobro'
    );

    // =========================================================================
    // 3. REGLA: NO PERMITIR COBRAR ANTES DE QUE EL MÉDICO FINALICE LA CONSULTA
    // =========================================================================
    console.log('\n3. Verificando regla: No permitir cobrar antes de que el médico finalice la consulta...');
    
    // Crear una cita de prueba en estado 'Programada'
    const { rows: citaRows } = await db.query(
      `INSERT INTO citas (paciente_id, fecha, hora, motivo, estado, canal_solicitud, telefono_contacto)
       VALUES ($1, CURRENT_DATE, '10:00:00', 'Consulta de control cardiología', 'Programada', 'Presencial', '809-555-1234')
       RETURNING id`,
      [testPacienteId]
    );
    testCitaId = citaRows[0].id;

    // Crear una consulta incompleta vinculada a la cita (sin diagnóstico o cita aún no Atendida)
    const { rows: consIncompleta } = await db.query(
      `INSERT INTO consultas (cita_id, paciente_id, motivo_consulta, hallazgos_clinicos, diagnostico_clinico, tratamiento_plan, valor_total, valor_cubierto_ars, diferencia_paciente, estado_pago)
       VALUES ($1, $2, 'Motivo de prueba', 'Hallazgos de prueba', '', '', 1500, 500, 1000, 'Pendiente')
       RETURNING id`,
      [testCitaId, testPacienteId]
    );
    const idIncompleta = consIncompleta[0].id;

    const resCobrarPrematuro = await request(appUrl, `/ars/cobrar/${idIncompleta}`, {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        _csrf: secAuth.csrfToken,
        metodo_pago: 'Efectivo',
        formato: 'json',
      }).toString(),
    });

    assert(
      resCobrarPrematuro.status === 400 &&
        resCobrarPrematuro.json &&
        resCobrarPrematuro.json.error.includes('No se puede cobrar antes de que el médico finalice la consulta'),
      'Se rechaza el cobro con HTTP 400 cuando la cita no está en estado "Atendida" o el médico no ha finalizado'
    );

    // Limpiar consulta incompleta
    await db.query(`DELETE FROM consultas WHERE id = $1`, [idIncompleta]);

    // =========================================================================
    // 4. FLUJO: MÉDICO FINALIZA LA CONSULTA -> CITA "ATENDIDA" & CARGO "PENDIENTE"
    // =========================================================================
    console.log('\n4. Médico finaliza la atención médica y receta; cambia cita a "Atendida" y crea cargo "Pendiente"...');

    const formMedico = new URLSearchParams({
      _csrf: medAuth.csrfToken,
      paciente_id: String(testPacienteId),
      cita_id: String(testCitaId),
      motivo_consulta: 'Dolor precordial opresivo atípico',
      pa_sistolica: '125',
      pa_diastolica: '82',
      temperatura: '36.8',
      frecuencia_cardiaca: '72',
      frecuencia_respiratoria: '16',
      peso: '75',
      hallazgos_clinicos: 'Ruidos cardiacos rítmicos sin soplos, murmullo vesicular conservado.',
      diagnostico_clinico: 'Dolor torácico no cardiogénico por tensión musculoesquelética',
      tratamiento_plan: 'Calor local, analgésico oral cada 8 horas por 5 días, reposo.',
      incluye_receta: 'true',
      indicaciones_generales: 'Acudir a control en caso de presentar dolor persistente.',
      med_nombre: 'Ibuprofeno 400mg',
      med_dosis: '400 mg',
      med_frecuencia: 'Cada 8 horas con comida',
      med_indicaciones: 'Vía oral',
      med_cantidad: '1',
    }).toString();

    const resGuardarAtencion = await request(appUrl, '/consultas', {
      method: 'POST',
      headers: {
        Cookie: medAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formMedico,
    });

    assert(
      resGuardarAtencion.status === 302,
      'Médico guarda la consulta exitosamente y redirige (HTTP 302)'
    );

    // Verificar estado de la cita en BD
    const { rows: citaActualizada } = await db.query(
      `SELECT estado FROM citas WHERE id = $1`,
      [testCitaId]
    );
    assert(
      citaActualizada.length > 0 && citaActualizada[0].estado === 'Atendida',
      'La cita médica vinculada cambió automáticamente a estado "Atendida"'
    );

    // Verificar que se creó la consulta vinculada con estado_pago = 'Pendiente'
    const { rows: consCreada } = await db.query(
      `SELECT * FROM consultas WHERE cita_id = $1`,
      [testCitaId]
    );
    assert(
      consCreada.length === 1 &&
        consCreada[0].estado_pago === 'Pendiente' &&
        parseFloat(consCreada[0].diferencia_paciente) > 0,
      'Se creó el cargo en estado "Pendiente" vinculado al paciente y a la cita, con copago calculado'
    );
    testConsultaId = consCreada[0].id;

    // =========================================================================
    // 5. REGLA: NO PERMITIR CARGOS DUPLICADOS
    // =========================================================================
    console.log('\n5. Verificando regla: Prevenir la creación de cargos duplicados para la misma cita...');
    const resIntentoDuplicado = await request(appUrl, '/consultas', {
      method: 'POST',
      headers: {
        Cookie: medAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formMedico,
    });

    const { rows: conteoConsultas } = await db.query(
      `SELECT COUNT(*) AS total FROM consultas WHERE cita_id = $1`,
      [testCitaId]
    );
    assert(
      parseInt(conteoConsultas[0].total, 10) === 1,
      'No se crean cargos duplicados: reenvíos para la misma cita son protegidos por idempotencia'
    );

    // =========================================================================
    // 6. EN ARS & COBROS: SECRETARÍA COBRA Y ACTUALIZA A "PAGADO"
    // =========================================================================
    console.log('\n6. En ARS & Cobros, Secretaría registra el pago y actualiza el estado a "Pagado"...');

    const resCobrarSec = await request(appUrl, `/ars/cobrar/${testConsultaId}`, {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        _csrf: secAuth.csrfToken,
        metodo_pago: 'Efectivo',
        formato: 'json',
      }).toString(),
    });

    assert(
      resCobrarSec.status === 200 &&
        resCobrarSec.json &&
        resCobrarSec.json.success === true,
      'Secretaría ejecuta POST /ars/cobrar/:id exitosamente (HTTP 200 JSON)'
    );

    // Verificar en la BD que pasó a 'Pagado'
    const { rows: consPagada } = await db.query(
      `SELECT estado_pago FROM consultas WHERE id = $1`,
      [testConsultaId]
    );
    assert(
      consPagada.length > 0 && consPagada[0].estado_pago === 'Pagado',
      'El estado del cobro en la base de datos se actualizó a "Pagado"'
    );

    // =========================================================================
    // 7. REGLA: NO PERMITIR COBROS DUPLICADOS SI YA ESTÁ "PAGADO"
    // =========================================================================
    console.log('\n7. Verificando regla: Prevenir cobros duplicados en consultas ya pagadas...');

    const resIntentoCobroDuplicado = await request(appUrl, `/ars/cobrar/${testConsultaId}`, {
      method: 'POST',
      headers: {
        Cookie: secAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        _csrf: secAuth.csrfToken,
        metodo_pago: 'Tarjeta de Débito',
        formato: 'json',
      }).toString(),
    });

    assert(
      resIntentoCobroDuplicado.status === 409 &&
        resIntentoCobroDuplicado.json &&
        resIntentoCobroDuplicado.json.error.includes('No se permiten cobros duplicados'),
      'Se rechaza el cobro duplicado con HTTP 409: "Esta consulta ya ha sido pagada previamente. No se permiten cobros duplicados."'
    );

  } finally {
    // Limpieza de datos creados en pruebas
    if (testConsultaId) {
      await db.query(`DELETE FROM receta_detalles WHERE receta_id IN (SELECT id FROM recetas WHERE consulta_id = $1)`, [testConsultaId]);
      await db.query(`DELETE FROM recetas WHERE consulta_id = $1`, [testConsultaId]);
      await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [testConsultaId]);
      await db.query(`DELETE FROM pagos_paypal WHERE consulta_id = $1`, [testConsultaId]);
      await db.query(`DELETE FROM consultas WHERE id = $1`, [testConsultaId]);
    }
    if (testCitaId) {
      await db.query(`DELETE FROM citas WHERE id = $1`, [testCitaId]);
    }
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
