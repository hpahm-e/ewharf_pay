# Provider response fixtures

These sanitized fixtures preserve the response shapes consumed by EWharf without containing real account identifiers or credentials. Field names and nesting are based on the provider API contracts used by the adapters:

- Binance Pay transaction history: <https://developers.binance.com/docs/binance-pay/api-order-query>
- OKX funding bills: <https://www.okx.com/docs-v5/en/#funding-account-rest-api-get-bills-details>
- SePay bank transfer integration: the [official SePay API v2](https://developer.sepay.vn/vi/sepay-api/v2/gioi-thieu) transaction list/detail contract and [webhook guide](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook) (API key or HMAC-SHA256 authentication)

Pagination tests generate additional rows around these canonical shapes. Live compatibility is checked separately by the opt-in smoke suite and never by default CI.

Chain fixtures under `tests/fixtures/chains` follow the corresponding official RPC/indexer response contracts. The TRON event fixture intentionally uses the 32-byte TVM event address form to verify the required `41` prefix and Base58Check conversion, and preserves the provider `event_index` for transaction-event uniqueness.
