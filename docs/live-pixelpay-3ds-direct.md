# Prueba directa PixelPay 3DS Live — MasterFade

## Estado
No se habilita automáticamente. El código inicia desactivado y conserva el bloqueo público y las credenciales del backend. No se aplica ninguna migración.

## Preparación
1. Desplegar backend y frontend desde los commits aprobados, manteniendo `PIXELPAY_LIVE_3DS_TEST_ENABLED=false`.
2. Comprobar que producción ejecuta `NODE_ENV=production`, `ENTORNO=production`, `PAYMENT_PROVIDER=pixelpay`, `PIXELPAY_IMPLEMENTATION=sdk`, `PIXELPAY_ENV=live`. `PIXELPAY_ENDPOINT` y `PIXELPAY_APP_URL` deben coincidir con los valores Live del panel PixelPay; no modificar llaves, firma, callback o webhook.
3. Mantener `PUBLIC_BOOKING_ENABLED=false`, `PUBLIC_VIP_PURCHASE_ENABLED=false`, `VITE_PUBLIC_BOOKING_ENABLED=false` y `VITE_VIP_MEMBERSHIPS_PURCHASE_ENABLED=false`.
4. Usar el acceso privado YA configurado: exactamente un `PRIVATE_COMMERCE_USER_IDS`, IP propia en `PRIVATE_COMMERCE_IPS`, peer de Traefik correcto en `PRIVATE_COMMERCE_PROXY_IPS`, sesión y CSRF. **No se permite abrir el acceso público** para facilitar la prueba.
5. Activar temporalmente en backend `PRIVATE_COMMERCE_PILOT_ENABLED=true` (guard de acceso existente) y `PIXELPAY_LIVE_3DS_TEST_ENABLED=true`. Guardar y desplegar backend. El tiempo máximo de sesión es 30 minutos desde arranque.
6. Desde esa única cuenta y origen, crear una **reserva nueva** con tarifa comercial real y total mayor que 0 y menor o igual a L 500. No editar catálogo ni forzar un precio de L 1.00.
7. Ejecutar **una** Sale con tarjeta real (nunca las tarjetas Sandbox). Con 202, el SDK gestionará Collect/Lookup/StepUp; no repetir manualmente la venta ni pulsar pagar de nuevo. La única continuación permitida se ata al mismo intento y se envía por el worker una sola vez.
8. Si sale aprobada, verificar identidad de orden, moneda, importe, hash, registro durable y cita; anular (Void) desde PixelPay antes de las 10:00 p. m. local según lo indicado por soporte. Si queda incierta, **no repetir el cargo ni asumir que falló**: conciliar con el panel y soporte de PixelPay.
9. Desactivar **ambas** variables de prueba: `PIXELPAY_LIVE_3DS_TEST_ENABLED=false` y `PRIVATE_COMMERCE_PILOT_ENABLED=false`. Redesplegar backend y verificar elegibilidad pública cerrada.

## Límites técnicos
- El proceso admite una sola prueba Live por arranque y una sola sesión activa por worker. El backend marca la respuesta 202 antes de entregar el desafío y no consulta Status externo durante autenticación pendiente.
- La continuación se delega al gestor nativo del SDK. No se interpretan JWT de Cardinal ni respuestas de navegador como aprobación financiera.
- Ante reinicio, vencimiento, error o desconexión, el intento queda incierto: no hay reintentos automáticos.
- Se mantiene la configuración de una sola réplica de backend. No operar múltiples workers/replicas sin un estado distribuido.
- Nada de esto certifica 3DS Live antes de una transacción real controlada y verificación posterior.
