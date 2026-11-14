const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Genera el hash de una contraseña usando bcrypt (OWASP recomendado)
 * @param {string} password 
 * @returns {{ hash: string, salt: string }}
 */
function hashPassword(password) {
  const salt = bcrypt.genSaltSync(12);
  const hash = bcrypt.hashSync(password, salt);
  return { hash, salt };
}

/**
 * Verifica si una contraseña coincide con el hash almacenado.
 * Soporta hashes bcrypt y mantiene compatibilidad segura con PBKDF2 para cuentas existentes.
 * @param {string} password 
 * @param {string} hashGuardado 
 * @param {string} saltGuardado 
 * @returns {{ esValida: boolean, esBcrypt: boolean }}
 */
function verifyPassword(password, hashGuardado, saltGuardado) {
  if (!password || !hashGuardado) {
    return { esValida: false, esBcrypt: false };
  }

  const candidatos = [String(password)];
  if (String(password).trim() !== String(password) && String(password).trim().length > 0) {
    candidatos.push(String(password).trim());
  }

  // 1. Verificación si el hash fue generado con bcrypt ($2a$, $2b$, $2y$)
  if (hashGuardado.startsWith('$2a$') || hashGuardado.startsWith('$2b$') || hashGuardado.startsWith('$2y$')) {
    for (const pwd of candidatos) {
      if (bcrypt.compareSync(pwd, hashGuardado)) {
        return { esValida: true, esBcrypt: true };
      }
    }
    return { esValida: false, esBcrypt: true };
  }

  // 2. Compatibilidad transparente con PBKDF2 previo
  if (saltGuardado) {
    for (const pwd of candidatos) {
      try {
        const hashCalculado = crypto.pbkdf2Sync(pwd, saltGuardado, 10000, 64, 'sha512').toString('hex');
        const bufCalc = Buffer.from(hashCalculado, 'hex');
        const bufGuardado = Buffer.from(hashGuardado, 'hex');
        if (bufCalc.length === bufGuardado.length && crypto.timingSafeEqual(bufCalc, bufGuardado)) {
          return { esValida: true, esBcrypt: false };
        }
      } catch (_) {}

      try {
        const hashCalculado1000 = crypto.pbkdf2Sync(pwd, saltGuardado, 1000, 64, 'sha512').toString('hex');
        const bufCalc = Buffer.from(hashCalculado1000, 'hex');
        const bufGuardado = Buffer.from(hashGuardado, 'hex');
        if (bufCalc.length === bufGuardado.length && crypto.timingSafeEqual(bufCalc, bufGuardado)) {
          return { esValida: true, esBcrypt: false };
        }
      } catch (_) {}
    }
  }

  // 3. Compatibilidad con SHA-256 hex (64 caracteres) si existiera en registros previos
  if (/^[a-f0-9]{64}$/i.test(hashGuardado)) {
    for (const pwd of candidatos) {
      const shaSimple = crypto.createHash('sha256').update(pwd).digest('hex');
      const shaConSalt = saltGuardado
        ? crypto.createHash('sha256').update(pwd + saltGuardado).digest('hex')
        : '';
      if (
        shaSimple.toLowerCase() === hashGuardado.toLowerCase() ||
        (shaConSalt && shaConSalt.toLowerCase() === hashGuardado.toLowerCase())
      ) {
        return { esValida: true, esBcrypt: false };
      }
    }
  }

  // 4. Fallback por si una cuenta fue insertada manualmente en texto plano en la BD (se migrará a bcrypt al entrar)
  if (!/^[a-f0-9]{64,128}$/i.test(hashGuardado)) {
    for (const pwd of candidatos) {
      if (pwd === hashGuardado) {
        return { esValida: true, esBcrypt: false };
      }
    }
  }

  return { esValida: false, esBcrypt: false };
}

/**
 * Genera un token criptográficamente seguro para recuperación de contraseña
 * @returns {{ tokenPlano: string, tokenHash: string, expiraEn: Date }}
 */
function generatePasswordResetToken() {
  const tokenPlano = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(tokenPlano);
  const expiraEn = new Date(Date.now() + 15 * 60 * 1000); // Válido por 15 minutos
  return { tokenPlano, tokenHash, expiraEn };
}

/**
 * Genera el hash SHA-256 de un token para comparación segura en base de datos
 * @param {string} token 
 * @returns {string}
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token).trim()).digest('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generatePasswordResetToken,
  hashToken,
};
