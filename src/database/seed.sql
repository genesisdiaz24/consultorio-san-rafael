
-- 0. USUARIOS POR ROL (ADMINISTRADOR, MEDICO, SECRETARIA, FARMACIA)
INSERT INTO usuarios (nombre, usuario, correo, contrasena, salt, rol, activo, token_version)
VALUES
    ('Administrador del Sistema', 'admin', 'admin@sanrafael.com', '$2b$12$yyeCZiUfQJjzvdG5OmUnYumX7cXuzsP/1SnPHi6ombU1RBYP3Hrk6', '$2b$12$yyeCZiUfQJjzvdG5OmUnYu', 'ADMINISTRADOR', true, 1),
    ('Dr. Rafael Morales (Médico)', 'medico', 'medico@sanrafael.com', '$2b$12$JIKMe8W4BgqgepbKDadDhOUGbJlHTNVxZp7wmhjbhTxw0nhzh0ca6', '$2b$12$JIKMe8W4BgqgepbKDadDhO', 'MEDICO', true, 1),
    ('Laura Gómez (Secretaría)', 'secretaria', 'secretaria@sanrafael.com', '$2b$12$JGGXxJVPjqwtFpfRaq1bKuWJTdVRJuDgFj9D4gTAb.g/cO.ywaFt.', '$2b$12$JGGXxJVPjqwtFpfRaq1bKu', 'SECRETARIA', true, 1),
    ('Laura Gómez (Recepción)', 'recepcion', 'recepcion@sanrafael.com', '$2b$12$L5r.tYHYCSe3zh3L9OLI1./7K5xNajAFK2H152ivv/1rKBHEEkIUK', '$2b$12$L5r.tYHYCSe3zh3L9OLI1.', 'SECRETARIA', true, 1),
    ('Carlos Dávila (Farmacéutico)', 'farmacia', 'farmacia@sanrafael.com', '$2b$12$QYSV/tj.9aQMv755i9ZyQ.xnyGw87GbJQfgbPWAPyAbKTbwH.ZvPe', '$2b$12$QYSV/tj.9aQMv755i9ZyQ.', 'FARMACIA', true, 1)
ON CONFLICT (usuario) DO NOTHING;

-- 1. ARS (Aseguradoras de Riesgos de Salud)
INSERT INTO ars (nombre, codigo, telefono, correo, contacto_nombre, notas)
VALUES
    ('ARS Privado / Sin Seguro', 'PRIV', '809-555-0001', 'particular@consultorio.com', 'N/A', 'Atención directa sin aseguradora'),
    ('Senasa Contributivo', 'SEN-01', '809-555-1100', 'autorizaciones@senasa.gob.do', 'Dpto. Médico Senasa', 'Seguro Nacional de Salud'),
    ('Primera ARS de Humano', 'PRIM-02', '809-555-2200', 'prestadores@primeraars.com', 'Gestión de Prestadores', 'Red Preferente'),
    ('Mapfre Salud ARS', 'MAP-03', '809-555-3300', 'autoriza@mapfresalud.com', 'Línea Médica', 'Cobertura nacional'),
    ('ARS Universal', 'UNI-04', '809-555-4400', 'atencion@universal.com.do', 'Servicios de Salud', 'Plan Élite y Estándar')
ON CONFLICT (nombre) DO NOTHING;

-- 2. SERVICIOS MÉDICOS
INSERT INTO servicios (codigo, nombre, descripcion, precio_base)
VALUES
    ('MED-GEN', 'Consulta de Medicina General', 'Evaluación médica integral, examen físico y diagnóstico inicial', 1500.00),
    ('MED-ESP', 'Consulta Médica Especializada', 'Atención por médico especialista en medicina interna', 2500.00),
    ('CONTROL', 'Consulta de Control o Seguimiento', 'Revisión de resultados y evolución de tratamiento', 1000.00),
    ('EKG-01',  'Electrocardiograma (EKG)', 'Registro de actividad eléctrica del corazón con informe', 1200.00),
    ('CUR-01',  'Curación y Manejo de Heridas Menores', 'Procedimiento de enfermería y limpieza aséptica', 800.00),
    ('CERT-01', 'Certificado Médico Oficial', 'Evaluación psicofísica y expedición de certificado', 1000.00)
