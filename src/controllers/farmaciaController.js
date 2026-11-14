const db = require('../config/db');
const farmaciaIaService = require('../services/farmaciaIaService');
const farmaciaChatService = require('../services/farmaciaChatService');

// Vista del Inventario de Medicamentos con Estimación de Demanda IA y Sugerencias de Reposición
exports.inventario = async (req, res, next) => {
  try {
    const { q, estado } = req.query;
    let queryText = `
      SELECT *,
        CASE
          WHEN stock_actual <= 0 THEN 'Agotado'
          WHEN stock_actual <= stock_minimo THEN 'Stock Bajo'
          ELSE 'Disponible'
        END AS estado_stock
      FROM medicamentos
      WHERE activo = true
    `;
    const params = [];

    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (nombre ILIKE $1 OR principio_activo ILIKE $1 OR codigo ILIKE $1)`;
    }

    if (estado === 'agotado') {
      queryText += ` AND stock_actual <= 0`;
    } else if (estado === 'bajo') {
      queryText += ` AND stock_actual > 0 AND stock_actual <= stock_minimo`;
    }

    queryText += ` ORDER BY stock_actual ASC, nombre ASC`;

    const { rows: medicamentos } = await db.query(queryText, params);

    // El análisis de IA NO se ejecuta al cargar la página. Permanece en espera hasta que el usuario presione "Consultar IA"
    const analisisIa = null;

    res.render('farmacia/inventario', {
      medicamentos,
      analisisIa,
      q: q || '',
      estado: estado || '',
      title: 'Inventario de Farmacia Interna',
    });
  } catch (error) {
    next(error);
  }
};

// Endpoint JSON para consultar el análisis de demanda y sugerencias de la IA
exports.obtenerEstimacionesIaJson = async (req, res) => {
  try {
    const ventanaDias = parseInt(req.query.dias, 10) || 30;
    const analisisIa = await farmaciaIaService.obtenerEstimacionDemandaInventario({ ventanaDias });
    return res.json({
      success: true,
      ...analisisIa,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Error al calcular estimación de demanda con IA: ' + error.message,
    });
  }
};

// Crear nuevo medicamento en inventario
exports.crearMedicamento = async (req, res, next) => {
  try {
    const {
      codigo,
      nombre,
      principio_activo,
      presentacion,
      concentracion,
      stock_actual,
      stock_minimo,
      ubicacion,
      lote,
      fecha_vencimiento,
    } = req.body;

    if (!codigo || !nombre || !presentacion) {
      req.flash('error', 'Código, nombre y presentación son obligatorios.');
      return res.redirect('/farmacia/inventario');
    }

    // Verificar código duplicado
    const { rows: exist } = await db.query(
      `SELECT id FROM medicamentos WHERE codigo = $1`,
      [codigo.trim()]
    );

    if (exist.length > 0) {
      req.flash('error', `Ya existe un medicamento con el código "${codigo}".`);
      return res.redirect('/farmacia/inventario');
    }

    const insertQuery = `
      INSERT INTO medicamentos (
        codigo, nombre, principio_activo, presentacion,
        concentracion, stock_actual, stock_minimo, ubicacion,
        lote, fecha_vencimiento
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const values = [
      codigo.trim(),
      nombre.trim(),
      principio_activo ? principio_activo.trim() : null,
      presentacion.trim(),
      concentracion ? concentracion.trim() : null,
      parseInt(stock_actual, 10) || 0,
      parseInt(stock_minimo, 10) || 5,
      ubicacion ? ubicacion.trim() : null,
      lote ? lote.trim() : null,
      fecha_vencimiento || null,
    ];

    const result = await db.query(insertQuery, values);

    // Registrar movimiento inicial de stock
    if (parseInt(stock_actual, 10) > 0) {
      await db.query(
        `INSERT INTO farmacia_movimientos (medicamento_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo)
         VALUES ($1, 'ENTRADA_STOCK', $2, 0, $2, 'Carga inicial de inventario')`,
        [result.rows[0].id, parseInt(stock_actual, 10)]
      );
    }

    req.flash('success', 'Medicamento registrado exitosamente en el inventario.');
    res.redirect('/farmacia/inventario');
  } catch (error) {
    next(error);
  }
};

// Reabastecer o ajustar stock de un medicamento
exports.ajustarStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cantidad_agregar, motivo } = req.body;

    const cant = parseInt(cantidad_agregar, 10);
    if (isNaN(cant) || cant <= 0) {
      req.flash('error', 'La cantidad a agregar debe ser un número positivo.');
      return res.redirect('/farmacia/inventario');
    }

    const { rows: meds } = await db.query(`SELECT * FROM medicamentos WHERE id = $1`, [id]);
    if (meds.length === 0) {
      req.flash('error', 'Medicamento no encontrado.');
      return res.redirect('/farmacia/inventario');
    }

    const med = meds[0];
    const stockAnterior = med.stock_actual;
    const stockNuevo = stockAnterior + cant;

    await db.query(
      `UPDATE medicamentos SET stock_actual = $1 WHERE id = $2`,
      [stockNuevo, id]
    );

    await db.query(
      `INSERT INTO farmacia_movimientos (medicamento_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo)
       VALUES ($1, 'ENTRADA_STOCK', $2, $3, $4, $5)`,
      [id, cant, stockAnterior, stockNuevo, motivo ? motivo.trim() : 'Reabastecimiento de existencias']
    );

    req.flash('success', `Stock actualizado. Nuevo stock de ${med.nombre}: ${stockNuevo} unidades.`);
    res.redirect('/farmacia/inventario');
  } catch (error) {
    next(error);
  }
};

