# Release10: cierre focalizado de ciclos y saldo historico

## A. Regla definitiva del propietario

Aclaracion del 15/11/2026 (America/Tegucigalpa), posterior al texto inicial del ticket:
**la vigencia es por ciclo, no por acreditacion individual**. El primer punto abre
12 meses calendario. Los puntos siguientes comparten ese aniversario. Si al llegar
el aniversario quedan ocho, vencen los ocho. Un sexto punto manual no reinicia el
plazo. Al agotarse el saldo, el siguiente credito abre otro ciclo; un canje que deja
remanente conserva el vencimiento vigente y no extiende puntos anteriores.

Para las cargas fisicas realizadas al montar Produccion, el propietario autorizo
expresamente usar la fecha de carga registrada como inicio: primer registro positivo
por cliente. No se deduce una fecha fisica desconocida ni se cambia created_at.
Esta decision sustituye el impedimento descrito en el cierre anterior. No se aplican
vencimientos individuales, puntos permanentes ni categorias comerciales nuevas.

## B. Base, alcance y compatibilidad

Base remota verificada: `55a86efb8b492402f79d7ec2930cdcfbd4fc72fb`.
HEAD anterior #123: `2d6f2eb1a5701550feffafc2a2ef2d7459be6fc4`.
Misma rama `release/prod-masterpuntos-functional`, sin dev, rebase ni force-push.

Solo MasterPuntos: tres funciones SQL existentes, vista de saldo, respaldo privado
del bootstrap y tratamiento controlado de sus errores en pointsService.js. No hay
cambios nuevos a citas.js, public/pagos.js, membershipService.js, proveedores,
checkout, flags, roles, frontend ni PR #132/#111/#93/#125. Las fuentes SQL previas
versionadas permanecen intactas; el paquete atomico incorpora la correccion despues
de ellas, sin intervalo operativo con una version intermedia.

## C. Causas corregidas

- **Reinicio:** fn_points_get_or_create_active_cycle conserva el aniversario mientras
  exista saldo. Cuando el saldo efectivo llega a cero, cierra ese ciclo usando el
  estado existente cerrado. El siguiente credito inicia otros doce meses. Un ciclo
  vacio previo se ancla en su primer credito, como antes.
- **Historico legitimo:** el preflight ya distingue cargas manuales verificables de
  historicos inconsistentes. Exige autor, signos/tipos correctos, fechas finitas y
  no futuras, orden inequivoco, prefijos no negativos y ciclo inicial no vencido.
  No acepta acreditaciones automaticas sin ciclo como si fueran cargas manuales.
  Los historicos completamente compensados siguen sin producir ciclos vacios.
- **Transicion:** se crean solamente metadatos points_cycles, desde el primer registro
  positivo autorizado de cada cliente. No se actualiza, borra, duplica ni compensa
  ningun points_transaction. Su asociacion efectiva se resuelve por cliente y rango
  temporal unico; los ciclos posteriores no absorben registros anteriores.
- **Debitos mixtos:** la vista, el calculo del ciclo, la guarda y materializacion
  incluyen esos movimientos originales sin id_cycle. No se confunde la suma de las
  filas con id_cycle explicito con el saldo completo del ciclo. Nueve puntos
  importados mas cinco nuevos menos diez dejan cuatro, sin saldo negativo ni
  vencimiento excesivo. El debito sigue siendo una unica fila de -10.
- **Concurrencia:** ajustes, canjes y vencimiento toman primero el mismo advisory lock
  por cliente. La guarda comprueba pertenencia y saldo antes de insertar; conserva
  los indices de idempotencia. Un rechazo SQL de ciclo se presenta como 409 seguro,
  sin exponer SQL ni alterar la respuesta de operaciones correctas.
- **Vencimiento:** vista de solo lectura y materializacion usan el mismo ciclo
  efectivo. Se resta solo el remanente, una vez, al alcanzar el limite exclusivo.
  Los meses calendario se anclan explicitamente en America/Tegucigalpa.

Las cargas anteriores conservan sus id_cycle y vence_at originales NULL en el
ledger: eso NO las convierte en permanentes. Su vigencia efectiva esta en el ciclo
creado desde la fecha autorizada; la vista, guarda y vencimiento lo resuelven. Los
nuevos ajustes guardan id_cycle y vence_at del ciclo vigente desde el INSERT.

No hay imputacion arbitraria entre ciclos simultaneos: el modelo conserva un unico
ciclo activo y exige revision ante periodos historicos ambiguos o ciclos inactivos
con saldo de un Cliente activo. No divide movimientos ni amplia reglas de canje.

## D. Evidencia productiva exclusivamente de lectura

`2026-11-16T00:27:50.901719+00:00` = 15/11/2026 18:27 Honduras.
REPEATABLE READ READ ONLY, transaction_read_only=on.

- 14 movimientos, 13 positivos, 69 puntos netos y 12 clientes; cero ciclos existentes.
- Ledger MD5: `7d9c4759b1d2e7f35c98a4c983f68cb6`, igual a las lecturas iniciales.
- **19 controles en cero**, incluido HISTORICAL_UNCYCLED_REVIEW.
- CATALOG_DRIFT=0 y SECURITY02_BACKUP_DRIFT=0.
- La bitacora tiene los 14 INSERT; no contiene otra fecha fisica de acreditacion.
  El uso de created_at procede de la autorizacion expresa del propietario, no de
  asumir que una fecha de importacion equivale siempre a una fecha fisica.

No se modifico ningun dato ni objeto remoto. No se utilizaron identidades reales
para escribir. La prueba local reconstruye catalogos y datos sinteticos, no declara
una certificacion funcional ya desplegada en Produccion.

