/**
 * Orientación farmacéutica de venta libre (OTC) para el Chat de Farmacia.
 * Consultorio Médico San Rafael
 *
 * 1. Síntoma → opciones de medicamento (dolor de cabeza, dolor de barriga/estómago y sus variantes).
 * 2. Sustitución: si un medicamento no está disponible (ej. "no hay acetaminofén"),
 *    ofrece el MISMO principio activo con otro nombre/marca y alternativas que cumplen la misma función.
 * 3. Cruza cada opción con el inventario real (stock_actual) para indicar qué hay disponible.
 *
 * Es orientación general para adultos; siempre incluye signos de alarma y precauciones.
 */

const db = require('../config/db');

// Quita acentos y pasa a minúsculas para comparar texto libre
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ============================================================================
// BASE DE CONOCIMIENTO DE MEDICAMENTOS (dosis orientativas para ADULTOS)
// ============================================================================

const MEDICAMENTOS = {
  acetaminofen: {
    nombre: 'Acetaminofén (Paracetamol)',
    detectar: ['acetaminofen', 'paracetamol', 'tylenol', 'panadol', 'dolex', 'tempra', 'atamel'],
    buscarEnInventario: ['acetaminof', 'paracetamol'],
    marcas: 'Tylenol, Panadol, Dolex, Tempra',
    funcion: 'Analgésico y antifebril',
    dosis: '500 mg a 1 g cada 6–8 horas. Máximo 3 g al día.',
    precaucion: 'Evitar con enfermedad del hígado o consumo de alcohol. No combinar con otros productos que ya contengan paracetamol.',
    alternativas: ['ibuprofeno', 'naproxeno', 'metamizol', 'aspirina'],
  },
  ibuprofeno: {
    nombre: 'Ibuprofeno',
    detectar: ['ibuprofeno', 'advil', 'motrin', 'dolofen'],
    buscarEnInventario: ['ibuprof'],
    marcas: 'Advil, Motrin',
    funcion: 'Analgésico, antiinflamatorio y antifebril (AINE)',
    dosis: '200–400 mg cada 6–8 horas, con comida. Máximo 1200 mg al día sin receta.',
    precaucion: 'No usar con gastritis/úlcera, sangrado, enfermedad renal, embarazo (3er trimestre) o si toma anticoagulantes.',
    alternativas: ['acetaminofen', 'naproxeno', 'metamizol'],
  },
  naproxeno: {
    nombre: 'Naproxeno sódico',
    detectar: ['naproxeno', 'aleve', 'flanax'],
    buscarEnInventario: ['naprox'],
    marcas: 'Aleve, Flanax',
    funcion: 'Analgésico y antiinflamatorio de acción prolongada (AINE)',
    dosis: '220–275 mg cada 8–12 horas, con comida. Máximo 660 mg al día sin receta.',
    precaucion: 'Mismas precauciones que el ibuprofeno (estómago, riñón, sangrado, embarazo).',
    alternativas: ['ibuprofeno', 'acetaminofen', 'metamizol'],
  },
  metamizol: {
    nombre: 'Metamizol (Dipirona)',
    detectar: ['metamizol', 'dipirona', 'novalgina', 'neo-melubrina', 'neomelubrina'],
    buscarEnInventario: ['metamizol', 'dipirona'],
    marcas: 'Novalgina, Neo-Melubrina',
    funcion: 'Analgésico y antifebril potente (también alivia cólicos)',
    dosis: '500 mg a 1 g cada 6–8 horas. Máximo 4 g al día.',
    precaucion: 'Puede causar alergia o bajar los glóbulos blancos (raro). No usar si hubo alergia a dipirona ni en embarazo.',
    alternativas: ['acetaminofen', 'ibuprofeno', 'naproxeno'],
  },
  aspirina: {
    nombre: 'Ácido acetilsalicílico (Aspirina)',
    detectar: ['aspirina', 'acido acetilsalicilico'],
    buscarEnInventario: ['aspirin', 'acetilsalic'],
    marcas: 'Aspirina, Bayer',
    funcion: 'Analgésico, antiinflamatorio y antifebril',
    dosis: '500 mg a 1 g cada 4–6 horas, con comida. Máximo 3 g al día.',
    precaucion: 'NO dar a menores de 16 años. Evitar con gastritis, sangrado, dengue o si toma anticoagulantes.',
    alternativas: ['acetaminofen', 'ibuprofeno', 'naproxeno'],
  },
  butilhioscina: {
    nombre: 'Butilbromuro de hioscina (Buscapina)',
    detectar: ['butilhioscina', 'hioscina', 'buscapina', 'buscapin'],
    buscarEnInventario: ['hioscina', 'buscapin'],
    marcas: 'Buscapina, Buscapina Compositum (con paracetamol/metamizol)',
    funcion: 'Antiespasmódico: alivia cólicos y retortijones',
    dosis: '10–20 mg hasta 3 veces al día. Máximo 60 mg al día.',
    precaucion: 'Evitar con glaucoma, problemas de próstata o taquicardia.',
    alternativas: ['pinaverio', 'trimebutina', 'acetaminofen'],
  },
  pinaverio: {
    nombre: 'Bromuro de pinaverio',
    detectar: ['pinaverio', 'dicetel'],
    buscarEnInventario: ['pinaver'],
    marcas: 'Dicetel',
    funcion: 'Antiespasmódico intestinal (cólico, colon irritable)',
    dosis: '50–100 mg 2–3 veces al día con comida y abundante agua.',
    precaucion: 'Tragar entero con agua, sin acostarse inmediatamente.',
    alternativas: ['butilhioscina', 'trimebutina'],
  },
  trimebutina: {
    nombre: 'Trimebutina',
    detectar: ['trimebutina', 'debridat'],
    buscarEnInventario: ['trimebut'],
    marcas: 'Debridat',
    funcion: 'Regulador intestinal y antiespasmódico',
    dosis: '100–200 mg 3 veces al día antes de las comidas.',
    precaucion: 'Generalmente bien tolerado; evitar en embarazo sin indicación médica.',
    alternativas: ['butilhioscina', 'pinaverio'],
  },
  omeprazol: {
    nombre: 'Omeprazol',
    detectar: ['omeprazol', 'losec', 'prilosec'],
    buscarEnInventario: ['omepraz'],
    marcas: 'Losec, Prilosec',
    funcion: 'Reduce la producción de ácido (acidez, gastritis, reflujo)',
    dosis: '20 mg una vez al día, 30 minutos antes del desayuno, por 14 días máximo sin receta.',
    precaucion: 'Si la acidez persiste más de 2 semanas, consultar al médico.',
    alternativas: ['esomeprazol', 'famotidina', 'antiacido'],
  },
  esomeprazol: {
    nombre: 'Esomeprazol',
    detectar: ['esomeprazol', 'nexium'],
    buscarEnInventario: ['esomepraz'],
    marcas: 'Nexium',
    funcion: 'Reduce la producción de ácido (mismo grupo que omeprazol)',
    dosis: '20 mg una vez al día antes del desayuno.',
    precaucion: 'Igual que omeprazol.',
    alternativas: ['omeprazol', 'famotidina', 'antiacido'],
  },
  famotidina: {
    nombre: 'Famotidina',
    detectar: ['famotidina', 'pepcid'],
    buscarEnInventario: ['famotid'],
    marcas: 'Pepcid',
    funcion: 'Reduce el ácido del estómago (acción rápida)',
    dosis: '10–20 mg hasta 2 veces al día.',
    precaucion: 'Ajustar dosis con enfermedad renal.',
    alternativas: ['omeprazol', 'esomeprazol', 'antiacido'],
  },
  antiacido: {
    nombre: 'Antiácido (Hidróxido de aluminio y magnesio / Simeticona)',
    detectar: ['antiacido', 'hidroxido de aluminio', 'hidroxido de magnesio', 'maalox', 'mylanta', 'gaviscon', 'leche de magnesia', 'alka-seltzer', 'sal de uvas'],
    buscarEnInventario: ['aluminio', 'magnesio', 'antiacid', 'maalox', 'mylanta', 'gaviscon'],
    marcas: 'Maalox, Mylanta, Gaviscon',
    funcion: 'Neutraliza el ácido: alivio inmediato de acidez y ardor',
    dosis: '10–20 mL (o 1–2 tabletas masticables) después de las comidas y al acostarse. Máximo 4 veces al día.',
    precaucion: 'Separar 2 horas de otros medicamentos. Evitar con enfermedad renal.',
    alternativas: ['famotidina', 'omeprazol'],
  },
  simeticona: {
    nombre: 'Simeticona',
    detectar: ['simeticona', 'gas-x', 'flatoril', 'espumisan'],
    buscarEnInventario: ['simetic'],
    marcas: 'Gas-X, Espumisan',
    funcion: 'Elimina gases e hinchazón abdominal',
    dosis: '40–125 mg después de las comidas y al acostarse.',
    precaucion: 'Muy segura; no se absorbe.',
    alternativas: ['butilhioscina', 'antiacido'],
  },
  sro: {
    nombre: 'Sales de Rehidratación Oral (Suero oral)',
    detectar: ['suero oral', 'sales de rehidratacion', 'pedialyte', 'electrolit', 'sro'],
    buscarEnInventario: ['rehidrat', 'suero oral', 'electrol', 'pedialyte'],
    marcas: 'Pedialyte, Electrolit',
    funcion: 'Repone líquidos y sales perdidos por diarrea o vómitos',
    dosis: 'Tomar a sorbos después de cada evacuación líquida (aprox. 200–400 mL).',
    precaucion: 'Es lo más importante en diarrea; no sustituir por refrescos.',
    alternativas: ['loperamida'],
  },
  loperamida: {
    nombre: 'Loperamida',
    detectar: ['loperamida', 'imodium'],
    buscarEnInventario: ['loperam'],
    marcas: 'Imodium',
    funcion: 'Antidiarreico: disminuye el número de evacuaciones',
    dosis: '4 mg al inicio y 2 mg tras cada evacuación líquida. Máximo 8 mg al día.',
    precaucion: 'NO usar si hay fiebre, sangre en las heces ni en menores de 12 años.',
    alternativas: ['sro', 'subsalicilato'],
  },
  subsalicilato: {
    nombre: 'Subsalicilato de bismuto',
    detectar: ['subsalicilato', 'bismuto', 'pepto'],
    buscarEnInventario: ['bismut', 'pepto'],
    marcas: 'Pepto-Bismol',
    funcion: 'Alivia diarrea, náuseas, indigestión y malestar estomacal',
    dosis: '524 mg (30 mL o 2 tabletas) cada 30–60 min si es necesario. Máximo 8 dosis al día.',
    precaucion: 'Puede oscurecer las heces y la lengua. No en menores de 16 años, embarazo ni alergia a la aspirina.',
    alternativas: ['loperamida', 'sro'],
  },
};

