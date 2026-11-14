/**
 * CONSULTORIO MÉDICO SAN RAFAEL
 * JavaScript para interacciones del lado del cliente
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Auto-descartar alertas de éxito e información tras 6 segundos
  const alerts = document.querySelectorAll('.alert-success, .alert-info');
  alerts.forEach((alert) => {
    setTimeout(() => {
      try {
        const bsAlert = bootstrap.Alert.getOrCreateInstance(alert);
        bsAlert.close();
      } catch (_) {}
    }, 6000);
  });

  // 2. Validación de formularios con estilo Bootstrap
  const forms = document.querySelectorAll('.needs-validation');
  Array.from(forms).forEach((form) => {
    form.addEventListener(
      'submit',
      (event) => {
        if (!form.checkValidity()) {
          event.preventDefault();
          event.stopPropagation();
        }
        form.classList.add('was-validated');
      },
      false
    );
  });

  // 3. Prevenir doble envío involuntario en botones de guardar
  const submitButtons = document.querySelectorAll('form:not([data-no-disable]) button[type="submit"]');
  submitButtons.forEach((btn) => {
    const form = btn.closest('form');
    if (form) {
      form.addEventListener('submit', () => {
        if (form.checkValidity()) {
          setTimeout(() => {
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> Guardando...`;
          }, 50);
        }
      });
    }
  });

  // 4. Inyección automática de token CSRF en todos los formularios POST
  const metaCsrf = document.querySelector('meta[name="csrf-token"]');
  const tokenCsrf = metaCsrf ? metaCsrf.getAttribute('content') : '';
  if (tokenCsrf) {
    document.querySelectorAll('form').forEach((form) => {
      const method = (form.getAttribute('method') || '').toUpperCase();
      if (method === 'POST' && !form.querySelector('input[name="_csrf"]')) {
        const inputCsrf = document.createElement('input');
        inputCsrf.type = 'hidden';
        inputCsrf.name = '_csrf';
        inputCsrf.value = tokenCsrf;
        form.prepend(inputCsrf);
      }
    });
  }

  // 5. Botón para mostrar/ocultar campo de contraseña
  document.querySelectorAll('.btn-toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      const icon = btn.querySelector('i');
      if (input.type === 'password') {
        input.type = 'text';
        if (icon) {
          icon.classList.remove('bi-eye');
          icon.classList.add('bi-eye-slash');
        }
      } else {
        input.type = 'password';
        if (icon) {
          icon.classList.remove('bi-eye-slash');
          icon.classList.add('bi-eye');
        }
      }
    });
  });
});

// 6. Protección de seguridad para navegación con botones Atrás/Adelante y Caché del Navegador (BFCache)
window.addEventListener('pageshow', (event) => {
  // Detectar si la página fue restaurada desde el BFCache del navegador o navegación del historial
  const navEntries = window.performance && window.performance.getEntriesByType ? window.performance.getEntriesByType('navigation') : [];
  const isBackForward =
    event.persisted ||
    (window.performance &&
      (window.performance.navigation?.type === 2 ||
        (navEntries.length > 0 && navEntries[0].type === 'back_forward')));

  // Si se navegó con el botón Atrás o Adelante a una página protegida y no es la pantalla de login
  const isAuthPage = document.body && document.body.classList.contains('auth-page');
  const metaCsrf = document.querySelector('meta[name="csrf-token"]');
  if (isBackForward && metaCsrf && !isAuthPage) {
    const tokenCsrf = metaCsrf.getAttribute('content') || '';
    // Validar de inmediato con el servidor si la sesión sigue activa
    fetch('/api/session/keep-alive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': tokenCsrf,
      },
    })
      .then((res) => {
        if (!res.ok || res.status === 401) {
          // Sesión cerrada o inválida: redirigir inmediatamente al login sin mostrar información previa
          window.location.replace('/login');
        } else if (event.persisted) {
          // Si la sesión sigue activa pero vino de un snapshot BFCache congelado, recargar datos frescos
          window.location.reload();
        }
      })
      .catch(() => {
        window.location.replace('/login');
      });
  }
});

