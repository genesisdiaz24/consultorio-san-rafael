const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.get('/', async (req, res, next) => {
  try {
    const rol = req.session && req.session.usuario ? req.session.usuario.rol : '';

    // ========================================================
    // 1. PANEL PARA ROL MÉDICO (Consultas, Historiales, Recetas y Sala de Espera)
    // ========================================================
    if (rol === 'MEDICO') {
      // Pacientes en Sala de Espera listos para atención
      const { rows: enEsperaList } = await db.query(`
        SELECT c.*, p.nombre as paciente_nombre, p.apellido as paciente_apellido, p.identificacion,
               p.antecedentes_alergicos,
               ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.fecha_llegada)) / 60) AS minutos_espera
        FROM citas c
        INNER JOIN pacientes p ON c.paciente_id = p.id
        WHERE c.estado = 'En sala de espera'
        ORDER BY c.fecha_llegada ASC
      `);

      // "Hoy" en hora de República Dominicana (la base de la nube guarda los timestamps en UTC)
      const HOY = `(NOW() AT TIME ZONE 'America/Santo_Domingo')::date`;
      const AHORA_RD = `(NOW() AT TIME ZONE 'America/Santo_Domingo')`;

      // Agenda de hoy ordenada por hora, con el estado que ve el médico.
      // El consultorio tiene un solo médico: la agenda del día es la suya.
      const { rows: agendaHoy } = await db.query(`
        SELECT c.id, c.paciente_id, c.hora, c.estado,
               p.nombre AS paciente_nombre, p.apellido AS paciente_apellido,
               COALESCE(s.nombre, 'Consulta General') AS servicio_nombre,
               CASE
                 WHEN c.estado = 'Atendida' THEN 'Atendido'
                 WHEN c.estado = 'En sala de espera' AND c.atencion_iniciada_en IS NOT NULL THEN 'En consulta'
                 WHEN c.estado = 'En sala de espera' THEN 'En espera'
                 WHEN c.estado = 'Cancelada' THEN 'No asistió'
                 WHEN (c.fecha + c.hora + INTERVAL '1 hour') < ${AHORA_RD} THEN 'No asistió'
                 ELSE 'Pendiente'
               END AS estado_medico
        FROM citas c
        INNER JOIN pacientes p ON p.id = c.paciente_id
        LEFT JOIN servicios s ON s.id = c.servicio_id
        WHERE c.fecha = ${HOY}
        ORDER BY c.hora ASC, c.id ASC
      `);

      // Citas de hoy (sin las canceladas)
      const citasHoy = agendaHoy.filter((c) => c.estado !== 'Cancelada').length;

      // Pacientes atendidos hoy por este médico
      const { rows: aHoy } = await db.query(
        `SELECT COUNT(*)::int AS n FROM consultas
         WHERE medico_id = $1
           AND (fecha_consulta::timestamptz AT TIME ZONE 'America/Santo_Domingo')::date = ${HOY}`,
        [req.session.usuario.id]
      );
      const atendidosHoy = aHoy[0].n;

      return res.render('index', {
        rol,
        enEsperaList,
        agendaHoy,
        citasHoy,
        atendidosHoy,
        title: 'Panel Médico - Consultorio San Rafael',
      });
    }

    // ========================================================
    // 2. PANEL PARA ROL SECRETARÍA (Pacientes, Citas, ARS y Cobros)
    // ========================================================
    if (rol === 'SECRETARIA' || rol === 'RECEPCION') {
      // Pacientes registrados
      const { rows: pCount } = await db.query(`SELECT COUNT(*) FROM pacientes WHERE activo = true`);
      const totalPacientes = parseInt(pCount[0].count, 10);

      // Citas programadas para hoy
      const { rows: cCount } = await db.query(
        `SELECT COUNT(*) FROM citas WHERE fecha = CURRENT_DATE AND estado != 'Cancelada'`
      );
      const citasHoy = parseInt(cCount[0].count, 10);

      // Pacientes en sala de espera (check-in confirmado)
      const { rows: sCount } = await db.query(
        `SELECT COUNT(*) FROM citas WHERE estado = 'En sala de espera'`
      );
      const enEsperaCount = parseInt(sCount[0].count, 10);

      // Total ARS activas
      const { rows: aCount } = await db.query(`SELECT COUNT(*) FROM ars WHERE activo = true`);
      const totalArs = parseInt(aCount[0].count, 10);

      // Agenda y citas del día
      const { rows: proximasCitas } = await db.query(`
        SELECT c.*, p.nombre as paciente_nombre, p.apellido as paciente_apellido, p.identificacion,
               s.nombre as servicio_nombre
        FROM citas c
        INNER JOIN pacientes p ON c.paciente_id = p.id
        LEFT JOIN servicios s ON c.servicio_id = s.id
        WHERE c.fecha = CURRENT_DATE
        ORDER BY c.hora ASC LIMIT 8
      `);

      // Pacientes registrados recientemente
      const { rows: pacientesRecientes } = await db.query(`
        SELECT p.*, a.nombre as ars_nombre
        FROM pacientes p
        LEFT JOIN ars a ON p.ars_id = a.id
        WHERE p.activo = true
        ORDER BY p.id DESC LIMIT 5
      `);

      // Atenciones médicas y consultas con cobro pendiente en caja
      const { rows: cobrosPendientes } = await db.query(`
        SELECT c.*,
               p.nombre as paciente_nombre, p.apellido as paciente_apellido, p.identificacion as paciente_identificacion,
               s.nombre as servicio_nombre, s.codigo as servicio_codigo,
               a.nombre as ars_nombre
        FROM consultas c
        INNER JOIN pacientes p ON c.paciente_id = p.id
        LEFT JOIN servicios s ON c.servicio_id = s.id
        LEFT JOIN ars a ON c.ars_id = a.id
        WHERE c.estado_pago = 'Pendiente'
        ORDER BY c.fecha_consulta DESC, c.id DESC
        LIMIT 8
      `);

      const { rows: pendCount } = await db.query(
        `SELECT COUNT(*) FROM consultas WHERE estado_pago = 'Pendiente'`
      );
      const cobrosPendientesCount = parseInt(pendCount[0].count, 10);

      return res.render('index', {
        rol,
        totalPacientes,
        citasHoy,
        enEsperaCount,
        totalArs,
        proximasCitas,
        pacientesRecientes,
        cobrosPendientes,
        cobrosPendientesCount,
        title: 'Panel Secretaría - Consultorio San Rafael',
      });
    }

    // ========================================================
    // 3. PANEL PARA ROL FARMACIA (Recetas e Inventario)
    // ========================================================
    if (rol === 'FARMACIA') {
      // Recetas pendientes de entrega
      const { rows: rPend } = await db.query(`
        SELECT COUNT(DISTINCT r.id) as pendientes
        FROM recetas r
        INNER JOIN receta_detalles rd ON rd.receta_id = r.id
        WHERE rd.estado_dispensacion = 'Pendiente'
      `);
      const recetasPendientesCount = parseInt(rPend[0].pendientes, 10);

      // Recetas entregadas
      const { rows: rEnt } = await db.query(`
        SELECT COUNT(DISTINCT r.id) as entregadas
        FROM recetas r
        INNER JOIN receta_detalles rd ON rd.receta_id = r.id
        WHERE rd.estado_dispensacion = 'Entregado'
      `);
      const recetasEntregadasCount = parseInt(rEnt[0].entregadas, 10);

      // Medicamentos con stock bajo o agotados
      const { rows: mAlert } = await db.query(`
        SELECT COUNT(*) as bajo_stock FROM medicamentos WHERE activo = true AND stock_actual <= stock_minimo
      `);
      const medicamentosBajoStock = parseInt(mAlert[0].bajo_stock, 10);

      // Total de medicamentos en inventario
      const { rows: mTot } = await db.query(`SELECT COUNT(*) FROM medicamentos WHERE activo = true`);
      const totalMedicamentos = parseInt(mTot[0].count, 10);

      // Cola de recetas pendientes de despacho
      const { rows: colaRecetas } = await db.query(`
        SELECT r.id as receta_id, r.codigo_receta, r.fecha_emision,
               p.nombre as paciente_nombre, p.apellido as paciente_apellido,
               COUNT(rd.id) as total_items,
               COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) as pendientes
        FROM recetas r
        INNER JOIN pacientes p ON r.paciente_id = p.id
        LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
        GROUP BY r.id, r.codigo_receta, r.fecha_emision, p.nombre, p.apellido
        ORDER BY r.fecha_emision DESC LIMIT 6
      `);

      // Medicamentos con existencias críticas
      const { rows: medsCriticos } = await db.query(`
        SELECT * FROM medicamentos
        WHERE activo = true AND stock_actual <= stock_minimo
        ORDER BY stock_actual ASC LIMIT 6
      `);

      return res.render('index', {
        rol,
        recetasPendientesCount,
        recetasEntregadasCount,
        medicamentosBajoStock,
        totalMedicamentos,
        colaRecetas,
        medsCriticos,
        title: 'Panel Farmacia - Consultorio San Rafael',
      });
    }

    // ========================================================
    // 4. PANEL PARA ROL ADMINISTRADOR (Gestión de Usuarios, Tarifarios y Medicamentos)
    // ========================================================
    const { rows: uCount } = await db.query(`SELECT COUNT(*) FROM usuarios WHERE activo = true`);
    const totalUsuarios = parseInt(uCount[0].count, 10);

    const { rows: aCount } = await db.query(`SELECT COUNT(*) FROM ars WHERE activo = true`);
    const totalArs = parseInt(aCount[0].count, 10);

    const { rows: mCount } = await db.query(`SELECT COUNT(*) FROM medicamentos WHERE activo = true`);
    const totalMedicamentos = parseInt(mCount[0].count, 10);

    const { rows: pCount } = await db.query(`SELECT COUNT(*) FROM pacientes WHERE activo = true`);
    const totalPacientes = parseInt(pCount[0].count, 10);

    const { rows: cCount } = await db.query(`SELECT COUNT(*) FROM consultas`);
    const totalConsultas = parseInt(cCount[0].count, 10);

    // Usuarios del sistema
    const { rows: usuariosList } = await db.query(`
      SELECT id, nombre, usuario, correo, rol, activo FROM usuarios ORDER BY id ASC
    `);

    // Resumen de ARS y tarifarios
    const { rows: arsTarifas } = await db.query(`
      SELECT a.id, a.nombre as ars_nombre, a.codigo,
             COUNT(t.id) as tarifas_configuradas
      FROM ars a
      LEFT JOIN ars_tarifarios t ON t.ars_id = a.id
      WHERE a.activo = true
      GROUP BY a.id, a.nombre, a.codigo
      ORDER BY a.nombre ASC
    `);

    res.render('index', {
      rol,
      totalUsuarios,
      totalArs,
      totalMedicamentos,
      totalPacientes,
      totalConsultas,
      usuariosList,
      arsTarifas,
      title: 'Panel Administración - Consultorio San Rafael',
    });
  } catch (error) {
    if (error.code === '42P01' || error.code === 'ECONNREFUSED' || error.code === '28P01') {
      return res.render('db-error', {
        error,
        title: 'Configuración de Base de Datos Requerida',
      });
    }
    next(error);
  }
});

module.exports = router;