## E. Aplicacion manual coordinada y rollback

1. Autorizacion explicita de ventana, respaldo/PITR disponible, escritores detenidos,
   rol postgres y SHA backend/SQL aprobados juntos. No ejecutar fuentes por separado.
2. Ejecutar `00-preflight.sql` completo: solo lectura, exigir TODOS affected=0.
   Archivar ledger_md5, cycles_md5, cantidad y suma actuales; no fijar 14/69 como sello.
   Cualquier deriva de catalogo, ACL, respaldo, fechas, signos, identidad o saldo bloquea.
3. Ejecutar `10-apply.sql` completo: una transaccion, locks de escritores en orden
   estable, lock_timeout=5s y statement_timeout=60s. Repite controles, instala fuentes
   y correccion, crea metadatos de ciclos y respaldo, valida target y datos otra vez.
   Antes de COMMIT exige que el hash del ledger siga EXACTAMENTE igual. Sin backfill
   de puntos, DML sobre el ledger ni registro ficticio de migraciones.
4. `20-postflight.sql` antes de trafico: target/ACL/backup exactos y todos controles
   en cero; ledger_md5, cantidad y suma iguales al preflight. **cycles_md5 cambia
   legitimamente al crear ciclos**: contrastarlo con cycles_after del respaldo y
   verificar anclas/aniversarios. No exigir igualdad con el hash de ciclos vacios.
5. Antes de trafico, `31-restore-before-traffic.sql`, en la misma conexion con
   masterfade.release10_expected_ledger y masterfade.release10_expected_cycles
   establecidos a los hashes originales del paso 2. Exige ledger original y ciclos
   exactos del bootstrap. Restaura nueve funciones/vista/triggers/ACL de PROD y elimina
   solo los ciclos nuevos. Conserva el respaldo privado. Verifica ambos hashes
   originales antes de COMMIT; no borra movimientos ni toca SEGURIDAD-02.
6. Tras nuevos movimientos, 31 se bloquea. `30-rollback-containment.sql` detiene solo
   las cuatro nuevas fuentes de acreditacion, conserva la guarda, saldo y expiracion.
   Mantener escritores detenidos y revisar; no recuperar el escritor antiguo que
   borraba puntos ni hacer compensaciones/backfill automaticos.

El unico objeto auxiliar nuevo es app_private.release10_cycle_bootstrap_backup:
respaldo de metadatos antes/despues y hash del ledger, RLS y privilegios solo postgres.
No es una clase de puntos ni un segundo ledger. Su contenido no se reemplaza al
reintentar; una deriva o acceso inesperado bloquea. Permite repetir apply tras un
aborto/reversion usando los mismos metadatos sin duplicar ciclos.

## F. SEGURIDAD-02 y pruebas

Se conservan fuentes, respaldos, OID, ACL y search_path endurecido de SEGURIDAD-02.
Solo cambian los tres cuerpos MasterPuntos enumerados y certificados en
current/cycle-target.json; el generador exige el SHA256 de su fuente y los tests
comparan los hashes reales PostgreSQL. No se rebaselina el respaldo de seguridad ni
se amplian indiscriminadamente las versiones aceptadas. La vista conserva owner,
ACL y contrato. Un rollback generico de SEGURIDAD-02 debe rechazar estos cuerpos
nuevos por deriva: es proteccion esperada, no motivo para actualizar su respaldo.

Comandos de certificacion, usando PostgreSQL 17 temporal en loopback:

- node --test --test-concurrency=2 (con las banderas financieras existentes de CI).
- node scripts/release-identity-postgres.mjs.
- npm run lint; ESLint de archivos JS afectados con max-warnings=0.
- node scripts/release-masterpuntos-package.mjs y git diff --exit-code del paquete.
- git diff --check.

Nueva suite de correccion: **26 PASS / 0 FAIL / 0 SKIP**. Fuentes de pago, canje
grupal, transicion/rollback: **182 PASS / 0 FAIL / 0 SKIP** en la ejecucion focalizada
anterior a los tres ultimos casos adicionales. Se conservan las 25 pruebas originales
de transicion; los dos nombres de fixtures sin autor se aclaran sin quitar aserciones.
Suite completa local: **3438 PASS / 0 FAIL / 7 SKIP**; identidad aislada: **12 PASS / 0 FAIL / 0 SKIP**.
ESLint: cero errores y 25 advertencias preexistentes; JS afectado con max-warnings=0.
CI del SHA final: enlace y resultado exactos en el PR #123. Los SKIP optativos no se
presentan como ejecutados; las suites financieras de CI se habilitaron.

Cobertura: 14/69/12, ledger byte a byte, fechas de carga distintas, sexto punto manual,
canje y restas concurrentes, reintentos, limite de ocho puntos, UTC/Honduras/Tokyo,
aniversarios/bisiesto, sobregiro, ciclo ajeno, roles, respaldo alterado/vacio/expuesto,
apply repetido, fallo atomico y rollback antes/despues de trafico.

## G. Decision y limites

GO tecnico para revision del codigo y SQL si la CI del SHA final pasa. La anterior
falta de autorizacion de fechas ya esta resuelta por el propietario; los historicos
ambiguos o inconsistentes siguen bloqueados. No hay permiso para aplicar SQL,
mergear ni desplegar: Produccion sigue NO-GO de ejecucion hasta autorizacion y ventana
coordinada. Pendiente validar despues de una aplicacion autorizada el backend servido,
rol de conexion, catalogo/postflight, interfaces y conciliacion con el ledger real.
No se afirma esa validacion desplegada. PR #132 permanece intacto.
