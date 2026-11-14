const db = require('../config/db');
const paypalService = require('../services/paypalService');
const imecfService = require('../services/imecfService');

/**
 * Obtiene el resumen de pagos PayPal y cálculo de conversión de moneda para una factura/consulta
 */
async function obtenerEstadoPagosFactura(consulta, client = db) {
  const { rows: pagos } = await client.query(
    `SELECT pp.*, u.nombre AS usuario_nombre
     FROM pagos_paypal pp
     LEFT JOIN usuarios u ON pp.usuario_id = u.id
     WHERE pp.consulta_id = $1
     ORDER BY pp.id DESC`,
    [consulta.id]
  );

  const pagoCompletado = pagos.find((p) => p.estado === 'COMPLETED') || null;
  const ultimoIntento = pagos[0] || null;
  const configPayPal = paypalService.obtenerConfiguracionPayPal();

  let calculoDefault = null;
  try {
    calculoDefault = paypalService.calcularImporteDesdeFactura(consulta);
  } catch (_) {
    calculoDefault = null;
  }

  return {
    configPayPal: {
      env: configPayPal.env,
      clientId: configPayPal.clientId,
      monedaFactura: configPayPal.monedaFactura,
      monedaCobro: configPayPal.monedaCobro,
      dopSoportadoPorPayPal: configPayPal.dopSoportadoPorPayPal,
      requiereConversionMoneda: configPayPal.requiereConversionMoneda,
      tasaCambioDop: configPayPal.tasaCambioDop,
      tieneCredencialesReales: configPayPal.tieneCredencialesReales,
      modoSimulacion: configPayPal.modoSimulacion,
    },
    calculoPayPal: calculoDefault,
    pagoCompletado,
    ultimoIntentoPayPal: ultimoIntento,
    historialPagosPayPal: pagos,
  };
}

/**
 * POST /pagos/paypal/crear-orden/:consultaId
 * Calcula el importe desde la base de datos (ignorando cualquier monto enviado por el navegador)
 * y crea la orden en PayPal Orders v2.
 */
