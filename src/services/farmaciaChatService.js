/**
 * Servicio de IA Conversacional para Farmacia Interna (Chat Box)
 * Consultorio Médico San Rafael
 *
 * Principios estrictos:
 * 1. Especializado ÚNICAMENTE en tareas de Farmacia Interna (catálogo, existencias, vencimientos,
 *    recetas pendientes, entregas, incidencias, movimientos y reposición basada en datos reales).
 * 2. Rechaza educada y firmemente solicitudes ajenas a Farmacia (citas, cobros, facturación e-CF,
 *    diagnósticos médicos o preguntas generales).
 * 3. Cero alucinaciones: Todas las respuestas provienen de consultas SQL reales a la base de datos.
 * 4. Human-In-The-Loop: Cualquier instrucción que cambie datos (entregar receta, marcar no entregado,
 *    ajustar existencias) REQUIERE confirmación explícita previa antes de tocar la base de datos.
 * 5. Respeta el rol de Farmacia: No expone datos financieros privados ni diagnósticos clínicos fuera del contexto de dispensación.
 */

const db = require('../config/db');
const farmaciaIaService = require('./farmaciaIaService');
const orientacionService = require('./farmaciaOrientacionService');
const crypto = require('crypto');

// Almacén en memoria de acciones pendientes de confirmación (expiran en 5 minutos)
const accionesPendientes = new Map();

// Limpieza periódica de acciones expiradas
setInterval(() => {
  const ahora = Date.now();
  for (const [id, accion] of accionesPendientes.entries()) {
    if (accion.expiraEn < ahora) {
      accionesPendientes.delete(id);
    }
  }
}, 60 * 1000).unref(); // unref: no impide que el proceso termine (pruebas/scripts)

/**
 * Procesa un mensaje entrante o una confirmación de acción
 */
async function procesarMensaje({ mensaje = '', usuario = {}, accionConfirmadaId = null, cancelarAccionId = null }) {
  // 1. Manejo de cancelación de acción pendiente
  if (cancelarAccionId) {
    if (accionesPendientes.has(cancelarAccionId)) {
      accionesPendientes.delete(cancelarAccionId);
      return {
        success: true,
        respuesta: 'Operación cancelada exitosamente. No se realizó ningún cambio en el inventario ni en las recetas.',
        tipo: 'INFO',
      };
    }
    return {
      success: true,
      respuesta: 'La operación ya no estaba pendiente o había expirado.',
      tipo: 'INFO',
    };
  }

  // 2. Manejo de ejecución de acción pendiente tras confirmación explícita
  if (accionConfirmadaId) {
    return await ejecutarAccionConfirmada(accionConfirmadaId, usuario);
  }

  const texto = String(mensaje || '').trim();
  if (!texto) {
    return {
      success: true,
      respuesta: 'Por favor escribe tu consulta o instrucción para el Asistente de Farmacia.',
      tipo: 'INFO',
    };
  }

  // 3. Si el usuario escribió textualmente "confirmar" o "si, confirmo" y hay una acción reciente
  const textoLimpio = texto.toLowerCase();
  if (
    textoLimpio === 'confirmar' ||
    textoLimpio === 'confirmo' ||
    textoLimpio === 'si' ||
    textoLimpio === 'sí' ||
    textoLimpio === 'proceder'
  ) {
    // Buscar si hay alguna acción pendiente para este usuario
    for (const [id, accion] of accionesPendientes.entries()) {
      if (accion.usuarioId === usuario.id && accion.expiraEn > Date.now()) {
        return await ejecutarAccionConfirmada(id, usuario);
      }
    }
  }

  // 4. Si el usuario escribió textualmente "cancelar"
  if (textoLimpio === 'cancelar' || textoLimpio === 'no' || textoLimpio === 'abortar') {
    for (const [id, accion] of accionesPendientes.entries()) {
      if (accion.usuarioId === usuario.id) {
        accionesPendientes.delete(id);
        return {
          success: true,
          respuesta: 'Operación cancelada. No se modificaron existencias ni registros en la farmacia.',
          tipo: 'INFO',
        };
      }
    }
  }

  // 5. Verificación estricta de alcance (Rechazar temas ajenos a Farmacia)
  const fueraDeAlcance = verificarFueraDeAlcance(texto);
  if (fueraDeAlcance.esAjeno) {
    return {
      success: true,
      respuesta: fueraDeAlcance.mensaje,
      tipo: 'FUERA_DE_ALCANCE',
    };
  }

  // 6. Detección de intenciones operativas y de consulta
  try {
    // 0. Orientación por síntomas (dolor de cabeza, barriga...) y sustitutos de medicamentos agotados
    const orientacion = orientacionService.detectarIntencionOrientacion(texto);
    if (orientacion) {
      return await orientacionService.responderOrientacion(orientacion);
    }

    // A. Instrucción de modificar existencias / ajustar stock (MUTANTE -> Requiere confirmación)
    if (esInstruccionAjustarStock(texto)) {
      return await prepararAjusteStock(texto, usuario);
    }

    // B. Instrucción de entregar ítem de receta (MUTANTE -> Requiere confirmación)
    if (esInstruccionEntregar(texto)) {
      return await prepararEntregaReceta(texto, usuario);
    }

    // C. Instrucción de registrar ítem no entregado (MUTANTE -> Requiere confirmación)
    if (esInstruccionNoEntregar(texto)) {
      return await prepararNoEntregaReceta(texto, usuario);
    }

    // D. Sugerencias de reposición y demanda estimada con IA
    if (esConsultaReposicion(texto)) {
      return await responderSugerenciasReposicion(texto);
    }

    // E. Consultar vencimientos de lotes
    if (esConsultaVencimientos(texto)) {
      return await responderConsultaVencimientos(texto);
    }

    // F. Consultar existencias, stock bajo o medicamentos agotados
    if (esConsultaExistencias(texto)) {
      return await responderConsultaExistencias(texto);
    }

    // G. Revisar recetas pendientes de dispensación
    if (esConsultaRecetas(texto)) {
      return await responderConsultaRecetas(texto);
    }

    // H. Informar qué se entregó o quedó sin entregar (auditoría / incidencias)
    if (esConsultaEntregasEIncidencias(texto)) {
      return await responderConsultaEntregas(texto);
    }

    // I. Consultar movimientos del kardex
    if (esConsultaMovimientos(texto)) {
      return await responderConsultaMovimientos(texto);
    }

    // J. Búsqueda de medicamentos específicos por nombre o principio activo
    if (esBusquedaMedicamento(texto)) {
      return await responderBusquedaMedicamento(texto);
    }

    // K. Saludo o menú de ayuda de farmacia
    if (esSaludoOAyuda(texto)) {
      return responderSaludoOAyuda();
    }

    // L. Consulta abierta sobre medicamentos: intentar buscar en el catálogo como respaldo
    return await responderBusquedaMedicamento(texto, true);
  } catch (error) {
    console.error('[ERROR CHAT FARMACIA]:', error);
    return {
      success: false,
      respuesta: 'Ocurrió un inconveniente al consultar los datos de farmacia: ' + error.message,
      tipo: 'ERROR',
    };
  }
}

// ============================================================================
// FILTRO DE ALCANCE (RESTRICCIÓN ESTRICTA DE ROL Y TAREAS DE FARMACIA)
// ============================================================================

