const db = require('../config/db');
const imecfService = require('../services/imecfService');
const emailService = require('../services/emailService');

/**
 * Obtiene los datos estrictamente fiscales y de facturación de una consulta médica
 * (Excluyendo diagnósticos, signos vitales, notas e historial clínico para máxima privacidad)
 */
async function obtenerDatosFiscalesConsulta(consultaId, client = db) {
  const { rows } = await client.query(
    `SELECT c.id,
            c.cita_id,
            c.paciente_id,
            c.servicio_id,
            c.fecha_consulta,
            c.ars_id,
            c.valor_total,
            c.valor_cubierto_ars,
            c.diferencia_paciente,
            c.estado_pago,
            c.diagnostico_clinico,
            c.hallazgos_clinicos,
            c.tratamiento_plan,
            c.antecedentes_revisados,
            c.notas_adicionales,
            p.nombre AS paciente_nombre,
            p.apellido AS paciente_apellido,
            p.identificacion AS paciente_identificacion,
            p.tipo_documento AS paciente_tipo_documento,
            p.telefono AS paciente_telefono,
            p.correo AS paciente_correo,
            p.direccion AS paciente_direccion,
            p.numero_afiliado AS paciente_afiliado,
            s.nombre AS servicio_nombre,
            s.codigo AS servicio_codigo,
            s.precio_base AS servicio_precio_base,
            COALESCE(s.indicador_facturacion, '4') AS servicio_indicador_facturacion,
            a.nombre AS ars_nombre,
            a.codigo AS ars_codigo
     FROM consultas c
     INNER JOIN pacientes p ON c.paciente_id = p.id
     LEFT JOIN servicios s ON c.servicio_id = s.id
     LEFT JOIN ars a ON c.ars_id = a.id
     WHERE c.id = $1`,
    [consultaId]
  );
  return rows[0] || null;
}

/**
 * Obtiene los comprobantes electrónicos reales asociados a una consulta/factura
 */
async function obtenerComprobantesPorConsulta(consultaId, client = db) {
  const { rows } = await client.query(
    `SELECT ce.*, u.nombre AS emitido_por_nombre
     FROM comprobantes_electronicos ce
     LEFT JOIN usuarios u ON ce.emitido_por_usuario_id = u.id
     WHERE ce.consulta_id = $1
       AND COALESCE(ce.modo_simulacion, false) = false
       AND COALESCE(ce.ecf_id_externo, '') NOT LIKE 'sim-%'
     ORDER BY ce.id DESC`,
    [consultaId]
  );

  const comprobanteActivo =
    rows.find(
      (r) =>
        !['Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO'].includes(
          r.estado
        )
    ) || rows[0] || null;

  return {
    comprobanteActivo,
    historialComprobantes: rows,
  };
}

/**
 * Listado general de Facturación y Comprobantes Electrónicos (e-CF)
 * Accesible para ADMINISTRADOR, MEDICO, SECRETARIA, RECEPCION
 */
