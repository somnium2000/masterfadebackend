// AM: Official sale example; synthetic fixture inputs only. No transport/SDK methods are replaced here.
export function buildOfficialSale(sdk, { authentication = false, credentials = true, sandbox = false } = {}) {
  const settings = new sdk.Models.Settings();
  if (sandbox) settings.setupSandbox();
  else {
    settings.setupEndpoint('https://offline-pixelpay.invalid');
    if (credentials) settings.setupCredentials('synthetic-merchant-key', 'synthetic-reusable-hash');
  }
  settings.setupHeaders({ 'x-client-signature': 'synthetic-order-signature' });
  const card = new sdk.Models.Card();
  card.number = '4111111111111111'; card.cvv2 = '999';
  card.expire_month = 7; card.expire_year = 2028; card.cardholder = 'Synthetic fixture';
  const billing = new sdk.Models.Billing();
  billing.address = 'Synthetic address'; billing.country = 'HN'; billing.state = 'HN-CR';
  billing.city = 'San Pedro Sula'; billing.phone = '99999999';
  const item = new sdk.Models.Item();
  item.code = '00001'; item.title = 'Synthetic item'; item.price = 1; item.qty = 1;
  const order = new sdk.Models.Order();
  order.id = 'SYNTHETIC-OFFICIAL-ORDER'; order.currency = 'HNL';
  order.customer_name = 'Synthetic fixture'; order.customer_email = 'fixture@example.invalid'; order.addItem(item);
  const sale = new sdk.Requests.SaleTransaction();
  if (authentication) sale.withAuthenticationRequest();
  sale.setOrder(order); sale.setCard(card); sale.setBilling(billing);
  return { settings, order, sale, service: new sdk.Services.Transaction(settings) };
}
