# Consultorio Médico San Rafael 🏥

Sistema web de gestión clínica y administrativa para el **Consultorio Médico San Rafael**, desarrollado con **Node.js**, **Express**, **PostgreSQL** y **EJS**. Su diseño es responsivo y se adapta tanto a pantallas de escritorio como a teléfonos móviles.

---

## 📋 Procesos y Módulos del Sistema

1. **Pacientes (Ficha Clínica y Control Anti-Duplicados)**:
   - Registro y consulta de: Cédula/Identificación, Tipo de Documento, Nombres, Apellidos, Fecha de Nacimiento, Género, Teléfono, Correo, Dirección, ARS y Número de Afiliado.
   - Búsqueda en tiempo real por cédula, nombre o teléfono para localizar rápidamente la ficha médica.
   - Restricción estricta de unicidad (`UNIQUE`) y validación previa en servidor para evitar registros duplicados por identificación.
   - Visualización de la ficha clínica del paciente con antecedentes personales, alérgicos, familiares, historial de citas, consultas médicas previas y recetas emitidas.

2. **Citas y Sala de Espera**:
   - Registro de citas solicitadas por múltiples canales: **Teléfono**, **Mensajería (WhatsApp / Chat)** o **Presencial (Recepción)**.
   - Verificación de disponibilidad de horario (evita solapamientos en la misma fecha y hora).
   - **Confirmación de Llegada ("Check-in")**: Al presentarse el paciente en recepción, se marca su llegada y pasa automáticamente al estado `"En sala de espera"`.
   - **Aviso al Médico**: Monitor de sala de espera en tiempo real que alerta al médico con el tiempo de espera transcurrido y botón directo para iniciar la consulta.

3. **Consultas Médicas e Historial Clínico**:
   - Revisión previa de antecedentes del paciente (con alerta destacada de alergias medicamentosas).
   - Registro de signos vitales (Presión arterial sistólica/diastólica, temperatura, frecuencia cardíaca, frecuencia respiratoria, peso, talla).
   - Registro estructurado de motivo de consulta, hallazgos físicos/examen clínico, diagnóstico principal y plan de tratamiento.
   - Historial clínico cronológico y acumulativo para consultar todas las atenciones anteriores del paciente.

4. **Recetas Médicas**:
   - Generación de recetas integradas a la consulta médica con código de seguimiento único.
   - Inclusión de fármacos con dosis, concentración, frecuencia, duración e indicaciones claras de uso.
   - Vista e impresión oficial de la receta (`@media print` optimizado con firma médica).

5. **Farmacia Interna y Control de Existencias**:
   - Catálogo de medicamentos con stock actual, stock mínimo, lote, ubicación y fecha de vencimiento.
   - Verificación de existencias antes de despachar una receta.
   - **Entrega Conforme**: Al entregar los medicamentos al paciente, se registra la salida y se descuentan las existencias automáticamente.
   - **Medicamentos sin existencias**: Si un medicamento está agotado o insuficiente, el sistema registra que no pudo entregarse por falta de stock y genera la notificación oficial indicando que el paciente debe conseguirlo en una farmacia externa.
   - Auditoría y bitácora completa de movimientos de farmacia.

6. **ARS, Coberturas y Cobros Dinámicos**:
   - Administración de Aseguradoras de Riesgos de Salud (ARS) y pacientes particulares.
   - **Tarifarios 100% Configurables**: No existen tarifas ni porcentajes fijos en código fuente. Permite definir para cada ARS y servicio médico la tarifa pactada, el tipo de cobertura (**Porcentaje %** o **Monto Fijo RD$**), el valor de cobertura y copagos fijos.
   - En la consulta o facturación, el sistema calcula automáticamente:
     - **Valor total del servicio**.
     - **Monto cubierto por la ARS**.
     - **Diferencia / Copago a pagar por el paciente**.
   - Guarda el desglose económico junto a la atención médica.
   - Incluye simulador/calculadora de copagos en tiempo real.

---

## 📊 Módulo de Reportes (37 reportes, mínimo 6 por módulo)

Menú **Reportes** (`/reportes`). Cada reporte tiene filtros, fila de totales, gráfico de barras cuando aplica, botón **Imprimir / PDF** (con encabezado del consultorio, fecha y usuario) y exportación **Excel (CSV)**. Todas las fechas y horas se muestran en hora de República Dominicana.

Los reportes se agrupan en **6 módulos**, que reúnen las partes del sistema descritas arriba:

