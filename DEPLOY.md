# Despliegue en Google Cloud (Cloud Build + GitHub Actions + Cloud Run)

## Cómo funciona

```
 git push (rama main)
        │
        ▼
 GitHub Actions ── 1. verificar: npm ci + compila JS y vistas EJS
        │          2. desplegar: se autentica en GCP (sin llaves JSON)
        ▼
 Cloud Build ───── construye la imagen Docker (Dockerfile)
        │          la sube a Artifact Registry
        ▼
 Cloud Run ─────── ejecuta la app (HTTPS público)
        │          lee credenciales desde Secret Manager
        ▼
 Cloud SQL ─────── PostgreSQL (tablas y datos iniciales se crean solos en el primer arranque)
```

| Archivo | Para qué sirve |
|---|---|
| `Dockerfile` | Empaqueta la app (Node 24, solo dependencias de producción, usuario sin root). |
| `.dockerignore` / `.gcloudignore` | Evitan que `.env`, pruebas y credenciales entren en la imagen o se suban a Cloud Build. |
| `cloudbuild.yaml` | Pasos de Cloud Build: construir → publicar → desplegar en Cloud Run. |
| `.github/workflows/deploy.yml` | GitHub Actions: verifica el código y lanza Cloud Build en cada push a `main`. |

---

## Paso 0 · Herramientas

Usa **Cloud Shell** (ya trae `gcloud`): entra a <https://console.cloud.google.com> y pulsa el icono `>_` arriba a la derecha.
Todos los comandos de esta guía se pegan ahí.

## Paso 1 · Variables (pegar primero en Cloud Shell)

Cambia `PROJECT_ID` por el ID de tu proyecto y `GITHUB_REPO` por `tu-usuario/tu-repositorio`.

```bash
export PROJECT_ID="mi-proyecto-consultorio"
export REGION="us-central1"
export GITHUB_REPO="usuario/consultorio-san-rafael"

gcloud config set project "$PROJECT_ID"
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
```

> El proyecto debe tener **facturación activada** (Cloud SQL y Cloud Run la exigen; con la cuenta de prueba gratuita de $300 alcanza).

## Paso 2 · Activar las APIs

```bash
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
```

## Paso 3 · Repositorio de imágenes (Artifact Registry)

```bash
gcloud artifacts repositories create consultorio \
  --repository-format=docker --location="$REGION" \
  --description="Imágenes del Consultorio San Rafael"
```

## Paso 4 · Base de datos (Cloud SQL PostgreSQL)

Tarda ~10 minutos en crearse.

```bash
gcloud sql instances create consultorio-db \
  --database-version=POSTGRES_16 --edition=ENTERPRISE \
  --tier=db-f1-micro --region="$REGION" --storage-size=10GB

# Contraseña aleatoria para el usuario postgres (se guarda en Secret Manager en el paso 5)
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
gcloud sql users set-password postgres --instance=consultorio-db --password="$DB_PASSWORD"
```

No hace falta crear la base de datos ni las tablas: la app las crea con sus datos iniciales la primera vez que arranca.

## Paso 5 · Secretos (Secret Manager)

```bash
printf '%s' "$DB_PASSWORD"                     | gcloud secrets create db-password    --data-file=-
printf '%s' "$(openssl rand -hex 32)"          | gcloud secrets create session-secret --data-file=-
printf '%s' "COLOCAR_PAYPAL_CLIENT_SECRET_SANDBOX" | gcloud secrets create paypal-client-secret --data-file=-

# Clave de la API de comprobantes fiscales (IMECF) del profesor.
# El comando la pide sin mostrarla en pantalla: pégala y pulsa Enter.
read -rs -p "Pega la IMECF_API_KEY: " IMECF_KEY; echo
printf '%s' "$IMECF_KEY" | gcloud secrets create imecf-api-key --data-file=-
unset IMECF_KEY

# Contraseña de aplicación de Gmail del consultorio (16 letras, sin espacios)
read -rs -p "Pega la contraseña de aplicación de Gmail: " SMTP_KEY; echo
printf '%s' "${SMTP_KEY// /}" | gcloud secrets create smtp-pass --data-file=-
unset SMTP_KEY
```

