# PixelPay SDK / 3DS: correcciones verificables en dev

## A. Diagnóstico demostrado

Base backend: `dffcc40321d3b596fc2e5e13dc498aa66bb4527f` (`origin/dev`).
Base frontend: `8383c4cb2c1d2df90fcf90e9dac2f948fca36992` (`origin/dev`).
No se fusionó main en dev. El PR #109 está en main (`6eca2ae62e528a8304934277c3fd806ccddee951`) y su contención no estaba en dev. Se portan selectivamente su adaptador de Sale, clasificación, sanitización y pruebas, conservando las diferencias propias de dev. No se portan cambios de Status, callbacks, SQL, recuperación ni controles comerciales de main.

**DEMOSTRADO EN CÓDIGO:** `Transaction.doSale()` envía el POST y procesa `PayloadResponse` con tipo `songbird` mediante `CardinalManager.init(payload, collection_url)`. Sin URL carga Songbird y usa `window.Cardinal`; con URL crea formulario/iframe y escucha mensajes. Lookup requiere navegador (`navigator`, `screen`, `window`). `withAuthenticationRequest()` activa una bandera, no ejecuta por sí mismo la autenticación. Node rechaza esa bandera antes de enviar Sale; sin ella también puede recibir una continuación que requiere DOM.

**REPRODUCIDO:** SDK 2.5.8 sin contención, respuesta sintética HTTP 202 de tipo `payload`, produce `ReferenceError: document is not defined`. El adaptador contiene todos los HTTP 202 antes de ejecutar DOM, router o otra transacción, y conserva `uncertain`, tipo permitido y HTTP observado. No confirma la reserva.

**EVIDENCIA HISTÓRICA, NO REEJECUTADA:** el intento reciente de las 08:33 UTC recibió HTTP 202 / `PayloadResponse` / `songbird` y quedó `SDK_BROWSER_ACTION_REQUIRED`. Esto explica su estancamiento con el flujo backend actual. No demuestra el stack de todos los incidentes anteriores, el resultado bancario ni ausencia de cargo. Los cinco intents Live no fueron reutilizados ni modificados.

**DEMOSTRADO EN CÓDIGO:** `CardinalAuthentication.retryTransaction()` vuelve a hacer POST a la ruta `transaction/sale` o `transaction/auth`. La etapa de autenticación puede terminar en ese método tanto con JWT validado como con `NOACTION`. No se interpreta ese segundo POST como un cargo nuevo ni como un reintento seguro sin la garantía explícita del proveedor. MasterFade no habilita esa secuencia en este parche.

## B. Contrato oficial y responsabilidades

La revisión directa anterior en Chrome cubrió menús ES/EN, instalaciones, ejemplos SDK/Sandbox, filtros y asistente de navegación. No se repite una auditoría general. Las fuentes y el código se contrastan aquí con las versiones publicadas.

