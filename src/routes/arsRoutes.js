const express = require('express');
const router = express.Router();
const arsController = require('../controllers/arsController');
const { requiereRol } = require('../middleware/auth');

// Simulador y calculadora de cobros y coberturas (exclusivo para Secretaría y Administrador; Médico y Farmacia bloqueados con 403)
router.get('/calcular', requiereRol('SECRETARIA', 'RECEPCION'), arsController.calculadora);
router.get('/api/calcular', requiereRol('SECRETARIA', 'RECEPCION'), arsController.apiCalcular);

// Módulo de Cobros y Liquidación al Paciente (exclusivo para Secretaría y Administrador; Médico bloqueado con 403)
router.get('/cobrar', requiereRol('SECRETARIA', 'RECEPCION'), arsController.listarCobros);
router.post('/cobrar/:consultaId', requiereRol('SECRETARIA', 'RECEPCION'), arsController.registrarCobro);
router.post('/cobrar/:consultaId/liquidar', requiereRol('SECRETARIA', 'RECEPCION'), arsController.actualizarLiquidacionCobro);

// Consulta de ARS y de sus tarifas: Secretaría/Recepción solo lectura (el Administrador siempre tiene acceso)
router.get('/', requiereRol('SECRETARIA', 'RECEPCION'), arsController.listar);
router.get('/:id/tarifas', requiereRol('SECRETARIA', 'RECEPCION'), arsController.verTarifas);

// Registro de nuevas ARS y configuración de tarifas/coberturas: SOLO ADMINISTRADOR (403 para los demás)
router.get('/nueva', requiereRol('ADMINISTRADOR'), arsController.formularioCrear);
router.post('/', requiereRol('ADMINISTRADOR'), arsController.crear);
router.post('/:id/tarifas', requiereRol('ADMINISTRADOR'), arsController.guardarTarifa);
router.post('/:id/tarifas/:tarifaId/eliminar', requiereRol('ADMINISTRADOR'), arsController.eliminarTarifa);

module.exports = router;
