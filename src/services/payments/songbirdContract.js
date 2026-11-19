import { AppError } from '../../utils/errors.js';

// AM: No env flag can accredit a provider token or enable a second financial POST.
const unavailable = () => { throw new AppError(409, 'La autenticacion requiere un contrato del proveedor.', { code: 'PIXELPAY_SONGBIRD_CONTRACT_BLOCKED' }); };
export const songbirdContract = Object.freeze({
  id: 'pixelpay-songbird-unaccredited',
  browserPayloadAccredited: false,
  inspect: () => false,
  lookup: unavailable,
  validate: unavailable,
});

export function assertSongbirdFinalizationBlocked() {
  throw new AppError(409, 'La finalizacion 3DS no esta habilitada.', { code: 'PIXELPAY_3DS_FINALIZATION_BLOCKED' });
}
