const express = require('express');
const router = express.Router();
const paypalController = require('../controllers/paypalController');
const { requiereRol } = require('../middleware/auth');

// Acceso exclusivo a roles autorizados para cobro y facturación (Administrador y Secretaría/Recepción; Médico bloqueado)
router.use(requiereRol('ADMINISTRADOR', 'SECRETARIA', 'RECEPCION'));

// Crear orden de pago en PayPal desde el backend (calculando importe de copago desde BD)
router.post('/crear-orden/:consultaId', paypalController.crearOrden);

// Capturar y verificar orden de pago en PayPal desde el backend
router.post('/capturar-orden/:consultaId', paypalController.capturarOrden);

// Registrar cancelación de orden de pago en PayPal
router.post('/cancelar-orden/:consultaId', paypalController.cancelarOrden);

// Ver y generar comprobante de pago electrónico de PayPal
router.get('/comprobante/:consultaId', paypalController.verComprobantePago);

module.exports = router;

