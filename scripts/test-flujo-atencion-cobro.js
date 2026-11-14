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

  return { cookie: finalCookieStr, csrfToken: activeCsrf };
}

async function runVerification() {
  console.log('========================================================================');
  console.log('🩺 VERIFICACIÓN: RECORRIDO MÉDICO (ATENCIÓN & RECETA) -> SECRETARÍA (COBRO)');
  console.log('========================================================================\n');

  process.env.NODE_ENV = 'test';

  const appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${appServer.address().port}`;

  let consultaCreadaId = null;

  try {
    // 1. Obtener un paciente de prueba
    const { rows: pacientes } = await db.query(`SELECT id, nombre, apellido, ars_id FROM pacientes LIMIT 1`);
    const paciente = pacientes[0];

    // =========================================================================
    // PASO 1: MÉDICO ABRE FORMULARIO DE ATENCIÓN
    // =========================================================================
    console.log('1. Verificando que en el perfil del Médico se oculta la sección de liquidación y cobro...');

    const medicoAuth = await loginSession(appUrl, 'medico', 'medico123');
    const resFormAtender = await request(appUrl, `/consultas/atender?paciente_id=${paciente.id}`, {
      headers: { Cookie: medicoAuth.cookie },
    });

    assert(resFormAtender.status === 200, 'Médico accede al formulario de atención médica (/consultas/atender)');
    assert(
      !resFormAtender.text.includes('id="servicio_id"') &&
        !resFormAtender.text.includes('id="ars_id"') &&
        !resFormAtender.text.includes('id="estado_pago"') &&
        !resFormAtender.text.includes('displayValorTotal') &&
        !resFormAtender.text.includes('displayDiferenciaPaciente'),
      'La sección completa de liquidación, servicio, ARS y cobro está TOTALMENTE OCULTA para el Médico'
    );
    assert(
      resFormAtender.text.includes('Guardar Atención Médica y Receta') &&
        !resFormAtender.text.includes('Guardar Atención, Receta y Cobro'),
      'El botón del Médico indica "Guardar Atención Médica y Receta" sin acciones ni mención de cobrar'
    );

    // =========================================================================
    // PASO 2: MÉDICO GUARDA LA ATENCIÓN CLÍNICA Y LA RECETA
    // =========================================================================
    console.log('\n2. Médico guarda la consulta clínica y prescribe receta; backend fija estado Pendiente...');

    const formAtencion = new URLSearchParams({
      _csrf: medicoAuth.csrfToken,
      paciente_id: String(paciente.id),
      motivo_consulta: 'Cefalea intensa y dolor muscular persistente',
      pa_sistolica: '120',
      pa_diastolica: '80',
      temperatura: '37.1',
      frecuencia_cardiaca: '78',
      frecuencia_respiratoria: '18',
      peso: '72',
      hallazgos_clinicos: 'Paciente consciente, orientado, auscultación cardiopulmonar normal.',
      diagnostico_clinico: 'Cefalea tensional asociada a sobrecarga laboral',
      tratamiento_plan: 'Reposo relativo 24 horas, hidratación abundante, analgesia reglada.',
      incluye_receta: 'true',
      indicaciones_generales: 'Tomar la medicación con alimentos.',
      med_nombre: 'Paracetamol 500mg',
      med_dosis: '500 mg',
      med_frecuencia: 'Cada 8 horas x 3 días',
      med_indicaciones: 'Tomar con abundante agua',
      med_cantidad: '1',
      // Intento malicioso de fijar pagado desde el cliente:
      estado_pago: 'Pagado',
      diferencia_paciente: '0.00',
    }).toString();

    const resGuardar = await request(appUrl, '/consultas', {
      method: 'POST',
      headers: {
        Cookie: medicoAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formAtencion,
    });

    assert(
      resGuardar.status === 302 && resGuardar.headers.location.startsWith('/consultas/'),
      'Atención médica guardada exitosamente y redirige al detalle de la consulta (HTTP 302)'
    );

    const matchId = resGuardar.headers.location.match(/\/consultas\/(\d+)/);
    consultaCreadaId = matchId ? parseInt(matchId[1], 10) : null;
    assert(Boolean(consultaCreadaId), `Consulta creada en la base de datos con ID #${consultaCreadaId}`);

    // Verificar en la Base de Datos que se creó como 'Pendiente' con la receta
    const { rows: consultaDb } = await db.query(
      `SELECT * FROM consultas WHERE id = $1`,
      [consultaCreadaId]
    );
    assert(
      consultaDb.length > 0 &&
        consultaDb[0].estado_pago === 'Pendiente' &&
        parseFloat(consultaDb[0].valor_total) > 0 &&
        parseFloat(consultaDb[0].diferencia_paciente) > 0,
      'Backend fija estado_pago = "Pendiente" y calcula automáticamente las tarifas oficiales ignorando intentos de manipulación'
    );

    const { rows: recetaDb } = await db.query(
      `SELECT r.*, COUNT(rd.id) as cant_meds
       FROM recetas r
       LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
       WHERE r.consulta_id = $1
       GROUP BY r.id`,
      [consultaCreadaId]
    );
    assert(
      recetaDb.length > 0 && parseInt(recetaDb[0].cant_meds, 10) >= 1,
      'Receta médica vinculada a la consulta y guardada con sus medicamentos correspondientes'
    );

    // =========================================================================
    // PASO 3: RESTRICCIÓN DE CONSULTA DE MONTOS / COBROS PARA MÉDICO
    // =========================================================================
    console.log('\n3. Verificando que el Médico no puede consultar montos ni estado de cobro...');

    const resDetalleMedico = await request(appUrl, `/consultas/${consultaCreadaId}`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(
      resDetalleMedico.status === 200 &&
        !resDetalleMedico.text.includes('Liquidación de Servicio y ARS') &&
        !resDetalleMedico.text.includes('Diferencia a pagar') &&
        !resDetalleMedico.text.includes('Estado del Pago'),
      'El detalle de consulta (/consultas/:id) oculta los montos y el estado de cobro al Médico'
    );

    const resListaConsultasMedico = await request(appUrl, '/consultas', {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(
      resListaConsultasMedico.status === 200 &&
        !resListaConsultasMedico.text.includes('Total: RD$') &&
        !resListaConsultasMedico.text.includes('Copago: RD$'),
      'El listado de consultas (/consultas) no expone los importes del cobro al Médico'
    );

    const resMedicoIntentaCobrar = await request(appUrl, `/ecf/factura/${consultaCreadaId}`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(
      resMedicoIntentaCobrar.status === 403,
      'Médico queda estrictamente bloqueado con HTTP 403 en las rutas de facturación y cobro (/ecf/*)'
    );

    // =========================================================================
    // PASO 4: SECRETARÍA VE EL CARGO PENDIENTE EN SU PANEL Y EN EL PACIENTE
    // =========================================================================
    console.log('\n4. Secretaría ve la consulta como pendiente de cobro en su panel y ficha del paciente...');

    const secretariaAuth = await loginSession(appUrl, 'secretaria', 'secretaria123');

    // 4A. Panel principal de Secretaría
    const resPanelSec = await request(appUrl, '/', {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resPanelSec.status === 200 &&
        resPanelSec.text.includes('Consultas Médicas Pendientes de Cobro') &&
        resPanelSec.text.includes(`href="/ecf/factura/${consultaCreadaId}"`),
      'El panel de Secretaría muestra la consulta como cargo pendiente de cobro con botón "Revisar y Cobrar"'
    );

    // 4B. Ficha del paciente vista por Secretaría
    const resFichaPaciente = await request(appUrl, `/pacientes/${paciente.id}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resFichaPaciente.status === 200 &&
        resFichaPaciente.text.includes('Consultas y Cobros de Copago') &&
        resFichaPaciente.text.includes(`href="/ecf/factura/${consultaCreadaId}"`),
      'En la ficha del paciente, Secretaría visualiza el cobro pendiente vinculado a la consulta'
    );

    // =========================================================================
    // PASO 5: SECRETARÍA REVISA LA LIQUIDACIÓN Y REGISTRA EL COBRO
    // =========================================================================
    console.log('\n5. Secretaría revisa la liquidación y registra el cobro de la consulta...');

    const resFacturaCobro = await request(appUrl, `/ecf/factura/${consultaCreadaId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resFacturaCobro.status === 200 &&
        resFacturaCobro.text.includes('Liquidación, Cobertura ARS y Cobro al Paciente') &&
        resFacturaCobro.text.includes('Servicio Prestado') &&
        resFacturaCobro.text.includes('ARS / Aseguradora') &&
        resFacturaCobro.text.includes('Monto que Paga el Paciente (Copago)'),
      'Secretaría accede a la pantalla de cobro y visualiza el servicio, la cobertura ARS y el copago'
    );

    // 5A. Probar actualización de liquidación por Secretaría
    const resActualizarLiq = await request(appUrl, `/ecf/factura/${consultaCreadaId}/actualizar-liquidacion`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: secretariaAuth.csrfToken,
        servicio_id: '1',
        ars_id: '0', // Cambiar a Particular para verificar recálculo
      }).toString(),
    });
    assert(
      resActualizarLiq.status === 302,
      'Secretaría puede revisar y actualizar el servicio y cobertura ARS antes de cobrar'
    );

    // 5B. Registrar el cobro en caja
    const resRegistrarCobro = await request(appUrl, `/ecf/factura/${consultaCreadaId}/registrar-cobro`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: secretariaAuth.csrfToken,
        metodo_pago: 'Efectivo',
      }).toString(),
    });
    assert(
      resRegistrarCobro.status === 302,
      'Secretaría registra exitosamente el cobro del copago en caja (HTTP 302)'
    );

    // Verificar en la Base de Datos que pasó a 'Pagado'
    const { rows: consultaPagada } = await db.query(
      `SELECT estado_pago FROM consultas WHERE id = $1`,
      [consultaCreadaId]
    );
    assert(
      consultaPagada.length > 0 && consultaPagada[0].estado_pago === 'Pagado',
      'El cargo de la consulta médica quedó verificado como "Pagado" en la base de datos'
    );

    // Comprobar que en la vista de la factura ahora figura como Liquidación Pagada
    const resFacturaFinal = await request(appUrl, `/ecf/factura/${consultaCreadaId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resFacturaFinal.status === 200 &&
        resFacturaFinal.text.includes('Liquidación Pagada'),
      'La pantalla de facturación confirma que la consulta ya fue cobrada y liquidada'
    );

  } finally {
    if (consultaCreadaId) {
      await db.query(`DELETE FROM receta_detalles WHERE receta_id IN (SELECT id FROM recetas WHERE consulta_id = $1)`, [consultaCreadaId]);
      await db.query(`DELETE FROM recetas WHERE consulta_id = $1`, [consultaCreadaId]);
      await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaCreadaId]);
      await db.query(`DELETE FROM pagos_paypal WHERE consulta_id = $1`, [consultaCreadaId]);
      await db.query(`DELETE FROM consultas WHERE id = $1`, [consultaCreadaId]);
    }
    try { appServer.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }

  console.log('\n========================================================================');
  console.log(`📊 RESULTADO DE VERIFICACIÓN: ${passed} exitosas, ${failed} fallidas`);
  console.log('========================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runVerification().catch((err) => {
  console.error('Error en verificación:', err);
  process.exit(1);
});

