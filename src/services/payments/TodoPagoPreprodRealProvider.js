import { PaymentProvider } from './PaymentProvider.js'
import { normalizeCreateIntentResult } from './paymentProviderContract.js'
import { encryptTodoPagoData } from './todopago/TodoPagoEncryption.js'
import {
  buildTodoPagoLaunch,
  normalizeTodoPagoAllowedMessageOrigin,
  normalizeTodoPagoAmount,
  normalizeTodoPagoExpiresAt,
  normalizeTodoPagoModalUrl,
} from './todopago/TodoPagoLaunchBuilder.js'

const REQUIRED_CONFIG_FIELDS = Object.freeze([
  'username',
  'password',
  'gatewayUsername',
  'gatewayPassword',
  'encryptionKey',
  'tenant',
  'terminal',
  'modalUrl',
  'allowedMessageOrigin',
  'commerceId',
])

const REQUIRED_METADATA_FIELDS = Object.freeze([
  'customerName',
  'clientIp',
  'ordenDeCompra',
  'expiresAt',
])

export class TodoPagoPreprodRealProviderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TodoPagoPreprodRealProviderError'
    this.code = code
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateConfig(config) {
  if (!isObject(config)) {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_PROVIDER_CONFIG_INVALID',
      'TodoPago provider configuration is invalid',
    )
  }

  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!isNonEmptyText(config[field])) {
      throw new TodoPagoPreprodRealProviderError(
        'TODOPAGO_PROVIDER_CONFIG_INVALID',
        'TodoPago provider configuration is invalid',
      )
    }
  }

  try {
    return Object.freeze({
      ...config,
      modalUrl: normalizeTodoPagoModalUrl(config.modalUrl),
      allowedMessageOrigin: normalizeTodoPagoAllowedMessageOrigin(
        config.allowedMessageOrigin,
        { requireOriginOnly: true },
      ),
    })
  } catch {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_PROVIDER_CONFIG_INVALID',
      'TodoPago provider configuration is invalid',
    )
  }
}

function validateDependency(value) {
  if (typeof value !== 'function') {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_PROVIDER_DEPENDENCY_INVALID',
      'TodoPago provider dependency is invalid',
    )
  }
}

function validateCreateIntentInput(input) {
  if (
    !isObject(input) ||
    !isNonEmptyText(input.idempotencyKey) ||
    !Number.isFinite(input.montoHnl) ||
    !isNonEmptyText(input.moneda) ||
    !isNonEmptyText(input.descripcion) ||
    !isNonEmptyText(input.callbackUrl)
  ) {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_CREATE_INTENT_INVALID',
      'TodoPago payment intent input is invalid',
    )
  }

  if (!isObject(input.metadata)) {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_METADATA_REQUIRED',
      'TodoPago payment metadata is incomplete',
    )
  }

  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!isNonEmptyText(input.metadata[field])) {
      throw new TodoPagoPreprodRealProviderError(
        'TODOPAGO_METADATA_REQUIRED',
        'TodoPago payment metadata is incomplete',
      )
    }
  }

  normalizeTodoPagoAmount(input.montoHnl)
  return normalizeTodoPagoExpiresAt(input.metadata.expiresAt)
}

function resolveCurrentTime(now) {
  let currentTime
  try {
    currentTime = now()
  } catch {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_CLOCK_INVALID',
      'TodoPago provider clock is invalid',
    )
  }

  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_CLOCK_INVALID',
      'TodoPago provider clock is invalid',
    )
  }

  return currentTime
}

function validateAuthenticationResult(result) {
  if (
    !isObject(result) ||
    !isNonEmptyText(result.token) ||
    !isNonEmptyText(result.idTransaccion)
  ) {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_AUTH_RESPONSE_INVALID',
      'TodoPago authentication response is invalid',
    )
  }
}

export class TodoPagoPreprodRealProvider extends PaymentProvider {
  constructor({
    config,
    authClient,
    encryptData = encryptTodoPagoData,
    buildLaunch = buildTodoPagoLaunch,
    now = () => new Date(),
  } = {}) {
    super()

    if (!authClient || typeof authClient.authenticate !== 'function') {
      throw new TodoPagoPreprodRealProviderError(
        'TODOPAGO_PROVIDER_DEPENDENCY_INVALID',
        'TodoPago provider dependency is invalid',
      )
    }

    validateDependency(encryptData)
    validateDependency(buildLaunch)
    validateDependency(now)

    this.config = validateConfig(config)
    this.authClient = authClient
    this.encryptData = encryptData
    this.buildLaunch = buildLaunch
    this.now = now
  }

  async createIntent(input) {
    const normalizedExpiresAt = validateCreateIntentInput(input)
    const currentTime = resolveCurrentTime(this.now)

    if (new Date(normalizedExpiresAt).getTime() <= currentTime.getTime()) {
      throw new TodoPagoPreprodRealProviderError(
        'TODOPAGO_LAUNCH_EXPIRED',
        'TodoPago payment launch has expired',
      )
    }

    const { montoHnl, moneda, descripcion, metadata } = input
    const authentication = await this.authClient.authenticate({
      username: this.config.username,
      password: this.config.password,
    })

    validateAuthenticationResult(authentication)

    const { token, idTransaccion } = authentication
    const encrypted = await this.encryptData({
      secret: this.config.encryptionKey,
      ip: metadata.clientIp,
      userTodopago: this.config.gatewayUsername,
      passwordTodopago: this.config.gatewayPassword,
      tenantId: this.config.tenant,
      terminalNbr: this.config.terminal,
    })

    if (!isNonEmptyText(encrypted)) {
      throw new TodoPagoPreprodRealProviderError(
        'TODOPAGO_ENCRYPTION_RESULT_INVALID',
        'TodoPago encryption result is invalid',
      )
    }

    const launch = await this.buildLaunch({
      modalUrl: this.config.modalUrl,
      allowedMessageOrigin: this.config.allowedMessageOrigin,
      tokenTodomovil: token,
      idTransaccion,
      amount: montoHnl,
      customerName: metadata.customerName,
      ordenDeCompra: metadata.ordenDeCompra,
      currencyCode: moneda,
      comentario: descripcion,
      encrypted,
      expiresAt: normalizedExpiresAt,
    })

    return normalizeCreateIntentResult({
      providerIntentId: idTransaccion,
      paymentUrl: null,
      launch,
      raw: {
        provider: 'todopago',
        mode: 'preprod_real',
        ordenDeCompra: metadata.ordenDeCompra,
        commerceId: this.config.commerceId,
      },
    })
  }

  async queryStatus() {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_STATUS_QUERY_UNSUPPORTED',
      'TodoPago status query is not supported',
    )
  }

  async cancelIntent() {
    throw new TodoPagoPreprodRealProviderError(
      'TODOPAGO_CANCEL_UNSUPPORTED',
      'TodoPago cancellation is not supported',
    )
  }

  verifyWebhookSignature() {
    return false
  }
}

export default TodoPagoPreprodRealProvider
