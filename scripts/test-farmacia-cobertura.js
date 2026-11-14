/**
 * Test de integración: Cobertura de ARS en la farmacia
 *
 *  1. ARS y n.º de afiliado en el registro y la edición del paciente.
 *  2. Administración de ARS (editar / desactivar) solo por el Administrador.
 *  3. Cobertura por medicamento (ARS + %) y precio; solo el Administrador la modifica.
 *  4. Despacho: desglose total / cubre ARS / paga paciente; "No cubierto" si no hay ARS
 *     o si la ARS del paciente no cubre el medicamento (paga 100%).
 *  5. Comprobante de despacho con el desglose (congelado al entregar).
 *
 * Usa datos propios (prefijo TCOB) y los borra al final. No toca los datos reales.
 */
require('dotenv').config();
const http = require('http');
const app = require('../src/app');
const db = require('../src/config/db');
const { ejecutarMigraciones } = require('../src/database/migraciones');
const cobertura = require('../src/services/coberturaFarmaciaService');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✔ ${msg}`); }
  else { failed++; console.error(`  ✘ FALLÓ: ${msg}`); }
}

async function login(base, usuario, contrasena) {
  const jar = {};
  const guardar = (r) => (r.headers.getSetCookie?.() || []).forEach((c) => { const [k, v] = c.split(';')[0].split('='); jar[k] = v; });
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const g = await fetch(`${base}/login`); guardar(g);
  const csrf = (await g.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, usuario, contrasena }),
  });
  guardar(r);
  const home = await fetch(`${base}/`, { headers: { Cookie: cookie() } }); guardar(home);
  const token = (await home.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1] || csrf;
  return {
    get: (p) => fetch(`${base}${p}`, { redirect: 'manual', headers: { Cookie: cookie() } }),
    post: (p, datos = {}) => fetch(`${base}${p}`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': token },
      body: new URLSearchParams({ _csrf: token, ...datos }),
    }),
  };
}

async function main() {
  console.log('=== COBERTURA DE ARS EN FARMACIA ===\n');
  await ejecutarMigraciones();

  // ---------------------------------------------------------------- 0. cálculo
  console.log('0. Cálculo de cobertura (unidad)');
  const sen = { id: 1, nombre: 'ARS X', codigo: 'X', activo: true };
  let c = cobertura.calcularCobertura({ precioUnitario: 100, cantidad: 2, ars: sen, porcentajeCobertura: 80 });
  assert(c.estado === 'CUBIERTO' && c.montoTotal === 200 && c.montoCubierto === 160 && c.montoPaciente === 40, 'Cubierto 80%: total 200 → ARS 160, paciente 40');
  c = cobertura.calcularCobertura({ precioUnitario: 50, cantidad: 1, ars: sen, porcentajeCobertura: null });
  assert(c.estado === 'NO_CUBIERTO' && c.montoPaciente === 50 && c.montoCubierto === 0, 'ARS sin cobertura para el medicamento → paciente paga 100%');
  c = cobertura.calcularCobertura({ precioUnitario: 50, cantidad: 1, ars: null, porcentajeCobertura: 80 });
  assert(c.estado === 'SIN_ARS' && c.montoPaciente === 50, 'Paciente sin ARS → paga 100% aunque el medicamento tenga cobertura');
  c = cobertura.calcularCobertura({ precioUnitario: 50, cantidad: 1, ars: { ...sen, codigo: 'PRIV' }, porcentajeCobertura: 80 });
  assert(c.estado === 'SIN_ARS', '"ARS Privado / Sin Seguro" (PRIV) se trata como sin ARS');
  c = cobertura.calcularCobertura({ precioUnitario: 50, cantidad: 1, ars: { ...sen, activo: false }, porcentajeCobertura: 80 });
  assert(c.estado === 'SIN_ARS' && c.montoPaciente === 50, 'ARS desactivada → sin cobertura');
  c = cobertura.calcularCobertura({ precioUnitario: 33.33, cantidad: 3, ars: sen, porcentajeCobertura: 33.33 });
  assert(Math.abs(c.montoCubierto + c.montoPaciente - c.montoTotal) < 0.001, 'Redondeo: cubierto + paciente = total exacto');

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = { pacientes: [], meds: [], ars: [] };

  try {
    const admin = await login(base, 'admin', 'admin123');
    const secretaria = await login(base, 'secretaria', 'secretaria123');
    const farmacia = await login(base, 'farmacia', 'farmacia123');

    // ------------------------------------------------------- 2. administración de ARS
    console.log('\n2. Administración de ARS');
    let r = await admin.post('/ars', { nombre: 'ARS TCOB Prueba', codigo: 'TCOB-A' });
    const { rows: arsT } = await db.query(`SELECT id FROM ars WHERE codigo = 'TCOB-A'`);
    ids.ars.push(arsT[0].id);
    const arsTid = arsT[0].id;
    assert(arsTid > 0, 'Administrador crea una ARS');
    r = await admin.post(`/ars/${arsTid}/editar`, { nombre: 'ARS TCOB Editada', codigo: 'TCOB-A', telefono: '809-000-0000' });
    const { rows: arsEd } = await db.query(`SELECT nombre, telefono FROM ars WHERE id = $1`, [arsTid]);
    assert(r.status === 302 && arsEd[0].nombre === 'ARS TCOB Editada' && arsEd[0].telefono === '809-000-0000', 'Administrador edita la ARS');
    assert((await secretaria.get(`/ars/${arsTid}/editar`)).status === 403, 'Secretaría bloqueada para editar ARS (GET 403)');
    assert((await secretaria.post(`/ars/${arsTid}/editar`, { nombre: 'hack' })).status === 403, 'Secretaría bloqueada para editar ARS (POST 403)');
    assert((await secretaria.post(`/ars/${arsTid}/estado`)).status === 403, 'Secretaría bloqueada para desactivar ARS (403)');
    const listaAdmin = await (await admin.get('/ars')).text();
    assert(listaAdmin.includes(`/ars/${arsTid}/editar`) && listaAdmin.includes(`/ars/${arsTid}/estado`), 'Lista de ARS muestra Editar y Desactivar al Administrador');
    const listaSec = await (await secretaria.get('/ars')).text();
    assert(!listaSec.includes('/editar"') && !listaSec.includes('/estado"'), 'Lista de ARS NO muestra Editar/Desactivar a Secretaría');

    // ------------------------------------------------------- 1. ARS en el paciente
    console.log('\n1. ARS y n.º de afiliado en el paciente');
    const { rows: senRows } = await db.query(`SELECT id, nombre FROM ars WHERE codigo = 'SEN-01'`);
    const { rows: uniRows } = await db.query(`SELECT id, nombre FROM ars WHERE codigo = 'UNI-04'`);
    const SEN = senRows[0];
    const UNI = uniRows[0];
    const formNuevo = await (await secretaria.get('/pacientes/nuevo')).text();
    assert(formNuevo.includes('name="ars_id"') && formNuevo.includes('name="numero_afiliado"'), 'El formulario de paciente tiene ARS y n.º de afiliado');
    assert(!formNuevo.includes('ARS Privado / Sin Seguro'), 'El formulario no repite "ARS Privado / Sin Seguro" (ya existe "Particular")');
    const nuevoPaciente = (ident, nombre, arsId, afiliado) => secretaria.post('/pacientes', {
      identificacion: ident, tipo_documento: 'Cédula', nombre, apellido: 'TCOB', fecha_nacimiento: '1990-01-01',
      genero: 'Femenino', telefono: '8095550000', ars_id: arsId ? String(arsId) : '', numero_afiliado: afiliado || '',
    });
    await nuevoPaciente('TCOB-0001', 'ConSenasa', SEN.id, 'SEN-TCOB-1');
    await nuevoPaciente('TCOB-0002', 'SinArs', null, '');
    const { rows: pacs } = await db.query(`SELECT id, identificacion, ars_id, numero_afiliado FROM pacientes WHERE identificacion IN ('TCOB-0001','TCOB-0002') ORDER BY identificacion`);
    ids.pacientes.push(...pacs.map((p) => p.id));
    const [pacSen, pacSin] = pacs;
    assert(pacSen && pacSen.ars_id === SEN.id && pacSen.numero_afiliado === 'SEN-TCOB-1', 'Registro de paciente guarda ARS y n.º de afiliado');
    assert(pacSin && pacSin.ars_id === null, 'Registro de paciente sin ARS guarda ars_id vacío');
    await secretaria.post(`/pacientes/${pacSin.id}`, {
      identificacion: 'TCOB-0002', tipo_documento: 'Cédula', nombre: 'SinArs', apellido: 'TCOB', fecha_nacimiento: '1990-01-01',
      genero: 'Femenino', telefono: '8095550000', ars_id: String(UNI.id), numero_afiliado: 'UNI-TCOB-9',
    });
    let { rows: edit } = await db.query(`SELECT ars_id, numero_afiliado FROM pacientes WHERE id = $1`, [pacSin.id]);
    assert(edit[0].ars_id === UNI.id && edit[0].numero_afiliado === 'UNI-TCOB-9', 'Edición de paciente cambia ARS y n.º de afiliado');
    await secretaria.post(`/pacientes/${pacSin.id}`, {
      identificacion: 'TCOB-0002', tipo_documento: 'Cédula', nombre: 'SinArs', apellido: 'TCOB', fecha_nacimiento: '1990-01-01',
      genero: 'Femenino', telefono: '8095550000', ars_id: '', numero_afiliado: '',
    });
    ({ rows: edit } = await db.query(`SELECT ars_id FROM pacientes WHERE id = $1`, [pacSin.id]));
    assert(edit[0].ars_id === null, 'Edición de paciente permite quitar la ARS (Particular)');

    // ------------------------------------------------------- 3. precio y cobertura
    console.log('\n3. Precio y cobertura por medicamento');
    for (const [cod, nombre] of [['TCOB-MED-1', 'TCOB Cubierto'], ['TCOB-MED-2', 'TCOB No Cubierto']]) {
      await admin.post('/farmacia/inventario', { codigo: cod, nombre, presentacion: 'Tabletas', stock_actual: '20', stock_minimo: '1', precio_unitario: cod.endsWith('1') ? '100' : '50' });
    }
    const { rows: meds } = await db.query(`SELECT id, codigo, precio_unitario FROM medicamentos WHERE codigo IN ('TCOB-MED-1','TCOB-MED-2') ORDER BY codigo`);
    ids.meds.push(...meds.map((m) => m.id));
    const [med1, med2] = meds;
    assert(Number(med1.precio_unitario) === 100 && Number(med2.precio_unitario) === 50, 'Al registrar un medicamento se guarda su precio');
    r = await admin.post(`/farmacia/inventario/${med1.id}/coberturas`, { ars_id: String(SEN.id), porcentaje_cobertura: '80' });
    let { rows: cov } = await db.query(`SELECT porcentaje_cobertura FROM medicamento_coberturas_ars WHERE medicamento_id = $1 AND ars_id = $2`, [med1.id, SEN.id]);
    assert(r.status === 302 && Number(cov[0]?.porcentaje_cobertura) === 80, 'Administrador asigna cobertura: Senasa cubre 80% de TCOB Cubierto');
    await admin.post(`/farmacia/inventario/${med2.id}/coberturas`, { ars_id: String(UNI.id), porcentaje_cobertura: '50' });
    r = await admin.post(`/farmacia/inventario/${med1.id}/coberturas`, { ars_id: String(SEN.id), porcentaje_cobertura: '150' });
    ({ rows: cov } = await db.query(`SELECT porcentaje_cobertura FROM medicamento_coberturas_ars WHERE medicamento_id = $1 AND ars_id = $2`, [med1.id, SEN.id]));
    assert(Number(cov[0].porcentaje_cobertura) === 80, 'Porcentaje inválido (150%) se rechaza');
    assert((await farmacia.post(`/farmacia/inventario/${med1.id}/coberturas`, { ars_id: String(SEN.id), porcentaje_cobertura: '10' })).status === 403, 'Farmacia bloqueada para modificar coberturas (403)');
    assert((await farmacia.post(`/farmacia/inventario/${med1.id}/precio`, { precio_unitario: '1' })).status === 403, 'Farmacia bloqueada para modificar precios (403)');
    const pagCovFarm = await farmacia.get(`/farmacia/inventario/${med1.id}/coberturas`);
    const htmlCovFarm = await pagCovFarm.text();
    assert(pagCovFarm.status === 200 && htmlCovFarm.includes('Senasa') && !htmlCovFarm.includes('Guardar cobertura'), 'Farmacia ve las coberturas en solo lectura');
    const htmlInv = await (await farmacia.get('/farmacia/inventario')).text();
    assert(htmlInv.includes(`/farmacia/inventario/${med1.id}/coberturas`) && htmlInv.includes('Precio unit.'), 'Inventario muestra precio y enlace "Cobertura ARS"');

    // ------------------------------------------------------- 4. despacho
    console.log('\n4. Despacho con desglose');
    async function crearReceta(pacienteId, lineas) {
      const { rows: cons } = await db.query(
        `INSERT INTO consultas (paciente_id, motivo_consulta, hallazgos_clinicos, diagnostico_clinico, tratamiento_plan)
         VALUES ($1, 'TCOB', 'TCOB', 'TCOB', 'TCOB') RETURNING id`, [pacienteId]);
      const { rows: rec } = await db.query(
        `INSERT INTO recetas (consulta_id, paciente_id, codigo_receta) VALUES ($1, $2, $3) RETURNING id`,
        [cons[0].id, pacienteId, `RX-TCOB-${pacienteId}-${Date.now() % 100000}`]);
      const detalles = [];
      for (const [med, cant, nombre] of lineas) {
        const { rows: d } = await db.query(
          `INSERT INTO receta_detalles (receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia, indicaciones_uso, cantidad_recetada)
           VALUES ($1, $2, $3, '1', 'c/8h', 'Oral', $4) RETURNING id`, [rec[0].id, med.id, nombre, cant]);
        detalles.push(d[0].id);
      }
      return { recetaId: rec[0].id, detalles };
    }
    const rxSen = await crearReceta(pacSen.id, [[med1, 2, 'TCOB Cubierto'], [med2, 1, 'TCOB No Cubierto']]);
    const rxSin = await crearReceta(pacSin.id, [[med1, 1, 'TCOB Cubierto']]);

    let html = await (await farmacia.get(`/farmacia/dispensar/${rxSen.recetaId}`)).text();
    assert(html.includes('cubre 80%') && html.includes('RD$ 200.00') && html.includes('RD$ 160.00') && html.includes('RD$ 40.00'),
      'Paciente con Senasa + medicamento cubierto: total RD$ 200.00, ARS RD$ 160.00, paciente RD$ 40.00');
    assert(html.includes('No cubierto') && html.includes('No lo cubre Senasa Contributivo: paga el 100%'),
      'Medicamento que su ARS no cubre: aviso "No cubierto" y paga el 100%');
    assert(html.includes('RD$ 250.00') && html.includes('RD$ 90.00'), 'Resumen de la receta: total RD$ 250.00 y paciente paga RD$ 90.00');

    html = await (await farmacia.get(`/farmacia/dispensar/${rxSin.recetaId}`)).text();
    assert(html.includes('Paciente sin ARS: paga el 100%') && html.includes('Sin cobertura: el paciente paga el 100%'),
      'Paciente sin ARS: aviso "No cubierto" y paga el 100% aunque el medicamento tenga cobertura');

    for (const det of rxSen.detalles) await farmacia.post(`/farmacia/dispensar/${det}/entregar`);
    await farmacia.post(`/farmacia/dispensar/${rxSin.detalles[0]}/entregar`);
    const { rows: congelados } = await db.query(
      `SELECT id, cobertura_estado, monto_total, porcentaje_cobertura, monto_cubierto_ars, monto_paciente, ars_cobertura_nombre, estado_dispensacion
       FROM receta_detalles WHERE id = ANY($1::int[]) ORDER BY id`, [[...rxSen.detalles, rxSin.detalles[0]]]);
    const [e1, e2, e3] = congelados;
    assert(e1.estado_dispensacion === 'Entregado' && e1.cobertura_estado === 'CUBIERTO' && Number(e1.monto_cubierto_ars) === 160 && Number(e1.monto_paciente) === 40,
      'Al entregar se guarda el desglose: CUBIERTO, ARS 160, paciente 40');
    assert(e2.cobertura_estado === 'NO_CUBIERTO' && Number(e2.monto_paciente) === 50 && Number(e2.monto_cubierto_ars) === 0, 'Al entregar: NO_CUBIERTO, paciente 50 (100%)');
    assert(e3.cobertura_estado === 'SIN_ARS' && Number(e3.monto_paciente) === 100, 'Al entregar: SIN_ARS, paciente 100 (100%)');

    // ------------------------------------------------------- 5. comprobante
    console.log('\n5. Comprobante de despacho');
    await admin.post(`/farmacia/inventario/${med1.id}/coberturas`, { ars_id: String(SEN.id), porcentaje_cobertura: '10' });
    await admin.post(`/farmacia/inventario/${med1.id}/precio`, { precio_unitario: '999' });
    const comp = await farmacia.get(`/farmacia/dispensar/${rxSen.recetaId}/comprobante`);
    html = await comp.text();
    assert(comp.status === 200 && html.includes('Senasa Contributivo') && html.includes('SEN-TCOB-1'), 'Comprobante muestra ARS y n.º de afiliado');
    assert(html.includes('80% Senasa Contributivo') && html.includes('No cubierto'), 'Comprobante muestra cobertura por medicamento y "No cubierto"');
    assert(html.includes('RD$ 250.00') && html.includes('- RD$ 160.00') && html.includes('RD$ 90.00'), 'Comprobante: total RD$ 250.00, cubre ARS RD$ 160.00, paga paciente RD$ 90.00');
    assert(!html.includes('RD$ 999') && !html.includes('10% Senasa'), 'El comprobante no cambia si después cambian el precio o la cobertura (montos congelados)');
    html = await (await farmacia.get(`/farmacia/dispensar/${rxSen.recetaId}`)).text();
    assert(html.includes(`/farmacia/dispensar/${rxSen.recetaId}/comprobante`), 'La receta despachada tiene botón "Comprobante de despacho"');

    // ARS desactivada → sin cobertura en pendientes
    const rxTarde = await crearReceta(pacSen.id, [[med1, 1, 'TCOB Cubierto']]);
    await admin.post(`/ars/${SEN.id}/estado`);
    html = await (await farmacia.get(`/farmacia/dispensar/${rxTarde.recetaId}`)).text();
    await admin.post(`/ars/${SEN.id}/estado`); // reactivar
    const { rows: senAct } = await db.query(`SELECT activo FROM ars WHERE id = $1`, [SEN.id]);
    assert(html.includes('ARS desactivada') && html.includes('Paciente sin ARS: paga el 100%'), 'ARS desactivada: sus afiliados pagan el 100%');
    assert(senAct[0].activo === true, 'ARS reactivada al terminar la prueba');
  } finally {
    // ------------------------------------------------------- limpieza
    try {
      await db.query(`DELETE FROM farmacia_movimientos WHERE medicamento_id = ANY($1::int[])`, [ids.meds]);
      await db.query(`DELETE FROM receta_detalles WHERE receta_id IN (SELECT id FROM recetas WHERE paciente_id = ANY($1::int[]))`, [ids.pacientes]);
      await db.query(`DELETE FROM recetas WHERE paciente_id = ANY($1::int[])`, [ids.pacientes]);
      await db.query(`DELETE FROM consultas WHERE paciente_id = ANY($1::int[])`, [ids.pacientes]);
      await db.query(`DELETE FROM pacientes WHERE id = ANY($1::int[])`, [ids.pacientes]);
      await db.query(`DELETE FROM medicamentos WHERE id = ANY($1::int[])`, [ids.meds]);
      await db.query(`DELETE FROM ars WHERE id = ANY($1::int[])`, [ids.ars]);
    } catch (e) {
      console.error('Limpieza:', e.message);
    }
    server.close();
  }

  console.log(`\n📊 RESULTADO COBERTURA ARS FARMACIA: ${passed} exitosas, ${failed} fallidas`);
  await db.pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
