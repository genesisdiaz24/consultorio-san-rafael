const db = require('../config/db');
const imecfService = require('../services/imecfService');
const ecfController = require('./ecfController');

// Nombre del médico (usuarios u) sin la etiqueta final entre paréntesis, p. ej. "Dr. Rafael Morales (Médico)" → "Dr. Rafael Morales"
const NOMBRE_MEDICO = `REGEXP_REPLACE(u.nombre, '\\s*\\([^)]*\\)\\s*$', '')`;

// Listado de consultas realizadas
exports.listar = async (req, res, next) => {
  try {
    const { q } = req.query;
    let queryText = `
      SELECT c.*,
             p.id AS paciente_id,
             p.nombre AS paciente_nombre,
             p.apellido AS paciente_apellido,
             p.identificacion AS paciente_identificacion,
             s.nombre AS servicio_nombre,
             a.nombre AS ars_nombre,
             ce.id AS ecf_local_id,
             ce.encf AS ecf_encf,
             ce.tipo_ecf AS ecf_tipo,
             ce.estado AS ecf_estado,
             ce.modo_simulacion AS ecf_modo_simulacion
      FROM consultas c
      INNER JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN servicios s ON c.servicio_id = s.id
      LEFT JOIN ars a ON c.ars_id = a.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM comprobantes_electronicos sub
        WHERE sub.consulta_id = c.id
        ORDER BY
          CASE WHEN sub.estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO') THEN 0 ELSE 1 END,
          sub.id DESC
        LIMIT 1
      ) ce ON true
      WHERE 1=1
    `;
    const params = [];

    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR c.diagnostico_clinico ILIKE $1 OR ce.encf ILIKE $1)`;
    }

    queryText += ` ORDER BY c.fecha_consulta DESC, c.id DESC LIMIT 100`;

    const { rows: consultas } = await db.query(queryText, params);

    // Restricción por rol: El médico no debe poder consultar montos ni estado del cobro
    const rolActual = req.session && req.session.usuario ? req.session.usuario.rol : '';
    if (rolActual === 'MEDICO') {
      consultas.forEach((c) => {
        delete c.valor_total;
        delete c.valor_cubierto_ars;
        delete c.diferencia_paciente;
        delete c.estado_pago;
      });
    }

    res.render('consultas/index', {
      consultas: consultas.map((c) => ({
        ...c,
        ecfEstadoInfo: c.ecf_estado ? imecfService.clasificarEstadoEcf(c.ecf_estado, c.ecf_modo_simulacion) : null,
      })),
      q: q || '',
      title: 'Consultas Médicas e Historial',
    });
  } catch (error) {
    next(error);
  }
};

// Pantalla de atención médica (Iniciar consulta para un paciente o cita)
exports.formularioAtender = async (req, res, next) => {
  try {
    const { paciente_id, cita_id } = req.query;

    if (!paciente_id) {
      req.flash('error', 'Debe seleccionar un paciente para iniciar la consulta médica.');
      return res.redirect('/citas/sala-espera');
    }

    // 1. Obtener datos completos del paciente
    const { rows: pRows } = await db.query(
      `SELECT p.*, a.nombre AS ars_nombre
       FROM pacientes p
       LEFT JOIN ars a ON p.ars_id = a.id
       WHERE p.id = $1`,
      [paciente_id]
    );

    if (pRows.length === 0) {
      req.flash('error', 'Paciente no encontrado.');
      return res.redirect('/pacientes');
    }

    const paciente = pRows[0];

    // 2. Si viene de una cita específica, cargarla; o buscar automáticamente si el paciente tiene una cita activa
    let cita = null;
    if (cita_id) {
      const { rows: cRows } = await db.query(`SELECT * FROM citas WHERE id = $1`, [cita_id]);
      if (cRows.length > 0) cita = cRows[0];
    }

    if (!cita) {
      const { rows: cAuto } = await db.query(
        `SELECT * FROM citas 
         WHERE paciente_id = $1 
           AND (estado = 'En sala de espera' OR (fecha = CURRENT_DATE AND estado NOT IN ('Atendida', 'Cancelada')))
         ORDER BY (estado = 'En sala de espera') DESC, fecha DESC, hora ASC 
         LIMIT 1`,
        [paciente_id]
      );
      if (cAuto.length > 0) cita = cAuto[0];
    }

    // 3. Obtener consultas anteriores del paciente (para revisar antecedentes y evoluciones previas)
    const { rows: consultasPrevias } = await db.query(
      `SELECT c.id, c.fecha_consulta, c.diagnostico_clinico, c.tratamiento_plan, s.nombre as servicio_nombre
       FROM consultas c
       LEFT JOIN servicios s ON c.servicio_id = s.id
       WHERE c.paciente_id = $1
       ORDER BY c.fecha_consulta DESC, c.id DESC LIMIT 10`,
      [paciente_id]
    );

    // 4. Catálogos: Servicios, ARS y Medicamentos disponibles en farmacia
    const { rows: servicios } = await db.query(
      `SELECT * FROM servicios WHERE activo = true ORDER BY nombre ASC`
    );

    const { rows: arsList } = await db.query(
      `SELECT * FROM ars WHERE activo = true ORDER BY nombre ASC`
    );

    const { rows: medicamentos } = await db.query(
      `SELECT id, codigo, nombre, concentracion, presentacion, stock_actual
       FROM medicamentos
       WHERE activo = true
       ORDER BY nombre ASC`
    );

    // 5. Tarifarios existentes para cálculo dinámico en pantalla
    const { rows: tarifarios } = await db.query(`
      SELECT t.*, a.nombre as ars_nombre, s.codigo as servicio_codigo, s.precio_base
      FROM ars_tarifarios t
      INNER JOIN ars a ON t.ars_id = a.id
      INNER JOIN servicios s ON t.servicio_id = s.id
    `);

    res.render('consultas/atender', {
      paciente,
      cita,
      consultasPrevias,
      servicios,
      arsList,
      medicamentos,
      tarifarios,
      title: `Atención Médica: ${paciente.nombre} ${paciente.apellido}`,
    });
  } catch (error) {
    next(error);
  }
};

// Guardar consulta, receta médica y desglose de cobro/cobertura ARS
exports.guardar = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const {
      paciente_id,
      cita_id,
      servicio_id,
      motivo_consulta,
      antecedentes_revisados,
      // Signos vitales
      pa_sistolica,
      pa_diastolica,
      temperatura,
      frecuencia_cardiaca,
      frecuencia_respiratoria,
      peso,
      talla,
      // Examen y diagnóstico
      hallazgos_clinicos,
      diagnostico_clinico,
      tratamiento_plan,
      notas_adicionales,
      // Cobros y ARS
      ars_id,
      valor_total,
      valor_cubierto_ars,
      diferencia_paciente,
      estado_pago,
      // Receta
      incluye_receta,
      indicaciones_generales,
      // Medicamentos prescritos (arrays)
      med_nombre,
      med_id,
      med_dosis,
      med_frecuencia,
      med_indicaciones,
      med_cantidad,
    } = req.body;

    if (!paciente_id || !motivo_consulta || !hallazgos_clinicos || !diagnostico_clinico || !tratamiento_plan) {
      await client.query('ROLLBACK');
      req.flash('error', 'Por favor complete todos los datos clínicos obligatorios (*).');
      return res.redirect(`/consultas/atender?paciente_id=${paciente_id}&cita_id=${cita_id || ''}`);
    }

    // Estructurar signos vitales en formato JSONB
    const signosVitales = {
      presion_arterial: pa_sistolica && pa_diastolica ? `${pa_sistolica}/${pa_diastolica} mmHg` : null,
      temperatura: temperatura ? `${temperatura} °C` : null,
      frecuencia_cardiaca: frecuencia_cardiaca ? `${frecuencia_cardiaca} lpm` : null,
      frecuencia_respiratoria: frecuencia_respiratoria ? `${frecuencia_respiratoria} rpm` : null,
      peso: peso ? `${peso} kg` : null,
      talla: talla ? `${talla} cm` : null,
    };

    // 0. Determinar cita vinculada (si vino en formulario o buscar la cita en sala de espera/hoy del paciente)
    let finalCitaId = (cita_id && !isNaN(parseInt(cita_id, 10)) && parseInt(cita_id, 10) > 0)
      ? parseInt(cita_id, 10)
      : null;

    if (!finalCitaId) {
      const { rows: citaActiva } = await client.query(
        `SELECT id FROM citas 
         WHERE paciente_id = $1 
           AND (estado = 'En sala de espera' OR (fecha = CURRENT_DATE AND estado NOT IN ('Atendida', 'Cancelada')))
         ORDER BY (estado = 'En sala de espera') DESC, fecha DESC, hora ASC
         LIMIT 1`,
        [parseInt(paciente_id, 10)]
      );
      if (citaActiva.length > 0) {
        finalCitaId = citaActiva[0].id;
      }
    }

    // 0.1 Control de Idempotencia: Si la cita ya tiene una consulta registrada, evitar duplicados
    if (finalCitaId) {
      const { rows: citaExistente } = await client.query(
        `SELECT id FROM consultas WHERE cita_id = $1`,
        [finalCitaId]
      );
      if (citaExistente.length > 0) {
        await client.query(`UPDATE citas SET estado = 'Atendida' WHERE id = $1`, [finalCitaId]);
        await client.query(`UPDATE citas SET estado = 'Atendida' WHERE paciente_id = $1 AND estado = 'En sala de espera'`, [parseInt(paciente_id, 10)]);
        await client.query('COMMIT');
        req.flash('info', 'Esta cita ya cuenta con una atención médica registrada en el historial.');
        return res.redirect(`/consultas/${citaExistente[0].id}`);
      }
    }

    // 0.2 Prevención de duplicados por doble envío, refresco de navegador o doble clic rápido
    const { rows: duplicadoReciente } = await client.query(
      `SELECT id FROM consultas 
       WHERE paciente_id = $1 
         AND motivo_consulta = $2 
         AND diagnostico_clinico = $3
         AND fecha_consulta >= NOW() - INTERVAL '10 minutes'
       ORDER BY id DESC LIMIT 1`,
      [parseInt(paciente_id, 10), motivo_consulta.trim(), diagnostico_clinico.trim()]
    );
    if (duplicadoReciente.length > 0) {
      await client.query('COMMIT');
      req.flash('info', 'Esta consulta médica ya fue guardada previamente en el historial.');
      return res.redirect(`/consultas/${duplicadoReciente[0].id}`);
    }

    // 1. Determinar Servicio, Cobertura ARS y Liquidación Financiera en Servidor
    const rolUsuario = req.session && req.session.usuario ? req.session.usuario.rol : '';
    const esMedico = rolUsuario === 'MEDICO';

    let finalArsId = null;
    let finalServicioId = null;
    let finalValorTotal = 0.00;
    let finalValorCubierto = 0.00;
    let finalDiferenciaPaciente = 0.00;
    let finalEstadoPago = 'Pendiente';

    // 1.1 Obtener ARS registrada del paciente
    const { rows: pData } = await client.query(
      `SELECT id, ars_id FROM pacientes WHERE id = $1`,
      [parseInt(paciente_id, 10)]
    );
    finalArsId = pData.length > 0 && pData[0].ars_id ? pData[0].ars_id : null;

    if (!esMedico && ars_id !== undefined && ars_id !== null && ars_id !== '') {
      finalArsId = parseInt(ars_id, 10) > 0 ? parseInt(ars_id, 10) : null;
    }

    // 1.2 Determinar Servicio: Cita previa o servicio estándar de Consulta General
    if (finalCitaId) {
      const { rows: citaData } = await client.query(
        `SELECT servicio_id FROM citas WHERE id = $1`,
        [finalCitaId]
      );
      if (citaData.length > 0 && citaData[0].servicio_id) {
        finalServicioId = citaData[0].servicio_id;
      }
    }
    if (!finalServicioId && !esMedico && servicio_id) {
      finalServicioId = parseInt(servicio_id, 10);
    }
    if (!finalServicioId) {
      const { rows: sMedGen } = await client.query(
        `SELECT id FROM servicios WHERE codigo = 'MED-GEN' AND activo = true LIMIT 1`
      );
      if (sMedGen.length > 0) {
        finalServicioId = sMedGen[0].id;
      } else {
        const { rows: sAny } = await client.query(
          `SELECT id FROM servicios WHERE activo = true ORDER BY id ASC LIMIT 1`
        );
        if (sAny.length > 0) finalServicioId = sAny[0].id;
      }
    }

    // 1.3 Liquidación tarifaria oficial en servidor (según tarifarios ARS o precio base)
    if (finalServicioId) {
      const { rows: sInfo } = await client.query(
        `SELECT precio_base FROM servicios WHERE id = $1`,
        [finalServicioId]
      );
      const precioBase = sInfo.length > 0 ? parseFloat(sInfo[0].precio_base) : 0.00;
      finalValorTotal = precioBase;
      finalDiferenciaPaciente = precioBase;

      if (finalArsId) {
        const { rows: tRows } = await client.query(
          `SELECT * FROM ars_tarifarios WHERE ars_id = $1 AND servicio_id = $2 LIMIT 1`,
          [finalArsId, finalServicioId]
        );
        if (tRows.length > 0) {
          const t = tRows[0];
          finalValorTotal = parseFloat(t.tarifa_pactada) || precioBase;
          const valCob = parseFloat(t.valor_cobertura) || 0;
          const copagoFijo = parseFloat(t.copago_fijo) || 0;

          if (t.tipo_cobertura === 'PORCENTAJE') {
            finalValorCubierto = (finalValorTotal * valCob) / 100.0;
          } else {
            finalValorCubierto = Math.min(finalValorTotal, valCob);
          }
          finalDiferenciaPaciente = Math.max(0, finalValorTotal - finalValorCubierto + copagoFijo);
        }
      }
    }

    // Restricción por rol: El médico NO puede fijar ni modificar el estado del cobro
    if (esMedico) {
      finalEstadoPago = 'Pendiente';
    } else {
      finalEstadoPago = estado_pago || 'Pendiente';
      if (valor_total !== undefined && !isNaN(parseFloat(valor_total))) {
        finalValorTotal = parseFloat(valor_total);
      }
      if (valor_cubierto_ars !== undefined && !isNaN(parseFloat(valor_cubierto_ars))) {
        finalValorCubierto = parseFloat(valor_cubierto_ars);
      }
      if (diferencia_paciente !== undefined && !isNaN(parseFloat(diferencia_paciente))) {
        finalDiferenciaPaciente = parseFloat(diferencia_paciente);
      }
    }

    // 1.4 Médico que atiende: el médico con sesión iniciada. Si registra la consulta el administrador,
    // se asigna al único médico activo; con varios médicos activos queda sin asignar (no se adivina).
    let medicoId = null;
    if (esMedico) {
      medicoId = req.session.usuario.id;
    } else {
      const { rows: medicosActivos } = await client.query(
        `SELECT id FROM usuarios WHERE rol = 'MEDICO' AND activo = true ORDER BY id LIMIT 2`
      );
      if (medicosActivos.length === 1) medicoId = medicosActivos[0].id;
    }

    // 1.5 Insertar Consulta vinculada con el cargo en estado Pendiente
    const consultaQuery = `
      INSERT INTO consultas (
        cita_id, paciente_id, servicio_id, motivo_consulta,
        antecedentes_revisados, signos_vitales, hallazgos_clinicos,
        diagnostico_clinico, tratamiento_plan, notas_adicionales,
        ars_id, valor_total, valor_cubierto_ars, diferencia_paciente,
        estado_pago, medico_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id
    `;

    const consultaValues = [
      finalCitaId,
      parseInt(paciente_id, 10),
      finalServicioId,
      motivo_consulta.trim(),
      antecedentes_revisados || null,
      JSON.stringify(signosVitales),
      hallazgos_clinicos.trim(),
      diagnostico_clinico.trim(),
      tratamiento_plan.trim(),
      notas_adicionales || null,
      finalArsId,
      finalValorTotal,
      finalValorCubierto,
      finalDiferenciaPaciente,
      finalEstadoPago,
      medicoId,
    ];

    const { rows: consultaResult } = await client.query(consultaQuery, consultaValues);
    const nuevaConsultaId = consultaResult[0].id;

    // 2. Finalizar y actualizar la cita a 'Atendida' para que salga de la sala de espera
    if (finalCitaId) {
      await client.query(
        `UPDATE citas SET estado = 'Atendida' WHERE id = $1`,
        [finalCitaId]
      );
    }

    // Regla de integridad clínica: marcar como 'Atendida' cualquier cita que este paciente tuviera en sala de espera
    await client.query(
      `UPDATE citas SET estado = 'Atendida' WHERE paciente_id = $1 AND estado = 'En sala de espera'`,
      [parseInt(paciente_id, 10)]
    );

    // 3. Crear Receta si se incluyeron medicamentos
    if (incluye_receta === 'true' || incluye_receta === 'on' || (med_nombre && med_nombre.length > 0)) {
      const codigoReceta = `REC-${Date.now().toString().slice(-6)}-${nuevaConsultaId}`;

      const { rows: recetaResult } = await client.query(
        `INSERT INTO recetas (consulta_id, paciente_id, codigo_receta, indicaciones_generales)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [nuevaConsultaId, paciente_id, codigoReceta, indicaciones_generales || null]
      );

      const recetaId = recetaResult[0].id;

      // Normalizar a arreglos si solo viene un elemento
      const nombres = Array.isArray(med_nombre) ? med_nombre : (med_nombre ? [med_nombre] : []);
      const ids = Array.isArray(med_id) ? med_id : (med_id ? [med_id] : []);
      const dosis = Array.isArray(med_dosis) ? med_dosis : (med_dosis ? [med_dosis] : []);
      const frecuencias = Array.isArray(med_frecuencia) ? med_frecuencia : (med_frecuencia ? [med_frecuencia] : []);
      const indicaciones = Array.isArray(med_indicaciones) ? med_indicaciones : (med_indicaciones ? [med_indicaciones] : []);
      const cantidades = Array.isArray(med_cantidad) ? med_cantidad : (med_cantidad ? [med_cantidad] : []);

      for (let i = 0; i < nombres.length; i++) {
        if (nombres[i] && nombres[i].trim() !== '') {
          const mId = ids[i] && ids[i] !== '' ? parseInt(ids[i], 10) : null;
          const cant = parseInt(cantidades[i], 10) || 1;

          await client.query(
            `INSERT INTO receta_detalles (
              receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia,
              indicaciones_uso, cantidad_recetada, estado_dispensacion
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pendiente')`,
            [
              recetaId,
              mId,
              nombres[i].trim(),
              dosis[i] ? dosis[i].trim() : 'Según prescripción',
              frecuencias[i] ? frecuencias[i].trim() : 'Según prescripción',
              indicaciones[i] ? indicaciones[i].trim() : 'Tomar con indicaciones médicas',
              cant,
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
    req.flash('success', 'Consulta e historial médico guardados exitosamente.');
    res.redirect(`/consultas/${nuevaConsultaId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      req.flash('info', 'La consulta médica ya fue guardada previamente en el historial.');
      return res.redirect('/consultas');
    }
    next(error);
  } finally {
    client.release();
  }
};

// Ver detalle completo de una consulta (con receta, desglose económico y comprobante electrónico e-CF)
exports.verDetalle = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: consultas } = await db.query(
      `SELECT c.*,
              p.nombre AS paciente_nombre,
              p.apellido AS paciente_apellido,
              p.identificacion AS paciente_identificacion,
              p.fecha_nacimiento AS paciente_fecha_nacimiento,
              p.genero AS paciente_genero,
              p.telefono AS paciente_telefono,
              p.correo AS paciente_correo,
              p.numero_afiliado AS paciente_afiliado,
              s.nombre AS servicio_nombre,
              s.codigo AS servicio_codigo,
              COALESCE(s.indicador_facturacion, '4') AS servicio_indicador_facturacion,
              a.nombre AS ars_nombre,
              ${NOMBRE_MEDICO} AS medico_nombre
       FROM consultas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       LEFT JOIN servicios s ON c.servicio_id = s.id
       LEFT JOIN ars a ON c.ars_id = a.id
       LEFT JOIN usuarios u ON c.medico_id = u.id
       WHERE c.id = $1`,
      [id]
    );

    if (consultas.length === 0) {
      req.flash('error', 'Consulta médica no encontrada.');
      return res.redirect('/consultas');
    }

    const consulta = consultas[0];

    // Obtener receta vinculada si existe
    const { rows: recetas } = await db.query(
      `SELECT * FROM recetas WHERE consulta_id = $1`,
      [id]
    );

    let receta = null;
    let medicamentos = [];

    if (recetas.length > 0) {
      receta = recetas[0];
      const { rows: meds } = await db.query(
        `SELECT rd.*, m.stock_actual, m.presentacion
         FROM receta_detalles rd
         LEFT JOIN medicamentos m ON rd.medicamento_id = m.id
         WHERE rd.receta_id = $1
         ORDER BY rd.id ASC`,
        [receta.id]
      );
      medicamentos = meds;
    }

    // Obtener comprobantes electrónicos (e-CF) y estado de pagos PayPal asociados a esta factura/consulta
    const { comprobanteActivo, historialComprobantes } = await ecfController.obtenerComprobantesPorConsulta(id);
    const configImecf = imecfService.obtenerConfiguracionPublica();
    const paypalController = require('./paypalController');
    const datosPayPal = await paypalController.obtenerEstadoPagosFactura(consulta);

    // Restricción por rol: El médico no debe poder consultar montos ni estado del cobro
    const rolActual = req.session && req.session.usuario ? req.session.usuario.rol : '';
    if (rolActual === 'MEDICO') {
      delete consulta.valor_total;
      delete consulta.valor_cubierto_ars;
      delete consulta.diferencia_paciente;
      delete consulta.estado_pago;
    }

    res.render('consultas/detalle', {
      consulta,
      receta,
      medicamentos,
      comprobanteActivo,
      estadoInfo: comprobanteActivo
        ? imecfService.clasificarEstadoEcf(comprobanteActivo.estado, comprobanteActivo.modo_simulacion)
        : null,
      historialComprobantes: historialComprobantes.map((h) => ({
        ...h,
        estadoInfo: imecfService.clasificarEstadoEcf(h.estado, h.modo_simulacion),
      })),
      esquemas: imecfService.ESQUEMAS_DOCUMENTADOS,
      indicadoresFacturacion: imecfService.INDICADORES_FACTURACION,
      formasPago: imecfService.FORMAS_PAGO,
      configImecf,
      datosPayPal,
      title: `Detalle de Atención Médica #${consulta.id}`,
    });
  } catch (error) {
    next(error);
  }
};

// Listado de Historiales Clínicos de Pacientes
exports.historialClinico = async (req, res, next) => {
  try {
    const { q } = req.query;
    let queryText = `
      SELECT p.id, p.nombre, p.apellido, p.identificacion, p.fecha_nacimiento, p.genero,
             p.telefono, p.antecedentes_alergicos, p.antecedentes_personales,
              a.nombre as ars_nombre,
              COUNT(DISTINCT c.id) as total_consultas,
              MAX(c.fecha_consulta) as ultima_consulta
      FROM pacientes p
      LEFT JOIN ars a ON p.ars_id = a.id
      LEFT JOIN consultas c ON c.paciente_id = p.id
      WHERE p.activo = true
    `;
    const params = [];
    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR p.telefono ILIKE $1)`;
    }
    queryText += ` GROUP BY p.id, a.nombre ORDER BY ultima_consulta DESC NULLS LAST, p.nombre ASC LIMIT 100`;

    const { rows: pacientes } = await db.query(queryText, params);
    res.render('consultas/historial', {
      pacientes,
      q: q || '',
      title: 'Historiales Clínicos de Pacientes',
    });
  } catch (error) {
    next(error);
  }
};

// Ver Historial Clínico completo de un paciente específico
exports.verHistorialPaciente = async (req, res, next) => {
  try {
    const { pacienteId } = req.params;
    const { rows: pRows } = await db.query(
      `SELECT p.*, a.nombre AS ars_nombre
       FROM pacientes p
       LEFT JOIN ars a ON p.ars_id = a.id
       WHERE p.id = $1`,
      [pacienteId]
    );

    if (pRows.length === 0) {
      req.flash('error', 'Paciente no encontrado.');
      return res.redirect('/consultas/historial');
    }

    const paciente = pRows[0];

    const { rows: consultas } = await db.query(
      `SELECT c.*, s.nombre AS servicio_nombre
       FROM consultas c
       LEFT JOIN servicios s ON c.servicio_id = s.id
       WHERE c.paciente_id = $1
       ORDER BY c.fecha_consulta DESC, c.id DESC`,
      [pacienteId]
    );

    const { rows: recetas } = await db.query(
      `SELECT r.*, c.fecha_consulta, c.diagnostico_clinico
       FROM recetas r
       INNER JOIN consultas c ON r.consulta_id = c.id
       WHERE r.paciente_id = $1
       ORDER BY r.fecha_emision DESC, r.id DESC`,
      [pacienteId]
    );

    res.render('consultas/historial_paciente', {
      paciente,
      consultas,
      recetas,
      title: `Historial Clínico: ${paciente.nombre} ${paciente.apellido}`,
    });
  } catch (error) {
    next(error);
  }
};

// Listado de Recetas Médicas Emitidas
exports.listarRecetas = async (req, res, next) => {
  try {
    const { q } = req.query;
    let queryText = `
      SELECT r.*,
             c.diagnostico_clinico,
             p.nombre as paciente_nombre,
             p.apellido as paciente_apellido,
             p.identificacion as paciente_identificacion,
             COUNT(rd.id) as total_medicamentos,
             COUNT(CASE WHEN rd.estado_dispensacion = 'Entregado' THEN 1 END) as total_entregados,
             COUNT(CASE WHEN rd.estado_dispensacion IN ('No entregado', 'No entregado - Sin existencias') THEN 1 END) as total_no_entregados
      FROM recetas r
      INNER JOIN consultas c ON r.consulta_id = c.id
      INNER JOIN pacientes p ON r.paciente_id = p.id
      LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
      WHERE 1=1
    `;
    const params = [];
    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR r.codigo_receta ILIKE $1 OR c.diagnostico_clinico ILIKE $1)`;
    }
    queryText += ` GROUP BY r.id, c.diagnostico_clinico, p.nombre, p.apellido, p.identificacion
                   ORDER BY r.fecha_emision DESC, r.id DESC LIMIT 100`;

    const { rows: recetas } = await db.query(queryText, params);
    res.render('consultas/recetas', {
      recetas,
      q: q || '',
      title: 'Recetas Médicas Emitidas',
    });
  } catch (error) {
    next(error);
  }
};

