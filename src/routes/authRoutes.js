const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { yaAutenticado, requiereAutenticacion } = require('../middleware/auth');
const { loginLimiter, passwordResetLimiter } = require('../middleware/security');

// 1. Inicio y Cierre de Sesión
router.get('/login', yaAutenticado, authController.formularioLogin);
router.post('/login', yaAutenticado, loginLimiter, authController.iniciarSesion);
router.get('/logout', authController.cerrarSesion);
router.post('/logout', authController.cerrarSesion);

// 2. Latido de Sesión / Detección de Actividad
router.post('/api/session/keep-alive', authController.keepAlive);

// 3. Recuperación de Contraseña
router.get('/recuperar-contrasena', yaAutenticado, authController.formularioRecuperar);
router.post('/recuperar-contrasena', yaAutenticado, passwordResetLimiter, authController.solicitarRecuperacion);

// 4. Restablecimiento con Token
router.get('/restablecer-contrasena/:token', yaAutenticado, authController.formularioRestablecer);
router.post('/restablecer-contrasena/:token', yaAutenticado, passwordResetLimiter, authController.procesarRestablecer);

module.exports = router;
