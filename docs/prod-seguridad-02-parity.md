# Matriz de paridad SEGURIDAD-02

Snapshot remoto de solo lectura: 2026-11-15 14:15 UTC. El estado alojado se diferencia
de la certificación local y del código del PR; ninguno implica aplicar SQL en Producción.

| Capacidad | Código/SQL versionado en candidato | SQL efectivo QA | SQL efectivo PROD | Certificación |
| --- | --- | --- | --- | --- |
| Fuente QA-SEGURIDAD-02B | Tres archivos idénticos a 73f1537, presentes en rama release | Aplicado bajo versión 20261114003629 | Pendiente | 41 cuerpos reconocidos en ambos, lectura remota |
| search_path de las 41 rutinas | Motor QA aprobado, guardas adicionales | Endurecido; conserva paths previos seguros | 36 sin path y cinco con path previo | PostgreSQL17 antes/después y reapply |
| EXECUTE de dos triggers SECURITY DEFINER | Restricción QA aprobada | Sin PUBLIC/anon/authenticated; roles servidor preservados | Acceso por PUBLIC | RLS/triggers/admin/grant options/inherencia |
| Dos helpers RLS | EXECUTE authenticated preservado | Endurecidos, excepción documentada | Permisos efectivos ya restringidos | Políticas y pruebas por rol |
| Respaldo privado y rollback | Fuente QA idéntica y postflight nuevo | 41 registros íntegros/privados, READY | No existe | Apply/rollback doble, concurrencia, rechazo de deriva |
| Lógica y ledger MasterPuntos | Sin cambios comerciales | Cinco cuerpos posteriores a PROD | Conserva sus cinco cuerpos anteriores | Hashes, filas sintéticas y vencimiento conservados |
| Release10 #123 → SEGURIDAD-02 | Compatibilidad SQL reproducida, sin integrar #123 | Estado equivalente de metadatos | No aplicado | Forward PASS en base nueva; reversión conjunta NO-GO por ACL |
| SEGURIDAD-02 → #123 | Guardas preservadas | No es la secuencia propuesta | No aplicado | Bloqueo esperado: hashes; tras rollback también proacl |
| Backend main | src y contratos intactos | No se redepliega | No se despliega | Regresiones completas y CI del candidato |
| HTTP/Supabase alojado con escrituras | Fuera de esta tarea | Sin pruebas de escritura | Sin pruebas de escritura | SKIP explícito |
| 10B, PixelPay Hosted, agenda del compañero | Excluidos | Sin cambios | Sin cambios | No integrados ni certificados por este PR |

GO técnico del candidato independiente requiere CI verde y repetir el preflight sobre el
catálogo vigente en la ventana autorizada. GO de aplicación remota aún no concedido.
NO-GO para ventana conjunta con #123 mientras sus guards/reversión no se reconcilien
en una revisión separada. Ningún saldo histórico se clasifica ni corrige en este paquete.
