/**
 * DETECTOR Y GESTOR DE INACTIVIDAD DE SESIÓN (15 MINUTOS)
 * Consultorio Médico San Rafael
 * 
 * Reglas de seguridad implementadas:
 * - Cuenta actividad: clics, teclas, scroll, toques en pantalla.
 * - Evita enviar solicitudes innecesarias en cada clic (throttle de 2 minutos).
 * - Sincronizado con validación estricta en el servidor.
 * - Al expirar redirige con mensaje: "Tu sesión ha expirado por inactividad".
 */

(function () {
  const TIEMPO_INACTIVIDAD_MS = 15 * 60 * 1000; // 15 minutos exactos
  const INTERVALO_PING_MINIMO_MS = 2 * 60 * 1000; // Máximo 1 ping al servidor cada 2 min de actividad
  const INTERVALO_REVISION_MS = 10 * 1000; // Revisar cada 10 segundos

  let ultimoTiempoActividad = Date.now();
  let ultimoPingServidor = Date.now();
  let sesionExpirada = false;

  function registrarActividad() {
    if (sesionExpirada) return;
    const ahora = Date.now();
    ultimoTiempoActividad = ahora;

    // Throttle inteligente: Solo envía ping si han pasado al menos 2 minutos desde el último registro
    if (ahora - ultimoPingServidor >= INTERVALO_PING_MINIMO_MS) {
      ultimoPingServidor = ahora;
      enviarPingServidor();
    }
  }

  function enviarPingServidor() {
    fetch('/api/session/keep-alive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
      .then((res) => {
        if (res.status === 401) {
          cerrarPorInactividad();
        }
        return res.json();
      })
      .then((data) => {
        if (data && data.expirado) {
          cerrarPorInactividad();
        }
      })
      .catch((_) => {
        // En caso de desconexión temporal de red, continuar monitoreo local
      });
  }

  function cerrarPorInactividad() {
    if (sesionExpirada) return;
    sesionExpirada = true;

    // Remover escuchadores para evitar ejecuciones adicionales
    eventos.forEach((evento) => {
      window.removeEventListener(evento, registrarActividad);
    });

    // Limpiar estado en página y redirigir al inicio de sesión con mensaje
    window.location.href = '/login?inactividad=1';
  }

  // Escuchar interacciones humanas reales en la interfaz
  const eventos = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
  eventos.forEach((evento) => {
    window.addEventListener(evento, registrarActividad, { passive: true });
  });

  // Verificación periódica local del tiempo transcurrido
  setInterval(() => {
    if (sesionExpirada) return;
    const transcurrido = Date.now() - ultimoTiempoActividad;
    if (transcurrido >= TIEMPO_INACTIVIDAD_MS) {
      cerrarPorInactividad();
    }
  }, INTERVALO_REVISION_MS);
})();