| # | Módulo de reportes | Partes del sistema que cubre | Reportes |
| :-: | :--- | :--- | :-: |
| 1 | Pacientes | Fichas de pacientes | 7 |
| 2 | Citas y Sala de Espera | Agenda, check-in y sala de espera | 6 |
| 3 | Consultas y Recetas | Consultas, historial clínico y recetas | 6 |
| 4 | Farmacia e Inventario | Inventario, dispensación, movimientos y coberturas de medicamentos | 6 |
| 5 | ARS, Cobros y Facturación | ARS y tarifarios, cobros, comprobantes e-CF y pagos PayPal | 6 |
| 6 | Administración | Usuarios y roles, catálogo de servicios e indicadores generales | 6 |
| | **Total** | | **37** |

<details>
<summary>Lista completa de reportes</summary>

| Código | Reporte |
| :-- | :-- |
| 1.1 | Directorio general de pacientes |
| 1.2 | Pacientes por aseguradora (ARS) |
| 1.3 | Distribución por edad y género |
| 1.4 | Pacientes nuevos registrados |
| 1.5 | Pacientes con alergias registradas *(solo médico y administrador)* |
| 1.6 | Pacientes con datos incompletos |
| 1.7 | Pacientes sin visitas recientes |
| 2.1 | Agenda de citas por período |
| 2.2 | Citas por estado |
| 2.3 | Citas canceladas |
| 2.4 | Citas por canal de solicitud |
| 2.5 | Puntualidad y tiempo en sala de espera |
| 2.6 | Demanda por día de la semana |
| 3.1 | Consultas realizadas por período |
| 3.2 | Diagnósticos más frecuentes |
| 3.3 | Consultas por tipo de servicio |
| 3.4 | Pacientes más frecuentes |
| 3.5 | Recetas emitidas |
| 3.6 | Medicamentos más recetados |
| 4.1 | Inventario valorizado |
| 4.2 | Medicamentos con stock bajo o agotados |
| 4.3 | Medicamentos vencidos o por vencer |
| 4.4 | Movimientos de inventario (Kardex) |
| 4.5 | Efectividad de dispensación |
| 4.6 | Cobertura de ARS en farmacia |
| 5.1 | Ingresos diarios (cuadre de caja) |
| 5.2 | Facturación por ARS (monto a reclamar) |
| 5.3 | Cuentas por cobrar a pacientes |
| 5.4 | Tarifarios y coberturas por ARS |
| 5.5 | Comprobantes fiscales electrónicos (e-CF) |
| 5.6 | Pagos en línea con PayPal |
| 6.1 | Resumen general del consultorio |
| 6.2 | Ingresos mensuales (últimos 12 meses) |
| 6.3 | Usuarios del sistema |
| 6.4 | Usuarios por rol |
| 6.5 | Actividad de facturación por usuario |
| 6.6 | Catálogo de servicios y su uso |

</details>

**Acceso por rol** (cada rol ve al menos 6 reportes en cada uno de sus módulos):

| Rol | Módulos de reportes | Reportes |
| :--- | :--- | :-: |
| Administrador | Los 6 módulos | 37 |
| Secretaría / Recepción | Pacientes (6), Citas (6), ARS y Facturación (6) | 18 |
| Médico | Pacientes (7), Citas (6), Consultas y Recetas (6) | 19 |
| Farmacia | Farmacia e Inventario (6) | 6 |

El médico no ve montos de cobro en sus reportes, y los datos clínicos (alergias) no se muestran a secretaría.

---

## 🔐 Control de Acceso por Roles (RBAC) e Inicio de Sesión Obligatorio

El sistema implementa **inicio de sesión obligatorio**. Sin una sesión activa, cualquier intento de ingresar al panel, ver pacientes o abrir módulos internos redirige automáticamente a `/login`.

### Matriz de Permisos por Rol:

| Rol | Usuario de Prueba | Contraseña | Permisos y Módulos Autorizados |
| :--- | :--- | :--- | :--- |
| **SECRETARÍA** | `secretaria` (o `recepcion`) | `secretaria123` (o `recepcion123`) | **Atención, Agenda y Cobros**: Registrar pacientes (control anti-duplicados por identificación), gestionar citas multicanal (teléfono, mensajería, presencial), confirmar llegada de pacientes (notifica al médico a sala de espera), directorio de ARS y calculadora/simulador de copagos. *Protegido: denegado a consultas médicas, usuarios y dispensación de farmacia.* |
| **MÉDICO** | `medico` | `medico123` | **Atención Clínica**: Revisar antecedentes del paciente, monitor de sala de espera (pacientes listos), registrar signos vitales, hallazgos, diagnóstico y tratamiento, emitir recetas médicas y consultar inventario de fármacos. *Protegido: denegado a gestión de usuarios, dispensación de farmacia y edición de tarifarios.* |
| **FARMACIA** | `farmacia` | `farmacia123` | **Dispensación e Inventario**: Cola de recetas emitidas, verificar existencias, entregar medicamentos (descuenta existencias automáticamente) o registrar falta de existencias (indicando derivación a farmacia externa), reabastecimiento y auditoría de movimientos. *Protegido: denegado a citas, pacientes y consultas clínicas.* |
| **ADMINISTRADOR** | `admin` | `admin123` | **Gestión Global**: Gestión de usuarios y roles, configuración de tarifas pactadas por ARS y servicio, catálogo de medicamentos y acceso completo a todos los módulos. |

