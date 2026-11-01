# Merchant API

[English](../en-US/MERCHANT_API.md) · Tiếng Việt

EWharf là giao thức dành cho merchant. Giao thức gồm: request có chữ ký dùng chung một API credential, dịch vụ
đơn hàng, checkout, bộ xử lý thanh toán và Webhook outbox.

## API credential

Mỗi credential gồm một `pid` dạng số và một API Secret. Secret chỉ hiển thị
một lần, khi credential được tạo hoặc rotate (xoay vòng). Rotate sẽ cập nhật ngay trên credential hiện có:
PID giữ nguyên, và mọi lần gửi sau đó đều dùng Secret mới.
Cấp scope `orders:create` để tạo giao dịch và `orders:read` để truy vấn.
Các scope được kiểm tra độc lập với nhau. Nếu dữ liệu scope đã lưu không hợp lệ, hệ thống từ chối mặc định (fail closed).

## Tạo giao dịch EWharf

Gửi JSON hoặc `application/x-www-form-urlencoded` tới:

```text
POST /payments/ewharf/v1/order/create-transaction
```

Các trường:

- `pid`, `order_id`, `amount`, `notify_url`, `signature`;
- `currency` (tùy chọn, theo ISO 4217). Nếu bỏ trống, hệ thống dùng cài đặt **Đồng tiền mặc định**:
  là USD, trừ khi admin đổi trong Settings → Orders;
- `amount` nhận số JSON dương hoặc chuỗi thập phân như `12.5` hay
  `"12.50"`. Với chuỗi, định dạng được giữ nguyên chính xác. Với số JSON, hệ thống dùng
  giá trị thập phân sau khi parse để ký và quy đổi sang đơn vị nhỏ nhất.
- `token` và `network` (tùy chọn), phải gửi cùng nhau;
- `redirect_url` và `name` (tùy chọn).

Nếu bỏ cả `token` và `network`, hệ thống tạo đơn hàng `pending` cho phép chọn phương thức. Hệ thống
không tự mặc định sang TRON hay USDT. Checkout dùng `payment_url` trả về
để người thanh toán chọn một phương thức nhận tiền đang khả dụng.

Response của create, query và checkout có `status` là số nguyên:
`1` là chờ thanh toán, `2` là đã thanh toán, `3` là đã đóng, và `4` là chờ chọn
phương thức thanh toán. `status_detail` giữ trạng thái chi tiết hơn của EWharf,
như `confirming`, `partially_paid` hoặc `overpaid`.

## Chữ ký HMAC-SHA256 của EWharf

1. Bỏ `signature`.
2. Bỏ các giá trị null và chuỗi rỗng.
3. Đổi số về dạng thập phân thông thường.
4. Sắp xếp tên trường theo thứ tự ASCII tăng dần.
5. Nối các cặp `key=value` bằng `&`, không mã hóa URL.
6. Tính HMAC-SHA256, dùng API Secret làm khóa HMAC.
7. Mã hóa kết quả thành chuỗi hex chữ thường dài 64 ký tự.

Hệ thống chỉ chấp nhận chữ ký khi ranh giới giữa các tham số rõ ràng.
Tên trường được ký phải khớp `[A-Za-z_][A-Za-z0-9_]*`. Giá trị không được chứa
`&` đi kèm một tên trường như vậy rồi đến `=`. Request mơ hồ sẽ bị từ chối xác thực
với `401`. Trường hợp này gồm cả URL callback có nhiều tham số truy vấn `&key=value`.
Thay vào đó, hãy dùng một đường dẫn callback, hoặc một tham số truy vấn duy nhất có giá trị opaque (không mang ý nghĩa).
Ký tự `&` hoặc `=` đứng riêng, không tạo thành mẫu ranh giới trường, vẫn được hỗ trợ.

```ts
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const parameters = {
  pid: "100000000001",
  order_id: "invoice-1001",
  currency: "USD",
  amount: "12.50",
  notify_url: "https://merchant.example/notify",
};
const source = Object.entries(parameters)
  .filter(([, value]) => value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value))) {
      throw new Error("ambiguous signature parameters");
    }
    return `${key}=${value}`;
  })
  .join("&");
const signature = bytesToHex(
  hmac(
    sha256,
    utf8ToBytes(process.env.EWHARF_API_SECRET ?? ""),
    utf8ToBytes(source),
  ),
);
```

Lưu đoạn mã trên thành `sign.ts`, đặt `EWHARF_API_SECRET`, rồi chạy bằng
`bun sign.ts`. Sau đó bạn có thể gửi một request hoàn chỉnh mà không cần SDK:

```bash
curl --fail-with-body \
  -H 'content-type: application/json' \
  --data '{"pid":"100000000001","order_id":"invoice-1001","currency":"USD","amount":"12.50","notify_url":"https://merchant.example/notify","signature":"<lowercase-hmac-sha256>"}' \
  https://pay.example.com/payments/ewharf/v1/order/create-transaction
```

