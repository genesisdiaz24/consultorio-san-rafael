const express = require('express');
const router = express.Router();
const reporteController = require('../controllers/reporteController');

// El permiso se valida por reporte en el controlador (cada módulo define qué roles lo ven;
// ADMINISTRADOR ve los 36 reportes).
router.get('/', reporteController.index);
router.get('/:id', reporteController.ver);
router.get('/:id/csv', reporteController.csv);

module.exports = router;
