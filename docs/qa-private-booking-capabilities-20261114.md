# QA: reservas privadas sin VIP ni Sale automática

## A. Causa raíz

El guard de dev calculaba un único booleano para reservas, VIP y todas las rutas comerciales. Un inicio de sesión Google válido no basta para habilitar el piloto: también deben coincidir flag, usuario interno, cliente activo, rol, IP y proxy. La respuesta `false,false` no demuestra cuál de esas condiciones falla en el contenedor QA. Este PR corrige el acoplamiento demostrado; no afirma haber identificado el rechazo operativo actual.

## B. Diseño

En `ENTORNO=qa`, una sesión elegible obtiene `booking=true, vipPurchase=false`. El guard permite únicamente una lista exacta de rutas de reservas/consultas; las demás rutas comerciales permanecen cerradas. Las dos rutas Sale requieren además `QA_PRIVATE_COMMERCE_SALE_ENABLED=true`, desactivado por defecto y válido exclusivamente con development/QA/PixelPay SDK Sandbox. No habilitarlo durante esta fase: 3DS sigue pendiente.

Las excepciones de mantenimiento y callback se conservan, así como la simulación QA existente cuando está configurada explícitamente. El hotfix no activa simuladores. Fuera de QA se conserva el comportamiento anterior; no es una promoción a main ni una activación de producción.

## C. Archivos

- `src/plugins/privateCommerce.js`: capacidades QA, lista exacta y permiso adicional de Sale; misma autenticación/IP/CSRF.
- `test/private-commerce.test.mjs`: escenarios QA, aliases, claims, proxy, permisos y regresión legacy; error handler de fixture para representar respuestas de validación.
- Este informe: contrato de configuración, rutas y límites de evidencia.

## D. Pruebas

```sh
node --test test/private-commerce.test.mjs test/pixelpay-sale-guard.test.mjs test/microfase2a2-public-pagos-routes.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs test/pixelpay-webhook-safety.test.mjs test/security-csrf-public.test.mjs test/trust-proxy-rate-limit.test.mjs
npm run lint
git diff --check
```

Los fixtures prueban entrada al schema original de hold/intent/consulta, rechazo de VIP y de ambas Sale antes del handler, cero llamadas al factory en el caso bloqueado, identidad activa/resuelta, sesión revocada/manipulada, propietario distinto, proxy y XFF falsos, cadena adicional, CSRF ausente/incorrecto, UUIDs inválidos/múltiples, configuración desactivada y mantenimiento/callback. Las suites de negocio preservan propiedad, idempotencia y contratos financieros. No se realiza ninguna transacción bancaria.

Resultado local Node 22.22.2: **375 PASS, 0 FAIL, 0 SKIP**. Lint: exit 0, cero errores y 25 advertencias preexistentes. Diff check PASS. CI se informa en el PR. Los primeros fallos fueron de fixture: serialización sin error handler y una URL de prueba no registrada; se corrigieron las pruebas sin relajar el producto.

Una prueba de guard no acredita crear una reserva real desplegada ni el peer TCP real de Swarm. El callback alcanza su guard financiero original; no se convierte en aprobación de un evento no autenticado.

## E. Rutas y seguridad

| Operación | Rutas / comportamiento QA |
| --- | --- |
| Hold | POST `/v1/public/citas/hold`, `/v1/citas/hold`; piloto + CSRF + validaciones originales |
| Contactos/titular | POST `/v1/public/citas/validar-contactos`, `/validar-titular`; mismo piloto |
| Intent | POST `/v1/public/pagos/crear-intent`, `/v1/pagos/reservas/crear-intent`; conserva propiedad, monto, sesión y rate limit |
| Confirmación L0 | POST `/v1/citas/hold/:id_grupo_cita/confirmar`; conserva saldo, titularidad, transacción e idempotencia |
| Sale | POST `/v1/public/pagos/pixelpay/sale` y `/v1/pagos/reservas/pixelpay/sale`: cerradas sin autorización adicional; con ella siguen exigiendo piloto/CSRF/guardas financieras |
| Consultas | POST `/estado`, `/pixelpay/status` bajo ambos prefijos de reservas, y `/v1/cliente/planes/pago-intent/:id_payment_intent/estado`: mismo piloto, autenticación/propiedad/CSRF/límites originales; no son permiso VIP |
| VIP | POST `/v1/cliente/planes/orden`, `/pago-intent`, `/confirmar-pago`, `/adquirir`, `/simulator/event`: bloqueadas por piloto QA SDK |
| Alias legacy | `/v1/pagos/crear-intent` no se abre; listado conservador, sin excepción global a pagos |
| Mantenimiento/callback | Lista MAINTENANCE_ROUTES y `/v1/pagos/webhook/:proveedor` intactas; conservan sus propias autorizaciones |
| Catálogo / lecturas | Sin modificación de reglas previas |