exports.listarFacturasEcf = async (req, res, next) => {
  try {
    const { q, estado_ecf } = req.query;
    const params = [];
    let whereSql = 'WHERE 1=1';

    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      whereSql += ` AND (p.nombre ILIKE $${params.length} OR p.apellido ILIKE $${params.length} OR p.identificacion ILIKE $${params.length} OR ce.encf ILIKE $${params.length})`;
    }

    if (estado_ecf && estado_ecf.trim() !== '') {
      if (estado_ecf === 'SIN_EMITIR') {
        whereSql += ` AND ce.id IS NULL`;
      } else {
        params.push(estado_ecf.trim());
        whereSql += ` AND ce.estado = $${params.length}`;
      }
    }

    const { rows: facturas } = await db.query(
      `SELECT c.id AS consulta_id,
              c.fecha_consulta,
              c.valor_total,
              c.valor_cubierto_ars,
              c.diferencia_paciente,
              c.estado_pago,
              p.id AS paciente_id,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              p.identificacion AS paciente_identificacion,
              s.nombre AS servicio_nombre,
              s.codigo AS servicio_codigo,
              COALESCE(s.indicador_facturacion, '4') AS servicio_indicador_facturacion,
              a.nombre AS ars_nombre,
              ce.id AS ecf_local_id,
              ce.ecf_id_externo,
              ce.encf,
              ce.tipo_ecf,
              ce.estado AS ecf_estado,
              ce.track_id,
              ce.codigo_seguridad,
              ce.ambiente,
              ce.modo_simulacion,
              ce.monto_total AS ecf_monto_total,
              ce.fecha_emision AS ecf_fecha_emision
       FROM consultas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       LEFT JOIN servicios s ON c.servicio_id = s.id
       LEFT JOIN ars a ON c.ars_id = a.id
       LEFT JOIN LATERAL (
         SELECT *
         FROM comprobantes_electronicos sub
         WHERE sub.consulta_id = c.id
           AND COALESCE(sub.modo_simulacion, false) = false
           AND COALESCE(sub.ecf_id_externo, '') NOT LIKE 'sim-%'
         ORDER BY
           CASE WHEN sub.estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO') THEN 0 ELSE 1 END,
           sub.id DESC
         LIMIT 1
       ) ce ON true
       ${whereSql}
       ORDER BY c.fecha_consulta DESC, c.id DESC
       LIMIT 100`,
      params
    );

    const configImecf = imecfService.obtenerConfiguracionPublica();

    res.render('ecf/index', {
      facturas: facturas.map((f) => ({
        ...f,
        estadoInfo: f.ecf_estado ? imecfService.clasificarEstadoEcf(f.ecf_estado, f.modo_simulacion) : null,
      })),
      q: q || '',
      estado_ecf: estado_ecf || '',
      configImecf,
      title: 'Facturación y Comprobantes Electrónicos (e-CF)',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Vista dedicada de la Factura y Emisión de Comprobante Electrónico para una Consulta
 */
exports.verFacturaEcf = async (req, res, next) => {
  try {
    const consultaId = parseInt(req.params.consultaId, 10);
    if (Number.isNaN(consultaId)) {
      req.flash('error', 'Identificador de factura inválido.');
      return res.redirect('/ecf');
    }

    const consulta = await obtenerDatosFiscalesConsulta(consultaId);
    if (!consulta) {
      req.flash('error', 'Factura / consulta no encontrada.');
      return res.redirect('/ecf');
    }

    const { comprobanteActivo, historialComprobantes } = await obtenerComprobantesPorConsulta(consultaId);
    const configImecf = imecfService.obtenerConfiguracionPublica();
    const paypalController = require('./paypalController');
    const datosPayPal = await paypalController.obtenerEstadoPagosFactura(consulta);

    // Generar previsualización por defecto del JSON para mostrar en el panel
    let previewDefault = null;
    try {
      previewDefault = imecfService.construirPayloadEcf(consulta, {
        tipoEcf: comprobanteActivo?.tipo_ecf || 'E32',
        indicadorFacturacion: comprobanteActivo?.indicador_facturacion || consulta.servicio_indicador_facturacion || configImecf.defaultIndicador,
        criterioMonto: comprobanteActivo?.criterio_monto || 'TOTAL',
      });
    } catch (_) {
      previewDefault = null;
    }

    // Catálogos para revisión y ajuste de liquidación por Secretaría
    const { rows: servicios } = await db.query(
      `SELECT * FROM servicios WHERE activo = true ORDER BY nombre ASC`
    );
    const { rows: arsList } = await db.query(
      `SELECT * FROM ars WHERE activo = true ORDER BY nombre ASC`
    );
    const { rows: tarifarios } = await db.query(
      `SELECT t.*, a.nombre as ars_nombre, s.codigo as servicio_codigo, s.precio_base
       FROM ars_tarifarios t
       INNER JOIN ars a ON t.ars_id = a.id
       INNER JOIN servicios s ON t.servicio_id = s.id`
    );

    res.render('ecf/factura', {
      consulta,
      comprobanteActivo,
      estadoInfo: comprobanteActivo
        ? imecfService.clasificarEstadoEcf(comprobanteActivo.estado, comprobanteActivo.modo_simulacion)
        : null,
      historialComprobantes: historialComprobantes.map((h) => ({
        ...h,
        estadoInfo: imecfService.clasificarEstadoEcf(h.estado, h.modo_simulacion),
      })),
      indicadoresFacturacion: imecfService.INDICADORES_FACTURACION,
      formasPago: imecfService.FORMAS_PAGO,
      configImecf,
      datosPayPal,
      previewDefault,
      servicios,
      arsList,
      tarifarios,
      title: `Comprobante Electrónico - Factura #${consulta.id}`,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Paso 1 (Secretaría): Registrar el cobro de la factura antes de emitir el comprobante electrónico e-CF
 * POST /ecf/factura/:consultaId/registrar-cobro
 */
exports.registrarCobro = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';

  const consultaId = parseInt(req.params.consultaId, 10);
  const urlRetorno = req.body?.return_to || `/ecf/factura/${consultaId}`;

  if (Number.isNaN(consultaId)) {
    if (esJsonRequest) {
      return res.status(400).json({ success: false, error: 'ID de factura inválido.' });
    }
    req.flash('error', 'ID de factura inválido.');
    return res.redirect('/ecf');
  }

  try {
    const { rows } = await db.query(
      `SELECT c.id, c.valor_total, c.valor_cubierto_ars, c.diferencia_paciente, c.estado_pago,
              c.cita_id, c.diagnostico_clinico, c.tratamiento_plan,
              ci.estado AS cita_estado
       FROM consultas c
       LEFT JOIN citas ci ON c.cita_id = ci.id
       WHERE c.id = $1`,
      [consultaId]
    );

    if (rows.length === 0) {
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'Factura / consulta no encontrada.' });
      }
      req.flash('error', 'Factura / consulta no encontrada.');
      return res.redirect('/ecf');
    }

    const consulta = rows[0];

    // Regla: No permitir cobrar antes de que el médico finalice la consulta
    if (consulta.cita_id && consulta.cita_estado && consulta.cita_estado !== 'Atendida') {
      const msg = 'No se puede cobrar antes de que el médico finalice la consulta (la cita aún no está en estado Atendida).';
      if (esJsonRequest) return res.status(400).json({ success: false, error: msg });
      req.flash('error', msg);
      return res.redirect(urlRetorno);
    }

    if (!consulta.diagnostico_clinico || !consulta.diagnostico_clinico.trim()) {
      const msg = 'No se puede cobrar antes de que el médico finalice la consulta y registre el diagnóstico clínico.';
      if (esJsonRequest) return res.status(400).json({ success: false, error: msg });
      req.flash('error', msg);
      return res.redirect(urlRetorno);
    }

    // Regla: No crear cobros o pagos duplicados
    if (consulta.estado_pago === 'Pagado') {
      const msg = 'Esta consulta ya ha sido pagada previamente. No se permiten cobros duplicados.';
      if (esJsonRequest) return res.status(409).json({ success: false, error: msg });
      req.flash('warning', msg);
      return res.redirect(urlRetorno);
    }

    const metodoPago = String(req.body?.metodo_pago || 'Efectivo').trim();
    const { rows: updated } = await db.query(
      `UPDATE consultas
       SET estado_pago = 'Pagado'
       WHERE id = $1
       RETURNING id, valor_total, valor_cubierto_ars, diferencia_paciente, estado_pago`,
      [consultaId]
    );

    const msg = `Cobro de la factura #${consultaId} registrado exitosamente (${metodoPago}). Ya puede emitir el comprobante electrónico e-CF a través de IMECF.`;
    if (esJsonRequest) {
      return res.json({
        success: true,
        message: msg,
        metodoPago,
        estado_pago: updated[0].estado_pago,
        consulta: updated[0],
      });
    }

    req.flash('success', msg);
    return res.redirect(urlRetorno);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ecf/factura/:consultaId/actualizar-liquidacion
 * Permite al usuario de Secretaría revisar y modificar el servicio y la cobertura ARS
 * antes de registrar el cobro de la consulta médica.
 */
exports.actualizarLiquidacion = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';

  const consultaId = parseInt(req.params.consultaId, 10);
  const urlRetorno = req.body?.return_to || `/ecf/factura/${consultaId}`;

  if (Number.isNaN(consultaId)) {
    if (esJsonRequest) return res.status(400).json({ success: false, error: 'ID de factura inválido.' });
    req.flash('error', 'ID de factura inválido.');
    return res.redirect('/ecf');
  }

  const { servicio_id, ars_id } = req.body;

  try {
    const { rows: cRows } = await db.query(
      `SELECT * FROM consultas WHERE id = $1`,
      [consultaId]
    );

    if (cRows.length === 0) {
      if (esJsonRequest) return res.status(404).json({ success: false, error: 'Consulta no encontrada.' });
      req.flash('error', 'Consulta no encontrada.');
      return res.redirect('/ecf');
    }

    const consulta = cRows[0];
    if (consulta.estado_pago === 'Pagado') {
      const errMsg = 'No se puede modificar la liquidación de una consulta que ya fue cobrada y registrada como Pagada.';
      if (esJsonRequest) return res.status(409).json({ success: false, error: errMsg });
      req.flash('error', errMsg);
      return res.redirect(urlRetorno);
    }

    const nuevoServicioId = servicio_id ? parseInt(servicio_id, 10) : consulta.servicio_id;
    const nuevoArsId = (ars_id !== undefined && ars_id !== null && ars_id !== '' && parseInt(ars_id, 10) > 0)
      ? parseInt(ars_id, 10)
      : null;

    // Calcular tarifario oficial en servidor
    const { rows: sRows } = await db.query(
      `SELECT precio_base FROM servicios WHERE id = $1`,
      [nuevoServicioId]
    );
    const precioBase = sRows.length > 0 ? parseFloat(sRows[0].precio_base) : 0;
    let valorTotal = precioBase;
    let valorCubierto = 0;
    let copago = precioBase;

    if (nuevoArsId && nuevoServicioId) {
      const { rows: tRows } = await db.query(
        `SELECT * FROM ars_tarifarios WHERE ars_id = $1 AND servicio_id = $2 LIMIT 1`,
        [nuevoArsId, nuevoServicioId]
      );
      if (tRows.length > 0) {
        const t = tRows[0];
        valorTotal = parseFloat(t.tarifa_pactada) || precioBase;
        const valCob = parseFloat(t.valor_cobertura) || 0;
        const copagoFijo = parseFloat(t.copago_fijo) || 0;

        if (t.tipo_cobertura === 'PORCENTAJE') {
          valorCubierto = (valorTotal * valCob) / 100.0;
        } else {
          valorCubierto = Math.min(valorTotal, valCob);
        }
        copago = Math.max(0, valorTotal - valorCubierto + copagoFijo);
      }
    }

    const { rows: updated } = await db.query(
      `UPDATE consultas
       SET servicio_id = $1,
           ars_id = $2,
           valor_total = $3,
           valor_cubierto_ars = $4,
           diferencia_paciente = $5
       WHERE id = $6
       RETURNING *`,
      [nuevoServicioId, nuevoArsId, valorTotal, valorCubierto, copago, consultaId]
    );

    const msgOk = 'Liquidación del servicio, cobertura ARS y copago actualizados exitosamente.';
    if (esJsonRequest) {
      return res.json({
        success: true,
        message: msgOk,
        consulta: updated[0],
      });
    }

    req.flash('success', msgOk);
    return res.redirect(urlRetorno);
  } catch (error) {
    next(error);
  }
};

/**
 * Verifica en vivo la conectividad con IMECF y el ambiente (TesteCF vs Producción eCF) asociado a IMECF_API_KEY
 * POST /ecf/verificar-conexion
 * Exclusivo para Administración
 */
exports.verificarConexion = async (req, res) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';
  const urlRetorno = req.body?.return_to || '/ecf';

  if (!req.session?.usuario || req.session.usuario.rol !== 'ADMINISTRADOR') {
    const msgDenegado = 'Acceso reservado para administración. La configuración técnica y verificación de claves corresponde al administrador.';
    if (esJsonRequest) {
      return res.status(403).json({ success: false, error: msgDenegado });
    }
    req.flash('error', msgDenegado);
    return res.redirect(urlRetorno);
  }

  try {
    const resultado = await imecfService.verificarConexionYAmbienteImecf();
    if (esJsonRequest) {
      return res.status(resultado.ok ? 200 : 400).json({
        success: resultado.ok,
        ...resultado,
      });
    }
    if (resultado.ok) {
      req.flash('success', resultado.mensaje);
    } else {
      req.flash('error', resultado.mensaje);
    }
    return res.redirect(urlRetorno);
  } catch (err) {
    const msg = imecfService.sanitizarTextoSeguridad(err.message || 'Error al verificar conexión con IMECF.');
    if (esJsonRequest) {
      return res.status(500).json({
        success: false,
        ok: false,
        mensaje: msg,
      });
    }
    req.flash('error', msg);
    return res.redirect(urlRetorno);
  }
};

/**
 * Emite un comprobante electrónico (POST /ecf/factura/:consultaId/emitir)
 * Exclusivamente a través de la API de IMECF (POST /api/v1/ecf/send).
 * Con validación de cobro previo, verificación de IMECF_API_KEY, protección de ambiente (TesteCF vs eCF),
 * bloqueo en base de datos, prevención de emisiones duplicadas y manejo de timeout incierto.
 */
exports.emitirComprobante = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';

  const consultaId = parseInt(req.params.consultaId, 10);
  const urlRetorno = req.body?.return_to || `/consultas/${consultaId}`;

  if (Number.isNaN(consultaId)) {
    if (esJsonRequest) {
      return res.status(400).json({ success: false, error: 'Identificador de consulta/factura inválido.' });
    }
    req.flash('error', 'Identificador de consulta/factura inválido.');
    return res.redirect('/consultas');
  }

  // No permitir enviar una simulación como si fuera una emisión real
  if (req.body?.modo_simulacion === 'true' || req.body?.modo_simulacion === 'on') {
    const msgSim =
      'El envío real se realiza exclusivamente mediante la API de IMECF (POST /api/v1/ecf/send) y nunca genera respuestas ni TrackIDs simulados. Para visualizar el formato sin emitir, utilice el botón separado "Vista de Demostración Local".';
    if (esJsonRequest) {
      return res.status(400).json({
        success: false,
        error: msgSim,
        codigo: 'SIMULACION_NO_PERMITIDA_EN_EMISION_REAL',
        tipo: 'ERROR_VALIDACION',
      });
    }
    req.flash('error', msgSim);
    return res.redirect(urlRetorno);
  }

  const client = await db.pool.connect();
  let registroEcfId = null;

  try {
    await client.query('BEGIN');

    // 1. Bloquear fila de la factura (consulta) en PostgreSQL para evitar concurrencia / doble clic
    const { rows: lockRows } = await client.query(
      `SELECT id FROM consultas WHERE id = $1 FOR UPDATE`,
      [consultaId]
    );

    if (lockRows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'La factura/consulta indicada no existe.' });
      }
      req.flash('error', 'La factura/consulta indicada no existe.');
      return res.redirect('/consultas');
    }

    // 2. Verificar si ya existe un comprobante activo, en proceso o en estado INCIERTO_TIMEOUT
    const { rows: existentes } = await client.query(
      `SELECT *
       FROM comprobantes_electronicos
       WHERE consulta_id = $1
         AND COALESCE(modo_simulacion, false) = false
         AND COALESCE(ecf_id_externo, '') NOT LIKE 'sim-%'
         AND estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [consultaId]
    );

    if (existentes.length > 0) {
      const actual = existentes[0];

      const bloqueadoHaceMs = actual.bloqueado_desde
        ? Date.now() - new Date(actual.bloqueado_desde).getTime()
        : 0;

      if (actual.bloqueado_envio && bloqueadoHaceMs < 180000) {
        await client.query('ROLLBACK');
        client.release();
        const msg = 'Ya hay un envío de comprobante electrónico en curso para esta factura. Por favor espere a que finalice.';
        if (esJsonRequest) {
          return res.status(409).json({ success: false, error: msg, codigo: 'ENVIO_EN_CURSO', comprobante: actual });
        }
        req.flash('warning', msg);
        return res.redirect(urlRetorno);
      }

      if (actual.estado === 'INCIERTO_TIMEOUT') {
        await client.query('ROLLBACK');
        client.release();
        const msg =
          'El envío anterior sufrió un timeout y su estado es INCIERTO. Por seguridad fiscal, debe ejecutar "Conciliar con IMECF" antes de reenviar para evitar duplicar el comprobante.';
        if (esJsonRequest) {
          return res.status(409).json({
            success: false,
            error: msg,
            codigo: 'INCIERTO_TIMEOUT_PENDIENTE_CONCILIACION',
            comprobante: actual,
          });
        }
        req.flash('warning', msg);
        return res.redirect(urlRetorno);
      }

      await client.query('ROLLBACK');
      client.release();
      const msg = `Esta factura ya cuenta con un comprobante electrónico emitido o en proceso en IMECF (${actual.encf || actual.tipo_ecf} - Estado: ${actual.estado}). No se permiten emisiones duplicadas.`;
      if (esJsonRequest) {
        return res.status(409).json({
          success: false,
          error: msg,
          codigo: 'DUPLICADO_BLOQUEADO',
          comprobante: actual,
        });
      }
      req.flash('warning', msg);
      return res.redirect(urlRetorno);
    }

    // 3. Obtener datos fiscales de la consulta y verificar que el cobro esté registrado si es al contado
    const consulta = await obtenerDatosFiscalesConsulta(consultaId, client);
    const tipoPagoSolicitado = String(req.body.tipo_pago || '1').trim();
    const permitirSinCobroTest = req.body.omitir_validacion_cobro === 'true';

    if (tipoPagoSolicitado === '1' && consulta.estado_pago !== 'Pagado' && !permitirSinCobroTest) {
      await client.query('ROLLBACK');
      client.release();
      const msgCobro =
        'La factura aún figura con pago "Pendiente". Secretaría debe registrar el cobro primero antes de emitir un comprobante electrónico al contado.';
      if (esJsonRequest) {
        return res.status(400).json({
          success: false,
          error: msgCobro,
          codigo: 'COBRO_REQUERIDO',
          tipo: 'ERROR_VALIDACION',
        });
      }
      req.flash('warning', msgCobro);
      return res.redirect(urlRetorno);
    }

    // Determinar medio de pago: si fue pagada por PayPal, registrar como pago electrónico/tarjeta (3) y no como efectivo (1)
    let formaPagoFinal = req.body.forma_pago || '1';
    const { rows: pagoPpRows } = await client.query(
      `SELECT * FROM pagos_paypal WHERE consulta_id = $1 AND estado = 'COMPLETED' LIMIT 1`,
      [consultaId]
    );
    if (pagoPpRows.length > 0 && (!req.body.forma_pago || req.body.forma_pago === '1')) {
      formaPagoFinal = '3'; // 3: Tarjeta Crédito/Débito / Pago Electrónico
    }

    const opcionesEmision = {
      tipoEcf: req.body.tipo_ecf || 'E32',
      indicadorFacturacion: req.body.indicador_facturacion || consulta.servicio_indicador_facturacion || '4',
      criterioMonto: req.body.criterio_monto || 'TOTAL',
      rncComprador: req.body.rnc_comprador,
      razonSocialComprador: req.body.razon_social_comprador,
      correoComprador: req.body.correo_comprador,
      tipoPago: tipoPagoSolicitado,
      formaPago: formaPagoFinal,
      fechaLimitePago: req.body.fecha_limite_pago,
    };

    const { payload, resumenFiscal } = imecfService.construirPayloadEcf(consulta, opcionesEmision);
    const configImecf = imecfService.obtenerConfiguracion();

    // 4. Verificar que la credencial esté configurada antes de intentar emitir
    if (!configImecf.tieneApiKeyReal) {
      await client.query('ROLLBACK');
      client.release();
      const msgFaltaKey =
        'La integración de comprobantes está pendiente de configuración. Contacte al administrador.';
      if (esJsonRequest) {
        return res.status(503).json({
          success: false,
          error: msgFaltaKey,
          codigo: 'ECF_NOT_CONFIGURED',
          tipo: 'ERROR_CONFIGURACION',
        });
      }
      req.flash('error', msgFaltaKey);
      return res.redirect(urlRetorno);
    }

    // 5. Insertar registro persistente con bloqueo activo ANTES de invocar la red hacia IMECF
    const { rows: insertRows } = await client.query(
      `INSERT INTO comprobantes_electronicos (
         consulta_id,
         tipo_ecf,
         estado,
         ambiente,
         modo_simulacion,
         indicador_facturacion,
         criterio_monto,
         tipo_pago,
         forma_pago,
         rnc_comprador,
         razon_social_comprador,
         correo_comprador,
         monto_gravado_total,
         monto_exento,
         total_itbis,
         monto_total,
         request_payload,
         bloqueado_envio,
         bloqueado_desde,
         emitido_por_usuario_id
       ) VALUES (
         $1, $2, 'EN_PROCESO_ENVIO', $3, false, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, true, CURRENT_TIMESTAMP, $16
       ) RETURNING id`,
      [
        consultaId,
        resumenFiscal.tipoEcf,
        configImecf.ambienteConfigurado || 'TesteCF',
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
        JSON.stringify(payload),
        req.session?.usuario?.id || null,
      ]
    );

    registroEcfId = insertRows[0].id;
    await client.query('COMMIT');
    client.release();

    // 6. Llamar a IMECF fuera de la transacción de bloqueo pero con el registro persistente bloqueado en BD
    try {
      const respuesta = await imecfService.enviarComprobante(payload, resumenFiscal, {
        consultaId,
        forzarSimulacion: false,
        simularTimeout: req.body.simular_timeout === 'true',
      });

      const { rows: actualizadoRows } = await db.query(
        `UPDATE comprobantes_electronicos
         SET ecf_id_externo = $1,
             encf = $2,
             tipo_ecf = $3,
             estado = $4,
             track_id = $5,
             codigo_seguridad = $6,
             dgii_url = $7,
             xml_url = $8,
             ambiente = $9,
             modo_simulacion = false,
             secuencia_utilizada = $10,
             enviado_dgii = $11,
             mensaje_error = $12,
             response_payload = $13,
             xml_firmado = COALESCE($14, xml_firmado),
             bloqueado_envio = false,
             fecha_emision = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $15
         RETURNING *`,
        [
          respuesta.ecfIdExterno,
          respuesta.encf,
          respuesta.tipoEcf,
          respuesta.estado,
          respuesta.trackId,
          respuesta.codigoSeguridad,
          respuesta.dgiiUrl,
          respuesta.xmlUrl,
          respuesta.ambiente,
          respuesta.secuenciaUtilizada,
          respuesta.enviadoDgii,
          respuesta.mensajeError,
          JSON.stringify(respuesta.responsePayload || {}),
          respuesta.xmlFirmado,
          registroEcfId,
        ]
      );

      const comprobanteGuardado = actualizadoRows[0];
      const infoEstado = imecfService.clasificarEstadoEcf(
        comprobanteGuardado.estado,
        false
      );

      const notaEstado = infoEstado.enProceso
        ? `Solicitud transmitida a IMECF (eNCF: ${comprobanteGuardado.encf || 'En asignación'} | ID IMECF: ${comprobanteGuardado.ecf_id_externo}). Estado devuelto por IMECF: "${comprobanteGuardado.estado}". Use el botón "Actualizar Estado" para verificar la respuesta final de la DGII.`
        : `Comprobante electrónico ${comprobanteGuardado.encf} procesado por IMECF con estado: ${comprobanteGuardado.estado}.`;

      if (esJsonRequest) {
        return res.status(201).json({
          success: true,
          message: notaEstado,
          comprobante: comprobanteGuardado,
          estadoInfo: infoEstado,
        });
      }

      req.flash('success', notaEstado);
      return res.redirect(urlRetorno);
    } catch (sendErr) {
      // Si ocurrió un timeout o resultado incierto de red, conservar como INCIERTO_TIMEOUT para impedir reenvío ciego
      const estadoFallo = sendErr.incierto
        ? 'INCIERTO_TIMEOUT'
        : sendErr.tipo === 'ERROR_AUTENTICACION'
        ? 'ERROR_AUTENTICACION'
        : sendErr.tipo === 'ERROR_CONFIGURACION'
        ? 'ERROR_CONFIGURACION'
        : 'ERROR_ENVIO';

      const msgSeguro = imecfService.sanitizarTextoSeguridad(sendErr.message);

      const { rows: errRows } = await db.query(
        `UPDATE comprobantes_electronicos
         SET estado = $1,
             mensaje_error = $2,
             response_payload = $3,
             bloqueado_envio = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [
          estadoFallo,
          msgSeguro,
          JSON.stringify({ error: msgSeguro, tipo: sendErr.tipo || 'ERROR_ENVIO' }),
          registroEcfId,
        ]
      );

      if (esJsonRequest) {
        return res.status(sendErr.statusCode || 502).json({
          success: false,
          error: msgSeguro,
          tipo: sendErr.tipo || 'ERROR_ENVIO',
          incierto: Boolean(sendErr.incierto),
          comprobante: errRows[0],
        });
      }

      req.flash(sendErr.incierto ? 'warning' : 'error', msgSeguro);
      return res.redirect(urlRetorno);
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    try {
      client.release();
    } catch (_) {}

    if (error.code === '23505') {
      const msg = 'Ya existe un comprobante electrónico activo o en proceso para esta factura.';
      if (esJsonRequest) {
        return res.status(409).json({ success: false, error: msg, codigo: 'DUPLICADO_BLOQUEADO' });
      }
      req.flash('warning', msg);
      return res.redirect(urlRetorno);
    }

    if (error instanceof imecfService.ImecfError) {
      if (esJsonRequest) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          tipo: error.tipo,
        });
      }
      req.flash('error', error.message);
      return res.redirect(urlRetorno);
    }

    next(error);
  }
};