ON CONFLICT (codigo) DO NOTHING;

-- 3. TARIFARIOS CONFIGURADOS POR ARS Y SERVICIO
-- Nótese: No son valores fijos en el código, están en la base de datos y se pueden editar desde el sistema.
INSERT INTO ars_tarifarios (ars_id, servicio_id, tarifa_pactada, tipo_cobertura, valor_cobertura, copago_fijo, notas)
SELECT a.id, s.id, 1500.00, 'PORCENTAJE', 80.00, 300.00, '80% cubierto por ARS, copago estándar paciente'
FROM ars a, servicios s
WHERE a.codigo = 'SEN-01' AND s.codigo = 'MED-GEN'
ON CONFLICT (ars_id, servicio_id) DO NOTHING;

INSERT INTO ars_tarifarios (ars_id, servicio_id, tarifa_pactada, tipo_cobertura, valor_cobertura, copago_fijo, notas)
SELECT a.id, s.id, 2500.00, 'PORCENTAJE', 75.00, 500.00, '75% cubierto por Senasa en especialidad'
FROM ars a, servicios s
WHERE a.codigo = 'SEN-01' AND s.codigo = 'MED-ESP'
ON CONFLICT (ars_id, servicio_id) DO NOTHING;

INSERT INTO ars_tarifarios (ars_id, servicio_id, tarifa_pactada, tipo_cobertura, valor_cobertura, copago_fijo, notas)
SELECT a.id, s.id, 1500.00, 'MONTO_FIJO', 1200.00, 300.00, 'Cobertura fija de RD$ 1,200.00 por consulta general'
FROM ars a, servicios s
WHERE a.codigo = 'PRIM-02' AND s.codigo = 'MED-GEN'
ON CONFLICT (ars_id, servicio_id) DO NOTHING;

INSERT INTO ars_tarifarios (ars_id, servicio_id, tarifa_pactada, tipo_cobertura, valor_cobertura, copago_fijo, notas)
SELECT a.id, s.id, 1500.00, 'PORCENTAJE', 85.00, 200.00, '85% cobertura Plan Preferente Mapfre'
FROM ars a, servicios s
WHERE a.codigo = 'MAP-03' AND s.codigo = 'MED-GEN'
ON CONFLICT (ars_id, servicio_id) DO NOTHING;

-- 4. MEDICAMENTOS DE LA FARMACIA INTERNA
-- Incluye medicamentos con existencia y medicamentos con stock 0 para probar el flujo de derivación externa
INSERT INTO medicamentos (codigo, nombre, principio_activo, presentacion, concentracion, stock_actual, stock_minimo, ubicacion, lote, fecha_vencimiento)
VALUES
    ('MED-001', 'Paracetamol / Acetaminofén', 'Paracetamol', 'Tabletas', '500 mg', 120, 20, 'Estante A-1', 'LOT-2026-A', '2027-12-31'),
    ('MED-002', 'Ibuprofeno', 'Ibuprofeno', 'Tabletas', '400 mg', 85, 15, 'Estante A-2', 'LOT-2026-B', '2027-10-15'),
    ('MED-003', 'Amoxicilina + Ácido Clavulánico', 'Amoxicilina / Clavulanato', 'Tabletas recubiertas', '875/125 mg', 45, 10, 'Estante B-1', 'LOT-2026-C', '2027-08-20'),
    ('MED-004', 'Omeprazol', 'Omeprazol', 'Cápsulas', '20 mg', 60, 15, 'Estante B-3', 'LOT-2026-D', '2028-01-10'),
    ('MED-005', 'Loratadina', 'Loratadina', 'Tabletas', '10 mg', 50, 10, 'Estante C-1', 'LOT-2026-E', '2027-11-30'),
    ('MED-006', 'Losartán Potásico', 'Losartán', 'Tabletas', '50 mg', 40, 10, 'Estante C-2', 'LOT-2026-F', '2028-03-15'),
    ('MED-007', 'Metformina', 'Metformina Clorhidrato', 'Tabletas', '850 mg', 30, 10, 'Estante C-3', 'LOT-2026-G', '2028-02-28'),
    -- Medicamentos SIN EXISTENCIA (Stock 0) para verificar proceso de receta y derivación externa
    ('MED-008', 'Azitromicina', 'Azitromicina', 'Tabletas', '500 mg', 0, 10, 'Estante B-2', 'LOT-2026-008', '2026-12-31'),
    ('MED-009', 'Salbutamol Inhalador', 'Salbutamol', 'Aerosol para inhalación', '100 mcg / dosis', 0, 5, 'Estante D-1', 'LOT-2026-009', '2026-12-31')
