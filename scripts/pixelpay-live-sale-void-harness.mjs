export async function runPixelPayLiveSaleVoidHarness({
  provider,
  saleInput,
  authorizedEmail,
  voidReason = "MasterFade controlled live validation",
} = {}) {
  if (!provider || provider.env !== "live") throw new Error("PIXELPAY_LIVE_PROVIDER_REQUIRED");
  if (Number(saleInput?.amount) !== 1) throw new Error("PIXELPAY_LIVE_HARNESS_AMOUNT_MUST_BE_1");
  const sale = await provider.sale(saleInput);
  if (sale?.approved !== true || !sale?.paymentUuid) {
    throw new Error("PIXELPAY_LIVE_HARNESS_SALE_NOT_APPROVED");
  }
  const voidResponse = await provider.voidPayment({
    paymentUuid: sale.paymentUuid,
    orderId: saleInput.orderId,
    authorizedEmail,
    reason: voidReason,
  });
  return { sale, voidResponse };
}
