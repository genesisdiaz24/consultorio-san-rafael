

-- 0. TABLA DE USUARIOS Y CONTROL DE ACCESO BASADO EN ROLES (RBAC)
CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    usuario VARCHAR(50) NOT NULL UNIQUE,
    correo VARCHAR(100) UNIQUE,
    contrasena VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL DEFAULT '',
    rol VARCHAR(30) NOT NULL CHECK (rol IN ('ADMINISTRADOR', 'MEDICO', 'SECRETARIA', 'FARMACIA', 'RECEPCION')),
    activo BOOLEAN DEFAULT true,
    token_version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 1. TABLA DE ARS (Aseguradoras de Riesgos de Salud)
CREATE TABLE IF NOT EXISTS ars (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL UNIQUE,
    codigo VARCHAR(30) UNIQUE,
    telefono VARCHAR(30),
    correo VARCHAR(100),
    contacto_nombre VARCHAR(100),
    activo BOOLEAN DEFAULT true,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. TABLA DE SERVICIOS MÉDICOS
CREATE TABLE IF NOT EXISTS servicios (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(30) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    descripcion TEXT,
    precio_base NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (precio_base >= 0),
    indicador_facturacion VARCHAR(5) NOT NULL DEFAULT '4' CHECK (indicador_facturacion IN ('1', '2', '3', '4')),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE servicios ADD COLUMN IF NOT EXISTS indicador_facturacion VARCHAR(5) NOT NULL DEFAULT '4';

-- 3. TABLA DE TARIFARIOS POR ARS Y SERVICIO
-- Permite configurar tarifas pactadas, tipos de cobertura y copagos
CREATE TABLE IF NOT EXISTS ars_tarifarios (
    id SERIAL PRIMARY KEY,
    ars_id INTEGER NOT NULL REFERENCES ars(id) ON DELETE CASCADE,
    servicio_id INTEGER NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
    tarifa_pactada NUMERIC(10, 2) NOT NULL CHECK (tarifa_pactada >= 0),
    tipo_cobertura VARCHAR(20) NOT NULL DEFAULT 'PORCENTAJE' CHECK (tipo_cobertura IN ('PORCENTAJE', 'MONTO_FIJO')),
    valor_cobertura NUMERIC(10, 2) NOT NULL CHECK (valor_cobertura >= 0),
    copago_fijo NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (copago_fijo >= 0),
    notas TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ars_servicio UNIQUE (ars_id, servicio_id)
);

-- 4. TABLA DE PACIENTES
-- Evita registros duplicados mediante restricción UNIQUE en 'identificacion'
CREATE TABLE IF NOT EXISTS pacientes (
    id SERIAL PRIMARY KEY,
    identificacion VARCHAR(50) NOT NULL UNIQUE,
    tipo_documento VARCHAR(20) DEFAULT 'Cédula',
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL,
    fecha_nacimiento DATE NOT NULL,
    genero VARCHAR(20) NOT NULL CHECK (genero IN ('Masculino', 'Femenino', 'Otro')),
    direccion TEXT,
    telefono VARCHAR(30) NOT NULL,
    correo VARCHAR(100),
    ars_id INTEGER REFERENCES ars(id) ON DELETE SET NULL,
    numero_afiliado VARCHAR(60),
    antecedentes_personales TEXT,
    antecedentes_alergicos TEXT,
    antecedentes_familiares TEXT,
    tipo_sangre VARCHAR(5) CONSTRAINT chk_pacientes_tipo_sangre
        CHECK (tipo_sangre IS NULL OR tipo_sangre IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
    medicamentos_actuales TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. TABLA DE CITAS
CREATE TABLE IF NOT EXISTS citas (
    id SERIAL PRIMARY KEY,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    servicio_id INTEGER REFERENCES servicios(id) ON DELETE SET NULL,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    canal_solicitud VARCHAR(30) NOT NULL CHECK (canal_solicitud IN ('Teléfono', 'Mensajería', 'Presencial')),
    telefono_contacto VARCHAR(30) NOT NULL,
    correo_contacto VARCHAR(100),
    motivo TEXT, -- opcional: la secretaria no registra información clínica; el motivo lo anota el médico en la consulta
    estado VARCHAR(30) NOT NULL DEFAULT 'Programada' CHECK (estado IN ('Programada', 'Confirmada', 'En sala de espera', 'Atendida', 'Cancelada')),
    fecha_llegada TIMESTAMP,
    atencion_iniciada_en TIMESTAMP, -- el médico abrió la atención ("En consulta" en su Agenda de Hoy)
    medico_notificado BOOLEAN DEFAULT false,
    notas_recepcion TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_cita_paciente_fecha_hora UNIQUE (paciente_id, fecha, hora)
);

-- 6. TABLA DE MEDICAMENTOS (Inventario Farmacia Interna)
CREATE TABLE IF NOT EXISTS medicamentos (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    principio_activo VARCHAR(150),
    presentacion VARCHAR(80) NOT NULL,
    concentracion VARCHAR(80),
    stock_actual INTEGER NOT NULL DEFAULT 0 CHECK (stock_actual >= 0),
    stock_minimo INTEGER NOT NULL DEFAULT 5 CHECK (stock_minimo >= 0),
    ubicacion VARCHAR(100),
    lote VARCHAR(50),
    fecha_vencimiento DATE,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. TABLA DE CONSULTAS MÉDICAS E HISTORIAL CLÍNICO
CREATE TABLE IF NOT EXISTS consultas (
    id SERIAL PRIMARY KEY,
    cita_id INTEGER REFERENCES citas(id) ON DELETE SET NULL,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    servicio_id INTEGER REFERENCES servicios(id) ON DELETE SET NULL,
    -- Médico que atendió (usuario con rol MEDICO; lo valida el trigger trg_validar_medico_consulta de migraciones.js)
    medico_id INTEGER CONSTRAINT fk_consultas_medico REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha_consulta TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    motivo_consulta TEXT NOT NULL,
    antecedentes_revisados TEXT,
    signos_vitales JSONB DEFAULT '{}'::jsonb,
    hallazgos_clinicos TEXT NOT NULL,
    diagnostico_clinico TEXT NOT NULL,
    tratamiento_plan TEXT NOT NULL,
    notas_adicionales TEXT,
    -- Desglose económico y ARS
    ars_id INTEGER REFERENCES ars(id) ON DELETE SET NULL,
    valor_total NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (valor_total >= 0),
    valor_cubierto_ars NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (valor_cubierto_ars >= 0),
    diferencia_paciente NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (diferencia_paciente >= 0),
    estado_pago VARCHAR(20) DEFAULT 'Pendiente' CHECK (estado_pago IN ('Pendiente', 'Pagado', 'Exonerado')),
    metodo_pago VARCHAR(40) CONSTRAINT chk_consultas_metodo_pago
        CHECK (metodo_pago IS NULL OR metodo_pago IN ('Efectivo', 'Tarjeta de Débito / Crédito', 'Transferencia Bancaria', 'PayPal')),
    fecha_pago TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Facturado = Cubierto por la ARS + Paciente (el copago fijo va incluido en lo del paciente)
    CONSTRAINT chk_consultas_cuadre CHECK (valor_total = valor_cubierto_ars + diferencia_paciente)
);

-- 8. TABLA DE RECETAS MÉDICAS
CREATE TABLE IF NOT EXISTS recetas (
    id SERIAL PRIMARY KEY,
    consulta_id INTEGER NOT NULL REFERENCES consultas(id) ON DELETE CASCADE,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    codigo_receta VARCHAR(40) NOT NULL UNIQUE,
    fecha_emision TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    indicaciones_generales TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. TABLA DE DETALLES DE RECETAS (Fármacos prescritos)
CREATE TABLE IF NOT EXISTS receta_detalles (
    id SERIAL PRIMARY KEY,
    receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
    medicamento_id INTEGER REFERENCES medicamentos(id) ON DELETE SET NULL,
    nombre_medicamento VARCHAR(150) NOT NULL,
    dosis VARCHAR(100) NOT NULL,
    frecuencia VARCHAR(100) NOT NULL,
    indicaciones_uso TEXT NOT NULL,
    cantidad_recetada INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_recetada > 0),
    estado_dispensacion VARCHAR(40) DEFAULT 'Pendiente' CHECK (estado_dispensacion IN ('Pendiente', 'Entregado', 'No entregado', 'No entregado - Sin existencias')),
    fecha_dispensacion TIMESTAMP,
    observacion_farmacia TEXT,
    cubierto_ars BOOLEAN DEFAULT true,
    cobertura_utilizada BOOLEAN DEFAULT false,
    motivo_no_entrega TEXT
);

-- 10. TABLA DE MOVIMIENTOS Y DISPENSACIÓN EN FARMACIA
CREATE TABLE IF NOT EXISTS farmacia_movimientos (
    id SERIAL PRIMARY KEY,
    receta_detalle_id INTEGER REFERENCES receta_detalles(id) ON DELETE SET NULL,
    medicamento_id INTEGER REFERENCES medicamentos(id) ON DELETE SET NULL,
    tipo_movimiento VARCHAR(35) NOT NULL CHECK (tipo_movimiento IN ('SALIDA_RECETA', 'ENTRADA_STOCK', 'NO_ENTREGADO_SIN_STOCK', 'NO_ENTREGADO', 'AJUSTE')),
    cantidad INTEGER NOT NULL,
    stock_anterior INTEGER,
    stock_nuevo INTEGER,
    motivo TEXT,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. TABLA DE TOKENS DE RECUPERACIÓN DE CONTRASEÑA
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL,
    expira_en TIMESTAMP NOT NULL,
    usado BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. TABLA DE COMPROBANTES FISCALES ELECTRÓNICOS (e-CF IMECF / DGII)
CREATE TABLE IF NOT EXISTS comprobantes_electronicos (
    id SERIAL PRIMARY KEY,
    consulta_id INTEGER NOT NULL REFERENCES consultas(id) ON DELETE CASCADE,
    ecf_id_externo VARCHAR(100),
    encf VARCHAR(30),
    tipo_ecf VARCHAR(10) NOT NULL CHECK (tipo_ecf IN ('E31', 'E32')),
    estado VARCHAR(60) NOT NULL DEFAULT 'EN_PROCESO_ENVIO',
    track_id VARCHAR(120),
    codigo_seguridad VARCHAR(60),
    dgii_url TEXT,
    xml_url TEXT,
    ambiente VARCHAR(40) DEFAULT 'TesteCF',
    modo_simulacion BOOLEAN NOT NULL DEFAULT false,
    indicador_facturacion VARCHAR(5) NOT NULL DEFAULT '4' CHECK (indicador_facturacion IN ('1', '2', '3', '4')),
    criterio_monto VARCHAR(30) NOT NULL DEFAULT 'TOTAL' CHECK (criterio_monto IN ('TOTAL', 'COPAGO', 'PERSONALIZADO')),
    tipo_pago VARCHAR(5) NOT NULL DEFAULT '1',
    forma_pago INTEGER NOT NULL DEFAULT 1,
    rnc_comprador VARCHAR(20),
    razon_social_comprador VARCHAR(150),
    correo_comprador VARCHAR(120),
    monto_gravado_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    monto_exento NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_itbis NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    monto_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    secuencia_utilizada BOOLEAN DEFAULT false,
    enviado_dgii BOOLEAN DEFAULT false,
    mensaje_error TEXT,
    request_payload JSONB DEFAULT '{}'::jsonb,
    response_payload JSONB DEFAULT '{}'::jsonb,
    xml_firmado TEXT,
    dgii_codigo_estado VARCHAR(20),
    dgii_mensajes JSONB DEFAULT '[]'::jsonb,
    fecha_recepcion_dgii VARCHAR(60),
    proveedor_modo VARCHAR(30) DEFAULT 'dgii',
    correo_enviado BOOLEAN NOT NULL DEFAULT false,
    correo_enviado_a VARCHAR(150),
    correo_enviado_fecha TIMESTAMP,
    correo_envio_metodo VARCHAR(40),
    correo_envio_error TEXT,
    bloqueado_envio BOOLEAN NOT NULL DEFAULT false,
    bloqueado_desde TIMESTAMP,
    emitido_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    fecha_emision TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 13. TABLA DE PAGOS CON PAYPAL (ÓRDENES Y CAPTURAS VERIFICADAS DESDE BACKEND)
CREATE TABLE IF NOT EXISTS pagos_paypal (
    id SERIAL PRIMARY KEY,
    consulta_id INTEGER NOT NULL REFERENCES consultas(id) ON DELETE CASCADE,
    referencia_interna VARCHAR(80) NOT NULL,
    paypal_order_id VARCHAR(100) NOT NULL UNIQUE,
    paypal_capture_id VARCHAR(100) UNIQUE,
    criterio_cobro VARCHAR(30) NOT NULL DEFAULT 'COPAGO' CHECK (criterio_cobro IN ('COPAGO', 'TOTAL')),
    monto_dop NUMERIC(12, 2) NOT NULL CHECK (monto_dop > 0),
    tasa_cambio NUMERIC(10, 4) NOT NULL DEFAULT 60.0000 CHECK (tasa_cambio > 0),
    importe NUMERIC(12, 2) NOT NULL CHECK (importe > 0),
    moneda VARCHAR(10) NOT NULL DEFAULT 'USD',
    estado VARCHAR(40) NOT NULL DEFAULT 'CREATED' CHECK (estado IN ('CREATED', 'APPROVED', 'COMPLETED', 'PENDING', 'CANCELLED', 'DECLINED', 'FAILED')),
    payer_email VARCHAR(150),
    payer_id VARCHAR(100),
    ambiente VARCHAR(20) NOT NULL DEFAULT 'sandbox',
    modo_simulacion BOOLEAN NOT NULL DEFAULT false,
    auto_emitir_ecf BOOLEAN NOT NULL DEFAULT false,
    ecf_intento_error TEXT,
    mensaje_estado TEXT,
    raw_order_response JSONB DEFAULT '{}'::jsonb,
    raw_capture_response JSONB DEFAULT '{}'::jsonb,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    fecha_pago TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 14. TABLA DE EVENTOS WEBHOOK DE PAYPAL (IDEMPOTENCIA Y AUDITORÍA DE FIRMAS)
CREATE TABLE IF NOT EXISTS paypal_webhook_eventos (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(120) NOT NULL UNIQUE,
    event_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(120),
    paypal_order_id VARCHAR(100),
    paypal_capture_id VARCHAR(100),
    verification_status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ÍNDICES PARA BÚSQUEDA RÁPIDA Y RENDIMIENTO
CREATE INDEX IF NOT EXISTS idx_pacientes_identificacion ON pacientes(identificacion);
CREATE INDEX IF NOT EXISTS idx_pacientes_nombre ON pacientes(nombre, apellido);
CREATE INDEX IF NOT EXISTS idx_citas_fecha_hora ON citas(fecha, hora);
CREATE INDEX IF NOT EXISTS idx_citas_estado ON citas(estado);
CREATE INDEX IF NOT EXISTS idx_consultas_paciente ON consultas(paciente_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consultas_cita_id ON consultas(cita_id) WHERE cita_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recetas_consulta ON recetas(consulta_id);
CREATE INDEX IF NOT EXISTS idx_medicamentos_stock ON medicamentos(stock_actual);
CREATE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_usuario ON password_reset_tokens(usuario_id);
CREATE INDEX IF NOT EXISTS idx_ecf_consulta ON comprobantes_electronicos(consulta_id);
CREATE INDEX IF NOT EXISTS idx_ecf_externo ON comprobantes_electronicos(ecf_id_externo);
CREATE INDEX IF NOT EXISTS idx_ecf_encf ON comprobantes_electronicos(encf);
-- Índice único parcial para impedir emisiones duplicadas activas/aceptadas/inciertas sobre la misma factura (consulta)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecf_consulta_activo
ON comprobantes_electronicos(consulta_id)
WHERE estado NOT IN ('Rechazado', 'ERROR_ENVIO', 'ERROR_VALIDACION', 'ERROR_CONFIGURACION', 'ERROR_AUTENTICACION', 'ANULADO');
CREATE INDEX IF NOT EXISTS idx_pagos_paypal_consulta ON pagos_paypal(consulta_id);
CREATE INDEX IF NOT EXISTS idx_pagos_paypal_order ON pagos_paypal(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_pagos_paypal_capture ON pagos_paypal(paypal_capture_id);
-- Índice único parcial para garantizar que una factura nunca tenga dos pagos PayPal completados (evita cobros duplicados)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagos_paypal_consulta_completado
ON pagos_paypal(consulta_id)
WHERE estado = 'COMPLETED';
CREATE INDEX IF NOT EXISTS idx_paypal_webhook_event_id ON paypal_webhook_eventos(event_id);

