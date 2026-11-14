const db = require('../config/db');

// Listar pacientes con filtro de búsqueda
exports.listar = async (req, res, next) => {
  try {
    const { q } = req.query;
    let queryText = `
      SELECT p.*, a.nombre AS ars_nombre
      FROM pacientes p
      LEFT JOIN ars a ON p.ars_id = a.id
      WHERE p.activo = true
    `;
    const params = [];

    if (q && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      queryText += `
        AND (
          p.identificacion ILIKE $1 OR
          p.nombre ILIKE $1 OR
          p.apellido ILIKE $1 OR
          CONCAT(p.nombre, ' ', p.apellido) ILIKE $1 OR
          p.telefono ILIKE $1
        )
      `;
    }

    queryText += ` ORDER BY p.nombre ASC, p.apellido ASC LIMIT 100`;

    const { rows: pacientes } = await db.query(queryText, params);
    res.render('pacientes/index', {
      pacientes,
      q: q || '',
      title: 'Directorio de Pacientes',
    });
  } catch (error) {
    next(error);
  }
};

// Formulario de nuevo paciente
exports.formularioCrear = async (req, res, next) => {
  try {
    const { rows: arsList } = await db.query(
      `SELECT id, nombre FROM ars WHERE activo = true ORDER BY nombre ASC`
    );
    res.render('pacientes/form', {
      paciente: {},
      arsList,
      esEdicion: false,
      title: 'Registrar Nuevo Paciente',
    });
  } catch (error) {
    next(error);
  }
};

// Guardar nuevo paciente con control de duplicados
exports.crear = async (req, res, next) => {
  try {
    const {
      identificacion,
      tipo_documento,
      nombre,
      apellido,
      fecha_nacimiento,
      genero,
      direccion,
      telefono,
      correo,
      ars_id,
      numero_afiliado,
      antecedentes_personales,
      antecedentes_alergicos,
      antecedentes_familiares,
    } = req.body;

    // Validación obligatoria
    if (!identificacion || !nombre || !apellido || !fecha_nacimiento || !genero || !telefono) {
      req.flash('error', 'Por favor complete todos los campos obligatorios (*).');
      return res.redirect('/pacientes/nuevo');
    }

    // Control estricto de duplicados por identificación
    const idNormalizada = identificacion.trim();
    const { rows: duplicados } = await db.query(
      `SELECT id, nombre, apellido, identificacion FROM pacientes WHERE identificacion = $1`,
      [idNormalizada]
    );

    if (duplicados.length > 0) {
      const p = duplicados[0];
      req.flash(
        'error',
        `No se pudo registrar: Ya existe un paciente registrado con la identificación "${idNormalizada}" (${p.nombre} ${p.apellido}). Puede localizar su ficha directamente.`
      );
      return res.redirect(`/pacientes/${p.id}`);
    }

    const insertQuery = `
      INSERT INTO pacientes (
        identificacion, tipo_documento, nombre, apellido,
        fecha_nacimiento, genero, direccion, telefono, correo,
        ars_id, numero_afiliado, antecedentes_personales,
        antecedentes_alergicos, antecedentes_familiares
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `;

    const values = [
      idNormalizada,
      tipo_documento || 'Cédula',
      nombre.trim(),
      apellido.trim(),
      fecha_nacimiento,
      genero,
      direccion || null,
      telefono.trim(),
      correo ? correo.trim() : null,
      ars_id ? parseInt(ars_id, 10) : null,
      numero_afiliado ? numero_afiliado.trim() : null,
      antecedentes_personales || null,
      antecedentes_alergicos || null,
      antecedentes_familiares || null,
    ];

    const result = await db.query(insertQuery, values);
    req.flash('success', 'Paciente registrado exitosamente.');
    res.redirect(`/pacientes/${result.rows[0].id}`);
  } catch (error) {
    if (error.code === '23505') {
      req.flash('error', 'Error: La identificación ya se encuentra registrada en el sistema.');
      return res.redirect('/pacientes/nuevo');
    }
    next(error);
  }
};