// Nota cuando el medicamento faltante es Acetaminofén: aclarar equivalentes del mismo principio activo
const NOTA_MISMO_PRINCIPIO = {
  acetaminofen: 'Acetaminofén y Paracetamol son **el mismo medicamento** (mismo principio activo). Si no hay "Acetaminofén" con ese nombre, cualquier presentación de **Paracetamol** o las marcas *Tylenol, Panadol, Dolex o Tempra* sirve igual.',
  ibuprofeno: 'Cualquier marca de Ibuprofeno (*Advil, Motrin*) contiene el mismo principio activo.',
  butilhioscina: 'Buscapina es la marca comercial de la butilhioscina; cualquier genérico de "Butilbromuro de hioscina" sirve igual.',
  omeprazol: 'Cualquier genérico de Omeprazol 20 mg es equivalente a Losec/Prilosec.',
};

// ============================================================================
// SÍNTOMAS → OPCIONES
// ============================================================================

const SINTOMAS = {
  cabeza: {
    titulo: 'Dolor de cabeza',
    detectar: /\b(dolor de cabeza|duele (la )?cabeza|cefalea|jaqueca|migrana|migranas|cabeza me duele)\b/,
    opciones: ['acetaminofen', 'ibuprofeno', 'naproxeno', 'metamizol', 'aspirina'],
    consejos: 'Descansar en un lugar tranquilo y oscuro, hidratarse bien y evitar el ayuno. No tomar analgésicos más de 10 días al mes (puede causar dolor de rebote).',
    alarma: 'Dolor súbito y muy intenso ("el peor de mi vida"), fiebre con cuello rígido, confusión, debilidad o adormecimiento de un lado del cuerpo, dificultad para hablar, visión doble, dolor tras un golpe en la cabeza, o presión arterial muy alta.',
  },
  estomago: {
    titulo: 'Dolor de estómago / barriga',
    detectar: /(?!)/, // se activa por PATRON_BARRIGA + PATRON_DOLOR
    opciones: ['butilhioscina', 'pinaverio', 'trimebutina', 'acetaminofen', 'metamizol'],
  },
  colico: {
    titulo: 'Dolor de barriga tipo cólico / retortijones',
    detectar: /\b(colico|colicos|retortijon|retortijones|espasmo|espasmos|calambre(s)? (en|de) (la )?(barriga|estomago|abdomen)|dolor menstrual|colitis)\b/,
    opciones: ['butilhioscina', 'pinaverio', 'trimebutina', 'acetaminofen'],
    consejos: 'Comidas ligeras, buena hidratación y calor local (bolsa tibia) sobre el abdomen.',
  },
  acidez: {
    titulo: 'Acidez / ardor de estómago / gastritis',
    detectar: /\b(acidez|agruras|ardor (de|en el) (estomago|pecho)|gastritis|reflujo|indigestion|llenura|pesadez)\b/,
    opciones: ['antiacido', 'famotidina', 'omeprazol', 'esomeprazol'],
  },
  gases: {
    titulo: 'Gases / hinchazón abdominal',
    detectar: /\b(gases|flatulencia|hinchazon|inflamad[oa] (la )?(barriga|panza|estomago)|barriga inflamada|distension)\b/,
    opciones: ['simeticona', 'butilhioscina'],
    consejos: 'Comer despacio, evitar bebidas gaseosas, chicle y alimentos que producen gases (granos, repollo).',
  },
  diarrea: {
    titulo: 'Diarrea',
    detectar: /\b(diarrea|evacuaciones liquidas|suelto del estomago|soltura|heces liquidas)\b/,
    opciones: ['sro', 'loperamida', 'subsalicilato'],
    consejos: 'Lo más importante es **hidratarse**. Dieta blanda (arroz, guineo, pan tostado, pollo hervido).',
  },
};

