const db = require('../config/db');

/**
 * Servicio de Inteligencia Artificial Consultiva para Farmacia Interna.
 *
 * Responsabilidades:
 * 1. Estimar la demanda de medicamentos a partir del historial real de dispensaciones
 *    y los niveles actuales de existencias.
 * 2. Generar sugerencias inteligentes de reposición (cantidades objetivo y días de cobertura).
 * 3. Identificar con total transparencia cuándo faltan datos históricos suficientes para
 *    garantizar una estimación confiable.
 *
 * Restricción estricta de diseño:
 * La IA es 100% consultiva/informativa. NUNCA modifica el inventario ni crea órdenes de compra automáticamente.
 */

const DIAS_VENTANA_ANALISIS = 30; // Período base para análisis de rotación mensual
const MINIMO_DISPENSACIONES_CONFIABLES = 3; // Mínimo de movimientos para considerar la estimación confiable

/**
 * Analiza el inventario completo de medicamentos y calcula proyecciones de demanda y sugerencias de reposición.
 */
async function obtenerEstimacionDemandaInventario({ ventanaDias = DIAS_VENTANA_ANALISIS } = {}) {
  // 1. Obtener medicamentos activos con stock actual y mínimo
  const { rows: medicamentos } = await db.query(
    `SELECT id, codigo, nombre, principio_activo, concentracion, presentacion,
            stock_actual, stock_minimo, ubicacion, lote, fecha_vencimiento
     FROM medicamentos
     WHERE activo = true
     ORDER BY nombre ASC`
  );

  // 2. Obtener historial de dispensaciones entregadas (salidas reales a pacientes)
  // en la ventana de análisis seleccionada
  const { rows: historial } = await db.query(
    `SELECT rd.medicamento_id,
            COUNT(rd.id) AS conteo_dispensaciones,
            COALESCE(SUM(rd.cantidad_recetada), 0) AS total_unidades_despachadas,
            MIN(COALESCE(rd.fecha_dispensacion, r.fecha_emision)) AS primer_despacho,
            MAX(COALESCE(rd.fecha_dispensacion, r.fecha_emision)) AS ultimo_despacho,
            COUNT(DISTINCT DATE(COALESCE(rd.fecha_dispensacion, r.fecha_emision))) AS dias_con_despacho
     FROM receta_detalles rd
     INNER JOIN recetas r ON rd.receta_id = r.id
     WHERE rd.estado_dispensacion = 'Entregado'
       AND COALESCE(rd.fecha_dispensacion, r.fecha_emision) >= CURRENT_TIMESTAMP - ($1 || ' days')::INTERVAL
       AND rd.medicamento_id IS NOT NULL
     GROUP BY rd.medicamento_id`,
    [ventanaDias]
  );

  // Indexar historial por medicamento_id para búsqueda O(1)
  const mapaHistorial = new Map();
  for (const h of historial) {
    mapaHistorial.set(Number(h.medicamento_id), {
      conteoDispensaciones: parseInt(h.conteo_dispensaciones, 10) || 0,
      totalUnidadesDespachadas: parseInt(h.total_unidades_despachadas, 10) || 0,
      primerDespacho: h.primer_despacho,
      ultimoDespacho: h.ultimo_despacho,
      diasConDespacho: parseInt(h.dias_con_despacho, 10) || 0,
    });
  }

  // 3. Procesar cada medicamento aplicando el modelo de estimación
  const estimaciones = [];
  let totalRequierenReposicion = 0;
  let totalUnidadesSugeridas = 0;
  let totalDatosInsuficientes = 0;
  let totalEstimacionesConfiables = 0;

  for (const med of medicamentos) {
    const medId = Number(med.id);
    const hist = mapaHistorial.get(medId) || {
      conteoDispensaciones: 0,
      totalUnidadesDespachadas: 0,
      primerDespacho: null,
      ultimoDespacho: null,
      diasConDespacho: 0,
    };

    const stockActual = parseInt(med.stock_actual, 10) || 0;
    const stockMinimo = parseInt(med.stock_minimo, 10) || 5;

    // Evaluación de suficiencia de datos históricos
    const datosSuficientes = hist.conteoDispensaciones >= MINIMO_DISPENSACIONES_CONFIABLES && hist.totalUnidadesDespachadas > 0;

    let nivelConfianza = 'Bajo (Datos insuficientes)';
    let motivoInsuficiencia = null;

    if (!datosSuficientes) {
      totalDatosInsuficientes++;
      if (hist.conteoDispensaciones === 0) {
        motivoInsuficiencia = 'No se registran dispensaciones entregadas en los últimos ' + ventanaDias + ' días. Faltan datos para proyectar una demanda representativa.';
      } else {
        motivoInsuficiencia = `Solo se registran ${hist.conteoDispensaciones} dispensaciones en el período (se requieren al menos ${MINIMO_DISPENSACIONES_CONFIABLES} para inferir una tasa de consumo confiable).`;
      }
    } else {
      totalEstimacionesConfiables++;
      nivelConfianza = hist.conteoDispensaciones >= 10 ? 'Alto' : 'Medio';
    }

    // Demanda diaria promedio estimada
    const demandaDiaria = datosSuficientes ? Number((hist.totalUnidadesDespachadas / ventanaDias).toFixed(2)) : 0;

    // Demanda mensual proyectada (próximos 30 días)
    const demandaProyectada30d = datosSuficientes ? Math.round(demandaDiaria * 30) : 0;

    // Días estimados de cobertura con el stock actual
    let diasCobertura = null;
    if (stockActual <= 0) {
      diasCobertura = 0;
    } else if (demandaDiaria > 0) {
      diasCobertura = Math.round(stockActual / demandaDiaria);
    }

    // Cálculo de sugerencia de reposición:
    // Modelo de inventario de punto de reorden:
    // Stock objetivo = Demanda esperada en 30 días + Margen de seguridad (stock_minimo)
    // Cantidad sugerida = max(0, Stock objetivo - Stock actual)
    let cantidadSugerida = 0;
    if (datosSuficientes) {
      const stockObjetivo = Math.ceil(demandaDiaria * 30) + stockMinimo;
      cantidadSugerida = Math.max(0, stockObjetivo - stockActual);
    } else {
      // Cuando faltan datos de demanda, la sugerencia prudente es solo completar el stock mínimo si está por debajo
      if (stockActual < stockMinimo) {
        cantidadSugerida = stockMinimo - stockActual;
      }
    }

    // Determinación de estado y prioridad por la IA
    let prioridad = 'ADECUADO';
    let estadoEtiqueta = 'Nivel Adecuado';
    let badgeClase = 'bg-success-subtle text-success border border-success';
    let icono = 'bi-check-circle-fill';

    if (stockActual <= 0) {
      prioridad = 'URGENTE';
      estadoEtiqueta = 'Agotado (0 unid.)';
      badgeClase = 'bg-danger text-white';
      icono = 'bi-exclamation-octagon-fill';
    } else if (diasCobertura !== null && diasCobertura <= 7) {
      prioridad = 'CRITICA';
      estadoEtiqueta = `Crítico (${diasCobertura} días de cobertura)`;
      badgeClase = 'bg-danger-subtle text-danger border border-danger';
      icono = 'bi-exclamation-triangle-fill';
    } else if (stockActual <= stockMinimo || (diasCobertura !== null && diasCobertura <= 15)) {
      prioridad = 'MODERADA';
      estadoEtiqueta = `Reposición Recomendada (${diasCobertura !== null ? diasCobertura + ' d.' : 'Bajo'})`;
      badgeClase = 'bg-warning text-dark';
      icono = 'bi-hourglass-split';
    } else if (!datosSuficientes) {
      prioridad = 'SIN_DATOS';
      estadoEtiqueta = 'Datos Insuficientes';
      badgeClase = 'bg-secondary-subtle text-secondary border';
      icono = 'bi-question-circle';
    }

    // Análisis de fechas de vencimiento del lote
    let diasHastaVencimiento = null;
    let proximoAVencer = false;
    let loteVencido = false;
    if (med.fecha_vencimiento) {
      const fechaV = new Date(med.fecha_vencimiento);
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      fechaV.setHours(0, 0, 0, 0);
      diasHastaVencimiento = Math.round((fechaV.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
      loteVencido = diasHastaVencimiento <= 0;
      proximoAVencer = diasHastaVencimiento <= 90;
    }

    const proximoAgotamiento = stockActual <= stockMinimo || (diasCobertura !== null && diasCobertura <= 15);

    // Motivo explícito de la sugerencia calculado por la IA
    let motivoReposicion = '';
    if (stockActual <= 0) {
      motivoReposicion = datosSuficientes
        ? `Agotado: Existencias en 0. Reponer demanda estimada de 30 días (~${demandaProyectada30d} unid.) más reserva mínima (${stockMinimo} unid.).`
        : `Agotado: Reposición urgente sugerida para alcanzar el margen de seguridad mínimo (${stockMinimo} unid.). Faltan datos históricos.`;
    } else if (diasCobertura !== null && diasCobertura <= 7) {
      motivoReposicion = `Agotamiento inminente: Existencias actuales solo alcanzan para ~${diasCobertura} días (consumo promedio ~${demandaDiaria} unid./día).`;
    } else if (stockActual <= stockMinimo) {
      motivoReposicion = datosSuficientes
        ? `Stock bajo mínimo de seguridad (${stockMinimo} unid.): Reponer +${cantidadSugerida} unid. para garantizar demanda de 30 días.`
        : `Stock bajo (${stockActual} unid., mínimo ${stockMinimo} unid.): Reponer +${cantidadSugerida} unid. para margen de seguridad.`;
    } else if (cantidadSugerida > 0) {
      motivoReposicion = `La demanda mensual esperada (~${demandaProyectada30d} unid.) superará las existencias disponibles en ~${diasCobertura} días.`;
    } else {
      motivoReposicion = `Existencias suficientes para cubrir la demanda proyectada (${diasCobertura !== null ? '~' + diasCobertura + ' días de cobertura' : 'sin rotación reciente'}).`;
    }

    if (loteVencido) {
      motivoReposicion += ' [ALERTA: Lote vencido; requiere retiro y reemplazo inmediato].';
    } else if (proximoAVencer) {
      motivoReposicion += ` [ATENCIÓN: Lote vence en ${diasHastaVencimiento} días; priorizar rotación antes de nuevo ingreso].`;
    }

    if (cantidadSugerida > 0) {
      totalRequierenReposicion++;
      totalUnidadesSugeridas += cantidadSugerida;
    }

    estimaciones.push({
      medicamento: {
        id: med.id,
        codigo: med.codigo,
        nombre: med.nombre,
        principioActivo: med.principio_activo,
        concentracion: med.concentracion,
        presentacion: med.presentacion,
        ubicacion: med.ubicacion,
        lote: med.lote,
        fechaVencimiento: med.fecha_vencimiento,
      },
      stockActual,
      stockMinimo,
      historial: {
        totalDespachado: hist.totalUnidadesDespachadas,
        conteoDispensaciones: hist.conteoDispensaciones,
        diasConDespacho: hist.diasConDespacho,
        primerDespacho: hist.primerDespacho,
        ultimoDespacho: hist.ultimoDespacho,
      },
      estimacion: {
        datosSuficientes,
        nivelConfianza,
        motivoInsuficiencia,
        motivoReposicion,
        proximoAgotamiento,
        proximoAVencer,
        loteVencido,
        diasHastaVencimiento,
        demandaDiaria,
        demandaProyectada30d,
        diasCobertura,
        cantidadSugerida,
        prioridad,
        estadoEtiqueta,
        badgeClase,
        icono,
      },
    });
  }

  // Ordenar priorizando los que necesitan reposición urgente / crítica
  const pesoPrioridad = {
    URGENTE: 1,
    CRITICA: 2,
    MODERADA: 3,
    SIN_DATOS: 4,
    ADECUADO: 5,
  };
  estimaciones.sort((a, b) => {
    const pesoA = pesoPrioridad[a.estimacion.prioridad] || 99;
    const pesoB = pesoPrioridad[b.estimacion.prioridad] || 99;
    if (pesoA !== pesoB) return pesoA - pesoB;
    return a.stockActual - b.stockActual;
  });

  return {
    parametros: {
      ventanaDias,
      minimoMovimientos: MINIMO_DISPENSACIONES_CONFIABLES,
      fechaAnalisis: new Date(),
    },
    resumen: {
      totalMedicamentos: medicamentos.length,
      requierenReposicion: totalRequierenReposicion,
      totalUnidadesSugeridas,
      datosSuficientes: totalEstimacionesConfiables,
      datosInsuficientes: totalDatosInsuficientes,
    },
    avisoConsultivo:
      'Asistente de IA consultivo: Las estimaciones y sugerencias de reposición se calculan en base al historial de dispensaciones entregadas. La IA no modifica el inventario ni crea órdenes de compra automáticamente; la decisión de abastecimiento corresponde al personal de farmacia.',
    estimaciones,
  };
}

module.exports = {
  obtenerEstimacionDemandaInventario,
  DIAS_VENTANA_ANALISIS,
  MINIMO_DISPENSACIONES_CONFIABLES,
};

