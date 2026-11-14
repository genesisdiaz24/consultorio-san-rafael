const db = require('../src/config/db');

async function fixDuplicates() {
  console.log('--- Limpiando duplicados de citas ---');
  const resDel = await db.query(`
    DELETE FROM citas a
    USING citas b
    WHERE a.id > b.id
      AND a.paciente_id = b.paciente_id
      AND a.fecha = b.fecha
      AND a.hora = b.hora
  `);
  console.log('Citas duplicadas eliminadas:', resDel.rowCount);

  // Agregar restricción UNIQUE
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_cita_paciente_fecha_hora'
      ) THEN
        ALTER TABLE citas ADD CONSTRAINT uq_cita_paciente_fecha_hora UNIQUE (paciente_id, fecha, hora);
      END IF;
    END $$;
  `);
  console.log('✔ Restricción UNIQUE agregada a citas (paciente_id, fecha, hora).');

  const check = await db.query(`
    SELECT c.id, c.fecha, c.hora, c.motivo, c.estado, p.nombre, p.apellido
    FROM citas c
    INNER JOIN pacientes p ON c.paciente_id = p.id
    ORDER BY c.fecha ASC, c.hora ASC
  `);
  console.log('\n--- Citas válidas actuales en el sistema ---');
  console.table(check.rows);
  process.exit(0);
}

fixDuplicates().catch((err) => {
  console.error('Error al limpiar duplicados:', err);
  process.exit(1);
});

