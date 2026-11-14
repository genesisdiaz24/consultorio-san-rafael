const express = require('express');
const router = express.Router();
const farmaciaController = require('../controllers/farmaciaController');
const { requiereRol } = require('../middleware/auth');

// Consultar inventario (Exclusivo Farmacia y Administrador; Médico y Secretaría bloqueados con 403)
router.get('/', (req, res) => res.redirect('/farmacia/inventario'));
router.get('/inventario', requiereRol('FARMACIA'), farmaciaController.inventario);
router.get('/inventario/ia-estimaciones', requiereRol('FARMACIA'), farmaciaController.obtenerEstimacionesIaJson);

// Catálogo de medicamentos (Crear nuevo: exclusivo ADMINISTRADOR; Reabastecer existencias: FARMACIA)
router.post('/inventario', requiereRol('ADMINISTRADOR'), farmaciaController.crearMedicamento);
router.post('/inventario/:id/ajustar', requiereRol('FARMACIA'), farmaciaController.ajustarStock);

// Dispensación de recetas y auditoría (Exclusivo FARMACIA y Administrador)
router.get('/dispensar', requiereRol('FARMACIA'), farmaciaController.colaDispensacion);
router.get('/dispensar/:id', requiereRol('FARMACIA'), farmaciaController.verRecetaDispensar);
router.post('/dispensar/:detalleId/entregar', requiereRol('FARMACIA'), farmaciaController.entregarItem);
router.post('/dispensar/:detalleId/no-entregar', requiereRol('FARMACIA'), farmaciaController.noEntregarItem);
router.get('/movimientos', requiereRol('FARMACIA'), farmaciaController.movimientos);

// Asistente de IA de Farmacia Interna (Chat Box conversacional)
router.get('/chat', requiereRol('FARMACIA'), farmaciaController.vistaChat);
router.post('/chat/mensaje', requiereRol('FARMACIA'), farmaciaController.procesarMensajeChat);

module.exports = router;
