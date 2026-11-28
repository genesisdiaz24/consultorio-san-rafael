const db = require('../config/db');

// Listar citas con filtros de fecha, estado o canal
exports.listar = async (req, res, next) => {
  try {
    const { fecha, estado, canal } = req.query;
    let queryText = `
      SELECT c.*,
             p.nombre AS paciente_nombre,
             p.apellido AS paciente_apellido,
             p.identificacion AS paciente_identificacion,
             s.nombre AS servicio_nombre
      FROM citas c
      INNER JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN servicios s ON c.servicio_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (fecha) {
      params.push(fecha);
      queryText += ` AND c.fecha = $${params.length}`;
    }

    if (estado) {
      params.push(estado);
      queryText += ` AND c.estado = $${params.length}`;
    }

    if (canal) {
      params.push(canal);
      queryText += ` AND c.canal_solicitud = $${params.length}`;
    }

    queryText += ` ORDER BY c.fecha DESC, c.hora ASC LIMIT 150`;

    const { rows: citas } = await db.query(queryText, params);

    res.render('citas/index', {
      citas,
      filtros: { fecha: fecha || '', estado: estado || '', canal: canal || '' },
      title: 'Gestión y Agenda de Citas',
    });
  } catch (error) {
    next(error);
  }
};

// Muestra el formulario de cita. Si viene de un intento fallido, conserva lo escrito y marca el campo con error.
async function renderFormulario(res, { pacienteId = null, valores = {}, errores = {}, mensajeError = null, status = 200 } = {}) {
  let pacienteSeleccionado = null;
  const idPaciente = parseInt(pacienteId, 10);
  if (idPaciente > 0) {
    const { rows } = await db.query(`SELECT * FROM pacientes WHERE id = $1`, [idPaciente]);
    if (rows.length > 0) pacienteSeleccionado = rows[0];
  }

  const { rows: pacientes } = await db.query(
    `SELECT id, identificacion, nombre, apellido, telefono, correo, fecha_nacimiento FROM pacientes WHERE activo = true ORDER BY nombre ASC`
  );

  const { rows: servicios } = await db.query(
    `SELECT id, codigo, nombre, precio_base FROM servicios WHERE activo = true ORDER BY nombre ASC`
  );

  if (mensajeError) res.locals.mensajes.error = [...(res.locals.mensajes.error || []), mensajeError];

  res.status(status).render('citas/form', {
    pacientes,
    servicios,
    pacienteSeleccionado,
    cita: {},
    valores,
    errores,
    title: 'Agendar Nueva Cita',
  });
}

// Formulario para nueva cita
exports.formularioCrear = async (req, res, next) => {
  try {
    await renderFormulario(res, { pacienteId: req.query.paciente_id });
  } catch (error) {
    next(error);
  }
};

// Validación y normalización de fechas escritas (AAAA-MM-DD o DD/MM/AAAA): utilidad compartida
const { normalizarFecha } = require('../utils/fechas');
exports.normalizarFecha = normalizarFecha;

const HORAS_VALIDAS = [
  '08:00:00', '08:30:00', '09:00:00', '09:30:00', '10:00:00', '10:30:00', '11:00:00', '11:30:00',
  '14:00:00', '14:30:00', '15:00:00', '15:30:00', '16:00:00', '16:30:00', '17:00:00',
];

// Guardar cita con verificación de disponibilidad de horario.
// La secretaria no registra información clínica: el motivo de consulta lo anota el médico al atender.
// La fecha de nacimiento se muestra del expediente y no se modifica desde aquí.
exports.crear = async (req, res, next) => {
  const { paciente_id, servicio_id, fecha, hora, canal_solicitud, telefono_contacto, correo_contacto } = req.body;
  const valores = { paciente_id, servicio_id, fecha, hora, canal_solicitud, telefono_contacto, correo_contacto };
  const volver = (opciones) => renderFormulario(res, { pacienteId: paciente_id, valores, ...opciones });

  try {
    if (!paciente_id || !fecha || !hora || !canal_solicitud || !telefono_contacto || !String(telefono_contacto).trim()) {
      return await volver({ status: 422, mensajeError: 'Por favor complete todos los datos requeridos para la cita (*).' });
    }

    if (!HORAS_VALIDAS.includes(hora)) {
      return await volver({ status: 422, errores: { hora: 'Seleccione una hora de la lista.' } });
    }

    // 1. Validar y normalizar formato de fecha de la cita (permite escritura manual y calendario)
    const fechaNormalizada = normalizarFecha(fecha);
    if (!fechaNormalizada) {
      return await volver({
        status: 422,
        mensajeError: 'El formato de la fecha de la cita no es válido. Utilice AAAA-MM-DD (ej: 2026-10-20) o DD/MM/AAAA (ej: 20/10/2026).',
      });
    }
    valores.fecha = fechaNormalizada;

    // 2. Verificación interna de disponibilidad: un solo paciente por horario
    const { rows: existentes } = await db.query(
      `SELECT c.id FROM citas c
       WHERE c.fecha = $1 AND c.hora = $2 AND c.estado NOT IN ('Cancelada')`,
      [fechaNormalizada, hora]
    );
    const horarioOcupado = 'Este horario ya está ocupado para la fecha elegida. Seleccione otra hora.';
    if (existentes.length > 0) {
      return await volver({ status: 409, errores: { hora: horarioOcupado } });
    }

    // 3. Inserción de la cita (sin motivo ni notas: no son datos de recepción)
    const insertQuery = `
      INSERT INTO citas (
        paciente_id, servicio_id, fecha, hora,
        canal_solicitud, telefono_contacto, correo_contacto, estado
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Programada')
      RETURNING id
    `;

    const values = [
      parseInt(paciente_id, 10),
      servicio_id ? parseInt(servicio_id, 10) : null,
      fechaNormalizada,
      hora,
      canal_solicitud,
      telefono_contacto.trim(),
      correo_contacto ? correo_contacto.trim() : null,
    ];

    try {
      await db.query(insertQuery, values);
    } catch (error) {
      // El mismo paciente ya tuvo una cita (aunque cancelada) en ese día y hora: restricción única de la tabla
      if (error.code === '23505') {
        return await volver({ status: 409, errores: { hora: 'El paciente ya tiene registrada una cita en este día y hora. Seleccione otra hora.' } });
      }
      throw error;
    }

    req.flash('success', 'Cita agendada correctamente.');
    res.redirect('/citas');
  } catch (error) {
    next(error);
  }
};

// Confirmar llegada del paciente ("Check-in") y avisar al médico
exports.confirmarLlegada = async (req, res, next) => {
  try {
    const { id } = req.params;

    const queryText = `
      UPDATE citas
      SET estado = 'En sala de espera',
          fecha_llegada = CURRENT_TIMESTAMP,
          medico_notificado = true
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await db.query(queryText, [id]);

    if (rows.length === 0) {
      req.flash('error', 'Cita no encontrada.');
      return res.redirect('/citas');
    }

    req.flash(
      'success',
      '¡Llegada confirmada! El paciente ha sido puesto en Sala de Espera y el médico ha recibido la notificación de disponibilidad.'
    );
    res.redirect('/citas/sala-espera');
  } catch (error) {
    next(error);
  }
};

// Vista de Sala de Espera (Monitor para Recepción y Médico)
exports.salaEspera = async (req, res, next) => {
  try {
    const queryText = `
      SELECT c.*,
             p.id AS paciente_id,
             p.nombre AS paciente_nombre,
             p.apellido AS paciente_apellido,
             p.identificacion AS paciente_identificacion,
             p.telefono AS paciente_telefono,
             a.nombre AS ars_nombre,
             s.nombre AS servicio_nombre,
             ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.fecha_llegada)) / 60) AS minutos_espera
      FROM citas c
      INNER JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN ars a ON p.ars_id = a.id
      LEFT JOIN servicios s ON c.servicio_id = s.id
      WHERE c.estado = 'En sala de espera'
      ORDER BY c.fecha_llegada ASC
    `;

    const { rows: enEspera } = await db.query(queryText);

    res.render('citas/sala-espera', {
      enEspera,
      title: 'Sala de Espera - Pacientes Listos para Atención',
    });
  } catch (error) {
    next(error);
  }
};

// Cancelar cita
exports.cancelar = async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query(`UPDATE citas SET estado = 'Cancelada' WHERE id = $1`, [id]);
    req.flash('info', 'Cita cancelada.');
    res.redirect('/citas');
  } catch (error) {
    next(error);
  }
};

