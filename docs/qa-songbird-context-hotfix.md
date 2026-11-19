# Hotfix QA: distinguir rechazo de contexto y excepción de captura

## Evidencia y alcance

La operación histórica comunicada por el operador está bloqueada y no se reutiliza. El wrapper de lectura disponible no permitió correlacionarla ni recuperar la condición específica que falló. No se atribuye el fallo a un JWT, clave, campo o variante concreta sin esa evidencia.

SDK Core 2.5.8 conserva la petición cifrada y `sdk_key_pair`; su serialización filtra una copia. El E2E con SDK real y transporte sintético llega a `handoff_ready`. No se reprodujo pérdida de objetos del SDK.

Sí se reproduce una pérdida de diagnóstico local: `PixelPaySdkProvider` absorbe excepciones de captura, y `SongbirdBridge.capture()` convierte varios rechazos distintos de contexto/JWT en `PIXELPAY_SONGBIRD_CONTEXT_UNAVAILABLE`. Este hotfix corrige exclusivamente esa ambigüedad. Los predicados originales de aceptación de claves, cifrado, identidad y JWT se mantienen.

## Telemetría mínima

Se emite un único evento `PIXELPAY_SONGBIRD_CAPTURE_DIAGNOSTIC` después del callback interno de captura de un 202/songbird QA. Usa el gate Sandbox/QA existente, sin nueva variable ni migración. No se emite para HTTP 200 ni fuera de ese callback diagnóstico.

El evento contiene `capture` y `validation`: decisión booleana, etapa de una lista cerrada, regla de una lista cerrada y flags booleanos allowlisted. `bridge_capture_completed` distingue un fallo del sink. `validation_available` indica si hubo inspección contra el contexto durable. No se serializan excepciones originales ni resultados completos.

| Lectura | Significado |
| --- | --- |
| `capture.rule=CAPTURE_EXCEPTION` | Excepción durante la captura local; no prueba que el proveedor omitiera datos. |
| `capture.rule=SDK_PUBLIC_KEY_MISSING` / `MERCHANT_PUBLIC_KEY_INVALID` | Regla exacta sobre la clave observada, sin publicar su valor. |
| `validation.rule=CONTEXT_MISSING` | El sink recibió contexto ausente; contrastar con `capture.rule`. |
| `validation.rule=JWT_SHAPE_INVALID`, `JWT_EXPIRED`, `JWT_IAT_STALE` o `JWT_ORDER_MISMATCH` | Rechazo concreto del token; no se publica token, algoritmo, fecha ni orden. |
| `COLLECTION_URL_UNSUPPORTED` | Variante existente no admitida; el bloqueo se conserva. |
| Ambas decisiones `true`, regla `VALID` | Los mismos guards originales aceptaron el contexto; no acredita autenticación ni pago. |

No se registran PAN, CVV, JWT, ciphertext, claves públicas o privadas, secretos, headers ni respuestas completas. El diagnóstico es transitorio, solo para el logger: no se persiste y no aparece en status, claim o respuestas públicas de Sale. Los fallos del logger no alteran el resultado incierto ni los claims.

## Procedimiento mínimo tras autorización separada

1. Autorizar y desplegar únicamente el backend del PR en QA; comprobar su HEAD. No requiere migraciones ni cambios de variables. Mantener segunda Sale/finalización financiera bloqueadas y los controles existentes de sesión Sandbox.
2. Crear una reserva y un intent **nuevos**, por L 1.00 HNL, con el caso oficial 2.9. Ejecutar una única operación inicial autorizada. No usar ni reintentar el intent histórico.
3. Obtener el evento sanitizado de los logs QA. Compartir solo etapas, códigos y booleanos. Si el wrapper filtra el evento, el operador debe leerlo en el visor QA autorizado; no ampliar permisos ni exportar cuerpos.
4. Con `handoff_ready` y la lease vigente, iniciar una vez la autenticación del puente existente. Si una regla rechaza datos ausentes, contradictorios o no admitidos, detener ese intent; no relajarla para forzar el desafío.
5. La aparición del desafío y la causa del incidente histórico siguen sin acreditarse hasta esa prueba. El resultado positivo de continue y la idempotencia del segundo POST mantienen su bloqueo contractual independiente.

Rollback: revertir este PR. No hay esquema, datos, flags ni capacidades financieras nuevos que revertir. AES-GCM, consumo único, caducidad, claims, ACS Sandbox y v2 permanecen intactos.