exports.crearOrden = async (req, res) => {
  const consultaId = parseInt(req.params.consultaId, 10);
  if (Number.isNaN(consultaId)) {
    return res.status(400).json({ success: false, error: 'ID de factura inválido.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Bloquear la factura en la base de datos para evitar cobros concurrentes
    const { rows: cRows } = await client.query(
      `SELECT c.*,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              p.identificacion AS paciente_identificacion,
              s.nombre AS servicio_nombre
       FROM consultas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       LEFT JOIN servicios s ON c.servicio_id = s.id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [consultaId]
    );

    if (cRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Factura no encontrada.' });
    }

    const consulta = cRows[0];

    // 1. Verificar si la factura ya está marcada como Pagada o tiene un pago COMPLETED
    const { rows: pagosCompletados } = await client.query(
      `SELECT * FROM pagos_paypal WHERE consulta_id = $1 AND estado = 'COMPLETED' LIMIT 1`,
      [consultaId]
    );

    if (consulta.estado_pago === 'Pagado' || pagosCompletados.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        codigo: 'FACTURA_YA_PAGADA',
        error: 'Esta factura ya se encuentra pagada. No se permiten cobros duplicados.',
        pagoExistente: pagosCompletados[0] || null,
      });
    }

    // 2. Calcular importe exclusivamente desde la factura guardada en PostgreSQL (se ignora cualquier monto del body)
    const criterioCobro = req.body?.criterio_cobro || null;
    const forzarSimulacion =
      req.body?.modo_simulacion === true ||
      req.body?.modo_simulacion === 'true' ||
      paypalService.obtenerConfiguracionPayPal().modoSimulacion;

    // Cancelar órdenes previas en estado CREATED de esta misma factura para mantener una sola orden activa
    await client.query(
      `UPDATE pagos_paypal
       SET estado = 'CANCELLED',
           mensaje_estado = 'Reemplazada por una nueva orden de pago.',
           updated_at = CURRENT_TIMESTAMP
       WHERE consulta_id = $1 AND estado = 'CREATED'`,
      [consultaId]
    );

    const ordenCreada = await paypalService.crearOrdenPayPal(consulta, {
      criterioCobro,
      forzarSimulacion,
    });

    const autoEmitirEcf = Boolean(req.body?.auto_emitir_ecf === true || req.body?.auto_emitir_ecf === 'true');

    const { rows: insertRows } = await client.query(
      `INSERT INTO pagos_paypal (
         consulta_id,
         referencia_interna,
         paypal_order_id,
         criterio_cobro,
         monto_dop,
         tasa_cambio,
         importe,
         moneda,
         estado,
         ambiente,
         modo_simulacion,
         auto_emitir_ecf,
         mensaje_estado,
         raw_order_response,
         usuario_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CREATED', $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        consultaId,
        ordenCreada.calculo.referenciaInterna,
        ordenCreada.paypalOrderId,
        ordenCreada.calculo.criterioCobro,
        ordenCreada.calculo.montoDop,
        ordenCreada.calculo.tasaCambio,
        ordenCreada.calculo.importeCobro,
        ordenCreada.calculo.monedaCobro,
        ordenCreada.ambiente,
        ordenCreada.modoSimulacion,
        autoEmitirEcf,
        'Orden creada en el servidor y pendiente de aprobación del pagador.',
        JSON.stringify(ordenCreada.rawResponse || {}),
        req.session?.usuario?.id || null,
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      orderId: ordenCreada.paypalOrderId,
      modoSimulacion: ordenCreada.modoSimulacion,
      ambiente: ordenCreada.ambiente,
      calculo: ordenCreada.calculo,
      registroPago: insertRows[0],
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    const status = err.statusCode || 400;
    return res.status(status).json({
      success: false,
      error: paypalService.sanitizarTextoPayPal(err.message || 'No se pudo iniciar la orden de pago con PayPal.'),
      tipo: err.tipo || 'PAYPAL_ERROR',
    });
  } finally {
    client.release();
  }
};

/**
 * Función auxiliar para intentar emitir el comprobante electrónico (e-CF) tras un pago exitoso
 * manteniendo completamente separados el estado del pago y el del comprobante IMECF.
 * Si la emisión del e-CF falla, el pago se conserva intacto como Pagado y permite reintentar sin volver a cobrar.
 */
async function intentarEmisionEcfPostPago(consultaId, opcionesEcf = {}, usuarioId = null) {
  try {
    const { rows: existentes } = await db.query(
      `SELECT * FROM comprobantes_electronicos
       WHERE consulta_id = $1
         AND estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO')
       LIMIT 1`,
      [consultaId]
    );
    if (existentes.length > 0) {
      return { emitido: true, comprobante: existentes[0], yaExistia: true };
    }

    const { rows: cRows } = await db.query(
      `SELECT c.*,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              p.identificacion AS paciente_identificacion,
              p.correo AS paciente_correo,
              s.nombre AS servicio_nombre,
              COALESCE(s.indicador_facturacion, '4') AS servicio_indicador_facturacion
       FROM consultas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       LEFT JOIN servicios s ON c.servicio_id = s.id
       WHERE c.id = $1`,
      [consultaId]
    );

    if (cRows.length === 0) {
      throw new Error('Factura no encontrada para emisión de e-CF.');
    }

    const consulta = cRows[0];
    const { payload, resumenFiscal } = imecfService.construirPayloadEcf(consulta, {
      tipoEcf: opcionesEcf.tipoEcf || 'E32',
      indicadorFacturacion: opcionesEcf.indicadorFacturacion || consulta.servicio_indicador_facturacion || '4',
      criterioMonto: opcionesEcf.criterioMonto || 'TOTAL',
      formaPago: 3, // Tarjeta / Medio electrónico PayPal
    });

    const configImecf = imecfService.obtenerConfiguracion();
    const forzarSimulacionEcf =
      opcionesEcf.forzarSimulacionEcf !== undefined ? Boolean(opcionesEcf.forzarSimulacionEcf) : configImecf.modoSimulacion;

    const respuestaEcf = await imecfService.enviarComprobante(payload, resumenFiscal, {
      consultaId,
      forzarSimulacion: forzarSimulacionEcf,
      simularTimeout: Boolean(opcionesEcf.simularFalloEcf),
    });

    const { rows: ecfRows } = await db.query(
      `INSERT INTO comprobantes_electronicos (
         consulta_id, ecf_id_externo, encf, tipo_ecf, estado, track_id,
         codigo_seguridad, dgii_url, xml_url, ambiente, modo_simulacion,
         indicador_facturacion, criterio_monto, tipo_pago, forma_pago,
         rnc_comprador, razon_social_comprador, correo_comprador,
         monto_gravado_total, monto_exento, total_itbis, monto_total,
         secuencia_utilizada, enviado_dgii, request_payload, response_payload,
         xml_firmado, bloqueado_envio, emitido_por_usuario_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, false, $28
       ) RETURNING *`,
      [
        consultaId,
        respuestaEcf.ecfIdExterno,
        respuestaEcf.encf,
        respuestaEcf.tipoEcf,
        respuestaEcf.estado,
        respuestaEcf.trackId,
        respuestaEcf.codigoSeguridad,
        respuestaEcf.dgiiUrl,
        respuestaEcf.xmlUrl,
        respuestaEcf.ambiente,
        respuestaEcf.modoSimulacion,
        resumenFiscal.indicadorFacturacion,
        resumenFiscal.criterioMonto,
        resumenFiscal.tipoPago,
        resumenFiscal.formaPago,
        resumenFiscal.rncComprador,
        resumenFiscal.razonSocialComprador,
        resumenFiscal.correoComprador,
        resumenFiscal.montoGravadoTotal,
        resumenFiscal.montoExento,
        resumenFiscal.totalItbis,
        resumenFiscal.montoTotal,
        respuestaEcf.secuenciaUtilizada,
        respuestaEcf.enviadoDgii,
        JSON.stringify(payload),
        JSON.stringify(respuestaEcf.responsePayload || {}),
        respuestaEcf.xmlFirmado,
        usuarioId,
      ]
    );

    return { emitido: true, comprobante: ecfRows[0] };
  } catch (ecfErr) {
    return {
      emitido: false,
      error: imecfService.sanitizarTextoSeguridad(
        ecfErr.message || 'Error al emitir el comprobante electrónico en IMECF.'
      ),
    };
  }
}

/**
 * POST /pagos/paypal/capturar-orden/:consultaId
 * Captura la orden desde el backend, verifica estado COMPLETED, importe, moneda y referencia
 * antes de marcar la factura como Pagada.
 */
exports.capturarOrden = async (req, res) => {
  const consultaId = parseInt(req.params.consultaId, 10);
  const orderId = String(req.body?.orderId || req.body?.orderID || '').trim();

  if (Number.isNaN(consultaId) || !orderId) {
    return res.status(400).json({
      success: false,
      error: 'Se requiere el ID de la factura y el orderId de PayPal para capturar el pago.',
    });
  }

  const client = await db.pool.connect();
  let pagoConfirmado = null;

  try {
    await client.query('BEGIN');

    // 1. Bloquear la factura y la orden de pago para evitar doble captura
    const { rows: cRows } = await client.query(
      `SELECT * FROM consultas WHERE id = $1 FOR UPDATE`,
      [consultaId]
    );
    if (cRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Factura no encontrada.' });
    }

    const { rows: ordenRows } = await client.query(
      `SELECT * FROM pagos_paypal WHERE paypal_order_id = $1 AND consulta_id = $2 FOR UPDATE`,
      [orderId, consultaId]
    );

    if (ordenRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'La orden de PayPal indicada no pertenece a esta factura o no existe.',
      });
    }

    const ordenLocal = ordenRows[0];

    // 2. Evitar cobros y capturas duplicadas
    if (ordenLocal.estado === 'COMPLETED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        codigo: 'ORDEN_YA_CAPTURADA',
        error: 'Esta orden de PayPal ya fue capturada y registrada como pagada anteriormente.',
        pago: ordenLocal,
      });
    }

    const { rows: otraCompletada } = await client.query(
      `SELECT * FROM pagos_paypal WHERE consulta_id = $1 AND estado = 'COMPLETED' LIMIT 1`,
      [consultaId]
    );

    if (otraCompletada.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        codigo: 'FACTURA_YA_PAGADA',
        error: 'Esta factura ya cuenta con un pago completado. No se permiten cobros duplicados.',
        pago: otraCompletada[0],
      });
    }

    // 3. Capturar en PayPal desde el backend y verificar importe, moneda y referencia
    const resultadoCaptura = await paypalService.capturarOrdenPayPal(ordenLocal, {
      simulacionResultado: req.body?.simulacion_resultado || 'COMPLETED',
    });

    if (resultadoCaptura.estado === 'DECLINED') {
      const { rows: declRows } = await client.query(
        `UPDATE pagos_paypal
         SET estado = 'DECLINED',
             payer_email = COALESCE($1, payer_email),
             payer_id = COALESCE($2, payer_id),
             mensaje_estado = $3,
             raw_capture_response = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING *`,
        [
          resultadoCaptura.payerEmail,
          resultadoCaptura.payerId,
          resultadoCaptura.mensaje,
          JSON.stringify(resultadoCaptura.rawResponse || {}),
          ordenLocal.id,
        ]
      );
      await client.query('COMMIT');
      return res.status(422).json({
        success: false,
        estado: 'DECLINED',
        error: resultadoCaptura.mensaje,
        pago: declRows[0],
      });
    }

    if (resultadoCaptura.estado === 'PENDING' || !resultadoCaptura.verificadaParaMarcarPagada) {
      const { rows: pendRows } = await client.query(
        `UPDATE pagos_paypal
         SET estado = 'PENDING',
             paypal_capture_id = COALESCE($1, paypal_capture_id),
             payer_email = COALESCE($2, payer_email),
             payer_id = COALESCE($3, payer_id),
             mensaje_estado = $4,
             raw_capture_response = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
         RETURNING *`,
        [
          resultadoCaptura.paypalCaptureId,
          resultadoCaptura.payerEmail,
          resultadoCaptura.payerId,
          resultadoCaptura.mensaje,
          JSON.stringify(resultadoCaptura.rawResponse || {}),
          ordenLocal.id,
        ]
      );
      await client.query('COMMIT');
      return res.status(202).json({
        success: true,
        estado: 'PENDING',
        facturaPagada: false,
        message: resultadoCaptura.mensaje,
        pago: pendRows[0],
      });
    }

    // 4. Captura COMPLETED y verificada (importe, moneda y referencia coinciden con la factura)
    const { rows: compRows } = await client.query(
      `UPDATE pagos_paypal
       SET estado = 'COMPLETED',
           paypal_capture_id = $1,
           payer_email = $2,
           payer_id = $3,
           mensaje_estado = $4,
           raw_capture_response = $5,
           fecha_pago = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [
        resultadoCaptura.paypalCaptureId,
        resultadoCaptura.payerEmail,
        resultadoCaptura.payerId,
        resultadoCaptura.mensaje,
        JSON.stringify(resultadoCaptura.rawResponse || {}),
        ordenLocal.id,
      ]
    );

    await client.query(`UPDATE consultas SET estado_pago = 'Pagado' WHERE id = $1`, [consultaId]);

    pagoConfirmado = compRows[0];
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        codigo: 'COBRO_DUPLICADO_BLOQUEADO',
        error: 'El pago o la captura ya fueron registrados previamente.',
      });
    }

    return res.status(err.statusCode || 400).json({
      success: false,
      error: paypalService.sanitizarTextoPayPal(err.message || 'Error al verificar o capturar el pago de PayPal.'),
      tipo: err.tipo || 'ERROR_CAPTURA',
    });
  } finally {
    client.release();
  }

  // 5. Mantener separados el estado del pago y el del comprobante IMECF:
  // Si se solicitó emitir el e-CF tras el cobro y este falla, el pago YA quedó guardado como Pagado
  // y el usuario puede reintentar la emisión del e-CF sin volver a cobrar.
  let resultadoEcf = null;
  const deseaEmitirEcf =
    pagoConfirmado.auto_emitir_ecf ||
    req.body?.emitir_ecf === true ||
    req.body?.emitir_ecf === 'true';

  if (deseaEmitirEcf) {
    resultadoEcf = await intentarEmisionEcfPostPago(
      consultaId,
      {
        tipoEcf: req.body?.tipo_ecf || 'E32',
        indicadorFacturacion: req.body?.indicador_facturacion,
        criterioMonto: pagoConfirmado.criterio_cobro,
        forzarSimulacionEcf: req.body?.forzar_simulacion_ecf,
        simularFalloEcf: req.body?.simular_fallo_ecf === true || req.body?.simular_fallo_ecf === 'true',
      },
      req.session?.usuario?.id || null
    );

    if (!resultadoEcf.emitido && resultadoEcf.error) {
      await db.query(
        `UPDATE pagos_paypal SET ecf_intento_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [resultadoEcf.error, pagoConfirmado.id]
      );
      pagoConfirmado.ecf_intento_error = resultadoEcf.error;
    }
  }

  const mensajeFinal =
    resultadoEcf && !resultadoEcf.emitido
      ? `Pago con PayPal completado y factura marcada como Pagada (Captura: ${pagoConfirmado.paypal_capture_id}). Nota: La emisión automática del comprobante IMECF falló (${resultadoEcf.error}), pero su pago está seguro y puede reintentar emitir el comprobante electrónico sin volver a cobrar.`
      : `Pago con PayPal completado y verificado exitosamente (Orden: ${pagoConfirmado.paypal_order_id}, Captura: ${pagoConfirmado.paypal_capture_id}).`;

  return res.status(200).json({
    success: true,
    estado: 'COMPLETED',
    facturaPagada: true,
    message: mensajeFinal,
    pago: pagoConfirmado,
    ecf: resultadoEcf,
  });
};

