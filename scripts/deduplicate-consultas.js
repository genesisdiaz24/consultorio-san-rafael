const db = require('../src/config/db');

async function deduplicate() {
  const client = await db.pool.connect();
  try {
    console.log('--- Iniciando deduplicación de consultas médicas ---');
    await client.query('BEGIN');

    // 1. Identificar y eliminar duplicados de citas (cita_id IS NOT NULL)
    // Mantendremos la primera consulta registrada (MIN(id)) para cada cita_id
    const { rows: dupCitas } = await client.query(`
      SELECT cita_id, MIN(id) as primer_id, ARRAY_AGG(id) as todos_ids, COUNT(*) as conteo
      FROM consultas
      WHERE cita_id IS NOT NULL
      GROUP BY cita_id
      HAVING COUNT(*) > 1
    `);

    for (const row of dupCitas) {
      const idsABorrar = row.todos_ids.filter(id => id !== row.primer_id);
      console.log(`Cita #${row.cita_id}: Conservando consulta #${row.primer_id}. Eliminando duplicados: ${idsABorrar.join(', ')}`);

      // Eliminar recetas y detalles asociados a las consultas duplicadas si existieran
      await client.query(`
        DELETE FROM receta_detalles
        WHERE receta_id IN (SELECT id FROM recetas WHERE consulta_id = ANY($1::int[]))
      `, [idsABorrar]);

      await client.query(`
        DELETE FROM recetas WHERE consulta_id = ANY($1::int[])
      `, [idsABorrar]);

      await client.query(`
        DELETE FROM consultas WHERE id = ANY($1::int[])
      `, [idsABorrar]);
    }

    // 2. Identificar y eliminar duplicados sin cita (mismo paciente, motivo y diagnóstico)
    // Mantendremos la primera consulta registrada (MIN(id))
    const { rows: dupSinCita } = await client.query(`
      SELECT paciente_id, motivo_consulta, diagnostico_clinico, MIN(id) as primer_id, ARRAY_AGG(id) as todos_ids, COUNT(*) as conteo
      FROM consultas
      WHERE cita_id IS NULL
      GROUP BY paciente_id, motivo_consulta, diagnostico_clinico
      HAVING COUNT(*) > 1
    `);

    for (const row of dupSinCita) {
      const idsABorrar = row.todos_ids.filter(id => id !== row.primer_id);
      console.log(`Paciente #${row.paciente_id} (${row.diagnostico_clinico}): Conservando consulta #${row.primer_id}. Eliminando duplicados: ${idsABorrar.join(', ')}`);

      // Eliminar recetas y detalles vinculados a los duplicados
      await client.query(`
        DELETE FROM receta_detalles
        WHERE receta_id IN (SELECT id FROM recetas WHERE consulta_id = ANY($1::int[]))
      `, [idsABorrar]);

      await client.query(`
        DELETE FROM recetas WHERE consulta_id = ANY($1::int[])
      `, [idsABorrar]);

      await client.query(`
        DELETE FROM consultas WHERE id = ANY($1::int[])
      `, [idsABorrar]);
    }

    // 3. Crear índice único para evitar que una cita tenga más de una consulta a nivel de base de datos
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_consultas_cita_id 
      ON consultas (cita_id) 
      WHERE cita_id IS NOT NULL
    `);
    console.log('✔ Restricción única uq_consultas_cita_id verificada / creada.');

    await client.query('COMMIT');
    console.log('✔ Deduplicación completada con éxito.');

    // Mostrar estado final de consultas
    const { rows: finales } = await client.query(`
      SELECT c.id, c.cita_id, c.paciente_id, p.nombre, p.apellido, c.diagnostico_clinico, c.fecha_consulta
      FROM consultas c
      JOIN pacientes p ON c.paciente_id = p.id
      ORDER BY c.fecha_consulta DESC, c.id DESC
    `);
    console.log('\nConsultas legítimas restantes:');
    console.table(finales);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error durante la deduplicación:', error);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

deduplicate();

