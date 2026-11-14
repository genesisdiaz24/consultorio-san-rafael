const nodemailer = require('nodemailer');

/**
 * Servicio de envío de correos electrónicos
 * Soporta configuración SMTP real y fallback seguro para entorno de desarrollo local.
 */
/**
 * Convierte un monto (número, "1000.00", "RD$ 1,000.00") a "RD$ 1,000.00".
 * Si no hay un monto válido devuelve "—" (nunca "NaN").
 */
function formatearMontoRD(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return '—';
  const limpio = typeof valor === 'number' ? String(valor) : String(valor).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(limpio)) return '—';
  const numero = Number(limpio);
  if (!Number.isFinite(numero)) return '—';
  return 'RD$ ' + numero.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * TrackID de la DGII para mostrar. En TesteCF/CerteCF IMECF puede no devolverlo:
 * se indica claramente para que no parezca un error.
 */
function textoTrackId(trackId, ambiente) {
  if (trackId) return trackId;
  return ambiente === 'eCF' ? 'Pendiente de asignación' : 'No asignado (ambiente de pruebas)';
}

class EmailService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

    if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
      this.transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT, 10) || 587,
        secure: parseInt(SMTP_PORT, 10) === 465,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
      });
    }
  }

  /**
   * Envía correo con enlace de recuperación de contraseña
   * @param {string} correoDestino 
   * @param {string} nombreUsuario 
   * @param {string} tokenPlano 
   * @param {string} baseUrl 
   */
  async enviarRecuperacionContrasena(correoDestino, nombreUsuario, tokenPlano, baseUrl) {
    const enlaceRecuperacion = `${baseUrl}/restablecer-contrasena/${encodeURIComponent(tokenPlano)}`;

    // Si hay un transporte SMTP configurado en producción o desarrollo
    if (this.transporter) {
      const remitente = process.env.SMTP_FROM || `noreply@${process.env.DOMAIN || 'sanrafael.com'}`;
      await this.transporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'Consultorio Médico San Rafael'}" <${remitente}>`,
        to: correoDestino,
        subject: 'Recuperación de contraseña - Consultorio Médico San Rafael',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h2 style="color: #0f766e; margin-top: 0;">Recuperación de Contraseña</h2>
            <p>Hola <strong>${nombreUsuario}</strong>,</p>
            <p>Hemos recibido una solicitud para restablecer la contraseña de su cuenta en el <strong>Consultorio Médico San Rafael</strong>.</p>
            <p>Este enlace es válido por <strong>15 minutos</strong> y puede usarse una sola vez:</p>
            <p style="text-align: center; margin: 28px 0;">
              <a href="${enlaceRecuperacion}" style="background-color: #0f766e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Restablecer mi contraseña
              </a>
            </p>
            <p style="font-size: 13px; color: #666;">Si no puede hacer clic en el botón, copie y pegue el siguiente enlace en su navegador:</p>
            <p style="font-size: 12px; color: #0f766e; word-break: break-all;">${enlaceRecuperacion}</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
            <p style="font-size: 12px; color: #999;">Si no solicitó este cambio, puede ignorar este mensaje de forma segura. Su contraseña no cambiará.</p>
          </div>
        `,
        text: `Hola ${nombreUsuario},\n\nPara restablecer su contraseña, ingrese al siguiente enlace (válido por 15 minutos):\n${enlaceRecuperacion}\n\nSi no solicitó este cambio, ignore este mensaje.`,
      });
      return { enviado: true, metodo: 'smtp' };
    }

    // Modo desarrollo local sin SMTP configurado:
    // Muestra el enlace en la consola del servidor para permitir pruebas sin exponerlo en la UI
    if (process.env.NODE_ENV !== 'production') {
      console.log('\n================================================================');
      console.log('✉️  [SERVICIO DE CORREO - MODO DESARROLLO LOCAL]');
      console.log(`Para: ${correoDestino} (${nombreUsuario})`);
      console.log('Asunto: Recuperación de Contraseña - Consultorio Médico San Rafael');
      console.log(`Enlace de recuperación (válido 15 min): ${enlaceRecuperacion}`);
      console.log('================================================================\n');
      return { enviado: true, metodo: 'consola_dev' };
    }

    console.warn('[ALERTA EMAIL]: Servidor SMTP no configurado en producción.');
    return { enviado: false, metodo: 'no_configurado' };
  }

  /**
   * Envía como paso separado la representación del comprobante electrónico (e-CF) y su XML firmado al correo del paciente/comprador.
   * Muestra con transparencia si se envió vía SMTP, si se registró en consola local (desarrollo sin SMTP) o si falló.
   */
  async enviarComprobanteEcf({
    correoDestino,
    nombreComprador,
    encf,
    tipoEcf,
    estadoDgii,
    trackId,
    codigoSeguridad,
    montoTotal,
    fechaEmision,
    ambiente,
    modoSimulacion,
    dgiiUrl,
    representacionHtml,
    xmlFirmado,
  }) {
    this.initTransporter();

    if (!correoDestino || !String(correoDestino).includes('@')) {
      return {
        enviado: false,
        metodo: 'validacion',
        mensaje: 'No se pudo enviar el correo: la dirección de correo electrónico del paciente/comprador no es válida.',
      };
    }

    const asunto = `${modoSimulacion ? '[DEMOSTRACIÓN] ' : ''}Comprobante Electrónico ${encf || tipoEcf} - Consultorio Médico San Rafael`;
    const attachments = [];
    if (xmlFirmado) {
      attachments.push({
        filename: `${encf || 'comprobante_ecf'}.xml`,
        content: xmlFirmado,
        contentType: 'application/xml; charset=utf-8',
      });
    }
    if (representacionHtml) {
      attachments.push({
        filename: `Representacion_${encf || 'ecf'}.html`,
        content: representacionHtml,
        contentType: 'text/html; charset=utf-8',
      });
    }

    const cuerpoHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 24px; border: 1px solid #d1d5db; border-radius: 10px;">
        <h2 style="color: #0f766e; margin-top: 0;">Comprobante Fiscal Electrónico (e-CF)</h2>
        <p>Estimado(a) <strong>${nombreComprador || 'Paciente'}</strong>,</p>
        <p>Adjunto encontrará la representación de su Comprobante Fiscal Electrónico emitido por el <strong>Consultorio Médico San Rafael</strong>.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #6b7280;">Número de e-NCF:</td><td style="padding: 6px 0; font-weight: bold;">${encf || 'N/A'} (${tipoEcf})</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280;">Estado DGII:</td><td style="padding: 6px 0; font-weight: bold;">${estadoDgii}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280;">TrackID DGII:</td><td style="padding: 6px 0; font-family: monospace;">${textoTrackId(trackId, ambiente)}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280;">Código de Seguridad:</td><td style="padding: 6px 0; font-family: monospace;">${codigoSeguridad || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280;">Ambiente:</td><td style="padding: 6px 0;">${ambiente || 'TesteCF'}${modoSimulacion ? ' (Modo Demostración)' : ''}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280;">Monto Total Facturado:</td><td style="padding: 6px 0; font-weight: bold; color: #0f766e;">${formatearMontoRD(montoTotal)}</td></tr>
        </table>
        ${
          dgiiUrl
            ? `<p style="margin: 20px 0;"><a href="${dgiiUrl}" style="background-color: #0f766e; color: #ffffff; padding: 10px 18px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verificar Timbre en Portal DGII</a></p>`
            : ''
        }
        <p style="font-size: 12px; color: #6b7280; margin-top: 20px;">Nota de privacidad: Este documento contiene exclusivamente datos fiscales y no incluye diagnósticos ni información clínica.</p>
      </div>
    `;

    const tieneSmtpReal =
      this.transporter &&
      process.env.SMTP_HOST &&
      process.env.SMTP_HOST !== 'smtp.ejemplo.com' &&
      process.env.SMTP_PASS &&
      process.env.SMTP_PASS !== 'tu_password_smtp_aqui';

    if (tieneSmtpReal) {
      try {
        const remitente = process.env.SMTP_FROM || `noreply@${process.env.DOMAIN || 'sanrafael.com'}`;
        await this.transporter.sendMail({
          from: `"${process.env.SMTP_FROM_NAME || 'Consultorio Médico San Rafael'}" <${remitente}>`,
          to: correoDestino,
          subject: asunto,
          html: cuerpoHtml,
          attachments,
        });
        return {
          enviado: true,
          metodo: 'smtp',
          mensaje: `El comprobante ${encf} y su representación fueron enviados exitosamente por SMTP a ${correoDestino}.`,
        };
      } catch (smtpErr) {
        return {
          enviado: false,
          metodo: 'smtp_error',
          mensaje: `Fallo al enviar el correo mediante el servidor SMTP (${process.env.SMTP_HOST}): ${smtpErr.message}`,
        };
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('\n================================================================');
      console.log('✉️  [CORREO DE COMPROBANTE e-CF - DESARROLLO LOCAL]');
      console.log(`Para: ${correoDestino} (${nombreComprador})`);
      console.log(`Asunto: ${asunto}`);
      console.log(`e-NCF: ${encf} | TrackID DGII: ${textoTrackId(trackId, ambiente)} | Total: ${formatearMontoRD(montoTotal)} | Estado: ${estadoDgii}`);
      console.log(`Adjuntos preparados: ${attachments.map((a) => a.filename).join(', ')}`);
      console.log('================================================================\n');
      return {
        enviado: false,
        metodo: 'consola_dev',
        mensaje: `El correo NO se envió a ${correoDestino}: el servidor de correo (SMTP) no está configurado en el archivo .env. Solo se registró en la consola del servidor.`,
      };
    }

    return {
      enviado: false,
      metodo: 'no_configurado',
      mensaje: 'El servidor SMTP no está configurado con credenciales reales en el archivo .env (SMTP_HOST, SMTP_USER, SMTP_PASS).',
    };
  }
}

module.exports = new EmailService();
module.exports.formatearMontoRD = formatearMontoRD;
module.exports.textoTrackId = textoTrackId;


