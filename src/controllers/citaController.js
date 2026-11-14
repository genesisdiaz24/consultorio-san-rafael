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

// Formulario para nueva cita
exports.formularioCrear = async (req, res, next) => {
  try {
    const pacienteId = req.query.paciente_id;
    let pacienteSeleccionado = null;

    if (pacienteId) {
      const { rows } = await db.query(`SELECT * FROM pacientes WHERE id = $1`, [pacienteId]);
      if (rows.length > 0) pacienteSeleccionado = rows[0];
    }

    const { rows: pacientes } = await db.query(
      `SELECT id, identificacion, nombre, apellido, telefono, correo, fecha_nacimiento FROM pacientes WHERE activo = true ORDER BY nombre ASC`
    );

    const { rows: servicios } = await db.query(
      `SELECT id, codigo, nombre, precio_base FROM servicios WHERE activo = true ORDER BY nombre ASC`
    );

    res.render('citas/form', {
      pacientes,
      servicios,
      pacienteSeleccionado,
      cita: {},
      title: 'Agendar Nueva Cita',
    });
  } catch (error) {
    next(error);
  }
};

// Función auxiliar para validar y normalizar fechas escritas manualmente o elegidas con calendario (AAAA-MM-DD o DD/MM/AAAA)
function normalizarFecha(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();

  // 1. Formato ISO AAAA-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) {
      return s;
    }
    return null;
  }

  // 2. Formato latinoamericano DD/MM/AAAA o DD-MM-AAAA
  const match = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const d = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) {
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    return null;
  }

  return null;
}
exports.normalizarFecha = normalizarFecha;

// Guardar cita con verificación de disponibilidad de horario y normalización de fechas manuales/calendario
exports.crear = async (req, res, next) => {
  try {
    const {
      paciente_id,
      servicio_id,
      fecha,
      hora,
      canal_solicitud,
      telefono_contacto,
      correo_contacto,
      fecha_nacimiento,
      motivo,
      notas_recepcion,
    } = req.body;

    if (!paciente_id || !fecha || !hora || !canal_solicitud || !telefono_contacto || !motivo) {
      req.flash('error', 'Por favor complete todos los datos requeridos para la cita (*).');
      return res.redirect('/citas/nueva');
    }

    // 1. Validar y normalizar formato de fecha de la cita (permite escritura manual y calendario)
    const fechaNormalizada = normalizarFecha(fecha);
    if (!fechaNormalizada) {
      req.flash(
        'error',
        'El formato de la fecha de la cita no es válido. Utilice el formato AAAA-MM-DD (ej: 2026-10-20) o DD/MM/AAAA (ej: 20/10/2026).'
      );
      return res.redirect('/citas/nueva');
    }

    // 2. Validar y conservar fecha de nacimiento del paciente (si se ingresó o editó)
    let fechaNacNormalizada = null;
    if (fecha_nacimiento && String(fecha_nacimiento).trim() !== '') {
      fechaNacNormalizada = normalizarFecha(fecha_nacimiento);
      if (!fechaNacNormalizada) {
        req.flash(
          'error',
          'El formato de la fecha de nacimiento no es válido. Utilice el formato AAAA-MM-DD (ej: 1990-05-15) o DD/MM/AAAA (ej: 15/05/1990).'
        );
        return res.redirect('/citas/nueva');
      }

      // Conservar la fecha de nacimiento en el expediente del paciente
      await db.query(
        `UPDATE pacientes SET fecha_nacimiento = $1 WHERE id = $2`,
        [fechaNacNormalizada, parseInt(paciente_id, 10)]
      );
    }

    // 3. Verificación de disponibilidad de horario para evitar solapamientos
    const { rows: existentes } = await db.query(
      `SELECT c.id, c.hora, p.nombre, p.apellido
       FROM citas c
       INNER JOIN pacientes p ON c.paciente_id = p.id
       WHERE c.fecha = $1 AND c.hora = $2 AND c.estado NOT IN ('Cancelada')`,
      [fechaNormalizada, hora]
    );

    if (existentes.length > 0) {
      const conflicto = existentes[0];
      req.flash(
        'error',
        `Conflicto de horario: Ya existe una cita activa para el ${fechaNormalizada} a las ${hora} (Paciente: ${conflicto.nombre} ${conflicto.apellido}). Seleccione otro horario.`
      );
      return res.redirect('/citas/nueva');
    }

    // 4. Inserción de la cita con fecha validada y normalizada
    const insertQuery = `
      INSERT INTO citas (
        paciente_id, servicio_id, fecha, hora,
        canal_solicitud, telefono_contacto, correo_contacto,
        motivo, notas_recepcion, estado
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Programada')
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
      motivo.trim(),
      notas_recepcion ? notas_recepcion.trim() : null,
    ];

    await db.query(insertQuery, values);
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

