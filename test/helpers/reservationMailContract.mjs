import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// AM: Ejecutar helpers reales aislados sin importar rutas financieras ni enviar correos.
function declaration(source, name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const match = marker.exec(source);
  if (!match) throw new Error(`Missing mail helper ${name}`);
  const remaining = source.slice(match.index);
  const next = remaining.slice(1).search(/\n(?:export )?(?:async )?function \w+/);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

export async function loadReservationMailContracts() {
  const paths = [
    new URL('../../src/routes/v1/public/pagos.js', import.meta.url),
    new URL('../../src/routes/v1/citas.js', import.meta.url),
  ];
  const [paid, membership] = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
  const shared = ['safeText', 'normalizeEmail', 'hashString', 'buildBookingShortCode', 'escapeHtml', 'formatDateTimeHn', 'resolvePaymentsFromAlias'];
  function load(source, names, result) {
    const declarations = [...shared, ...names].map((name) => declaration(source, name)).join('\n');
    return vm.runInNewContext(`const HONDURAS_TIME_ZONE='America/Tegucigalpa'; const EMAIL_PATTERN=/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\n${declarations}\n({${result}})`, { process: { env: {} } });
  }
  return {
    ...load(paid, ['queuePostPaymentEmails', 'buildPostPaymentEmailTemplate'], 'queuePostPaymentEmails,buildPostPaymentEmailTemplate,buildBookingShortCode'),
    ...load(membership, ['sendNoPaymentConfirmationEmails', 'buildNoPaymentConfirmationEmailTemplate'], 'sendNoPaymentConfirmationEmails'),
  };
}
