import assert from 'node:assert/strict'
import test from 'node:test'

import TodoPagoPreprodRealProvider, {
  TodoPagoPreprodRealProviderError,
} from '../src/services/payments/TodoPagoPreprodRealProvider.js'

const CONFIG = Object.freeze({
  username: 'auth-user',
  password: 'auth-password',
  gatewayUsername: 'gateway-user',
  gatewayPassword: 'gateway-password',
  encryptionKey: 'encryption-secret',
  tenant: 'tenant-001',
  terminal: 'terminal-001',
  modalUrl: 'https://modal.example.test/checkout',
  allowedMessageOrigin: 'https://modal.example.test',
  commerceId: 'commerce-001',
})

const INTENT_INPUT = Object.freeze({
  idempotencyKey: 'intent-idempotency-001',
  montoHnl: 125.5,
  moneda: 'HNL',
  descripcion: 'Reserva MasterFade',
  callbackUrl: 'https://api.example.test/payments/callback',
  metadata: Object.freeze({
    customerName: 'Cliente Prueba',
    clientIp: '192.0.2.10',
    ordenDeCompra: 'ORDER-001',
    expiresAt: '2026-08-01T18:30:00.000Z',
  }),
})

function createLaunch(input) {
  return {
    type: 'iframe_post',
    action: input.modalUrl,
    method: 'POST',
    fields: {
      tokenTodomovil: input.tokenTodomovil,
      idTransaccion: input.idTransaccion,
      amount: '125.50',
      customerName: input.customerName,
      ordenDeCompra: input.ordenDeCompra,
      currencyCode: input.currencyCode,
      comentario: input.comentario,
      encrypted: input.encrypted,
    },
    allowedMessageOrigin: input.allowedMessageOrigin,
    expiresAt: input.expiresAt,
  }
}

function createHarness(overrides = {}) {
  const calls = {
    authenticate: [],
    encryptData: [],
    buildLaunch: [],
  }

  const authClient = overrides.authClient ?? {
    async authenticate(input) {
      calls.authenticate.push(input)
      return {
        token: 'private-auth-token',
        idTransaccion: 'transaction-001',
      }
    },
  }

  const encryptData =
    overrides.encryptData ??
    (async (input) => {
      calls.encryptData.push(input)
      return 'private-encrypted-payload'
    })

  const buildLaunch =
    overrides.buildLaunch ??
    (async (input) => {
      calls.buildLaunch.push(input)
      return createLaunch(input)
    })

  const provider = new TodoPagoPreprodRealProvider({
    config: overrides.config ?? CONFIG,
    authClient,
    encryptData,
    buildLaunch,
    now: overrides.now ?? (() => new Date('2026-08-01T12:00:00.000Z')),
  })

  return { provider, calls }
}

test('createIntent orchestrates one authentication and returns the normalized launch contract', async () => {
  const { provider, calls } = createHarness()

  const result = await provider.createIntent(INTENT_INPUT)

  assert.equal(calls.authenticate.length, 1)
  assert.equal(calls.buildLaunch.length, 1)
  assert.deepEqual(calls.authenticate[0], {
    username: CONFIG.username,
    password: CONFIG.password,
  })
  assert.equal(result.providerIntentId, 'transaction-001')
  assert.equal(result.paymentUrl, null)
  assert.deepEqual(result.launch, createLaunch(calls.buildLaunch[0]))
})

test('createIntent sends the exact payload to the encryption dependency', async () => {
  const { provider, calls } = createHarness()

  await provider.createIntent(INTENT_INPUT)

  assert.deepEqual(calls.encryptData, [
    {
      secret: CONFIG.encryptionKey,
      ip: INTENT_INPUT.metadata.clientIp,
      userTodopago: CONFIG.gatewayUsername,
      passwordTodopago: CONFIG.gatewayPassword,
      tenantId: CONFIG.tenant,
      terminalNbr: CONFIG.terminal,
    },
  ])
})

test('createIntent sends the exact payload to the launch builder', async () => {
  const { provider, calls } = createHarness()

  await provider.createIntent(INTENT_INPUT)

  assert.deepEqual(calls.buildLaunch, [
    {
      modalUrl: CONFIG.modalUrl,
      allowedMessageOrigin: CONFIG.allowedMessageOrigin,
      tokenTodomovil: 'private-auth-token',
      idTransaccion: 'transaction-001',
      amount: INTENT_INPUT.montoHnl,
      customerName: INTENT_INPUT.metadata.customerName,
      ordenDeCompra: INTENT_INPUT.metadata.ordenDeCompra,
      currencyCode: INTENT_INPUT.moneda,
      comentario: INTENT_INPUT.descripcion,
      encrypted: 'private-encrypted-payload',
      expiresAt: INTENT_INPUT.metadata.expiresAt,
    },
  ])
})