// Dolor de barriga/estómago sin especificar → orientación general + preguntar tipo
const PATRON_BARRIGA = /\b(barriga|panza|estomago|abdomen|abdominal|vientre|tripa|guata)\b/;
const PATRON_DOLOR = /\b(duele|dolor|molestia|malestar|me siento mal)\b/;

const ALARMA_ABDOMEN =
  'Dolor muy fuerte o que no mejora en 24 horas, dolor en la parte baja derecha del abdomen, abdomen duro, fiebre alta, vómitos persistentes, sangre en vómito o heces (o heces negras), embarazo, o signos de deshidratación (boca seca, poca orina, mareo).';

// ============================================================================
// DETECCIÓN
// ============================================================================

function detectarMedicamento(t) {
  for (const [clave, med] of Object.entries(MEDICAMENTOS)) {
    if (med.detectar.some((d) => t.includes(d))) return clave;
  }
  return null;
}

function detectarSintomas(t) {
  const encontrados = Object.keys(SINTOMAS).filter((k) => SINTOMAS[k].detectar.test(t));
  const barrigaGeneral = encontrados.length === 0 && PATRON_BARRIGA.test(t) && PATRON_DOLOR.test(t);
  return { encontrados, barrigaGeneral };
}

const PATRON_SUSTITUCION =
  /\b(no hay|no tenemos|no tienen|no queda|no quedan|se acabo|se termino|agotad[oa]|sin existencia|falta|faltan|sustitut[oa]|sustituir|reemplaz\w*|alternativa\w*|en vez de|en lugar de|equivalente|parecido|similar|igual a|otra opcion|otro medicamento|que haga lo mismo|misma funcion)\b/;

