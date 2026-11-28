/**
 * Utilidades clínicas compartidas por vistas y controladores.
 */

// Textos que significan "sin alergias" (misma regla que el reporte 1.5 de alergias)
const SIN_ALERGIAS = /^(ningun|niega|negad|no( |$|\.|,|ref|tiene|conoc|presenta)|n\/?a$|sin alerg|desconoc|-+$)/i;

// true solo si el paciente tiene alergias registradas de verdad
function tieneAlergias(texto) {
  const t = String(texto || '').trim();
  return t !== '' && !SIN_ALERGIAS.test(t);
}

// Edad en años cumplidos (hoy en hora de República Dominicana); null si no hay fecha
function calcularEdad(fechaNacimiento) {
  if (!fechaNacimiento) return null;
  const n = new Date(fechaNacimiento);
  if (Number.isNaN(n.getTime())) return null;
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' }).split('-').map(Number);
  let edad = y - n.getFullYear();
  if (m < n.getMonth() + 1 || (m === n.getMonth() + 1 && d < n.getDate())) edad -= 1;
  return edad;
}

const TIPOS_SANGRE = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Cédula dominicana: 11 dígitos con formato 000-0000000-0. Cualquier otro valor se devuelve igual.
function formatearCedula(texto) {
  const t = String(texto || '').trim();
  const digitos = t.replace(/\D/g, '');
  return digitos.length === 11 && /^[\d\s.-]+$/.test(t)
    ? `${digitos.slice(0, 3)}-${digitos.slice(3, 10)}-${digitos.slice(10)}`
    : t;
}

// Identificación a guardar: las cédulas se normalizan con guiones; pasaportes y otros se dejan como se escribieron
function normalizarIdentificacion(tipoDocumento, texto) {
  const t = String(texto || '').trim();
  return (tipoDocumento || 'Cédula') === 'Cédula' ? formatearCedula(t) : t;
}

module.exports = { tieneAlergias, calcularEdad, TIPOS_SANGRE, formatearCedula, normalizarIdentificacion };
