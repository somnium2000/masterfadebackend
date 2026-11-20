import { sanitizeQa3dsObservation } from './qaPixelPay3dsDiagnostic.js';
const SALE_ROUTE = "api/v2/transaction/sale";
const PUBLIC_KEY_ROUTE = 'api/v2/merchant/public_key';
const EXECUTION_PHASES = new Set(["request_construction", "sdk_preparation", "sale_transport", "response_processing"]);
const RUNTIME_CODES = new Set([
  "SDK_REFERENCE_ERROR", "SDK_RUNTIME_ERROR", "SDK_NETWORK_ERROR", "SDK_HTTP_TIMEOUT",
  "SDK_RESPONSE_PARSE_ERROR", "SDK_BROWSER_ACTION_REQUIRED", "SDK_CONTINUATION_REQUIRED", "SDK_UPSTREAM_ERROR",
  "SDK_DNS_ERROR", "SDK_TLS_ERROR", "SDK_WAF_CHALLENGE",
]);
const ERROR_NAMES = new Set([
  "Error", "ReferenceError", "TypeError", "SyntaxError", "RangeError", "EvalError", "URIError",
  "AggregateError", "AxiosError", "AbortError", "InvalidCredentialsException",
  "FailedEncryptionException", "InvalidTransactionTypeException", "RunningTransactionException",
  "PixelPayContinuationRequiredError",
]);
const REFERENCE_SYMBOLS = new Set(["document", "window", "DOMParser", "navigator", "atob", "Cardinal"]);
const CONTINUATION_TYPES = new Set(["payload", "songbird", "router"]);
const SDK_FILES = new Set([
  "lib/base/Helpers.js", "lib/base/ServiceBehaviour.js", "lib/base/RequestBehaviour.js", "lib/base/Response.js",
  "lib/services/Transaction.js", "lib/services/CardinalAuthentication.js",
  "lib/requests/PaymentTransaction.js", "lib/requests/SaleTransaction.js",
  "lib/requests/LookupTransaction.js", "lib/requests/LookupContinueTransaction.js",
  "lib/libraries/CardinalManager.js", "lib/libraries/CybersourceManager.js",
  "lib/libraries/PayloadManager.js", "lib/libraries/PixelPayLoading.js",
  "lib/libraries/PixelPayModal.js", "lib/libraries/RouterManager.js",
]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ECONNABORTED"]);
const TLS_CODES = new Set([
  "EPROTO", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
]);
const TRANSPORT_CODES = new Set([...DNS_CODES, ...NETWORK_CODES, ...TIMEOUT_CODES, ...TLS_CODES]);
const CONTENT_TYPES = new Set(["application/json", "text/html", "text/plain", "application/octet-stream"]);

const safeBoolean = value => typeof value === "boolean" ? value : null;
const safePosition = value => Number.isInteger(value) && value > 0 && value <= 9999999 ? value : null;
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const safeName = value => ERROR_NAMES.has(value) ? value : null;
const safeContinuationType = value => CONTINUATION_TYPES.has(value) ? value : null;
const safeTransportCode = value => TRANSPORT_CODES.has(value) ? value : null;
const safeContentType = value => {
  const type = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : null;
  return CONTENT_TYPES.has(type) ? type : null;
};
const safeCfRay = value => typeof value === "string" && /^[a-fA-F0-9]{16,32}-[A-Z]{3}$/.test(value) ? value : null;

function safeHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && /^[a-z0-9.-]{1,253}$/.test(url.hostname)) {
      return url.origin;
    }
  } catch { /* AM: URL parse exceptions may contain the original value. */ }
  return null;
}