ON CONFLICT (codigo) DO NOTHING;

-- 5. PACIENTES DE PRUEBA
INSERT INTO pacientes (identificacion, tipo_documento, nombre, apellido, fecha_nacimiento, genero, direccion, telefono, correo, ars_id, numero_afiliado, antecedentes_personales, antecedentes_alergicos, antecedentes_familiares)
SELECT '001-1234567-8', 'Cédula', 'Carlos', 'Martínez Pérez', '1988-05-14', 'Masculino', 'Calle El Sol #45, Gazcue', '809-555-8811', 'carlos.martinez@email.com', a.id, 'SEN-998822', 'Hipertensión arterial controlada', 'Alergia a la penicilina', 'Padre con diabetes tipo 2'
FROM ars a WHERE a.codigo = 'SEN-01'
ON CONFLICT (identificacion) DO NOTHING;

INSERT INTO pacientes (identificacion, tipo_documento, nombre, apellido, fecha_nacimiento, genero, direccion, telefono, correo, ars_id, numero_afiliado, antecedentes_personales, antecedentes_alergicos, antecedentes_familiares)
SELECT '001-9876543-2', 'Cédula', 'María Elena', 'Gómez Rosario', '1995-11-20', 'Femenino', 'Av. Independencia #88, Mirador Sur', '829-555-3344', 'maria.gomez@email.com', a.id, 'PRIM-112233', 'Sin antecedentes patológicos relevantes', 'Ninguna conocida', 'Madre hipertensa'
FROM ars a WHERE a.codigo = 'PRIM-02'
ON CONFLICT (identificacion) DO NOTHING;

INSERT INTO pacientes (identificacion, tipo_documento, nombre, apellido, fecha_nacimiento, genero, direccion, telefono, correo, ars_id, numero_afiliado, antecedentes_personales, antecedentes_alergicos, antecedentes_familiares)
SELECT '402-3344556-7', 'Cédula', 'Juan Alberto', 'Peña Díaz', '1976-03-08', 'Masculino', 'Calle Restauración #12, Zona Colonial', '849-555-7766', 'juan.pena@email.com', a.id, NULL, 'Gastritis crónica', 'Ninguna conocida', 'Sin antecedentes conocidos'
FROM ars a WHERE a.codigo = 'PRIV'
ON CONFLICT (identificacion) DO NOTHING;

-- 6. CITAS INICIALES
INSERT INTO citas (paciente_id, servicio_id, fecha, hora, canal_solicitud, telefono_contacto, correo_contacto, motivo, estado, fecha_llegada, medico_notificado)
SELECT p.id, s.id, CURRENT_DATE, '09:00:00', 'Teléfono', p.telefono, p.correo, 'Cefalea persistente y control de presión', 'Atendida', CURRENT_TIMESTAMP - INTERVAL '45 minutes', true
FROM pacientes p, servicios s
WHERE p.identificacion = '001-1234567-8' AND s.codigo = 'MED-GEN'
ON CONFLICT (paciente_id, fecha, hora) DO NOTHING;