| Método / dato | Parámetros relevantes | Entorno y responsabilidad | Evidencia / límite |
| --- | --- | --- | --- |
| `Settings.setupSandbox()` | sin argumentos | Backend configura Sandbox | [Instalación JS](https://docs.pixelpay.com/page/sdk/installation/javascript); el código fija ambiente/credenciales genéricas, MasterFade conserva credenciales de comercio configuradas |
| `setupCredentials(key, hash)` | identificador y hash de autenticación | Backend | [Modelos](https://docs.pixelpay.com/page/sdk/models); no entregar el hash a React |
| `setupHeaders(headers)` | `x-client-signature` | Backend firma la petición | [Firma](https://docs.pixelpay.com/page/secure-signature); no confundir con firma del callback |
| `setupPlatformUser(value)` | hash de usuario | Backend, operaciones que lo requieren | Modelos/código Settings; no resuelve 3DS |
| `SaleTransaction` / `AuthTransaction` | Order, Card, Billing | Orden y total canónicos en backend | [Peticiones](https://docs.pixelpay.com/page/sdk/requests) |
| `withAuthenticationRequest()` | sin argumentos | Cliente con navegador | Peticiones; solo activa `authentication_request=true`, no define un handoff React/Node |
| `doSale()` / `doAuth()` | petición SDK | Documentación recomienda backend para ejecución firmada | [Primeros pasos](https://docs.pixelpay.com/page/sdk/getting-started); la continuación interna exige navegador |
| `getStatus()` | `StatusTransaction.payment_uuid` | Backend, para un UUID auténtico disponible | [Servicios](https://docs.pixelpay.com/page/sdk/services); no se ejecutó contra proveedor, ni se cambia su contrato en este PR |
| `verifyPaymentHash()` | hash, orden, secret | Exclusivamente backend | SDK rechaza validarlo en browser; no sustituye monto, identidad, transacción ni evidencia durable |
| `TransactionResult` | respuesta SDK validada | Backend interpreta y verifica | [Respuestas y entidades](https://docs.pixelpay.com/page/sdk/responses-entities); HTTP 200/202 no basta para aprobar |
| HTTP 202 / `songbird` | `payload`, `collection_url` opcional | CardinalManager / navegador | Implementación npm; no se encontró contrato público completo de reanudación React/Node |

**PENDIENTE DEL PROVEEDOR:** esquema y autoridad del handoff, datos permitidos al navegador, alcance/TTL/orígenes de tokens, continuación de la misma operación, resultado verificable y recuperación durable. La tabla no inventa esos contratos.

## C. Comparativa SDK

Ver [matriz reproducible de versiones](pixelpay-sdk-3ds-versions-20261114.md). Registro oficial: <https://registry.npmjs.org/@pixelpay%2Fsdk-core>. Se comparan 2.5.8, 2.5.9 y 2.5.10; `latest` observado es 2.5.10. No se cambia `package.json` ni el lockfile: una actualización sola no elimina las dependencias DOM/Cardinal ni acredita el handoff seguro.

## D. Arquitectura y estados inciertos

### Flujo actual, con la corrección acotada

```mermaid
sequenceDiagram
  participant C as Cliente / React
  participant B as Backend
  participant P as PixelPay
  participant D as PostgreSQL
  C->>B: Sesión + CSRF + grupo/intent + datos de formulario
  B->>D: Propiedad, monto, orden, vencimiento, lock y claim durable
  B->>P: Una invocación inicial doSale por intento
  alt HTTP 200 con evidencia completa verificada
    P-->>B: Resultado financiero
    B->>D: Evidencia durable + contrato financiero + confirmación
    B-->>C: Confirmación verificada
  else HTTP 202 del proveedor
    P-->>B: Continuación songbird/payload/router
    B->>D: Intent incierto, sin pago aprobado
    B-->>C: HTTP 202 de MasterFade: pending_confirmation
    Note over C,P: Continuación 3DS aún bloqueada: falta contrato seguro
  else Transporte / runtime / respuesta insuficiente
    B->>D: Conservar incertidumbre y correlación
    B-->>C: Pendiente seguro; no otra Sale
  end
```

El **HTTP 202 de PixelPay** es una respuesta upstream observada. El **HTTP 202 de MasterFade** es nuestra respuesta de pendiente; también puede emitirse ante otras causas inciertas y no prueba que el proveedor haya respondido 202.

### Circuito objetivo, todavía no implementable por completo

Cliente → React → backend (claim y orden) → PixelPay → handoff 3DS autorizado → navegador/Cardinal → continuación de la misma operación → backend verifica evidencia financiera → PostgreSQL/Supabase → cita confirmada.

Los pasos handoff/continuación quedan bloqueados hasta obtener un contrato soportado. React necesita participar en la interacción, pero no debe recibir Secret Key, auth hash ni router payload con credenciales. Un evento del navegador, `postMessage`, redirect, OTP completado o HTTP 200 no autoriza contabilizar un pago.

Si el usuario cierra/recarga, o falta un UUID auténtico, se conserva el intent incierto y no se relanza Sale. El SDK no aporta por sí solo persistencia/reanudación entre navegadores. La recuperación automática solo puede usar evidencia durable aprobada/verificada admitida por el contrato vigente; sin ella corresponde conciliación manual con PixelPay, no SQL ni Status aislado.

## E. Código modificado

- `PixelPaySdkProvider.js`: adapta únicamente Sale al runtime Node, distingue fallos de construcción/runtime/transporte, conserva incertidumbre después de invocar SDK y captura errores al interpretar resultados.
- `pixelPaySaleRuntime.js`: contención de HTTP 202 antes de DOM/router, observación de fase/HTTP y sanitización por allowlist.
- `pixelPaySaleTelemetry.js`: incorpora solo metadatos sanitizados y ambiente real configurado.
- Pruebas de provider, runtime, privacidad y contrato SDK/3DS. Sin endpoints nuevos ni cambios SQL.
- PR frontend separado: propaga `VITE_PIXELPAY_ENV` por Dockerfile; no integra Cardinal ni carga secretos en React.

## F. Pruebas y reproducción

Todas las Sales del harness son fixtures locales, con credenciales sintéticas y bloqueo de salidas externas antes de cargar SDK/Axios. Los sockets permitidos son de loopback para errores reales de transporte. No se llamaron Sale, Status o Void del proveedor.

Matriz backend focalizada (Node 20.20.2; repetida también en Node 22.22.2):

```powershell
node --test test/pixelpay-sdk-node-runtime.test.mjs test/pixelpay-sale-runtime-diagnostics.test.mjs test/pixelpay-sdk-provider.test.mjs test/pixelpay-sale-guard.test.mjs test/pixelpay-sale-attempt-store.test.mjs test/pixelpay-webhook-safety.test.mjs test/private-commerce.test.mjs test/security-csrf-public.test.mjs test/microfase2a2-public-pagos-routes.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs
```

Resultado: **500 PASS, 0 FAIL, 0 SKIP**. Incluye 200 aprobado con hash/monto, 202 tipos conocidos/desconocidos/incompletos, 412, timeout, DNS/TLS/reset locales, privacidad, callbacks, CSRF, roles, idempotencia y ausencia de segundo cobro.

PostgreSQL 17 local y aislado, con contratos existentes de dev (sin Supabase):

```powershell
$env:RUN_PAYMENT_LATE_PG_INTEGRATION='true'
$env:RUN_FINANCIAL_CONTRACT_PG='true'
node --test test/payment-late-paid-at.postgres.test.mjs test/pixelpay-expiration-evidence.postgres.test.mjs
```

Resultado: **34 PASS, 0 FAIL, 0 SKIP**. Contrato financiero, evidencia, identidad, duplicado, rollback, pagos tardíos y carrera expiración/confirmación. No acredita equivalencia de todo dev con los hotfix financieros de main.

`npm run lint`: exit 0, **0 errores / 25 advertencias** existentes. `git diff --check`: PASS. La primera ejecución de sockets en sandbox produjo EACCES y DNS bloqueado; se repitió con permiso de loopback sin relajar las aserciones. Un fixture antiguo `cf-ray=safe-ray` se corrigió al formato permitido por el sanitizador.

`node --test test/pixelpay-sdk-3ds-contract.test.mjs`: **12 PASS, 0 FAIL, 0 SKIP** en Node 20.20.2. Caracteriza bandera 3DS, rechazo previo a HTTP en Node, callbacks Cardinal, segundo POST interno del SDK, orígenes y cierre/recarga no resueltos.

Frontend: **81 PASS, 0 FAIL, 0 SKIP** en 10 suites de presentación, formulario, recarga, navegación, contexto grupo/intent y expiración. `npm run lint`, `npm run build` (QA/PixelPay/Sandbox explícitos) y diff check PASS. Advertencia preexistente de chunks >500 kB. Se verificó Dockerfile estáticamente y build Vite; no se ejecutó Docker build ni se acreditó bundle desplegado.

Las pruebas sintéticas de callbacks Cardinal/DOM verifican ramas de código; **no acreditan un desafío bancario real**, autenticación de un JWT del proveedor ni reanudación durable. Primera prueba Sandbox real: pendiente de autorización y del contrato.

## G. GitHub

Rama backend: `fix/pixelpay-sdk-3ds-dev-20261114`, destino `dev`.
Rama frontend: `fix/pixelpay-sdk-3ds-dev-20261114`, destino `dev`.
SHA, PR y CI se informan con la publicación. Sin merge ni deploy. PR Hosted backend #111 y frontend #93 siguen independientes y no se modifican.

## H. Bloqueos restantes y QA

**Resuelto con documentación/código:** se identifica la rama navegador, se contiene 202 en dev, se clasifica la excepción sin registrar datos financieros y se corrige la transmisión del entorno de Vite.

**QA observado en EasyPanel, solo lectura:** ambos servicios declaran rama `dev`, Dockerfile y despliegue automático deshabilitado; última etiqueta `QA-CLIENTE-PLANES-UX-05`. Backend declara development/qa, pixelpay/sdk/sandbox, endpoint y app URL `https://pixelpay.dev` y los cuatro simuladores desactivados. Frontend declara PixelPay y simuladores desactivados; no se localizó `VITE_PIXELPAY_ENV`. Las URLs Supabase declaradas coinciden con QA y no producción. Health QA respondió OK.

**No verificado en runtime:** SHA exacto, variables dentro del contenedor, bundle servido, autenticidad Sandbox de las credenciales, flags efectivos del piloto, sesión/CSRF en navegador. El panel no prueba esos hechos. No se modificó infraestructura. CORS declarado incluye QA; cookies declaradas Secure/SameSite=None/domain compartido no sustituyen una prueba de aislamiento de sesión.

Con simuladores desactivados, el código de dev todavía exige la elegibilidad del piloto para nuevas operaciones SDK. No se amplía su excepción ni se cambia configuración para forzar una prueba. No se presume que las restricciones de IP/proxy estén satisfechas.

**Preguntas concretas a PixelPay:**

1. Para SDK 2.5.8/2.5.10 y React+Node, ¿cuál es el ejemplo completo y soportado que continúa el mismo `songbird`, sin exponer auth hash/Secret Key/router credentials al navegador?
2. ¿Qué identifica y limita la continuación (token, orden, monto, comercio, sesión, TTL, origen)? ¿Quién firma lookup/continue y la ejecución final?
3. `retryTransaction()` hace otro POST a Sale/Auth. ¿Qué garantía contractual evita un cargo adicional, incluso ante callbacks duplicados, timeout o dos pestañas? ¿Cómo debe coordinarse con el claim durable de MasterFade?
4. ¿Cómo se recupera una operación tras cierre/recarga antes de recibir `payment_uuid`, sin reenviar Sale? ¿Hay identificador consultable por orden/attempt?
5. ¿Qué evidencia verificable entrega el flujo al backend al finalizar y cómo se correlaciona con UUID/transacción, monto, moneda, hash y timestamp canónico?

**Hosted frente a SDK:** Hosted documenta un checkout hospedado y evita manejar el desafío dentro de React; el candidato #111/#93 aún tiene bloqueos propios (habilitación/ruta Sandbox y equivalencia de evidencia financiera). No es una alternativa lista para producción. SDK 3DS tampoco está listo para promoción hasta demostrar handoff y recuperación. No se actualizan ni incorporan sus migraciones.

## I. Siguiente acción operativa

Revisar los PR acotados hacia dev. El responsable puede autorizar por separado un despliegue QA de contención/build, fijando SHA y `VITE_PIXELPAY_ENV=sandbox`, verificando después el entorno efectivo y la cuenta de pruebas autorizada. Ese despliegue no completa 3DS ni autoriza cobros.

Antes de una prueba Sandbox real: respuesta de PixelPay a las cinco preguntas, implementación/revisión del contrato, entorno efectivo aislado y autorización explícita de una operación nueva con tarjeta oficial Sandbox. No reutilizar ninguno de los cinco intents Live. Producción y apertura pública permanecen fuera de esta intervención.
