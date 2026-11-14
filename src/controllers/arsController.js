const db = require('../config/db');

// Listar ARS registradas
exports.listar = async (req, res, next) => {
  try {
    const queryText = `
      SELECT a.*,
             COUNT(DISTINCT p.id) AS total_pacientes,
             COUNT(DISTINCT t.id) AS total_tarifas
      FROM ars a
      LEFT JOIN pacientes p ON p.ars_id = a.id
      LEFT JOIN ars_tarifarios t ON t.ars_id = a.id
      GROUP BY a.id
      ORDER BY a.nombre ASC
    `;

    const { rows: arsList } = await db.query(queryText);

    res.render('ars/index', {
      arsList,
      title: 'Administración de ARS y Aseguradoras',
    });
  } catch (error) {
    next(error);
  }
};

// Formulario de nueva ARS
exports.formularioCrear = (req, res) => {
  res.render('ars/form', {
    ars: {},
    esEdicion: false,
    title: 'Registrar Nueva ARS / Seguro Médico',
  });
};

// Crear nueva ARS
exports.crear = async (req, res, next) => {
  try {
    const { nombre, codigo, telefono, correo, contacto_nombre, notas } = req.body;

    if (!nombre) {
      req.flash('error', 'El nombre de la ARS es obligatorio.');
      return res.redirect('/ars/nueva');
    }

    const { rows: existentes } = await db.query(
      `SELECT id FROM ars WHERE nombre ILIKE $1`,
      [nombre.trim()]
    );

    if (existentes.length > 0) {
      req.flash('error', `Ya existe una ARS registrada con el nombre "${nombre}".`);
      return res.redirect('/ars/nueva');
    }

    const insertQuery = `
      INSERT INTO ars (nombre, codigo, telefono, correo, contacto_nombre, notas)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;

    const values = [
      nombre.trim(),
      codigo ? codigo.trim() : null,
      telefono ? telefono.trim() : null,
      correo ? correo.trim() : null,
      contacto_nombre ? contacto_nombre.trim() : null,
      notas ? notas.trim() : null,
    ];

    const result = await db.query(insertQuery, values);

    const esAdmin = req.session && req.session.usuario && req.session.usuario.rol === 'ADMINISTRADOR';
    if (esAdmin) {
      req.flash('success', 'ARS registrada correctamente. Ahora puede configurar sus tarifarios.');
      res.redirect(`/ars/${result.rows[0].id}/tarifas`);
    } else {
      req.flash('success', 'Aseguradora (ARS) registrada correctamente.');
      res.redirect('/ars');
    }
  } catch (error) {
    next(error);
  }
};

// Ver y gestionar tarifarios de una ARS específica
exports.verTarifas = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: arsRows } = await db.query(`SELECT * FROM ars WHERE id = $1`, [id]);
    if (arsRows.length === 0) {
      req.flash('error', 'ARS no encontrada.');
      return res.redirect('/ars');
    }

    const ars = arsRows[0];

    // Obtener los tarifarios configurados para esta ARS
    const { rows: tarifas } = await db.query(
      `SELECT t.*, s.codigo AS servicio_codigo, s.nombre AS servicio_nombre, s.precio_base
       FROM ars_tarifarios t
       INNER JOIN servicios s ON t.servicio_id = s.id
       WHERE t.ars_id = $1
       ORDER BY s.nombre ASC`,
      [id]
    );

    // Obtener todos los servicios médicos disponibles para agregar o modificar
    const { rows: servicios } = await db.query(
      `SELECT * FROM servicios WHERE activo = true ORDER BY nombre ASC`
    );

    res.render('ars/tarifas', {
      ars,
      tarifas,
      servicios,
      title: `Tarifario y Cobertura: ${ars.nombre}`,
    });
  } catch (error) {
    next(error);
  }
};

// Guardar o actualizar una tarifa para un servicio y ARS
exports.guardarTarifa = async (req, res, next) => {
  try {
    const { id: ars_id } = req.params;
    const {
      servicio_id,
      tarifa_pactada,
      tipo_cobertura,
      valor_cobertura,
      copago_fijo,
      notas,
    } = req.body;

    if (!servicio_id || !tarifa_pactada || !tipo_cobertura || valor_cobertura === undefined) {
      req.flash('error', 'Todos los campos de la tarifa son obligatorios.');
      return res.redirect(`/ars/${ars_id}/tarifas`);
    }

    const tarifaNum = parseFloat(tarifa_pactada);
    const coberturaNum = parseFloat(valor_cobertura);
    const copagoNum = parseFloat(copago_fijo) || 0.00;

    if (isNaN(tarifaNum) || isNaN(coberturaNum) || tarifaNum < 0 || coberturaNum < 0) {
      req.flash('error', 'Los valores numéricos deben ser válidos y positivos.');
      return res.redirect(`/ars/${ars_id}/tarifas`);
    }

    if (tipo_cobertura === 'PORCENTAJE' && (coberturaNum < 0 || coberturaNum > 100)) {
      req.flash('error', 'El porcentaje de cobertura debe estar entre 0% y 100%.');
      return res.redirect(`/ars/${ars_id}/tarifas`);
    }

    // Insertar o actualizar con UPSERT
    const queryText = `
      INSERT INTO ars_tarifarios (
        ars_id, servicio_id, tarifa_pactada, tipo_cobertura,
        valor_cobertura, copago_fijo, notas, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (ars_id, servicio_id) DO UPDATE SET
        tarifa_pactada = EXCLUDED.tarifa_pactada,
        tipo_cobertura = EXCLUDED.tipo_cobertura,
        valor_cobertura = EXCLUDED.valor_cobertura,
        copago_fijo = EXCLUDED.copago_fijo,
        notas = EXCLUDED.notas,
        updated_at = CURRENT_TIMESTAMP
    `;

    const values = [
      parseInt(ars_id, 10),
      parseInt(servicio_id, 10),
      tarifaNum,
      tipo_cobertura,
      coberturaNum,
      copagoNum,
      notas ? notas.trim() : null,
    ];

    await db.query(queryText, values);
    req.flash('success', 'Tarifario y porcentaje de cobertura guardados exitosamente.');
    res.redirect(`/ars/${ars_id}/tarifas`);
  } catch (error) {
    next(error);
  }
};

// Eliminar tarifa específica
exports.eliminarTarifa = async (req, res, next) => {
  try {
    const { id: ars_id, tarifaId } = req.params;
    await db.query(`DELETE FROM ars_tarifarios WHERE id = $1 AND ars_id = $2`, [tarifaId, ars_id]);
    req.flash('info', 'Tarifa eliminada del tarifario.');
    res.redirect(`/ars/${ars_id}/tarifas`);
  } catch (error) {
    next(error);
  }
};

// Simulador y Calculadora de Cobertura y Cobros
exports.calculadora = async (req, res, next) => {
  try {
    const { rows: arsList } = await db.query(
      `SELECT * FROM ars WHERE activo = true ORDER BY nombre ASC`
    );

    const { rows: servicios } = await db.query(
      `SELECT * FROM servicios WHERE activo = true ORDER BY nombre ASC`
    );

    const { rows: tarifarios } = await db.query(`
      SELECT t.*, a.nombre as ars_nombre, s.nombre as servicio_nombre, s.codigo as servicio_codigo
      FROM ars_tarifarios t
      INNER JOIN ars a ON t.ars_id = a.id
      INNER JOIN servicios s ON t.servicio_id = s.id
    `);

    res.render('ars/calcular', {
      arsList,
      servicios,
      tarifarios,
      title: 'Calculadora de Cobertura de Seguros y Copagos',
    });
  } catch (error) {
    next(error);
  }
};

// API Endpoint para cálculo exacto según reglas configuradas
exports.apiCalcular = async (req, res) => {
  try {
    const { ars_id, servicio_id } = req.query;

    if (!servicio_id) {
      return res.status(400).json({ error: 'Debe especificar el servicio' });
    }

    // 1. Obtener servicio
    const { rows: sRows } = await db.query(
      `SELECT * FROM servicios WHERE id = $1`,
      [servicio_id]
    );

    if (sRows.length === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const servicio = sRows[0];
    let valorTotal = parseFloat(servicio.precio_base);
    let valorCubierto = 0.00;
    let diferenciaPaciente = valorTotal;
    let reglaAplicada = 'Tarifa base particular (Sin cobertura ARS configurada)';
    let tieneTarifario = false;

    // 2. Si tiene ARS seleccionada, buscar tarifario configurado
    if (ars_id && ars_id !== '0' && ars_id !== '') {
      const { rows: tRows } = await db.query(
        `SELECT * FROM ars_tarifarios WHERE ars_id = $1 AND servicio_id = $2`,
        [ars_id, servicio_id]
      );

      if (tRows.length > 0) {
        tieneTarifario = true;
        const tarifa = tRows[0];
        valorTotal = parseFloat(tarifa.tarifa_pactada);
        const valorCob = parseFloat(tarifa.valor_cobertura);
        const copagoFijo = parseFloat(tarifa.copago_fijo) || 0.00;

        if (tarifa.tipo_cobertura === 'PORCENTAJE') {
          // Cobertura calculada por porcentaje
          valorCubierto = (valorTotal * valorCob) / 100.0;
          diferenciaPaciente = Math.max(0, valorTotal - valorCubierto + copagoFijo);
          reglaAplicada = `Tarifa ARS: RD$ ${valorTotal.toFixed(2)} | Cobertura ${valorCob}% (-RD$ ${valorCubierto.toFixed(2)}) + Copago RD$ ${copagoFijo.toFixed(2)}`;
        } else {
          // Cobertura calculada por monto fijo
          valorCubierto = Math.min(valorTotal, valorCob);
          diferenciaPaciente = Math.max(0, valorTotal - valorCubierto + copagoFijo);
          reglaAplicada = `Tarifa ARS: RD$ ${valorTotal.toFixed(2)} | Cobertura fija (-RD$ ${valorCubierto.toFixed(2)}) + Copago RD$ ${copagoFijo.toFixed(2)}`;
        }
      }
    }

    return res.json({
      servicio_id: servicio.id,
      servicio_nombre: servicio.nombre,
      precio_base: parseFloat(servicio.precio_base),
      tiene_tarifario: tieneTarifario,
      valor_total: valorTotal,
      valor_cubierto_ars: valorCubierto,
      diferencia_paciente: diferenciaPaciente,
      regla_aplicada: reglaAplicada,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Listado de Cobros y Liquidación al Paciente (Exclusivo Secretaría y Administración)
 * GET /ars/cobrar
 */
exports.listarCobros = async (req, res, next) => {
  try {
    const { q, estado } = req.query;
    const filtroEstado = estado || 'Pendiente'; // 'Pendiente', 'Pagado', 'Todos'

    let queryText = `
      SELECT c.id AS consulta_id,
             c.cita_id,
             c.fecha_consulta,
             c.motivo_consulta,
             c.diagnostico_clinico,
             c.tratamiento_plan,
             c.valor_total,
             c.valor_cubierto_ars,
             c.diferencia_paciente,
             c.estado_pago,
             c.created_at,
             p.id AS paciente_id,
             p.nombre AS paciente_nombre,
             p.apellido AS paciente_apellido,
             p.identificacion AS paciente_identificacion,
             p.telefono AS paciente_telefono,
             p.numero_afiliado AS paciente_afiliado,
             s.id AS servicio_id,
             s.nombre AS servicio_nombre,
             s.codigo AS servicio_codigo,
             s.precio_base,
             a.id AS ars_id,
             a.nombre AS ars_nombre,
             ci.id AS cita_ref_id,
             ci.fecha AS cita_fecha,
             ci.hora AS cita_hora,
             ci.estado AS cita_estado,
             ce.id AS ecf_id,
             ce.encf AS ecf_encf,
             ce.estado AS ecf_estado,
             ce.tipo_ecf AS ecf_tipo
      FROM consultas c
      INNER JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN servicios s ON c.servicio_id = s.id
      LEFT JOIN ars a ON c.ars_id = a.id
      LEFT JOIN citas ci ON c.cita_id = ci.id
      LEFT JOIN LATERAL (
        SELECT id, encf, estado, tipo_ecf
        FROM comprobantes_electronicos sub
        WHERE sub.consulta_id = c.id
        ORDER BY sub.id DESC
        LIMIT 1
      ) ce ON true
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (filtroEstado === 'Pendiente') {
      queryText += ` AND c.estado_pago = 'Pendiente'`;
    } else if (filtroEstado === 'Pagado') {
      queryText += ` AND c.estado_pago = 'Pagado'`;
    }

    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (
        p.nombre ILIKE $${paramIdx} OR
        p.apellido ILIKE $${paramIdx} OR
        p.identificacion ILIKE $${paramIdx} OR
        s.nombre ILIKE $${paramIdx} OR
        a.nombre ILIKE $${paramIdx} OR
        c.diagnostico_clinico ILIKE $${paramIdx}
      )`;
      paramIdx++;
    }

    queryText += ` ORDER BY (c.estado_pago = 'Pendiente') DESC, c.fecha_consulta DESC, c.id DESC LIMIT 150`;

    const { rows: cobros } = await db.query(queryText, params);

    // Métricas del panel de cobros
    const { rows: metricasRows } = await db.query(`
      SELECT
        COUNT(CASE WHEN c.estado_pago = 'Pendiente' THEN 1 END) AS pendientes_cantidad,
        COALESCE(SUM(CASE WHEN c.estado_pago = 'Pendiente' THEN c.diferencia_paciente ELSE 0 END), 0) AS pendientes_monto,
        COUNT(CASE WHEN c.estado_pago = 'Pagado' AND c.fecha_consulta::date = CURRENT_DATE THEN 1 END) AS pagados_hoy_cantidad,
        COALESCE(SUM(CASE WHEN c.estado_pago = 'Pagado' AND c.fecha_consulta::date = CURRENT_DATE THEN c.diferencia_paciente ELSE 0 END), 0) AS pagados_hoy_monto,
        COUNT(CASE WHEN c.estado_pago = 'Pagado' THEN 1 END) AS total_pagados
      FROM consultas c
    `);
    const metricas = metricasRows[0] || {
      pendientes_cantidad: 0,
      pendientes_monto: 0,
      pagados_hoy_cantidad: 0,
      pagados_hoy_monto: 0,
      total_pagados: 0,
    };

    // Listas para selector de liquidación
    const { rows: servicios } = await db.query(`SELECT * FROM servicios WHERE activo = true ORDER BY nombre ASC`);
    const { rows: arsList } = await db.query(`SELECT * FROM ars WHERE activo = true ORDER BY nombre ASC`);

    res.render('ars/cobrar', {
      cobros,
      metricas,
      servicios,
      arsList,
      q: q || '',
      filtroEstado,
      title: 'Cobro de Consultas y Liquidación ARS - San Rafael',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Registrar cobro de la consulta y actualizar estado a 'Pagado'
 * POST /ars/cobrar/:consultaId
 */
exports.registrarCobro = async (req, res, next) => {
  const esJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.body?.formato === 'json';
  const consultaId = parseInt(req.params.consultaId, 10);
  const metodoPago = String(req.body.metodo_pago || 'Efectivo').trim();
  const returnTo = req.body.return_to || '/ars/cobrar';

  if (!consultaId || isNaN(consultaId)) {
    if (esJson) return res.status(400).json({ success: false, error: 'ID de consulta inválido.' });
    req.flash('error', 'ID de consulta inválido.');
    return res.redirect('/ars/cobrar');
  }

  try {
    const { rows: cRows } = await db.query(
      `SELECT c.*,
              ci.estado AS cita_estado,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido
       FROM consultas c
       LEFT JOIN citas ci ON c.cita_id = ci.id
       INNER JOIN pacientes p ON c.paciente_id = p.id
       WHERE c.id = $1`,
      [consultaId]
    );

    if (cRows.length === 0) {
      if (esJson) return res.status(404).json({ success: false, error: 'Consulta médica no encontrada.' });
      req.flash('error', 'Consulta médica no encontrada.');
      return res.redirect('/ars/cobrar');
    }

    const consulta = cRows[0];

    // 1. Validar que el médico haya finalizado la consulta
    if (consulta.cita_id && consulta.cita_estado && consulta.cita_estado !== 'Atendida') {
      const msg = 'No se puede cobrar antes de que el médico finalice la consulta (la cita aún no está en estado Atendida).';
      if (esJson) return res.status(400).json({ success: false, error: msg });
      req.flash('error', msg);
      return res.redirect(returnTo);
    }

    if (!consulta.diagnostico_clinico || !consulta.diagnostico_clinico.trim()) {
      const msg = 'No se puede cobrar antes de que el médico finalice la consulta y registre el diagnóstico clínico.';
      if (esJson) return res.status(400).json({ success: false, error: msg });
      req.flash('error', msg);
      return res.redirect(returnTo);
    }

    // 2. Validar que no se creen cobros duplicados
    if (consulta.estado_pago === 'Pagado') {
      const msg = 'Esta consulta ya ha sido pagada previamente. No se permiten cobros duplicados.';
      if (esJson) return res.status(409).json({ success: false, error: msg });
      req.flash('warning', msg);
      return res.redirect(returnTo);
    }

    // 3. Registrar el cobro y actualizar estado a 'Pagado'
    const { rows: updated } = await db.query(
      `UPDATE consultas
       SET estado_pago = 'Pagado'
       WHERE id = $1
       RETURNING id, valor_total, valor_cubierto_ars, diferencia_paciente, estado_pago`,
      [consultaId]
    );

    const copagoNum = parseFloat(updated[0].diferencia_paciente || 0);
    const montoCobrado = copagoNum.toLocaleString('es-DO', { minimumFractionDigits: 2 });
    const exitoMsg = `Pago de RD$ ${montoCobrado} registrado exitosamente (${metodoPago}) para el paciente ${consulta.paciente_nombre} ${consulta.paciente_apellido}. Estado actualizado a "Pagado".`;

    if (esJson) {
      return res.json({
        success: true,
        message: exitoMsg,
        consulta: updated[0],
      });
    }

    req.flash('success', exitoMsg);
    return res.redirect(returnTo);
  } catch (error) {
    next(error);
  }
};

/**
 * Actualizar liquidación tarifaria de la consulta antes de cobrar
 * POST /ars/cobrar/:consultaId/liquidar
 */
exports.actualizarLiquidacionCobro = async (req, res, next) => {
  const consultaId = parseInt(req.params.consultaId, 10);
  const { servicio_id, ars_id } = req.body;
  const returnTo = req.body.return_to || '/ars/cobrar';

  if (!consultaId || isNaN(consultaId)) {
    req.flash('error', 'ID de consulta inválido.');
    return res.redirect('/ars/cobrar');
  }

  try {
    const { rows: cRows } = await db.query(`SELECT * FROM consultas WHERE id = $1`, [consultaId]);
    if (cRows.length === 0) {
      req.flash('error', 'Consulta médica no encontrada.');
      return res.redirect('/ars/cobrar');
    }

    const consulta = cRows[0];
    if (consulta.estado_pago === 'Pagado') {
      req.flash('error', 'No se puede modificar la liquidación de una consulta que ya fue cobrada y registrada como Pagada.');
      return res.redirect(returnTo);
    }

    const nuevoServicioId = servicio_id ? parseInt(servicio_id, 10) : consulta.servicio_id;
    const nuevoArsId = (ars_id !== undefined && ars_id !== null && ars_id !== '' && parseInt(ars_id, 10) > 0)
      ? parseInt(ars_id, 10)
      : null;

    // Calcular tarifario oficial en el servidor
    const { rows: sRows } = await db.query(`SELECT precio_base FROM servicios WHERE id = $1`, [nuevoServicioId]);
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

    await db.query(
      `UPDATE consultas
       SET servicio_id = $1,
           ars_id = $2,
           valor_total = $3,
           valor_cubierto_ars = $4,
           diferencia_paciente = $5
       WHERE id = $6`,
      [nuevoServicioId, nuevoArsId, valorTotal, valorCubierto, copago, consultaId]
    );

    req.flash('success', 'Liquidación y cobertura ARS actualizadas exitosamente según el tarifario vigente.');
    return res.redirect(returnTo);
  } catch (error) {
    next(error);
  }
};