Bản triển khai chuẩn và các vector kiểm thử nằm trong
`src/features/api-keys/server/ewharf-signature.ts` và
`tests/unit/auth/ewharf-signature.test.ts`.

## Truy vấn đơn hàng EWharf

Truy vấn đơn hàng do chính API credential này tạo, và chỉ dùng đúng một trường để chọn đơn:

```text
GET /payments/ewharf/v1/order/query?pid=100000000001&trade_id=<trade-id>&signature=<lowercase-hmac-sha256>
```

Nếu muốn truy vấn theo ID đơn hàng bên ngoài, hãy dùng `order_id` thay cho `trade_id`.
Chữ ký dùng cùng các trường truy vấn không rỗng đã sắp xếp và cùng secret như khi
tạo đơn hàng. Một credential chỉ truy vấn được các đơn hàng do chính credential đó tạo.

## EWharf notifications

EWharf gửi POST JSON tới `notify_url` của đơn hàng, và URL này không thể thay đổi. Payload dùng
status dạng số nguyên (`1` chờ thanh toán, `2` đã thanh toán, `3` đã đóng). Payload chứa `pid`, `trade_id`,
`order_id`, số tiền đơn hàng và số tiền thanh toán, đích nhận, token, ID giao dịch, status và
`signature`. Hãy xác minh bằng cùng thuật toán HMAC-SHA256 trên các tham số đã sắp xếp, rồi trả về
văn bản thuần `ok` kèm HTTP 200. Mọi response khác đều bị gửi lại (retry).
Hãy lưu định danh đơn hàng/sự kiện trước khi trả về `ok`. Lý do là các lần retry tự động và
thủ công có thể gửi cùng một status nhiều lần.

Status, số tiền đơn hàng, số tiền tài sản phải trả và mã tài sản lấy từ snapshot
sự kiện đã lưu, không lấy từ trạng thái sau này của đơn hàng. Giả sử bạn retry một sự kiện thanh toán một phần
sau khi đơn đã được thanh toán đủ. Sự kiện đó vẫn báo status chờ thanh toán ban đầu. `actual_amount`
vẫn là số tiền tài sản phải trả, không phải tổng tiền đã nhận. Trường nội bộ
`payment.receivedAmountUnits` của sự kiện ghi tổng tiền đã nhận tại thời điểm xảy ra sự kiện.
Rotate credential có thể làm đổi chữ ký, nhưng không đổi dữ liệu nghiệp vụ của sự kiện.

Bun handler dưới đây xác minh một payload JSON nhận được, theo đúng quy tắc
chuẩn hóa (canonicalization) ở trên:

```ts
import { timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const payload = await Bun.stdin.json() as Record<string, string | number>;
const received = String(payload.signature ?? "");
const source = Object.entries(payload)
  .filter(([key, value]) => key !== "signature" && value != null && value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value))) {
      throw new Error("ambiguous signature parameters");
    }
    return `${key}=${value}`;
  })
  .join("&");
const expected = bytesToHex(hmac(
  sha256,
  utf8ToBytes(process.env.EWHARF_API_SECRET ?? ""),
  utf8ToBytes(source),
));
const valid = received.length === expected.length && timingSafeEqual(
  Buffer.from(received),
  Buffer.from(expected),
);
if (!valid) throw new Error("invalid signature");
process.stdout.write("ok");
```

## Lỗi và idempotency

Response dùng các trường `status_code`, `message`, `data` và `request_id`. ID đơn hàng
bên ngoài là duy nhất trong phạm vi API credential đã tạo ra nó. Nếu gửi lại ID đó với
cùng credential, hệ thống không tạo đơn hàng thứ hai. Còn các credential độc lập thì có thể
dùng cách đánh số đơn riêng. Hệ thống kiểm tra API scope và giới hạn tốc độ D1
trước khi tạo đơn hàng.

| `status_code` | Ý nghĩa |
| --- | --- |
| `10002` | ID đơn hàng bên ngoài đã tồn tại |
| `10003` | Phương thức nhận tiền được yêu cầu không khả dụng |
| `10004` | Số tiền không hợp lệ |
| `10009` | Tham số request không hợp lệ |
| `10016` | Tài sản/mạng được yêu cầu không khả dụng |
| `401` | Xác minh PID, scope hoặc chữ ký thất bại |
| `429` | Vượt quá giới hạn tốc độ của API credential |
| `500` | Lỗi gateway ngoài dự kiến; dùng `request_id` khi điều tra |

Khi gặp timeout, hãy coi như chưa biết kết quả. Hãy kiểm tra kết quả bạn đã lưu trong hệ thống của mình
trước khi chọn một ID đơn hàng bên ngoài mới. Retry cùng `order_id` là an toàn và không tạo đơn trùng,
vì ràng buộc unique của cơ sở dữ liệu là căn cứ cuối cùng. Tuy nhiên, hệ thống sẽ trả về `10002`,
chứ không âm thầm tạo hay thay thế đơn hàng.

Hợp đồng chuẩn là [`public/openapi.yaml`](../../public/openapi.yaml)
và được hiển thị tại `/docs`.
