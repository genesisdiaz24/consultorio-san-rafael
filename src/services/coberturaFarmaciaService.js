/**
 * Cálculo de cobertura de ARS para medicamentos despachados en la farmacia interna.
 *
 * Reglas:
 *  - Paciente sin ARS (o con "ARS Privado / Sin Seguro", o con una ARS desactivada) → paga el 100%.
 *  - Paciente con ARS, pero el medicamento no tiene cobertura activa con esa ARS → paga el 100% ("No cubierto").
 *  - Paciente con ARS que cubre el medicamento → la ARS paga el porcentaje configurado y el paciente el resto.
 */

const CODIGOS_SIN_SEGURO = ['PRIV'];

function redondear2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** true si el paciente tiene una ARS real y activa (no "Particular / Sin Seguro"). */
function tieneArsValida(ars) {
  return Boolean(ars && ars.id && ars.activo !== false && !CODIGOS_SIN_SEGURO.includes(String(ars.codigo || '').toUpperCase()));
}

/**
 * @param {object} p
 * @param {number|string} p.precioUnitario  precio por unidad del medicamento
 * @param {number|string} p.cantidad        unidades
 * @param {{id,nombre,codigo,activo}|null} p.ars  ARS del paciente
 * @param {number|string|null} p.porcentajeCobertura  % que cubre esa ARS para el medicamento (null si no hay cobertura activa)
 * @returns {{estado:'CUBIERTO'|'NO_CUBIERTO'|'SIN_ARS', precioUnitario, cantidad, montoTotal, porcentaje, montoCubierto, montoPaciente, arsId, arsNombre, mensaje}}
 */
function calcularCobertura({ precioUnitario, cantidad, ars, porcentajeCobertura }) {
  const precio = Math.max(0, Number(precioUnitario) || 0);
  const unidades = Math.max(0, parseInt(cantidad, 10) || 0);
  const montoTotal = redondear2(precio * unidades);
  const arsValida = tieneArsValida(ars);
  const pct = Number(porcentajeCobertura);
  const cubierto = arsValida && Number.isFinite(pct) && pct > 0;

  if (!cubierto) {
    return {
      estado: arsValida ? 'NO_CUBIERTO' : 'SIN_ARS',
      precioUnitario: precio,
      cantidad: unidades,
      montoTotal,
      porcentaje: 0,
      montoCubierto: 0,
      montoPaciente: montoTotal,
      arsId: arsValida ? ars.id : null,
      arsNombre: arsValida ? ars.nombre : null,
      mensaje: arsValida
        ? `No cubierto por ${ars.nombre}: el paciente paga el 100%.`
        : 'Paciente sin ARS: paga el 100%.',
    };
  }

  const porcentaje = Math.min(100, pct);
  const montoCubierto = redondear2((montoTotal * porcentaje) / 100);
  const montoPaciente = redondear2(montoTotal - montoCubierto);
  return {
    estado: 'CUBIERTO',
    precioUnitario: precio,
    cantidad: unidades,
    montoTotal,
    porcentaje,
    montoCubierto,
    montoPaciente,
    arsId: ars.id,
    arsNombre: ars.nombre,
    mensaje: `${ars.nombre} cubre el ${porcentaje}%.`,
  };
}

/** Suma los desgloses de varios ítems. */
function totalizar(desgloses) {
  return desgloses.reduce(
    (acc, d) => ({
      montoTotal: redondear2(acc.montoTotal + (Number(d.montoTotal) || 0)),
      montoCubierto: redondear2(acc.montoCubierto + (Number(d.montoCubierto) || 0)),
      montoPaciente: redondear2(acc.montoPaciente + (Number(d.montoPaciente) || 0)),
    }),
    { montoTotal: 0, montoCubierto: 0, montoPaciente: 0 }
  );
}

/** Convierte las columnas congeladas de receta_detalles (ítem ya entregado) al mismo formato. */
function desgloseDesdeDetalle(rd) {
  return {
    estado: rd.cobertura_estado || 'SIN_ARS',
    precioUnitario: Number(rd.precio_unitario) || 0,
    cantidad: parseInt(rd.cantidad_recetada, 10) || 0,
    montoTotal: Number(rd.monto_total) || 0,
    porcentaje: Number(rd.porcentaje_cobertura) || 0,
    montoCubierto: Number(rd.monto_cubierto_ars) || 0,
    montoPaciente: Number(rd.monto_paciente) || 0,
    arsId: rd.ars_cobertura_id || null,
    arsNombre: rd.ars_cobertura_nombre || null,
    mensaje: '',
  };
}

module.exports = {
  calcularCobertura,
  totalizar,
  desgloseDesdeDetalle,
  tieneArsValida,
  redondear2,
  CODIGOS_SIN_SEGURO,
};
