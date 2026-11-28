/**
 * Campo de fecha escrito con teclado + calendario con menú de mes y año.
 * Se activa en cualquier <input data-campo-fecha> que esté dentro de un .input-group con
 * un botón [data-abrir-calendario] y, después del grupo, un <div class="invalid-feedback">.
 *
 *  - Escritura DD/MM/AAAA con barras automáticas (22041999 → 22/04/1999).
 *  - También acepta AAAA-MM-DD (se muestra luego como DD/MM/AAAA).
 *  - Rango: data-min (AAAA-MM-DD, por defecto 1900-01-01) y data-max ("hoy" o AAAA-MM-DD).
 */
(function () {
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  const dos = (n) => String(n).padStart(2, '0');
  const aIso = (y, m, d) => `${y}-${dos(m)}-${dos(d)}`;
  const aTexto = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
  const formatoLegible = (iso) => aTexto(iso);

  function hoyIso() {
    const d = new Date();
    return aIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  // DD/MM/AAAA o AAAA-MM-DD → AAAA-MM-DD (null si no existe la fecha)
  function normalizar(texto) {
    const s = String(texto || '').trim();
    let y, m, d;
    let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (r) {
      [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
    } else {
      r = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (!r) return null;
      [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    }
    const f = new Date(y, m - 1, d);
    if (f.getFullYear() !== y || f.getMonth() !== m - 1 || f.getDate() !== d) return null;
    return aIso(y, m, d);
  }

  // Inserta las barras mientras se escriben solo dígitos: 2204 → 22/04, 22041999 → 22/04/1999
  function conBarras(valor) {
    // Escribió 4 dígitos y luego "-": era un año (AAAA-MM-DD), se quita la barra automática (19/99- → 1999-)
    const anio = valor.match(/^(\d{2})\/(\d{2})-(.*)$/);
    if (anio) return `${anio[1]}${anio[2]}-${anio[3]}`;
    if (/-/.test(valor)) return valor; // está escribiendo AAAA-MM-DD
    const digitos = valor.replace(/\D/g, '').slice(0, 8);
    if (digitos.length > 4) return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4)}`;
    if (digitos.length > 2) return `${digitos.slice(0, 2)}/${digitos.slice(2)}`;
    return digitos;
  }

  function iniciar(input) {
    const grupo = input.closest('.input-group');
    const boton = grupo ? grupo.querySelector('[data-abrir-calendario]') : null;
    const ayuda = grupo ? grupo.parentElement.querySelector('.invalid-feedback') : null;
    const min = input.dataset.min || '1900-01-01';
    const max = !input.dataset.max || input.dataset.max === 'hoy' ? hoyIso() : input.dataset.max;
    const obligatorio = input.hasAttribute('required');

    function error() {
      const valor = input.value.trim();
      if (!valor) return obligatorio ? 'La fecha de nacimiento es obligatoria.' : '';
      const iso = normalizar(valor);
      if (!iso) return 'Fecha no válida. Escríbala como DD/MM/AAAA (ej: 15/05/1990) o AAAA-MM-DD.';
      if (iso < min) return `La fecha no puede ser anterior al ${formatoLegible(min)}.`;
      if (iso > max) return 'La fecha no puede ser una fecha futura.';
      return '';
    }

    // mostrar = true pinta el mensaje; con false solo actualiza la validez interna del formulario
    function validar(mostrar) {
      const msg = error();
      input.setCustomValidity(msg);
      if (ayuda) ayuda.textContent = msg;
      if (mostrar) {
        input.classList.toggle('is-invalid', Boolean(msg));
        if (ayuda) ayuda.classList.toggle('d-block', Boolean(msg));
      }
      return !msg;
    }

    input.addEventListener('input', (e) => {
      if (!e.inputType || e.inputType.startsWith('insert')) {
        const antes = input.value;
        const despues = conBarras(antes);
        if (despues !== antes) input.value = despues;
      }
      // Mientras escribe solo se quita el error si ya quedó bien
      if (input.classList.contains('is-invalid')) validar(true); else validar(false);
    });

    input.addEventListener('blur', () => {
      const iso = normalizar(input.value);
      if (iso) input.value = aTexto(iso); // AAAA-MM-DD se muestra como DD/MM/AAAA
      if (input.value.trim() || input.form?.classList.contains('was-validated')) validar(true);
    });

    if (input.form) {
      input.form.addEventListener('submit', (e) => {
        if (!validar(true)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          input.form.classList.add('was-validated');
          input.focus();
        }
      }, true);
    }

    if (input.value) {
      const iso = normalizar(input.value);
      if (iso) input.value = aTexto(iso);
    }
    validar(false);
    if (boton) crearCalendario(input, boton, grupo, min, max, () => validar(true));
  }

  function crearCalendario(input, boton, grupo, min, max, alElegir) {
    const anioMin = Number(min.slice(0, 4));
    const anioMax = Number(max.slice(0, 4));
    grupo.style.position = 'relative';

    const panel = document.createElement('div');
    // No se usa .dropdown-menu de Bootstrap: su manejo de teclado busca un botón de dropdown que aquí no existe
    panel.className = 'bg-white border rounded-3 p-3 shadow calendario-fecha';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Elegir fecha');
    panel.innerHTML = `
      <div class="d-flex align-items-center gap-1 mb-2">
        <button type="button" class="btn btn-sm btn-light" data-mover="-1" aria-label="Mes anterior"><i class="bi bi-chevron-left"></i></button>
        <select class="form-select form-select-sm" data-mes aria-label="Mes">${MESES.map((m, i) => `<option value="${i}">${m}</option>`).join('')}</select>
        <select class="form-select form-select-sm" data-anio aria-label="Año" style="max-width: 6rem;"></select>
        <button type="button" class="btn btn-sm btn-light" data-mover="1" aria-label="Mes siguiente"><i class="bi bi-chevron-right"></i></button>
      </div>
      <div class="calendario-grilla" data-dias></div>`;
    grupo.appendChild(panel);

    const selMes = panel.querySelector('[data-mes]');
    const selAnio = panel.querySelector('[data-anio]');
    const grilla = panel.querySelector('[data-dias]');
    for (let a = anioMax; a >= anioMin; a--) selAnio.insertAdjacentHTML('beforeend', `<option value="${a}">${a}</option>`);

    let vista = { y: anioMax, m: 0 };

    function dibujar() {
      selMes.value = String(vista.m);
      selAnio.value = String(vista.y);
      const elegido = normalizar(input.value);
      const primero = new Date(vista.y, vista.m, 1);
      const huecos = (primero.getDay() + 6) % 7; // semana empieza en lunes
      const diasMes = new Date(vista.y, vista.m + 1, 0).getDate();
      let html = DIAS.map((d) => `<div class="calendario-dia-nombre">${d}</div>`).join('');
      html += '<div></div>'.repeat(huecos);
      for (let d = 1; d <= diasMes; d++) {
        const iso = aIso(vista.y, vista.m + 1, d);
        const fuera = iso < min || iso > max;
        const clase = iso === elegido ? 'btn-teal' : 'btn-light';
        html += `<button type="button" class="btn btn-sm ${clase}" data-dia="${iso}" ${fuera ? 'disabled' : ''}>${d}</button>`;
      }
      grilla.innerHTML = html;
    }

    function abrir() {
      const iso = normalizar(input.value);
      const base = iso || (max < hoyIso() ? max : aIso(anioMax - 30 < anioMin ? anioMin : anioMax - 30, 1, 1));
      vista = { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 };
      dibujar();
      panel.classList.add('show');
      boton.setAttribute('aria-expanded', 'true');
      selAnio.focus();
    }

    function cerrar() {
      panel.classList.remove('show');
      boton.setAttribute('aria-expanded', 'false');
    }

    boton.setAttribute('aria-expanded', 'false');
    boton.addEventListener('click', () => (panel.classList.contains('show') ? cerrar() : abrir()));
    selMes.addEventListener('change', () => { vista.m = Number(selMes.value); dibujar(); });
    selAnio.addEventListener('change', () => { vista.y = Number(selAnio.value); dibujar(); });
    panel.querySelectorAll('[data-mover]').forEach((b) => b.addEventListener('click', () => {
      const f = new Date(vista.y, vista.m + Number(b.dataset.mover), 1);
      if (f.getFullYear() < anioMin || f.getFullYear() > anioMax) return;
      vista = { y: f.getFullYear(), m: f.getMonth() };
      dibujar();
    }));
    grilla.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dia]');
      if (!b || b.disabled) return;
      input.value = aTexto(b.dataset.dia);
      cerrar();
      alElegir();
      input.focus();
    });
    document.addEventListener('click', (e) => { if (!grupo.contains(e.target)) cerrar(); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cerrar(); boton.focus(); } });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[data-campo-fecha]').forEach(iniciar);
  });

  window.CampoFecha = { normalizar, conBarras, aTexto };
})();