// Ver ficha clínica e historial completo del paciente
exports.verFicha = async (req, res, next) => {
  try {
    const { id } = req.params;
    const rolUsuario = req.session && req.session.usuario ? req.session.usuario.rol : '';
    const esClinico = ['MEDICO', 'ADMINISTRADOR'].includes(rolUsuario);

    // 1. Datos del paciente
    const { rows: pRows } = await db.query(
      `SELECT p.*, a.nombre AS ars_nombre
       FROM pacientes p
       LEFT JOIN ars a ON p.ars_id = a.id
       WHERE p.id = $1`,
      [id]
    );

    if (pRows.length === 0) {
      req.flash('error', 'Paciente no encontrado.');
      return res.redirect('/pacientes');
    }

    const paciente = { ...pRows[0] };
    let consultas = [];
    let recetas = [];

    // 2. Historial de consultas y cobros del paciente (accesible para cobro por Secretaría y evaluación clínica por Médicos/Admin)
    const { rows: consultasRows } = await db.query(
      `SELECT c.*, s.nombre AS servicio_nombre, a.nombre AS ars_nombre
       FROM consultas c
       LEFT JOIN servicios s ON c.servicio_id = s.id
       LEFT JOIN ars a ON c.ars_id = a.id
       WHERE c.paciente_id = $1
       ORDER BY c.fecha_consulta DESC, c.id DESC`,
      [id]
    );

    if (!esClinico) {
      // Proteger datos clínicos a nivel de servidor: Secretaría maneja datos de contacto, citas, ARS y cobros
      delete paciente.antecedentes_personales;
      delete paciente.antecedentes_alergicos;
      delete paciente.antecedentes_familiares;
      // Para Secretaría, proveemos las consultas con información de facturación y cobro, omitiendo diagnósticos y planes médicos confidenciales
      consultas = consultasRows.map((c) => ({
        id: c.id,
        paciente_id: c.paciente_id,
        fecha_consulta: c.fecha_consulta,
        servicio_id: c.servicio_id,
        servicio_nombre: c.servicio_nombre,
        ars_nombre: c.ars_nombre,
        valor_total: c.valor_total,
        valor_cubierto_ars: c.valor_cubierto_ars,
        diferencia_paciente: c.diferencia_paciente,
        estado_pago: c.estado_pago,
        created_at: c.created_at,
      }));
    } else {
      consultas = consultasRows;

      // 3. Recetas emitidas (solo Médico y Admin)
      const { rows: recetasRows } = await db.query(
        `SELECT r.*,
          (SELECT COUNT(*) FROM receta_detalles rd WHERE rd.receta_id = r.id) as total_medicamentos,
          (SELECT COUNT(*) FROM receta_detalles rd WHERE rd.receta_id = r.id AND rd.estado_dispensacion = 'Entregado') as entregados,
          (SELECT COUNT(*) FROM receta_detalles rd WHERE rd.receta_id = r.id AND rd.estado_dispensacion = 'No entregado - Sin existencias') as no_entregados
         FROM recetas r
         WHERE r.paciente_id = $1
         ORDER BY r.fecha_emision DESC, r.id DESC`,
        [id]
      );
      recetas = recetasRows;
    }

    // 4. Historial de citas (Secretaría, Médico y Admin)
    const { rows: citas } = await db.query(
      `SELECT ci.*, s.nombre AS servicio_nombre
       FROM citas ci
       LEFT JOIN servicios s ON ci.servicio_id = s.id
       WHERE ci.paciente_id = $1
       ORDER BY ci.fecha DESC, ci.hora DESC`,
      [id]
    );

    res.render('pacientes/detalle', {
      paciente,
      consultas,
      citas,
      recetas,
      esClinico,
      title: `Ficha de Paciente: ${paciente.nombre} ${paciente.apellido}`,
    });
  } catch (error) {
    next(error);
  }
};

