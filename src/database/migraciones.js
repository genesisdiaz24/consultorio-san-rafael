/**
 * Migraciones idempotentes que se ejecutan en CADA arranque del servidor.
 *
 * init-db.js solo crea el esquema la primera vez; estas migraciones agregan
 * tablas/columnas nuevas a bases de datos ya existentes (local y Cloud SQL)
 * sin borrar datos. Cada una se ejecuta UNA vez (queda registrada en
 * schema_migraciones) dentro de una transacción; además son idempotentes
 * (IF NOT EXISTS / ON CONFLICT) por si se aplican sobre una base ya modificada.
 */
const db = require('../config/db');

const MIGRACIONES = [
  {
    nombre: '2026-11-cobertura-ars-farmacia',
    sql: `
      -- Precio de venta por unidad de cada medicamento
      ALTER TABLE medicamentos
        ADD COLUMN IF NOT EXISTS precio_unitario NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_medicamentos_precio_no_negativo') THEN
          ALTER TABLE medicamentos
            ADD CONSTRAINT chk_medicamentos_precio_no_negativo CHECK (precio_unitario >= 0);
        END IF;
      END $$;

      -- Qué ARS cubre cada medicamento y con qué porcentaje
      CREATE TABLE IF NOT EXISTS medicamento_coberturas_ars (
        id SERIAL PRIMARY KEY,
        medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id) ON DELETE CASCADE,
        ars_id INTEGER NOT NULL REFERENCES ars(id) ON DELETE CASCADE,
        porcentaje_cobertura NUMERIC(5, 2) NOT NULL CHECK (porcentaje_cobertura > 0 AND porcentaje_cobertura <= 100),
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_cobertura_medicamento_ars UNIQUE (medicamento_id, ars_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cobertura_ars ON medicamento_coberturas_ars(ars_id);

      -- Desglose congelado al momento de entregar (no cambia si luego cambian precios o coberturas)
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS precio_unitario NUMERIC(10, 2);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS monto_total NUMERIC(10, 2);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS porcentaje_cobertura NUMERIC(5, 2);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS monto_cubierto_ars NUMERIC(10, 2);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS monto_paciente NUMERIC(10, 2);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS ars_cobertura_id INTEGER REFERENCES ars(id) ON DELETE SET NULL;
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS ars_cobertura_nombre VARCHAR(120);
      ALTER TABLE receta_detalles ADD COLUMN IF NOT EXISTS cobertura_estado VARCHAR(20);
    `,
  },
  {
    nombre: '2026-11-datos-ejemplo-cobertura-farmacia',
    sql: `
      -- Precios de ejemplo (solo si el medicamento aún no tiene precio)
      UPDATE medicamentos m SET precio_unitario = v.precio
      FROM (VALUES
        ('MED-001', 5.00), ('MED-002', 8.00), ('MED-003', 45.00), ('MED-004', 12.00),
        ('MED-005', 10.00), ('MED-006', 18.00), ('MED-007', 9.00), ('MED-008', 60.00),
        ('MED-009', 450.00)
      ) AS v(codigo, precio)
      WHERE m.codigo = v.codigo AND m.precio_unitario = 0;

      -- Coberturas de ejemplo (no se sobrescriben si el administrador ya las cambió)
      INSERT INTO medicamento_coberturas_ars (medicamento_id, ars_id, porcentaje_cobertura)
      SELECT m.id, a.id, v.pct
      FROM (VALUES
        ('MED-001', 'SEN-01', 80), ('MED-002', 'SEN-01', 70), ('MED-003', 'SEN-01', 80),
        ('MED-006', 'SEN-01', 90), ('MED-007', 'SEN-01', 90),
        ('MED-001', 'PRIM-02', 70), ('MED-003', 'PRIM-02', 75), ('MED-004', 'PRIM-02', 60),
        ('MED-006', 'PRIM-02', 80),
        ('MED-002', 'UNI-04', 60), ('MED-005', 'UNI-04', 50), ('MED-009', 'UNI-04', 70)
      ) AS v(med_codigo, ars_codigo, pct)
      INNER JOIN medicamentos m ON m.codigo = v.med_codigo
      INNER JOIN ars a ON a.codigo = v.ars_codigo
      ON CONFLICT (medicamento_id, ars_id) DO NOTHING;
    `,
  },
  {
    nombre: '2026-11-consultas-medico',
    sql: `
      -- Médico que atendió la consulta. Los médicos son usuarios con rol MEDICO;
      -- el diseño admite varios médicos aunque hoy el consultorio tenga uno solo.
      ALTER TABLE consultas ADD COLUMN IF NOT EXISTS medico_id INTEGER;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_consultas_medico') THEN
          -- RESTRICT: no se puede borrar un médico con consultas (los usuarios se desactivan, no se borran)
          ALTER TABLE consultas
            ADD CONSTRAINT fk_consultas_medico FOREIGN KEY (medico_id) REFERENCES usuarios(id) ON DELETE RESTRICT;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_consultas_medico ON consultas(medico_id);

      -- La clave foránea apunta a usuarios: este trigger garantiza que sea un usuario con rol MEDICO
      CREATE OR REPLACE FUNCTION validar_medico_consulta() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.medico_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM usuarios WHERE id = NEW.medico_id AND rol = 'MEDICO') THEN
          RAISE EXCEPTION 'El usuario % no tiene rol MEDICO y no puede figurar como médico de una consulta', NEW.medico_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_validar_medico_consulta ON consultas;
      CREATE TRIGGER trg_validar_medico_consulta
        BEFORE INSERT OR UPDATE OF medico_id ON consultas
        FOR EACH ROW EXECUTE FUNCTION validar_medico_consulta();

      -- Consultas existentes → Dr. Rafael Morales (usuario "medico"; si no existe, el primer médico registrado)
      UPDATE consultas c SET medico_id = m.id
      FROM (
        SELECT id FROM usuarios WHERE rol = 'MEDICO'
        ORDER BY (usuario = 'medico') DESC, id ASC LIMIT 1
      ) m
      WHERE c.medico_id IS NULL;
    `,
  },
];

async function ejecutarMigraciones() {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migraciones (
      nombre VARCHAR(120) PRIMARY KEY,
      aplicada_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const { rows } = await db.pool.query('SELECT nombre FROM schema_migraciones');
  const aplicadas = new Set(rows.map((r) => r.nombre));

  let nuevas = 0;
  for (const m of MIGRACIONES) {
    if (aplicadas.has(m.nombre)) continue;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migraciones (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [m.nombre]);
      await client.query('COMMIT');
      nuevas++;
      console.log(`✔ Migración aplicada: ${m.nombre}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`⚠️ Migración "${m.nombre}" falló: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }
  if (nuevas === 0) console.log('✔ Base de datos al día (sin migraciones pendientes).');
}

module.exports = { ejecutarMigraciones, MIGRACIONES };
