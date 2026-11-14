const crypto = require('crypto');

const PAYPAL_SANDBOX_URL = 'https://api-m.sandbox.paypal.com';
const PAYPAL_LIVE_URL = 'https://api-m.paypal.com';

/**
 * Monedas admitidas oficialmente por PayPal REST API v2 (Orders/Captures).
 * Nota: DOP (Peso Dominicano) NO está admitido nativamente por PayPal REST API,
 * por lo que las facturas en DOP se convierten de forma transparente a USD antes de cobrar.
 */
const MONEDAS_ADMITIDAS_PAYPAL = [
  'USD',
  'EUR',
  'CAD',
  'GBP',
  'AUD',
  'JPY',
  'MXN',
  'BRL',
  'CHF',
  'HKD',
  'NZD',
  'SEK',
  'SGD',
];

function redondear2(valor) {
  const num = Number(valor);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function formatearMonto2(valor) {
  return redondear2(valor).toFixed(2);
}

/**
 * Obtiene la configuración de PayPal desde las variables de entorno privadas del servidor.
 * PAYPAL_CLIENT_SECRET jamás sale del backend.
 */
function obtenerConfiguracionPayPal() {
  const env = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
  const defaultBaseUrl = env === 'live' ? PAYPAL_LIVE_URL : PAYPAL_SANDBOX_URL;
  const baseUrl = (process.env.PAYPAL_API_BASE_URL || defaultBaseUrl).replace(/\/+$/, '');

  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const webhookId = String(process.env.PAYPAL_WEBHOOK_ID || '').trim();

  const monedaConfigurada = String(process.env.PAYPAL_CURRENCY || 'USD').trim().toUpperCase();
  const monedaCobro = MONEDAS_ADMITIDAS_PAYPAL.includes(monedaConfigurada) ? monedaConfigurada : 'USD';

  const tasaCambioRaw = parseFloat(process.env.PAYPAL_DOP_TO_USD_RATE);
  const tasaCambioDop = Number.isFinite(tasaCambioRaw) && tasaCambioRaw > 0 ? redondear2(tasaCambioRaw) : 60.0;

  const credencialesPlaceholder =
    !clientId ||
    !clientSecret ||
    clientId === 'COLOCAR_PAYPAL_CLIENT_ID_SANDBOX' ||
    clientSecret === 'COLOCAR_PAYPAL_CLIENT_SECRET_SANDBOX' ||
    clientId.includes('FICTICIO') ||
    clientSecret.includes('FICTICIO') ||
    clientId.includes('EJEMPLO');

  const simulacionForzada =
    String(process.env.PAYPAL_SIMULATION_MODE || '').toLowerCase() === 'true' ||
    String(process.env.PAYPAL_SIMULATION_MODE || '') === '1';

  return {
    env,
    baseUrl,
    clientId,
    clientSecret, // Exclusivo en servidor
    webhookId,
    monedaFactura: 'DOP',
    monedaCobro,
    dopSoportadoPorPayPal: MONEDAS_ADMITIDAS_PAYPAL.includes('DOP'),
    requiereConversionMoneda: monedaCobro !== 'DOP',
    tasaCambioDop,
    tieneCredencialesReales: !credencialesPlaceholder,
    modoSimulacion: simulacionForzada || credencialesPlaceholder,
  };
}

/**
 * Sanitiza cualquier texto de error o log para no exponer PAYPAL_CLIENT_SECRET ni tokens OAuth
 */
function sanitizarTextoPayPal(texto) {
  if (!texto) return '';
  let limpio = String(texto);
  const secret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (secret && secret.length >= 5) {
    limpio = limpio.split(secret).join('[PAYPAL_SECRET_OCULTO]');
  }
  limpio = limpio.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [TOKEN_OCULTO]');
  return limpio;
}

class PayPalError extends Error {
  constructor(message, { tipo = 'PAYPAL_ERROR', statusCode = 400, codigoPayPal = null, detalle = null } = {}) {
    super(sanitizarTextoPayPal(message));
    this.name = 'PayPalError';
    this.tipo = tipo;
    this.statusCode = statusCode;
    this.codigoPayPal = codigoPayPal;
    this.detalle = detalle ? sanitizarTextoPayPal(JSON.stringify(detalle)) : null;
  }
}

/**
 * Calcula en el servidor el importe exacto desde la factura guardada en la base de datos (sin confiar en el navegador).
 * Verifica las monedas admitidas por PayPal y convierte de DOP a USD (u otra moneda admitida).
 */
function calcularImporteDesdeFactura(consulta, { criterioCobro = null } = {}) {
  if (!consulta || !consulta.id) {
    throw new PayPalError('Factura / consulta no encontrada para calcular el cobro.', {
      tipo: 'ERROR_VALIDACION',
      statusCode: 404,
    });
  }

  const config = obtenerConfiguracionPayPal();
  const valorTotalDop = redondear2(consulta.valor_total);
  const diferenciaPacienteDop = redondear2(consulta.diferencia_paciente);

  // Determinar si se cobra el copago del paciente o el valor total de la factura
  let criterioFinal = String(criterioCobro || '').trim().toUpperCase();
  if (!['COPAGO', 'TOTAL'].includes(criterioFinal)) {
    criterioFinal = diferenciaPacienteDop > 0 ? 'COPAGO' : 'TOTAL';
  }

  let montoDop = criterioFinal === 'COPAGO' && diferenciaPacienteDop > 0 ? diferenciaPacienteDop : valorTotalDop;

  if (!Number.isFinite(montoDop) || montoDop <= 0) {
    throw new PayPalError(
      'El importe pendiente de la factura en la base de datos es RD$ 0.00. No es posible generar una orden de cobro.',
      { tipo: 'ERROR_IMPORTE_INVALIDO', statusCode: 400 }
    );
  }

  const tasaCambio = config.tasaCambioDop;
  const importeConvertido = config.requiereConversionMoneda
    ? Math.max(0.01, redondear2(montoDop / tasaCambio))
    : montoDop;

  // Referencia interna única de la factura y descripción general sin ningún dato clínico
  const referenciaInterna = `FAC-SR-${consulta.id}`;
  const descripcionGeneral = `Servicios Medicos Factura #${consulta.id} - Consultorio San Rafael`;

  return {
    consultaId: Number(consulta.id),
    criterioCobro: criterioFinal,
    monedaOriginal: 'DOP',
    montoDop,
    monedaCobro: config.monedaCobro,
    tasaCambio,
    importeCobro: importeConvertido,
    importeCobroStr: formatearMonto2(importeConvertido),
    requiereConversion: config.requiereConversionMoneda,
    referenciaInterna,
    descripcionGeneral,
    explicacionConversion: config.requiereConversionMoneda
      ? `PayPal no admite pagos directos en Pesos Dominicanos (DOP). El importe de RD$ ${formatearMonto2(montoDop)} DOP se convierte a ${config.monedaCobro} aplicando la tasa de referencia 1 ${config.monedaCobro} = RD$ ${formatearMonto2(tasaCambio)} DOP (Total a pagar: ${config.monedaCobro} $${formatearMonto2(importeConvertido)}).`
      : null,
  };
}

/**
 * Construye el cuerpo oficial de PayPal Orders v2 y verifica que NO contenga información clínica
 */
function construirOrdenPayPalPayload(calculo, datosClinicosProhibidos = []) {
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: calculo.referenciaInterna,
        custom_id: calculo.referenciaInterna,
        invoice_id: `${calculo.referenciaInterna}-${Date.now()}`,
        description: calculo.descripcionGeneral,
        amount: {
          currency_code: calculo.monedaCobro,
          value: calculo.importeCobroStr,
        },
      },
    ],
    application_context: {
      brand_name: 'Consultorio Medico San Rafael',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
    },
  };

  // Verificación de privacidad médica: prohibir envío de diagnósticos, síntomas, historia clínica o recetas a PayPal
  const serializado = JSON.stringify(payload);
  const clavesProhibidas = [
    'diagnostico_clinico',
    'hallazgos_clinicos',
    'motivo_consulta',
    'tratamiento_plan',
    'signos_vitales',
    'antecedentes_revisados',
    'notas_adicionales',
  ];

  for (const clave of clavesProhibidas) {
    if (serializado.includes(clave)) {
      throw new PayPalError(`Privacidad clínica: el campo "${clave}" no puede enviarse a PayPal.`, {
        tipo: 'ERROR_PRIVACIDAD',
        statusCode: 400,
      });
    }
  }

  for (const texto of datosClinicosProhibidos) {
    const limpio = String(texto || '').trim();
    if (limpio.length >= 8 && serializado.toLowerCase().includes(limpio.toLowerCase())) {
      throw new PayPalError(
        'Privacidad clínica: se detectó información médica sensible en la solicitud hacia PayPal.',
        { tipo: 'ERROR_PRIVACIDAD', statusCode: 400 }
      );
    }
  }

  return payload;
}