/**
 * Devuelve la intención de orientación si aplica, o null para que el chat siga su flujo normal.
 */
function detectarIntencionOrientacion(texto) {
  const t = normalizar(texto);
  const medicamento = detectarMedicamento(t);
  const { encontrados, barrigaGeneral } = detectarSintomas(t);

  if (medicamento && PATRON_SUSTITUCION.test(t)) {
    return { tipo: 'SUSTITUCION', medicamento, sintomas: encontrados, barrigaGeneral: PATRON_BARRIGA.test(t) };
  }
  if (encontrados.length > 0 || barrigaGeneral) {
    return { tipo: 'SINTOMA', sintomas: encontrados, barrigaGeneral };
  }
  return null;
}

// ============================================================================
// INVENTARIO
// ============================================================================

async function consultarInventario(claves) {
  const resultado = {};
  for (const clave of claves) {
    const patrones = MEDICAMENTOS[clave].buscarEnInventario.map((p) => `%${p}%`);
    const { rows } = await db.query(
      `SELECT nombre, concentracion, presentacion, stock_actual, ubicacion
       FROM medicamentos
       WHERE activo = true
         AND (nombre ILIKE ANY($1::text[]) OR principio_activo ILIKE ANY($1::text[]))
         AND (fecha_vencimiento IS NULL OR fecha_vencimiento > CURRENT_DATE)
       ORDER BY stock_actual DESC`,
      [patrones]
    );
    const total = rows.reduce((s, r) => s + (parseInt(r.stock_actual, 10) || 0), 0);
    resultado[clave] = { registrado: rows.length > 0, total, items: rows };
  }
  return resultado;
}

