# Diagnostico temporal del proxy del piloto QA

## Alcance y activacion posterior

PR hacia dev. No autoriza merge, despliegue, cambios de entorno o pagos.
No introduce endpoints. Solo instrumenta GET /v1/commerce/eligibility.

Variables nuevas (no configuradas por este PR):

- QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED=true
- QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL=<fecha ISO UTC terminada en Z>

Por defecto no se emite ningun evento. Ambas variables son necesarias, con
NODE_ENV=development y ENTORNO=qa exactos. La fecha debe estar en el futuro
y a no mas de diez minutos del arranque. Una fecha ausente, invalida, vencida
o demasiado lejana desactiva el diagnostico. La fecha absoluta no se renueva
al reiniciar y el reloj monotono impide extender el intervalo si retrocede UTC.
No hay temporizadores, trabajos persistentes ni escrituras diagnosticas de sesion.

Limite fijo: cinco intentos con cookie presente por proceso, incluidos tokens
invalidos, reservados antes de autenticar para impedir superar el limite por
concurrencia. Cada intento puede emitir como maximo un evento. Reiniciar crea
otro contador, pero no extiende la fecha UTC. No reiniciar para ampliar captura.
Fuera de QA se ignora la activacion y no se cambia la respuesta.

## Autenticacion y contrato

Con piloto apagado, elegibilidad no ejecutaba autenticacion. El observador usa
el mismo verificador JWT y validador de sesion activa, sobre un objeto y respuesta
aislados, con readOnly=true. Se preservan firma, issuer, audience, tipo de token,
identificadores de sesion, hash JTI, estado, revocacion, vencimiento e inactividad.
No se actualiza, expira ni toca la sesion durante esa comprobacion adicional.
La autenticacion ordinaria mantiene readOnly=false por defecto y su conducta.
Tokens invalidos, sesiones revocadas o consultas fallidas no generan evento.
No se asignan auth/claims del diagnostico a la peticion real.

La instrumentacion registra la primera condicion evaluada por el guard original,
sin duplicar su decision financiera. PILOT_DISABLED es distinto de errores de
peer, longitud de cadena, IP cliente, usuario, identidad, cliente y rol.
AUTH_CONTEXT_REJECTED indica que el guard original ya envio su rechazo.
Los fallos del observador no afectan la respuesta ni las decisiones comerciales.

## Evento seguro

QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC contiene UTC, instancia/PID/requestId
acotados, peer TCP enmascarado, IP resuelta enmascarada, ipsLength real,
fastifyTrustsPeer (evaluacion de buildTrustProxy con TRUST_PROXY de arranque),
coincidencias exactas peerAllowlisted/clientAllowlisted/directPeerAllowlisted
y reason de una lista fija. IPv6 se oculta completamente. No se serializan
peticiones, cabeceras, cookies, JWT, UUID, credenciales ni valores de configuracion.
fastifyTrustsPeer no significa identidad Traefik autenticada: la politica existente
acepta un primer salto interno. La allowlist comercial exacta sigue siendo necesaria.

## Decision sobre easypanel-endpoint: NO-GO de confianza exclusiva

La unica observacion coordinada previa encontro un socket y un endpoint exactos
en la red compartida easypanel, identificado como easypanel-endpoint, sin tarea
Traefik acreditada. Los nombres tecnicos bastan para documentar esa topologia;
este informe no incluye IP exactas ni identificadores personales.

El endpoint de balanceo Swarm funciona en la capa de transporte. No acredita
por si mismo saneamiento de X-Forwarded-For ni origen HTTP exclusivo de Traefik.
La red observada es compartida con otros servicios. No queda validada como frontera
exclusiva de confianza. Tampoco ipsLength=2 demostraria que la cabecera original
tuviera una unica direccion: buildTrustProxy trunca los saltos mas lejanos.

Docker asigna direcciones al inicializar/actualizar componentes. No se garantiza
que el endpoint conserve su IP tras recrearse; tampoco se afirma que cambie con
cada despliegue del backend. Una VIP o nombre DNS no prueba identidad del peer.

Fuentes primarias:
- https://docs.docker.com/engine/swarm/networking/
- https://docs.docker.com/engine/swarm/

Solucion estable minima propuesta, NO implementada: autenticar el canal
Traefik-backend con mTLS y una identidad de certificado exclusiva, verificable,
manteniendo sesion, unico usuario, IP publica exacta, CSRF y los bloqueos VIP/Sale.
El cliente solo se resolveria desde un proxy autenticado que sanee el origen.
Requiere autorizacion independiente. No dar acceso Docker al backend ni autorizar
CIDR completos, cabeceras arbitrarias o easypanel-endpoint solo por su IP.

## Verificacion QA, solo tras autorizacion separada

1. Revisar/autorizar merge y despliegue QA por separado.
2. Mantener PRIVATE_COMMERCE_PILOT_ENABLED=false,
   QA_PRIVATE_COMMERCE_SALE_ENABLED=false y VIP suspendido; no cambiar TRUST_PROXY.
3. El operador fija una fecha UTC futura dentro de diez minutos y activa las dos
   variables nuevas exclusivamente en QA, bajo autorizacion propia.
4. Realizar una consulta autenticada a la ruta existente. Buscar un unico evento
   por requestId/instancia/PID y comprobar ipsLength, booleanos y PILOT_DISABLED.
5. No repetir capturas de sockets. Si ipsLength es distinto de 2, el contrato de
   cadena falla; si es 2, queda probado el getter, pero no la exclusividad del
   intermediario. El bloqueo de confianza de la red compartida permanece.
6. Cualquier IP exacta candidata se verifica solo en un canal operativo privado
   autorizado. Las mascaras nunca son valores configurables ni se publican valores
   reales en PR, CI o informes. No activar el piloto para obtener logs.

## Retirada y rollback

La caducidad y el limite detienen solos las emisiones. Para deshabilitar en la
proxima operacion autorizada, poner QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED=false
y retirar QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL. No cambia controles comerciales.
Tras cerrar la decision, retirar helper, llamadas y opcion readOnly mediante PR
de limpieza revisado; no crear ni fusionar una reversion automatica.