function verificarFueraDeAlcance(texto) {
  const t = texto.toLowerCase();

  // Patrones de Citas médicas
  const esCitas = /\b(agendar|agenda|cita|citas|sala de espera|turno|reprogramar cita|cancelar cita|nueva cita)\b/i.test(t) &&
                  !/\b(medicamento|receta|pastilla|stock|dispensar|dosis|fármaco)\b/i.test(t);

  // Patrones de Pagos, PayPal, Facturación e-CF
  const esPagos = /\b(paypal|pago|pagos|pagar|cobro|cobros|cobrar|copago|factura fiscal|facturacion|facturación|e-cf|ecf|rnc|ncf|tarjeta|dólares|usd|liquidación ars)\b/i.test(t) &&
                  !/\b(cobertura ars|seguro del paciente|cubierto por seguro)\b/i.test(t);

  // Patrones de Diagnósticos clínicos / consultas
  const esClinico = /\b(diagnosticar|diagnóstico médico|diagnostico medico|examen físico|signos vitales|presión arterial|temperatura corporal|atender paciente|historia clínica completa|antecedentes familiares)\b/i.test(t) &&
                    !/\b(receta|prescripción|medicamento)\b/i.test(t);

  // Patrones generales / no médicos
  const esGeneral = /\b(chiste|poema|canción|cancion|quién ganó|futbol|fútbol|política|clima de hoy|receta de cocina|hacer una torta|programar en python|cuéntame un cuento)\b/i.test(t);

  if (esCitas) {
    return {
      esAjeno: true,
      mensaje: '⛔ **Solicitud fuera del alcance de Farmacia:**\n\nNo tengo autorización para gestionar o consultar **citas médicas**. Las citas deben ser agendadas y gestionadas desde el módulo de **Agenda de Citas** por el personal de Secretaría o Recepción.\n\nPuedo ayudarte con cualquier consulta de medicamentos, existencias, vencimientos o despacho de recetas.',
    };
  }

  if (esPagos) {
    return {
      esAjeno: true,
      mensaje: '⛔ **Solicitud fuera del alcance de Farmacia:**\n\nNo tengo autorización para gestionar **pagos, copagos con PayPal ni comprobantes fiscales e-CF**. Los cobros y liquidaciones corresponden exclusivamente al módulo de Secretaría y Facturación e-CF.\n\nRecuerda que en Farmacia únicamente se verifica si la receta cuenta con cobertura de ARS o si debe ser adquirida de forma particular.',
    };
  }

  if (esClinico) {
    return {
      esAjeno: true,
      mensaje: '⛔ **Solicitud fuera del alcance de Farmacia:**\n\nNo puedo emitir **diagnósticos médicos ni alterar planes clínicos**. Esas funciones corresponden exclusivamente al perfil del Médico en la consulta clínica.\n\nPuedo informarte sobre los medicamentos prescritos en recetas existentes, su disponibilidad en inventario y registrarlos cuando sean dispensados.',
    };
  }

  if (esGeneral) {
    return {
      esAjeno: true,
      mensaje: 'Como Asistente de IA de Farmacia Interna, únicamente puedo responder preguntas e instrucciones relacionadas con la **gestión de medicamentos, inventario, vencimientos y despacho de recetas** del Consultorio Médico San Rafael.',
    };
  }

  return { esAjeno: false };
}

// ============================================================================
// DETECCIÓN DE INTENCIONES
// ============================================================================

function esSaludoOAyuda(t) {
  const s = t.toLowerCase();
  return /^(hola|buenos días|buenas tardes|buenas noches|saludos|ayuda|qué puedes hacer|que puedes hacer|instrucciones|comandos)$/i.test(s.trim());
}

function esConsultaExistencias(t) {
  const s = t.toLowerCase();
  return /\b(agotado|agotados|stock bajo|bajo stock|existencias|cuánto queda|cuanto queda|cuántos hay|cuantos hay|unidades disponibles|disponibilidad de|stock de|nivel de stock)\b/i.test(s);
}

function esConsultaVencimientos(t) {
  const s = t.toLowerCase();
  return /\b(vence|vencen|vencimiento|vencimientos|vencido|vencidos|caducar|caducados|lote por vencer|fecha de vencimiento)\b/i.test(s);
}

function esConsultaRecetas(t) {
  const s = t.toLowerCase();
  return /\b(receta|recetas)\b.*\b(pendiente|pendientes|por dispensar|por entregar|cola|despacho|despachar)\b/i.test(s) ||
         /\b(recetas pendientes|receta pendiente|recetas por dispensar|por entregar|pendientes de entrega|receta de|recetas de|cola de recetas)\b/i.test(s);
}

function esConsultaEntregasEIncidencias(t) {
  const s = t.toLowerCase();
  return /\b(qué se entregó|que se entrego|qué se ha entregado|no entregado|no entregados|sin entregar|por qué no se entregó|porque no se entrego|motivo de no entrega|incidencias|entregas de hoy)\b/i.test(s);
}

function esConsultaMovimientos(t) {
  const s = t.toLowerCase();
  return /\b(movimientos|kardex|salidas|entradas de stock|historial de inventario|últimos movimientos|ultimos movimientos)\b/i.test(s);
}

function esConsultaReposicion(t) {
  const s = t.toLowerCase();
  return /\b(reposición|reposicion|reponer|sugerencias de compra|qué comprar|que comprar|demanda estimada|rotación|rotacion|estimación ia|estimacion ia|abastecimiento|sugieres reponer)\b/i.test(s);
}

function esInstruccionEntregar(t) {
  const s = t.toLowerCase();
  return /\b(entregar|entrega|despachar|despacha|registrar entrega|marca como entregado|marcar como entregado)\b/i.test(s) &&
         /\b(receta|medicamento|ítem|item|rx)\b/i.test(s);
}

function esInstruccionNoEntregar(t) {
  const s = t.toLowerCase();
  return /\b(no entregar|no entregado|marcar no entregado|marca como no entregado|registrar no entrega)\b/i.test(s);
}

function esInstruccionAjustarStock(t) {
  const s = t.toLowerCase();
  return /\b(ajustar stock|ajusta el stock|modificar existencias|cambiar stock|aumentar stock|reducir stock|sumar|restar|actualizar stock|fijar stock)\b/i.test(s);
}

function esBusquedaMedicamento(t) {
  const s = t.toLowerCase();
  return /\b(busca|buscar|dónde está|donde esta|ubicación|ubicacion|información de|informacion de|tienen|tenemos|precio|concentración|concentracion)\b/i.test(s);
}

// ============================================================================
// MANEJADORES DE CONSULTA (100% DATOS REALES DE POSTGRESQL)
// ============================================================================

function responderSaludoOAyuda() {
  return {
    success: true,
    respuesta:
      `👋 **¡Hola! Soy el Asistente de IA de Farmacia Interna.**\n\n` +
      `Estoy conectado a la base de datos en tiempo real del consultorio y puedo ayudarte con tareas exclusivas de farmacia:\n\n` +
      `🔍 **Consultas que puedes realizarme en lenguaje natural:**\n` +
      `• *¿Qué medicamentos están agotados o con stock bajo?*\n` +
      `• *¿Hay medicamentos vencidos o próximos a vencer en los siguientes 90 días?*\n` +
      `• *Busca Paracetamol o Amoxicilina (te mostraré stock, ubicación y lote).*\n` +
      `• *¿Qué recetas médicas están pendientes por dispensar?*\n` +
      `• *¿Qué medicamentos quedaron sin entregar y por qué motivos?*\n` +
      `• *Muéstrame los últimos movimientos del kardex de farmacia.*\n` +
      `• *¿Qué me sugieres reponer según el historial de rotación real?*\n` +
      `• *Me duele la cabeza, ¿qué medicamento me recomiendas?*\n` +
      `• *Me duele la barriga / tengo acidez / tengo diarrea*\n` +
      `• *No hay acetaminofén, ¿qué otro medicamento hace la misma función?*\n\n` +
      `⚙️ **Instrucciones de cambio con confirmación previa (Human-in-the-Loop):**\n` +
      `• *Entrega el medicamento Amoxicilina en la receta RX-123456*\n` +
      `• *Marca el medicamento Ibuprofeno de la receta RX-... como no entregado por falta de existencias*\n` +
      `• *Ajusta el stock de Omeprazol a 40 unidades por reposición*\n\n` +
      `Antes de modificar cualquier dato, siempre te mostraré el impacto exacto y te pediré confirmación. ¿En qué puedo colaborar contigo?`,
    tipo: 'AYUDA',
  };
}

