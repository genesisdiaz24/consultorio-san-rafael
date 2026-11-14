const express = require('express');
const router = express.Router();
const ecfController = require('../controllers/ecfController');
const { requiereRol } = require('../middleware/auth');

// Acceso exclusivo para usuarios autorizados a facturación y emisión fiscal (Administrador y Secretaría/Recepción; Médico bloqueado)
router.use(requiereRol('ADMINISTRADOR', 'SECRETARIA', 'RECEPCION'));

// Listado de facturas y estado de comprobantes electrónicos
router.get('/', ecfController.listarFacturasEcf);

// Verificar conectividad y ambiente (TesteCF vs Producción eCF) de IMECF_API_KEY
router.post('/verificar-conexion', ecfController.verificarConexion);

// Vista de factura y gestión de e-CF de una consulta específica
router.get('/factura/:consultaId', ecfController.verFacturaEcf);

// Paso 1 (Secretaría): Revisar y actualizar liquidación, servicio y cobertura ARS antes de cobrar
router.post('/factura/:consultaId/actualizar-liquidacion', ecfController.actualizarLiquidacion);

// Paso 1 (Secretaría): Registrar el cobro de la factura antes de emitir el comprobante electrónico
router.post('/factura/:consultaId/registrar-cobro', ecfController.registrarCobro);

// Paso 2: Emisión real del comprobante electrónico hacia IMECF (POST /api/v1/ecf/send vía backend)
router.post('/factura/:consultaId/emitir', ecfController.emitirComprobante);

// Consulta de estado en IMECF (GET /api/v1/ecf/{id}/status vía backend)
router.get('/documento/:id/status', ecfController.actualizarEstado);
router.post('/documento/:id/consultar-estado', ecfController.actualizarEstado);

// Consulta de trackId en la DGII vía IMECF (GET /api/v1/ecf/{id}/track vía backend)
router.post('/documento/:id/consultar-track', ecfController.consultarTrack);

// Descarga de XML firmado desde IMECF (GET /api/v1/ecf/{id}/xml vía backend sin exponer IMECF_API_KEY)
router.get('/documento/:id/xml', ecfController.descargarXml);

// Representación Impresa (HTML / PDF imprimible)
router.get('/documento/:id/impresion', ecfController.verRepresentacionImpresa);

// Envío del comprobante por correo electrónico al paciente (paso separado)
router.post('/documento/:id/enviar-correo', ecfController.enviarComprobanteCorreo);

// Conciliación de envío incierto por timeout antes de reenviar
router.post('/documento/:id/conciliar', ecfController.conciliarTimeout);

module.exports = router;
