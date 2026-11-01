# Webhooks

[English](../en-US/WEBHOOKS.md) · Tiếng Việt

EWharf tách riêng hai loại: endpoint inbound của hệ thống, và thông báo outbound theo từng đơn hàng.

## Inbound endpoints

Endpoint inbound là một danh mục chỉ chứa đường dẫn, được cài sẵn, dùng cho callback của nhà cung cấp và
Telegram. Danh mục này không bao giờ lưu domain triển khai. Trang chi tiết endpoint trong phần quản trị
tự suy ra một URL ví dụ từ Origin hiện tại. Trang này hiển thị các bản ghi nhận đã che thông tin nhạy cảm,
kết quả kiểm tra chữ ký, trạng thái xử lý, thời gian xử lý và mã lỗi an toàn.

Các host triển khai được phép chỉ cần cấu hình một lần tại **Security → Allowed Hosts**.
Middleware toàn cục áp dụng danh sách này cho cả request thông thường lẫn callback.

## Order notification URL

Merchant có thể truyền `notify_url` khi tạo đơn hàng. EWharf kiểm tra
đó phải là URL HTTPS công khai, rồi lưu bất biến cùng với đơn hàng và danh tính
API credential đã tạo đơn hàng đó. Hệ thống không có cấu hình đích callback toàn cục,
và sự kiện của một đơn hàng không bao giờ được phát tới URL của đơn hàng khác.
Hệ thống từ chối các đích sau: private, loopback, link-local, metadata, có chứa thông tin xác thực, và redirect không an toàn.

## Xác minh chữ ký

JSON mà EWharf gửi đi có trường `signature`. Chữ ký này là HMAC-SHA256 dạng chữ thường,
tính trên các trường callback không rỗng đã sắp xếp, với API Secret làm khóa HMAC. Rotate cập nhật ngay trên credential hiện có:
PID và các tham chiếu đơn hàng giữ nguyên, còn mọi lần gửi sau đó và các lần
gửi lại chủ động đều dùng Secret mới. Hãy so sánh chữ ký bằng phép so sánh thời gian hằng số (constant-time), và loại bỏ bản trùng
theo định danh giao dịch hoặc đơn hàng, tùy cách tích hợp của bạn.

Ví dụ xác minh bằng Bun, chạy được ngay, nằm trong
[`MERCHANT_API.md`](./MERCHANT_API.md#ewharf-notifications). Ví dụ này đọc JSON thô
từ stdin, so sánh chữ ký trong thời gian hằng số, và in ra
văn bản thuần `ok` theo yêu cầu. Handler production nên lưu định danh sự kiện/đơn hàng
trước khi xác nhận, để nếu bị gửi lặp lại thì cũng không gây hại.

## Cách gửi và retry

- Chỉ HTTP `200` kèm văn bản thuần `ok` mới tính là thành công.
- Trạng thái gửi và từng lần thử đều được lưu trong D1.
- Thông điệp trong Queue chỉ chứa định danh, không chứa secret.
- Khi thất bại, hệ thống dùng exponential backoff có giới hạn, và dừng ở số lần thử tối đa đã cấu hình.
- Cơ chế phục hồi Outbox đưa vào Queue lại các lượt gửi lần đầu và gửi lại bị kẹt, theo cách idempotent.
- Retry thủ công dùng cùng payload sự kiện, với một lần gửi mới.
- Quản trị viên có thể chủ động gửi lại trạng thái hiện tại của đơn hàng. Thao tác này tạo một
  sự kiện thủ công và một lượt gửi mới, đồng thời giữ nguyên lịch sử các lần gửi thành công trước đó.
- Việc ghi lại response JSON và các bản ghi audit đều bị giới hạn kích thước và che các
  trường nhạy cảm. Nội dung response không phải JSON (opaque) không bao giờ được lưu nguyên văn.

Bảng **Outbound notifications** có hộp thoại chi tiết lượt gửi, hiển thị
payload sự kiện và lịch sử các lần thử, mới nhất xếp trước. Các lần thử mới lưu lại chính xác
phương thức, đích, header, và body hoặc tham số truy vấn của request đã dùng để gửi.
Tuy nhiên, các giá trị dùng để ký được lưu dưới dạng `[REDACTED]`, và credential đã giải mã không bao giờ
được lưu. Nếu snapshot không có hoặc không hợp lệ, giao diện hiển thị là không khả dụng, chứ không
dựng lại từ trạng thái hiện tại vốn có thể đã thay đổi.

Bốn việc sau được commit cùng một lúc: hạch toán thanh toán, chuyển trạng thái đơn hàng, tạo sự kiện Webhook và ghi
Outbox gửi đi. Sự kiện trùng từ chain hoặc nhà cung cấp không thể
tạo ra sự kiện nghiệp vụ hay lượt gửi callback trùng.

## Xác minh production

1. Dùng một máy nhận HTTPS có ghi lại body thô và header.
2. Xác minh một chữ ký hợp lệ, và từ chối các tham số callback đã bị sửa.
3. Trả về `500`, timeout và các response redirect để kiểm tra retry và các
   biện pháp chống SSRF.
4. Phát lại cùng ID sự kiện và kiểm tra việc loại bỏ trùng ở cấp ứng dụng.
5. Phục hồi một consumer Queue đã dừng và xác nhận việc gửi từ Outbox tiếp tục đúng một lần.
