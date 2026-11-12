# Piloto privado: promocion y activacion independiente

Este PR parte de main 866706d y traslada solo el piloto integrado mediante #91 en dev
(merge 796ec40). Conserva las autorizaciones productivas de registro, login, exchange,
catalogos, perfil y mantenimiento. No modifica servicios financieros, migraciones ni datos.
Frontend complementario: promocion selectiva de #79, nunca fusion de dev completo.

## Estado de entrega

Codigo preparado para revision hacia main; sin fusion, despliegue ni activacion.
Default PRIVATE_COMMERCE_PILOT_ENABLED=false. Las nuevas operaciones comerciales requieren
sesion firmada vigente, UUID autorizado, rol cliente y cliente activo resuelto por el
servidor, IP autorizada y activacion explicita. Rol administrativo/email/headers no autorizan.
El callback conserva verificacion y deduplicacion independientes de cuenta/IP/piloto.
Cancelaciones y mantenimiento conservan los guards existentes de propiedad, rol y sucursal.

## EasyPanel: valores para una activacion posterior autorizada

No guardar cambios ni reiniciar servicios durante la preparacion de este PR.

1. En la sesion de la cuenta cliente aprobada, consultar GET /v1/auth/me. Debe devolver
   roles con cliente y cliente_id no vacio. Copiar data.user.id_usuario como UUID autorizado;
   no usar email, cliente_id ni un UUID declarado por el navegador. La elegibilidad vuelve
   a comprobar el vinculo cliente activo en servidor; no se crea ni modifica una cuenta.
2. En la configuracion de red del servicio backend identificar el Traefik que realmente
   termina su conexion. Verificar su IP interna exacta en la red compartida y que coincide
   con el peer TCP observado por el backend. No usar un valor de X-Forwarded-For como peer.
   Solo Traefik puede alcanzar ese puerto; sin entrada publica directa al backend.
3. Verificar TRUST_PROXY de un solo salto, forwardedHeaders.insecure=false y que Traefik
   elimina valores externos no confiables o agrega la IP real al extremo derecho de XFF.
   La aplicacion exige peer exacto y request.ips.length=2. Si existe CDN/segundo proxy,
   detener activacion; no ampliar rangos/saltos para forzar elegibilidad.
4. Obtener la salida real de la PC y contrastarla con la direccion observada por Traefik
   durante un GET inocuo. Considerar IPv4/IPv6/VPN/NAT. No inferirla de un header enviado
   por el cliente. IP y sesion no certifican hardware si otra PC comparte ambas.
5. En backend -> Entorno, preparar estos valores, sustituyendo los tres marcadores por
   valores verificados. Una sola cuenta; IPs exactas separadas por coma, sin CIDR/wildcards:

```dotenv
PRIVATE_COMMERCE_PILOT_ENABLED=false
PRIVATE_COMMERCE_USER_IDS=<UUID_DATA_USER_ID_USUARIO>
PRIVATE_COMMERCE_IPS=<IP_SALIDA_VERIFICADA_PC>
PRIVATE_COMMERCE_PROXY_IPS=<IP_INTERNA_PEER_TRAEFIK_VERIFICADA>
TRUST_PROXY=true
PAYMENT_PROVIDER=pixelpay
ADMIN_DATA_ENTRY_MODE=false
```

Conservar las credenciales Live y todos los controles financieros/webhook existentes;
este procedimiento no los modifica ni autoriza habilitar un webhook deshabilitado.
PAYMENT_PROVIDER y ADMIN_DATA_ENTRY_MODE son requisitos de una futura activacion,
no cambios a realizar ahora. AGENDA_SSE_ENABLED debe contener literalmente true o false.

Mantener en frontend los flags publicos y de compra global apagados:

```dotenv
VITE_PUBLIC_BOOKING_ENABLED=false
VITE_VIP_MEMBERSHIPS_PURCHASE_ENABLED=false
VITE_CLIENT_BOOKING_ENABLED=false
VITE_CLIENT_PLAN_PURCHASE_ENABLED=false
```

VITE_VIP_MEMBERSHIPS_ENABLED conserva su valor productivo; no se necesita abrir el catalogo
global para que el propietario elegible acceda a su flujo privado.

6. Solo despues de aprobar los PR a main, publicar el codigo y autorizar la activacion:
   cambiar unicamente PRIVATE_COMMERCE_PILOT_ENABLED=true y efectuar el reinicio controlado
   aprobado. No es necesaria otra compilacion frontend para alternar el piloto.
7. Comprobar solo GET /v1/commerce/eligibility, sin cache: invitado/otra cuenta/otra IP deben
   recibir false,false; la cuenta cliente aprobada desde la PC debe recibir true,true.
   Con piloto apagado todos reciben false,false. Una cookie invalida mantiene 401.
   No usar POST de reservas/intents/Sale/Status/Void como prueba de elegibilidad.

## Reversion rapida

Cambiar solo PRIVATE_COMMERCE_PILOT_ENABLED=false y aplicar el reinicio controlado aprobado.
Conservar PAYMENT_PROVIDER=pixelpay, ADMIN_DATA_ENTRY_MODE=false, credenciales y configuracion
financiera/webhook existentes. Cambiar proveedor a disabled o modo administrativo puede
interferir con la conciliacion previa; no usar esos ajustes como rollback del piloto.
No borrar ni expirar manualmente pagos, intents, ordenes o evidencia. El guard cierra nuevas
operaciones y recuperacion interactiva; los callbacks mantienen sus controles existentes.

## Validacion focalizada

node --test test/private-commerce.test.mjs test/private-commerce-main-presale.audit.mjs
test/guest-registration-qa02g.test.mjs test/pixelpay-webhook-safety.test.mjs

node --test --test-name-pattern='private pilot:' test/microfase2a2-public-pagos-routes.test.mjs
test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs

Ejecutar tambien npm run lint y git diff --check. Backend no define script build: se
comprueba sintaxis de los plugins modificados. Todo usa fixtures locales y proveedor simulado.
Las excepciones CI heredadas estan documentadas en #91; no son regresiones nuevas.
Resultado de esta rama: 91/91 pruebas de acceso/registro/webhook y 4/4 positivos HTTP
de reserva/VIP. Lint sin errores (25 advertencias previas), sintaxis y diff-check correctos.