/**
 * Consulta el estado en IMECF (GET /api/v1/ecf/{id}/status) y actualiza nuestro registro local
 */
exports.actualizarEstado = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json';

  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);

    if (rows.length === 0) {
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'Comprobante electrónico no encontrado.' });
      }
      req.flash('error', 'Comprobante electrónico no encontrado.');
      return res.redirect('/ecf');
    }

    const comprobante = rows[0];
    const urlRetorno = req.body?.return_to || `/consultas/${comprobante.consulta_id}`;

    const estadoRemoto = await imecfService.consultarEstado(comprobante);

    const { rows: updatedRows } = await db.query(
      `UPDATE comprobantes_electronicos
       SET estado = $1,
           track_id = COALESCE($2, track_id),
           codigo_seguridad = COALESCE($3, codigo_seguridad),
           dgii_url = COALESCE($4, dgii_url),
           xml_url = COALESCE($5, xml_url),
           ambiente = COALESCE($6, ambiente),
           mensaje_error = $7,
           response_payload = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        estadoRemoto.estado,
        estadoRemoto.trackId,
        estadoRemoto.codigoSeguridad,
        estadoRemoto.dgiiUrl,
        estadoRemoto.xmlUrl,
        estadoRemoto.ambiente,
        estadoRemoto.mensajeError,
        JSON.stringify(estadoRemoto.responsePayload || {}),
        comprobante.id,
      ]
    );

    const actualizado = updatedRows[0];
    const estadoInfo = imecfService.clasificarEstadoEcf(actualizado.estado, actualizado.modo_simulacion);

    if (esJsonRequest) {
      return res.json({
        success: true,
        message: `Estado actualizado desde IMECF: ${actualizado.estado}`,
        comprobante: actualizado,
        estadoInfo,
      });
    }

    req.flash('info', `Estado del comprobante ${actualizado.encf || ''} actualizado: ${actualizado.estado}.`);
    return res.redirect(urlRetorno);
  } catch (error) {
    if (error instanceof imecfService.ImecfError) {
      if (esJsonRequest) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          tipo: error.tipo,
        });
      }
      req.flash('error', error.message);
      return res.redirect(req.headers.referer || '/ecf');
    }
    next(error);
  }
};

/**
 * Consulta el trackId en la DGII mediante GET /api/v1/ecf/{id}/track
 */
exports.consultarTrack = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json';

  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);

    if (rows.length === 0) {
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'Comprobante electrónico no encontrado.' });
      }
      req.flash('error', 'Comprobante electrónico no encontrado.');
      return res.redirect('/ecf');
    }

    const comprobante = rows[0];
    const urlRetorno = req.body?.return_to || `/consultas/${comprobante.consulta_id}`;

    const trackRemoto = await imecfService.consultarTrackDgii(comprobante);

    const { rows: updatedRows } = await db.query(
      `UPDATE comprobantes_electronicos
       SET estado = $1,
           track_id = COALESCE($2, track_id),
           codigo_seguridad = COALESCE($3, codigo_seguridad),
           dgii_url = COALESCE($4, dgii_url),
           xml_url = COALESCE($5, xml_url),
           ambiente = COALESCE($6, ambiente),
           mensaje_error = $7,
           response_payload = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        trackRemoto.estado,
        trackRemoto.trackId,
        trackRemoto.codigoSeguridad,
        trackRemoto.dgiiUrl,
        trackRemoto.xmlUrl,
        trackRemoto.ambiente,
        trackRemoto.mensajeError,
        JSON.stringify(trackRemoto.responsePayload || {}),
        comprobante.id,
      ]
    );

    const actualizado = updatedRows[0];
    const estadoInfo = imecfService.clasificarEstadoEcf(actualizado.estado, actualizado.modo_simulacion);

    if (esJsonRequest) {
      return res.json({
        success: true,
        message: `Consulta de Track DGII completada. Estado real: ${actualizado.estado}`,
        comprobante: actualizado,
        estadoInfo,
      });
    }

    req.flash(
      actualizado.estado === 'Aceptado' ? 'success' : 'info',
      `Track DGII consultado (${actualizado.track_id || 'N/A'}): Estado "${actualizado.estado}".`
    );
    return res.redirect(urlRetorno);
  } catch (error) {
    if (error instanceof imecfService.ImecfError) {
      if (esJsonRequest) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          tipo: error.tipo,
        });
      }
      req.flash('error', error.message);
      return res.redirect(req.headers.referer || '/ecf');
    }
    next(error);
  }
};

