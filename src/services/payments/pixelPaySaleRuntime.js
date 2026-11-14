const SALE_ROUTE = "api/v2/transaction/sale";
const EXECUTION_PHASES = new Set(["request_construction", "sdk_preparation", "sale_transport", "response_processing"]);
const RUNTIME_CODES = new Set([
  "SDK_REFERENCE_ERROR", "SDK_RUNTIME_ERROR", "SDK_NETWORK_ERROR", "SDK_HTTP_TIMEOUT",
  "SDK_RESPONSE_PARSE_ERROR", "SDK_BROWSER_ACTION_REQUIRED", "SDK_UPSTREAM_ERROR",
]);
const ERROR_NAMES = new Set([
  "Error", "ReferenceError", "TypeError", "SyntaxError", "RangeError", "EvalError", "URIError",
  "AggregateError", "AxiosError", "AbortError", "InvalidCredentialsException",
  "FailedEncryptionException", "InvalidTransactionTypeException", "RunningTransactionException",
  "PixelPayBrowserActionRequiredError",
]);
const REFERENCE_SYMBOLS = new Set(["document", "window", "DOMParser", "navigator", "atob", "Cardinal"]);
const SDK_FILES = new Set([
  "lib/base/Helpers.js", "lib/base/ServiceBehaviour.js", "lib/base/RequestBehaviour.js", "lib/base/Response.js",
  "lib/services/Transaction.js", "lib/services/CardinalAuthentication.js",
  "lib/requests/PaymentTransaction.js", "lib/requests/SaleTransaction.js",
  "lib/requests/LookupTransaction.js", "lib/requests/LookupContinueTransaction.js",
  "lib/libraries/CardinalManager.js", "lib/libraries/CybersourceManager.js",
  "lib/libraries/PayloadManager.js", "lib/libraries/PixelPayLoading.js",
  "lib/libraries/PixelPayModal.js", "lib/libraries/RouterManager.js",
]);
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ECONNABORTED"]);

const safeBoolean = value => typeof value === "boolean" ? value : null;
const safePosition = value => Number.isInteger(value) && value > 0 && value <= 9999999 ? value : null;
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const safeName = value => ERROR_NAMES.has(value) ? value : null;

export function sanitizePixelPaySaleRuntimeDiagnostics(source = {}) {
  const input = source && typeof source === "object" ? source : {};
  const sdkStackFile = SDK_FILES.has(input.sdkStackFile) ? input.sdkStackFile : null;
  return {
    executionPhase: EXECUTION_PHASES.has(input.executionPhase) ? input.executionPhase : null,
    httpResponseReceived: safeBoolean(input.httpResponseReceived),
    requestMayHaveBeenSent: safeBoolean(input.requestMayHaveBeenSent),
    statusCode: safeStatus(input.statusCode),
    sdkStackFile,
    sdkStackLine: sdkStackFile ? safePosition(input.sdkStackLine) : null,
    sdkStackColumn: sdkStackFile ? safePosition(input.sdkStackColumn) : null,
    referenceSymbol: REFERENCE_SYMBOLS.has(input.referenceSymbol) ? input.referenceSymbol : null,
    safeMessageCode: RUNTIME_CODES.has(input.safeMessageCode) ? input.safeMessageCode : null,
    errorName: safeName(input.errorName),
    errorConstructorName: safeName(input.errorConstructorName),
    sdkErrorName: safeName(input.sdkErrorName),
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

export class PixelPayBrowserActionRequiredError extends Error {
  constructor() {
    super("PixelPay requires a browser action that cannot execute in this backend.");
    this.name = "PixelPayBrowserActionRequiredError";
    this.code = "SDK_BROWSER_ACTION_REQUIRED";
    this.statusCode = 202;
    this.responseClass = "PayloadResponse";
  }
}

export function classifyPixelPaySaleRuntimeError(error, execution = {}) {
  const errorName = safeName(error?.name);
  const errorConstructorName = safeName(error?.constructor?.name);
  const context = sanitizePixelPaySaleRuntimeDiagnostics(execution);
  let safeMessageCode = "SDK_RUNTIME_ERROR";
  if (error instanceof PixelPayBrowserActionRequiredError) {
    safeMessageCode = "SDK_BROWSER_ACTION_REQUIRED";
  } else if (errorName === "ReferenceError" || errorConstructorName === "ReferenceError") {
    safeMessageCode = "SDK_REFERENCE_ERROR";
  } else if ((errorName === "SyntaxError" || errorConstructorName === "SyntaxError")
    && context.httpResponseReceived === true) {
    safeMessageCode = "SDK_RESPONSE_PARSE_ERROR";
  } else if (TIMEOUT_CODES.has(error?.code) || error?.message === "timeout of 60000ms exceeded") {
    safeMessageCode = "SDK_HTTP_TIMEOUT";
  } else if (NETWORK_CODES.has(error?.code) || error?.message === "Network Error") {
    safeMessageCode = "SDK_NETWORK_ERROR";
  } else if (context.httpResponseReceived === true && context.statusCode === 408) {
    safeMessageCode = "SDK_HTTP_TIMEOUT";
  } else if (!error && context.httpResponseReceived === true && context.statusCode >= 400) {
    safeMessageCode = "SDK_UPSTREAM_ERROR";
  }
  const reference = safeMessageCode === "SDK_REFERENCE_ERROR" && typeof error?.message === "string"
    ? /^(document|window|DOMParser|navigator|atob|Cardinal) is not defined$/.exec(error.message)?.[1]
    : null;
  return sanitizePixelPaySaleRuntimeDiagnostics({
    ...context, ...sdkFrame(error), referenceSymbol: reference, safeMessageCode,
    errorName, errorConstructorName, sdkErrorName: errorConstructorName,
  });
}

export function createPixelPayNodeSaleTransaction(sdk, settings) {
  class NodeSaleTransaction extends sdk.Services.Transaction {
    constructor(configuration) {
      super(configuration);
      this.saleActive = false;
      this.saleResponsePending = false;
      this.saleExecution = {
        executionPhase: "sdk_preparation", httpResponseReceived: false,
        requestMayHaveBeenSent: false, statusCode: null,
      };
    }

    getSaleExecutionDiagnostics() {
      const safe = sanitizePixelPaySaleRuntimeDiagnostics(this.saleExecution);
      return {
        executionPhase: safe.executionPhase, httpResponseReceived: safe.httpResponseReceived,
        requestMayHaveBeenSent: safe.requestMayHaveBeenSent, statusCode: safe.statusCode,
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
      if (this.saleActive && url === SALE_ROUTE) {
        // AM: El public_key del SDK no prueba que se envio Sale ni que se recibio su respuesta.
        transport.interceptors.request.use(config => {
          this.saleExecution.executionPhase = "sale_transport";
          this.saleExecution.requestMayHaveBeenSent = true;
          return config;
        });
        const received = response => {
          this.saleExecution.executionPhase = "response_processing";
          this.saleExecution.httpResponseReceived = true;
          this.saleExecution.statusCode = safeStatus(response?.status);
          this.saleResponsePending = true;
        };
        transport.interceptors.response.use(response => {
          received(response);
          return response;
        }, error => {
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
      // AM: Contener el 202 antes de DOM/3DS/router; nunca ejecutar otra Sale ni convertirlo en aprobacion.
      if (saleResponse && status === 202) throw new PixelPayBrowserActionRequiredError();
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