## Paso 6 · Cuentas de servicio y permisos

```bash
# 6.1 Cuenta con la que CORRE la app en Cloud Run: solo Cloud SQL y lectura de secretos
gcloud iam service-accounts create consultorio-run --display-name="Consultorio - Cloud Run"
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:consultorio-run@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done

# 6.2 Cuenta que usa CLOUD BUILD (la cuenta de Compute por defecto del proyecto)
export BUILD_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for ROLE in roles/run.admin roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SA" --role="$ROLE"
done
gcloud iam service-accounts add-iam-policy-binding \
  "consultorio-run@$PROJECT_ID.iam.gserviceaccount.com" \
  --member="serviceAccount:$BUILD_SA" --role="roles/iam.serviceAccountUser"

# 6.3 Cuenta que usa GITHUB ACTIONS para lanzar Cloud Build
gcloud iam service-accounts create github-deployer --display-name="GitHub Actions - despliegue"
export DEPLOY_SA="github-deployer@$PROJECT_ID.iam.gserviceaccount.com"
for ROLE in roles/cloudbuild.builds.editor roles/storage.admin roles/viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="$ROLE"
done
gcloud iam service-accounts add-iam-policy-binding "$BUILD_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role="roles/iam.serviceAccountUser"
```

## Paso 7 · Conectar GitHub con GCP sin llaves (Workload Identity Federation)

Solo el repositorio indicado en `GITHUB_REPO` podrá desplegar.

```bash
gcloud iam workload-identity-pools create github-pool \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$GITHUB_REPO'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/$GITHUB_REPO"

# Valores para GitHub (paso 8)
echo "GCP_PROJECT_ID   = $PROJECT_ID"
echo "GCP_DEPLOY_SA    = $DEPLOY_SA"
echo "GCP_WIF_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
```

## Paso 8 · Configurar GitHub

En el repositorio: **Settings → Secrets and variables → Actions → pestaña Variables → New repository variable**.
Crea las 3 variables con los valores que imprimió el paso 7:

| Nombre | Valor |
|---|---|
| `GCP_PROJECT_ID` | ID del proyecto |
| `GCP_DEPLOY_SA` | `github-deployer@…iam.gserviceaccount.com` |
| `GCP_WIF_PROVIDER` | `projects/…/providers/github-provider` |

(No son secretos: no contienen contraseñas. Por eso van en *Variables*.)

## Paso 9 · Desplegar

Haz `git push` a la rama `main` (o en GitHub: **Actions → Desplegar en Cloud Run → Run workflow**).
Al terminar, el resumen del flujo muestra la URL pública (`https://consultorio-san-rafael-….run.app`).

### Primera entrada

La base de datos se crea con los usuarios de ejemplo (`admin/admin123`, `medico/medico123`, `secretaria/secretaria123`, `farmacia/farmacia123`).
**Cámbialos en cuanto entres**: la aplicación queda pública en Internet.

---

## Mantenimiento

| Tarea | Comando |
|---|---|
| Ver registros de la app | `gcloud run services logs read consultorio-san-rafael --region=$REGION --limit=50` |
| Actualizar la clave IMECF | `printf '%s' "NUEVA" \| gcloud secrets versions add imecf-api-key --data-file=-` y volver a desplegar |
| Cambiar el Gmail que envía | Editar `_SMTP_USER` en `cloudbuild.yaml` y actualizar el secreto: `printf '%s' "NUEVA" \| gcloud secrets versions add smtp-pass --data-file=-` |
| **Apagar la BD para no gastar** | `gcloud sql instances patch consultorio-db --activation-policy=NEVER` |
| Encenderla de nuevo | `gcloud sql instances patch consultorio-db --activation-policy=ALWAYS` |

**Costos aproximados:** Cloud Run escala a 0 (gratis sin visitas, dentro del nivel gratuito). Cloud SQL `db-f1-micro` cuesta ~US$9–10/mes mientras está encendida: apágala cuando no la uses.