function etiquetaStock(inv) {
  if (!inv || !inv.registrado) return '⚪ No registrado en nuestro inventario';
  if (inv.total <= 0) return '🔴 **AGOTADO** en farmacia';
  const ref = inv.items.find((i) => i.stock_actual > 0);
  const det = ref ? ` — ${ref.nombre}${ref.concentracion ? ' ' + ref.concentracion : ''}, ubicación: ${ref.ubicacion || 'General'}` : '';
  return `🟢 **DISPONIBLE** (${inv.total} unid.${det})`;
}

function bloqueMedicamento(clave, inv, numero) {
  const m = MEDICAMENTOS[clave];
  return (
    `**${numero}. ${m.nombre}** — ${m.funcion}\n` +
    `  - Marcas: *${m.marcas}*\n` +
    `  - Dosis adulto: ${m.dosis}\n` +
    `  - Precaución: ${m.precaucion}\n` +
    `  - Inventario: ${etiquetaStock(inv[clave])}\n`
  );
}

const AVISO_FINAL =
  '\n*ℹ️ Orientación general para **adultos**. En niños, embarazadas, adultos mayores o personas con enfermedades crónicas/alergias, la dosis debe indicarla el médico. Lea siempre el prospecto.*';

// ============================================================================
// RESPUESTAS
// ============================================================================