/**
 * Obtiene un token OAuth 2.0 desde PayPal (/v1/oauth2/token) usando Client ID y Client Secret en el backend
 */
async function obtenerAccessToken() {
  const config = obtenerConfiguracionPayPal();
  if (!config.clientId || !config.clientSecret || config.clientSecret === 'COLOCAR_PAYPAL_CLIENT_SECRET_SANDBOX') {
    throw new PayPalError(
      'Las credenciales PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET no están configuradas en el servidor.',
      { tipo: 'ERROR_CONFIGURACION', statusCode: 503 }
    );
  }

  const credencialesBase64 = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const resp = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credencialesBase64}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new PayPalError(
      `Error de autenticación con PayPal (${resp.status}): Verifique PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET y PAYPAL_ENV.`,
      { tipo: 'ERROR_AUTENTICACION', statusCode: 401, detalle: data }
    );
  }

  return data.access_token;
}

/**
 * Crea una orden de pago en PayPal Orders v2 (POST /v2/checkout/orders) desde el backend
 */
async function crearOrdenPayPal(consulta, { criterioCobro = null, forzarSimulacion = false } = {}) {
  const config = obtenerConfiguracionPayPal();
  const calculo = calcularImporteDesdeFactura(consulta, { criterioCobro });
  const payload = construirOrdenPayPalPayload(calculo, [
    consulta.diagnostico_clinico,
    consulta.hallazgos_clinicos,
    consulta.motivo_consulta,
    consulta.tratamiento_plan,
    consulta.notas_adicionales,
  ]);

  const usarSimulacion = Boolean(forzarSimulacion || config.modoSimulacion);

  if (usarSimulacion) {
    const orderIdSim = `PAYPAL-SIM-ORD-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    return {
      modoSimulacion: true,
      ambiente: config.env,
      paypalOrderId: orderIdSim,
      estado: 'CREATED',
      calculo,
      rawResponse: {
        id: orderIdSim,
        status: 'CREATED',
        intent: 'CAPTURE',
        simulated: true,
        purchase_units: payload.purchase_units,
      },
    };
  }

  const accessToken = await obtenerAccessToken();
  const resp = await fetch(`${config.baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'PayPal-Request-Id': `ord-${calculo.referenciaInterna}-${Date.now()}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id) {
    const msg = data?.details?.[0]?.description || data?.message || `Error HTTP ${resp.status} al crear orden en PayPal.`;
    throw new PayPalError(`No se pudo crear la orden en PayPal: ${msg}`, {
      tipo: 'ERROR_CREAR_ORDEN',
      statusCode: resp.status >= 500 ? 502 : 400,
      codigoPayPal: data?.name || null,
      detalle: data,
    });
  }

  return {
    modoSimulacion: false,
    ambiente: config.env,
    paypalOrderId: data.id,
    estado: data.status || 'CREATED',
    calculo,
    rawResponse: data,
  };
}

/**
 * Verifica rigurosamente que los datos de la captura de PayPal coincidan con la factura local
 * antes de marcar la factura como Pagada.
 */
function verificarIntegridadCaptura(ordenLocal, { estadoCaptura, importeCapturado, monedaCapturada, referenciaCapturada }) {
  if (estadoCaptura !== 'COMPLETED') {
    return {
      verificada: false,
      motivo: `La captura no está en estado COMPLETED (estado actual: ${estadoCaptura}).`,
    };
  }

  const importeEsperado = redondear2(ordenLocal.importe);
  const importeRecibido = redondear2(importeCapturado);
  if (importeEsperado !== importeRecibido) {
    throw new PayPalError(
      `Discrepancia de seguridad en el importe capturado: se esperaba ${ordenLocal.moneda} ${formatearMonto2(importeEsperado)} pero PayPal reportó ${formatearMonto2(importeRecibido)}.`,
      { tipo: 'ERROR_VERIFICACION_CAPTURA', statusCode: 400 }
    );
  }

  const monedaEsperada = String(ordenLocal.moneda || '').toUpperCase();
  const monedaRecibida = String(monedaCapturada || '').toUpperCase();
  if (monedaEsperada !== monedaRecibida) {
    throw new PayPalError(
      `Discrepancia de seguridad en la moneda: se esperaba ${monedaEsperada} pero se recibió ${monedaRecibida}.`,
      { tipo: 'ERROR_VERIFICACION_CAPTURA', statusCode: 400 }
    );
  }

  const refEsperada = String(ordenLocal.referencia_interna || '').trim();
  const refRecibida = String(referenciaCapturada || '').trim();
  if (!refRecibida || refRecibida !== refEsperada) {
    throw new PayPalError(
      `Discrepancia de seguridad en la referencia de la factura: se esperaba "${refEsperada}" pero la orden pertenece a "${refRecibida || 'N/A'}".`,
      { tipo: 'ERROR_VERIFICACION_CAPTURA', statusCode: 400 }
    );
  }

  return { verificada: true };
}

/**
 * Captura una orden de PayPal desde el backend (POST /v2/checkout/orders/{id}/capture)
 * y valida estado, importe, moneda y referencia interna.
 */
async function capturarOrdenPayPal(ordenLocal, { simulacionResultado = 'COMPLETED' } = {}) {
  if (!ordenLocal || !ordenLocal.paypal_order_id) {
    throw new PayPalError('No se encontró la orden local de PayPal para capturar.', {
      tipo: 'ERROR_VALIDACION',
      statusCode: 404,
    });
  }

  const config = obtenerConfiguracionPayPal();
  const esSimulacion = Boolean(ordenLocal.modo_simulacion || String(ordenLocal.paypal_order_id).startsWith('PAYPAL-SIM-'));

  if (esSimulacion) {
    const resultadoSim = String(simulacionResultado || 'COMPLETED').toUpperCase();
    const captureIdSim = `PAYPAL-SIM-CAP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    if (resultadoSim === 'DECLINED' || resultadoSim === 'REJECTED') {
      return {
        estado: 'DECLINED',
        paypalCaptureId: null,
        payerEmail: 'comprador.sandbox@ejemplo.do',
        payerId: 'SIMPAYER001',
        importeCapturado: redondear2(ordenLocal.importe),
        monedaCapturada: ordenLocal.moneda,
        referenciaCapturada: ordenLocal.referencia_interna,
        verificadaParaMarcarPagada: false,
        mensaje: 'El pago fue rechazado por el emisor de la tarjeta o cuenta en PayPal Sandbox (INSTRUMENT_DECLINED).',
        rawResponse: {
          id: ordenLocal.paypal_order_id,
          status: 'DECLINED',
          name: 'INSTRUMENT_DECLINED',
          simulated: true,
        },
      };
    }

    if (resultadoSim === 'PENDING') {
      return {
        estado: 'PENDING',
        paypalCaptureId: captureIdSim,
        payerEmail: 'comprador.sandbox@ejemplo.do',
        payerId: 'SIMPAYER001',
        importeCapturado: redondear2(ordenLocal.importe),
        monedaCapturada: ordenLocal.moneda,
        referenciaCapturada: ordenLocal.referencia_interna,
        verificadaParaMarcarPagada: false,
        mensaje: 'El pago quedó en estado PENDIENTE de compensación en PayPal. La factura se marcará como pagada cuando se confirme.',
        rawResponse: {
          id: ordenLocal.paypal_order_id,
          status: 'PENDING',
          simulated: true,
        },
      };
    }

    // Caso COMPLETED en modo simulado
    const datosVerificacion = {
      estadoCaptura: 'COMPLETED',
      importeCapturado: redondear2(ordenLocal.importe),
      monedaCapturada: ordenLocal.moneda,
      referenciaCapturada: ordenLocal.referencia_interna,
    };

    verificarIntegridadCaptura(ordenLocal, datosVerificacion);

    return {
      estado: 'COMPLETED',
      paypalCaptureId: captureIdSim,
      payerEmail: 'comprador.sandbox@ejemplo.do',
      payerId: 'SIMPAYER001',
      importeCapturado: datosVerificacion.importeCapturado,
      monedaCapturada: datosVerificacion.monedaCapturada,
      referenciaCapturada: datosVerificacion.referenciaCapturada,
      verificadaParaMarcarPagada: true,
      mensaje: 'Pago capturado y verificado exitosamente en PayPal Sandbox.',
      rawResponse: {
        id: ordenLocal.paypal_order_id,
        status: 'COMPLETED',
        simulated: true,
        payer: {
          payer_id: 'SIMPAYER001',
          email_address: 'comprador.sandbox@ejemplo.do',
        },
        purchase_units: [
          {
            reference_id: ordenLocal.referencia_interna,
            custom_id: ordenLocal.referencia_interna,
            payments: {
              captures: [
                {
                  id: captureIdSim,
                  status: 'COMPLETED',
                  custom_id: ordenLocal.referencia_interna,
                  amount: {
                    currency_code: ordenLocal.moneda,
                    value: formatearMonto2(ordenLocal.importe),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }

  // Captura real contra PayPal Orders v2: POST /v2/checkout/orders/{id}/capture
  const accessToken = await obtenerAccessToken();
  const resp = await fetch(
    `${config.baseUrl}/v2/checkout/orders/${encodeURIComponent(ordenLocal.paypal_order_id)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || '';
    const desc =
      data?.details?.[0]?.description ||
      data?.message ||
      'El pago fue rechazado o no pudo ser capturado por PayPal.';

    if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_CANNOT_PAY' || resp.status === 422) {
      return {
        estado: 'DECLINED',
        paypalCaptureId: null,
        payerEmail: data?.payer?.email_address || null,
        payerId: data?.payer?.payer_id || null,
        importeCapturado: null,
        monedaCapturada: null,
        referenciaCapturada: null,
        verificadaParaMarcarPagada: false,
        mensaje: `Pago rechazado por PayPal (${issue || 'DECLINED'}): ${sanitizarTextoPayPal(desc)}`,
        rawResponse: data,
      };
    }

    throw new PayPalError(`Error al capturar la orden en PayPal: ${desc}`, {
      tipo: 'ERROR_CAPTURA',
      statusCode: resp.status >= 500 ? 502 : 400,
      codigoPayPal: issue || null,
      detalle: data,
    });
  }

  const purchaseUnit = data?.purchase_units?.[0] || {};
  const captureObj = purchaseUnit?.payments?.captures?.[0] || {};
  const estadoCaptura = String(captureObj.status || data.status || 'PENDING').toUpperCase();
  const importeCapturado = captureObj?.amount?.value ? redondear2(captureObj.amount.value) : 0;
  const monedaCapturada = captureObj?.amount?.currency_code || '';
  const referenciaCapturada =
    captureObj?.custom_id || purchaseUnit?.custom_id || purchaseUnit?.reference_id || '';

  if (estadoCaptura === 'PENDING') {
    return {
      estado: 'PENDING',
      paypalCaptureId: captureObj.id || null,
      payerEmail: data?.payer?.email_address || null,
      payerId: data?.payer?.payer_id || null,
      importeCapturado,
      monedaCapturada,
      referenciaCapturada,
      verificadaParaMarcarPagada: false,
      mensaje:
        'El pago se encuentra PENDIENTE de revisión/compensación en PayPal. La factura se actualizará al completarse la captura.',
      rawResponse: data,
    };
  }

  if (estadoCaptura === 'DECLINED' || estadoCaptura === 'FAILED' || estadoCaptura === 'DENIED') {
    return {
      estado: 'DECLINED',
      paypalCaptureId: captureObj.id || null,
      payerEmail: data?.payer?.email_address || null,
      payerId: data?.payer?.payer_id || null,
      importeCapturado,
      monedaCapturada,
      referenciaCapturada,
      verificadaParaMarcarPagada: false,
      mensaje: 'La captura del pago fue rechazada por PayPal.',
      rawResponse: data,
    };
  }

  // Verificar que estado === 'COMPLETED' y que importe, moneda y referencia coincidan con la factura
  verificarIntegridadCaptura(ordenLocal, {
    estadoCaptura,
    importeCapturado,
    monedaCapturada,
    referenciaCapturada,
  });

  return {
    estado: 'COMPLETED',
    paypalCaptureId: captureObj.id || null,
    payerEmail: data?.payer?.email_address || null,
    payerId: data?.payer?.payer_id || null,
    importeCapturado,
    monedaCapturada,
    referenciaCapturada,
    verificadaParaMarcarPagada: true,
    mensaje: 'Pago capturado y verificado satisfactoriamente con PayPal.',
    rawResponse: data,
  };
}

/**
 * Verifica la autenticidad de un Webhook enviado por PayPal mediante
 * POST /v1/notifications/verify-webhook-signature
 */
async function verificarAutenticidadWebhook(headers, eventBody) {
  const config = obtenerConfiguracionPayPal();

  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];
  const transmissionSig = headers['paypal-transmission-sig'];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    throw new PayPalError(
      'Solicitud de webhook rechazada: faltan encabezados de firma criptográfica de PayPal (paypal-transmission-*).',
      { tipo: 'ERROR_FIRMA_WEBHOOK', statusCode: 400 }
    );
  }

  // En modo simulado local con firma de prueba controlada
  if (config.modoSimulacion && transmissionSig === 'SIMULATED_VALID_PAYPAL_SIGNATURE') {
    return { verificado: true, status: 'SUCCESS', modoSimulacion: true };
  }

  if (!config.webhookId) {
    throw new PayPalError(
      'Falta configurar PAYPAL_WEBHOOK_ID en el servidor para verificar firmas de webhooks.',
      { tipo: 'ERROR_CONFIGURACION_WEBHOOK', statusCode: 400 }
    );
  }

  const accessToken = await obtenerAccessToken();
  const verifyPayload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: config.webhookId,
    webhook_event: eventBody,
  };

  const resp = await fetch(`${config.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(verifyPayload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.verification_status !== 'SUCCESS') {
    throw new PayPalError('La firma del webhook de PayPal no es auténtica (verification_status != SUCCESS).', {
      tipo: 'ERROR_FIRMA_WEBHOOK',
      statusCode: 401,
      detalle: data,
    });
  }

  return { verificado: true, status: 'SUCCESS', modoSimulacion: false };
}

module.exports = {
  MONEDAS_ADMITIDAS_PAYPAL,
  PayPalError,
  redondear2,
  formatearMonto2,
  obtenerConfiguracionPayPal,
  sanitizarTextoPayPal,
  calcularImporteDesdeFactura,
  construirOrdenPayPalPayload,
  crearOrdenPayPal,
  capturarOrdenPayPal,
  verificarIntegridadCaptura,
  verificarAutenticidadWebhook,
};