/**
 * POST /pagos/paypal/cancelar-orden/:consultaId
 * Registra cuando el usuario cancela el flujo de pago en la ventana de PayPal.
 */
exports.cancelarOrden = async (req, res) => {
  try {
    const consultaId = parseInt(req.params.consultaId, 10);
    const orderId = String(req.body?.orderId || req.body?.orderID || '').trim();

    if (Number.isNaN(consultaId) || !orderId) {
      return res.status(400).json({ success: false, error: 'Datos de orden incompletos para cancelar.' });
    }

    const { rows } = await db.query(
      `UPDATE pagos_paypal
       SET estado = 'CANCELLED',
           mensaje_estado = 'Pago cancelado por el usuario antes de completar la autorización en PayPal.',
           updated_at = CURRENT_TIMESTAMP
       WHERE paypal_order_id = $1
         AND consulta_id = $2
         AND estado IN ('CREATED', 'APPROVED')
       RETURNING *`,
      [orderId, consultaId]
    );

    return res.json({
      success: true,
      estado: 'CANCELLED',
      message: 'El proceso de pago con PayPal fue cancelado. La factura permanece pendiente y no se realizó ningún cargo.',
      pago: rows[0] || null,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: paypalService.sanitizarTextoPayPal(err.message),
    });
  }
};