INSERT INTO citas (paciente_id, servicio_id, fecha, hora, canal_solicitud, telefono_contacto, correo_contacto, motivo, estado)
SELECT p.id, s.id, CURRENT_DATE, '11:00:00', 'Mensajería', p.telefono, p.correo, 'Chequeo general preventivo y rutina', 'Programada'
FROM pacientes p, servicios s
WHERE p.identificacion = '001-9876543-2' AND s.codigo = 'MED-GEN'
ON CONFLICT (paciente_id, fecha, hora) DO NOTHING;

INSERT INTO citas (paciente_id, servicio_id, fecha, hora, canal_solicitud, telefono_contacto, correo_contacto, motivo, estado)
SELECT p.id, s.id, CURRENT_DATE + INTERVAL '1 day', '10:00:00', 'Presencial', p.telefono, p.correo, 'Evaluación de dolor epigástrico', 'Programada'
FROM pacientes p, servicios s
WHERE p.identificacion = '402-3344556-7' AND s.codigo = 'MED-GEN'
ON CONFLICT (paciente_id, fecha, hora) DO NOTHING;

-- 7. CONSULTA Y RECETA INICIALES (Para el paciente Carlos Martínez)
INSERT INTO consultas (
    cita_id, paciente_id, servicio_id, medico_id, fecha_consulta, motivo_consulta,
    antecedentes_revisados, signos_vitales, hallazgos_clinicos,
    diagnostico_clinico, tratamiento_plan, notas_adicionales,
    ars_id, valor_total, valor_cubierto_ars, diferencia_paciente, estado_pago
)
SELECT
    c.id, p.id, s.id, (SELECT id FROM usuarios WHERE usuario = 'medico'), CURRENT_TIMESTAMP - INTERVAL '30 minutes',
    'Cefalea persistente y control de presión arterial',
    'Hipertensión arterial en tratamiento con Losartán. Alergia a la penicilina.',
    '{"presion_arterial":"135/85 mmHg","temperatura":"36.6 °C","frecuencia_cardiaca":"76 lpm","frecuencia_respiratoria":"16 rpm","peso":"78 kg","talla":"174 cm"}'::jsonb,
    'Paciente consciente, orientado, hidratado. Ruidos cardíacos rítmicos sin soplos. Examen neurológico sin focalidad.',
    'Cefalea tensional asociada a hipertensión arterial esencial en control',
    'Continuar Losartán 50 mg cada 24 horas, Paracetamol 500 mg condicional al dolor y control de presión por 7 días.',
    'Control en 15 días con bitácora de presión arterial.',
    p.ars_id, 1500.00, 1200.00, 300.00, 'Pagado'
FROM citas c
JOIN pacientes p ON c.paciente_id = p.id
JOIN servicios s ON c.servicio_id = s.id
WHERE p.identificacion = '001-1234567-8' AND c.hora = '09:00:00'
ON CONFLICT (cita_id) WHERE cita_id IS NOT NULL DO NOTHING;

INSERT INTO recetas (consulta_id, paciente_id, codigo_receta, indicaciones_generales)
SELECT con.id, p.id, 'REC-2026-0001', 'Reducir consumo de sodio, mantener buena hidratación y acudir por urgencias si presenta signos de alarma.'
FROM consultas con
JOIN pacientes p ON con.paciente_id = p.id
WHERE p.identificacion = '001-1234567-8'
ORDER BY con.id ASC LIMIT 1
ON CONFLICT (codigo_receta) DO NOTHING;

INSERT INTO receta_detalles (
    receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia,
    indicaciones_uso, cantidad_recetada, estado_dispensacion
)
SELECT r.id, m.id, 'Losartán Potásico 50 mg', '50 mg (1 tableta)', 'Cada 24 horas por 30 días', 'Tomar en las mañanas con agua', 30, 'Pendiente'
FROM recetas r
JOIN medicamentos m ON m.codigo = 'MED-006'
WHERE r.codigo_receta = 'REC-2026-0001'
  AND NOT EXISTS (SELECT 1 FROM receta_detalles rd WHERE rd.receta_id = r.id);