async function responderSintoma({ sintomas, barrigaGeneral }) {
  let claves = sintomas;
  let msg = '';

  if (barrigaGeneral) {
    claves = ['estomago'];
  }

  // Inventario de todas las opciones a mostrar
  const todas = [...new Set(claves.flatMap((k) => SINTOMAS[k].opciones))];
  const inv = await consultarInventario(todas);

  for (const k of claves) {
    const s = SINTOMAS[k];
    msg += `💊 **${s.titulo} — opciones de medicamento:**\n\n`;
    s.opciones.forEach((clave, i) => {
      msg += bloqueMedicamento(clave, inv, i + 1) + '\n';
    });

    // Si la primera opción está agotada, sugerir automáticamente la mejor alternativa disponible
    const primera = s.opciones[0];
    if (inv[primera] && inv[primera].total <= 0) {
      const disponible = s.opciones.slice(1).find((c) => inv[c] && inv[c].total > 0);
      msg += `🔁 **${MEDICAMENTOS[primera].nombre} no está disponible.** `;
      msg += disponible
        ? `La mejor opción con existencias ahora es **${MEDICAMENTOS[disponible].nombre}**.\n\n`
        : 'Ninguna de las alternativas tiene existencias en este momento; recomendar adquirirla en farmacia externa.\n\n';
    }

    if (s.consejos) msg += `✅ **Recomendaciones:** ${s.consejos}\n\n`;
  }

  if (sintomas.includes('cabeza')) {
    msg += `🚨 **Acudir a emergencias si:** ${SINTOMAS.cabeza.alarma}\n`;
  }
  if (barrigaGeneral || sintomas.some((k) => k !== 'cabeza')) {
    msg +=
      '⚠️ En dolor de barriga **evitar ibuprofeno, naproxeno y aspirina** (irritan el estómago); si se necesita un analgésico, preferir Acetaminofén.\n\n' +
      `🚨 **Acudir a emergencias si:** ${ALARMA_ABDOMEN}\n`;
  }

  msg += AVISO_FINAL;
  return { success: true, respuesta: msg, datos: inv, tipo: 'ORIENTACION' };
}

async function responderSustitucion({ medicamento, sintomas, barrigaGeneral }) {
  const original = MEDICAMENTOS[medicamento];
  let alternativas = [...original.alternativas];

  // Si hay contexto de dolor de barriga, no ofrecer AINEs como alternativa
  const contextoAbdominal = barrigaGeneral || sintomas.some((k) => k !== 'cabeza');
  if (contextoAbdominal) {
    alternativas = alternativas.filter((c) => !['ibuprofeno', 'naproxeno', 'aspirina'].includes(c));
    if (!alternativas.includes('butilhioscina') && medicamento !== 'butilhioscina') alternativas.push('butilhioscina');
  }

  const inv = await consultarInventario([medicamento, ...alternativas]);

  let msg = `🔁 **Sustitutos de ${original.nombre}** (${original.funcion.toLowerCase()})\n\n`;
  msg += `Estado del original: ${etiquetaStock(inv[medicamento])}\n\n`;

  if (NOTA_MISMO_PRINCIPIO[medicamento]) {
    msg += `🟰 **Mismo medicamento con otro nombre:** ${NOTA_MISMO_PRINCIPIO[medicamento]}\n\n`;
  }

  msg += '💊 **Medicamentos que hacen la misma función:**\n\n';
  alternativas.forEach((clave, i) => {
    msg += bloqueMedicamento(clave, inv, i + 1) + '\n';
  });

  const disponible = alternativas.find((c) => inv[c] && inv[c].total > 0);
  if (disponible) {
    msg += `⭐ **Recomendación:** usar **${MEDICAMENTOS[disponible].nombre}**, que sí tiene existencias en nuestra farmacia.\n\n`;
  } else {
    msg += '⚠️ Ninguna alternativa tiene existencias en nuestro inventario; recomendar adquirirla en una farmacia externa.\n\n';
  }

  if (medicamento === 'acetaminofen' && !contextoAbdominal) {
    msg +=
      '📝 **Importante al cambiar de Acetaminofén a un antiinflamatorio (ibuprofeno/naproxeno/aspirina):** tomarlo con comida y no usarlo si la persona tiene gastritis, úlcera, problemas renales, está embarazada o toma anticoagulantes. En esos casos la alternativa más segura es **Metamizol**.\n';
  }

  msg += AVISO_FINAL;
  return { success: true, respuesta: msg, datos: inv, tipo: 'SUSTITUCION' };
}

async function responderOrientacion(intencion) {
  if (intencion.tipo === 'SUSTITUCION') return responderSustitucion(intencion);
  return responderSintoma(intencion);
}

module.exports = {
  detectarIntencionOrientacion,
  responderOrientacion,
  MEDICAMENTOS,
  SINTOMAS,
};
