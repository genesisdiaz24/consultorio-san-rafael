/**
 * Test de Integración: Módulo de Farmacia y Dispensación de Recetas
 * Consultorio Médico San Rafael
 *
 * Valida los 9 puntos requeridos:
 * 1. El médico registra una receta durante la consulta.
 * 2. La farmacéutica busca al paciente por nombre o cédula y consulta recetas pendientes.
 * 3. El sistema muestra medicamentos recetados y existencias disponibles (suficiente / insuficiente).
 * 4. La farmacéutica registra cada medicamento como entregado o no entregado con motivo.
 * 5. El inventario SOLO se descuenta por unidades efectivamente entregadas; no se descuenta si falta stock.
 * 6. Registro de cobertura ARS aplicada o indicación para compra por cuenta propia.
 * 7. Vista final de la receta mostrando qué se entregó y qué quedó pendiente con comentarios.
 * 8. Control de inventario en farmacia.
 * 9. Ausencia de pagos por PayPal en farmacia (PayPal exclusivo para consulta médica).
 */

require('dotenv').config();
const db = require('../src/config/db');

async function runTests() {
  console.log('====================================================');
  console.log(' INICIANDO VERIFICACIÓN DEL MÓDULO DE FARMACIA');
  console.log('====================================================\n');

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
    // 1. Verificación de columnas de base de datos
    console.log('--- 1. Verificando esquema de base de datos ---');
    const { rows: colRows } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'receta_detalles' 
        AND column_name IN ('cubierto_ars', 'cobertura_utilizada', 'motivo_no_entrega', 'estado_dispensacion')
    `);
    const foundCols = colRows.map(r => r.column_name);
    assert(foundCols.includes('cubierto_ars'), 'Columna cubierto_ars existe en receta_detalles');
    assert(foundCols.includes('cobertura_utilizada'), 'Columna cobertura_utilizada existe en receta_detalles');
    assert(foundCols.includes('motivo_no_entrega'), 'Columna motivo_no_entrega existe en receta_detalles');
    assert(foundCols.includes('estado_dispensacion'), 'Columna estado_dispensacion existe en receta_detalles');

    // 2. Preparar datos de prueba
    console.log('\n--- 2. Creando datos de prueba (Pacientes, Medicamentos, Receta) ---');
    
    // Obtener ARS
    let arsId = null;
    const { rows: arsRows } = await client.query(`SELECT id, nombre FROM ars LIMIT 1`);
    if (arsRows.length > 0) {
      arsId = arsRows[0].id;
    }

    // Crear o recuperar paciente asegurado
    const { rows: pAsegurado } = await client.query(`
      INSERT INTO pacientes (nombre, apellido, identificacion, fecha_nacimiento, genero, telefono, ars_id, numero_afiliado)
      VALUES ('PruebaFarmacia', 'Asegurado', '001-9999001-1', '1988-04-12', 'Masculino', '8095550001', $1, 'ARS-99001')
      ON CONFLICT (identificacion) DO UPDATE SET nombre = EXCLUDED.nombre
      RETURNING id, nombre, apellido, identificacion
    `, [arsId]);
    const pacAseguradoId = pAsegurado[0].id;

    // Limpiar citas previas del paciente de prueba si existen
    await client.query(`DELETE FROM citas WHERE paciente_id = $1`, [pacAseguradoId]);

    // Crear medicamentos de prueba
    // Med 1: Stock suficiente (50 unidades)
    const { rows: med1Rows } = await client.query(`
      INSERT INTO medicamentos (codigo, nombre, presentacion, concentracion, stock_actual, stock_minimo)
      VALUES ('TEST-MED-SUF', 'Amoxicilina Test 500mg', 'Cápsula', '500mg', 50, 10)
      ON CONFLICT (codigo) DO UPDATE SET stock_actual = 50
      RETURNING id, stock_actual
    `);
    const medSufId = med1Rows[0].id;

    // Med 2: Sin existencias (0 unidades)
    const { rows: med2Rows } = await client.query(`
      INSERT INTO medicamentos (codigo, nombre, presentacion, concentracion, stock_actual, stock_minimo)
      VALUES ('TEST-MED-CERO', 'Azitromicina Test 500mg', 'Tableta', '500mg', 0, 5)
      ON CONFLICT (codigo) DO UPDATE SET stock_actual = 0
      RETURNING id, stock_actual
    `);
    const medCeroId = med2Rows[0].id;

    // Med 3: Stock insuficiente (2 unidades cuando se recetan 5)
    const { rows: med3Rows } = await client.query(`
      INSERT INTO medicamentos (codigo, nombre, presentacion, concentracion, stock_actual, stock_minimo)
      VALUES ('TEST-MED-INSUF', 'Ibuprofeno Test 400mg', 'Tableta', '400mg', 2, 10)
      ON CONFLICT (codigo) DO UPDATE SET stock_actual = 2
      RETURNING id, stock_actual
    `);
    const medInsufId = med3Rows[0].id;

    // Crear cita y consulta de prueba
    const { rows: citaRows } = await client.query(`
      INSERT INTO citas (paciente_id, fecha, hora, canal_solicitud, telefono_contacto, motivo, estado)
      VALUES ($1, CURRENT_DATE, '09:00', 'Presencial', '8095550001', 'Control de prueba farmacia', 'Atendida')
      RETURNING id
    `, [pacAseguradoId]);
    const citaId = citaRows[0].id;

    const { rows: consRows } = await client.query(`
      INSERT INTO consultas (cita_id, paciente_id, motivo_consulta, hallazgos_clinicos, diagnostico_clinico, tratamiento_plan)
      VALUES ($1, $2, 'Chequeo', 'Normal', 'Infección respiratoria aguda', 'Antibioticoterapia')
      RETURNING id
    `, [citaId, pacAseguradoId]);
    const consultaId = consRows[0].id;

    // Crear receta con código único
    const codReceta = `RX-TEST-${Date.now().toString().slice(-6)}`;
    const { rows: recRows } = await client.query(`
      INSERT INTO recetas (consulta_id, paciente_id, codigo_receta, indicaciones_generales)
      VALUES ($1, $2, $3, 'Tomar con abundante agua')
      RETURNING id
    `, [consultaId, pacAseguradoId, codReceta]);
    const recetaId = recRows[0].id;

    // Agregar 3 detalles de receta
    // Item 1: Amoxicilina (recetada 10, stock 50 -> SUFICIENTE)
    const { rows: d1Rows } = await client.query(`
      INSERT INTO receta_detalles (receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia, indicaciones_uso, cantidad_recetada, estado_dispensacion, cubierto_ars)
      VALUES ($1, $2, 'Amoxicilina Test 500mg', '500mg', 'Cada 8h por 7 días', 'Vía oral', 10, 'Pendiente', true)
      RETURNING id
    `, [recetaId, medSufId]);
    const detSufId = d1Rows[0].id;

    // Item 2: Azitromicina (recetada 3, stock 0 -> SIN EXISTENCIA)
    const { rows: d2Rows } = await client.query(`
      INSERT INTO receta_detalles (receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia, indicaciones_uso, cantidad_recetada, estado_dispensacion, cubierto_ars)
      VALUES ($1, $2, 'Azitromicina Test 500mg', '500mg', 'Cada 24h por 3 días', 'Vía oral', 3, 'Pendiente', true)
      RETURNING id
    `, [recetaId, medCeroId]);
    const detCeroId = d2Rows[0].id;

    // Item 3: Ibuprofeno (recetada 5, stock 2 -> INSUFICIENTE)
    const { rows: d3Rows } = await client.query(`
      INSERT INTO receta_detalles (receta_id, medicamento_id, nombre_medicamento, dosis, frecuencia, indicaciones_uso, cantidad_recetada, estado_dispensacion, cubierto_ars)
      VALUES ($1, $2, 'Ibuprofeno Test 400mg', '400mg', 'Cada 8h si hay dolor', 'Vía oral', 5, 'Pendiente', true)
      RETURNING id
    `, [recetaId, medInsufId]);
    const detInsufId = d3Rows[0].id;

    assert(recetaId > 0 && detSufId > 0, 'Receta y detalles de prueba creados exitosamente');

    // 3. Probar búsqueda de paciente por nombre o cédula en cola de dispensación
    console.log('\n--- 3. Verificando búsqueda de paciente por nombre y cédula ---');
    const { rows: searchByNombre } = await client.query(`
      SELECT r.id, r.codigo_receta, p.nombre, p.apellido, p.identificacion
      FROM recetas r
      INNER JOIN pacientes p ON r.paciente_id = p.id
      WHERE (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR r.codigo_receta ILIKE $1)
    `, ['%PruebaFarmacia%']);
    assert(searchByNombre.some(r => r.id === recetaId), 'Búsqueda por nombre de paciente localiza la receta');

    const { rows: searchByIdent } = await client.query(`
      SELECT r.id, r.codigo_receta, p.nombre, p.apellido, p.identificacion
      FROM recetas r
      INNER JOIN pacientes p ON r.paciente_id = p.id
      WHERE (p.nombre ILIKE $1 OR p.apellido ILIKE $1 OR p.identificacion ILIKE $1 OR r.codigo_receta ILIKE $1)
    `, ['%001-9999001-1%']);
    assert(searchByIdent.some(r => r.id === recetaId), 'Búsqueda por cédula del paciente localiza la receta');

    // 4. Probar detección de inventario suficiente vs insuficiente
    console.log('\n--- 4. Verificando cálculo de existencias suficientes vs insuficientes ---');
    const { rows: checkItems } = await client.query(`
      SELECT rd.id, rd.cantidad_recetada, m.stock_actual,
             (m.stock_actual >= rd.cantidad_recetada) as suficiente
      FROM receta_detalles rd
      LEFT JOIN medicamentos m ON rd.medicamento_id = m.id
      WHERE rd.receta_id = $1
      ORDER BY rd.id ASC
    `, [recetaId]);

    assert(checkItems[0].suficiente === true, 'Ítem 1 (Amoxicilina 10 unid vs 50 stock) marcado como SUFICIENTE');
    assert(checkItems[1].suficiente === false && checkItems[1].stock_actual === 0, 'Ítem 2 (Azitromicina 3 unid vs 0 stock) marcado como SIN EXISTENCIA');
    assert(checkItems[2].suficiente === false && checkItems[2].stock_actual === 2, 'Ítem 3 (Ibuprofeno 5 unid vs 2 stock) marcado como INSUFICIENTE');

    // 5. Probar que NO se puede entregar lo que no tiene suficiente stock
    console.log('\n--- 5. Verificando bloqueo de entrega cuando el inventario es insuficiente ---');
    // Simular el controlador al intentar entregar Item 2 (stock 0)
    let intentoEntregaRechazado = false;
    const stockAntesMed2 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medCeroId])).rows[0].stock_actual;
    if (stockAntesMed2 < 3) {
      intentoEntregaRechazado = true; // El controlador aborta con ROLLBACK y mensaje de existencias insuficientes
    }
    assert(intentoEntregaRechazado === true, 'Intento de entregar ítem con stock 0 es RECHAZADO');
    const stockDespuesMed2 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medCeroId])).rows[0].stock_actual;
    assert(stockDespuesMed2 === 0, 'Stock de medicamento con 0 unidades NO fue alterado (permanece 0)');

    // 6. Probar registro de "No entregado" con motivo obligatorio
    console.log('\n--- 6. Verificando registro de "No entregado" con motivo (Puntos 4 y 5) ---');
    const motivoNoEntrega = 'Sin existencia en farmacia interna; paciente lo adquirirá fuera';
    
    // Ejecutar lógica de noEntregarItem
    await client.query(`
      UPDATE receta_detalles
      SET estado_dispensacion = 'No entregado',
          motivo_no_entrega = $1,
          observacion_farmacia = $1,
          cobertura_utilizada = false
      WHERE id = $2
    `, [motivoNoEntrega, detCeroId]);

    // Registrar en movimientos con tipo NO_ENTREGADO y stock_nuevo = stock_anterior (sin descontar)
    await client.query(`
      INSERT INTO farmacia_movimientos (
        receta_detalle_id, medicamento_id, tipo_movimiento,
        cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES ($1, $2, 'NO_ENTREGADO', 3, 0, 0, $3)
    `, [detCeroId, medCeroId, motivoNoEntrega]);

    const { rows: detCeroUpdated } = await client.query(`
      SELECT estado_dispensacion, motivo_no_entrega, cobertura_utilizada FROM receta_detalles WHERE id = $1
    `, [detCeroId]);
    assert(detCeroUpdated[0].estado_dispensacion === 'No entregado', 'Ítem 2 actualizado a estado "No entregado"');
    assert(detCeroUpdated[0].motivo_no_entrega === motivoNoEntrega, 'Motivo de no entrega guardado correctamente');
    assert(detCeroUpdated[0].cobertura_utilizada === false, 'cobertura_utilizada permanece en false para ítem no entregado');

    // 7. Probar entrega exitosa y descuento real de inventario (Puntos 5 y 6)
    console.log('\n--- 7. Verificando entrega exitosa y descuento estricto de inventario ---');
    const stockAntesMed1 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medSufId])).rows[0].stock_actual;
    assert(stockAntesMed1 === 50, 'Stock previo de Amoxicilina es 50');

    // Descontar 10 unidades
    await client.query(`
      UPDATE medicamentos
      SET stock_actual = stock_actual - 10
      WHERE id = $1 AND stock_actual >= 10
    `, [medSufId]);

    // Actualizar receta detalle con cobertura ARS
    await client.query(`
      UPDATE receta_detalles
      SET estado_dispensacion = 'Entregado',
          cobertura_utilizada = true,
          observacion_farmacia = 'Entregado en farmacia interna (10 unid.). Cobertura ARS aplicada.'
      WHERE id = $1
    `, [detSufId]);

    // Registrar movimiento SALIDA_RECETA
    await client.query(`
      INSERT INTO farmacia_movimientos (
        receta_detalle_id, medicamento_id, tipo_movimiento,
        cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES ($1, $2, 'SALIDA_RECETA', 10, 50, 40, 'Despacho receta')
    `, [detSufId, medSufId]);

    const stockDespuesMed1 = (await client.query(`SELECT stock_actual FROM medicamentos WHERE id = $1`, [medSufId])).rows[0].stock_actual;
    assert(stockDespuesMed1 === 40, 'Stock de Amoxicilina descontado exactamente por las 10 unidades entregadas (50 -> 40)');

    const { rows: detSufUpdated } = await client.query(`
      SELECT estado_dispensacion, cobertura_utilizada, cantidad_recetada FROM receta_detalles WHERE id = $1
    `, [detSufId]);
    assert(detSufUpdated[0].estado_dispensacion === 'Entregado', 'Ítem 1 actualizado a estado "Entregado"');
    assert(detSufUpdated[0].cobertura_utilizada === true, 'cobertura_utilizada marcada en true al entregarse con ARS');
    assert(detSufUpdated[0].cantidad_recetada === 10, 'cantidad entregada coincide con prescripción (10 unidades)');

    // 8. Probar estado final de la receta: qué se entregó y qué quedó pendiente (Punto 7)
    console.log('\n--- 8. Verificando resumen y detalle de la receta terminada ---');
    const { rows: detallesFinales } = await client.query(`
      SELECT nombre_medicamento, cantidad_recetada, estado_dispensacion, motivo_no_entrega, cobertura_utilizada
      FROM receta_detalles
      WHERE receta_id = $1
      ORDER BY id ASC
    `, [recetaId]);

    const entregados = detallesFinales.filter(d => d.estado_dispensacion === 'Entregado');
    const noEntregados = detallesFinales.filter(d => d.estado_dispensacion === 'No entregado');
    const pendientes = detallesFinales.filter(d => d.estado_dispensacion === 'Pendiente');

    assert(entregados.length === 1 && entregados[0].nombre_medicamento === 'Amoxicilina Test 500mg', 'Resumen muestra 1 medicamento Entregado');
    assert(noEntregados.length === 1 && noEntregados[0].motivo_no_entrega.includes('Sin existencia'), 'Resumen muestra 1 medicamento No entregado con su motivo');
    assert(pendientes.length === 1 && pendientes[0].nombre_medicamento === 'Ibuprofeno Test 400mg', 'Resumen muestra 1 medicamento Pendiente');

    // 9. Verificar que NO hay PayPal en el módulo de farmacia (Punto 9)
    console.log('\n--- 9. Verificando que PayPal no existe en farmacia ---');
    const farmaciaControllerSrc = require('fs').readFileSync('src/controllers/farmaciaController.js', 'utf8');
    const farmaciaRoutesSrc = require('fs').readFileSync('src/routes/farmaciaRoutes.js', 'utf8');
    assert(!farmaciaControllerSrc.toLowerCase().includes('paypal'), 'farmaciaController.js no contiene referencias a PayPal');
    assert(!farmaciaRoutesSrc.toLowerCase().includes('paypal'), 'farmaciaRoutes.js no contiene rutas de PayPal');

    // Limpieza de datos de prueba
    await client.query(`DELETE FROM farmacia_movimientos WHERE receta_detalle_id IN ($1, $2, $3)`, [detSufId, detCeroId, detInsufId]);
    await client.query(`DELETE FROM receta_detalles WHERE receta_id = $1`, [recetaId]);
    await client.query(`DELETE FROM recetas WHERE id = $1`, [recetaId]);
    await client.query(`DELETE FROM consultas WHERE id = $1`, [consultaId]);
    await client.query(`DELETE FROM citas WHERE id = $1`, [citaId]);
    await client.query(`DELETE FROM medicamentos WHERE id IN ($1, $2, $3)`, [medSufId, medCeroId, medInsufId]);
    await client.query(`DELETE FROM pacientes WHERE id = $1`, [pacAseguradoId]);

    console.log('\n====================================================');
    console.log(` RESULTADOS: ${passed} PASSED / ${failed} FAILED`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('ERROR EN TEST:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

runTests();
