const express = require('express');
const router = express.Router();
const consultaController = require('../controllers/consultaController');
const { requiereRol } = require('../middleware/auth');

// Consultas, historiales clínicos y recetas: Exclusivo para Médicos y Administradores (Secretaría y Farmacia bloqueadas con 403)
router.use(requiereRol('MEDICO'));

// Consultas y atención
router.get('/', consultaController.listar);
router.get('/atender', consultaController.formularioAtender);
router.post('/', consultaController.guardar);

// Historiales clínicos de pacientes
router.get('/historial', consultaController.historialClinico);
router.get('/historial/:pacienteId', consultaController.verHistorialPaciente);

// Recetas médicas emitidas
router.get('/recetas', consultaController.listarRecetas);
router.get('/recetas/:id', consultaController.verReceta);

// Detalle de consulta médica
router.get('/:id', consultaController.verDetalle);

module.exports = router;
