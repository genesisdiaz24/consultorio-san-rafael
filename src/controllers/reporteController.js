/**
 * Controlador del Módulo de Reportes
 * Listado de reportes por módulo, visualización con filtros/totales/gráfico y exportación CSV.
 */
const db = require('../config/db');
const { MODULOS, REPORTES, POR_ID, puedeVer } = require('../reportes/catalogo');

const MAX_FILAS = 5000;

// Opciones dinámicas de los filtros tipo select (cargadas de la base de datos)
const FUENTES = {
  ars: `SELECT id::text AS valor, nombre AS etiqueta FROM ars ORDER BY nombre`,
  servicios: `SELECT id::text AS valor, nombre AS etiqueta FROM servicios ORDER BY nombre`,
};

function rolDe(req) {
  return req.session && req.session.usuario ? req.session.usuario.rol : '';
}

function denegar(res, rol) {
  return res.status(403).render('403', {
    title: 'Acceso Denegado - Consultorio Médico San Rafael',
    mensaje: `Su rol actual (${rol}) no tiene autorización para ver este reporte.`,
  });
}

function fechaValida(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [y, m, dia] = valor.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dia));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === dia;
}

// Lee y valida los filtros del querystring: solo pasan valores con el formato esperado
async function prepararFiltros(reporte, query) {
  const definiciones = [];
  const valores = {};

  for (const filtro of reporte.filtros || []) {
    let opciones = null;
    if (filtro.tipo === 'select') {
      if (filtro.fuente) {
        const { rows } = await db.query(FUENTES[filtro.fuente]);
        opciones = rows;
      } else {
        opciones = filtro.opciones.map((o) => ({ valor: o, etiqueta: o }));
      }
    }

    const defecto = typeof filtro.defecto === 'function' ? filtro.defecto() : filtro.defecto;
    const crudo = Object.prototype.hasOwnProperty.call(query, filtro.nombre) ? query[filtro.nombre] : defecto;
    const valor = typeof crudo === 'string' ? crudo.trim() : '';
    let aceptado = '';

    if (valor) {
      if (filtro.tipo === 'fecha' && fechaValida(valor)) aceptado = valor;
      if (filtro.tipo === 'numero' && /^\d{1,4}$/.test(valor)) aceptado = String(parseInt(valor, 10));
      if (filtro.tipo === 'select' && opciones.some((o) => o.valor === valor)) aceptado = valor;
    }

    valores[filtro.nombre] = aceptado;
    definiciones.push({ ...filtro, opciones, valor: aceptado });
  }

  return { definiciones, valores };
}

async function ejecutar(reporte, valores) {
  const { sql, params } = reporte.consulta(valores);
  const { rows } = await db.query(sql, params);
  return rows;
}

function calcularTotales(reporte, filas) {
  const totales = {};
  let hay = false;
  for (const col of reporte.columnas) {
    if (!col.total) continue;
    const numeros = filas.map((f) => parseFloat(f[col.clave])).filter((n) => !Number.isNaN(n));
    if (col.total === 'suma') {
      totales[col.clave] = numeros.reduce((a, b) => a + b, 0);
    } else if (col.total === 'promedio') {
      totales[col.clave] = numeros.length ? numeros.reduce((a, b) => a + b, 0) / numeros.length : null;
    }
    hay = true;
  }
  return hay ? totales : null;
}

function calcularGrafico(reporte, filas) {
  if (!reporte.grafico || filas.length === 0) return null;
  const { etiqueta, valor } = reporte.grafico;
  const columna = reporte.columnas.find((c) => c.clave === valor);
  const barras = filas
    .map((f) => ({ etiqueta: String(f[etiqueta] ?? '—'), valor: parseFloat(f[valor]) || 0 }))
    .slice(0, 15);
  const maximo = Math.max(...barras.map((b) => b.valor), 0);
  if (maximo <= 0) return null;
  return {
    titulo: columna ? columna.etiqueta : valor,
    tipo: columna ? columna.tipo : 'numero',
    barras: barras.map((b) => ({ ...b, ancho: Math.max(1, Math.round((b.valor / maximo) * 100)) })),
  };
}

function resumenFiltros(definiciones) {
  return definiciones
    .filter((d) => d.valor)
    .map((d) => {
      const opcion = d.opciones ? d.opciones.find((o) => o.valor === d.valor) : null;
      return `${d.etiqueta}: ${opcion ? opcion.etiqueta : d.valor}`;
    })
    .join(' · ');
}

