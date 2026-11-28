/**
 * Utilidades de fechas escritas por el usuario (servidor).
 * Aceptan DD/MM/AAAA (también DD-MM-AAAA) y AAAA-MM-DD, y devuelven AAAA-MM-DD.
 */

// Convierte DD/MM/AAAA o AAAA-MM-DD a AAAA-MM-DD; null si el formato o la fecha no existen (p. ej. 31/02)
function normalizarFecha(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  let y;
  let m;
  let d;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    [y, m, d] = s.split('-').map(Number);
  } else {
    const match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) return null;
    d = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    y = parseInt(match[3], 10);
  }

  const fecha = new Date(Date.UTC(y, m - 1, d));
  if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Fecha de hoy (AAAA-MM-DD) en la hora de República Dominicana
function hoyRD() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' });
}

/**
 * Valida una fecha de nacimiento: formato válido, no futura y no anterior a 1900.
 * @returns {{ iso: string } | { error: string }}
 */
function validarFechaNacimiento(str) {
  if (!str || !String(str).trim()) return { error: 'La fecha de nacimiento es obligatoria.' };
  const iso = normalizarFecha(String(str));
  if (!iso) return { error: 'La fecha de nacimiento no es válida. Escríbala como DD/MM/AAAA (ej: 15/05/1990).' };
  if (iso < '1900-01-01') return { error: 'La fecha de nacimiento no puede ser anterior a 1900.' };
  if (iso > hoyRD()) return { error: 'La fecha de nacimiento no puede ser una fecha futura.' };
  return { iso };
}

module.exports = { normalizarFecha, validarFechaNacimiento, hoyRD };
