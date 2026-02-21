import "dotenv/config"; // NUEVO: 
// PORQUE: Asegura que process.env esté listo antes de construir/register plugins.
// IMPACTO: Evita inconsistencias si algún plugin lee env al iniciar.

import { buildApp } from "./app.js";

const app = await buildApp();
const port = Number(process.env.PORT || 3002);
const host = process.env.HOST || "127.0.0.1";

// NUEVO:
// PORQUE: Evitar doble cierre por múltiples señales/errores.
// IMPACTO: Previene errores de "close called twice" y ayuda a liberar el puerto correctamente.
let isShuttingDown = false;

async function shutdown(signal, error) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // NUEVO:
  // PORQUE: Log claro de por qué se está cerrando.
  // IMPACTO: Debug más fácil.
  if (error) app.log.error({ signal, err: error }, "Cerrando servidor por error");
  else app.log.warn({ signal }, "Cerrando servidor...");

  try {
    // NUEVO:
    // PORQUE: Cierra listener HTTP y ejecuta hooks onClose (por ejemplo pool de DB).
    // IMPACTO: Libera el puerto 3002 y conexiones abiertas.
    await app.close();
  } catch (err) {
    app.log.error({ err }, "Error durante el cierre");
  } finally {
    process.exit(error ? 1 : 0);
  }
}

// NUEVO:
// PORQUE: Ctrl+C o apagado del proceso debe cerrar bien Fastify.
// IMPACTO: El puerto se libera al parar el servidor.
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// NUEVO:
// PORQUE: Si algo explota, cerramos ordenadamente en vez de dejar el proceso colgado.
// IMPACTO: Menos puertos “pegados” por procesos zombie.
process.on("uncaughtException", (err) => shutdown("uncaughtException", err));
process.on("unhandledRejection", (reason) =>
  shutdown("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)))
);

try {
  await app.listen({ port, host });

  // NUEVO:
  // PORQUE: Confirmación de arranque con dirección completa.
  // IMPACTO: Facilita saber dónde está corriendo.
  
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
