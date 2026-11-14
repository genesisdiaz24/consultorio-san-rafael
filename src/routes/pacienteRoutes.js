const express = require('express');
const router = express.Router();
const pacienteController = require('../controllers/pacienteController');
const { requiereRol } = require('../middleware/auth');

// 1. Directorio y Registro de Pacientes: Exclusivo Secretaría y Administrador (Médico y Farmacia bloqueados con 403)
router.get('/', requiereRol('SECRETARIA', 'RECEPCION'), pacienteController.listar);
router.get('/nuevo', requiereRol('SECRETARIA', 'RECEPCION'), pacienteController.formularioCrear);
router.post('/', requiereRol('SECRETARIA', 'RECEPCION'), pacienteController.crear);

// 2. Edición de Datos de Pacientes: Exclusivo Secretaría y Administrador
router.get('/:id/editar', requiereRol('SECRETARIA', 'RECEPCION'), pacienteController.formularioEditar);
router.post('/:id', requiereRol('SECRETARIA', 'RECEPCION'), pacienteController.actualizar);

// 3. Ver Ficha e Historial Clínico: Accesible para Médico, Secretaría y Administrador (Farmacia bloqueada con 403)
router.get('/:id', requiereRol('SECRETARIA', 'RECEPCION', 'MEDICO'), pacienteController.verFicha);

module.exports = router;