// ---------------------------------------------------------------------
// GET /reportes → Centro de reportes con los módulos que el rol puede ver
// ---------------------------------------------------------------------
exports.index = async (req, res, next) => {
  try {
    const rol = rolDe(req);
    const modulos = MODULOS.map((m) => ({
      ...m,
      reportes: REPORTES.filter((r) => r.modulo === m.id && puedeVer(rol, r)),
    })).filter((m) => m.reportes.length > 0);

    // Totales clínicos (antes en el panel del médico) para quien ve el módulo de Consultas
    let totalesClinicos = null;
    if (modulos.some((m) => m.id === 'consultas')) {
      const { rows } = await db.query(
        `SELECT (SELECT COUNT(*) FROM consultas)::int AS consultas, (SELECT COUNT(*) FROM recetas)::int AS recetas`
      );
      totalesClinicos = rows[0];
    }

    res.render('reportes/index', {
      totalesClinicos,
      title: 'Reportes - Consultorio Médico San Rafael',
      modulos,
      totalReportes: modulos.reduce((n, m) => n + m.reportes.length, 0),
      totalSistema: REPORTES.length,
      modulosSistema: MODULOS.length,
      esAdmin: rol === 'ADMINISTRADOR',
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------
// GET /reportes/:id → Reporte con filtros, tabla, totales y gráfico
// ---------------------------------------------------------------------
exports.ver = async (req, res, next) => {
  try {
    const reporte = POR_ID.get(req.params.id);
    if (!reporte) {
      req.flash('error', 'El reporte solicitado no existe.');
      return res.redirect('/reportes');
    }
    const rol = rolDe(req);
    if (!puedeVer(rol, reporte)) return denegar(res, rol);

    const { definiciones, valores } = await prepararFiltros(reporte, req.query);
    const todas = await ejecutar(reporte, valores);
    const filas = todas.slice(0, MAX_FILAS);
    const qs = new URLSearchParams(valores).toString();

    res.render('reportes/ver', {
      title: `${reporte.titulo} - Reportes`,
      reporte,
      modulo: MODULOS.find((m) => m.id === reporte.modulo),
      filtros: definiciones,
      filas,
      truncado: todas.length > MAX_FILAS,
      totales: calcularTotales(reporte, filas),
      grafico: calcularGrafico(reporte, filas),
      resumenFiltros: resumenFiltros(definiciones),
      urlCsv: `/reportes/${reporte.id}/csv${qs ? `?${qs}` : ''}`,
      generadoEn: new Date().toLocaleString('es-DO', {
        timeZone: 'America/Santo_Domingo', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }),
      generadoPor: req.session.usuario.nombre,
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------
// GET /reportes/:id/csv → Exportación para Excel (UTF-8 con BOM)
// ---------------------------------------------------------------------
function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

function valorCsv(valor, tipo) {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) {
    const fecha = `${valor.getFullYear()}-${dosDigitos(valor.getMonth() + 1)}-${dosDigitos(valor.getDate())}`;
    return tipo === 'fechahora' ? `${fecha} ${dosDigitos(valor.getHours())}:${dosDigitos(valor.getMinutes())}` : fecha;
  }
  return String(valor);
}

function celdaCsv(texto) {
  let t = String(texto);
  // Evita inyección de fórmulas al abrir el archivo en Excel
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

exports.csv = async (req, res, next) => {
  try {
    const reporte = POR_ID.get(req.params.id);
    if (!reporte) return res.status(404).send('Reporte no encontrado');
    const rol = rolDe(req);
    if (!puedeVer(rol, reporte)) return denegar(res, rol);

    const { valores } = await prepararFiltros(reporte, req.query);
    const filas = await ejecutar(reporte, valores);

    const lineas = [reporte.columnas.map((c) => celdaCsv(c.etiqueta)).join(',')];
    for (const fila of filas) {
      lineas.push(reporte.columnas.map((c) => celdaCsv(valorCsv(fila[c.clave], c.tipo))).join(','));
    }

    const hoy = new Date();
    const nombre = `${reporte.id}_${hoy.getFullYear()}${dosDigitos(hoy.getMonth() + 1)}${dosDigitos(hoy.getDate())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(`﻿${lineas.join('\r\n')}\r\n`);
  } catch (error) {
    next(error);
  }
};
