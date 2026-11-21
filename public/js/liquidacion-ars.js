/**
 * Liquidación de una consulta con ARS: ÚNICA fuente de la regla de cobro.
 * La usan el servidor (require) y el navegador (window.liquidarArs).
 *
 * Regla: Facturado = Cubierto por la ARS + Lo que paga el paciente (siempre cuadra).
 *  - PORCENTAJE: la ARS cubre tarifa × % ; MONTO_FIJO: la ARS cubre ese monto (máx. la tarifa).
 *  - El copago fijo del tarifario va INCLUIDO en lo que paga el paciente: es el mínimo que paga.
 *    Si lo no cubierto es menor que el copago fijo, la ARS cubre un poco menos.
 */
(function (raiz) {
  function redondear2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function liquidarArs({ valorTotal, tipoCobertura, valorCobertura, copagoFijo }) {
    const total = Math.max(0, parseFloat(valorTotal) || 0);
    const valor = Math.max(0, parseFloat(valorCobertura) || 0);
    const copagoMinimo = Math.max(0, parseFloat(copagoFijo) || 0);

    let cubierto = tipoCobertura === 'PORCENTAJE' ? (total * Math.min(valor, 100)) / 100 : Math.min(total, valor);
    cubierto = Math.min(cubierto, Math.max(0, total - copagoMinimo));
    cubierto = redondear2(Math.max(0, cubierto));

    return {
      valorTotal: redondear2(total),
      valorCubierto: cubierto,
      diferenciaPaciente: redondear2(total - cubierto),
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { liquidarArs, redondear2 };
  } else {
    raiz.liquidarArs = liquidarArs;
  }
})(typeof window !== 'undefined' ? window : this);
