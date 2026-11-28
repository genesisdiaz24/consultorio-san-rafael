/**
 * Catálogo de Reportes del Consultorio Médico San Rafael
 *
 * 6 módulos x 6 reportes = 36 reportes. Cada reporte declara:
 *  - id, modulo, titulo, descripcion, icono
 *  - filtros: [{ nombre, etiqueta, tipo: 'fecha'|'numero'|'select', opciones|fuente, defecto }]
 *  - columnas: [{ clave, etiqueta, tipo: 'texto'|'numero'|'moneda'|'fecha'|'fechahora'|'porcentaje'|'estado', total: 'suma'|'promedio' }]
 *  - grafico (opcional): { etiqueta: <clave>, valor: <clave> } → barras horizontales
 *  - consulta(f): devuelve { sql, params } usando solo parámetros posicionales (sin concatenar valores)
 */

// Constructor de condiciones WHERE con parámetros posicionales ($1, $2...).
// Cada "?" de la expresión se reemplaza por el número del parámetro; los valores vacíos se ignoran.
class Condiciones {
  constructor() {
    this.lista = [];
    this.params = [];
  }

  agregar(expresion, valor) {
    if (valor === undefined || valor === null || valor === '') return this;
    this.params.push(valor);
    this.lista.push(expresion.replace(/\?/g, `$${this.params.length}`));
    return this;
  }

  fijo(expresion) {
    this.lista.push(expresion);
    return this;
  }

  // Filtro de rango de fechas inclusivo (sirve para columnas DATE y TIMESTAMP)
  rango(columna, f) {
    this.agregar(`${columna} >= ?::date`, f.desde);
    this.agregar(`${columna} < (?::date + 1)`, f.hasta);
    return this;
  }

  where(prefijo = 'WHERE') {
    return this.lista.length ? ` ${prefijo} ${this.lista.join(' AND ')} ` : ' ';
  }
}

// Zona horaria del consultorio. Cloud SQL guarda CURRENT_TIMESTAMP en UTC: todo timestamp se
// convierte a hora de República Dominicana antes de mostrarlo, agruparlo por día o filtrarlo.
const L = (col) => `((${col})::timestamptz AT TIME ZONE 'America/Santo_Domingo')`;
const HOY = `(NOW() AT TIME ZONE 'America/Santo_Domingo')::date`;
const MES_HOY = `DATE_TRUNC('month', ${HOY})`;