// Formulario de edición
exports.formularioEditar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const rolUsuario = req.session && req.session.usuario ? req.session.usuario.rol : '';
    const esClinico = ['MEDICO', 'ADMINISTRADOR'].includes(rolUsuario);

    const { rows: pRows } = await db.query(`SELECT * FROM pacientes WHERE id = $1`, [id]);
    if (pRows.length === 0) {
      req.flash('error', 'Paciente no encontrado.');
      return res.redirect('/pacientes');
    }

    const paciente = { ...pRows[0] };
    if (!esClinico) {
      delete paciente.antecedentes_personales;
      delete paciente.antecedentes_alergicos;
      delete paciente.antecedentes_familiares;
    }

    const { rows: arsList } = await db.query(
      `SELECT id, nombre FROM ars WHERE activo = true ORDER BY nombre ASC`
    );

    res.render('pacientes/form', {
      paciente,
      arsList,
      esEdicion: true,
      esClinico,
      title: `Editar Paciente: ${paciente.nombre} ${paciente.apellido}`,
    });
  } catch (error) {
    next(error);
  }
};

// Actualizar datos del paciente
exports.actualizar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const rolUsuario = req.session && req.session.usuario ? req.session.usuario.rol : '';
    const esClinico = ['MEDICO', 'ADMINISTRADOR'].includes(rolUsuario);

    const {
      identificacion,
      tipo_documento,
      nombre,
      apellido,
      fecha_nacimiento,
      genero,
      direccion,
      telefono,
      correo,
      ars_id,
      numero_afiliado,
      antecedentes_personales,
      antecedentes_alergicos,
      antecedentes_familiares,
    } = req.body;

    const idNormalizada = identificacion.trim();

    // Validar duplicado con otros pacientes
    const { rows: otros } = await db.query(
      `SELECT id FROM pacientes WHERE identificacion = $1 AND id != $2`,
      [idNormalizada, id]
    );

    if (otros.length > 0) {
      req.flash(
        'error',
        `No se puede actualizar: La identificación "${idNormalizada}" ya pertenece a otro paciente registrado.`
      );
      return res.redirect(`/pacientes/${id}/editar`);
    }

    // Si el rol que edita no es clínico (por ejemplo, Secretaría), preservar antecedentes previos existentes
    let antPersonales = antecedentes_personales || null;
    let antAlergicos = antecedentes_alergicos || null;
    let antFamiliares = antecedentes_familiares || null;

    if (!esClinico) {
      const { rows: prevRows } = await db.query(
        `SELECT antecedentes_personales, antecedentes_alergicos, antecedentes_familiares FROM pacientes WHERE id = $1`,
        [id]
      );
      if (prevRows.length > 0) {
        antPersonales = prevRows[0].antecedentes_personales;
        antAlergicos = prevRows[0].antecedentes_alergicos;
        antFamiliares = prevRows[0].antecedentes_familiares;
      }
    }

    const updateQuery = `
      UPDATE pacientes SET
        identificacion = $1,
        tipo_documento = $2,
        nombre = $3,
        apellido = $4,
        fecha_nacimiento = $5,
        genero = $6,
        direccion = $7,
        telefono = $8,
        correo = $9,
        ars_id = $10,
        numero_afiliado = $11,
        antecedentes_personales = $12,
        antecedentes_alergicos = $13,
        antecedentes_familiares = $14
      WHERE id = $15
    `;

    const values = [
      idNormalizada,
      tipo_documento || 'Cédula',
      nombre.trim(),
      apellido.trim(),
      fecha_nacimiento,
      genero,
      direccion || null,
      telefono.trim(),
      correo ? correo.trim() : null,
      ars_id ? parseInt(ars_id, 10) : null,
      numero_afiliado ? numero_afiliado.trim() : null,
      antPersonales,
      antAlergicos,
      antFamiliares,
      id,
    ];

    await db.query(updateQuery, values);
    req.flash('success', 'Ficha del paciente actualizada con éxito.');
    res.redirect(`/pacientes/${id}`);
  } catch (error) {
    next(error);
  }
};