/**
 * POST /api/paypal/webhook
 * Receptor oficial de Webhooks de PayPal con verificación criptográfica de autenticidad
 * y protección idempotente contra notificaciones duplicadas.
 */
exports.recibirWebhook = async (req, res) => {
  const eventBody = req.body || {};
  const eventId = String(eventBody.id || '').trim();
  const eventType = String(eventBody.event_type || '').trim();

  if (!eventId || !eventType) {
    return res.status(400).json({
      success: false,
      error: 'Cuerpo de evento webhook inválido (falta id o event_type).',
    });
  }

  // 1. Verificar autenticidad de la firma del webhook con PayPal
  try {
    await paypalService.verificarAutenticidadWebhook(req.headers, eventBody);
  } catch (verifyErr) {
    return res.status(verifyErr.statusCode || 401).json({
      success: false,
      error: verifyErr.message,
      tipo: verifyErr.tipo || 'ERROR_FIRMA_WEBHOOK',
    });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 2. Protección contra eventos duplicados (idempotencia por event_id)
    const { rows: existentes } = await client.query(
      `SELECT id, processed_at FROM paypal_webhook_eventos WHERE event_id = $1`,
      [eventId]
    );

    if (existentes.length > 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        success: true,
        duplicate: true,
        eventId,
        message: 'Evento webhook ya fue procesado anteriormente (idempotencia activa).',
      });
    }

    const resource = eventBody.resource || {};
    const resourceId = resource.id || null;
    const relatedOrderId =
      resource?.supplementary_data?.related_ids?.order_id ||
      (eventType.startsWith('CHECKOUT.ORDER.') ? resource.id : null);
    const captureId = eventType.startsWith('PAYMENT.CAPTURE.') ? resource.id : null;

    await client.query(
      `INSERT INTO paypal_webhook_eventos (
         event_id, event_type, resource_id, paypal_order_id, paypal_capture_id, verification_status, payload
       ) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6)`,
      [eventId, eventType, resourceId, relatedOrderId, captureId, JSON.stringify(eventBody)]
    );

    // 3. Sincronizar el estado del pago según el tipo de evento
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const customId = resource.custom_id || '';
      const ordenes = await client.query(
        `SELECT * FROM pagos_paypal
         WHERE paypal_order_id = $1
            OR paypal_capture_id = $2
            OR (referencia_interna = $3 AND $3 <> '')
         ORDER BY id DESC LIMIT 1
         FOR UPDATE`,
        [relatedOrderId || '', captureId || '', customId]
      );

      if (ordenes.rows.length > 0) {
        const ordenLocal = ordenes.rows[0];
        if (ordenLocal.estado !== 'COMPLETED') {
          const importeWebhook = resource.amount?.value ? Number(resource.amount.value) : Number(ordenLocal.importe);
          const monedaWebhook = resource.amount?.currency_code || ordenLocal.moneda;
          const refWebhook = customId || ordenLocal.referencia_interna;

          paypalService.verificarIntegridadCaptura(ordenLocal, {
            estadoCaptura: 'COMPLETED',
            importeCapturado: importeWebhook,
            monedaCapturada: monedaWebhook,
            referenciaCapturada: refWebhook,
          });

          await client.query(
            `UPDATE pagos_paypal
             SET estado = 'COMPLETED',
                 paypal_capture_id = COALESCE($1, paypal_capture_id),
                 mensaje_estado = 'Confirmado mediante Webhook verificado PAYMENT.CAPTURE.COMPLETED.',
                 fecha_pago = COALESCE(fecha_pago, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [captureId, ordenLocal.id]
          );

          await client.query(`UPDATE consultas SET estado_pago = 'Pagado' WHERE id = $1`, [ordenLocal.consulta_id]);
        }
      }
    } else if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      await client.query(
        `UPDATE pagos_paypal
         SET estado = 'PENDING',
             paypal_capture_id = COALESCE($1, paypal_capture_id),
             mensaje_estado = 'Notificación Webhook: captura en estado PENDING.',
             updated_at = CURRENT_TIMESTAMP
         WHERE (paypal_order_id = $2 OR paypal_capture_id = $1)
           AND estado <> 'COMPLETED'`,
        [captureId, relatedOrderId || '']
      );
    } else if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED') {
      await client.query(
        `UPDATE pagos_paypal
         SET estado = 'DECLINED',
             paypal_capture_id = COALESCE($1, paypal_capture_id),
             mensaje_estado = 'Notificación Webhook: captura rechazada o denegada por PayPal.',
             updated_at = CURRENT_TIMESTAMP
         WHERE (paypal_order_id = $2 OR paypal_capture_id = $1)
           AND estado <> 'COMPLETED'`,
        [captureId, relatedOrderId || '']
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({
      success: true,
      duplicate: false,
      eventId,
      eventType,
      message: 'Webhook de PayPal verificado y procesado correctamente.',
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    if (err.code === '23505') {
      return res.status(200).json({
        success: true,
        duplicate: true,
        eventId,
        message: 'Evento webhook ya fue registrado previamente.',
      });
    }

    return res.status(err.statusCode || 400).json({
      success: false,
      error: paypalService.sanitizarTextoPayPal(err.message),
    });
  } finally {
    client.release();
  }
};

exports.obtenerEstadoPagosFactura = obtenerEstadoPagosFactura;

/**
 * GET /pagos/paypal/comprobante/:consultaId
 * Muestra e imprime el comprobante de pago de copago con PayPal.
 * Si el pago no fue completado o faltan credenciales/datos, indica claramente qué falta y que el pago no se completó.
 */
exports.verComprobantePago = async (req, res, next) => {
  try {
    const consultaId = parseInt(req.params.consultaId, 10);
    if (Number.isNaN(consultaId)) {
      req.flash('error', 'Identificador de factura inválido.');
      return res.redirect('/ecf');
    }

    const { rows: cRows } = await db.query(
      `SELECT c.*,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              p.identificacion AS paciente_identificacion,
              p.correo AS paciente_correo,
              p.telefono AS paciente_telefono,
              p.numero_afiliado AS paciente_afiliado,
              s.nombre AS servicio_nombre,
              s.codigo AS servicio_codigo,
              a.nombre AS ars_nombre
       FROM consultas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       LEFT JOIN servicios s ON c.servicio_id = s.id
       LEFT JOIN ars a ON c.ars_id = a.id
       WHERE c.id = $1`,
      [consultaId]
    );

    if (cRows.length === 0) {
      req.flash('error', 'Factura no encontrada.');
      return res.redirect('/ecf');
    }

    const consulta = cRows[0];
    const { rows: pagos } = await db.query(
      `SELECT * FROM pagos_paypal WHERE consulta_id = $1 ORDER BY id DESC`,
      [consultaId]
    );

    const pagoCompletado = pagos.find((p) => p.estado === 'COMPLETED') || null;
    const ultimoIntento = pagos[0] || null;
    const configPP = paypalService.obtenerConfiguracionPayPal();

    // Si el pago NO está completado o faltan datos
    if (!pagoCompletado || consulta.estado_pago !== 'Pagado') {
      const estadoActual = ultimoIntento ? ultimoIntento.estado : consulta.estado_pago;
      let detalleFalta = 'El copago de la consulta aún no ha sido autorizado ni cobrado.';
      if (!configPP.tieneCredencialesReales) {
        detalleFalta = 'Faltan configurar las credenciales PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET en las variables de entorno del servidor.';
      } else if (ultimoIntento?.estado === 'CANCELLED') {
        detalleFalta = 'El proceso de pago fue cancelado por el usuario en la ventana de PayPal.';
      } else if (ultimoIntento?.estado === 'DECLINED') {
        detalleFalta = 'El pago fue rechazado por el instrumento o emisor en PayPal (DECLINED).';
      } else if (ultimoIntento?.estado === 'PENDING') {
        detalleFalta = 'El pago se encuentra pendiente de compensación y revisión en PayPal.';
      }

      const htmlIncompleto = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Comprobante de Pago - Pago No Completado</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 40px 20px; }
    .card { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border-top: 6px solid #f59e0b; }
    h1 { font-size: 20px; color: #b45309; margin-top: 0; }
    p { font-size: 14px; line-height: 1.6; color: #475569; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 12px; background: #fef3c7; color: #b45309; }
    .btn { display: inline-block; margin-top: 20px; padding: 10px 18px; background: #0f766e; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="margin-bottom: 12px;"><span class="badge">ESTADO: ${estadoActual}</span></div>
    <h1>El pago no se completó</h1>
    <p>No se puede emitir el comprobante de pago definitivo para la Factura <strong>#${consulta.id}</strong> porque el copago del paciente no fue completado.</p>
    <div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 13px; color: #92400e;">
      <strong>Detalle del estado:</strong><br>${detalleFalta}
    </div>
    <p style="font-size: 13px; color: #64748b;">Monto pendiente del copago: <strong>RD$ ${Number(consulta.diferencia_paciente).toFixed(2)}</strong>.</p>
    <a href="/ecf/factura/${consulta.id}" class="btn">&larr; Volver al proceso de cobro</a>
  </div>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(htmlIncompleto);
    }

    // Factura fiscal e-CF vigente de esta consulta (para enlazarla desde el comprobante de pago)
    const { rows: ecfRows } = await db.query(
      `SELECT id, encf
       FROM comprobantes_electronicos
       WHERE consulta_id = $1
         AND encf IS NOT NULL
         AND estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO')
       ORDER BY id DESC
       LIMIT 1`,
      [consultaId]
    );
    const facturaEcf = ecfRows[0] || null;

    // Fecha y hora reales del pago, siempre en hora de República Dominicana
    // (en Cloud Run el servidor está en UTC y sin esto la hora saldría corrida)
    const fechaPago = pagoCompletado.fecha_pago || pagoCompletado.updated_at;
    const fechaPagoTexto = fechaPago
      ? new Date(fechaPago).toLocaleString('es-DO', {
          timeZone: 'America/Santo_Domingo',
          dateStyle: 'long',
          timeStyle: 'short',
        })
      : '—';
    const numeroTransaccion = pagoCompletado.paypal_capture_id || pagoCompletado.paypal_order_id;

    // Si el pago ESTÁ completado, generar y mostrar el comprobante formal
    const htmlComprobante = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Comprobante de Pago Electrónico - Factura #${consulta.id}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; padding: 24px; margin: 0; }
    .ticket { max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 36px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
    .header { border-bottom: 2px dashed #cbd5e1; padding-bottom: 20px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-start; }
    .clinic-title { font-size: 20px; font-weight: 800; color: #0f766e; margin: 0 0 4px 0; }
    .clinic-sub { font-size: 12px; color: #64748b; margin: 0; }
    .badge-approved { background: #dcfce7; color: #166534; font-weight: 700; padding: 6px 12px; border-radius: 9999px; font-size: 12px; border: 1px solid #bbf7d0; display: inline-flex; align-items: center; gap: 4px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; font-size: 13px; margin-bottom: 24px; }
    .meta-item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
    .meta-label { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 4px; }
    .meta-val { font-size: 13.5px; font-weight: 600; color: #0f172a; }
    .amount-box { background: #f0fdfa; border: 1.5px solid #99f6e4; border-radius: 10px; padding: 20px; margin-bottom: 24px; text-align: center; }
    .amount-lbl { font-size: 12px; text-transform: uppercase; font-weight: 700; color: #0f766e; letter-spacing: 0.5px; }
    .amount-val { font-size: 32px; font-weight: 900; color: #0f766e; margin: 6px 0 2px 0; }
    .amount-sub { font-size: 12.5px; color: #475569; }
    .link-ecf { color: #0f766e; font-weight: 700; text-decoration: none; }
    .link-ecf:hover { text-decoration: underline; }
    .txn { font-size: 11px; color: #94a3b8; text-align: center; margin: -8px 0 20px 0; }
    .txn span { font-family: monospace; }
    .footer-note { font-size: 11.5px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px; }
    .actions { display: flex; justify-content: center; gap: 12px; margin-top: 24px; }
    .btn-print { background: #0f766e; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: none; }
    .btn-back { background: #e2e8f0; color: #334155; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 13px; text-decoration: none; }
    @media print {
      body { background: #fff; padding: 0; }
      .ticket { box-shadow: none; border: none; padding: 0; }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="ticket">
    <div class="header">
      <div>
        <h1 class="clinic-title">Consultorio Médico San Rafael</h1>
        <p class="clinic-sub">Comprobante de Pago &bull; Pago en línea (simulación de PayPal)</p>
      </div>
      <div>
        <span class="badge-approved">&#10004; PAGO APROBADO</span>
      </div>
    </div>

    <div class="amount-box">
      <div class="amount-lbl">Copago de Consulta Médica Cobrado</div>
      <div class="amount-val">RD$ ${Number(pagoCompletado.monto_dop).toFixed(2)}</div>
      <div class="amount-sub">
        Equivalente a <strong>${pagoCompletado.moneda} $${Number(pagoCompletado.importe).toFixed(2)}</strong>
        (Tasa oficial aplicada: 1 USD = RD$ ${Number(pagoCompletado.tasa_cambio).toFixed(2)} DOP)
      </div>
    </div>

    <div class="meta-grid">
      <div class="meta-item">
        <div class="meta-label">Paciente / Pagador</div>
        <div class="meta-val">${consulta.paciente_nombre} ${consulta.paciente_apellido}</div>
        <div style="font-size: 11.5px; color: #64748b;">Identificación: ${consulta.paciente_identificacion || 'N/A'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Servicio Médico Facturado</div>
        <div class="meta-val">${consulta.servicio_nombre || 'Consulta Médica General'}</div>
        <div style="font-size: 11.5px; color: #64748b;">ARS: ${consulta.ars_nombre || 'Particular / Sin Aseguradora'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Fecha y Hora del Pago</div>
        <div class="meta-val">${fechaPagoTexto}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Factura Fiscal (e-CF)</div>
        ${
          facturaEcf
            ? `<div class="meta-val"><a class="link-ecf" href="/ecf/documento/${facturaEcf.id}/impresion" target="_blank" rel="noopener">${facturaEcf.encf} &rarr;</a></div>
        <div style="font-size: 11.5px; color: #64748b;">Ver comprobante fiscal</div>`
            : `<div class="meta-val">Aún no emitida</div>
        <div style="font-size: 11.5px;"><a class="link-ecf" href="/ecf/factura/${consulta.id}">Emitir desde la factura #${consulta.id} &rarr;</a></div>`
        }
      </div>
    </div>

    <div class="txn">N.º de transacción: <span>${numeroTransaccion}</span></div>

    <div class="footer-note">
      Pago registrado mediante una simulación de PayPal con fines académicos: no se realizó un cobro real. Este documento es una constancia de pago, no un comprobante fiscal.
    </div>

    <div class="actions">
      <button onclick="window.print()" class="btn-print">&#128438; Imprimir Comprobante</button>
      <a href="/ecf/factura/${consulta.id}" class="btn-back">&larr; Volver a Facturación</a>
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(htmlComprobante);
  } catch (error) {
    next(error);
  }
};