// Cola de dispensación de recetas con búsqueda por paciente (nombre o cédula) y filtros
exports.colaDispensacion = async (req, res, next) => {
  try {
    const { q, estado } = req.query;
    const filtroEstado = estado || 'pendientes'; // 'pendientes', 'completadas', 'todas'

    let queryText = `
      SELECT r.id AS receta_id,
             r.codigo_receta,
             r.fecha_emision,
             c.id AS consulta_id,
             c.diagnostico_clinico,
             p.id AS paciente_id,
             p.nombre AS paciente_nombre,
             p.apellido AS paciente_apellido,
             p.identificacion AS paciente_identificacion,
             p.telefono AS paciente_telefono,
             a.nombre AS ars_nombre,
             COUNT(rd.id) AS total_items,
             COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) AS pendientes,
             COUNT(CASE WHEN rd.estado_dispensacion = 'Entregado' THEN 1 END) AS entregados,
             COUNT(CASE WHEN rd.estado_dispensacion IN ('No entregado', 'No entregado - Sin existencias') THEN 1 END) AS no_entregados
      FROM recetas r
      INNER JOIN consultas c ON r.consulta_id = c.id
      INNER JOIN pacientes p ON r.paciente_id = p.id
      LEFT JOIN ars a ON (COALESCE(c.ars_id, p.ars_id) = a.id)
      LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    // Búsqueda por nombre o cédula del paciente o código de receta
    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (p.nombre ILIKE $${paramIdx} OR p.apellido ILIKE $${paramIdx} OR p.identificacion ILIKE $${paramIdx} OR r.codigo_receta ILIKE $${paramIdx})`;
      paramIdx++;
    }

    queryText += `
      GROUP BY r.id, r.codigo_receta, r.fecha_emision, c.id, c.diagnostico_clinico, p.id, p.nombre, p.apellido, p.identificacion, p.telefono, a.nombre
    `;

    if (filtroEstado === 'pendientes') {
      queryText += ` HAVING COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) > 0`;
    } else if (filtroEstado === 'completadas') {
      queryText += ` HAVING COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) = 0`;
    }

    queryText += ` ORDER BY (COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) > 0) DESC, r.fecha_emision DESC LIMIT 100`;

    const { rows: recetas } = await db.query(queryText, params);

    // Contadores de resumen
    const { rows: statsRows } = await db.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN r.id END) AS recetas_pendientes_count,
        COUNT(CASE WHEN rd.estado_dispensacion = 'Entregado' AND rd.fecha_dispensacion::date = CURRENT_DATE THEN 1 END) AS items_entregados_hoy,
        COUNT(CASE WHEN rd.estado_dispensacion IN ('No entregado', 'No entregado - Sin existencias') AND rd.fecha_dispensacion::date = CURRENT_DATE THEN 1 END) AS items_no_entregados_hoy
      FROM recetas r
      LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
    `);
    const stats = statsRows[0] || {};

    res.render('farmacia/dispensar', {
      recetas,
      stats,
      q: q || '',
      filtroEstado,
      title: 'Dispensación de Recetas en Farmacia Interna',
    });
  } catch (error) {
    next(error);
  }
};

// Detalle de una receta para dispensación
exports.verRecetaDispensar = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: rRows } = await db.query(
      `SELECT r.*,
              c.id as consulta_id,
              c.diagnostico_clinico,
              p.id as paciente_id,
              p.nombre as paciente_nombre,
              p.apellido as paciente_apellido,
              p.identificacion as paciente_identificacion,
              p.telefono as paciente_telefono,
              p.correo as paciente_correo,
              a.id as ars_id,
              a.nombre as ars_nombre,
              p.numero_afiliado
       FROM recetas r
       INNER JOIN consultas c ON r.consulta_id = c.id
       INNER JOIN pacientes p ON r.paciente_id = p.id
       LEFT JOIN ars a ON (COALESCE(c.ars_id, p.ars_id) = a.id)
       WHERE r.id = $1`,
      [id]
    );

    if (rRows.length === 0) {
      req.flash('error', 'Receta no encontrada.');
      return res.redirect('/farmacia/dispensar');
    }

    const receta = rRows[0];

    // Obtener los detalles con el stock actual del medicamento en farmacia
    const { rows: items } = await db.query(
      `SELECT rd.*,
              m.codigo as med_codigo,
              m.nombre as med_nombre_catalogo,
              COALESCE(m.stock_actual, 0) as stock_actual,
              m.presentacion as med_presentacion,
              m.concentracion as med_concentracion,
              m.ubicacion as med_ubicacion,
              m.lote as med_lote,
              m.fecha_vencimiento as med_vencimiento
       FROM receta_detalles rd
       LEFT JOIN medicamentos m ON rd.medicamento_id = m.id
       WHERE rd.receta_id = $1
       ORDER BY rd.id ASC`,
      [id]
    );

    // Calcular estado resumen de la receta
    const totalItems = items.length;
    const entregados = items.filter(it => it.estado_dispensacion === 'Entregado').length;
    const noEntregados = items.filter(it => it.estado_dispensacion === 'No entregado' || it.estado_dispensacion === 'No entregado - Sin existencias').length;
    const pendientes = items.filter(it => it.estado_dispensacion === 'Pendiente').length;

    res.render('farmacia/receta_dispensar', {
      receta,
      items,
      resumen: {
        totalItems,
        entregados,
        noEntregados,
        pendientes,
        completada: pendientes === 0 && totalItems > 0
      },
      title: `Despacho de Receta: ${receta.codigo_receta}`,
    });
  } catch (error) {
    next(error);
  }
};

// Acción: Entregar medicamento (solo si hay unidades suficientes; descuenta existencias de forma atómica)
exports.entregarItem = async (req, res, next) => {
  const { detalleId } = req.params;
  const detalleIdNum = parseInt(detalleId, 10);

  if (Number.isNaN(detalleIdNum) || detalleIdNum <= 0) {
    req.flash('error', 'Identificador de ítem de receta inválido.');
    return res.redirect('/farmacia/dispensar');
  }

  const client = await db.pool.connect();
  let recetaIdRedirect = null;

  try {
    await client.query('BEGIN');

    // 1. Obtener y bloquear exclusivamente la fila de receta_detalles
    const { rows: detRows } = await client.query(
      `SELECT rd.*, 
              r.id AS receta_id, 
              r.codigo_receta,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              a.nombre AS ars_nombre
       FROM receta_detalles rd
       INNER JOIN recetas r ON rd.receta_id = r.id
       INNER JOIN pacientes p ON r.paciente_id = p.id
       INNER JOIN consultas c ON r.consulta_id = c.id
       LEFT JOIN ars a ON (COALESCE(c.ars_id, p.ars_id) = a.id)
       WHERE rd.id = $1
       FOR UPDATE OF rd`,
      [detalleIdNum]
    );

    if (detRows.length === 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'Ítem de receta no encontrado.');
      return res.redirect('/farmacia/dispensar');
    }

    const item = detRows[0];
    recetaIdRedirect = item.receta_id;

    // 2. Si ya fue entregado, no permitir volver a entregar ni duplicar descuento
    if (item.estado_dispensacion === 'Entregado') {
      await client.query('ROLLBACK');
      req.flash(
        'info',
        `El medicamento "${item.nombre_medicamento}" ya fue entregado previamente. No se realizó ningún descuento duplicado.`
      );
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    // 3. Localizar y bloquear el medicamento en inventario
    let med = null;
    if (item.medicamento_id) {
      const { rows: medRows } = await client.query(
        `SELECT * FROM medicamentos WHERE id = $1 FOR UPDATE`,
        [item.medicamento_id]
      );
      med = medRows[0] || null;
    }

    if (!med && item.nombre_medicamento) {
      const { rows: medByName } = await client.query(
        `SELECT * FROM medicamentos
         WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
         ORDER BY id ASC LIMIT 1
         FOR UPDATE`,
        [item.nombre_medicamento]
      );
      med = medByName[0] || null;
    }

    if (!med) {
      await client.query('ROLLBACK');
      req.flash(
        'error',
        `El medicamento "${item.nombre_medicamento}" no existe en el inventario interno. Si no hay existencias, debe registrarlo como "No entregado" con el motivo correspondiente.`
      );
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    const cantidadSolicitada = parseInt(item.cantidad_recetada, 10) || 0;
    const stockAnterior = parseInt(med.stock_actual, 10) || 0;

    if (cantidadSolicitada <= 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'La cantidad recetada a entregar debe ser mayor a cero.');
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    // 4. REGLA ESTRICTA: El inventario solo se descuenta por unidades efectivamente entregadas.
    // Si no hay unidades suficientes, NO se debe descontar ni marcar como entregado lo que no se dio.
    if (stockAnterior < cantidadSolicitada) {
      await client.query('ROLLBACK');
      req.flash(
        'error',
        `Existencias insuficientes: Solo hay ${stockAnterior} unidad(es) de "${item.nombre_medicamento}" y se requieren ${cantidadSolicitada}. No se puede entregar lo que no se tiene. Márquelo como "No entregado" indicando el motivo.`
      );
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    // 5. Descontar del inventario validando que no quede negativo
    const { rows: updateMedRows } = await client.query(
      `UPDATE medicamentos
       SET stock_actual = stock_actual - $1
       WHERE id = $2 AND stock_actual >= $1
       RETURNING stock_actual`,
      [cantidadSolicitada, med.id]
    );

    if (updateMedRows.length === 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'No se pudo descontar el stock por falta de disponibilidad concurrente.');
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    const nuevoStock = updateMedRows[0].stock_actual;

    // 6. Determinar cobertura ARS (Punto 6)
    const tieneArs = Boolean(item.ars_nombre && item.ars_nombre.trim() !== '' && item.ars_nombre.toLowerCase() !== 'particular');
    const cubiertoArs = (item.cubierto_ars !== false) && tieneArs;

    let obsFarmacia = '';
    if (cubiertoArs) {
      obsFarmacia = `Entregado en farmacia interna (${cantidadSolicitada} unid.). Cobertura ARS aplicada: ${item.ars_nombre}.`;
    } else if (!tieneArs) {
      obsFarmacia = `Entregado en farmacia interna (${cantidadSolicitada} unid.). No cubierto por seguro (Paciente Particular).`;
    } else {
      obsFarmacia = `Entregado en farmacia interna (${cantidadSolicitada} unid.). No cubierto por el seguro ${item.ars_nombre}; paciente asume costo.`;
    }

    // 7. Actualizar el estado del ítem en la receta
    await client.query(
      `UPDATE receta_detalles
       SET estado_dispensacion = 'Entregado',
           medicamento_id = $1,
           fecha_dispensacion = CURRENT_TIMESTAMP,
           observacion_farmacia = $2,
           cubierto_ars = $3,
           cobertura_utilizada = $4
       WHERE id = $5`,
      [med.id, obsFarmacia, cubiertoArs, cubiertoArs, detalleIdNum]
    );

    // 8. Registrar movimiento de salida en kardex de farmacia
    await client.query(
      `INSERT INTO farmacia_movimientos (
        receta_detalle_id, medicamento_id, tipo_movimiento,
        cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES ($1, $2, 'SALIDA_RECETA', $3, $4, $5, $6)`,
      [
        detalleIdNum,
        med.id,
        cantidadSolicitada,
        stockAnterior,
        nuevoStock,
        `Despacho receta ${item.codigo_receta || '#' + item.receta_id} (${cubiertoArs ? 'Cobertura ARS: ' + item.ars_nombre : 'Sin cobertura ARS'})`,
      ]
    );

    await client.query('COMMIT');
    req.flash(
      'success',
      `✔ Medicamento "${item.nombre_medicamento}" entregado correctamente (${cantidadSolicitada} unid. descontadas). Stock restante: ${nuevoStock}.${cubiertoArs ? ' Cobertura de seguro aplicada.' : ''}`
    );
    return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[ERROR FARMACIA - ENTREGAR ITEM]:', error.message || error);
    req.flash('error', 'No se pudo completar la entrega del medicamento por un error en el inventario.');
    return res.redirect(recetaIdRedirect ? `/farmacia/dispensar/${recetaIdRedirect}` : '/farmacia/dispensar');
  } finally {
    client.release();
  }
};

// Acción: Registrar que el medicamento NO se entregó (con motivo obligatorio y SIN descontar stock)
exports.noEntregarItem = async (req, res, next) => {
  const { detalleId } = req.params;
  const detalleIdNum = parseInt(detalleId, 10);

  if (Number.isNaN(detalleIdNum) || detalleIdNum <= 0) {
    req.flash('error', 'Identificador de ítem inválido.');
    return res.redirect('/farmacia/dispensar');
  }

  const client = await db.pool.connect();
  let recetaIdRedirect = null;

  try {
    await client.query('BEGIN');

    const motivo = (req.body.motivo || req.body.observacion || '').trim();
    if (!motivo) {
      await client.query('ROLLBACK');
      req.flash('error', 'Debe indicar el motivo por el cual no se entrega el medicamento (ej: "Sin existencia" o "Paciente lo comprará fuera").');
      return res.redirect(req.body.return_to || '/farmacia/dispensar');
    }

    // Bloquear únicamente la fila de receta_detalles
    const { rows: detRows } = await client.query(
      `SELECT rd.*, r.id AS receta_id, m.stock_actual
       FROM receta_detalles rd
       INNER JOIN recetas r ON rd.receta_id = r.id
       LEFT JOIN medicamentos m ON rd.medicamento_id = m.id
       WHERE rd.id = $1
       FOR UPDATE OF rd`,
      [detalleIdNum]
    );

    if (detRows.length === 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'Ítem no encontrado.');
      return res.redirect('/farmacia/dispensar');
    }

    const item = detRows[0];
    recetaIdRedirect = item.receta_id;

    if (item.estado_dispensacion === 'Entregado') {
      await client.query('ROLLBACK');
      req.flash('warning', `El medicamento "${item.nombre_medicamento}" ya fue entregado y no puede marcarse como no entregado.`);
      return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
    }

    // Actualizar detalle de receta a 'No entregado' con el motivo especificado
    await client.query(
      `UPDATE receta_detalles
       SET estado_dispensacion = 'No entregado',
           fecha_dispensacion = CURRENT_TIMESTAMP,
           observacion_farmacia = $1,
           motivo_no_entrega = $1,
           cobertura_utilizada = false
       WHERE id = $2`,
      [motivo, detalleIdNum]
    );

    const stockActualConservado = parseInt(item.stock_actual, 10) || 0;

    // Registrar incidencia en movimientos SIN descontar inventario
    await client.query(
      `INSERT INTO farmacia_movimientos (
        receta_detalle_id, medicamento_id, tipo_movimiento,
        cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES ($1, $2, 'NO_ENTREGADO', $3, $4, $4, $5)`,
      [
        detalleIdNum,
        item.medicamento_id || null,
        item.cantidad_recetada,
        stockActualConservado,
        `No entregado: ${motivo}`,
      ]
    );

    await client.query('COMMIT');
    req.flash(
      'warning',
      `⚠️ Registrado como NO ENTREGADO: "${item.nombre_medicamento}". Motivo: "${motivo}". El inventario no fue descontado.`
    );
    return res.redirect(`/farmacia/dispensar/${item.receta_id}`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[ERROR FARMACIA - NO ENTREGAR]:', error.message || error);
    req.flash('error', 'No se pudo registrar la no entrega del medicamento.');
    return res.redirect(recetaIdRedirect ? `/farmacia/dispensar/${recetaIdRedirect}` : '/farmacia/dispensar');
  } finally {
    client.release();
  }
};

// Historial y auditoría de movimientos de farmacia
exports.movimientos = async (req, res, next) => {
  try {
    const queryText = `
      SELECT fm.*,
             m.nombre as med_nombre,
             m.codigo as med_codigo,
             rd.nombre_medicamento as receta_med_nombre,
             r.codigo_receta
      FROM farmacia_movimientos fm
      LEFT JOIN medicamentos m ON fm.medicamento_id = m.id
      LEFT JOIN receta_detalles rd ON fm.receta_detalle_id = rd.id
      LEFT JOIN recetas r ON rd.receta_id = r.id
      ORDER BY fm.fecha DESC LIMIT 100
    `;

    const { rows: movimientos } = await db.query(queryText);

    res.render('farmacia/movimientos', {
      movimientos,
      title: 'Historial de Movimientos y Despachos de Farmacia',
    });
  } catch (error) {
    next(error);
  }
};

// Vista del Chat Box del Asistente de IA para Farmacia Interna
exports.vistaChat = async (req, res, next) => {
  try {
    // Métricas rápidas de contexto para el panel lateral del chat
    const { rows: stats } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM medicamentos WHERE activo = true) AS total_medicamentos,
        (SELECT COUNT(*) FROM medicamentos WHERE activo = true AND stock_actual <= 0) AS agotados,
        (SELECT COUNT(*) FROM medicamentos WHERE activo = true AND stock_actual > 0 AND stock_actual <= stock_minimo) AS stock_bajo,
        (SELECT COUNT(DISTINCT r.id)
         FROM recetas r
         INNER JOIN receta_detalles rd ON rd.receta_id = r.id
         WHERE rd.estado_dispensacion = 'Pendiente') AS recetas_pendientes
    `);

    res.render('farmacia/chat', {
      stats: stats[0] || {},
      title: 'Asistente IA de Farmacia Interna',
    });
  } catch (error) {
    next(error);
  }
};

// Endpoint API para procesar mensajes del chat y confirmaciones
exports.procesarMensajeChat = async (req, res) => {
  try {
    const { mensaje, accionConfirmadaId, cancelarAccionId } = req.body;
    const usuario = req.session ? req.session.usuario : {};

    const resultado = await farmaciaChatService.procesarMensaje({
      mensaje,
      usuario,
      accionConfirmadaId,
      cancelarAccionId,
    });

    return res.json(resultado);
  } catch (error) {
    console.error('[ERROR API CHAT FARMACIA]:', error);
    return res.status(500).json({
      success: false,
      respuesta: 'Ocurrió un error inesperado al procesar tu mensaje: ' + error.message,
      tipo: 'ERROR',
    });
  }
};