async function responderBusquedaMedicamento(texto, modoFallback = false) {
  // Extraer términos clave limpiando palabras de parada
  const terminos = texto
    .replace(/\b(busca|buscar|medicamento|fármaco|farmaco|dónde está|donde esta|información de|informacion de|tienen|tenemos|hay|el|la|los|las|de|un|una)\b/gi, '')
    .trim();

  if (!terminos || terminos.length < 2) {
    if (modoFallback) {
      return {
        success: true,
        respuesta:
          'No pude identificar qué medicamento o tarea de farmacia requieres. Puedes preguntarme por existencias, vencimientos, recetas pendientes o escribir el nombre de un fármaco (por ej: *"Busca Amoxicilina"* o *"¿Qué medicamentos están agotados?"*).',
        tipo: 'INFO',
      };
    }
    return {
      success: true,
      respuesta: 'Por favor indica el nombre o principio activo del medicamento que deseas buscar.',
      tipo: 'INFO',
    };
  }

  const { rows: meds } = await db.query(
    `SELECT id, codigo, nombre, principio_activo, concentracion, presentacion,
            stock_actual, stock_minimo, ubicacion, lote, fecha_vencimiento
     FROM medicamentos
     WHERE activo = true
       AND (nombre ILIKE $1 OR principio_activo ILIKE $1 OR codigo ILIKE $1)
     ORDER BY nombre ASC
     LIMIT 8`,
    [`%${terminos}%`]
  );

  if (meds.length === 0) {
    return {
      success: true,
      respuesta: `🔍 No se encontró ningún medicamento registrado con el término **"${terminos}"** en el inventario interno de la clínica.`,
      tipo: 'NO_ENCONTRADO',
    };
  }

  let respuesta = `📋 **Resultados encontrados para "${terminos}" (${meds.length}):**\n\n`;

  for (const m of meds) {
    const estado = m.stock_actual <= 0
      ? '🔴 **AGOTADO** (0 unid.)'
      : (m.stock_actual <= m.stock_minimo
          ? `🟡 **STOCK BAJO** (${m.stock_actual} unid. - Mínimo: ${m.stock_minimo})`
          : `🟢 **DISPONIBLE** (${m.stock_actual} unid.)`);

    let vencTexto = 'No especificado';
    if (m.fecha_vencimiento) {
      const fechaV = new Date(m.fecha_vencimiento);
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      fechaV.setHours(0, 0, 0, 0);
      const dias = Math.round((fechaV.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
      if (dias <= 0) {
        vencTexto = `⚠️ **VENCIDO** (${fechaV.toLocaleDateString('es-DO')})`;
      } else if (dias <= 90) {
        vencTexto = `⚠️ Vence en ${dias} días (${fechaV.toLocaleDateString('es-DO')})`;
      } else {
        vencTexto = `${fechaV.toLocaleDateString('es-DO')} (${dias} días)`;
      }
    }

    respuesta +=
      `• **${m.nombre}** (\`${m.codigo}\`)\n` +
      `  - Presentación: ${m.presentacion || 'N/A'} | Concentración: ${m.concentracion || 'N/A'}\n` +
      `  - Principio Activo: ${m.principio_activo || 'N/A'}\n` +
      `  - Estado Stock: ${estado}\n` +
      `  - Ubicación física: **${m.ubicacion || 'General / Farmacia'}** | Lote: \`${m.lote || 'N/A'}\`\n` +
      `  - Vencimiento: ${vencTexto}\n\n`;
  }

  return {
    success: true,
    respuesta,
    datos: meds,
    tipo: 'MEDICAMENTOS',
  };
}

async function responderConsultaExistencias(texto) {
  const t = texto.toLowerCase();
  const soloAgotados = t.includes('agotado') || t.includes('en cero') || t.includes('sin existencia');
  const soloBajos = t.includes('bajo') || t.includes('minimo') || t.includes('mínimo');

  if (soloAgotados) {
    const { rows: agotados } = await db.query(
      `SELECT codigo, nombre, concentracion, presentacion, stock_minimo, ubicacion
       FROM medicamentos
       WHERE activo = true AND stock_actual <= 0
       ORDER BY nombre ASC`
    );

    if (agotados.length === 0) {
      return {
        success: true,
        respuesta: '🟢 **Excelente noticia:** Actualmente no hay ningún medicamento con stock en 0 en la farmacia interna.',
        tipo: 'EXISTENCIAS',
      };
    }

    let msg = `🔴 **Medicamentos Agotados (Stock 0) - Total: ${agotados.length}:**\n\n`;
    for (const m of agotados) {
      msg += `• **${m.nombre}** (${m.presentacion || ''}) - Código: \`${m.codigo}\` | Mínimo requerido: ${m.stock_minimo} unid. | Ubicación: ${m.ubicacion || 'General'}\n`;
    }
    msg += `\n*Nota: Se requiere reposición para estos ítems antes de poder dispensarlos a pacientes.*`;
    return { success: true, respuesta: msg, datos: agotados, tipo: 'EXISTENCIAS' };
  }

  if (soloBajos) {
    const { rows: bajos } = await db.query(
      `SELECT codigo, nombre, concentracion, presentacion, stock_actual, stock_minimo, ubicacion
       FROM medicamentos
       WHERE activo = true AND stock_actual > 0 AND stock_actual <= stock_minimo
       ORDER BY stock_actual ASC, nombre ASC`
    );

    if (bajos.length === 0) {
      return {
        success: true,
        respuesta: '🟢 **Inventario estable:** No hay medicamentos que se encuentren actualmente por debajo de su umbral mínimo de seguridad.',
        tipo: 'EXISTENCIAS',
      };
    }

    let msg = `🟡 **Medicamentos con Stock Bajo (por debajo o igual al mínimo) - Total: ${bajos.length}:**\n\n`;
    for (const m of bajos) {
      msg += `• **${m.nombre}**: Stock actual **${m.stock_actual} unid.** (Mínimo: ${m.stock_minimo} unid.) - Ubicación: ${m.ubicacion || 'General'}\n`;
    }
    return { success: true, respuesta: msg, datos: bajos, tipo: 'EXISTENCIAS' };
  }

  // Resumen general de existencias
  const { rows: stats } = await db.query(`
    SELECT
      COUNT(*) AS total_medicamentos,
      COALESCE(SUM(stock_actual), 0) AS total_unidades,
      COUNT(CASE WHEN stock_actual <= 0 THEN 1 END) AS agotados,
      COUNT(CASE WHEN stock_actual > 0 AND stock_actual <= stock_minimo THEN 1 END) AS bajos,
      COUNT(CASE WHEN stock_actual > stock_minimo THEN 1 END) AS adecuados
    FROM medicamentos
    WHERE activo = true
  `);

  const s = stats[0];
  let msg = `📊 **Resumen General de Existencias en Farmacia Interna:**\n\n` +
    `• **Total de Medicamentos en Catálogo:** ${s.total_medicamentos}\n` +
    `• **Total de Unidades Físicas Almacenadas:** ${s.total_unidades} unidades\n` +
    `• 🟢 **Nivel Adecuado:** ${s.adecuados} medicamentos\n` +
    `• 🟡 **Stock Bajo (crítico):** ${s.bajos} medicamentos\n` +
    `• 🔴 **Agotados (stock 0):** ${s.agotados} medicamentos\n\n` +
    `Puedes pedirme detalles específicos como: *"Muéstrame los agotados"* o *"¿Cuáles tienen stock bajo?"*.`;

  return { success: true, respuesta: msg, datos: s, tipo: 'EXISTENCIAS' };
}

async function responderConsultaVencimientos(texto) {
  const { rows: vencidos } = await db.query(`
    SELECT codigo, nombre, lote, fecha_vencimiento, stock_actual, ubicacion
    FROM medicamentos
    WHERE activo = true AND fecha_vencimiento <= CURRENT_DATE
    ORDER BY fecha_vencimiento ASC
  `);

  const { rows: proximos } = await db.query(`
    SELECT codigo, nombre, lote, fecha_vencimiento, stock_actual, ubicacion,
           (fecha_vencimiento - CURRENT_DATE) AS dias_restantes
    FROM medicamentos
    WHERE activo = true
      AND fecha_vencimiento > CURRENT_DATE
      AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '90 days'
    ORDER BY fecha_vencimiento ASC
  `);

  let msg = `📅 **Control de Fechas de Vencimiento y Lotes:**\n\n`;

  if (vencidos.length > 0) {
    msg += `🚨 **Lotes Vencidos (Requieren cuarentena y descarte) - Total: ${vencidos.length}:**\n`;
    for (const v of vencidos) {
      msg += `• ❌ **${v.nombre}** (Lote: \`${v.lote || 'N/A'}\`) - Venció el **${new Date(v.fecha_vencimiento).toLocaleDateString('es-DO')}** | Stock actual: ${v.stock_actual} unid.\n`;
    }
    msg += `\n`;
  } else {
    msg += `✔ No se registran medicamentos con fecha de caducidad superada.\n\n`;
  }

  if (proximos.length > 0) {
    msg += `⚠️ **Lotes Próximos a Vencer (dentro de 90 días) - Total: ${proximos.length}:**\n`;
    for (const p of proximos) {
      msg += `• 🟡 **${p.nombre}** (Lote: \`${p.lote || 'N/A'}\`) - Vence el **${new Date(p.fecha_vencimiento).toLocaleDateString('es-DO')}** (*en ${p.dias_restantes} días*) | Stock: ${p.stock_actual} unid.\n`;
    }
    msg += `\n*Recomendación de farmacia: Priorizar la dispensación de estos lotes antes de rotar ingresos nuevos.*`;
  } else {
    msg += `✔ No hay lotes en riesgo de caducar en los próximos 90 días.`;
  }

  return { success: true, respuesta: msg, datos: { vencidos, proximos }, tipo: 'VENCIMIENTOS' };
}

async function responderConsultaRecetas(texto) {
  // Buscar si se especificó el nombre o cédula de un paciente
  let pacienteFiltro = null;
  const match = texto.match(/receta(?:s)?\s+(?:de|para)?\s+([A-Za-z0-9\-]+(?:\s+[A-Za-z0-9\-]+)?)/i);
  if (match && !['hoy', 'pendientes', 'todas', 'por', 'dispensar'].includes(match[1].toLowerCase())) {
    pacienteFiltro = match[1].trim();
  }

  let sql = `
    SELECT r.id, r.codigo_receta, r.fecha_emision,
           p.nombre AS pac_nombre, p.apellido AS pac_apellido, p.identificacion AS pac_ident,
           a.nombre AS ars_nombre,
           COUNT(rd.id) AS total_items,
           COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) AS pendientes,
           COUNT(CASE WHEN rd.estado_dispensacion = 'Entregado' THEN 1 END) AS entregados,
           COUNT(CASE WHEN rd.estado_dispensacion IN ('No entregado', 'No entregado - Sin existencias') THEN 1 END) AS no_entregados
    FROM recetas r
    INNER JOIN pacientes p ON r.paciente_id = p.id
    LEFT JOIN ars a ON p.ars_id = a.id
    LEFT JOIN receta_detalles rd ON rd.receta_id = r.id
    WHERE 1=1
  `;
  const params = [];

  if (pacienteFiltro) {
    params.push(`%${pacienteFiltro}%`);
    sql += ` AND (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR r.codigo_receta ILIKE $1)`;
  }

  sql += `
    GROUP BY r.id, p.nombre, p.apellido, p.identificacion, a.nombre
    HAVING COUNT(CASE WHEN rd.estado_dispensacion = 'Pendiente' THEN 1 END) > 0
    ORDER BY r.fecha_emision ASC
    LIMIT 8
  `;

  const { rows: recetas } = await db.query(sql, params);

  if (recetas.length === 0) {
    return {
      success: true,
      respuesta: pacienteFiltro
        ? `No se encontraron recetas pendientes para **"${pacienteFiltro}"**.`
        : '🟢 No hay recetas con medicamentos pendientes por dispensar en este momento. La cola de entrega está al día.',
      tipo: 'RECETAS',
    };
  }

  let msg = `📋 **Recetas Médicas con Despacho Pendiente (${recetas.length}):**\n\n`;
  for (const r of recetas) {
    const fecha = new Date(r.fecha_emision).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' });
    const seguro = r.ars_nombre || 'Particular';
    msg +=
      `• **Receta \`${r.codigo_receta}\`** (${fecha})\n` +
      `  - Paciente: **${r.pac_nombre} ${r.pac_apellido}** (Cédula: \`${r.pac_ident}\`)\n` +
      `  - Cobertura: ${seguro} | Estado: **${r.pendientes}** de ${r.total_items} medicamentos pendientes\n` +
      `  - [Abrir Despacho](/farmacia/dispensar/${r.id})\n\n`;
  }

  return { success: true, respuesta: msg, datos: recetas, tipo: 'RECETAS' };
}

async function responderConsultaEntregas(texto) {
  const { rows: entregas } = await db.query(`
    SELECT rd.id, rd.nombre_medicamento, rd.cantidad_recetada, rd.estado_dispensacion,
           rd.motivo_no_entrega, rd.observacion_farmacia, rd.fecha_dispensacion, rd.cobertura_utilizada,
           r.codigo_receta, p.nombre AS pac_nombre, p.apellido AS pac_apellido, a.nombre AS ars_nombre
    FROM receta_detalles rd
    INNER JOIN recetas r ON rd.receta_id = r.id
    INNER JOIN pacientes p ON r.paciente_id = p.id
    LEFT JOIN ars a ON p.ars_id = a.id
    WHERE rd.estado_dispensacion IN ('Entregado', 'No entregado', 'No entregado - Sin existencias')
    ORDER BY rd.fecha_dispensacion DESC NULLS LAST, rd.id DESC
    LIMIT 10
  `);

  if (entregas.length === 0) {
    return {
      success: true,
      respuesta: 'No se registran entregas ni incidencias procesadas recientemente en la base de datos.',
      tipo: 'ENTREGAS',
    };
  }

  let msg = `📦 **Auditoría de Despachos Recientes (Entregados y No Entregados):**\n\n`;
  for (const e of entregas) {
    const esEntregado = e.estado_dispensacion === 'Entregado';
    const fecha = e.fecha_dispensacion
      ? new Date(e.fecha_dispensacion).toLocaleDateString('es-DO', { hour: '2-digit', minute: '2-digit' })
      : 'Reciente';

    if (esEntregado) {
      msg += `• 🟢 **ENTREGADO**: **${e.nombre_medicamento}** (${e.cantidad_recetada} unid.) en receta \`${e.codigo_receta}\`\n`;
      msg += `  - Paciente: ${e.pac_nombre} ${e.pac_apellido} | Seguro: ${e.cobertura_utilizada ? e.ars_nombre || 'ARS' : 'Particular'}\n`;
      msg += `  - Fecha: ${fecha}\n\n`;
    } else {
      msg += `• 🔴 **NO ENTREGADO**: **${e.nombre_medicamento}** (${e.cantidad_recetada} unid.) en receta \`${e.codigo_receta}\`\n`;
      msg += `  - Paciente: ${e.pac_nombre} ${e.pac_apellido}\n`;
      msg += `  - Motivo registrado: **"${e.motivo_no_entrega || e.observacion_farmacia || 'Sin existencias'}"**\n`;
      msg += `  - Fecha: ${fecha} (Sin descuento de inventario)\n\n`;
    }
  }

  return { success: true, respuesta: msg, datos: entregas, tipo: 'ENTREGAS' };
}

async function responderConsultaMovimientos(texto) {
  const { rows: movs } = await db.query(`
    SELECT fm.*, m.nombre AS med_nombre, m.codigo AS med_codigo, r.codigo_receta
    FROM farmacia_movimientos fm
    LEFT JOIN medicamentos m ON fm.medicamento_id = m.id
    LEFT JOIN receta_detalles rd ON fm.receta_detalle_id = rd.id
    LEFT JOIN recetas r ON rd.receta_id = r.id
    ORDER BY fm.fecha DESC
    LIMIT 10
  `);

  if (movs.length === 0) {
    return {
      success: true,
      respuesta: 'No se registran movimientos en el kardex de farmacia hasta el momento.',
      tipo: 'MOVIMIENTOS',
    };
  }

  let msg = `📑 **Últimos 10 Movimientos en Kardex de Farmacia:**\n\n`;
  for (const m of movs) {
    const fecha = new Date(m.fecha).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
    let tipoIcono = 'ℹ️';
    if (m.tipo_movimiento === 'SALIDA_RECETA') tipoIcono = '📤 Salida Receta';
    else if (m.tipo_movimiento === 'ENTRADA_STOCK') tipoIcono = '📥 Entrada Stock';
    else if (m.tipo_movimiento === 'NO_ENTREGADO' || m.tipo_movimiento === 'NO_ENTREGADO_SIN_STOCK') tipoIcono = '⚠️ No Entregado';
    else if (m.tipo_movimiento === 'AJUSTE') tipoIcono = '🔧 Ajuste';

    msg += `• **${tipoIcono}** | **${m.med_nombre || 'Medicamento'}**\n`;
    msg += `  - Cantidad: ${m.cantidad} unid. | Stock: ${m.stock_anterior ?? '-'} ➔ **${m.stock_nuevo ?? '-'}**\n`;
    msg += `  - Motivo: ${m.motivo || 'N/A'} | Fecha: ${fecha}\n\n`;
  }

  return { success: true, respuesta: msg, datos: movs, tipo: 'MOVIMIENTOS' };
}

async function responderSugerenciasReposicion(texto) {
  // Consulta al servicio predictivo real
  const analisis = await farmaciaIaService.obtenerEstimacionDemandaInventario({ ventanaDias: 30 });
  const resumen = analisis.resumen || {};
  const estimaciones = analisis.estimaciones || [];

  // Filtrar los que requieren reposición
  const conSugerencia = estimaciones.filter((e) => e.estimacion.cantidadSugerida > 0);

  let msg = `🤖 **Estimación de Demanda y Sugerencias de Reposición (IA Consultiva):**\n\n` +
    `• **Medicamentos evaluados:** ${resumen.totalMedicamentos}\n` +
    `• **Ítems que requieren reposición:** ${resumen.requierenReposicion}\n` +
    `• **Total de unidades sugeridas para compra:** ${resumen.totalUnidadesSugeridas} unidades\n` +
    `• **Confiabilidad:** ${resumen.datosSuficientes} con datos históricos suficientes | ${resumen.datosInsuficientes} con datos insuficientes\n\n`;

  if (conSugerencia.length === 0) {
    msg += `🟢 **Todo en orden:** Ningún medicamento requiere compra urgente en base a la rotación de los últimos 30 días y los niveles actuales de existencias.`;
    return { success: true, respuesta: msg, datos: analisis, tipo: 'REPOSICION' };
  }

  msg += `📋 **Principales Fármacos a Reponer:**\n\n`;
  const top = conSugerencia.slice(0, 8);
  for (const item of top) {
    const med = item.medicamento;
    const est = item.estimacion;
    const fiab = est.datosSuficientes ? '✔ Confiable' : '⚠️ Baja (Faltan despachos históricos)';

    msg +=
      `• **${med.nombre}** (\`${med.codigo}\`)\n` +
      `  - Stock Actual: **${item.stockActual}** unid. | Mínimo: ${item.stockMinimo} unid.\n` +
      `  - Demanda estimada (30d): ~${est.demandaProyectada30d} unid. | Cobertura estimada: ${est.diasCobertura !== null ? est.diasCobertura + ' días' : 'Agotado'}\n` +
      `  - 🎯 **Sugerencia de compra: +${est.cantidadSugerida} unidades**\n` +
      `  - Motivo IA: ${est.motivoReposicion}\n` +
      `  - Fiabilidad: ${fiab}\n\n`;
  }

  msg += `*Aviso consultivo: Las sugerencias de la IA son informativas y calculadas a partir del historial real. La decisión final corresponde a la farmacéutica.*`;

  return { success: true, respuesta: msg, datos: analisis, tipo: 'REPOSICION' };
}

// ============================================================================
// HUMAN-IN-THE-LOOP: PREPARACIÓN DE ACCIONES MUTANTES CON CONFIRMACIÓN PREVIA
// ============================================================================

/**
 * 1. Preparar ajuste de stock (propuesta antes de ejecutar)
 */
async function prepararAjusteStock(texto, usuario) {
  // Regex inteligente para extraer: medicamento, cantidad y motivo opcional
  // Ejemplos:
  // "Ajusta el stock de Amoxicilina a 45 unidades por reposición"
  // "Ajusta el stock de Paracetamol a 50"
  // "Cambiar el stock de Ibuprofeno a 30 por llegada de pedido"
  const regexPrincipal = /(?:ajustar?|cambiar?|modificar?|actualizar?)\s+(?:el\s+)?(?:stock|existencias)\s+(?:de\s+)?(.+?)\s+(?:a|en|fijar)\s+(\d+)(?:\s*(?:unidades?|unid|unids?|cajas?|pastillas?))?(?:\s+por\s+(.+))?/i;
  const match = texto.match(regexPrincipal);

  let nombreBuscado = '';
  let cantidadObjetivo = null;
  let motivoExtra = '';

  if (match) {
    nombreBuscado = match[1].trim();
    cantidadObjetivo = parseInt(match[2], 10);
    motivoExtra = match[3] ? match[3].trim() : '';
  } else {
    // Extracción defensiva
    const matchNumero = texto.match(/\b(?:a|en|fijar|aumentar|reducir)?\s*(\d+)\s*(?:unidades|unid|unids|cajas|pastillas)?\b/i);
    if (!matchNumero) {
      return {
        success: true,
        respuesta: 'Por favor indica la cantidad de unidades para el ajuste (ejemplo: *"Ajusta el stock de Amoxicilina a 50 unidades"*).',
        tipo: 'INFO',
      };
    }
    cantidadObjetivo = parseInt(matchNumero[1], 10);
    nombreBuscado = texto
      .replace(matchNumero[0], '')
      .replace(/\b(ajustar|ajusta|el|stock|de|a|existencias|cambiar|fijar|unidades|por reposición|por reposicion|por llegada|por pedido)\b/gi, '')
      .trim();
  }

  if (Number.isNaN(cantidadObjetivo) || cantidadObjetivo < 0) {
    return {
      success: true,
      respuesta: 'La cantidad de existencias debe ser un número entero mayor o igual a cero.',
      tipo: 'ERROR',
    };
  }

  if (!nombreBuscado || nombreBuscado.length < 2) {
    return {
      success: true,
      respuesta: 'Por favor indica el nombre del medicamento a ajustar (ejemplo: *"Ajusta el stock de Ibuprofeno a 30"*).',
      tipo: 'INFO',
    };
  }

  const { rows: meds } = await db.query(
    `SELECT * FROM medicamentos WHERE activo = true AND (nombre ILIKE $1 OR codigo ILIKE $1) ORDER BY nombre ASC LIMIT 1`,
    [`%${nombreBuscado}%`]
  );

  if (meds.length === 0) {
    return {
      success: true,
      respuesta: `No encontré ningún medicamento en inventario que coincida con **"${nombreBuscado}"**. Verifica el nombre.`,
      tipo: 'NO_ENCONTRADO',
    };
  }

  const med = meds[0];
  const stockAnterior = parseInt(med.stock_actual, 10) || 0;
  const diferencia = cantidadObjetivo - stockAnterior;

  if (diferencia === 0) {
    return {
      success: true,
      respuesta: `El medicamento **${med.nombre}** ya tiene exactamente **${stockAnterior} unidades** en existencias. No se requiere ajuste.`,
      tipo: 'INFO',
    };
  }

  // Generar ID de acción pendiente
  const accionId = 'act_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const accion = {
    id: accionId,
    usuarioId: usuario.id,
    tipo: 'AJUSTAR_STOCK',
    titulo: 'Ajuste Manual de Existencias en Inventario',
    medicamentoId: med.id,
    medicamentoNombre: med.nombre,
    medicamentoCodigo: med.codigo,
    stockAnterior,
    stockNuevo: cantidadObjetivo,
    diferencia,
    motivo: motivoExtra ? `Ajuste vía Asistente IA: ${motivoExtra}` : `Ajuste manual solicitado por ${usuario.nombre || 'personal de farmacia'}`,
    expiraEn: Date.now() + 5 * 60 * 1000,
  };

  accionesPendientes.set(accionId, accion);

  const respuesta =
    `⚠️ **Confirmación Requerida para Modificar Existencias:**\n\n` +
    `He preparado el ajuste de inventario con los siguientes datos reales:\n\n` +
    `• **Medicamento:** ${med.nombre} (\`${med.codigo}\`)\n` +
    `• **Stock Actual:** ${stockAnterior} unidades\n` +
    `• **Nuevo Stock Propuesto:** **${cantidadObjetivo} unidades** (${diferencia > 0 ? '+' : ''}${diferencia} unid.)\n` +
    `• **Motivo de Auditoría:** ${motivoExtra || `Ajuste manual solicitado por ${usuario.nombre || 'personal de farmacia'}`}\n\n` +
    `¿Deseas confirmar y aplicar este cambio en el inventario?`;

  return {
    success: true,
    respuesta,
    tipo: 'CONFIRMACION_REQUERIDA',
    accionPendiente: {
      id: accionId,
      tipo: 'AJUSTAR_STOCK',
      titulo: 'Confirmar Ajuste de Existencias',
      detalles: [
        { etiqueta: 'Medicamento', valor: `${med.nombre} (${med.codigo})` },
        { etiqueta: 'Stock Anterior', valor: `${stockAnterior} unid.` },
        { etiqueta: 'Stock Nuevo', valor: `${cantidadObjetivo} unid.` },
        { etiqueta: 'Variación', valor: `${diferencia > 0 ? '+' : ''}${diferencia} unid.` },
      ],
    },
  };
}

/**
 * 2. Preparar entrega de ítem de receta (propuesta antes de ejecutar)
 */
async function prepararEntregaReceta(texto, usuario) {
  // Extraer código de receta si se especificó
  const matchRx = texto.match(/RX-[A-Z0-9\-]+/i);
  const codRx = matchRx ? matchRx[0].toUpperCase() : null;

  // Extraer nombre de medicamento o término
  let terminoMed = texto.replace(/RX-[A-Z0-9\-]+/i, '').replace(/\b(entrega|entregar|el|la|los|las|medicamento|receta|de|en|por)\b/gi, '').trim();

  let sql = `
    SELECT rd.id AS detalle_id, rd.nombre_medicamento, rd.cantidad_recetada, rd.estado_dispensacion,
           r.id AS receta_id, r.codigo_receta,
           p.nombre AS pac_nombre, p.apellido AS pac_apellido, a.nombre AS ars_nombre,
           m.id AS med_id, m.nombre AS med_real_nombre, m.stock_actual
    FROM receta_detalles rd
    INNER JOIN recetas r ON rd.receta_id = r.id
    INNER JOIN pacientes p ON r.paciente_id = p.id
    LEFT JOIN ars a ON p.ars_id = a.id
    LEFT JOIN medicamentos m ON rd.medicamento_id = m.id OR LOWER(TRIM(rd.nombre_medicamento)) = LOWER(TRIM(m.nombre))
    WHERE rd.estado_dispensacion = 'Pendiente'
  `;
  const params = [];

  if (codRx) {
    params.push(codRx);
    sql += ` AND r.codigo_receta = $${params.length}`;
  }

  if (terminoMed && terminoMed.length >= 2) {
    params.push(`%${terminoMed}%`);
    sql += ` AND (rd.nombre_medicamento ILIKE $${params.length} OR m.nombre ILIKE $${params.length})`;
  }

  sql += ` ORDER BY r.fecha_emision ASC, rd.id ASC LIMIT 1`;

  const { rows: items } = await db.query(sql, params);

  if (items.length === 0) {
    return {
      success: true,
      respuesta: `No encontré ningún ítem pendiente de dispensación que coincida con tu solicitud${codRx ? ` en la receta ${codRx}` : ''}. Verifica el código o el nombre del fármaco.`,
      tipo: 'NO_ENCONTRADO',
    };
  }

  const item = items[0];
  const stockActual = parseInt(item.stock_actual, 10) || 0;
  const cantSolicitada = parseInt(item.cantidad_recetada, 10) || 1;

  // REGLA ESTRICTA DE FARMACIA: No se puede entregar lo que no se tiene
  if (stockActual < cantSolicitada) {
    return {
      success: true,
      respuesta:
        `⛔ **Existencias Insuficientes:**\n\n` +
        `El medicamento **"${item.nombre_medicamento}"** de la receta **\`${item.codigo_receta}\`** solo cuenta con **${stockActual} unidades** disponibles en inventario y la prescripción solicita **${cantSolicitada} unidades**.\n\n` +
        `Por normativa de farmacia, **no es posible descontar ni marcar como entregado lo que no se dio**.\n\n` +
        `Puedes registrarlo como **No entregado** indicando el motivo correspondiente (ej: *"Marca como no entregado por falta de existencias"*).`,
      tipo: 'INSUFICIENTE',
    };
  }

  const tieneArs = Boolean(item.ars_nombre && item.ars_nombre.toLowerCase() !== 'particular');
  const nuevoStock = stockActual - cantSolicitada;

  // Generar ID de acción pendiente
  const accionId = 'act_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const accion = {
    id: accionId,
    usuarioId: usuario.id,
    tipo: 'ENTREGAR_ITEM',
    titulo: 'Dispensar Medicamento de Receta',
    detalleId: item.detalle_id,
    recetaId: item.receta_id,
    codigoReceta: item.codigo_receta,
    medicamentoId: item.med_id,
    medicamentoNombre: item.nombre_medicamento,
    cantidad: cantSolicitada,
    stockAnterior: stockActual,
    stockNuevo: nuevoStock,
    arsNombre: item.ars_nombre,
    cubiertoArs: tieneArs,
    pacienteNombre: `${item.pac_nombre} ${item.pac_apellido}`,
    expiraEn: Date.now() + 5 * 60 * 1000,
  };

  accionesPendientes.set(accionId, accion);

  const respuesta =
    `⚠️ **Confirmación Requerida para Registrar Entrega:**\n\n` +
    `He preparado el registro de entrega con los siguientes datos verificados:\n\n` +
    `• **Receta:** \`${item.codigo_receta}\` | Paciente: **${item.pac_nombre} ${item.pac_apellido}**\n` +
    `• **Medicamento:** ${item.nombre_medicamento}\n` +
    `• **Cantidad a entregar:** **${cantSolicitada} unidades**\n` +
    `• **Impacto en Inventario:** Stock actual ${stockActual} ➔ **Nuevo stock: ${nuevoStock} unidades**\n` +
    `• **Cobertura:** ${tieneArs ? `Cobertura ARS aplicada (${item.ars_nombre})` : 'Particular (Sin cobertura de seguro)'}\n\n` +
    `¿Deseas confirmar la entrega de este medicamento?`;

  return {
    success: true,
    respuesta,
    tipo: 'CONFIRMACION_REQUERIDA',
    accionPendiente: {
      id: accionId,
      tipo: 'ENTREGAR_ITEM',
      titulo: 'Confirmar Entrega de Medicamento',
      detalles: [
        { etiqueta: 'Receta', valor: item.codigo_receta },
        { etiqueta: 'Paciente', valor: `${item.pac_nombre} ${item.pac_apellido}` },
        { etiqueta: 'Medicamento', valor: item.nombre_medicamento },
        { etiqueta: 'Cantidad', valor: `${cantSolicitada} unid.` },
        { etiqueta: 'Stock Resultante', valor: `${nuevoStock} unid.` },
        { etiqueta: 'Cobertura', valor: tieneArs ? `ARS ${item.ars_nombre}` : 'Particular' },
      ],
    },
  };
}