// Fecha (YYYY-MM-DD) de hace N días en hora de RD; se usa como valor por defecto de filtros
function haceDias(n) {
  const hoyRd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' });
  const d = new Date(`${hoyRd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const RANGO_FECHAS = [
  { nombre: 'desde', etiqueta: 'Desde', tipo: 'fecha' },
  { nombre: 'hasta', etiqueta: 'Hasta', tipo: 'fecha' },
];
const FILTRO_ARS = { nombre: 'ars_id', etiqueta: 'ARS', tipo: 'select', fuente: 'ars' };
const NOMBRE_PACIENTE = `p.nombre || ' ' || p.apellido`;
// Médico de la consulta (usuarios u), sin la etiqueta "(Médico)" del nombre de usuario
const NOMBRE_MEDICO = `COALESCE(REGEXP_REPLACE(u.nombre, '\\s*\\([^)]*\\)\\s*$', ''), 'Sin asignar')`;
const EDAD = `EXTRACT(YEAR FROM AGE(p.fecha_nacimiento))::int`;

const MODULOS = [
  { id: 'pacientes', nombre: 'Pacientes', icono: 'bi-people', color: 'primary', roles: ['SECRETARIA', 'RECEPCION', 'MEDICO'] },
  { id: 'citas', nombre: 'Citas y Sala de Espera', icono: 'bi-calendar2-check', color: 'info', roles: ['SECRETARIA', 'RECEPCION', 'MEDICO'] },
  { id: 'consultas', nombre: 'Consultas y Recetas', icono: 'bi-clipboard2-pulse', color: 'success', roles: ['MEDICO'] },
  { id: 'farmacia', nombre: 'Farmacia e Inventario', icono: 'bi-capsule', color: 'warning', roles: ['FARMACIA'] },
  { id: 'facturacion', nombre: 'ARS, Cobros y Facturación', icono: 'bi-cash-coin', color: 'teal', roles: ['SECRETARIA', 'RECEPCION'] },
  { id: 'administracion', nombre: 'Administración', icono: 'bi-person-gear', color: 'dark', roles: [] },
];

const REPORTES = [
  // =====================================================================
  // MÓDULO 1: PACIENTES
  // =====================================================================
  {
    id: 'pacientes-directorio',
    modulo: 'pacientes',
    titulo: 'Directorio general de pacientes',
    descripcion: 'Listado completo de pacientes con datos de contacto, edad y aseguradora.',
    icono: 'bi-person-lines-fill',
    filtros: [
      FILTRO_ARS,
      { nombre: 'genero', etiqueta: 'Género', tipo: 'select', opciones: ['Masculino', 'Femenino', 'Otro'] },
      { nombre: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: ['Activo', 'Inactivo'], defecto: 'Activo' },
    ],
    columnas: [
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'edad', etiqueta: 'Edad', tipo: 'numero' },
      { clave: 'genero', etiqueta: 'Género' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
      { clave: 'correo', etiqueta: 'Correo' },
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'numero_afiliado', etiqueta: 'No. Afiliado' },
      { clave: 'registrado', etiqueta: 'Registrado', tipo: 'fecha' },
    ],
    consulta(f) {
      const w = new Condiciones()
        .agregar('p.ars_id = ?', f.ars_id)
        .agregar('p.genero = ?', f.genero)
        .agregar('p.activo = ?', f.estado ? f.estado === 'Activo' : '');
      return {
        sql: `SELECT p.identificacion, ${NOMBRE_PACIENTE} AS paciente, ${EDAD} AS edad, p.genero, p.telefono, p.correo,
                     COALESCE(a.nombre, 'Sin ARS') AS ars, p.numero_afiliado, ${L('p.created_at')} AS registrado
              FROM pacientes p LEFT JOIN ars a ON a.id = p.ars_id
              ${w.where()} ORDER BY p.apellido, p.nombre`,
        params: w.params,
      };
    },
  },
  {
    id: 'pacientes-por-ars',
    modulo: 'pacientes',
    titulo: 'Pacientes por aseguradora (ARS)',
    descripcion: 'Cantidad de pacientes activos afiliados a cada ARS y su participación porcentual.',
    icono: 'bi-shield-check',
    filtros: [],
    columnas: [
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'pacientes', etiqueta: 'Pacientes', tipo: 'numero', total: 'suma' },
      { clave: 'porcentaje', etiqueta: '% del total', tipo: 'porcentaje' },
      { clave: 'edad_promedio', etiqueta: 'Edad promedio', tipo: 'numero' },
    ],
    grafico: { etiqueta: 'ars', valor: 'pacientes' },
    consulta() {
      return {
        sql: `SELECT COALESCE(a.nombre, 'Sin ARS') AS ars, COUNT(p.id)::int AS pacientes,
                     ROUND(100.0 * COUNT(p.id) / NULLIF(SUM(COUNT(p.id)) OVER (), 0), 1) AS porcentaje,
                     ROUND(AVG(${EDAD}), 1) AS edad_promedio
              FROM pacientes p LEFT JOIN ars a ON a.id = p.ars_id
              WHERE p.activo = true
              GROUP BY COALESCE(a.nombre, 'Sin ARS') ORDER BY pacientes DESC, ars`,
        params: [],
      };
    },
  },
  {
    id: 'pacientes-demografia',
    modulo: 'pacientes',
    titulo: 'Distribución por edad y género',
    descripcion: 'Pacientes activos agrupados por rango de edad, separados por género.',
    icono: 'bi-bar-chart',
    filtros: [],
    columnas: [
      { clave: 'rango_edad', etiqueta: 'Rango de edad' },
      { clave: 'masculino', etiqueta: 'Masculino', tipo: 'numero', total: 'suma' },
      { clave: 'femenino', etiqueta: 'Femenino', tipo: 'numero', total: 'suma' },
      { clave: 'otro', etiqueta: 'Otro', tipo: 'numero', total: 'suma' },
      { clave: 'total', etiqueta: 'Total', tipo: 'numero', total: 'suma' },
    ],
    grafico: { etiqueta: 'rango_edad', valor: 'total' },
    consulta() {
      return {
        sql: `WITH base AS (
                SELECT p.genero, ${EDAD} AS edad FROM pacientes p WHERE p.activo = true
              ), rangos AS (
                SELECT * FROM (VALUES (1, '0 - 17 años', 0, 17), (2, '18 - 29 años', 18, 29), (3, '30 - 44 años', 30, 44),
                                      (4, '45 - 59 años', 45, 59), (5, '60 años o más', 60, 200)) AS r(orden, rango_edad, minimo, maximo)
              )
              SELECT r.rango_edad,
                     COUNT(*) FILTER (WHERE b.genero = 'Masculino')::int AS masculino,
                     COUNT(*) FILTER (WHERE b.genero = 'Femenino')::int AS femenino,
                     COUNT(*) FILTER (WHERE b.genero = 'Otro')::int AS otro,
                     COUNT(b.edad)::int AS total
              FROM rangos r LEFT JOIN base b ON b.edad BETWEEN r.minimo AND r.maximo
              GROUP BY r.orden, r.rango_edad ORDER BY r.orden`,
        params: [],
      };
    },
  },
  {
    id: 'pacientes-nuevos',
    modulo: 'pacientes',
    titulo: 'Pacientes nuevos registrados',
    descripcion: 'Pacientes dados de alta en el sistema dentro del período seleccionado.',
    icono: 'bi-person-plus',
    filtros: [...RANGO_FECHAS, FILTRO_ARS],
    columnas: [
      { clave: 'registrado', etiqueta: 'Fecha de registro', tipo: 'fechahora' },
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'edad', etiqueta: 'Edad', tipo: 'numero' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
      { clave: 'ars', etiqueta: 'ARS' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('p.created_at'), f).agregar('p.ars_id = ?', f.ars_id);
      return {
        sql: `SELECT ${L('p.created_at')} AS registrado, p.identificacion, ${NOMBRE_PACIENTE} AS paciente, ${EDAD} AS edad,
                     p.telefono, COALESCE(a.nombre, 'Sin ARS') AS ars
              FROM pacientes p LEFT JOIN ars a ON a.id = p.ars_id
              ${w.where()} ORDER BY p.created_at DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'pacientes-alergias',
    modulo: 'pacientes',
    titulo: 'Pacientes con alergias registradas',
    descripcion: 'Pacientes que tienen antecedentes alérgicos anotados en su ficha (alerta clínica).',
    icono: 'bi-exclamation-triangle',
    // Información clínica: solo el médico (y el administrador), aunque el módulo lo vea también secretaría
    roles: ['MEDICO'],
    filtros: [],
    columnas: [
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'edad', etiqueta: 'Edad', tipo: 'numero' },
      { clave: 'alergias', etiqueta: 'Alergias' },
      { clave: 'antecedentes_personales', etiqueta: 'Antecedentes personales' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
    ],
    consulta() {
      return {
        sql: `SELECT p.identificacion, ${NOMBRE_PACIENTE} AS paciente, ${EDAD} AS edad,
                     p.antecedentes_alergicos AS alergias, p.antecedentes_personales, p.telefono
              FROM pacientes p
              WHERE p.activo = true
                AND NULLIF(TRIM(p.antecedentes_alergicos), '') IS NOT NULL
                -- Excluye textos que significan "sin alergias": Ninguna (conocida), Niega, No, N/A, Negadas, Sin alergias, Desconoce...
                AND LOWER(TRIM(p.antecedentes_alergicos)) !~ '^(ningun|niega|negad|no( |$|\\.|,|ref|tiene|conoc|presenta)|n/?a$|sin alerg|desconoc|-+$)'
              ORDER BY p.apellido, p.nombre`,
        params: [],
      };
    },
  },
  {
    id: 'pacientes-datos-incompletos',
    modulo: 'pacientes',
    titulo: 'Pacientes con datos incompletos',
    descripcion: 'Fichas a las que les falta correo, dirección, ARS o número de afiliado (para completarlas en recepción).',
    icono: 'bi-person-exclamation',
    filtros: [],
    columnas: [
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
      { clave: 'faltantes', etiqueta: 'Datos faltantes' },
      { clave: 'cantidad', etiqueta: 'Cantidad faltante', tipo: 'numero', total: 'suma' },
    ],
    consulta() {
      // ARS "privado/sin seguro" no necesita número de afiliado
      const sinAfiliado = `p.ars_id IS NOT NULL AND a.codigo <> 'PRIV' AND NULLIF(TRIM(p.numero_afiliado), '') IS NULL`;
      const faltas = [
        [`NULLIF(TRIM(p.correo), '') IS NULL`, 'Correo'],
        [`NULLIF(TRIM(p.direccion), '') IS NULL`, 'Dirección'],
        [`p.ars_id IS NULL`, 'ARS'],
        [sinAfiliado, 'No. de afiliado'],
      ];
      return {
        sql: `SELECT * FROM (
                SELECT p.identificacion, ${NOMBRE_PACIENTE} AS paciente, p.telefono, p.apellido, p.nombre,
                       CONCAT_WS(', ', ${faltas.map(([c, t]) => `CASE WHEN ${c} THEN '${t}' END`).join(', ')}) AS faltantes,
                       (${faltas.map(([c]) => `(CASE WHEN ${c} THEN 1 ELSE 0 END)`).join(' + ')}) AS cantidad
                FROM pacientes p LEFT JOIN ars a ON a.id = p.ars_id
                WHERE p.activo = true
              ) t WHERE t.cantidad > 0 ORDER BY t.cantidad DESC, t.apellido, t.nombre`,
        params: [],
      };
    },
  },
  {
    id: 'pacientes-sin-visita',
    modulo: 'pacientes',
    titulo: 'Pacientes sin visitas recientes',
    descripcion: 'Pacientes activos que no han tenido consulta en los últimos N días (para seguimiento o llamada).',
    icono: 'bi-telephone-outbound',
    filtros: [{ nombre: 'dias', etiqueta: 'Días sin visita', tipo: 'numero', defecto: '180' }],
    columnas: [
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'total_consultas', etiqueta: 'Consultas históricas', tipo: 'numero' },
      { clave: 'ultima_consulta', etiqueta: 'Última consulta', tipo: 'fecha' },
      { clave: 'dias_sin_visita', etiqueta: 'Tiempo sin visita' },
    ],
    consulta(f) {
      const dias = parseInt(f.dias, 10) || 180;
      return {
        sql: `SELECT ${NOMBRE_PACIENTE} AS paciente, p.identificacion, p.telefono, COALESCE(a.nombre, 'Sin ARS') AS ars,
                     COUNT(c.id)::int AS total_consultas, MAX(${L('c.fecha_consulta')}) AS ultima_consulta,
                     CASE WHEN COUNT(c.id) = 0 THEN 'Nunca ha consultado'
                          ELSE (${HOY} - MAX(${L('c.fecha_consulta')})::date) || ' días' END AS dias_sin_visita
              FROM pacientes p
              LEFT JOIN ars a ON a.id = p.ars_id
              LEFT JOIN consultas c ON c.paciente_id = p.id
              WHERE p.activo = true
              GROUP BY p.id, a.nombre
              HAVING COUNT(c.id) = 0 OR MAX(${L('c.fecha_consulta')})::date < ${HOY} - $1::int
              ORDER BY MAX(c.fecha_consulta) ASC NULLS FIRST, p.apellido`,
        params: [dias],
      };
    },
  },

  // =====================================================================
  // MÓDULO 2: CITAS Y SALA DE ESPERA
  // =====================================================================
  {
    id: 'citas-agenda',
    modulo: 'citas',
    titulo: 'Agenda de citas por período',
    descripcion: 'Todas las citas programadas en un rango de fechas, con su estado y canal de solicitud.',
    icono: 'bi-calendar-week',
    filtros: [
      ...RANGO_FECHAS,
      { nombre: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: ['Programada', 'Confirmada', 'En sala de espera', 'Atendida', 'Cancelada'] },
    ],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
      { clave: 'hora', etiqueta: 'Hora' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'telefono_contacto', etiqueta: 'Teléfono' },
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'canal_solicitud', etiqueta: 'Canal' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
    ],
    consulta(f) {
      const w = new Condiciones().rango('c.fecha', f).agregar('c.estado = ?', f.estado);
      return {
        sql: `SELECT c.fecha, TO_CHAR(c.hora, 'HH12:MI AM') AS hora, ${NOMBRE_PACIENTE} AS paciente, c.telefono_contacto,
                     COALESCE(s.nombre, '—') AS servicio, c.canal_solicitud, c.estado
              FROM citas c
              INNER JOIN pacientes p ON p.id = c.paciente_id
              LEFT JOIN servicios s ON s.id = c.servicio_id
              ${w.where()} ORDER BY c.fecha DESC, c.hora`,
        params: w.params,
      };
    },
  },
  {
    id: 'citas-por-estado',
    modulo: 'citas',
    titulo: 'Citas por estado',
    descripcion: 'Resumen de cuántas citas están programadas, confirmadas, atendidas o canceladas.',
    icono: 'bi-pie-chart',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      { clave: 'citas', etiqueta: 'Citas', tipo: 'numero', total: 'suma' },
      { clave: 'porcentaje', etiqueta: '% del total', tipo: 'porcentaje' },
    ],
    grafico: { etiqueta: 'estado', valor: 'citas' },
    consulta(f) {
      const w = new Condiciones().rango('c.fecha', f);
      // Se listan siempre los 5 estados (con 0 si no hay citas), en el orden del flujo de atención
      return {
        sql: `SELECT e.estado, COUNT(c.id)::int AS citas,
                     COALESCE(ROUND(100.0 * COUNT(c.id) / NULLIF(SUM(COUNT(c.id)) OVER (), 0), 1), 0) AS porcentaje
              FROM (VALUES (1, 'Programada'), (2, 'Confirmada'), (3, 'En sala de espera'), (4, 'Atendida'), (5, 'Cancelada')) AS e(orden, estado)
              LEFT JOIN (SELECT c.id, c.estado FROM citas c ${w.where()}) c ON c.estado = e.estado
              GROUP BY e.orden, e.estado ORDER BY e.orden`,
        params: w.params,
      };
    },
  },
  {
    id: 'citas-canceladas',
    modulo: 'citas',
    titulo: 'Citas canceladas',
    descripcion: 'Detalle de las citas canceladas: paciente, contacto, servicio, canal y cuándo se solicitó (para reprogramar).',
    icono: 'bi-calendar-x',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha cita', tipo: 'fecha' },
      { clave: 'hora', etiqueta: 'Hora' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'telefono_contacto', etiqueta: 'Teléfono' },
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'canal_solicitud', etiqueta: 'Canal' },
      { clave: 'solicitada', etiqueta: 'Solicitada el', tipo: 'fechahora' },
    ],
    consulta(f) {
      const w = new Condiciones().fijo(`c.estado = 'Cancelada'`).rango('c.fecha', f);
      return {
        sql: `SELECT c.fecha, TO_CHAR(c.hora, 'HH12:MI AM') AS hora, ${NOMBRE_PACIENTE} AS paciente, c.telefono_contacto,
                     COALESCE(s.nombre, '—') AS servicio, c.canal_solicitud, ${L('c.created_at')} AS solicitada
              FROM citas c INNER JOIN pacientes p ON p.id = c.paciente_id
              LEFT JOIN servicios s ON s.id = c.servicio_id
              ${w.where()} ORDER BY c.fecha DESC, c.hora`,
        params: w.params,
      };
    },
  },
  {
    id: 'citas-por-canal',
    modulo: 'citas',
    titulo: 'Citas por canal de solicitud',
    descripcion: 'Teléfono, mensajería o presencial: volumen de citas y tasa de asistencia por canal.',
    icono: 'bi-telephone',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'canal_solicitud', etiqueta: 'Canal' },
      { clave: 'total', etiqueta: 'Citas', tipo: 'numero', total: 'suma' },
      { clave: 'atendidas', etiqueta: 'Atendidas', tipo: 'numero', total: 'suma' },
      { clave: 'canceladas', etiqueta: 'Canceladas', tipo: 'numero', total: 'suma' },
      { clave: 'tasa_asistencia', etiqueta: 'Tasa de asistencia', tipo: 'porcentaje' },
    ],
    grafico: { etiqueta: 'canal_solicitud', valor: 'total' },
    consulta(f) {
      const w = new Condiciones().rango('c.fecha', f);
      return {
        sql: `SELECT c.canal_solicitud, COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE c.estado = 'Atendida')::int AS atendidas,
                     COUNT(*) FILTER (WHERE c.estado = 'Cancelada')::int AS canceladas,
                     ROUND(100.0 * COUNT(*) FILTER (WHERE c.estado = 'Atendida') / NULLIF(COUNT(*), 0), 1) AS tasa_asistencia
              FROM citas c ${w.where()}
              GROUP BY c.canal_solicitud ORDER BY total DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'citas-tiempo-espera',
    modulo: 'citas',
    titulo: 'Puntualidad y tiempo en sala de espera',
    descripcion: 'Minutos que llegó antes/después cada paciente y cuánto esperó en sala hasta ser atendido.',
    icono: 'bi-hourglass-split',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
      { clave: 'hora_cita', etiqueta: 'Hora cita' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'llegada', etiqueta: 'Llegada', tipo: 'fechahora' },
      { clave: 'min_retraso', etiqueta: 'Min. de retraso (+) / adelanto (−)', tipo: 'numero', total: 'promedio' },
      { clave: 'atencion', etiqueta: 'Inicio de consulta', tipo: 'fechahora' },
      { clave: 'min_espera', etiqueta: 'Min. en sala', tipo: 'numero', total: 'promedio' },
    ],
    consulta(f) {
      const w = new Condiciones().fijo('c.fecha_llegada IS NOT NULL').rango('c.fecha', f);
      return {
        sql: `SELECT c.fecha, TO_CHAR(c.hora, 'HH12:MI AM') AS hora_cita, ${NOMBRE_PACIENTE} AS paciente,
                     ${L('c.fecha_llegada')} AS llegada,
                     ROUND(EXTRACT(EPOCH FROM (${L('c.fecha_llegada')} - (c.fecha + c.hora))) / 60)::int AS min_retraso,
                     ${L('co.fecha_consulta')} AS atencion,
                     CASE WHEN co.fecha_consulta IS NOT NULL
                          THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (co.fecha_consulta - c.fecha_llegada)) / 60))::int END AS min_espera
              FROM citas c
              INNER JOIN pacientes p ON p.id = c.paciente_id
              LEFT JOIN consultas co ON co.cita_id = c.id
              ${w.where()} ORDER BY c.fecha DESC, c.hora`,
        params: w.params,
      };
    },
  },
  {
    id: 'citas-demanda-dia',
    modulo: 'citas',
    titulo: 'Demanda por día de la semana',
    descripcion: 'Citas por día de la semana divididas en mañana y tarde, para planificar horarios.',
    icono: 'bi-calendar3-week',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'dia', etiqueta: 'Día' },
      { clave: 'manana', etiqueta: 'Mañana (antes 12 PM)', tipo: 'numero', total: 'suma' },
      { clave: 'tarde', etiqueta: 'Tarde (12 PM en adelante)', tipo: 'numero', total: 'suma' },
      { clave: 'total', etiqueta: 'Total', tipo: 'numero', total: 'suma' },
      { clave: 'canceladas', etiqueta: 'Canceladas', tipo: 'numero', total: 'suma' },
    ],
    grafico: { etiqueta: 'dia', valor: 'total' },
    consulta(f) {
      const w = new Condiciones().rango('c.fecha', f);
      // Se listan siempre los 7 días de lunes a domingo (con 0 si no hay citas)
      return {
        sql: `SELECT d.dia,
                     COUNT(c.id) FILTER (WHERE c.hora < '12:00')::int AS manana,
                     COUNT(c.id) FILTER (WHERE c.hora >= '12:00')::int AS tarde,
                     COUNT(c.id)::int AS total,
                     COUNT(c.id) FILTER (WHERE c.estado = 'Cancelada')::int AS canceladas
              FROM (VALUES (1, 'Lunes'), (2, 'Martes'), (3, 'Miércoles'), (4, 'Jueves'), (5, 'Viernes'), (6, 'Sábado'), (7, 'Domingo')) AS d(n, dia)
              LEFT JOIN (SELECT c.id, c.hora, c.estado, EXTRACT(ISODOW FROM c.fecha)::int AS n FROM citas c ${w.where()}) c ON c.n = d.n
              GROUP BY d.n, d.dia ORDER BY d.n`,
        params: w.params,
      };
    },
  },

  // =====================================================================
  // MÓDULO 3: CONSULTAS MÉDICAS Y RECETAS
  // =====================================================================
  {
    id: 'consultas-periodo',
    modulo: 'consultas',
    titulo: 'Consultas realizadas por período',
    descripcion: 'Consultas atendidas con motivo, diagnóstico, servicio y ARS del paciente.',
    icono: 'bi-clipboard2-pulse',
    filtros: [...RANGO_FECHAS, { nombre: 'servicio_id', etiqueta: 'Servicio', tipo: 'select', fuente: 'servicios' }],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fechahora' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'medico', etiqueta: 'Médico' },
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'motivo', etiqueta: 'Motivo' },
      { clave: 'diagnostico', etiqueta: 'Diagnóstico' },
      { clave: 'ars', etiqueta: 'ARS' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f).agregar('co.servicio_id = ?', f.servicio_id);
      return {
        sql: `SELECT ${L('co.fecha_consulta')} AS fecha, ${NOMBRE_PACIENTE} AS paciente, ${NOMBRE_MEDICO} AS medico,
                     COALESCE(s.nombre, '—') AS servicio, co.motivo_consulta AS motivo, co.diagnostico_clinico AS diagnostico,
                     COALESCE(a.nombre, 'Sin ARS') AS ars
              FROM consultas co
              INNER JOIN pacientes p ON p.id = co.paciente_id
              LEFT JOIN usuarios u ON u.id = co.medico_id
              LEFT JOIN servicios s ON s.id = co.servicio_id
              LEFT JOIN ars a ON a.id = co.ars_id
              ${w.where()} ORDER BY co.fecha_consulta DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'consultas-diagnosticos',
    modulo: 'consultas',
    titulo: 'Diagnósticos más frecuentes',
    descripcion: 'Ranking de diagnósticos clínicos registrados y cuántos pacientes distintos los presentaron.',
    icono: 'bi-activity',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'diagnostico', etiqueta: 'Diagnóstico' },
      { clave: 'casos', etiqueta: 'Casos', tipo: 'numero', total: 'suma' },
      { clave: 'pacientes', etiqueta: 'Pacientes distintos', tipo: 'numero' },
      { clave: 'ultima_vez', etiqueta: 'Último registro', tipo: 'fecha' },
    ],
    grafico: { etiqueta: 'diagnostico', valor: 'casos' },
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f);
      return {
        sql: `SELECT MIN(TRIM(co.diagnostico_clinico)) AS diagnostico, COUNT(*)::int AS casos,
                     COUNT(DISTINCT co.paciente_id)::int AS pacientes, MAX(${L('co.fecha_consulta')}) AS ultima_vez
              FROM consultas co ${w.where()}
              GROUP BY LOWER(TRIM(co.diagnostico_clinico)) ORDER BY casos DESC, diagnostico LIMIT 50`,
        params: w.params,
      };
    },
  },
  {
    id: 'consultas-por-servicio',
    modulo: 'consultas',
    titulo: 'Consultas por tipo de servicio',
    descripcion: 'Cantidad de consultas y pacientes atendidos en cada servicio médico.',
    icono: 'bi-diagram-3',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'porcentaje', etiqueta: '% del total', tipo: 'porcentaje' },
      { clave: 'pacientes', etiqueta: 'Pacientes distintos', tipo: 'numero' },
      { clave: 'ultima', etiqueta: 'Última consulta', tipo: 'fecha' },
    ],
    grafico: { etiqueta: 'servicio', valor: 'consultas' },
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f);
      return {
        sql: `SELECT COALESCE(s.nombre, 'Sin servicio asignado') AS servicio, COUNT(co.id)::int AS consultas,
                     ROUND(100.0 * COUNT(co.id) / NULLIF(SUM(COUNT(co.id)) OVER (), 0), 1) AS porcentaje,
                     COUNT(DISTINCT co.paciente_id)::int AS pacientes, MAX(${L('co.fecha_consulta')}) AS ultima
              FROM consultas co LEFT JOIN servicios s ON s.id = co.servicio_id
              ${w.where()} GROUP BY COALESCE(s.nombre, 'Sin servicio asignado') ORDER BY consultas DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'consultas-pacientes-frecuentes',
    modulo: 'consultas',
    titulo: 'Pacientes más frecuentes',
    descripcion: 'Los 50 pacientes con más consultas, con su primera y última visita y el diagnóstico más reciente.',
    icono: 'bi-person-check',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'identificacion', etiqueta: 'Identificación' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'primera', etiqueta: 'Primera visita', tipo: 'fecha' },
      { clave: 'ultima', etiqueta: 'Última visita', tipo: 'fecha' },
      { clave: 'ultimo_diagnostico', etiqueta: 'Diagnóstico más reciente' },
    ],
    grafico: { etiqueta: 'paciente', valor: 'consultas' },
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f);
      return {
        sql: `SELECT ${NOMBRE_PACIENTE} AS paciente, p.identificacion,
                     COUNT(co.id)::int AS consultas, MIN(${L('co.fecha_consulta')}) AS primera, MAX(${L('co.fecha_consulta')}) AS ultima,
                     (ARRAY_AGG(co.diagnostico_clinico ORDER BY co.fecha_consulta DESC))[1] AS ultimo_diagnostico
              FROM consultas co
              INNER JOIN pacientes p ON p.id = co.paciente_id
              ${w.where()} GROUP BY p.id ORDER BY consultas DESC, ultima DESC LIMIT 50`,
        params: w.params,
      };
    },
  },
  {
    id: 'recetas-emitidas',
    modulo: 'consultas',
    titulo: 'Recetas emitidas',
    descripcion: 'Recetas médicas emitidas con cantidad de medicamentos y estado de entrega en farmacia.',
    icono: 'bi-prescription',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'codigo_receta', etiqueta: 'Código' },
      { clave: 'fecha_emision', etiqueta: 'Emitida', tipo: 'fechahora' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'medico', etiqueta: 'Médico' },
      { clave: 'diagnostico', etiqueta: 'Diagnóstico' },
      { clave: 'medicamentos', etiqueta: 'Medicamentos', tipo: 'numero', total: 'suma' },
      { clave: 'entregados', etiqueta: 'Entregados', tipo: 'numero', total: 'suma' },
      { clave: 'pendientes', etiqueta: 'Pendientes', tipo: 'numero', total: 'suma' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('r.fecha_emision'), f);
      return {
        sql: `SELECT r.codigo_receta, ${L('r.fecha_emision')} AS fecha_emision, ${NOMBRE_PACIENTE} AS paciente,
                     ${NOMBRE_MEDICO} AS medico, co.diagnostico_clinico AS diagnostico,
                     COUNT(rd.id)::int AS medicamentos,
                     COUNT(rd.id) FILTER (WHERE rd.estado_dispensacion = 'Entregado')::int AS entregados,
                     COUNT(rd.id) FILTER (WHERE rd.estado_dispensacion = 'Pendiente')::int AS pendientes
              FROM recetas r
              INNER JOIN pacientes p ON p.id = r.paciente_id
              INNER JOIN consultas co ON co.id = r.consulta_id
              LEFT JOIN usuarios u ON u.id = co.medico_id
              LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
              ${w.where()} GROUP BY r.id, p.id, co.id, u.id ORDER BY r.fecha_emision DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'recetas-medicamentos-top',
    modulo: 'consultas',
    titulo: 'Medicamentos más recetados',
    descripcion: 'Ranking de medicamentos prescritos por el médico, con unidades y pacientes.',
    icono: 'bi-capsule-pill',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'medicamento', etiqueta: 'Medicamento' },
      { clave: 'veces', etiqueta: 'Veces recetado', tipo: 'numero', total: 'suma' },
      { clave: 'unidades', etiqueta: 'Unidades recetadas', tipo: 'numero', total: 'suma' },
      { clave: 'pacientes', etiqueta: 'Pacientes distintos', tipo: 'numero' },
      { clave: 'pct_entregado', etiqueta: '% entregado en farmacia', tipo: 'porcentaje' },
    ],
    grafico: { etiqueta: 'medicamento', valor: 'veces' },
    consulta(f) {
      const w = new Condiciones().rango(L('r.fecha_emision'), f);
      return {
        sql: `SELECT COALESCE(m.nombre, rd.nombre_medicamento) AS medicamento, COUNT(*)::int AS veces,
                     SUM(rd.cantidad_recetada)::int AS unidades, COUNT(DISTINCT r.paciente_id)::int AS pacientes,
                     ROUND(100.0 * COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'Entregado') / NULLIF(COUNT(*), 0), 1) AS pct_entregado
              FROM receta_detalles rd
              INNER JOIN recetas r ON r.id = rd.receta_id
              LEFT JOIN medicamentos m ON m.id = rd.medicamento_id
              ${w.where()} GROUP BY COALESCE(m.nombre, rd.nombre_medicamento) ORDER BY veces DESC, medicamento LIMIT 50`,
        params: w.params,
      };
    },
  },

  // =====================================================================
  // MÓDULO 4: FARMACIA E INVENTARIO
  // =====================================================================
  {
    id: 'farmacia-inventario-valorizado',
    modulo: 'farmacia',
    titulo: 'Inventario valorizado',
    descripcion: 'Existencias actuales de cada medicamento y su valor en RD$ (stock × precio unitario).',
    icono: 'bi-boxes',
    filtros: [],
    columnas: [
      { clave: 'codigo', etiqueta: 'Código' },
      { clave: 'nombre', etiqueta: 'Medicamento' },
      { clave: 'presentacion', etiqueta: 'Presentación' },
      { clave: 'ubicacion', etiqueta: 'Ubicación' },
      { clave: 'stock_actual', etiqueta: 'Stock', tipo: 'numero', total: 'suma' },
      { clave: 'precio_unitario', etiqueta: 'Precio unitario', tipo: 'moneda' },
      { clave: 'valor_inventario', etiqueta: 'Valor en inventario', tipo: 'moneda', total: 'suma' },
    ],
    grafico: { etiqueta: 'nombre', valor: 'valor_inventario' },
    consulta() {
      return {
        sql: `SELECT m.codigo, m.nombre || COALESCE(' ' || m.concentracion, '') AS nombre, m.presentacion, m.ubicacion,
                     m.stock_actual, m.precio_unitario, (m.stock_actual * m.precio_unitario) AS valor_inventario
              FROM medicamentos m WHERE m.activo = true ORDER BY valor_inventario DESC, m.nombre`,
        params: [],
      };
    },
  },
  {
    id: 'farmacia-stock-bajo',
    modulo: 'farmacia',
    titulo: 'Medicamentos con stock bajo o agotados',
    descripcion: 'Medicamentos en o por debajo del stock mínimo y la cantidad sugerida a reponer.',
    icono: 'bi-exclamation-octagon',
    filtros: [],
    columnas: [
      { clave: 'codigo', etiqueta: 'Código' },
      { clave: 'nombre', etiqueta: 'Medicamento' },
      { clave: 'stock_actual', etiqueta: 'Stock actual', tipo: 'numero' },
      { clave: 'stock_minimo', etiqueta: 'Stock mínimo', tipo: 'numero' },
      { clave: 'sugerido', etiqueta: 'Sugerido a reponer', tipo: 'numero', total: 'suma' },
      { clave: 'costo_reposicion', etiqueta: 'Costo estimado', tipo: 'moneda', total: 'suma' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
    ],
    consulta() {
      return {
        sql: `SELECT m.codigo, m.nombre || COALESCE(' ' || m.concentracion, '') AS nombre, m.stock_actual, m.stock_minimo,
                     GREATEST(m.stock_minimo * 2 - m.stock_actual, 0) AS sugerido,
                     GREATEST(m.stock_minimo * 2 - m.stock_actual, 0) * m.precio_unitario AS costo_reposicion,
                     CASE WHEN m.stock_actual = 0 THEN 'Agotado' ELSE 'Stock bajo' END AS estado
              FROM medicamentos m
              WHERE m.activo = true AND m.stock_actual <= m.stock_minimo
              ORDER BY m.stock_actual ASC, m.nombre`,
        params: [],
      };
    },
  },
  {
    id: 'farmacia-vencimientos',
    modulo: 'farmacia',
    titulo: 'Medicamentos vencidos o por vencer',
    descripcion: 'Lotes que ya vencieron o vencen dentro de los próximos N días y su valor en riesgo.',
    icono: 'bi-calendar-event',
    filtros: [{ nombre: 'dias', etiqueta: 'Vencen en los próximos (días)', tipo: 'numero', defecto: '90' }],
    columnas: [
      { clave: 'codigo', etiqueta: 'Código' },
      { clave: 'nombre', etiqueta: 'Medicamento' },
      { clave: 'lote', etiqueta: 'Lote' },
      { clave: 'fecha_vencimiento', etiqueta: 'Vence', tipo: 'fecha' },
      { clave: 'dias_restantes', etiqueta: 'Días restantes', tipo: 'numero' },
      { clave: 'stock_actual', etiqueta: 'Stock', tipo: 'numero', total: 'suma' },
      { clave: 'valor_riesgo', etiqueta: 'Valor en riesgo', tipo: 'moneda', total: 'suma' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
    ],
    consulta(f) {
      const dias = parseInt(f.dias, 10) || 90;
      return {
        sql: `SELECT m.codigo, m.nombre || COALESCE(' ' || m.concentracion, '') AS nombre, m.lote, m.fecha_vencimiento,
                     (m.fecha_vencimiento - ${HOY}) AS dias_restantes, m.stock_actual,
                     m.stock_actual * m.precio_unitario AS valor_riesgo,
                     CASE WHEN m.fecha_vencimiento < ${HOY} THEN 'Vencido' ELSE 'Por vencer' END AS estado
              FROM medicamentos m
              WHERE m.activo = true AND m.fecha_vencimiento IS NOT NULL
                AND m.fecha_vencimiento <= ${HOY} + $1::int
              ORDER BY m.fecha_vencimiento ASC`,
        params: [dias],
      };
    },
  },
  {
    id: 'farmacia-movimientos',
    modulo: 'farmacia',
    titulo: 'Movimientos de inventario (Kardex)',
    descripcion: 'Entradas, salidas por receta, ajustes y no entregas, con stock antes y después. Por defecto, los últimos 30 días.',
    icono: 'bi-arrow-left-right',
    filtros: [
      { nombre: 'desde', etiqueta: 'Desde', tipo: 'fecha', defecto: () => haceDias(30) },
      { nombre: 'hasta', etiqueta: 'Hasta', tipo: 'fecha' },
      {
        nombre: 'tipo', etiqueta: 'Tipo', tipo: 'select',
        opciones: [
          { valor: 'SALIDA_RECETA', etiqueta: 'Salida por receta' },
          { valor: 'ENTRADA_STOCK', etiqueta: 'Entrada de stock' },
          { valor: 'AJUSTE', etiqueta: 'Ajuste' },
          { valor: 'NO_ENTREGADO', etiqueta: 'No entregado' },
        ],
      },
    ],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fechahora' },
      { clave: 'tipo', etiqueta: 'Tipo', tipo: 'estado' },
      { clave: 'medicamento', etiqueta: 'Medicamento' },
      { clave: 'cantidad', etiqueta: 'Cantidad', tipo: 'numero', total: 'suma' },
      { clave: 'stock_anterior', etiqueta: 'Stock antes', tipo: 'numero' },
      { clave: 'stock_nuevo', etiqueta: 'Stock después', tipo: 'numero' },
      { clave: 'motivo', etiqueta: 'Motivo' },
      { clave: 'receta', etiqueta: 'Receta' },
      { clave: 'lote', etiqueta: 'Lote' },
      { clave: 'usuario', etiqueta: 'Usuario' },
    ],
    consulta(f) {
      // "No entregado" agrupa los dos códigos internos (con y sin existencias)
      const tipos = f.tipo === 'NO_ENTREGADO' ? ['NO_ENTREGADO', 'NO_ENTREGADO_SIN_STOCK'] : (f.tipo ? [f.tipo] : null);
      const w = new Condiciones().rango(L('fm.fecha'), f).agregar('fm.tipo_movimiento = ANY(?::text[])', tipos);
      return {
        sql: `SELECT ${L('fm.fecha')} AS fecha,
                     CASE fm.tipo_movimiento
                       WHEN 'SALIDA_RECETA' THEN 'Salida por receta'
                       WHEN 'ENTRADA_STOCK' THEN 'Entrada de stock'
                       WHEN 'AJUSTE' THEN 'Ajuste'
                       ELSE 'No entregado'
                     END AS tipo,
                     COALESCE(m.nombre, rd.nombre_medicamento, '—') AS medicamento,
                     fm.cantidad, fm.stock_anterior, fm.stock_nuevo, fm.motivo, r.codigo_receta AS receta, fm.lote,
                     COALESCE(REGEXP_REPLACE(u.nombre, '\\s*\\([^)]*\\)\\s*$', ''), 'No registrado') AS usuario
              FROM farmacia_movimientos fm
              LEFT JOIN medicamentos m ON m.id = fm.medicamento_id
              LEFT JOIN receta_detalles rd ON rd.id = fm.receta_detalle_id
              LEFT JOIN recetas r ON r.id = rd.receta_id
              LEFT JOIN usuarios u ON u.id = fm.usuario_id
              ${w.where()} ORDER BY fm.fecha DESC, fm.id DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'farmacia-dispensacion',
    modulo: 'farmacia',
    titulo: 'Efectividad de dispensación',
    descripcion: 'Por medicamento: cuántas prescripciones se entregaron, no se entregaron o siguen pendientes.',
    icono: 'bi-check2-circle',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'medicamento', etiqueta: 'Medicamento' },
      { clave: 'recetado', etiqueta: 'Prescripciones', tipo: 'numero', total: 'suma' },
      { clave: 'entregado', etiqueta: 'Entregadas', tipo: 'numero', total: 'suma' },
      { clave: 'sin_existencia', etiqueta: 'Sin existencias', tipo: 'numero', total: 'suma' },
      { clave: 'no_entregado', etiqueta: 'No entregadas (otro motivo)', tipo: 'numero', total: 'suma' },
      { clave: 'pendiente', etiqueta: 'Pendientes', tipo: 'numero', total: 'suma' },
      { clave: 'pct_entregado', etiqueta: '% entregado', tipo: 'porcentaje' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('r.fecha_emision'), f);
      return {
        sql: `SELECT COALESCE(m.nombre, rd.nombre_medicamento) AS medicamento, COUNT(*)::int AS recetado,
                     COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'Entregado')::int AS entregado,
                     COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'No entregado - Sin existencias')::int AS sin_existencia,
                     COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'No entregado')::int AS no_entregado,
                     COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'Pendiente')::int AS pendiente,
                     ROUND(100.0 * COUNT(*) FILTER (WHERE rd.estado_dispensacion = 'Entregado') / NULLIF(COUNT(*), 0), 1) AS pct_entregado
              FROM receta_detalles rd
              INNER JOIN recetas r ON r.id = rd.receta_id
              LEFT JOIN medicamentos m ON m.id = rd.medicamento_id
              ${w.where()} GROUP BY COALESCE(m.nombre, rd.nombre_medicamento) ORDER BY recetado DESC, medicamento`,
        params: w.params,
      };
    },
  },
  {
    id: 'farmacia-cobertura-ars',
    modulo: 'farmacia',
    titulo: 'Cobertura de ARS en farmacia',
    descripcion: 'Qué ARS cubre cada medicamento y con qué porcentaje, cuánto paga cada parte por unidad y lo ya entregado con cobertura.',
    icono: 'bi-shield-plus',
    filtros: [FILTRO_ARS, ...RANGO_FECHAS],
    columnas: [
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'medicamento', etiqueta: 'Medicamento' },
      { clave: 'precio_unitario', etiqueta: 'Precio unitario', tipo: 'moneda' },
      { clave: 'porcentaje', etiqueta: '% cobertura', tipo: 'porcentaje', total: 'promedio' },
      { clave: 'cubre_ars', etiqueta: 'Cubre la ARS (unidad)', tipo: 'moneda' },
      { clave: 'paga_paciente', etiqueta: 'Paga el paciente (unidad)', tipo: 'moneda' },
      { clave: 'entregas', etiqueta: 'Entregas con cobertura', tipo: 'numero', total: 'suma' },
      { clave: 'cubierto_entregado', etiqueta: 'Cubierto por ARS (entregado)', tipo: 'moneda', total: 'suma' },
      { clave: 'pagado_paciente', etiqueta: 'Pagado por pacientes (entregado)', tipo: 'moneda', total: 'suma' },
    ],
    grafico: { etiqueta: 'medicamento_ars', valor: 'porcentaje' },
    consulta(f) {
      // Las fechas filtran solo las entregas; el ARS filtra las coberturas configuradas
      const entregas = new Condiciones().fijo(`rd.estado_dispensacion = 'Entregado'`).rango(L('rd.fecha_dispensacion'), f);
      const params = [...entregas.params, f.ars_id || null];
      const pArs = `$${params.length}`;
      // Misma fórmula que coberturaFarmaciaService.calcularCobertura
      const cubre = `ROUND(m.precio_unitario * LEAST(mc.porcentaje_cobertura, 100) / 100.0, 2)`;
      return {
        sql: `SELECT a.nombre AS ars, m.nombre || COALESCE(' ' || m.concentracion, '') AS medicamento,
                     m.nombre || ' (' || a.nombre || ')' AS medicamento_ars,
                     m.precio_unitario, mc.porcentaje_cobertura AS porcentaje,
                     ${cubre} AS cubre_ars, m.precio_unitario - ${cubre} AS paga_paciente,
                     COALESCE(e.entregas, 0)::int AS entregas, COALESCE(e.cubierto, 0) AS cubierto_entregado,
                     COALESCE(e.paciente, 0) AS pagado_paciente
              FROM medicamento_coberturas_ars mc
              INNER JOIN medicamentos m ON m.id = mc.medicamento_id
              INNER JOIN ars a ON a.id = mc.ars_id
              LEFT JOIN (
                SELECT rd.medicamento_id, rd.ars_cobertura_id, COUNT(*) AS entregas,
                       SUM(rd.monto_cubierto_ars) AS cubierto, SUM(rd.monto_paciente) AS paciente
                FROM receta_detalles rd ${entregas.where()}
                GROUP BY rd.medicamento_id, rd.ars_cobertura_id
              ) e ON e.medicamento_id = m.id AND e.ars_cobertura_id = a.id
              WHERE mc.activo = true AND m.activo = true AND (${pArs}::int IS NULL OR mc.ars_id = ${pArs}::int)
              ORDER BY a.nombre, mc.porcentaje_cobertura DESC, m.nombre`,
        params,
      };
    },
  },

  // =====================================================================
  // MÓDULO 5: ARS, COBROS Y FACTURACIÓN
  // =====================================================================
  {
    id: 'facturacion-ingresos-diarios',
    modulo: 'facturacion',
    titulo: 'Ingresos diarios (cuadre de caja)',
    descripcion: 'Por día: consultas, facturado, parte de la ARS, lo cobrado a pacientes por método de pago y lo pendiente.',
    icono: 'bi-cash-stack',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'facturado', etiqueta: 'Facturado', tipo: 'moneda', total: 'suma' },
      { clave: 'cubierto_ars', etiqueta: 'A cargo de ARS', tipo: 'moneda', total: 'suma' },
      { clave: 'efectivo', etiqueta: 'Cobrado efectivo', tipo: 'moneda', total: 'suma' },
      { clave: 'tarjeta', etiqueta: 'Cobrado tarjeta', tipo: 'moneda', total: 'suma' },
      { clave: 'otros', etiqueta: 'Transferencia / PayPal / otro', tipo: 'moneda', total: 'suma' },
      { clave: 'cobrado', etiqueta: 'Total cobrado', tipo: 'moneda', total: 'suma' },
      { clave: 'pendiente', etiqueta: 'Pendiente de cobro', tipo: 'moneda', total: 'suma' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f);
      const pagado = (extra = '') => `COALESCE(SUM(co.diferencia_paciente) FILTER (WHERE co.estado_pago = 'Pagado'${extra}), 0)`;
      return {
        sql: `SELECT ${L('co.fecha_consulta')}::date AS fecha, COUNT(*)::int AS consultas, SUM(co.valor_total) AS facturado,
                     SUM(co.valor_cubierto_ars) AS cubierto_ars,
                     ${pagado(` AND co.metodo_pago = 'Efectivo'`)} AS efectivo,
                     ${pagado(` AND co.metodo_pago = 'Tarjeta de Débito / Crédito'`)} AS tarjeta,
                     ${pagado(` AND (co.metodo_pago IS NULL OR co.metodo_pago NOT IN ('Efectivo', 'Tarjeta de Débito / Crédito'))`)} AS otros,
                     ${pagado()} AS cobrado,
                     COALESCE(SUM(co.diferencia_paciente) FILTER (WHERE co.estado_pago = 'Pendiente'), 0) AS pendiente
              FROM consultas co ${w.where()}
              GROUP BY ${L('co.fecha_consulta')}::date ORDER BY fecha DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'facturacion-por-ars',
    modulo: 'facturacion',
    titulo: 'Facturación por ARS (monto a reclamar)',
    descripcion: 'Total facturado por aseguradora y monto que el consultorio debe reclamar a cada ARS.',
    icono: 'bi-building-check',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'facturado', etiqueta: 'Facturado', tipo: 'moneda', total: 'suma' },
      { clave: 'a_reclamar', etiqueta: 'A reclamar a la ARS', tipo: 'moneda', total: 'suma' },
      { clave: 'copagos', etiqueta: 'Copagos de pacientes', tipo: 'moneda', total: 'suma' },
      { clave: 'pct_cobertura', etiqueta: '% cubierto', tipo: 'porcentaje' },
    ],
    grafico: { etiqueta: 'ars', valor: 'a_reclamar' },
    consulta(f) {
      const w = new Condiciones().rango(L('co.fecha_consulta'), f);
      return {
        sql: `SELECT COALESCE(a.nombre, 'Sin ARS') AS ars, COUNT(*)::int AS consultas, SUM(co.valor_total) AS facturado,
                     SUM(co.valor_cubierto_ars) AS a_reclamar, SUM(co.diferencia_paciente) AS copagos,
                     ROUND(100.0 * SUM(co.valor_cubierto_ars) / NULLIF(SUM(co.valor_total), 0), 1) AS pct_cobertura
              FROM consultas co LEFT JOIN ars a ON a.id = co.ars_id
              ${w.where()} GROUP BY COALESCE(a.nombre, 'Sin ARS') ORDER BY a_reclamar DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'facturacion-cuentas-por-cobrar',
    modulo: 'facturacion',
    titulo: 'Cuentas por cobrar a pacientes',
    descripcion: 'Consultas con pago pendiente, monto que adeuda el paciente y antigüedad de la deuda.',
    icono: 'bi-hourglass',
    filtros: [FILTRO_ARS],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha consulta', tipo: 'fecha' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'telefono', etiqueta: 'Teléfono' },
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'valor_total', etiqueta: 'Valor consulta', tipo: 'moneda', total: 'suma' },
      { clave: 'adeudado', etiqueta: 'Adeudado por paciente', tipo: 'moneda', total: 'suma' },
      { clave: 'dias', etiqueta: 'Días pendiente', tipo: 'numero' },
    ],
    consulta(f) {
      const w = new Condiciones().fijo(`co.estado_pago = 'Pendiente'`).agregar('co.ars_id = ?', f.ars_id);
      return {
        sql: `SELECT ${L('co.fecha_consulta')} AS fecha, ${NOMBRE_PACIENTE} AS paciente, p.telefono, COALESCE(s.nombre, '—') AS servicio,
                     COALESCE(a.nombre, 'Sin ARS') AS ars, co.valor_total, co.diferencia_paciente AS adeudado,
                     (${HOY} - ${L('co.fecha_consulta')}::date) AS dias
              FROM consultas co
              INNER JOIN pacientes p ON p.id = co.paciente_id
              LEFT JOIN servicios s ON s.id = co.servicio_id
              LEFT JOIN ars a ON a.id = co.ars_id
              ${w.where()} ORDER BY co.fecha_consulta ASC`,
        params: w.params,
      };
    },
  },
  {
    id: 'facturacion-tarifarios',
    modulo: 'facturacion',
    titulo: 'Tarifarios y coberturas por ARS',
    descripcion: 'Tarifa pactada de cada servicio por ARS, cobertura estimada y lo que pagaría el paciente.',
    icono: 'bi-table',
    filtros: [FILTRO_ARS],
    columnas: [
      { clave: 'ars', etiqueta: 'ARS' },
      { clave: 'servicio', etiqueta: 'Servicio' },
      { clave: 'precio_base', etiqueta: 'Precio base', tipo: 'moneda' },
      { clave: 'tarifa_pactada', etiqueta: 'Tarifa pactada', tipo: 'moneda' },
      { clave: 'cobertura', etiqueta: 'Cobertura' },
      { clave: 'cubre_ars', etiqueta: 'Cubre la ARS', tipo: 'moneda' },
      { clave: 'copago_fijo', etiqueta: 'Copago mínimo (incluido)', tipo: 'moneda' },
      { clave: 'paga_paciente', etiqueta: 'Paga el paciente', tipo: 'moneda' },
    ],
    consulta(f) {
      const w = new Condiciones().agregar('t.ars_id = ?', f.ars_id);
      // Misma regla que public/js/liquidacion-ars.js: el copago fijo es el mínimo que paga el paciente
      // (va incluido), así que Tarifa = Cubre la ARS + Paga el paciente.
      const cubre = `LEAST(
                       CASE WHEN t.tipo_cobertura = 'PORCENTAJE' THEN ROUND(t.tarifa_pactada * LEAST(t.valor_cobertura, 100) / 100.0, 2)
                            ELSE LEAST(t.tarifa_pactada, t.valor_cobertura) END,
                       GREATEST(t.tarifa_pactada - t.copago_fijo, 0))`;
      return {
        sql: `SELECT a.nombre AS ars, s.nombre AS servicio, s.precio_base, t.tarifa_pactada,
                     CASE WHEN t.tipo_cobertura = 'PORCENTAJE' THEN t.valor_cobertura || '%'
                          ELSE 'Fijo RD$ ' || t.valor_cobertura END AS cobertura,
                     ${cubre} AS cubre_ars, t.copago_fijo,
                     t.tarifa_pactada - ${cubre} AS paga_paciente
              FROM ars_tarifarios t
              INNER JOIN ars a ON a.id = t.ars_id
              INNER JOIN servicios s ON s.id = t.servicio_id
              ${w.where()} ORDER BY a.nombre, s.nombre`,
        params: w.params,
      };
    },
  },
  {
    id: 'facturacion-ecf',
    modulo: 'facturacion',
    titulo: 'Comprobantes fiscales electrónicos (e-CF)',
    descripcion: 'e-CF emitidos ante la DGII con su tipo, montos, ITBIS, estado y envío por correo.',
    icono: 'bi-receipt-cutoff',
    filtros: [...RANGO_FECHAS, { nombre: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: ['E31', 'E32'] }],
    columnas: [
      { clave: 'fecha_emision', etiqueta: 'Emisión', tipo: 'fechahora' },
      { clave: 'encf', etiqueta: 'e-NCF' },
      { clave: 'tipo_ecf', etiqueta: 'Tipo' },
      { clave: 'cliente', etiqueta: 'Cliente' },
      { clave: 'monto_total', etiqueta: 'Monto total', tipo: 'moneda', total: 'suma' },
      { clave: 'total_itbis', etiqueta: 'ITBIS', tipo: 'moneda', total: 'suma' },
      { clave: 'estado', etiqueta: 'Estado DGII', tipo: 'estado' },
      { clave: 'correo', etiqueta: 'Enviado por correo' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('e.fecha_emision'), f).agregar('e.tipo_ecf = ?', f.tipo);
      return {
        sql: `SELECT ${L('e.fecha_emision')} AS fecha_emision, COALESCE(e.encf, '—') AS encf, e.tipo_ecf,
                     COALESCE(e.razon_social_comprador, ${NOMBRE_PACIENTE}) AS cliente,
                     e.monto_total, e.total_itbis, e.estado,
                     CASE WHEN e.correo_enviado THEN 'Sí' ELSE 'No' END AS correo
              FROM comprobantes_electronicos e
              INNER JOIN consultas co ON co.id = e.consulta_id
              INNER JOIN pacientes p ON p.id = co.paciente_id
              ${w.where()} ORDER BY e.fecha_emision DESC`,
        params: w.params,
      };
    },
  },
  {
    id: 'facturacion-paypal',
    modulo: 'facturacion',
    titulo: 'Pagos en línea con PayPal',
    descripcion: 'Órdenes de pago PayPal con monto en RD$ y USD, tasa usada, estado y pagador.',
    icono: 'bi-paypal',
    filtros: [
      ...RANGO_FECHAS,
      { nombre: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: ['COMPLETED', 'CREATED', 'APPROVED', 'PENDING', 'CANCELLED', 'DECLINED', 'FAILED'] },
    ],
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fechahora' },
      { clave: 'referencia_interna', etiqueta: 'Referencia' },
      { clave: 'paciente', etiqueta: 'Paciente' },
      { clave: 'criterio_cobro', etiqueta: 'Concepto' },
      { clave: 'monto_dop', etiqueta: 'Monto RD$', tipo: 'moneda', total: 'suma' },
      { clave: 'importe_usd', etiqueta: 'Importe USD', tipo: 'numero', total: 'suma' },
      { clave: 'tasa_cambio', etiqueta: 'Tasa', tipo: 'numero' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      { clave: 'payer_email', etiqueta: 'Pagador' },
    ],
    consulta(f) {
      const w = new Condiciones().rango(L('COALESCE(pp.fecha_pago, pp.created_at)'), f).agregar('pp.estado = ?', f.estado);
      return {
        sql: `SELECT ${L('COALESCE(pp.fecha_pago, pp.created_at)')} AS fecha, pp.referencia_interna, ${NOMBRE_PACIENTE} AS paciente,
                     pp.criterio_cobro, pp.monto_dop, pp.importe AS importe_usd, pp.tasa_cambio, pp.estado, pp.payer_email
              FROM pagos_paypal pp
              INNER JOIN consultas co ON co.id = pp.consulta_id
              INNER JOIN pacientes p ON p.id = co.paciente_id
              ${w.where()} ORDER BY fecha DESC`,
        params: w.params,
      };
    },
  },

  // =====================================================================
  // MÓDULO 6: ADMINISTRACIÓN (solo ADMINISTRADOR)
  // =====================================================================
  {
    id: 'admin-resumen-general',
    modulo: 'administracion',
    titulo: 'Resumen general del consultorio',
    descripcion: 'Indicadores clave del sistema: pacientes, citas, consultas, recetas, inventario e ingresos.',
    icono: 'bi-speedometer2',
    filtros: [],
    columnas: [
      { clave: 'area', etiqueta: 'Área' },
      { clave: 'indicador', etiqueta: 'Indicador' },
      { clave: 'cantidad', etiqueta: 'Cantidad', tipo: 'numero' },
      { clave: 'monto', etiqueta: 'Monto', tipo: 'moneda' },
    ],
    consulta() {
      return {
        sql: `SELECT * FROM (
                SELECT 1 AS o, 'Pacientes' AS area, 'Pacientes activos' AS indicador, (SELECT COUNT(*) FROM pacientes WHERE activo)::int AS cantidad, NULL::numeric AS monto
                UNION ALL SELECT 2, 'Pacientes', 'Pacientes nuevos este mes', (SELECT COUNT(*) FROM pacientes WHERE ${L('created_at')} >= ${MES_HOY})::int, NULL
                UNION ALL SELECT 3, 'Citas', 'Citas de hoy', (SELECT COUNT(*) FROM citas WHERE fecha = ${HOY})::int, NULL
                UNION ALL SELECT 4, 'Citas', 'Citas próximas (programadas/confirmadas)', (SELECT COUNT(*) FROM citas WHERE fecha >= ${HOY} AND estado IN ('Programada', 'Confirmada'))::int, NULL
                UNION ALL SELECT 5, 'Consultas', 'Consultas este mes', (SELECT COUNT(*) FROM consultas WHERE ${L('fecha_consulta')} >= ${MES_HOY})::int,
                                     (SELECT COALESCE(SUM(valor_total), 0) FROM consultas WHERE ${L('fecha_consulta')} >= ${MES_HOY})
                UNION ALL SELECT 6, 'Consultas', 'Consultas históricas', (SELECT COUNT(*) FROM consultas)::int, (SELECT COALESCE(SUM(valor_total), 0) FROM consultas)
                UNION ALL SELECT 7, 'Cobros', 'Cuentas pendientes de cobro', (SELECT COUNT(*) FROM consultas WHERE estado_pago = 'Pendiente')::int,
                                     (SELECT COALESCE(SUM(diferencia_paciente), 0) FROM consultas WHERE estado_pago = 'Pendiente')
                UNION ALL SELECT 8, 'Cobros', 'Por reclamar a ARS (histórico)', (SELECT COUNT(*) FROM consultas WHERE valor_cubierto_ars > 0)::int,
                                     (SELECT COALESCE(SUM(valor_cubierto_ars), 0) FROM consultas)
                UNION ALL SELECT 9, 'Recetas', 'Recetas emitidas', (SELECT COUNT(*) FROM recetas)::int, NULL
                UNION ALL SELECT 10, 'Farmacia', 'Medicamentos pendientes de entregar', (SELECT COUNT(*) FROM receta_detalles WHERE estado_dispensacion = 'Pendiente')::int, NULL
                UNION ALL SELECT 11, 'Farmacia', 'Medicamentos con stock bajo', (SELECT COUNT(*) FROM medicamentos WHERE activo AND stock_actual <= stock_minimo)::int, NULL
                UNION ALL SELECT 12, 'Farmacia', 'Valor del inventario', (SELECT COALESCE(SUM(stock_actual), 0) FROM medicamentos WHERE activo)::int,
                                     (SELECT COALESCE(SUM(stock_actual * precio_unitario), 0) FROM medicamentos WHERE activo)
                UNION ALL SELECT 13, 'Facturación', 'e-CF emitidos', (SELECT COUNT(*) FROM comprobantes_electronicos)::int,
                                     (SELECT COALESCE(SUM(monto_total), 0) FROM comprobantes_electronicos)
                UNION ALL SELECT 14, 'Facturación', 'Pagos PayPal completados', (SELECT COUNT(*) FROM pagos_paypal WHERE estado = 'COMPLETED')::int,
                                     (SELECT COALESCE(SUM(monto_dop), 0) FROM pagos_paypal WHERE estado = 'COMPLETED')
                UNION ALL SELECT 15, 'Sistema', 'Usuarios activos', (SELECT COUNT(*) FROM usuarios WHERE activo)::int, NULL
              ) t ORDER BY o`,
        params: [],
      };
    },
  },
  {
    id: 'admin-ingresos-mensuales',
    modulo: 'administracion',
    titulo: 'Ingresos mensuales (últimos 12 meses)',
    descripcion: 'Evolución mensual de consultas, facturación médica, cobertura ARS y ventas de farmacia.',
    icono: 'bi-graph-up-arrow',
    filtros: [],
    columnas: [
      { clave: 'mes', etiqueta: 'Mes' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'facturado', etiqueta: 'Facturado consultas', tipo: 'moneda', total: 'suma' },
      { clave: 'cubierto_ars', etiqueta: 'A cargo de ARS', tipo: 'moneda', total: 'suma' },
      { clave: 'pacientes', etiqueta: 'A cargo de pacientes', tipo: 'moneda', total: 'suma' },
      { clave: 'farmacia', etiqueta: 'Ventas farmacia', tipo: 'moneda', total: 'suma' },
    ],
    grafico: { etiqueta: 'mes', valor: 'facturado' },
    consulta() {
      return {
        sql: `WITH meses AS (
                SELECT generate_series(${MES_HOY} - INTERVAL '11 months', ${MES_HOY}, INTERVAL '1 month')::date AS mes
              ), c AS (
                SELECT DATE_TRUNC('month', ${L('fecha_consulta')})::date AS mes, COUNT(*) AS consultas, SUM(valor_total) AS facturado,
                       SUM(valor_cubierto_ars) AS cubierto_ars, SUM(diferencia_paciente) AS pacientes
                FROM consultas GROUP BY 1
              ), f AS (
                SELECT DATE_TRUNC('month', ${L('fecha_dispensacion')})::date AS mes, SUM(monto_total) AS farmacia
                FROM receta_detalles WHERE estado_dispensacion = 'Entregado' GROUP BY 1
              )
              SELECT (ARRAY['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre',
                            'Octubre', 'Noviembre', 'Diciembre'])[EXTRACT(MONTH FROM m.mes)::int] || ' ' || EXTRACT(YEAR FROM m.mes) AS mes, COALESCE(c.consultas, 0)::int AS consultas,
                     COALESCE(c.facturado, 0) AS facturado, COALESCE(c.cubierto_ars, 0) AS cubierto_ars,
                     COALESCE(c.pacientes, 0) AS pacientes, COALESCE(f.farmacia, 0) AS farmacia
              FROM meses m LEFT JOIN c ON c.mes = m.mes LEFT JOIN f ON f.mes = m.mes
              ORDER BY m.mes`,
        params: [],
      };
    },
  },
  {
    id: 'admin-usuarios',
    modulo: 'administracion',
    titulo: 'Usuarios del sistema',
    descripcion: 'Cuentas de usuario con su rol, estado y fecha de creación (control de accesos).',
    icono: 'bi-people-fill',
    filtros: [
      { nombre: 'rol', etiqueta: 'Rol', tipo: 'select', opciones: ['ADMINISTRADOR', 'MEDICO', 'SECRETARIA', 'RECEPCION', 'FARMACIA'] },
      { nombre: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: ['Activo', 'Inactivo'] },
    ],
    columnas: [
      { clave: 'nombre', etiqueta: 'Nombre' },
      { clave: 'usuario', etiqueta: 'Usuario' },
      { clave: 'correo', etiqueta: 'Correo' },
      { clave: 'rol', etiqueta: 'Rol' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      { clave: 'created_at', etiqueta: 'Creado', tipo: 'fecha' },
    ],
    consulta(f) {
      const w = new Condiciones().agregar('u.rol = ?', f.rol).agregar('u.activo = ?', f.estado ? f.estado === 'Activo' : '');
      return {
        sql: `SELECT u.nombre, u.usuario, u.correo, u.rol, CASE WHEN u.activo THEN 'Activo' ELSE 'Inactivo' END AS estado, ${L('u.created_at')} AS created_at
              FROM usuarios u ${w.where()} ORDER BY u.rol, u.nombre`,
        params: w.params,
      };
    },
  },
  {
    id: 'admin-usuarios-por-rol',
    modulo: 'administracion',
    titulo: 'Usuarios por rol',
    descripcion: 'Cantidad de cuentas activas e inactivas en cada rol del sistema.',
    icono: 'bi-diagram-2',
    filtros: [],
    columnas: [
      { clave: 'rol', etiqueta: 'Rol' },
      { clave: 'activos', etiqueta: 'Activos', tipo: 'numero', total: 'suma' },
      { clave: 'inactivos', etiqueta: 'Inactivos', tipo: 'numero', total: 'suma' },
      { clave: 'total', etiqueta: 'Total', tipo: 'numero', total: 'suma' },
    ],
    grafico: { etiqueta: 'rol', valor: 'total' },
    consulta() {
      return {
        sql: `SELECT u.rol, COUNT(*) FILTER (WHERE u.activo)::int AS activos, COUNT(*) FILTER (WHERE NOT u.activo)::int AS inactivos,
                     COUNT(*)::int AS total
              FROM usuarios u GROUP BY u.rol ORDER BY total DESC, u.rol`,
        params: [],
      };
    },
  },
  {
    id: 'admin-actividad-facturacion',
    modulo: 'administracion',
    titulo: 'Actividad de facturación por usuario',
    descripcion: 'Comprobantes e-CF emitidos y pagos PayPal procesados por cada usuario del sistema.',
    icono: 'bi-person-badge',
    filtros: [...RANGO_FECHAS],
    columnas: [
      { clave: 'nombre', etiqueta: 'Usuario' },
      { clave: 'rol', etiqueta: 'Rol' },
      { clave: 'ecf_emitidos', etiqueta: 'e-CF emitidos', tipo: 'numero', total: 'suma' },
      { clave: 'monto_ecf', etiqueta: 'Monto e-CF', tipo: 'moneda', total: 'suma' },
      { clave: 'pagos_paypal', etiqueta: 'Pagos PayPal', tipo: 'numero', total: 'suma' },
      { clave: 'monto_paypal', etiqueta: 'Cobrado PayPal (RD$)', tipo: 'moneda', total: 'suma' },
    ],
    consulta(f) {
      // $1 = desde, $2 = hasta (NULL = sin límite); se usan en ambos subconjuntos
      const enRango = (c) => `($1::date IS NULL OR ${L(c)} >= $1::date) AND ($2::date IS NULL OR ${L(c)} < ($2::date + 1))`;
      return {
        sql: `WITH e AS (
                SELECT e.emitido_por_usuario_id AS uid, COUNT(*) AS n, SUM(e.monto_total) AS monto
                FROM comprobantes_electronicos e WHERE ${enRango('e.fecha_emision')} GROUP BY 1
              ), p AS (
                SELECT pp.usuario_id AS uid, COUNT(*) AS n, SUM(pp.monto_dop) AS monto
                FROM pagos_paypal pp WHERE pp.estado = 'COMPLETED' AND ${enRango('COALESCE(pp.fecha_pago, pp.created_at)')} GROUP BY 1
              )
              SELECT u.nombre, u.rol, COALESCE(e.n, 0)::int AS ecf_emitidos, COALESCE(e.monto, 0) AS monto_ecf,
                     COALESCE(p.n, 0)::int AS pagos_paypal, COALESCE(p.monto, 0) AS monto_paypal
              FROM usuarios u LEFT JOIN e ON e.uid = u.id LEFT JOIN p ON p.uid = u.id
              WHERE e.uid IS NOT NULL OR p.uid IS NOT NULL OR u.rol IN ('ADMINISTRADOR', 'SECRETARIA', 'RECEPCION')
              ORDER BY COALESCE(e.n, 0) + COALESCE(p.n, 0) DESC, u.nombre`,
        params: [f.desde || null, f.hasta || null],
      };
    },
  },
  {
    id: 'admin-servicios',
    modulo: 'administracion',
    titulo: 'Catálogo de servicios y su uso',
    descripcion: 'Servicios médicos con precio base, ARS con tarifa pactada, citas, consultas e ingresos.',
    icono: 'bi-list-check',
    filtros: [],
    columnas: [
      { clave: 'codigo', etiqueta: 'Código' },
      { clave: 'nombre', etiqueta: 'Servicio' },
      { clave: 'precio_base', etiqueta: 'Precio base', tipo: 'moneda' },
      { clave: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      { clave: 'ars_con_tarifa', etiqueta: 'ARS con tarifa', tipo: 'numero' },
      { clave: 'citas', etiqueta: 'Citas', tipo: 'numero', total: 'suma' },
      { clave: 'consultas', etiqueta: 'Consultas', tipo: 'numero', total: 'suma' },
      { clave: 'ingresos', etiqueta: 'Ingresos', tipo: 'moneda', total: 'suma' },
    ],
    grafico: { etiqueta: 'nombre', valor: 'ingresos' },
    consulta() {
      return {
        sql: `SELECT s.codigo, s.nombre, s.precio_base, CASE WHEN s.activo THEN 'Activo' ELSE 'Inactivo' END AS estado,
                     (SELECT COUNT(*) FROM ars_tarifarios t WHERE t.servicio_id = s.id)::int AS ars_con_tarifa,
                     (SELECT COUNT(*) FROM citas c WHERE c.servicio_id = s.id)::int AS citas,
                     (SELECT COUNT(*) FROM consultas co WHERE co.servicio_id = s.id)::int AS consultas,
                     (SELECT COALESCE(SUM(co.valor_total), 0) FROM consultas co WHERE co.servicio_id = s.id) AS ingresos
              FROM servicios s ORDER BY ingresos DESC, s.nombre`,
        params: [],
      };
    },
  },
];

// Numeración "módulo.reporte" (1.1 … 6.6) según el orden de MODULOS y de REPORTES
MODULOS.forEach((m, i) => {
  REPORTES.filter((r) => r.modulo === m.id).forEach((r, j) => {
    r.codigo = `${i + 1}.${j + 1}`;
  });
});

const POR_ID = new Map(REPORTES.map((r) => [r.id, r]));

function modulo(id) {
  return MODULOS.find((m) => m.id === id);
}

// ADMINISTRADOR ve todo; los demás roles ven los módulos que les corresponden.
// Un reporte puede restringirse más con su propia lista "roles" (p. ej. datos clínicos solo para el médico).
function puedeVer(rol, reporte) {
  if (rol === 'ADMINISTRADOR') return true;
  const roles = reporte.roles || (modulo(reporte.modulo) || {}).roles || [];
  return roles.includes(rol);
}

module.exports = { MODULOS, REPORTES, POR_ID, modulo, puedeVer };