---

## 🧭 Guía Rápida para Probar el Flujo Completo (De Cita a Farmacia)

1. **Prueba de Acceso sin Sesión**:
   - Ingresa a `http://localhost:3000/` o `http://localhost:3000/pacientes` en una ventana privada: el sistema te redirigirá a `/login` con el mensaje de inicio de sesión obligatorio.
2. **Rol Secretaría (`secretaria` / `secretaria123`)**:
   - Inicia sesión. Abre **Citas** o **Pacientes**.
   - Haz clic en **Confirmar Llegada** para un paciente de hoy: pasará a `"En sala de espera"` y se avisará al médico.
   - Intenta acceder a `/consultas`: verás la pantalla `403 Acceso Denegado`. Cierra sesión.
3. **Rol Médico (`medico` / `medico123`)**:
   - Inicia sesión. Verás la alerta de paciente en sala de espera. Haz clic en **Iniciar Consulta**.
   - Revisa antecedentes, anota signos vitales, diagnóstico, plan y emite una receta con medicamento disponible (ej. *Paracetamol*) o agotado (ej. *Azitromicina*).
   - Guarda la consulta: el paciente pasa a atendido, se calcula el copago de la ARS y la receta se envía a farmacia. Cierra sesión.
4. **Rol Farmacia (`farmacia` / `farmacia123`)**:
   - Inicia sesión. Entra a **Farmacia > Dispensar Recetas**.
   - Abre la receta emitida:
     - Para el fármaco con existencia: pulsa **Entregar Medicamento**: el stock se descuenta y se registra el movimiento.
     - Para el fármaco agotado: pulsa **Registrar Sin Existencia**: el sistema registra la no entrega y genera el aviso de que el paciente debe adquirirlo en farmacia externa.
   - Intenta acceder a `/citas`: verás `403 Acceso Denegado`. Cierra sesión.
5. **Rol Administrador (`admin` / `admin123`)**:
   - Inicia sesión. Gestiona usuarios en `/usuarios` o configura tarifarios de ARS en `/ars`.

## 🛠️ Tecnologías Utilizadas

- **Backend**: Node.js v24+, Express 4.x.
- **Base de Datos**: PostgreSQL 18.
- **Cliente DB**: `pg` (Node-Postgres connection pool).
- **Vistas**: EJS (Embedded JavaScript) con diseño modular y parciales reutilizables.
- **Estilos**: Bootstrap 5 (CDN) + CSS médico personalizado y responsivo (`public/css/style.css`).

---

## ⚙️ Configuración de PostgreSQL y Variables de Entorno

### 1. Dónde se configuran los datos de conexión
Toda la configuración de conexión a la base de datos se gestiona en el archivo **`.env`** ubicado en la raíz del proyecto (junto a `.env.example`).

Abre el archivo **`.env`** en tu editor de texto y revisa las siguientes variables:

```env
# Configuración del Servidor
PORT=3000
NODE_ENV=development
SESSION_SECRET=consultorio_san_rafael_seguro_clave_2026

# Conexión a PostgreSQL (Modifica con la clave de tu instalación)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=tu_contrasena_de_postgres
DB_NAME=consultorio_san_rafael

# Datos del Consultorio
CLINIC_NAME="Consultorio Médico San Rafael"
CLINIC_PHONE="(809) 555-0199"
CLINIC_ADDRESS="Av. San Rafael #102, Santiago de los Caballeros"
```

> ⚠️ **Importante**: Si durante la instalación de PostgreSQL en tu computadora definiste una contraseña para el usuario `postgres`, escríbela en la línea `DB_PASSWORD=tu_clave`.

---

## 🚀 Instalación y Puesta en Marcha

En esta computadora con Windows, ejecuta los comandos en **PowerShell** usando `npm.cmd`:

### Paso 1: Inicializar la Base de Datos
El proyecto incluye un script automatizado que se conecta a PostgreSQL, crea la base de datos `consultorio_san_rafael` si no existe, ejecuta las tablas (`schema.sql`) e inserta datos iniciales de prueba y catálogos (`seed.sql`):

```powershell
npm.cmd run db:init
```

