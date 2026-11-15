# Validación SEGURIDAD-02 de release

Base main: 3a77863038f866f2b30787a8e67cf69bd8e8adaa. PostgreSQL local 17.11,
Node 22.14.0, zona UTC, conexiones de prueba exclusivamente loopback.
La CI de GitHub comprueba el SHA publicado del PR, con matriz B0 inmutable y D1.
Los enlaces de esa ejecución se entregan en la descripción del PR.

| Validación | Resultado |
| --- | --- |
| HEAD remoto main y #123 | PASS: 3a77863 y 57ca040, respectivamente |
| Fuentes manuales QA-02B | PASS: tres archivos sin diferencias contra 73f1537 |
| Preflight original remoto QA / PROD | PASS: 41 KNOWN_DEFINITION en cada entorno |
| Preflight exacto PROD | PASS: PROD_CURRENT, mismatches=0, trusted=true |
| Preflight exacto QA | PASS: RELEASE10_HARDENED, mismatches=0, trusted=true |
| Respaldo remoto QA | PASS: 41/41 íntegros, READY, privado y con RLS |
| Suite completa backend, misma activación PG que CI | PASS: 3238 aprobadas, 0 fallos, 7 SKIP, 3245 total |
| Identidad en otra BD efímera | PASS: 12 aprobadas, 0 fallos, 0 SKIP |
| Seguridad y release dentro de suite completa | PASS: 15 pruebas incluidas; cero SKIP |
| Protección contra deriva | PASS: owner, cuerpo, firma, ACL/herencia, search_path, trigger y dependencia de política |
| Doble aplicación/concurrencia/reversión/reapply | PASS: motor QA aprobado; el catálogo actual verifica además entrada/salida exactas |
| Preservación financiera | PASS: cuerpos y ledger sintético intactos; regresiones de vencimiento firmado/idempotente |
| #123 primero → SEGURIDAD-02 | PASS forward: 13 hashes y postflight #123 conservados |
| SEGURIDAD-02 primero → #123 | PASS del bloqueo esperado por hashes; después del rollback también por ACL explícita |
| Rollback SEGURIDAD-02 después de #123 | PASS efectivo; incompatibilidad esperada del postflight estricto #123 reproducida |
| Hashes SHA256 de entradas congeladas de #123 | PASS: SQL apply/postflight/pago verificados en test estático |
| ESLint | PASS: cero errores, 25 warnings preexistentes; archivos JS nuevos/modificados con max-warnings=0 |
| diff --check / reconstrucción del paquete | PASS; CI verifica además git diff --exit-code del paquete generado |
| Build | SKIP: el backend no define script build |
| Escritura remota / smoke HTTP que escriba | SKIP: prohibido por el alcance; ninguna escritura remota ejecutada |

Las siete omisiones preexistentes son benchmark y contrato PG de códigos de reserva,
02G, alcance administrativo de personas, invitado/empleado y dos suites PROMOS_b.
Exigen activaciones propias ajenas a este paquete; no se cuentan como aprobadas.
Las pruebas financieras/pagos/membresías activadas en CI sí se ejecutaron.

Comando local completo (PowerShell, binarios PG17 instalados fuera del repositorio):

```powershell
$env:MASTERFADE_TEST_PG_BIN='C:/ruta/postgresql17/bin'
$env:MASTERFADE_PHASE02_PG_BIN=$env:MASTERFADE_TEST_PG_BIN
$env:RUN_PAYMENT_LATE_PG_INTEGRATION='true'
$env:RUN_FINANCIAL_CONTRACT_PG='true'
$env:RUN_MEMBERSHIP_RECONCILIATION_PG='true'
$env:RUN_MEMBERSHIP_PAYMENT_IDENTITY_PG='true'
$env:RUN_PIXELPAY_RESPONSE_CODE_PG='true'
$env:TZ='UTC'
$env:PGTZ='UTC'
node --test --test-concurrency=2
npm run lint
node scripts/release-security02-package.mjs
git diff --exit-code -- db/manual/security02-release
git diff --check
node scripts/release-identity-postgres.mjs
```

La suite adicional de identidad usa otra BD efímera y se reporta por separado en CI;
no utiliza QA/PROD ni el Auth alojado. El paquete reproduce los límites de QA-02B:
no cambia cuerpos comerciales, RLS ni políticas financieras para resolver un test.
Los fallos de desarrollo iniciales del fixture de ACL se corrigieron conservando proacl
NULL al reconstruir el catálogo, y se ejecutó después la suite completa con cero fallos.
La incompatibilidad posterior al rollback es un hallazgo real, conservado como aserción
de bloqueo esperado; no se neutraliza modificando el catálogo ni el candidato #123.

GO técnico independiente sujeto a CI verde del SHA y preflight vigente en ventana.
NO-GO técnico para integración/reversión conjunta sin revisar antes los guards de #123.