/**
 * 3. Preparar registro de ítem no entregado (propuesta antes de ejecutar)
 */
async function prepararNoEntregaReceta(texto, usuario) {
  const matchRx = texto.match(/RX-[A-Z0-9\-]+/i);
  const codRx = matchRx ? matchRx[0].toUpperCase() : null;

  // Extraer posible motivo
  let motivo = 'Sin existencias en farmacia interna';
  if (texto.includes('comprará fuera') || texto.includes('comprara fuera')) {
    motivo = 'Paciente lo comprará fuera en farmacia externa';
  } else if (texto.includes('no cubierto') || texto.includes('seguro')) {
    motivo = 'No cubierto por el seguro; paciente no autorizó compra particular';
  } else if (texto.includes('motivo')) {
    const partes = texto.split(/motivo\s*(?:es|:)?/i);
    if (partes[1]) motivo = partes[1].trim();
  }

  let sql = `
    SELECT rd.id AS detalle_id, rd.nombre_medicamento, rd.cantidad_recetada, rd.estado_dispensacion,
           r.id AS receta_id, r.codigo_receta,
           p.nombre AS pac_nombre, p.apellido AS pac_apellido,
           m.stock_actual
    FROM receta_detalles rd
    INNER JOIN recetas r ON rd.receta_id = r.id
    INNER JOIN pacientes p ON r.paciente_id = p.id
    LEFT JOIN medicamentos m ON rd.medicamento_id = m.id
    WHERE rd.estado_dispensacion = 'Pendiente'
  `;
  const params = [];

  if (codRx) {
    params.push(codRx);
    sql += ` AND r.codigo_receta = $1`;
  }

  sql += ` ORDER BY r.fecha_emision ASC, rd.id ASC LIMIT 1`;

  const { rows: items } = await db.query(sql, params);

  if (items.length === 0) {
    return {
      success: true,
      respuesta: `No encontré ningún ítem pendiente de dispensación para marcar como no entregado${codRx ? ` en la receta ${codRx}` : ''}.`,
      tipo: 'NO_ENCONTRADO',
    };
  }

  const item = items[0];
  const stockActual = parseInt(item.stock_actual, 10) || 0;

  const accionId = 'act_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const accion = {
    id: accionId,
    usuarioId: usuario.id,
    tipo: 'NO_ENTREGAR_ITEM',
    titulo: 'Registrar Medicamento No Entregado',
    detalleId: item.detalle_id,
    recetaId: item.receta_id,
    codigoReceta: item.codigo_receta,
    medicamentoNombre: item.nombre_medicamento,
    cantidad: item.cantidad_recetada,
    motivo,
    stockActual,
    pacienteNombre: `${item.pac_nombre} ${item.pac_apellido}`,
    expiraEn: Date.now() + 5 * 60 * 1000,
  };

  accionesPendientes.set(accionId, accion);

  const respuesta =
    `⚠️ **Confirmación Requerida para Registrar No Entrega:**\n\n` +
    `He preparado el registro de incidencia con los siguientes datos:\n\n` +
    `• **Receta:** \`${item.codigo_receta}\` | Paciente: **${item.pac_nombre} ${item.pac_apellido}**\n` +
    `• **Medicamento:** ${item.nombre_medicamento} (${item.cantidad_recetada} unid.)\n` +
    `• **Motivo Registrado:** **"${motivo}"**\n` +
    `• **Inventario:** **NO se descontará stock** (se mantendrán intactas las ${stockActual} unidades actuales).\n\n` +
    `¿Deseas confirmar este registro de no entrega?`;

  return {
    success: true,
    respuesta,
    tipo: 'CONFIRMACION_REQUERIDA',
    accionPendiente: {
      id: accionId,
      tipo: 'NO_ENTREGAR_ITEM',
      titulo: 'Confirmar No Entrega',
      detalles: [
        { etiqueta: 'Receta', valor: item.codigo_receta },
        { etiqueta: 'Paciente', valor: `${item.pac_nombre} ${item.pac_apellido}` },
        { etiqueta: 'Medicamento', valor: item.nombre_medicamento },
        { etiqueta: 'Motivo', valor: motivo },
        { etiqueta: 'Stock Físico', valor: 'Sin deducción (intacto)' },
      ],
    },
  };
}

