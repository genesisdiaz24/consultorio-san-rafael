const express = require('express');
const router = express.Router();
const usuarioController = require('../controllers/usuarioController');
const { requiereRol } = require('../middleware/auth');

// Solo administradores pueden gestionar usuarios
router.use(requiereRol('ADMINISTRADOR'));

router.get('/', usuarioController.listar);
router.get('/nuevo', usuarioController.formularioCrear);
router.post('/', usuarioController.crear);
router.post('/:id/estado', usuarioController.cambiarEstado);

module.exports = router;
