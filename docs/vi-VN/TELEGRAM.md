# Tích hợp Telegram

[English](../en-US/TELEGRAM.md) · Tiếng Việt

EWharf dùng grammY để quản lý nhiều Telegram Bot. Các bot này phục vụ đặt hàng qua Inline, tra cứu đơn hàng, kiểm tra thanh toán, thông báo vận hành và các lệnh có thể cấu hình. Bot là các kết nối nền tảng. Lệnh áp dụng cho toàn instance, còn subscription thông báo thì thuộc về một Bot cụ thể.

## Cấu hình Bot

1. Tạo Bot bằng BotFather và bật Inline Mode.
2. Thêm Token của Bot tại **Admin → Telegram → Bots**. EWharf xác minh Token bằng `getMe`, tạo Webhook Secret riêng cho từng Bot và đăng ký `/api/telegram/:botId/webhook`.
3. Request gửi đến phải qua bước xác minh `X-Telegram-Bot-Api-Secret-Token`.
4. Token và Webhook Secret được mã hóa. API danh sách không bao giờ trả chúng về, và payload audit cũng không bao giờ chứa chúng.

Webhook nhận các update `message`, `inline_query`, `chosen_inline_result`, `callback_query` và `my_chat_member`.

## Subscription thông báo và quyền truy cập Telegram

Khi người dùng gửi `/start` trong chat riêng, hệ thống tạo một subscription thông báo `private` ở trạng thái tắt, theo cách idempotent. Hệ thống tự động ghi lại Telegram User ID, username, tên hiển thị và locale để quản trị viên xem xét.

Khi một Bot tham gia nhóm, supergroup hoặc kênh, `my_chat_member` tự động tạo một subscription ở trạng thái tắt. Supergroup được chuẩn hóa thành `group`. Nếu Bot bị gỡ hoặc bị đuổi, subscription sẽ bị tắt. Nếu Bot tham gia lại, subscription không bao giờ tự bật lại.

Quản trị viên cũng có thể tạo subscription thủ công. Khi đó họ nhập tên, Bot, loại đích, ID đích, locale, các sự kiện và nội dung cho sáu locale.

Mỗi subscription chỉ có một công tắc bật/tắt:

- subscription private điều khiển cùng lúc bốn việc: thông báo, đặt hàng qua Inline, tra cứu đơn hàng và kiểm tra **I have paid**;
- subscription nhóm và kênh điều khiển việc gửi thông báo;
- subscription private đang tắt không bao giờ cho phép thao tác đơn hàng nào trên Telegram.

## Nội dung thông điệp

Hệ thống không có danh mục mẫu thông điệp riêng. Mỗi subscription thông báo và mỗi lệnh tự chứa nội dung `en-US`, `ja-JP`, `ko-KR`, `ru-RU`, `zh-TW` và `zh-CN` của nó. Cài đặt subscription mặc định lưu các sự kiện mặc định và nội dung thông báo cho sáu locale. Chúng được dùng cho các đích được phát hiện tự động.

Nội dung dùng Telegram Markdown và chỉ dùng các biến không bí mật đã được ghi trong tài liệu:

- `{{orderId}}`, `{{externalOrderId}}` và `{{status}}`;
- `{{amount}}` và `{{currency}}`;
- `{{payment.amount}}`, `{{payment.asset}}` và `{{payment.network}}`.

Khi gửi, hệ thống dùng locale đã chọn. Nếu không có, hệ thống chuyển sang `en-US`, rồi đến một định dạng mặc định an toàn. Các giá trị động được escape. Audit khi gửi thất bại không bao giờ chứa nội dung thông điệp, Token hay Secret.

## Lệnh và Inline

Instance khởi tạo sẵn `/start`, `/help`, `/new` và `/status`. Hành vi mặc định của các lệnh này do hệ thống quản lý. Lệnh do quản trị viên tạo luôn trả lời bằng nội dung sáu locale của chính nó, và không có ô chọn handler. Lệnh là duy nhất theo `command + scope`, và có thể đồng bộ tới một Bot hoặc tất cả Bot.

Bản nháp Inline không giữ chỗ các phương thức nhận tiền. Đơn hàng chỉ được tạo sau khi Telegram trả về `chosen_inline_result` và subscription private tương ứng đang bật. **I have paid** chỉ yêu cầu quét adapter một lần, theo cách idempotent. Nút này không bao giờ đánh dấu đơn hàng là đã thanh toán trực tiếp.

Các cổng chất lượng tự động không bao giờ kết nối tới Telegram. Khi xác minh trên production, bạn cần kiểm tra đủ các mục sau: Webhook HTTPS cuối cùng, tự động phát hiện đích, xem xét subscription, phân quyền Inline, nội dung sáu locale, đồng bộ lệnh, xoay vòng Token và audit thất bại đã được che (redact) thông tin.