const CONTINUATION_FIELDS = ['collection_url', 'payload', 'transaction_type'];
// AM: Keep field presence distinct from null and empty string at each boundary.
function describeContinuationField(container, field) {
  const present = container != null && Object.hasOwn(container, field);
  const value = present ? container[field] : undefined;
  const type = !present ? 'absent' : value === null ? 'null' : value === '' ? 'empty_string'
    : Array.isArray(value) ? 'array' : typeof value;
  return { present, type, length: typeof value === 'string' ? value.length : null,
    ...(field === 'collection_url' ? { origin: safeHttpsOrigin(value) } : {}) };
}

function inspectContinuationData(data) {
  return {
    ...Object.fromEntries(CONTINUATION_FIELDS.map(field => [field, describeContinuationField(data, field)])),
    transaction_type_kind: safeContinuationType(data?.transaction_type),
  };
}

export function comparePixelPayContinuationFields(left, right) {
  return Object.fromEntries(CONTINUATION_FIELDS.map(field => {
    const leftPresent = left != null && Object.hasOwn(left, field);
    const rightPresent = right != null && Object.hasOwn(right, field);
    return [field, leftPresent === rightPresent && (!leftPresent || Object.is(left[field], right[field]))];
  }));
}

// AM: Public diagnostics allow only field shape; provider bodies and opaque values cannot reach the log sink.
export function sanitizePixelPayContinuationDiagnostic(source = {}) {
  const codes = new Set(['PIXELPAY_3DS_COLLECTION_URL_ABSENT', 'PIXELPAY_3DS_COLLECTION_URL_NULL',
    'PIXELPAY_3DS_COLLECTION_URL_EMPTY', 'PIXELPAY_3DS_COLLECTION_URL_INVALID',
    'PIXELPAY_3DS_CONTINUATION_INVALID', 'PIXELPAY_3DS_COLLECTION_READY']);
  const types = new Set(['absent', 'null', 'empty_string', 'array', 'string', 'object', 'number', 'boolean', 'undefined']);
  const field = (value, name) => ({ present: safeBoolean(value?.present),
    type: types.has(value?.type) ? value.type : null,
    length: Number.isSafeInteger(value?.length) && value.length >= 0 ? value.length : null,
    ...(name === 'collection_url' ? { origin: safeHttpsOrigin(value?.origin) } : {}) });
  const data = value => ({ ...Object.fromEntries(CONTINUATION_FIELDS.map(name => [name, field(value?.[name], name)])),
    transaction_type_kind: safeContinuationType(value?.transaction_type_kind) });
  const comparison = value => value == null ? null
    : Object.fromEntries(CONTINUATION_FIELDS.map(name => [name, safeBoolean(value[name])]));
  return {
    code: codes.has(source?.code) ? source.code : null,
    upstream_http_status: safeStatus(source?.upstream_http_status),
    upstream_cf_ray: safeCfRay(source?.upstream_cf_ray), sale_origin: safeHttpsOrigin(source?.sale_origin),
    sale_environment: ['sandbox', 'staging', 'live'].includes(source?.sale_environment) ? source.sale_environment : null,
    raw_top_level_collection_url: field(source?.raw_top_level_collection_url, 'collection_url'),
    raw_data: data(source?.raw_data), sdk_data: data(source?.sdk_data),
    raw_to_sdk_equal: comparison(source?.raw_to_sdk_equal), sdk_to_handoff_equal: comparison(source?.sdk_to_handoff_equal),
  };
}

