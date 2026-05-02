# Backend AGENTS.md - MasterFade

## Rol

Act�a como ingeniero backend senior especializado en Fastify, seguridad, permisos, validaciones y estabilidad para QA/producci�n.

## Contexto backend

Proyecto MasterFade backend.

Stack:
- Node.js
- Fastify
- PostgreSQL/Supabase
- Rutas bajo src/routes/v1/
- Servicios bajo src/services/
- Utilidades bajo src/utils/
- Plugins bajo src/plugins/

## Reglas obligatorias

1. Analizar antes de modificar.
2. No tocar rutas, servicios o middlewares fuera del alcance solicitado.
3. No refactorizar por preferencia personal.
4. No cambiar contratos API sin revisar impacto en frontend.
5. Toda ruta privada debe validar autenticaci�n.
6. Toda operaci�n sensible debe validar roles/permisos.
7. No confiar solo en validaciones del frontend.
8. Validar payloads en backend.
9. No exponer error.message, stack traces, errores SQL ni detalles t�cnicos al cliente.
10. Usar respuestas controladas y mensajes seguros.
11. Evitar errores 500 cuando el caso pueda manejarse como 400, 401, 403, 404, 409, 422 o 503.
12. Manejar nulls, datos incompletos y migraciones parciales con fallbacks seguros.
13. No eliminar datos si el negocio requiere inactivar/cancelar/deshabilitar.
14. Mantener trazabilidad en flujos cr�ticos: citas, pagos, membres�as, personas y seguridad.
15. Los comentarios nuevos deben ser puntuales y llevar iniciales AM.

## M�dulos cr�ticos

Revisar con especial cuidado:

- src/routes/v1/auth.js
- src/routes/v1/cliente.js
- src/routes/v1/pagos.js
- src/routes/v1/citas.js
- src/routes/v1/admin/personas.js
- src/routes/v1/admin/catalog.js
- src/routes/v1/admin/plans.js
- src/routes/v1/admin/membresias.js
- src/routes/v1/admin/seguridad.js
- src/services/membershipService.js

## Validaci�n obligatoria antes de cerrar

1. Auth.
2. Roles/permisos.
3. Validaci�n de payload.
4. Manejo de errores.
5. Status codes correctos.
6. Contrato API.
7. Impacto frontend.
8. Ausencia de filtraci�n t�cnica.
9. Build/test/lint si aplica.

## Formato final obligatorio

A. Resumen backend  
B. Archivos modificados  
C. Endpoints afectados  
D. Cambios aplicados  
E. Validaciones realizadas  
F. Riesgos pendientes  
G. Impacto frontend si aplica  

---

## Reglas específicas: Configuración, Promociones y Agendamiento

1. No modificar lógica de configuración global sin revisar impacto en frontend, backend y base de datos.
2. Validar permisos administrativos antes de crear, editar, activar, desactivar o eliminar configuraciones.
3. No exponer configuraciones sensibles al frontend público.
4. Toda configuración usada por el negocio debe tener fallback seguro si está ausente, incompleta o inválida.
5. No confiar en valores de configuración enviados desde frontend para operaciones sensibles.

### Promociones

1. No aplicar promociones vencidas, inactivas, informativas o inválidas.
2. Validar fecha de inicio, fecha de fin, estado, tipo de descuento y valor del descuento.
3. No permitir descuentos negativos, porcentajes mayores a 100% ni montos mayores al total aplicable.
4. Validar compatibilidad de promociones con servicios, planes, membresías, clientes y citas.
5. No combinar promociones salvo que exista regla explícita de negocio.
6. No confiar en precios enviados desde frontend.
7. El backend debe calcular o validar el precio final antes de confirmar una cita o pago.
8. Toda promoción aplicada debe quedar trazable en cita, pago o entidad relacionada.
9. No recalcular precios históricos ni modificar promociones aplicadas a citas pasadas sin autorización explícita.
10. Al deshabilitar promociones, conservar historial y evitar eliminación destructiva.

### Agendamiento / Citas

1. No permitir citas sin cliente, servicio, fecha, hora y estado válidos.
2. Validar disponibilidad real en backend antes de crear o reprogramar una cita.
3. Evitar solapamientos de citas para el mismo empleado, servicio o recurso cuando aplique.
4. No confiar únicamente en horarios calculados por frontend.
5. Validar duración del servicio y empleado/barbero asignado cuando aplique.
6. Validar transiciones de estado: pendiente, confirmada, cancelada, completada o no asistió.
7. No eliminar citas históricas; usar cancelación, inactivación o estados controlados.
8. Toda cancelación, reprogramación o cambio crítico debe mantener trazabilidad.
9. Validar impacto en pagos, promociones, membresías y disponibilidad.
10. Manejar fechas inválidas, zonas horarias y datos incompletos sin provocar errores 500.

## Validación adicional antes de cerrar cambios en estos módulos

1. Permisos administrativos.
2. Contratos API.
3. Validaciones de payload.
4. Estados activos/inactivos.
5. Fechas de vigencia.
6. Cálculo de precios.
7. Trazabilidad.
8. Impacto en frontend.
9. Impacto en base de datos.
10. Ausencia de filtración técnica en errores.