/**
 * Descarga el XML firmado del comprobante pasando por nuestro backend (GET /ecf/documento/:id/xml)
 * Conserva privada la clave ECF_API_KEY en el servidor.
 */
exports.descargarXml = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);

    if (rows.length === 0) {
      req.flash('error', 'Comprobante electrónico no encontrado.');
      return res.redirect('/ecf');
    }

    const comprobante = rows[0];
    const { filename, xml } = await imecfService.obtenerXmlFirmado(comprobante);

    // Guardar copia caché del XML firmado en base de datos si aún no estaba almacenado
    if (!comprobante.xml_firmado && xml) {
      await db.query(`UPDATE comprobantes_electronicos SET xml_firmado = $1 WHERE id = $2`, [xml, comprobante.id]);
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(xml);
  } catch (error) {
    if (error instanceof imecfService.ImecfError) {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          tipo: error.tipo,
        });
      }
      req.flash('error', error.message);
      return res.redirect(req.headers.referer || '/ecf');
    }
    next(error);
  }
};

/**
 * Concilia un comprobante con estado INCIERTO_TIMEOUT antes de permitir un nuevo envío
 */
exports.conciliarTimeout = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';

  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);

    if (rows.length === 0) {
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'Registro de comprobante no encontrado.' });
      }
      req.flash('error', 'Registro de comprobante no encontrado.');
      return res.redirect('/ecf');
    }

    const comprobante = rows[0];
    const urlRetorno = req.body?.return_to || `/consultas/${comprobante.consulta_id}`;

    const resultadoConciliacion = await imecfService.conciliarComprobanteIncierto(comprobante);

    if (resultadoConciliacion.encontradoEnImecf && resultadoConciliacion.doc) {
      const doc = resultadoConciliacion.doc;
      const { rows: recRows } = await db.query(
        `UPDATE comprobantes_electronicos
         SET ecf_id_externo = $1,
             encf = $2,
             estado = $3,
             track_id = $4,
             codigo_seguridad = $5,
             dgii_url = $6,
             ambiente = COALESCE($7, ambiente),
             mensaje_error = NULL,
             bloqueado_envio = false,
             response_payload = $8,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $9
         RETURNING *`,
        [
          doc.id,
          doc.encf,
          doc.estado || 'En Proceso',
          doc.trackId || null,
          doc.codigoSeguridad || null,
          doc.dgiiUrl || null,
          doc.ambiente || null,
          JSON.stringify(doc),
          comprobante.id,
        ]
      );

      if (esJsonRequest) {
        return res.json({
          success: true,
          reconciled: true,
          encontradoEnImecf: true,
          message: resultadoConciliacion.mensaje,
          comprobante: recRows[0],
        });
      }
      req.flash('success', resultadoConciliacion.mensaje);
      return res.redirect(urlRetorno);
    }

    // Si se confirmó que NO llegó a IMECF, marcar el intento incierto como ANULADO para liberar el índice único y permitir reenviar
    const { rows: anuladoRows } = await db.query(
      `UPDATE comprobantes_electronicos
       SET estado = 'ANULADO',
           mensaje_error = 'Conciliado tras timeout: se verificó que no fue procesado en IMECF; liberado para reenvío seguro.',
           bloqueado_envio = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [comprobante.id]
    );

    if (esJsonRequest) {
      return res.json({
        success: true,
        reconciled: true,
        encontradoEnImecf: false,
        message: resultadoConciliacion.mensaje,
        comprobante: anuladoRows[0],
      });
    }

    req.flash('info', resultadoConciliacion.mensaje);
    return res.redirect(urlRetorno);
  } catch (error) {
    if (error instanceof imecfService.ImecfError) {
      if (esJsonRequest) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          tipo: error.tipo,
        });
      }
      req.flash('error', error.message);
      return res.redirect(req.headers.referer || '/ecf');
    }
    next(error);
  }
};

/**
 * Construye el HTML de la Representación Impresa (RI) indicando sin ambigüedad
 * si el comprobante fue realmente transmitido a través de IMECF o si es una vista de demostración local.
 */
function construirHtmlRepresentacionImpresa(comprobante, consulta, { esDemoSinEnvio = false } = {}) {
  const esSimulado = Boolean(esDemoSinEnvio || comprobante.modo_simulacion || String(comprobante.ecf_id_externo || '').startsWith('sim-'));
  const estadoInfo = imecfService.clasificarEstadoEcf(comprobante.estado, esSimulado);

  let respPayload = comprobante.response_payload;
  if (typeof respPayload === 'string') {
    try {
      respPayload = JSON.parse(respPayload);
    } catch (_) {
      respPayload = {};
    }
  }
  const docImecf = respPayload?.data || respPayload || {};
  const emisorImecf = docImecf?.requestJson?.ECF?.Encabezado?.Emisor || {};
  const idDocImecf = docImecf?.requestJson?.ECF?.Encabezado?.IdDoc || {};

  const clinicName = emisorImecf.RazonSocialEmisor || process.env.CLINIC_NAME || 'Consultorio Médico San Rafael';
  const clinicAddress = emisorImecf.DireccionEmisor || process.env.CLINIC_ADDRESS || 'Av. San Rafael #102, Santiago de los Caballeros';
  const rncEmisorReal = emisorImecf.RNCEmisor || (esSimulado ? 'No aplica (Demostración Local)' : 'Inyectado por IMECF en XML firmado');

  const qrUrl =
    !esSimulado && comprobante.dgii_url
      ? `https://quickchart.io/qr?size=150&text=${encodeURIComponent(comprobante.dgii_url)}`
      : null;

  let bannerHtml = '';
  if (esSimulado) {
    bannerHtml = `
      <div style="background:#fef3c7;border:2px dashed #d97706;color:#92400e;padding:12px 16px;border-radius:8px;margin-bottom:18px;text-align:center;font-weight:700;font-size:13px;">
        MODO DEMOSTRACIÓN LOCAL — DOCUMENTO NO TRANSMITIDO A IMECF NI A LA DGII (SIN VALIDEZ FISCAL)
      </div>`;
  } else if (!estadoInfo.aceptadoDgii) {
    bannerHtml = `
      <div style="background:#fee2e2;border:2px solid #dc2626;color:#991b1b;padding:12px 16px;border-radius:8px;margin-bottom:18px;text-align:center;font-weight:700;font-size:13px;">
        TRANSMITIDO A IMECF — ESTADO ACTUAL: ${comprobante.estado || 'PENDIENTE'} (AÚN NO CONFIRMADO COMO ACEPTADO POR LA DGII)
        ${comprobante.mensaje_error ? `<div style="font-weight:400;font-size:12px;margin-top:4px;">Detalle: ${comprobante.mensaje_error}</div>` : ''}
      </div>`;
  } else if (comprobante.ambiente === 'eCF') {
    bannerHtml = `
      <div style="background:#dcfce7;border:1px solid #16a34a;color:#166534;padding:10px 14px;border-radius:8px;margin-bottom:18px;text-align:center;font-weight:700;font-size:12.5px;">
        COMPROBANTE TRANSMITIDO REALMENTE VÍA IMECF Y ACEPTADO POR LA DGII — AMBIENTE DE PRODUCCIÓN (eCF)
      </div>`;
  } else {
    bannerHtml = `
      <div style="background:#dbeafe;border:1px solid #2563eb;color:#1e40af;padding:10px 14px;border-radius:8px;margin-bottom:18px;text-align:center;font-weight:700;font-size:12.5px;">
        COMPROBANTE TRANSMITIDO REALMENTE VÍA IMECF Y ACEPTADO POR LA DGII — AMBIENTE DE PRUEBAS (${comprobante.ambiente || 'TesteCF'})
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${esSimulado ? 'Demostración Local e-CF (No Transmitido)' : `Representación Impresa e-CF ${comprobante.encf || ''}`}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #1e293b; background: #f8fafc; margin: 0; padding: 24px; }
    .sheet { max-width: 780px; margin: 0 auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .top { display: flex; justify-content: space-between; border-bottom: 2px solid #0f766e; padding-bottom: 16px; margin-bottom: 18px; gap: 16px; }
    .box-encf { border: 2px solid #0f766e; border-radius: 8px; padding: 12px 16px; text-align: right; min-width: 240px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; font-size: 13px; }
    .panel { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 13px; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 8px; text-align: left; }
    th { background: #f1f5f9; font-weight: 700; }
    .totals { width: 290px; margin-left: auto; font-size: 13px; }
    .totals .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
    .totals .row.grand { font-size: 15px; font-weight: 800; color: #0f766e; border-top: 2px solid #0f766e; border-bottom: none; padding-top: 10px; }
    .footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #cbd5e1; padding-top: 16px; margin-top: 16px; font-size: 12px; color: #475569; }
    .no-print { text-align: center; margin-bottom: 14px; }
    .btn { padding: 8px 16px; background: #0f766e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
    @media print { body { background: #fff; padding: 0; } .sheet { border: none; box-shadow: none; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn" onclick="window.print()">Imprimir / Guardar PDF</button>
  </div>
  <div class="sheet">
    ${bannerHtml}
    <div class="top">
      <div>
        <h2 style="margin:0 0 4px 0; color:#0f766e;">${clinicName}</h2>
        <div style="font-size:13px; color:#475569;">${clinicAddress}</div>
        <div style="font-size:12.5px; margin-top:4px;"><strong>RNC Emisor:</strong> ${rncEmisorReal}</div>
        <div style="font-size:12.5px;"><strong>Proveedor e-CF:</strong> IMECF API &bull; <strong>Transmisión Real:</strong> ${esSimulado ? 'NO (Demostración Local)' : 'SÍ (Vía API IMECF)'}</div>
      </div>
      <div class="box-encf">
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#0f766e;">
          ${comprobante.tipo_ecf === 'E31' ? 'Factura de Crédito Fiscal Electrónica (E31)' : 'Factura de Consumo Electrónica (E32)'}
        </div>
        <div style="font-size:20px; font-weight:800; font-family:monospace; margin:4px 0;">
          ${esSimulado ? 'SIN-ENCF (DEMO)' : (comprobante.encf || 'PENDIENTE')}
        </div>
        <div style="font-size:11.5px; color:#475569;">
          <strong>Estado IMECF / DGII:</strong> ${esSimulado ? 'NO TRANSMITIDO (DEMO)' : comprobante.estado}<br>
          <strong>Ambiente:</strong> ${esSimulado ? 'Demostración Local' : (comprobante.ambiente || 'TesteCF')}<br>
          ${idDocImecf.FechaVencimientoSecuencia ? `<strong>Venc. Secuencia:</strong> ${idDocImecf.FechaVencimientoSecuencia}` : ''}
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="panel">
        <div style="font-weight:700; font-size:11.5px; text-transform:uppercase; color:#64748b; margin-bottom:6px;">Datos del Comprador</div>
        <div><strong>Nombre / Razón Social:</strong> ${comprobante.razon_social_comprador || 'Consumidor Final'}</div>
        <div><strong>RNC / Cédula:</strong> ${comprobante.rnc_comprador || 'N/A'}</div>
        <div><strong>Correo:</strong> ${comprobante.correo_comprador || 'N/A'}</div>
      </div>
      <div class="panel">
        <div style="font-weight:700; font-size:11.5px; text-transform:uppercase; color:#64748b; margin-bottom:6px;">Trazabilidad IMECF &amp; DGII</div>
        <div><strong>Factura Interna:</strong> #${consulta?.id || comprobante.consulta_id}</div>
        <div><strong>ID Externo IMECF:</strong> ${esSimulado ? 'No transmitido' : (comprobante.ecf_id_externo || 'N/A')}</div>
        <div><strong>TrackID DGII:</strong> ${esSimulado ? 'No transmitido' : (comprobante.track_id || 'Pendiente / No asignado')}</div>
        <div><strong>Código Seguridad:</strong> ${esSimulado ? 'No aplica' : (comprobante.codigo_seguridad || 'N/A')}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Código</th>
          <th>Descripción Fiscal del Servicio</th>
          <th style="text-align:center;">Cant.</th>
          <th style="text-align:right;">Precio Unitario</th>
          <th style="text-align:right;">Total Línea</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${consulta?.servicio_codigo || 'SERV-MED'}</td>
          <td>${consulta?.servicio_nombre || 'Consulta Médica General'} (Sin datos clínicos)</td>
          <td style="text-align:center;">1</td>
          <td style="text-align:right;">RD$ ${Number(comprobante.monto_exento > 0 ? comprobante.monto_exento : comprobante.monto_gravado_total).toFixed(2)}</td>
          <td style="text-align:right;">RD$ ${Number(comprobante.monto_exento > 0 ? comprobante.monto_exento : comprobante.monto_gravado_total).toFixed(2)}</td>
        </tr>
      </tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Monto Exento:</span><strong>RD$ ${Number(comprobante.monto_exento || 0).toFixed(2)}</strong></div>
      <div class="row"><span>Monto Gravado:</span><strong>RD$ ${Number(comprobante.monto_gravado_total || 0).toFixed(2)}</strong></div>
      <div class="row"><span>ITBIS:</span><strong>RD$ ${Number(comprobante.total_itbis || 0).toFixed(2)}</strong></div>
      <div class="row grand"><span>Total e-CF:</span><strong>RD$ ${Number(comprobante.monto_total || 0).toFixed(2)}</strong></div>
    </div>

    <div class="footer">
      <div>
        <div><strong>¿Transmitido realmente a IMECF / DGII?:</strong> ${esSimulado ? 'NO — Vista de demostración local sin validez fiscal' : `SÍ — Estado actual: ${comprobante.estado}`}</div>
        <div><strong>Fecha de registro:</strong> ${new Date(comprobante.fecha_emision || Date.now()).toLocaleString('es-DO')}</div>
        ${!esSimulado && comprobante.dgii_url ? `<div style="margin-top:4px;"><a href="${comprobante.dgii_url}" target="_blank" rel="noopener">Validar timbre electrónico en portal de la DGII</a></div>` : ''}
      </div>
      <div>
        ${qrUrl ? `<img src="${qrUrl}" alt="QR DGII" width="120" height="120">` : `<div style="border:1px dashed #94a3b8;padding:10px;border-radius:6px;font-size:11px;max-width:160px;text-align:center;">${esSimulado ? 'Sin QR fiscal (Demostración no transmitida)' : 'QR disponible cuando IMECF retorna dgiiUrl'}</div>`}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * GET /ecf/documento/:id/impresion
 * Muestra la Representación Impresa (RI) de un comprobante real emitido en IMECF.
 */
exports.verRepresentacionImpresa = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);
    if (rows.length === 0) {
      req.flash('error', 'Comprobante electrónico no encontrado.');
      return res.redirect('/ecf');
    }
    const comprobante = rows[0];
    const consulta = await obtenerDatosFiscalesConsulta(comprobante.consulta_id);
    const html = construirHtmlRepresentacionImpresa(comprobante, consulta, {
      esDemoSinEnvio: Boolean(comprobante.modo_simulacion),
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ecf/documento/:id/enviar-correo
 * Paso separado para enviar la representación del comprobante al correo del paciente/comprador.
 */
exports.enviarComprobanteCorreo = async (req, res, next) => {
  const esJsonRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato_respuesta === 'json';

  try {
    const { id } = req.params;
    const { rows } = await db.query(`SELECT * FROM comprobantes_electronicos WHERE id = $1`, [id]);
    if (rows.length === 0) {
      if (esJsonRequest) {
        return res.status(404).json({ success: false, error: 'Comprobante electrónico no encontrado.' });
      }
      req.flash('error', 'Comprobante electrónico no encontrado.');
      return res.redirect('/ecf');
    }

    const comprobante = rows[0];
    const urlRetorno = req.body?.return_to || `/ecf/factura/${comprobante.consulta_id}`;
    const consulta = await obtenerDatosFiscalesConsulta(comprobante.consulta_id);
    const correoDestino = String(req.body?.correo_destino || comprobante.correo_comprador || consulta?.paciente_correo || '').trim();

    // Si aún no hay TrackID, pedírselo a IMECF antes de enviar (GET /api/v1/ecf/{id}/status).
    // En el ambiente de pruebas puede no existir; el correo lo indicará sin parecer un error.
    if (!comprobante.track_id && comprobante.ecf_id_externo && !comprobante.modo_simulacion) {
      try {
        const estadoRemoto = await imecfService.consultarEstado(comprobante);
        if (estadoRemoto.trackId) {
          await db.query(
            `UPDATE comprobantes_electronicos SET track_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [estadoRemoto.trackId, comprobante.id]
          );
          comprobante.track_id = estadoRemoto.trackId;
        }
      } catch (errTrack) {
        console.warn('[e-CF CORREO] No se pudo consultar el TrackID en IMECF:', errTrack.message);
      }
    }

    const representacionHtml = construirHtmlRepresentacionImpresa(comprobante, consulta, {
      esDemoSinEnvio: Boolean(comprobante.modo_simulacion),
    });

    const resultadoCorreo = await emailService.enviarComprobanteEcf({
      correoDestino,
      nombreComprador: comprobante.razon_social_comprador || `${consulta?.paciente_nombre || ''} ${consulta?.paciente_apellido || ''}`.trim(),
      encf: comprobante.encf,
      tipoEcf: comprobante.tipo_ecf,
      estadoDgii: comprobante.estado,
      trackId: comprobante.track_id,
      codigoSeguridad: comprobante.codigo_seguridad,
      montoTotal: comprobante.monto_total, // mismo campo que usa el PDF; el formato lo aplica emailService
      fechaEmision: new Date(comprobante.fecha_emision || Date.now()).toLocaleString('es-DO'),
      ambiente: comprobante.ambiente || 'TesteCF',
      modoSimulacion: Boolean(comprobante.modo_simulacion),
      dgiiUrl: comprobante.dgii_url,
      representacionHtml,
      xmlFirmado: comprobante.xml_firmado,
    });

    if (esJsonRequest) {
      return res.status(resultadoCorreo.enviado ? 200 : 400).json({
        success: resultadoCorreo.enviado,
        ...resultadoCorreo,
      });
    }

    const tipoAviso = resultadoCorreo.enviado ? 'success' : (resultadoCorreo.metodo === 'consola_dev' ? 'warning' : 'error');
    req.flash(tipoAviso, resultadoCorreo.mensaje || 'Proceso de correo finalizado.');
    return res.redirect(urlRetorno);
  } catch (error) {
    next(error);
  }
};

exports.obtenerComprobantesPorConsulta = obtenerComprobantesPorConsulta;