test('createIntent rejects an expired expiresAt before authentication', async () => {
  const { provider, calls } = createHarness()

  await assert.rejects(
    provider.createIntent({
      ...INTENT_INPUT,
      metadata: {
        ...INTENT_INPUT.metadata,
        expiresAt: '2026-08-01T11:59:59.000Z',
      },
    }),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_LAUNCH_EXPIRED',
  )

  assert.equal(calls.authenticate.length, 0)
  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

test('createIntent rejects invalid RFC3339 expiresAt before authentication', async () => {
  const { provider, calls } = createHarness()

  await assert.rejects(
    provider.createIntent({
      ...INTENT_INPUT,
      metadata: {
        ...INTENT_INPUT.metadata,
        expiresAt: '2026-08-01 18:30:00',
      },
    }),
    (error) => error.code === 'TODOPAGO_LAUNCH_EXPIRES_AT_INVALID',
  )

  assert.equal(calls.authenticate.length, 0)
  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

test('createIntent rejects expiresAt equal to now before authentication', async () => {
  const { provider, calls } = createHarness()

  await assert.rejects(
    provider.createIntent({
      ...INTENT_INPUT,
      metadata: {
        ...INTENT_INPUT.metadata,
        expiresAt: '2026-08-01T12:00:00.000Z',
      },
    }),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_LAUNCH_EXPIRED',
  )

  assert.equal(calls.authenticate.length, 0)
  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

test('createIntent reports an invalid injected clock before authentication', async () => {
  const { provider, calls } = createHarness({
    now: () => new Date('invalid'),
  })

  await assert.rejects(
    provider.createIntent(INTENT_INPUT),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_CLOCK_INVALID',
  )

  assert.equal(calls.authenticate.length, 0)
  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

for (const [amount, expectedCode] of [
  [0, 'TODOPAGO_LAUNCH_AMOUNT_INVALID'],
  [-1, 'TODOPAGO_LAUNCH_AMOUNT_INVALID'],
  [0.001, 'TODOPAGO_LAUNCH_AMOUNT_INVALID'],
  [NaN, 'TODOPAGO_CREATE_INTENT_INVALID'],
  [Infinity, 'TODOPAGO_CREATE_INTENT_INVALID'],
]) {
  test(`createIntent rejects amount ${String(amount)} before authentication`, async () => {
    const { provider, calls } = createHarness()

    await assert.rejects(
      provider.createIntent({ ...INTENT_INPUT, montoHnl: amount }),
      (error) => error.code === expectedCode,
    )

    assert.equal(calls.authenticate.length, 0)
    assert.equal(calls.encryptData.length, 0)
    assert.equal(calls.buildLaunch.length, 0)
  })
}

for (const modalUrl of [
  'http://modal.example.test/checkout',
  'not-a-valid-url',
]) {
  test(`provider rejects invalid modalUrl: ${modalUrl}`, () => {
    assert.throws(
      () => createHarness({ config: { ...CONFIG, modalUrl } }),
      (error) =>
        error instanceof TodoPagoPreprodRealProviderError &&
        error.code === 'TODOPAGO_PROVIDER_CONFIG_INVALID',
    )
  })
}

for (const allowedMessageOrigin of [
  'http://modal.example.test',
  'not-a-valid-origin',
  'https://modal.example.test/messages',
]) {
  test(`provider rejects invalid allowedMessageOrigin: ${allowedMessageOrigin}`, () => {
    assert.throws(
      () => createHarness({
        config: { ...CONFIG, allowedMessageOrigin },
      }),
      (error) =>
        error instanceof TodoPagoPreprodRealProviderError &&
        error.code === 'TODOPAGO_PROVIDER_CONFIG_INVALID',
    )
  })
}

test('createIntent raw diagnostic data contains only the approved safe fields', async () => {
  const { provider } = createHarness()

  const result = await provider.createIntent(INTENT_INPUT)

  assert.deepEqual(result.raw, {
    provider: 'todopago',
    mode: 'preprod_real',
    ordenDeCompra: INTENT_INPUT.metadata.ordenDeCompra,
    commerceId: CONFIG.commerceId,
  })

  const serializedRaw = JSON.stringify(result.raw)
  for (const secret of [
    'private-auth-token',
    'private-encrypted-payload',
    CONFIG.password,
    CONFIG.gatewayPassword,
    CONFIG.encryptionKey,
    CONFIG.username,
    CONFIG.gatewayUsername,
  ]) {
    assert.equal(serializedRaw.includes(secret), false)
  }
})

for (const missingField of [
  'customerName',
  'clientIp',
  'ordenDeCompra',
  'expiresAt',
]) {
  test(`createIntent rejects missing metadata.${missingField} before authentication`, async () => {
    const { provider, calls } = createHarness()
    const metadata = { ...INTENT_INPUT.metadata }
    delete metadata[missingField]

    await assert.rejects(
      provider.createIntent({ ...INTENT_INPUT, metadata }),
      (error) =>
        error instanceof TodoPagoPreprodRealProviderError &&
        error.code === 'TODOPAGO_METADATA_REQUIRED',
    )

    assert.equal(calls.authenticate.length, 0)
    assert.equal(calls.encryptData.length, 0)
    assert.equal(calls.buildLaunch.length, 0)
  })
}

test('authentication failure is preserved and stops encryption and launch building', async () => {
  const authenticationError = Object.assign(new Error('Safe authentication failure'), {
    code: 'TODOPAGO_AUTH_HTTP_ERROR',
  })
  let authenticationAttempts = 0
  const { provider, calls } = createHarness({
    authClient: {
      async authenticate() {
        authenticationAttempts += 1
        throw authenticationError
      },
    },
  })

  await assert.rejects(provider.createIntent(INTENT_INPUT), (error) => {
    assert.equal(error, authenticationError)
    assert.equal(error.code, 'TODOPAGO_AUTH_HTTP_ERROR')
    return true
  })

  assert.equal(authenticationAttempts, 1)
  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

test('encryption failure stops the launch builder without retries', async () => {
  const encryptionError = Object.assign(new Error('Safe encryption failure'), {
    code: 'TODOPAGO_ENCRYPTION_FAILED',
  })
  let encryptionAttempts = 0
  const { provider, calls } = createHarness({
    encryptData: async () => {
      encryptionAttempts += 1
      throw encryptionError
    },
  })

  await assert.rejects(provider.createIntent(INTENT_INPUT), (error) => {
    assert.equal(error, encryptionError)
    return true
  })

  assert.equal(calls.authenticate.length, 1)
  assert.equal(encryptionAttempts, 1)
  assert.equal(calls.buildLaunch.length, 0)
})

test('an invalid authentication result cannot reach encryption', async () => {
  const { provider, calls } = createHarness({
    authClient: {
      async authenticate() {
        return { token: '', idTransaccion: 'transaction-001' }
      },
    },
  })

  await assert.rejects(
    provider.createIntent(INTENT_INPUT),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_AUTH_RESPONSE_INVALID',
  )

  assert.equal(calls.encryptData.length, 0)
  assert.equal(calls.buildLaunch.length, 0)
})

test('queryStatus reports that real status queries are unsupported', async () => {
  const { provider } = createHarness()

  await assert.rejects(
    provider.queryStatus('transaction-001'),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_STATUS_QUERY_UNSUPPORTED',
  )
})

test('cancelIntent reports that real cancellation is unsupported', async () => {
  const { provider } = createHarness()

  await assert.rejects(
    provider.cancelIntent('transaction-001'),
    (error) =>
      error instanceof TodoPagoPreprodRealProviderError &&
      error.code === 'TODOPAGO_CANCEL_UNSUPPORTED',
  )
})

test('verifyWebhookSignature never considers undocumented webhooks valid', () => {
  const { provider } = createHarness()

  assert.equal(
    provider.verifyWebhookSignature('payload', 'unverified-signature'),
    false,
  )
})

test('provider validation errors do not disclose configured secrets', () => {
  const unsafeConfig = {
    ...CONFIG,
    terminal: '',
  }

  assert.throws(
    () =>
      new TodoPagoPreprodRealProvider({
        config: unsafeConfig,
        authClient: { authenticate: async () => ({}) },
        encryptData: async () => 'encrypted',
        buildLaunch: async () => ({}),
        now: () => new Date(),
      }),
    (error) => {
      const diagnostic = `${error.message}\n${error.stack}`
      assert.equal(diagnostic.includes(CONFIG.password), false)
      assert.equal(diagnostic.includes(CONFIG.gatewayPassword), false)
      assert.equal(diagnostic.includes(CONFIG.encryptionKey), false)
      return error.code === 'TODOPAGO_PROVIDER_CONFIG_INVALID'
    },
  )
})
