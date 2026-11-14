const express = require('express');
const router = express.Router();
const citaController = require('../controllers/citaController');
const { requiereRol } = require('../middleware/auth');

// Monitor de Sala de Espera: Accesible para Médico, Secretaría y Administrador
router.get('/sala-espera', requiereRol('MEDICO', 'SECRETARIA', 'RECEPCION'), citaController.salaEspera);

// Gestión de Agenda y Citas: Exclusivo de Secretaría y Administrador (Médico y Farmacia bloqueados con 403)
router.get('/', requiereRol('SECRETARIA', 'RECEPCION'), citaController.listar);
router.get('/nueva', requiereRol('SECRETARIA', 'RECEPCION'), citaController.formularioCrear);
router.post('/', requiereRol('SECRETARIA', 'RECEPCION'), citaController.crear);
router.post('/:id/confirmar-llegada', requiereRol('SECRETARIA', 'RECEPCION'), citaController.confirmarLlegada);
router.post('/:id/cancelar', requiereRol('SECRETARIA', 'RECEPCION'), citaController.cancelar);

module.exports = router;
