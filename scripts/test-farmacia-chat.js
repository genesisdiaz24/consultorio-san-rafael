/**
 * Test de Integración: Chat Box Asistente IA de Farmacia Interna
 * Consultorio Médico San Rafael
 *
 * Valida todos los requerimientos:
 * 1. Entendimiento de preguntas en lenguaje natural sobre tareas de Farmacia.
 * 2. Consulta de medicamentos, existencias, vencimientos, recetas, kardex y reposición con datos reales.
 * 3. Rechazo estricto de solicitudes ajenas a Farmacia (citas, pagos, diagnósticos, off-topic).
 * 4. Human-In-The-Loop: Confirmación previa obligatoria antes de modificar datos (ajustes de stock, entregas, incidencias).
 * 5. Ejecución atómica y auditoría tras confirmación explícita.
 * 6. Control de acceso por rol (RBAC): Farmacia autorizada, Médico y Secretaría bloqueados con 403.
 */

require('dotenv').config();
const http = require('http');
const db = require('../src/config/db');
const farmaciaChatService = require('../src/services/farmaciaChatService');

async function runTests() {
  console.log('================================================================');
  console.log(' INICIANDO VERIFICACIÓN DEL CHAT BOX ASISTENTE IA DE FARMACIA');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  const client = await db.pool.connect();

  try {
    // 1. RESTRICCIÓN DE ALCANCE: Solicitudes ajenas a Farmacia
    console.log('--- 1. Verificando Rechazo Estricto de Temas Ajenos a Farmacia ---');

    // A. Intento de consultar citas médicas
    const rCitas = await farmaciaChatService.procesarMensaje({
      mensaje: 'Quiero agendar una cita médica para mañana a las 10am',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rCitas.tipo === 'FUERA_DE_ALCANCE' && rCitas.respuesta.includes('citas médicas'), 'Rechaza solicitudes sobre citas médicas con advertencia de alcance');

    // B. Intento de consultar pagos / cobros / PayPal / e-CF
    const rPagos = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Cuánto pagó el paciente por PayPal y cuál es el e-NCF de la factura?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rPagos.tipo === 'FUERA_DE_ALCANCE' && rPagos.respuesta.includes('PayPal'), 'Rechaza solicitudes sobre pagos, PayPal o facturación e-CF');

    // C. Intento de solicitar diagnósticos médicos o historia clínica
    const rDiag = await farmaciaChatService.procesarMensaje({
      mensaje: 'Diagnostica al paciente según sus síntomas y examen físico',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rDiag.tipo === 'FUERA_DE_ALCANCE' && rDiag.respuesta.includes('diagnósticos médicos'), 'Rechaza solicitudes de diagnósticos clínicos (exclusivo del médico)');

    // D. Intento de solicitar temas generales u off-topic
    const rGeneral = await farmaciaChatService.procesarMensaje({
      mensaje: 'Cuéntame un chiste y dime cómo está el clima de hoy',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rGeneral.tipo === 'FUERA_DE_ALCANCE', 'Rechaza temas de conversación general no relacionados con farmacia');

    // 2. CONSULTAS VÁLIDAS DE FARMACIA CON DATOS REALES
    console.log('\n--- 2. Verificando Consultas en Lenguaje Natural con Datos Reales ---');

    // A. Búsqueda de medicamento
    const rBusq = await farmaciaChatService.procesarMensaje({
      mensaje: 'Busca el medicamento Paracetamol',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rBusq.success === true && rBusq.respuesta.includes('Paracetamol'), 'Búsqueda de medicamento localiza fármaco real en base de datos');

    // B. Consulta de existencias / stock bajo / agotados
    const rExist = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Cuáles medicamentos tienen stock bajo actualmente?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rExist.success === true && rExist.tipo === 'EXISTENCIAS', 'Consulta de existencias y stock bajo ejecutada correctamente');

    // C. Consulta de vencimientos
    const rVenc = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Hay lotes próximos a vencer o vencidos en la farmacia?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rVenc.success === true && rVenc.tipo === 'VENCIMIENTOS', 'Consulta de fechas de caducidad y lotes ejecutada con éxito');

    // D. Consulta de recetas pendientes
    const rRec = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Qué recetas médicas están pendientes por dispensar?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rRec.success === true && rRec.tipo === 'RECETAS', 'Consulta de recetas pendientes ejecutada con datos reales');

    // E. Consulta de entregas e incidencias de no entrega
    const rEnt = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Qué medicamentos se han entregado o quedaron sin entregar?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rEnt.success === true && rEnt.tipo === 'ENTREGAS', 'Consulta de auditoría de entregas e incidencias procesada correctamente');

    // F. Consulta de movimientos del kardex
    const rMov = await farmaciaChatService.procesarMensaje({
      mensaje: 'Muéstrame los últimos movimientos del kardex de farmacia',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rMov.success === true && rMov.tipo === 'MOVIMIENTOS', 'Consulta de movimientos y kardex de farmacia ejecutada con éxito');

    // G. Sugerencias de reposición basadas en rotación real
    const rSug = await farmaciaChatService.procesarMensaje({
      mensaje: '¿Qué me sugieres reponer según la rotación de los últimos 30 días?',
      usuario: { id: 5, nombre: 'Farmacéutica' },
    });
    assert(rSug.success === true && rSug.tipo === 'REPOSICION' && rSug.respuesta.includes('Sugerencias de Reposición'), 'Genera sugerencias de reposición basadas en el historial de demanda real');

    // 3. HUMAN-IN-THE-LOOP: INSTRUCCIONES QUE CAMBIAN DATOS (CONFIRMACIÓN PREVIA OBLIGATORIA)
    console.log('\n--- 3. Verificando Human-in-the-Loop y Confirmación Previa Obligatoria ---');

    // Obtener un medicamento real para la prueba
    const { rows: testMeds } = await client.query(`SELECT id, codigo, nombre, stock_actual FROM medicamentos WHERE activo = true LIMIT 1`);
    const medPrueba = testMeds[0];
    const stockOriginal = medPrueba.stock_actual;
    const stockDeseado = stockOriginal + 15;

    // A. Enviar instrucción de ajuste de stock
    const rPrepAjuste = await farmaciaChatService.procesarMensaje({
      mensaje: `Ajusta el stock de ${medPrueba.nombre} a ${stockDeseado} unidades por reposición`,
      usuario: { id: 5, nombre: 'Farmacéutica de Prueba' },
    });

    assert(rPrepAjuste.tipo === 'CONFIRMACION_REQUERIDA', 'Instrucción que cambia stock NO modifica datos de inmediato; solicita CONFIRMACIÓN');
    assert(rPrepAjuste.accionPendiente && rPrepAjuste.accionPendiente.id, 'Genera tarjeta de acción pendiente con ID único y tabla de impacto');

    // Verificar que la base de datos NO ha sido modificada aún
    const stockCheck1 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medPrueba.id])).rows[0].stock_actual;
    assert(stockCheck1 === stockOriginal, `Stock permanece intacto (${stockOriginal} unid.) antes de confirmar`);

    const accionId = rPrepAjuste.accionPendiente.id;

    // B. Probar cancelación de acción pendiente
    const rCancel = await farmaciaChatService.procesarMensaje({
      cancelarAccionId: accionId,
      usuario: { id: 5, nombre: 'Farmacéutica de Prueba' },
    });
    assert(rCancel.success === true && rCancel.respuesta.includes('cancelada'), 'Cancelación de acción pendiente confirmada por el servicio');
    const stockCheckCancel = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medPrueba.id])).rows[0].stock_actual;
    assert(stockCheckCancel === stockOriginal, 'Tras cancelar, el inventario permanece inalterado');

    // C. Nueva instrucción y esta vez confirmar y ejecutar
    const rPrepAjuste2 = await farmaciaChatService.procesarMensaje({
      mensaje: `Ajusta el stock de ${medPrueba.nombre} a ${stockDeseado} unidades por llegada de pedido`,
      usuario: { id: 5, nombre: 'Farmacéutica de Prueba' },
    });
    const accionId2 = rPrepAjuste2.accionPendiente.id;

    const rEjecucion = await farmaciaChatService.procesarMensaje({
      accionConfirmadaId: accionId2,
      usuario: { id: 5, nombre: 'Farmacéutica de Prueba' },
    });
    assert(rEjecucion.tipo === 'EXITO', 'Tras confirmación explícita, la acción se ejecuta satisfactoriamente');

    // Verificar que la base de datos SÍ fue actualizada
    const stockCheck2 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medPrueba.id])).rows[0].stock_actual;
    assert(stockCheck2 === stockDeseado, `Stock en base de datos actualizado a ${stockDeseado} unidades tras confirmación`);

    // Verificar que se registró el movimiento en kardex
    const { rows: movCheck } = await client.query(`
      SELECT * FROM farmacia_movimientos WHERE medicamento_id = $1 ORDER BY id DESC LIMIT 1
    `, [medPrueba.id]);
    assert(movCheck.length > 0 && movCheck[0].tipo_movimiento === 'AJUSTE', 'Kardex registra movimiento AJUSTE con trazabilidad completa');

    // Restaurar stock original para mantener la base de datos limpia
    await client.query(`UPDATE medicamentos SET stock_actual = $1 WHERE id = $2`, [stockOriginal, medPrueba.id]);
    await client.query(`DELETE FROM farmacia_movimientos WHERE id = $1`, [movCheck[0].id]);

    // 4. VERIFICACIÓN HTTP Y CONTROL DE ACCESO POR ROL (RBAC)
    console.log('\n--- 4. Verificando Sesiones Web y Control de Acceso por Rol (RBAC) ---');

    function httpGetWithCookie(path, cookie) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: 3000,
          path,
          method: 'GET',
          headers: cookie ? { Cookie: cookie } : {},
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function loginUser(usuario, contrasena) {
      const step1 = await httpGetWithCookie('/login', '');
      const setCookies = step1.headers ? step1.headers['set-cookie'] || [] : [];
      let xsrf = '';
      let sid = '';
      for (const c of setCookies) {
        if (c.startsWith('XSRF-TOKEN=')) xsrf = c.split(';')[0].replace('XSRF-TOKEN=', '');
        if (c.startsWith('sanrafael_sid=')) sid = c.split(';')[0];
      }

      const postBody = `usuario=${encodeURIComponent(usuario)}&contrasena=${encodeURIComponent(contrasena)}&_csrf=${encodeURIComponent(xsrf)}`;
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: 3000,
          path: '/login',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postBody),
            Cookie: `XSRF-TOKEN=${xsrf}; ${sid}`,
          },
        }, (res) => {
          const newCookies = res.headers['set-cookie'] || [];
          for (const c of newCookies) {
            if (c.startsWith('sanrafael_sid=')) sid = c.split(';')[0];
          }
          resolve(`XSRF-TOKEN=${xsrf}; ${sid}`);
        });
        req.on('error', reject);
        req.write(postBody);
        req.end();
      });
    }

    // A. Sesión de Farmacia
    const cookieFarmacia = await loginUser('farmacia', 'farmacia123');
    const resChatFarmacia = await httpGetWithCookie('/farmacia/chat', cookieFarmacia);
    assert(resChatFarmacia.statusCode === 200, 'Usuario FARMACIA tiene acceso autorizado (HTTP 200) a /farmacia/chat');
    assert(resChatFarmacia.data.includes('Asistente IA de Farmacia Interna'), 'Vista del Chat Box renderiza interfaz completa para Farmacia');

    // B. Sesión de Médico (Bloqueado con 403)
    const cookieMedico = await loginUser('medico', 'medico123');
    const resChatMedico = await httpGetWithCookie('/farmacia/chat', cookieMedico);
    assert(resChatMedico.statusCode === 403, 'Usuario MÉDICO bloqueado con HTTP 403 Forbidden para /farmacia/chat');

    // C. Sesión de Secretaría (Bloqueado con 403)
    const cookieSecretaria = await loginUser('secretaria', 'secretaria123');
    const resChatSecretaria = await httpGetWithCookie('/farmacia/chat', cookieSecretaria);
    assert(resChatSecretaria.statusCode === 403, 'Usuario SECRETARÍA bloqueado con HTTP 403 Forbidden para /farmacia/chat');

    console.log('\n================================================================');
    console.log(` RESULTADOS DEL TEST: ${passed} PASSED / ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('ERROR EN TESTS DE CHAT:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

runTests();