// ============================================================================
// EJECUCIÓN ATÓMICA DE ACCIÓN CONFIRMADA
// ============================================================================

async function ejecutarAccionConfirmada(accionId, usuario) {
  const accion = accionesPendientes.get(accionId);

  if (!accion) {
    return {
      success: false,
      respuesta: 'La acción solicitada ya no está disponible o ha expirado (límite de 5 minutos). Por favor formula la instrucción nuevamente.',
      tipo: 'ERROR',
    };
  }

  // Eliminar para evitar doble ejecución concurrente
  accionesPendientes.delete(accionId);

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    if (accion.tipo === 'AJUSTAR_STOCK') {
      // 1. Bloquear y verificar medicamento
      const { rows: medRows } = await client.query(
        `SELECT id, stock_actual, nombre FROM medicamentos WHERE id = $1 FOR UPDATE`,
        [accion.medicamentoId]
      );

      if (medRows.length === 0) {
        throw new Error('Medicamento no encontrado en inventario.');
      }

      const stockPrevio = medRows[0].stock_actual;

      // 2. Actualizar stock
      await client.query(
        `UPDATE medicamentos SET stock_actual = $1 WHERE id = $2`,
        [accion.stockNuevo, accion.medicamentoId]
      );

      // 3. Registrar en kardex
      await client.query(
        `INSERT INTO farmacia_movimientos (
          medicamento_id, tipo_movimiento, cantidad,
          stock_anterior, stock_nuevo, motivo, usuario_id
        ) VALUES ($1, 'AJUSTE', $2, $3, $4, $5, $6)`,
        [
          accion.medicamentoId,
          Math.abs(accion.diferencia),
          stockPrevio,
          accion.stockNuevo,
          accion.motivo,
          usuario && usuario.id ? usuario.id : null,
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        respuesta:
          `✔ **Ajuste Aplicado Exitosamente en Inventario:**\n\n` +
          `• Medicamento: **${accion.medicamentoNombre}**\n` +
          `• Stock modificado: de **${stockPrevio}** a **${accion.stockNuevo} unidades** (${accion.diferencia > 0 ? '+' : ''}${accion.diferencia})\n` +
          `• Movimiento registrado en kardex con motivo: *"${accion.motivo}"*.\n` +
          `• Operador: ${usuario.nombre || 'Personal de Farmacia'}`,
        tipo: 'EXITO',
      };
    }

    if (accion.tipo === 'ENTREGAR_ITEM') {
      // 1. Bloquear ítem de receta
      const { rows: detRows } = await client.query(
        `SELECT rd.*, r.codigo_receta FROM receta_detalles rd
         INNER JOIN recetas r ON rd.receta_id = r.id
         WHERE rd.id = $1 FOR UPDATE OF rd`,
        [accion.detalleId]
      );

      if (detRows.length === 0 || detRows[0].estado_dispensacion === 'Entregado') {
        throw new Error('El ítem de la receta no existe o ya fue entregado previamente.');
      }

      // 2. Bloquear y descontar medicamento
      const { rows: medRows } = await client.query(
        `SELECT id, stock_actual FROM medicamentos WHERE id = $1 FOR UPDATE`,
        [accion.medicamentoId]
      );

      if (medRows.length === 0 || medRows[0].stock_actual < accion.cantidad) {
        throw new Error('Existencias insuficientes para completar la entrega.');
      }

      const stockPrevio = medRows[0].stock_actual;

      // Descontar atómicamente
      const { rows: updMed } = await client.query(
        `UPDATE medicamentos
         SET stock_actual = stock_actual - $1
         WHERE id = $2 AND stock_actual >= $1
         RETURNING stock_actual`,
        [accion.cantidad, accion.medicamentoId]
      );

      const nuevoStock = updMed[0].stock_actual;

      const obs = accion.cubiertoArs
        ? `Entregado vía Asistente IA (${accion.cantidad} unid.). Cobertura ARS aplicada: ${accion.arsNombre}.`
        : `Entregado vía Asistente IA (${accion.cantidad} unid.). Particular / Sin seguro.`;

      // 3. Actualizar receta
      await client.query(
        `UPDATE receta_detalles
         SET estado_dispensacion = 'Entregado',
             fecha_dispensacion = CURRENT_TIMESTAMP,
             observacion_farmacia = $1,
             cobertura_utilizada = $2
         WHERE id = $3`,
        [obs, accion.cubiertoArs, accion.detalleId]
      );

      // 4. Registrar en kardex
      await client.query(
        `INSERT INTO farmacia_movimientos (
          receta_detalle_id, medicamento_id, tipo_movimiento,
          cantidad, stock_anterior, stock_nuevo, motivo, usuario_id
        ) VALUES ($1, $2, 'SALIDA_RECETA', $3, $4, $5, $6, $7)`,
        [
          accion.detalleId,
          accion.medicamentoId,
          accion.cantidad,
          stockPrevio,
          nuevoStock,
          `Despacho receta ${accion.codigoReceta} (Vía Asistente IA)`,
          usuario && usuario.id ? usuario.id : null,
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        respuesta:
          `✔ **Entrega Registrada Exitosamente:**\n\n` +
          `• Medicamento: **${accion.medicamentoNombre}** (${accion.cantidad} unidades entregadas)\n` +
          `• Receta: **\`${accion.codigoReceta}\`** | Paciente: **${accion.pacienteNombre}**\n` +
          `• Cobertura: ${accion.cubiertoArs ? `ARS ${accion.arsNombre} (Aplicada)` : 'Particular'}\n` +
          `• Inventario descontado: de **${stockPrevio}** a **${nuevoStock} unidades** restantes.\n` +
          `• Salida asentada en el kardex de farmacia.`,
        tipo: 'EXITO',
      };
    }

    if (accion.tipo === 'NO_ENTREGAR_ITEM') {
      // 1. Bloquear ítem de receta
      const { rows: detRows } = await client.query(
        `SELECT rd.*, r.codigo_receta FROM receta_detalles rd
         INNER JOIN recetas r ON rd.receta_id = r.id
         WHERE rd.id = $1 FOR UPDATE OF rd`,
        [accion.detalleId]
      );

      if (detRows.length === 0 || detRows[0].estado_dispensacion === 'Entregado') {
        throw new Error('El ítem de la receta no existe o ya fue entregado previamente.');
      }

      // 2. Actualizar a No entregado con motivo
      await client.query(
        `UPDATE receta_detalles
         SET estado_dispensacion = 'No entregado',
             fecha_dispensacion = CURRENT_TIMESTAMP,
             observacion_farmacia = $1,
             motivo_no_entrega = $1,
             cobertura_utilizada = false
         WHERE id = $2`,
        [accion.motivo, accion.detalleId]
      );

      // 3. Registrar incidencia en movimientos SIN descontar inventario
      await client.query(
        `INSERT INTO farmacia_movimientos (
          receta_detalle_id, medicamento_id, tipo_movimiento,
          cantidad, stock_anterior, stock_nuevo, motivo, usuario_id
        ) VALUES ($1, $2, 'NO_ENTREGADO', $3, $4, $4, $5, $6)`,
        [
          accion.detalleId,
          detRows[0].medicamento_id || null,
          accion.cantidad,
          accion.stockActual,
          `No entregado vía Asistente IA: ${accion.motivo}`,
          usuario && usuario.id ? usuario.id : null,
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        respuesta:
          `✔ **No Entrega Registrada Correctamente:**\n\n` +
          `• Medicamento: **${accion.medicamentoNombre}** en receta **\`${accion.codigoReceta}\`**\n` +
          `• Motivo registrado: *"${accion.motivo}"*\n` +
          `• Paciente: ${accion.pacienteNombre}\n` +
          `• **Inventario intacto:** Se mantuvieron las ${accion.stockActual} unidades sin ninguna deducción.\n` +
          `• Incidencia registrada en kardex para fines de auditoría.`,
        tipo: 'EXITO',
      };
    }

    await client.query('ROLLBACK');
    return {
      success: false,
      respuesta: 'Tipo de acción no reconocido.',
      tipo: 'ERROR',
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[ERROR ACCION CONFIRMADA FARMACIA]:', error);
    return {
      success: false,
      respuesta: 'No se pudo completar la operación en la base de datos: ' + error.message,
      tipo: 'ERROR',
    };
  } finally {
    client.release();
  }
}

module.exports = {
  procesarMensaje,
  accionesPendientes,
};