export function sanitizePixelPaySaleRuntimeDiagnostics(source = {}) {
  const input = source && typeof source === "object" ? source : {};
  const sdkStackFile = SDK_FILES.has(input.sdkStackFile) ? input.sdkStackFile : null;
  return {
    executionPhase: EXECUTION_PHASES.has(input.executionPhase) ? input.executionPhase : null,
    httpResponseReceived: safeBoolean(input.httpResponseReceived),
    requestMayHaveBeenSent: safeBoolean(input.requestMayHaveBeenSent),
    statusCode: safeStatus(input.statusCode),
    sdkTransactionType: safeContinuationType(input.sdkTransactionType),
    transportErrorCode: safeTransportCode(input.transportErrorCode),
    wafChallenge: safeBoolean(input.wafChallenge),
    upstreamContentType: safeContentType(input.upstreamContentType),
    cfRay: safeCfRay(input.cfRay),
    sdkStackFile,
    sdkStackLine: sdkStackFile ? safePosition(input.sdkStackLine) : null,
    sdkStackColumn: sdkStackFile ? safePosition(input.sdkStackColumn) : null,
    referenceSymbol: REFERENCE_SYMBOLS.has(input.referenceSymbol) ? input.referenceSymbol : null,
    safeMessageCode: RUNTIME_CODES.has(input.safeMessageCode) ? input.safeMessageCode : null,
    errorName: safeName(input.errorName),
    errorConstructorName: safeName(input.errorConstructorName),
    sdkErrorName: safeName(input.sdkErrorName),
    ...(input.qa3dsObservation ? { qa3dsObservation: sanitizeQa3dsObservation(input.qa3dsObservation) } : {}),
  };
}

function sdkFrame(error) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  for (const line of stack.split(/\r?\n/).slice(1, 40)) {
    const match = line.replaceAll("\\", "/").match(
      /\/node_modules\/@pixelpay\/sdk-core\/(lib\/(?:base|libraries|services|requests)\/[A-Za-z][A-Za-z0-9]*\.js):([1-9]\d{0,6}):([1-9]\d{0,6})(?=[)\s]|$)/
    );
    if (match && SDK_FILES.has(match[1])) return {
      sdkStackFile: match[1], sdkStackLine: Number(match[2]), sdkStackColumn: Number(match[3]),
    };
  }
  return {};
}

export class PixelPayContinuationRequiredError extends Error {
  constructor(transactionType) {
    super("PixelPay returned a continuation that this backend cannot resolve automatically.");
    this.name = "PixelPayContinuationRequiredError";
    this.sdkTransactionType = safeContinuationType(transactionType);
    this.statusCode = 202;
    this.responseClass = "PayloadResponse";
  }
}

export function classifyPixelPaySaleRuntimeError(error, execution = {}) {
  const errorName = safeName(error?.name);
  const errorConstructorName = safeName(error?.constructor?.name);
  const context = sanitizePixelPaySaleRuntimeDiagnostics(execution);
  let safeMessageCode = "SDK_RUNTIME_ERROR";
  if (error instanceof PixelPayContinuationRequiredError) {
    context.sdkTransactionType = error.sdkTransactionType;
    safeMessageCode = ["payload", "songbird"].includes(error.sdkTransactionType)
      ? "SDK_BROWSER_ACTION_REQUIRED" : "SDK_CONTINUATION_REQUIRED";
  } else if (errorName === "ReferenceError" || errorConstructorName === "ReferenceError") {
    safeMessageCode = "SDK_REFERENCE_ERROR";
  } else if ((errorName === "SyntaxError" || errorConstructorName === "SyntaxError")
    && context.httpResponseReceived === true) {
    safeMessageCode = "SDK_RESPONSE_PARSE_ERROR";
  } else if (TIMEOUT_CODES.has(error?.code) || error?.message === "timeout of 60000ms exceeded") {
    safeMessageCode = "SDK_HTTP_TIMEOUT";
  } else if (DNS_CODES.has(error?.code)) {
    safeMessageCode = "SDK_DNS_ERROR";
  } else if (TLS_CODES.has(error?.code)) {
    safeMessageCode = "SDK_TLS_ERROR";
  } else if (NETWORK_CODES.has(error?.code) || error?.message === "Network Error") {
    safeMessageCode = "SDK_NETWORK_ERROR";
  } else if (context.httpResponseReceived === true && context.statusCode === 408) {
    safeMessageCode = "SDK_HTTP_TIMEOUT";
  } else if (!error && context.httpResponseReceived === true && context.statusCode >= 400) {
    safeMessageCode = context.statusCode === 403 && context.wafChallenge === true
      ? "SDK_WAF_CHALLENGE" : "SDK_UPSTREAM_ERROR";
  }
  const reference = safeMessageCode === "SDK_REFERENCE_ERROR" && typeof error?.message === "string"
    ? /^(document|window|DOMParser|navigator|atob|Cardinal) is not defined$/.exec(error.message)?.[1]
    : null;
  return sanitizePixelPaySaleRuntimeDiagnostics({
    ...context, ...sdkFrame(error), referenceSymbol: reference, safeMessageCode,
    transportErrorCode: safeTransportCode(error?.code) ?? context.transportErrorCode,
    errorName, errorConstructorName, sdkErrorName: errorConstructorName,
  });
}