// Ver / Imprimir Receta Médica específica
exports.verReceta = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: rRows } = await db.query(
      `SELECT r.*,
              c.fecha_consulta,
              c.diagnostico_clinico,
              p.nombre as paciente_nombre,
              p.apellido as paciente_apellido,
              p.identificacion as paciente_identificacion,
              p.fecha_nacimiento as paciente_nacimiento,
              p.telefono as paciente_telefono,
              a.nombre as ars_nombre,
              ${NOMBRE_MEDICO} AS medico_nombre
       FROM recetas r
       INNER JOIN consultas c ON r.consulta_id = c.id
       INNER JOIN pacientes p ON r.paciente_id = p.id
       LEFT JOIN ars a ON p.ars_id = a.id
       LEFT JOIN usuarios u ON c.medico_id = u.id
       WHERE r.id = $1`,
      [id]
    );

    if (rRows.length === 0) {
      req.flash('error', 'Receta no encontrada.');
      return res.redirect('/consultas/recetas');
    }

    const receta = rRows[0];
    const { rows: detalles } = await db.query(
      `SELECT * FROM receta_detalles WHERE receta_id = $1 ORDER BY id ASC`,
      [id]
    );

    res.render('consultas/receta_detalle', {
      receta,
      detalles,
      title: `Receta Médica ${receta.codigo_receta}`,
    });
  } catch (error) {
    next(error);
  }
};

