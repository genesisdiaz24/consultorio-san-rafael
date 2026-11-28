const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const imecfService = require('../src/services/imecfService');

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

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
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
      }
    );
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

async function runTests() {
  console.log('================================================================');
  console.log('🧪 PRUEBAS DE INTEGRACIÓN API IMECF (COMPROBANTES ELECTRÓNICOS)');
  console.log('================================================================\n');

  process.env.NODE_ENV = 'test';

  // 1. Iniciar servidor Mock de IMECF para verificar peticiones HTTP del backend, encabezados X-API-Key y estados
  const mockImecfStore = new Map();
  let mockNextBehavior = 'SUCCESS'; // 'SUCCESS' | 'AUTH_ERROR' | 'CONFIG_ERROR' | 'TIMEOUT'
  let lastReceivedHeaders = {};
  let lastReceivedBody = null;

  const mockImecfServer = http.createServer((req, res) => {
    lastReceivedHeaders = req.headers;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        lastReceivedBody = body ? JSON.parse(body) : null;
      } catch (_) {
        lastReceivedBody = body;
      }

      // Verificar X-API-Key en endpoints protegidos /api/v1/ecf
      if (req.url.startsWith('/api/v1/ecf')) {
        if (mockNextBehavior === 'AUTH_ERROR' || req.headers['x-api-key'] !== 'ecf_live_clave_prueba_unitaria_segura_999') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'API Key inválida o sin permisos.' }));
        }
      }

      if (req.method === 'POST' && req.url === '/api/v1/ecf/send') {
        if (mockNextBehavior === 'CONFIG_ERROR') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              message: 'La empresa no tiene un certificado digital (.p12) configurado ni secuencias fiscales activas.',
            })
          );
        }

        if (mockNextBehavior === 'TIMEOUT') {
          // No responder a tiempo para disparar el AbortController timeout
          setTimeout(() => {
            try {
              res.writeHead(504);
              res.end();
            } catch (_) {}
          }, 1500);
          return;
        }

        const tipoeCF = lastReceivedBody?.ECF?.Encabezado?.IdDoc?.TipoeCF || '32';
        const tipoEcf = tipoeCF === '31' ? 'E31' : 'E32';
        const id = `imecf-doc-${Date.now()}`;
        const encf = `${tipoEcf}0000000045`;
        const docRecord = {
          id,
          encf,
          tipoEcf,
          estado: 'PENDIENTE_ENVIO_AL_SERVICIO_DGII',
          trackId: `trk-dgii-${Date.now()}`,
          codigoSeguridad: 'A9F4K2',
          dgiiUrl: `https://ecf.dgii.gov.do/TesteCF/ConsultaTimbre?ENCF=${encf}`,
          xmlUrl: `/api/v1/ecf/${id}/xml`,
          enviado: true,
          secuenciaUtilizada: true,
          ambiente: 'TesteCF',
          errorMessage: null,
          requestJson: lastReceivedBody,
        };
        mockImecfStore.set(id, docRecord);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: docRecord }));
      }

      const statusMatch = req.url.match(/^\/api\/v1\/ecf\/([^/]+)\/status$/);
      if (req.method === 'GET' && statusMatch) {
        const doc = mockImecfStore.get(decodeURIComponent(statusMatch[1]));
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'No encontrado' }));
        }
        doc.estado = 'En Proceso';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: doc }));
      }

      const trackMatch = req.url.match(/^\/api\/v1\/ecf\/([^/]+)\/track$/);
      if (req.method === 'GET' && trackMatch) {
        const doc = mockImecfStore.get(decodeURIComponent(trackMatch[1]));
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'No encontrado' }));
        }
        doc.estado = 'Aceptado';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: doc }));
      }

      const xmlMatch = req.url.match(/^\/api\/v1\/ecf\/([^/]+)\/xml$/);
      if (req.method === 'GET' && xmlMatch) {
        const doc = mockImecfStore.get(decodeURIComponent(xmlMatch[1]));
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'XML no encontrado' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ECF><Encabezado><IdDoc><eNCF>${doc.encf}</eNCF></IdDoc></Encabezado><Signature>${doc.codigoSeguridad}</Signature></ECF>`
        );
      }

      if (req.method === 'GET' && req.url.startsWith('/api/v1/ecf')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            success: true,
            ambiente: 'TesteCF',
            data: Array.from(mockImecfStore.values()),
          })
        );
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Ruta no encontrada en mock' }));
    });
  });

  await new Promise((r) => mockImecfServer.listen(0, '127.0.0.1', r));
  const mockPort = mockImecfServer.address().port;
  process.env.IMECF_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.ECF_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.IMECF_API_KEY = 'ecf_live_clave_prueba_unitaria_segura_999';
  process.env.ECF_API_KEY = 'ecf_live_clave_prueba_unitaria_segura_999';
  process.env.IMECF_ALLOW_PRODUCTION = 'false';
  process.env.ECF_REQUEST_TIMEOUT_MS = '400';

  const appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${appServer.address().port}`;

  try {
    // Limpiar cualquier registro simulado antiguo que haya quedado en comprobantes_electronicos
    await db.query(
      `DELETE FROM comprobantes_electronicos
       WHERE modo_simulacion = true
          OR ecf_id_externo LIKE 'sim-%'
          OR track_id LIKE 'trk-sim-%'
          OR estado = 'EN_PROCESO_SIMULADO'`
    );

    // =========================================================================
    // BLOQUE 1: NORMALIZACIÓN DE URL (FRONTEND -> BACKEND API) Y ESQUEMAS E31/E32
    // =========================================================================
    console.log('1. Verificando URL de IMECF, esquemas E31/E32, cálculo de impuestos y privacidad clínica...');

    const urlNormalizada = imecfService.normalizarBaseUrlImecf(
      'https://ecf-platform-frontend-50801509587.us-central1.run.app/'
    );
    assert(
      urlNormalizada === 'https://ecf-platform-backend-50801509587.us-central1.run.app',
      'La URL de la plataforma web (frontend) se normaliza automáticamente al backend API documentado de IMECF'
    );

    const consultaFicticia = {
      id: 999,
      paciente_nombre: 'Juan',
      paciente_apellido: 'Pérez',
      paciente_identificacion: '001-1234567-8',
      paciente_correo: 'juan.perez@ejemplo.do',
      servicio_nombre: 'Consulta Médica Especializada',
      servicio_indicador_facturacion: '4',
      valor_total: 2500.0,
      valor_cubierto_ars: 2000.0,
      diferencia_paciente: 500.0,
      diagnostico_clinico: 'Hipertensión arterial severa estadio 2 confidencial',
      hallazgos_clinicos: 'Soplo sistólico grado II confidencial',
      tratamiento_plan: 'Enalapril 20mg cada 12 horas confidencial',
      notas_adicionales: 'Paciente con antecedente quirúrgico confidencial',
    };

    // Caso 1A: E32 Exento (por defecto en salud)
    const e32Exento = imecfService.construirPayloadEcf(consultaFicticia, {
      tipoEcf: 'E32',
      indicadorFacturacion: '4',
      criterioMonto: 'TOTAL',
    });

    assert(e32Exento.payload.ECF.Encabezado.IdDoc.TipoeCF === '32', 'E32 asigna TipoeCF = "32"');
    assert(e32Exento.payload.ECF.Encabezado.Totales.MontoExento === '2500.00', 'E32 Exento asigna MontoExento = "2500.00"');
    assert(e32Exento.payload.ECF.Encabezado.Totales.MontoGravadoTotal === '0.00', 'E32 Exento asigna MontoGravadoTotal = "0.00"');
    assert(e32Exento.payload.ECF.Encabezado.Totales.TotalITBIS === '0.00', 'E32 Exento asigna TotalITBIS = "0.00"');
    assert(e32Exento.payload.ECF.Encabezado.Totales.MontoTotal === '2500.00', 'E32 Exento asigna MontoTotal = "2500.00"');
    assert(
      !('eNCF' in e32Exento.payload.ECF.Encabezado.IdDoc) &&
        !('FechaVencimientoSecuencia' in e32Exento.payload.ECF.Encabezado.IdDoc) &&
        !('Emisor' in e32Exento.payload.ECF.Encabezado) &&
        !('FechaHoraFirma' in e32Exento.payload.ECF),
      'El JSON de envío omite los campos autogenerados por IMECF (eNCF, FechaVencimientoSecuencia, Emisor, FechaHoraFirma) sin usar RNC inventados'
    );

    const jsonE32Str = JSON.stringify(e32Exento.payload);
    assert(
      !jsonE32Str.includes('Hipertensión') &&
        !jsonE32Str.includes('Soplo') &&
        !jsonE32Str.includes('Enalapril') &&
        !jsonE32Str.includes('quirúrgico'),
      'Privacidad garantizada: el JSON fiscal excluye diagnósticos, hallazgos, recetas y notas médicas'
    );

    // Caso 1B: E31 Crédito Fiscal Gravado al 18% y facturando solo Copago
    const e31Gravado = imecfService.construirPayloadEcf(consultaFicticia, {
      tipoEcf: 'E31',
      indicadorFacturacion: '1',
      criterioMonto: 'COPAGO',
      rncComprador: '1-31-99887-7',
      razonSocialComprador: 'EMPRESA SALUD DOMINICANA SRL',
    });

    assert(e31Gravado.payload.ECF.Encabezado.IdDoc.TipoeCF === '31', 'E31 asigna TipoeCF = "31"');
    assert(
      e31Gravado.payload.ECF.Encabezado.Comprador.RNCComprador === '131998877',
      'RNCComprador se normaliza sin guiones (9 dígitos)'
    );
    assert(
      e31Gravado.payload.ECF.Encabezado.Totales.MontoGravadoTotal === '500.00' &&
        e31Gravado.payload.ECF.Encabezado.Totales.MontoGravadoI1 === '500.00' &&
        e31Gravado.payload.ECF.Encabezado.Totales.ITBIS1 === '18' &&
        e31Gravado.payload.ECF.Encabezado.Totales.TotalITBIS === '90.00' &&
        e31Gravado.payload.ECF.Encabezado.Totales.MontoTotal === '590.00',
      'Cálculo exacto de ITBIS 18% sobre copago (500 + 90 = 590.00)'
    );

    // Caso 1C: Validaciones de rechazo en servidor
    let falloE31SinRnc = false;
    try {
      imecfService.construirPayloadEcf(consultaFicticia, {
        tipoEcf: 'E31',
        rncComprador: '123', // RNC inválido
      });
    } catch (e) {
      falloE31SinRnc = e.tipo === 'ERROR_VALIDACION';
    }
    assert(falloE31SinRnc, 'El servidor rechaza E31 cuando el RNC/Cédula no tiene 9 u 11 dígitos');

    let falloMontoCero = false;
    try {
      imecfService.construirPayloadEcf({ ...consultaFicticia, valor_total: 0 }, { tipoEcf: 'E32' });
    } catch (e) {
      falloMontoCero = e.tipo === 'ERROR_VALIDACION';
    }
    assert(falloMontoCero, 'El servidor rechaza comprobantes con importe cero o negativo');

    // =========================================================================
    // BLOQUE 2: CONTROL DE ACCESO POR ROL (RBAC) Y PROTECCIÓN DE IMECF_API_KEY
    // =========================================================================
    console.log('\n2. Verificando control de acceso (RBAC) y privacidad de IMECF_API_KEY...');

    const adminAuth = await loginSession(appUrl, 'admin', 'admin123');
    const medicoAuth = await loginSession(appUrl, 'medico', 'medico123');
    const secretariaAuth = await loginSession(appUrl, 'secretaria', 'secretaria123');
    const farmaciaAuth = await loginSession(appUrl, 'farmacia', 'farmacia123');

    const { rows: consultasDb } = await db.query(`SELECT id, estado_pago FROM consultas ORDER BY id ASC LIMIT 1`);
    const consultaIdReal = consultasDb[0].id;
    const estadoPagoOriginal = consultasDb[0].estado_pago;

    // Limpiar comprobantes de prueba previos sobre esta consulta
    await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaIdReal]);

    const resDetalleMedico = await request(appUrl, `/consultas/${consultaIdReal}`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(resDetalleMedico.status === 200, 'Médico accede al detalle de la consulta');
    assert(
      !resDetalleMedico.text.includes('Emitir comprobante electrónico'),
      'El botón "Emitir comprobante electrónico" está bloqueado y no aparece para Médico'
    );
    assert(
      !resDetalleMedico.text.includes(process.env.IMECF_API_KEY),
      'La clave IMECF_API_KEY jamás se expone en el HTML enviado al navegador'
    );

    const resEcfMedico = await request(appUrl, `/ecf`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(
      resEcfMedico.status === 403,
      'Médico queda estrictamente bloqueado al intentar entrar por URL a /ecf (HTTP 403)'
    );

    const resFacturaMedico = await request(appUrl, `/ecf/factura/${consultaIdReal}`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(
      resFacturaMedico.status === 403,
      'Médico queda estrictamente bloqueado al intentar entrar por URL a /ecf/factura/:id (HTTP 403)'
    );

    const resModuloSecretaria = await request(appUrl, `/ecf`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resModuloSecretaria.status === 200,
      'Secretaría puede acceder a la lista general de facturación /ecf'
    );
    assert(
      !resModuloSecretaria.text.includes('IMECF_API_KEY') &&
        !resModuloSecretaria.text.includes('Verificar Clave y Ambiente IMECF'),
      'En Secretaría se eliminan avisos técnicos, nombre de variable IMECF_API_KEY y botón de verificación'
    );

    const resFacturaSecretaria = await request(appUrl, `/ecf/factura/${consultaIdReal}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resFacturaSecretaria.status === 200 && resFacturaSecretaria.text.includes('Emitir e-CF'),
      'Secretaría puede acceder a la factura fiscal (/ecf/factura/:id) sin ver diagnósticos clínicos'
    );

    const resFarmaciaBloqueada = await request(appUrl, `/ecf/factura/${consultaIdReal}`, {
      headers: { Cookie: farmaciaAuth.cookie },
    });
    assert(
      resFarmaciaBloqueada.status === 403,
      'Usuario no autorizado para facturación (FARMACIA) recibe HTTP 403 al intentar acceder a /ecf'
    );

    // =========================================================================
    // BLOQUE 3: FLUJO DE SECRETARÍA (COBRO -> EMISIÓN REAL IMECF) Y NO SIMULACIÓN
    // =========================================================================
    console.log('\n3. Probando flujo de Secretaría: bloqueo sin cobro, registro de cobro, emisión real IMECF y rechazo de simulación...');

    // 3A. Poner factura como Pendiente de cobro y verificar que exige registrar cobro antes de emitir al contado
    await db.query(`UPDATE consultas SET estado_pago = 'Pendiente' WHERE id = $1`, [consultaIdReal]);

    const resSinCobro = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        tipo_pago: '1',
        forma_pago: '1',
        formato_respuesta: 'json',
      },
    });
    assert(
      resSinCobro.status === 400 && resSinCobro.json?.codigo === 'COBRO_REQUERIDO',
      'El sistema exige registrar el cobro antes de emitir un comprobante al contado'
    );

    // 3B. Secretaría registra el cobro de la factura
    const resCobro = await request(appUrl, `/ecf/factura/${consultaIdReal}/registrar-cobro`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        metodo_pago: 'Efectivo',
        formato_respuesta: 'json',
      },
    });
    assert(
      resCobro.status === 200 && resCobro.json?.estado_pago === 'Pagado',
      'El usuario de Secretaría puede registrar el cobro de la factura antes de emitir el comprobante'
    );

    // 3C. Verificar que si falta IMECF_API_KEY no simula ni inventa comprobantes
    process.env.IMECF_API_KEY = '';
    process.env.ECF_API_KEY = '';
    const resSinKey = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        formato_respuesta: 'json',
      },
    });
    assert(
      resSinKey.status === 503 &&
        resSinKey.json?.codigo === 'ECF_NOT_CONFIGURED' &&
        resSinKey.json?.error === 'La integración de comprobantes está pendiente de configuración. Contacte al administrador.',
      'Si falta credencial en .env, detiene la emisión con HTTP 503 y "La integración de comprobantes está pendiente de configuración. Contacte al administrador."'
    );
    process.env.IMECF_API_KEY = 'ecf_live_clave_prueba_unitaria_segura_999';
    process.env.ECF_API_KEY = 'ecf_live_clave_prueba_unitaria_segura_999';

    // 3D. Verificar que no se permite enviar modo_simulacion en el flujo real
    const resIntentoSim = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        modo_simulacion: 'true',
        formato_respuesta: 'json',
      },
    });
    assert(
      resIntentoSim.status === 400 && resIntentoSim.json?.codigo === 'SIMULACION_NO_PERMITIDA_EN_EMISION_REAL',
      'El endpoint de emisión real rechaza solicitudes de simulación'
    );

    // 3E. Secretaría emite el comprobante real vía IMECF después de registrar el cobro
    mockNextBehavior = 'SUCCESS';
    const resEmitir = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E31',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        rnc_comprador: '00112345678',
        razon_social_comprador: 'Carlos Martínez Pérez',
        tipo_pago: '1',
        forma_pago: '1',
        formato_respuesta: 'json',
      },
    });

    assert(resEmitir.status === 201 && resEmitir.json?.success === true, 'Secretaría emite comprobante E31 vía IMECF exitosamente después del cobro (HTTP 201)');
    assert(
      lastReceivedHeaders['x-api-key'] === process.env.IMECF_API_KEY &&
        lastReceivedHeaders['content-type']?.includes('application/json'),
      'Nuestro backend envía los encabezados X-API-Key (desde IMECF_API_KEY) y Content-Type: application/json hacia IMECF'
    );

    const compEmitido = resEmitir.json.comprobante;
    assert(
      compEmitido.ecf_id_externo &&
        !compEmitido.ecf_id_externo.startsWith('sim-') &&
        compEmitido.encf === 'E310000000045' &&
        compEmitido.tipo_ecf === 'E31' &&
        compEmitido.estado === 'PENDIENTE_ENVIO_AL_SERVICIO_DGII' &&
        compEmitido.track_id &&
        !compEmitido.track_id.startsWith('trk-sim-') &&
        compEmitido.codigo_seguridad === 'A9F4K2' &&
        compEmitido.ambiente === 'TesteCF' &&
        compEmitido.modo_simulacion === false,
      'Se guarda la respuesta real de IMECF sin prefijos sim- ni trk-sim- y con el estado real devuelto por el proveedor'
    );

    // Prueba de prevención de emisiones duplicadas
    const resDuplicado = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E31',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        rnc_comprador: '00112345678',
        razon_social_comprador: 'Carlos Martínez Pérez',
        formato_respuesta: 'json',
      },
    });
    assert(
      resDuplicado.status === 409 && resDuplicado.json?.codigo === 'DUPLICADO_BLOQUEADO',
      'Control persistente en BD bloquea emisiones duplicadas para la misma factura (HTTP 409)'
    );

    // Prueba de consulta de estado: GET /api/v1/ecf/{id}/status
    const resStatus = await request(appUrl, `/ecf/documento/${compEmitido.id}/consultar-estado`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
    });
    assert(
      resStatus.status === 200 && resStatus.json?.comprobante?.estado === 'En Proceso',
      'Consulta de estado (GET /api/v1/ecf/{id}/status) actualiza y muestra el estado real devuelto por IMECF ("En Proceso")'
    );

    // Prueba de consulta de track DGII: GET /api/v1/ecf/{id}/track
    const resTrack = await request(appUrl, `/ecf/documento/${compEmitido.id}/consultar-track`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
    });
    assert(
      resTrack.status === 200 && resTrack.json?.comprobante?.estado === 'Aceptado',
      'Consulta de trackId (GET /api/v1/ecf/{id}/track) actualiza el estado cuando la DGII acepta el comprobante ("Aceptado")'
    );

    // Prueba de Representación Impresa Real vs Vista de Demostración Local
    const resRiReal = await request(appUrl, `/ecf/documento/${compEmitido.id}/impresion`, {
      method: 'GET',
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resRiReal.status === 200 &&
        resRiReal.text.includes('COMPROBANTE TRANSMITIDO REALMENTE VÍA IMECF') &&
        resRiReal.text.includes('E310000000045'),
      'La Representación Impresa del documento emitido indica claramente que fue transmitido a IMECF con su eNCF y TrackId reales'
    );

    const resDemoLocal = await request(appUrl, `/ecf/factura/${consultaIdReal}/demo-impresion`, {
      method: 'GET',
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resDemoLocal.status === 404,
      'La antigua Vista de Demostración (sin validez fiscal) ya no está disponible'
    );

    // Prueba de descarga de XML firmado vía backend: GET /api/v1/ecf/{id}/xml
    const resXml = await request(appUrl, `/ecf/documento/${compEmitido.id}/xml`, {
      method: 'GET',
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resXml.status === 200 &&
        resXml.headers['content-type']?.includes('xml') &&
        resXml.text.includes('<eNCF>E310000000045</eNCF>') &&
        !resXml.text.includes(process.env.IMECF_API_KEY),
      'Descarga de XML firmado pasa por nuestro backend conservando privada la clave IMECF_API_KEY'
    );

    // =========================================================================
    // BLOQUE 4: MANEJO DE TIMEOUT INCIERTO, CONCILIACIÓN Y ERRORES DE API
    // =========================================================================
    console.log('\n4. Probando manejo de Timeout incierto, conciliación y errores de configuración/autenticación...');

    await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaIdReal]);
    mockImecfStore.clear();

    // 4A. Simular timeout de red en POST /api/v1/ecf/send
    mockNextBehavior = 'TIMEOUT';
    const resTimeout = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        formato_respuesta: 'json',
      },
    });

    assert(
      resTimeout.status === 504 &&
        resTimeout.json?.incierto === true &&
        resTimeout.json?.comprobante?.estado === 'INCIERTO_TIMEOUT',
      'Cuando ocurre un timeout durante el envío, el resultado se conserva como INCIERTO_TIMEOUT'
    );

    const idIncierto = resTimeout.json.comprobante.id;

    // 4B. Intentar reenviar sin conciliar primero -> Debe bloquearse
    mockNextBehavior = 'SUCCESS';
    const resReenvioSinConciliar = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        formato_respuesta: 'json',
      },
    });
    assert(
      resReenvioSinConciliar.status === 409 &&
        resReenvioSinConciliar.json?.codigo === 'INCIERTO_TIMEOUT_PENDIENTE_CONCILIACION',
      'El sistema impide reenviar una factura con estado INCIERTO_TIMEOUT hasta que sea conciliada'
    );

    // 4C. Conciliar el comprobante incierto con IMECF
    const resConciliar = await request(appUrl, `/ecf/documento/${idIncierto}/conciliar`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: { formato_respuesta: 'json' },
    });
    assert(
      resConciliar.status === 200 &&
        resConciliar.json?.reconciled === true &&
        resConciliar.json?.comprobante?.estado === 'ANULADO',
      'La conciliación verifica en IMECF que el envío con timeout no se procesó y libera la factura para reenvío seguro'
    );

    // 4D. Probar error de configuración (falta certificado .p12 o secuencia en IMECF)
    mockNextBehavior = 'CONFIG_ERROR';
    const resConfigErr = await request(appUrl, `/ecf/factura/${consultaIdReal}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'TOTAL',
        formato_respuesta: 'json',
      },
    });
    assert(
      resConfigErr.status === 400 &&
        resConfigErr.json?.tipo === 'ERROR_CONFIGURACION' &&
        resConfigErr.json?.error.includes('certificado digital'),
      'Maneja error de configuración (falta de certificado/secuencias en IMECF) con mensaje claro y sin simular éxito'
    );

    // 4E. Verificar endpoint de comprobación de clave: restringido a Administrador
    mockNextBehavior = 'SUCCESS';
    const resVerifSecretaria = await request(appUrl, `/ecf/verificar-conexion`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: { formato_respuesta: 'json' },
    });
    assert(
      resVerifSecretaria.status === 403,
      'Secretaría no tiene permiso para /ecf/verificar-conexion (restringido a Administración, HTTP 403)'
    );

    const resVerifAdmin = await request(appUrl, `/ecf/verificar-conexion`, {
      method: 'POST',
      headers: {
        Cookie: adminAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': adminAuth.csrfToken,
      },
      body: { formato_respuesta: 'json' },
    });
    assert(
      resVerifAdmin.status === 200 &&
        resVerifAdmin.json?.success === true &&
        resVerifAdmin.json?.ambienteDetectado === 'TesteCF',
      'Administración puede verificar la clave IMECF_API_KEY y ambiente con /ecf/verificar-conexion (HTTP 200)'
    );

    // =========================================================================
    // BLOQUE 5: VERIFICACIÓN PAYPAL SANDBOX Y MODELO IA DE FARMACIA
    // =========================================================================
    console.log('\n5. Verificando Widget PayPal en modo Sandbox y Módulo IA de Inventario Farmacia...');

    // 5A. Widget de PayPal en factura pendiente
    await db.query(`UPDATE consultas SET estado_pago = 'Pendiente' WHERE id = $1`, [consultaIdReal]);
    const resFacturaPaypal = await request(appUrl, `/ecf/factura/${consultaIdReal}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resFacturaPaypal.text.includes('Modo Prueba (Sandbox)') &&
        resFacturaPaypal.text.includes('Pagar copago con PayPal'),
      'El botón de pago PayPal muestra "Pagar copago con PayPal" en Modo Prueba (Sandbox) sin cobrar dinero real'
    );

    // 5B. Inventario de farmacia con IA
    const farmaciaIaService = require('../src/services/farmaciaIaService');
    const estimaciones = await farmaciaIaService.obtenerEstimacionDemandaInventario({ ventanaDias: 30 });
    assert(
      estimaciones && Array.isArray(estimaciones.estimaciones),
      'El servicio de IA de farmacia calcula estimaciones y sugerencias de abastecimiento'
    );
    assert(
      estimaciones.avisoConsultivo &&
        estimaciones.avisoConsultivo.includes('La IA no modifica el inventario ni crea órdenes de compra automáticamente'),
      'La IA de inventario es estrictamente consultiva y aclara que no modifica inventario ni genera compras automáticamente'
    );

    const resVistaFarmacia = await request(appUrl, '/farmacia/inventario', {
      headers: { Cookie: farmaciaAuth.cookie },
    });
    assert(
      resVistaFarmacia.status === 200 &&
        // La sección de IA llega plegada y sin resultados: solo se despliega y calcula al pulsar "Consultar IA"
        /id="seccionIa"/.test(resVistaFarmacia.text) &&
        /class="collapse[^"]*" id="seccionIa"/.test(resVistaFarmacia.text) &&
        /id="iaEstadoResultados" class="d-none"/.test(resVistaFarmacia.text) &&
        resVistaFarmacia.text.includes('id="btnConsultarIa"'),
      'La vista de inventario no ejecuta la IA al cargar: la sección llega plegada hasta pulsar "Consultar IA"'
    );

    // Verificar comportamiento entrando con perfil de administrador
    const resVistaAdmin = await request(appUrl, '/farmacia/inventario', {
      headers: { Cookie: adminAuth.cookie },
    });
    assert(
      resVistaAdmin.status === 200 &&
        /class="collapse[^"]*" id="seccionIa"/.test(resVistaAdmin.text) &&
        resVistaAdmin.text.includes('id="btnConsultarIa"'),
      'Administrador accede a farmacia y la IA permanece en espera sin ejecutarse automáticamente al cargar'
    );

    const resEndpointIaJson = await request(appUrl, '/farmacia/inventario/ia-estimaciones?dias=30', {
      headers: { Cookie: adminAuth.cookie },
    });
    assert(
      resEndpointIaJson.status === 200 &&
        resEndpointIaJson.json?.success === true &&
        Array.isArray(resEndpointIaJson.json?.estimaciones),
      'El botón "Consultar IA" invoca el endpoint JSON y retorna las estimaciones con análisis de fiabilidad'
    );

    // Restaurar estado original de la consulta y limpiar registros de prueba
    await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaIdReal]);
    await db.query(`UPDATE consultas SET estado_pago = $1 WHERE id = $2`, [estadoPagoOriginal, consultaIdReal]);
  } finally {
    appServer.close();
    mockImecfServer.close();
    await db.pool.end();
  }

  console.log('\n================================================================');
  console.log(`📊 RESULTADO DE PRUEBAS IMECF: ${passed} exitosas, ${failed} fallidas`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Error ejecutando pruebas e-CF:', err);
  process.exit(1);
});