export function createPixelPayNodeSaleTransaction(sdk, settings, { qa3dsDiagnostic = false, onSongbirdPayload, onContinuation } = {}) {
  class NodeSaleTransaction extends sdk.Services.Transaction {
    constructor(configuration) {
      super(configuration);
      this.saleActive = false;
      this.saleResponsePending = false;
      this.qa3dsObservation = qa3dsDiagnostic === true ? {
        public_key_request_attempted: false, public_key_response_received: false, public_key_http_status: null,
        public_key_obtained: false, encryption_completed: false, stopped_before_continuation: false,
        transaction_type: 'absent', continuation_required: false, opaque_payload_present: false,
      } : null;
      this.saleExecution = {
        executionPhase: "sdk_preparation", httpResponseReceived: false,
        requestMayHaveBeenSent: false, statusCode: null,
      };
    }

    getSaleExecutionDiagnostics() {
      if (this.qa3dsObservation) {
        this.qa3dsObservation.public_key_obtained = Boolean(this.settings.public_key);
        this.qa3dsObservation.encryption_completed = Boolean(this.sdk_public_key);
      }
      const safe = sanitizePixelPaySaleRuntimeDiagnostics(this.saleExecution);
      return {
        executionPhase: safe.executionPhase, httpResponseReceived: safe.httpResponseReceived,
        requestMayHaveBeenSent: safe.requestMayHaveBeenSent, statusCode: safe.statusCode,
        sdkTransactionType: safe.sdkTransactionType,
        transportErrorCode: safe.transportErrorCode, wafChallenge: safe.wafChallenge,
        upstreamContentType: safe.upstreamContentType, cfRay: safe.cfRay,
        ...(this.qa3dsObservation ? { qa3dsObservation: sanitizeQa3dsObservation(this.qa3dsObservation) } : {}),
      };
    }

    async doSale(transaction) {
      this.saleActive = true;
      this.saleResponsePending = false;
      this.saleExecution = {
        executionPhase: "sdk_preparation", httpResponseReceived: false,
        requestMayHaveBeenSent: false, statusCode: null,
      };
      try {
        return await super.doSale(transaction);
      } finally {
        this.saleActive = false;
        this.saleResponsePending = false;
      }
    }

    buildRequest(url, transaction) {
      const transport = super.buildRequest(url, transaction);
      if (this.saleActive && this.qa3dsObservation && url === PUBLIC_KEY_ROUTE) {
        transport.interceptors.request.use(config => { this.qa3dsObservation.public_key_request_attempted = true; return config; });
        const received = response => {
          this.qa3dsObservation.public_key_response_received = true;
          this.qa3dsObservation.public_key_http_status = safeStatus(response?.status);
        };
        transport.interceptors.response.use(response => { received(response); return response; }, error => {
          if (error?.response) received(error.response);
          throw error;
        });
      }
      if (this.saleActive && url === SALE_ROUTE) {
        if (this.qa3dsObservation) {
          // AM: Observe presence only after the SDK completes its native encryption path.
          this.qa3dsObservation.public_key_obtained = Boolean(this.settings.public_key);
          this.qa3dsObservation.encryption_completed = Boolean(this.sdk_public_key);
        }
        // AM: El public_key del SDK no prueba que se envio Sale ni que se recibio su respuesta.
        transport.interceptors.request.use(config => {
          this.saleExecution.executionPhase = "sale_transport";
          this.saleExecution.requestMayHaveBeenSent = true;
          if (typeof onContinuation === 'function') this.saleExecution.saleOrigin = safeHttpsOrigin(config.baseURL);
          return config;
        });
        const received = response => {
          this.saleExecution.executionPhase = "response_processing";
          this.saleExecution.httpResponseReceived = true;
          this.saleExecution.statusCode = safeStatus(response?.status);
          if (this.qa3dsObservation) this.qa3dsObservation.upstream_http_status = safeStatus(response?.status);
          // AM: Conservar solo evidencia de cabeceras permitidas antes de que el SDK las descarte.
          const headers = response?.headers;
          const header = name => typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
          this.saleExecution.upstreamContentType = safeContentType(header("content-type"));
          this.saleExecution.cfRay = safeCfRay(header("cf-ray"));
          this.saleExecution.wafChallenge = header("cf-mitigated") === "challenge";
          this.saleResponsePending = true;
        };
        transport.interceptors.response.use(response => {
          received(response);
          return response;
        }, error => {
          this.saleExecution.transportErrorCode = safeTransportCode(error?.code);
          if (error?.response) received(error.response);
          throw error;
        });
      }
      return transport;
    }

    parseResponse(data, status) {
      const saleResponse = this.saleActive && this.saleResponsePending;
      this.saleResponsePending = false;
      const response = super.parseResponse(data, status);
      if (saleResponse && this.qa3dsObservation) {
        const type = response?.data?.transaction_type;
        this.qa3dsObservation.response_class = response?.constructor?.name;
        this.qa3dsObservation.transaction_type = CONTINUATION_TYPES.has(type) ? type : type == null ? 'absent' : 'other';
        this.qa3dsObservation.opaque_payload_present = typeof response?.data?.payload === 'string' && response.data.payload.length > 0;
        this.qa3dsObservation.continuation_required = status === 202 ? (CONTINUATION_TYPES.has(type) ? true : null) : false;
        this.qa3dsObservation.stopped_before_continuation = status === 202;
      }
      // AM: Contener el 202 antes de DOM/3DS/router; nunca ejecutar otra Sale ni convertirlo en aprobacion.
      if (saleResponse && status === 202) {
        this.saleExecution.sdkTransactionType = safeContinuationType(response?.data?.transaction_type);
        // AM: Opt-in application transport captures the native response; default containment remains intact.
        if (typeof onContinuation === 'function') onContinuation(response, {
          upstream_http_status: safeStatus(this.saleExecution.statusCode),
          upstream_cf_ray: this.saleExecution.cfRay ?? null,
          sale_origin: this.saleExecution.saleOrigin ?? null,
          sale_environment: ['sandbox', 'staging', 'live'].includes(this.settings.environment) ? this.settings.environment : null,
          raw_top_level_collection_url: describeContinuationField(data, 'collection_url'),
          raw_data: inspectContinuationData(data?.data),
          sdk_data: inspectContinuationData(response?.data),
          raw_to_sdk_equal: comparePixelPayContinuationFields(data?.data, response?.data),
        });
        // AM: Transient server-only handoff sink; never attach opaque data to errors or diagnostics.
        if (qa3dsDiagnostic && response?.data?.transaction_type === 'songbird' && typeof onSongbirdPayload === 'function') {
          onSongbirdPayload(response?.data?.payload, { collectionUrl: response?.data?.collection_url ?? null });
        }
        throw new PixelPayContinuationRequiredError(this.saleExecution.sdkTransactionType);
      }
      return response;
    }

    exceptionResponse(error) {
      // AM: Preservar la causa y fase originales; el SDK la reemplazaria por una respuesta 520.
      if (this.saleActive) throw error;
      return super.exceptionResponse(error);
    }
  }
  return new NodeSaleTransaction(settings);
}