Si tus credenciales en `.env` son correctas, verás el mensaje:
```
✔ Conexión inicial con el servidor PostgreSQL exitosa.
✔ Base de datos "consultorio_san_rafael" creada exitosamente.
✔ Tablas y restricciones creadas correctamente.
✔ Datos de prueba y catálogos insertados correctamente.
🎉 BASE DE DATOS INICIALIZADA SATISFACTORIAMENTE
```

### Paso 2: Iniciar el Servidor Web

Para iniciar el servidor en modo producción/estándar:
```powershell
npm.cmd start
```

O en modo desarrollo con recarga automática:
```powershell
npm.cmd run dev
```

Verás en la consola de PowerShell:
```
🏥 INICIANDO SISTEMA WEB - CONSULTORIO MÉDICO SAN RAFAEL
✔ Conexión a PostgreSQL establecida con éxito.
🚀 Servidor en funcionamiento en el puerto: 3000
🌐 Acceso web: http://localhost:3000
```

### Paso 3: Abrir el Sistema en el Navegador
Abre cualquier navegador web (Google Chrome, Microsoft Edge, Firefox, etc.) y visita:



---

## 🧪 Comprobaciones y Pruebas Automáticas

Puedes ejecutar la suite de comprobaciones del sistema en cualquier momento:

```powershell
npm.cmd test
```

Este script verifica:
- Existencia de los 31 archivos de vistas, rutas, controladores y estilos.
- Carga de módulos de Express y conexión al pool de PostgreSQL.
- Verificación unitaria de los cálculos de coberturas porcentuales y montos fijos.
- Diagnóstico del estado del servidor PostgreSQL.

---

## 📂 Estructura del Proyecto

```
CONSULTORIO/
├── package.json              # Metadatos, dependencias y scripts npm
├── .env.example              # Plantilla de variables de entorno sin contraseñas
├── .env                      # Variables de entorno locales configurables
├── README.md                 # Documentación técnica y manual de inicio
├── scripts/
│   └── test-system.js        # Script de pruebas automáticas del sistema
├── src/
│   ├── app.js                # Configuración de Express, middlewares y rutas
│   ├── server.js             # Entrada del servidor y escucha de puerto
│   ├── config/
│   │   └── db.js             # Conexión al pool de PostgreSQL y consultas
│   ├── database/
│   │   ├── schema.sql        # Definición de tablas, llaves foráneas e índices
│   │   ├── seed.sql          # Catálogo inicial de ARS, servicios y fármacos
│   │   └── init-db.js        # Inicializador automático de base de datos
│   ├── controllers/
│   │   ├── pacienteController.js   # Gestión de pacientes y anti-duplicados
│   │   ├── citaController.js       # Agenda multicanal y sala de espera
│   │   ├── consultaController.js   # Ficha clínica, signos, Dx y recetas
│   │   ├── farmaciaController.js   # Inventario, dispensación y derivación
│   │   └── arsController.js        # Tarifarios dinámicos y cálculo de cobros
│   ├── routes/
│   │   ├── indexRoutes.js          # Dashboard principal y métricas en vivo
│   │   ├── pacienteRoutes.js       # Rutas de pacientes
│   │   ├── citaRoutes.js           # Rutas de citas y sala de espera
│   │   ├── consultaRoutes.js       # Rutas de consultas e historial
│   │   ├── farmaciaRoutes.js       # Rutas de farmacia y movimientos
│   │   └── arsRoutes.js            # Rutas de ARS, tarifas y simulador
│   └── views/
│       ├── layout.ejs              # Estructura base
│       ├── index.ejs               # Panel de control principal
│       ├── 404.ejs / 500.ejs       # Pantallas de error amigables
│       ├── db-error.ejs            # Guía interactiva si la DB no está creada
│       ├── partials/
│       │   ├── header.ejs          # Menú superior responsivo
│       │   ├── footer.ejs          # Pie de página y scripts
│       │   └── alerts.ejs          # Notificaciones flash
│       ├── pacientes/              # Vistas de directorio, ficha y formulario
│       ├── citas/                  # Vistas de agenda, agendar y sala de espera
│       ├── consultas/              # Vistas de atención clínica y recetas
│       ├── farmacia/               # Vistas de inventario, despacho y auditoría
│       └── ars/                    # Vistas de ARS, tarifarios y calculadora
└── public/
    ├── css/
    │   └── style.css         # Estilos responsivos e impresión de recetas
    └── js/
        └── main.js           # Interacciones cliente y validación de formularios
```

---

## 🔒 Manejo Seguro de Contraseñas y Control de Acceso
- El archivo `.env.example` contiene únicamente valores de ejemplo y no expone contraseñas reales.
- El archivo `.env` se mantiene localmente para que cada usuario o administrador configure las credenciales de su propio servidor de base de datos.
- Las consultas SQL implementan sentencias parametrizadas (`$1, $2, ...`) mediante Node-Postgres para prevenir inyecciones SQL.