`authClaims.js` resuelve `public.usuarios.id_usuario = auth.users.id`; ese UUID interno coincide con `request.auth.sub`. No usar el Google subject ni `clientes.id_cliente` como allowlist. El cliente resuelto exige `clientes.estado IS TRUE` y `deleted_at IS NULL`; usuarios activos y roles activos también se filtran por SQL. No se consultaron filas personales ni se modificó Supabase.

Fastify se registra con `buildTrustProxy` antes de auth/guard. TRUST_PROXY solo confía en el primer salto interno. El piloto exige además peer TCP exacto en su allowlist y `request.ips.length===2`, con `request.ip` autorizado. Sin proxies configurados compara directamente el socket. No asumir que la IP de Traefik coincide con el peer observado en Swarm. No se modifican trustProxy, cookies, CORS ni CSRF.

## F. Matriz de variables (no aplicadas)

| Variable | Requerida | Objetivo | Validación / riesgo |
| --- | --- | --- | --- |
| ENTORNO | Sí | `qa` | Activa separación QA; nunca cambiar producción |
| NODE_ENV | Sí | `development` | Requerido para eventual permiso Sale Sandbox |
| PAYMENT_PROVIDER | Sí | `pixelpay` | Mantener proveedor |
| PIXELPAY_IMPLEMENTATION / PIXELPAY_ENV | Sí | `sdk` / `sandbox` | No acredita titularidad de credenciales; no cambiarlas |
| PRIVATE_COMMERCE_PILOT_ENABLED | Sí para habilitar | `true` después de aprobación | `false`/ausente mantiene cierre |
| PRIVATE_COMMERCE_USER_IDS | Sí con piloto | `<UUID_INTERNO_QA_VERIFICADO>` | Exactamente uno; comparar `/v1/auth/me` con usuario interno QA mediante sesión del propietario |
| PRIVATE_COMMERCE_IPS | Sí con piloto | `<IP_CLIENTE_AUTORIZADA_VERIFICADA>` | IP exacta, sin CIDR, comodines ni valores inventados |
| PRIVATE_COMMERCE_PROXY_IPS | Si existe proxy | `<PEER_TCP_QA_OBSERVADO>` | Obtener de diagnóstico interno autorizado del socket, no del nombre/IP supuesto de Traefik |
| TRUST_PROXY | Con proxy | `true` | Solo primer salto; no admitir XFF arbitrario |
| QA_PRIVATE_COMMERCE_SALE_ENABLED | No | `false` o ausente | No activarlo: permiso financiero separado; `true` fuera de QA SDK Sandbox impide arranque |
| ADMIN_DATA_ENTRY_MODE | Sí | `false` | No autoriza por sí solo comercio |
| Flags de simulación existentes | Sí | `false` | No son sustitutos de autorización del piloto |

El operador debe conservar endpoints/credenciales, revisar las variables declaradas y después verificar su efectividad en el contenedor QA. Antes de activar piloto debe confirmar de forma privada UUID, IP y peer, sin publicarlos. Este PR no guarda variables. Si todavía devuelve false,false, verificar las condiciones anteriores: el parche no elimina ninguna.

## G–I. Entrega y siguiente acción

Rama `fix/qa-pilot-booking-vip-separation`, derivada de dev después de #112. SHA/PR/CI se informan al publicar. Frontend no requiere cambios y conserva #95.

Pendiente: diagnóstico del rechazo efectivo, identidad/IP/peer actuales, aplicación del hotfix y respuesta real de elegibilidad en QA. No hay afirmación de PASS desplegado. Conciliación/callback mantienen restricciones preexistentes; no se amplía acceso cuando el piloto está apagado.

Siguiente aprobación: revisar y autorizar merge de este PR hacia dev; después autorizar por separado despliegue y configuración del piloto exclusivamente QA, conservando Sale=false y VIP bloqueado. Confirmar true,false y rechazos por otra cuenta sin pulsar Pagar ni crear un cobro. No tocar main, producción, históricos, Hosted #111/#93 ni 3DS.
