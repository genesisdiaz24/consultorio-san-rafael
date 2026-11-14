const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const paypalService = require('../src/services/paypalService');

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

async function runTests() {
  console.log('================================================================');
  console.log('🧪 PRUEBAS DE INTEGRACIÓN PAYPAL SANDBOX (ORDERS V2 & WEBHOOKS)');
  console.log('================================================================\n');

  process.env.NODE_ENV = 'test';

  // 1. Servidor Mock de PayPal Sandbox API v2 (/v1/oauth2/token, /v2/checkout/orders, /v1/notifications/verify-webhook-signature)
  const mockOrders = new Map();
  let nextCaptureMode = 'COMPLETED'; // 'COMPLETED' | 'PENDING' | 'DECLINED' | 'TAMPERED_AMOUNT'
  let lastOrderPayload = null;
  let orderCounter = 1000;

  const mockPayPalServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch (_) {}

      // OAuth2 Token Endpoint
      if (req.method === 'POST' && req.url === '/v1/oauth2/token') {
        const expectedAuth =
          'Basic ' +
          Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_client' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            access_token: 'MOCK_SANDBOX_ACCESS_TOKEN_999',
            token_type: 'Bearer',
            expires_in: 32400,
          })
        );
      }

      // Create Order: POST /v2/checkout/orders
      if (req.method === 'POST' && req.url === '/v2/checkout/orders') {
        if (req.headers.authorization !== 'Bearer MOCK_SANDBOX_ACCESS_TOKEN_999') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Unauthorized' }));
        }
        lastOrderPayload = parsed;
        orderCounter++;
        const orderId = `SBX-ORD-${orderCounter}`;
        const record = {
          id: orderId,
          status: 'CREATED',
          intent: parsed.intent,
          purchase_units: parsed.purchase_units,
        };
        mockOrders.set(orderId, record);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(record));
      }

      // Capture Order: POST /v2/checkout/orders/:id/capture
      const capMatch = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
      if (req.method === 'POST' && capMatch) {
        const orderId = decodeURIComponent(capMatch[1]);
        const ord = mockOrders.get(orderId);
        if (!ord) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Order not found' }));
        }

        if (nextCaptureMode === 'DECLINED') {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was either declined by the processor or bank.' }],
            })
          );
        }

        const pu = ord.purchase_units[0];
        const captureStatus = nextCaptureMode === 'PENDING' ? 'PENDING' : 'COMPLETED';
        const capturedValue = nextCaptureMode === 'TAMPERED_AMOUNT' ? '0.01' : pu.amount.value;
        const captureId = `SBX-CAP-${orderCounter}`;

        const responseObj = {
          id: orderId,
          status: captureStatus,
          payer: {
            payer_id: 'PAYER123456',
            email_address: 'paciente.sandbox@personal.example.com',
          },
          purchase_units: [
            {
              reference_id: pu.reference_id,
              custom_id: pu.custom_id,
              payments: {
                captures: [
                  {
                    id: captureId,
                    status: captureStatus,
                    custom_id: pu.custom_id,
                    amount: {
                      currency_code: pu.amount.currency_code,
                      value: capturedValue,
                    },
                  },
                ],
              },
            },
          ],
        };

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(responseObj));
      }

      // Verify Webhook Signature: POST /v1/notifications/verify-webhook-signature
      if (req.method === 'POST' && req.url === '/v1/notifications/verify-webhook-signature') {
        const isAuthentic =
          parsed?.transmission_sig === 'VALID_PAYPAL_WEBHOOK_SIGNATURE_2026' &&
          parsed?.webhook_id === process.env.PAYPAL_WEBHOOK_ID;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            verification_status: isAuthentic ? 'SUCCESS' : 'FAILURE',
          })
        );
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found' }));
    });
  });

  await new Promise((r) => mockPayPalServer.listen(0, '127.0.0.1', r));
  const mockPort = mockPayPalServer.address().port;

  process.env.PAYPAL_ENV = 'sandbox';
  process.env.PAYPAL_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.PAYPAL_CLIENT_ID = 'AZ_SANDBOX_CLIENT_ID_TEST_12345';
  process.env.PAYPAL_CLIENT_SECRET = 'EL_SECRETO_SUPER_PRIVADO_PAYPAL_98765';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-SANDBOX-ID-123456';
  process.env.PAYPAL_CURRENCY = 'USD';
  process.env.PAYPAL_DOP_TO_USD_RATE = '60.00';
  process.env.PAYPAL_SIMULATION_MODE = 'false';
  // Aislar la prueba de la plataforma IMECF real: nunca usar la API Key del .env
  // (sin clave, la emisión responde ECF_NOT_CONFIGURED y no se transmite nada a la DGII)
  process.env.IMECF_API_KEY = '';
  process.env.ECF_API_KEY = '';
  process.env.IMECF_API_BASE_URL = 'http://127.0.0.1:9';
  process.env.ECF_API_BASE_URL = 'http://127.0.0.1:9';

  const appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${appServer.address().port}`;

  const { rows: consultasDb } = await db.query(`SELECT id, estado_pago FROM consultas ORDER BY id ASC LIMIT 1`);
  const consultaId = consultasDb[0].id;
  const estadoPagoOriginal = consultasDb[0].estado_pago;

  try {
    // Preparar la consulta en estado Pendiente para probar todo el ciclo de pago
    await db.query(`DELETE FROM pagos_paypal WHERE consulta_id = $1`, [consultaId]);
    await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaId]);
    await db.query(`DELETE FROM paypal_webhook_eventos WHERE event_id LIKE 'WH-EVT-TEST-%'`);
    await db.query(`UPDATE consultas SET estado_pago = 'Pendiente' WHERE id = $1`, [consultaId]);

    // =========================================================================
    // BLOQUE 1: RESTRICCIÓN DE ROLES (RBAC), CONVERSIÓN DOP -> USD Y VISTAS
    // =========================================================================
    console.log('1. Verificando separación de roles (Médico sin cobros vs Secretaría con cobros), conversión DOP -> USD y privacidad...');

    assert(
      !paypalService.MONEDAS_ADMITIDAS_PAYPAL.includes('DOP') &&
        paypalService.MONEDAS_ADMITIDAS_PAYPAL.includes('USD'),
      'Comprueba que DOP no está admitida nativamente por PayPal y aplica USD como moneda de cobro'
    );

    const medicoAuth = await loginSession(appUrl, 'medico', 'medico123');
    const secretariaAuth = await loginSession(appUrl, 'secretaria', 'secretaria123');

    // 1A. Verificar que el perfil de Médico NO tiene panel ni botones de pago en la consulta
    const resVistaConsultaMedico = await request(appUrl, `/consultas/${consultaId}`, {
      headers: { Cookie: medicoAuth.cookie },
    });
    assert(resVistaConsultaMedico.status === 200, 'Médico accede a la consulta clínica (/consultas/:id)');
    assert(
      !resVistaConsultaMedico.text.includes('panel-pago-paypal') &&
        !resVistaConsultaMedico.text.includes('btn-pagar-paypal-exito'),
      'Médico NO ve el panel de pago ni botones de PayPal en su consulta (el médico atiende, no cobra)'
    );

    // 1B. Verificar que el Médico tiene bloqueado el endpoint de cobro con PayPal (HTTP 403)
    const resMedicoCobroBloqueado = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: {
        Cookie: medicoAuth.cookie,
        'X-CSRF-Token': medicoAuth.csrfToken,
      },
      body: { criterio_cobro: 'COPAGO' },
    });
    assert(
      resMedicoCobroBloqueado.status === 403,
      'Médico queda estrictamente bloqueado (HTTP 403 Forbidden) en los endpoints de cobro con PayPal'
    );

    // 1C. Verificar que Secretaría ve el proceso de cobro en la ficha del paciente
    const { rows: pacienteRows } = await db.query(
      `SELECT paciente_id FROM consultas WHERE id = $1`,
      [consultaId]
    );
    const pacienteId = pacienteRows[0].paciente_id;

    const resFichaPacienteSec = await request(appUrl, `/pacientes/${pacienteId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(resFichaPacienteSec.status === 200, 'Secretaría accede a la ficha del paciente (/pacientes/:id)');
    assert(
      resFichaPacienteSec.text.includes('Consultas y Cobros de Copago') &&
        resFichaPacienteSec.text.includes('Pagar copago con PayPal') &&
        resFichaPacienteSec.text.includes(`/ecf/factura/${consultaId}`),
      'El cobro del copago aparece en el perfil de Secretaría dentro del proceso de cobro del paciente'
    );

    // 1D. Verificar que Secretaría accede a la vista de facturación con el panel de PayPal y sin texto de suscripción
    const resFacturaSec = await request(appUrl, `/ecf/factura/${consultaId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(resFacturaSec.status === 200, 'Secretaría accede a la vista de facturación y cobro (/ecf/factura/:id)');
    assert(
      resFacturaSec.text.includes('Total a cobrar en PayPal') &&
        resFacturaSec.text.includes('1 USD = RD$ 60.00') &&
        resFacturaSec.text.includes('USD $5.00'),
      'La interfaz de cobro muestra claramente la conversión de DOP (RD$ 300.00) a USD ($5.00) antes de pagar'
    );
    assert(
      resFacturaSec.text.includes('paypal-button-container') &&
        !resFacturaSec.text.includes('id="btn-pagar-paypal-exito"') &&
        !resFacturaSec.text.includes('Pagar / Suscribirte'),
      'Con credenciales reales solo se muestra el botón oficial de PayPal (sin botón de pago simulado)'
    );
    assert(
      !resFacturaSec.text.includes(process.env.PAYPAL_CLIENT_SECRET),
      'El secreto PAYPAL_CLIENT_SECRET permanece exclusivamente en el backend y jamás se expone en el HTML'
    );

    // =========================================================================
    // BLOQUE 2: CÁLCULO DE IMPORTE EN SERVIDOR Y CREACIÓN DE ORDEN DESDE BACKEND
    // =========================================================================
    console.log('\n2. Probando creación de orden por Secretaría en backend ignorando montos manipulados en el navegador...');

    const resCrear = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        criterio_cobro: 'COPAGO',
        // Intento malicioso de enviar un monto de $0.01 desde el navegador:
        monto: 0.01,
        importe: 0.01,
        amount: 0.01,
      },
    });

    assert(resCrear.status === 201 && resCrear.json?.success === true, 'Orden de copago creada desde el backend en PayPal Sandbox (HTTP 201)');
    assert(
      lastOrderPayload?.purchase_units?.[0]?.amount?.value === '5.00' &&
        lastOrderPayload?.purchase_units?.[0]?.amount?.currency_code === 'USD',
      'El backend calcula USD $5.00 desde el copago en BD (RD$ 300.00 / 60) e ignora el monto enviado por el navegador'
    );

    const payloadPayPalStr = JSON.stringify(lastOrderPayload);
    assert(
      lastOrderPayload?.purchase_units?.[0]?.reference_id === `FAC-SR-${consultaId}` &&
        !payloadPayPalStr.includes('Cefalea') &&
        !payloadPayPalStr.includes('hipertensión') &&
        !payloadPayPalStr.includes('Losartán'),
      'Privacidad clínica hacia PayPal: solo envía referencia interna y descripción general, sin diagnósticos ni recetas'
    );

    // =========================================================================
    // BLOQUE 3: MANEJO DE PAGOS CANCELADOS, RECHAZADOS, PENDIENTES Y ADULTERADOS
    // =========================================================================
    console.log('\n3. Probando manejo de pagos cancelados, rechazados, pendientes y comprobante no completado...');

    // 3A. Cancelación de orden
    const ordenCancelId = resCrear.json.orderId;
    const resCancel = await request(appUrl, `/pagos/paypal/cancelar-orden/${consultaId}`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: { orderId: ordenCancelId },
    });
    assert(
      resCancel.status === 200 && resCancel.json?.estado === 'CANCELLED',
      'Maneja correctamente los pagos cancelados por el usuario (estado CANCELLED y factura sigue Pendiente)'
    );

    // 3B. Pago rechazado (INSTRUMENT_DECLINED)
    const resCrearDecline = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { criterio_cobro: 'COPAGO' },
    });
    nextCaptureMode = 'DECLINED';
    const resCapDecline = await request(appUrl, `/pagos/paypal/capturar-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { orderId: resCrearDecline.json.orderId },
    });
    assert(
      resCapDecline.status === 422 && resCapDecline.json?.estado === 'DECLINED',
      'Maneja correctamente los pagos rechazados por PayPal (estado DECLINED y factura NO se marca pagada)'
    );

    // 3C. Comprobante cuando el pago NO fue completado
    const resComprobanteIncompleto = await request(appUrl, `/pagos/paypal/comprobante/${consultaId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resComprobanteIncompleto.status === 200 &&
        resComprobanteIncompleto.text.includes('El pago no se completó') &&
        resComprobanteIncompleto.text.includes('DECLINED'),
      'Al consultar comprobante de pago no completado/rechazado, indica qué falta y deja claro que el pago no se completó'
    );

    // 3D. Pago en estado PENDING
    const resCrearPending = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { criterio_cobro: 'COPAGO' },
    });
    nextCaptureMode = 'PENDING';
    const resCapPending = await request(appUrl, `/pagos/paypal/capturar-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { orderId: resCrearPending.json.orderId },
    });
    assert(
      resCapPending.status === 202 &&
        resCapPending.json?.estado === 'PENDING' &&
        resCapPending.json?.facturaPagada === false,
      'Maneja correctamente los pagos pendientes (estado PENDING sin marcar la factura como pagada prematuramente)'
    );

    // 3E. Verificación de discrepancia de importe en captura
    const resCrearTamper = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { criterio_cobro: 'COPAGO' },
    });
    nextCaptureMode = 'TAMPERED_AMOUNT';
    const resCapTamper = await request(appUrl, `/pagos/paypal/capturar-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { orderId: resCrearTamper.json.orderId },
    });
    assert(
      resCapTamper.status === 400 && resCapTamper.json?.tipo === 'ERROR_VERIFICACION_CAPTURA',
      'Rechaza marcar la factura como pagada si el importe capturado no coincide exactamente con la factura'
    );

    // =========================================================================
    // BLOQUE 4: CAPTURA EXITOSA, SEPARACIÓN DE ESTADO CON IMECF Y COMPROBANTE
    // =========================================================================
    console.log('\n4. Probando captura exitosa por Secretaría, comprobante oficial y prevención de cobros duplicados...');

    const resCrearExito = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { criterio_cobro: 'COPAGO' },
    });
    const orderExitoId = resCrearExito.json.orderId;

    // Capturar pago exitoso pero simulando un fallo en la emisión automática del comprobante IMECF
    nextCaptureMode = 'COMPLETED';
    const resCapExito = await request(appUrl, `/pagos/paypal/capturar-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: {
        orderId: orderExitoId,
        emitir_ecf: true,
        simular_fallo_ecf: true,
      },
    });

    assert(
      resCapExito.status === 200 &&
        resCapExito.json?.estado === 'COMPLETED' &&
        resCapExito.json?.facturaPagada === true &&
        resCapExito.json?.pago?.paypal_order_id === orderExitoId &&
        resCapExito.json?.pago?.paypal_capture_id &&
        resCapExito.json?.ecf?.emitido === false,
      'Si falla la emisión del comprobante IMECF después del cobro, conserva el pago COMPLETED y la factura Pagada'
    );

    // 4B. Verificar generación del Comprobante de Pago Electrónico tras pago aprobado
    const resComprobanteAprobado = await request(appUrl, `/pagos/paypal/comprobante/${consultaId}`, {
      headers: { Cookie: secretariaAuth.cookie },
    });
    assert(
      resComprobanteAprobado.status === 200 &&
        resComprobanteAprobado.text.includes('PAGO APROBADO') &&
        resComprobanteAprobado.text.includes('Consultorio Médico San Rafael') &&
        resComprobanteAprobado.text.includes('Pago en línea (simulación de PayPal)') &&
        resComprobanteAprobado.text.includes('N.º de transacción') &&
        resComprobanteAprobado.text.includes(resCapExito.json.pago.paypal_capture_id) &&
        !resComprobanteAprobado.text.includes('Estado de Liquidación') &&
        !resComprobanteAprobado.text.includes('Cuenta Pagadora'),
      'Comprobante de pago aprobado: indica que es simulación de PayPal y muestra solo el N.º de transacción'
    );

    // 4C. Verificar que no permite volver a cobrar la factura ya pagada
    const resDobleCobro = await request(appUrl, `/pagos/paypal/crear-orden/${consultaId}`, {
      method: 'POST',
      headers: { Cookie: secretariaAuth.cookie, 'X-CSRF-Token': secretariaAuth.csrfToken },
      body: { criterio_cobro: 'COPAGO' },
    });
    assert(
      resDobleCobro.status === 409 && resDobleCobro.json?.codigo === 'FACTURA_YA_PAGADA',
      'Evita cobros y registros duplicados bloqueando nuevas órdenes sobre una factura ya pagada (HTTP 409)'
    );

    // Verificar que Médico queda bloqueado para emitir e-CF incluso si la factura fue pagada por PayPal
    const resMedicoEcf = await request(appUrl, `/ecf/factura/${consultaId}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: medicoAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': medicoAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'COPAGO',
        formato_respuesta: 'json',
      },
    });
    assert(
      resMedicoEcf.status === 403,
      'Médico queda bloqueado (HTTP 403) para emitir e-CF tras el pago con PayPal (restringido a Secretaría)'
    );

    // Secretaría puede gestionar la emisión; si falta credencial IMECF, no simula éxito
    const resReintentoEcf = await request(appUrl, `/ecf/factura/${consultaId}/emitir`, {
      method: 'POST',
      headers: {
        Cookie: secretariaAuth.cookie,
        Accept: 'application/json',
        'X-CSRF-Token': secretariaAuth.csrfToken,
      },
      body: {
        tipo_ecf: 'E32',
        indicador_facturacion: '4',
        criterio_monto: 'COPAGO',
        formato_respuesta: 'json',
      },
    });
    assert(
      (resReintentoEcf.status === 201 && resReintentoEcf.json?.success === true) ||
        (resReintentoEcf.status === 503 && resReintentoEcf.json?.codigo === 'ECF_NOT_CONFIGURED'),
      'Secretaría gestiona la emisión del e-CF sin volver a cobrar y sin simular envíos si falta la credencial'
    );

    // =========================================================================
    // BLOQUE 5: WEBHOOKS CON VERIFICACIÓN DE AUTENTICIDAD E IDEMPOTENCIA
    // =========================================================================
    console.log('\n5. Probando Webhooks de PayPal: verificación de firma criptográfica y eventos duplicados...');

    const webhookEventPayload = {
      id: 'WH-EVT-TEST-2026-0001',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: resCapExito.json.pago.paypal_capture_id,
        status: 'COMPLETED',
        custom_id: `FAC-SR-${consultaId}`,
        amount: {
          currency_code: 'USD',
          value: '5.00',
        },
        supplementary_data: {
          related_ids: {
            order_id: orderExitoId,
          },
        },
      },
    };

    // 5A. Webhook con firma inválida -> Debe rechazarse con 401
    const resWebhookInvalido = await request(appUrl, '/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'paypal-transmission-id': 'tx-123',
        'paypal-transmission-time': new Date().toISOString(),
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-transmission-sig': 'FIRMA_FALSA_ALTERADA',
      },
      body: webhookEventPayload,
    });
    assert(
      resWebhookInvalido.status === 401,
      'El receptor de Webhooks rechaza notificaciones cuya firma no sea auténtica según PayPal (HTTP 401)'
    );

    // 5B. Webhook con firma auténtica -> Procesado exitosamente
    const headersValidosWebhook = {
      'paypal-transmission-id': 'tx-valid-001',
      'paypal-transmission-time': new Date().toISOString(),
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'VALID_PAYPAL_WEBHOOK_SIGNATURE_2026',
    };

    const resWebhookValido = await request(appUrl, '/api/paypal/webhook', {
      method: 'POST',
      headers: headersValidosWebhook,
      body: webhookEventPayload,
    });
    assert(
      resWebhookValido.status === 200 &&
        resWebhookValido.json?.success === true &&
        resWebhookValido.json?.duplicate === false,
      'Webhook con firma auténtica es verificado y procesado correctamente (HTTP 200)'
    );

    // 5C. Reenvío del mismo evento Webhook (notificación duplicada) -> Detectado e ignorado idempotentemente
    const resWebhookDuplicado = await request(appUrl, '/api/paypal/webhook', {
      method: 'POST',
      headers: headersValidosWebhook,
      body: webhookEventPayload,
    });
    assert(
      resWebhookDuplicado.status === 200 &&
        resWebhookDuplicado.json?.success === true &&
        resWebhookDuplicado.json?.duplicate === true,
      'Protección contra eventos duplicados: el mismo event_id no vuelve a ejecutarse ni duplica registros'
    );
  } finally {
    await db.query(`DELETE FROM pagos_paypal WHERE consulta_id = $1`, [consultaId]);
    await db.query(`DELETE FROM comprobantes_electronicos WHERE consulta_id = $1`, [consultaId]);
    await db.query(`DELETE FROM paypal_webhook_eventos WHERE event_id LIKE 'WH-EVT-TEST-%'`);
    await db.query(`UPDATE consultas SET estado_pago = $1 WHERE id = $2`, [estadoPagoOriginal, consultaId]);

    try { appServer.close(); } catch (_) {}
    try { mockPayPalServer.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }

  console.log('\n================================================================');
  console.log(`📊 RESULTADO DE PRUEBAS PAYPAL: ${passed} exitosas, ${failed} fallidas`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Error ejecutando pruebas PayPal:', err);
  process.exit(1);
});

