# Danh sách kiểm tra triển khai EWharf

[English](../en-US/DEPLOYMENT.md) · Tiếng Việt

Danh sách kiểm tra này giúp bạn triển khai một instance EWharf đơn tenant trên Cloudflare
Workers hoặc Bun/Nitro. Operator làm việc qua
`/admin`. Merchant chỉ tích hợp qua giao thức EWharf có chữ ký.

## Các hướng triển khai

### Nút Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ewharf/ewharf)

Quy trình có hướng dẫn sẽ fork repository và cấu hình Workers Builds. Khi dùng nút này,
repository nguồn phải ở chế độ công khai. Đặt `bun run build` làm
Build command, và đặt `bun run deploy` (được tự động phát hiện) làm Deploy command.
Build command sẽ tái sử dụng các tài nguyên D1, KV, R2 và Queue có đúng tên, và chỉ tạo những tài nguyên còn thiếu.
Sau đó nó áp dụng D1 baseline và biên dịch một artifact Vite chứa các ID D1/KV đã được phân giải.
Ở bước deploy, Workers Builds không build lại mà tải lên
artifact vừa được tạo. Tệp `wrangler.jsonc` nguồn (dùng được ở mọi môi trường) không bao giờ bị ghi đè.
Khi triển khai xong, hãy mở `/install` trên URL của Worker.

### Wrangler CLI

Đăng nhập Wrangler rồi chạy lệnh triển khai của package. Hook `predeploy` của lệnh này
tái sử dụng các tài nguyên D1, KV, R2 và Queue có đúng tên, và chỉ tạo những tài nguyên
còn thiếu. Sau đó hook áp dụng D1 baseline và build artifact Vite đã được phân giải trước khi
xuất bản:

```bash
bun install
bunx wrangler login
bun run deploy
```

Nếu cần, hãy chuẩn bị D1 thủ công bằng `bunx wrangler d1 create ewharf`
rồi chạy `bun run db:migrate:remote`. Không đưa ID cơ sở dữ liệu vừa tạo vào
cấu hình nguồn dùng được ở mọi môi trường.

### Bun và Docker

[Gói GHCR](https://github.com/orgs/ewharf/packages/container/package/ewharf) công khai
hỗ trợ `linux/amd64` và `linux/arm64`. Bạn không cần đăng nhập registry.

| Tag | Mục đích sử dụng khuyến nghị |
| --- | --- |
| `latest` | Bản phát hành ổn định mới nhất |
| `alpha` | Bản tiền phát hành mới nhất để thử nghiệm |
| `1.0.0` | Bản phát hành cố định để triển khai lặp lại được kết quả |

#### Docker Compose

Lưu nội dung sau thành `compose.yml`:

```yaml
services:
  ewharf:
    image: ghcr.io/ewharf/ewharf:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      EWHARF_DATA_DIR: /var/lib/ewharf
    volumes:
      - ewharf-data:/var/lib/ewharf

volumes:
  ewharf-data:
```

```bash
docker compose pull
docker compose up -d
```

Muốn thử bản tiền phát hành, hãy đổi `latest` thành `alpha` trước khi khởi động dịch vụ.

#### Lệnh Docker

Nếu không có Compose, hãy chạy container trực tiếp:

```bash
docker volume create ewharf-data
docker run --detach --name ewharf --restart unless-stopped \
  --publish 3000:3000 \
  --env EWHARF_DATA_DIR=/var/lib/ewharf \
  --volume ewharf-data:/var/lib/ewharf \
  ghcr.io/ewharf/ewharf:latest
```

#### Thiết lập lần đầu

Chờ đến khi `GET /healthz` trả về thành công, rồi mở `/install` trên URL công khai.
Hãy xác nhận địa chỉ được phát hiện và Allowed Hosts trước khi tạo root
user đầu tiên. Cấu hình các thiết lập ứng dụng, bảo mật và email trong giao diện
quản trị. Không thêm chúng vào biến môi trường của container.

`EWHARF_DATA_DIR` trỏ đến thư mục lưu trữ bền vững. Thư mục này chứa SQLite,
các tệp đã tải lên, private object, trạng thái queue và mọi dữ liệu runtime khác. Mỗi khi cập nhật hoặc tạo lại container,
hãy sao lưu và giữ nguyên named volume.

#### Các lệnh thường dùng

Kiểm tra và vận hành một bản triển khai Compose bằng các lệnh sau:

```bash
curl --fail http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --follow ewharf
docker compose pull
docker compose up -d
```

Hai lệnh cuối cập nhật tag đã chọn và tạo lại container,
nhưng vẫn giữ nguyên named volume.

Để build artifact Bun từ mã nguồn, hãy chạy `bun run build:bun`. Các lệnh
Workers vẫn giữ nguyên như trên và tiếp tục dùng Cloudflare Vite adapter.
Về sao lưu, khôi phục và di chuyển D1/R2, hãy làm theo
[Bun data operations](../vi-VN/NODE_DATA_OPERATIONS.md). Dùng script `data`
của package (luôn được duy trì) với các lệnh con `backup`, `restore` và `import-cloudflare`.

## Tài nguyên Cloudflare

- [ ] Cấu hình ít nhất một provider tại **Admin → Email delivery**. Để dùng Cloudflare Email, hãy bind Email Routing với tên `EMAIL` và xác nhận provider chỉ dành cho Workers đã xuất hiện. Gửi một email khôi phục thật và xác nhận liên kết có hiệu lực 15 phút hoạt động. Trang đăng nhập cố ý trả về phản hồi chung khi không thể gửi email.
- [ ] Xác nhận quá trình build Workers tạo hoặc tái sử dụng cơ sở dữ liệu D1 `ewharf` và liên kết nó với tên `DB`.
- [ ] Build một lần và xác minh `assets.directory` của Wrangler xuất bản `dist/client`. Các tệp tĩnh do cơ chế xử lý asset của nền tảng Cloudflare phục vụ, nên mã ứng dụng không thấy binding `ASSETS`. Các route ứng dụng và API vẫn đi qua Worker.
- [ ] Xác nhận log deploy đọc `dist/server/wrangler.json` với `main: index.js` và `no_bundle: true`. Wrangler không được bundle lại `src/server-entry.ts` và không được báo lỗi các module `#tanstack-router-entry`/`#tanstack-start-entry` chưa được phân giải.
- [ ] Xác nhận quá trình build Workers tạo hoặc tái sử dụng bucket R2 riêng tư `ewharf-files` và liên kết nó với tên `FILES`.
- [ ] Giữ `ewharf-files` ở chế độ riêng tư và cấu hình chính sách vòng đời R2 cho bằng chứng đối soát do payer gửi. Bằng chứng chỉ được phục vụ qua route Worker đã xác thực.
- [ ] Xác nhận quá trình build Workers tạo hoặc tái sử dụng KV namespace `ewharf-cache` và liên kết nó với tên `CACHE`.
- [ ] Xác minh một user có `audit:create` xuất được audit log, và một artifact NDJSON xuất hiện dưới `exports/audit-logs/` trong R2. Các trường secret có cấu trúc được che đi, và bản thân thao tác xuất cũng được ghi audit.
- [ ] Tạo một đơn hàng thử có chữ ký với `notify_url` là HTTPS công khai. Xác minh chữ ký JSON của EWharf bằng Secret hiện tại của API credential đã tạo đơn. Sau đó gửi lại thông báo đơn hàng một cách tường minh và xác nhận một bản ghi delivery mới được lưu lại.
- [ ] Chỉnh sửa một RPC credential thử nghiệm và xác nhận node bị vô hiệu hóa, đồng thời kết quả health trước đó bị xóa. Kiểm tra node thành công rồi mới bật lại.
- [ ] Vô hiệu hóa phương thức nhận tiền sẵn sàng cuối cùng của một asset thử nghiệm và xác nhận nó biến mất khỏi danh mục public/API. Chỉ bật lại sau khi việc xác thực đích nhận và quyền truy cập thành công.
- [ ] Chỉnh sửa cấu hình tài khoản chỉ đọc của một phương thức nhận tiền Binance, OKX hoặc SePay. Xác nhận phương thức đó vẫn bị vô hiệu hóa cho đến khi danh tính và quyền truy cập mới vượt qua bước xác thực.
- [ ] Kích hoạt **Sync rates** với một nguồn thử nghiệm cố ý không khả dụng. Xác minh các cặp khác vẫn được cập nhật, quan sát bị lỗi giữ nguyên thời điểm hết hạn trước đó, và bản tóm tắt audit không chứa response body của provider.
- [ ] Cấp cho một role thử nghiệm quyền `operations:read` mà không có `operations:update`. Xác minh role đó xem được health nhưng không chạy được các tác vụ khôi phục thủ công. Sau đó cấp quyền update và kiểm tra riêng từng tác vụ có giới hạn.
- [ ] Xoay vòng một Telegram Bot Token thử nghiệm. Xác nhận các subscription hiện có vẫn còn, bot mới nhận Webhook có secret-token, và token cũ bị thu hồi hoặc Webhook của nó bị gỡ.
- [ ] Xác nhận quá trình build Workers tạo hoặc tái sử dụng `ewharf-webhooks`, `ewharf-webhooks-dlq`, `ewharf-payments` và `ewharf-payments-dlq`. Các producer được liên kết với tên `WEBHOOK_QUEUE` và `PAYMENT_QUEUE`.
- [ ] Triển khai producer và consumer của Queue từ cùng một bản phát hành. Payload bắt buộc có kind tường minh là `webhook.delivery`, `payment.scan` hoặc `payment.provider_event`, kèm `version: 1`.
- [ ] Với mỗi nguồn sự kiện Alchemy đã bật, hãy dùng một Address Activity webhook riêng. Xác minh URL callback HTTPS đã sao chép và Allowed Host. Xác nhận quá trình đối soát kiểm tra loại, network, URL, trạng thái hoạt động và các địa chỉ ở phía remote trước khi báo cáo trạng thái khỏe mạnh.
- [ ] Hoàn tất một bài diễn tập Alchemy ở chế độ shadow với giá trị thấp trước khi kích hoạt kế toán. Kiểm tra dòng provider-event, thực hiện một lần thử lại thủ công đủ điều kiện, và xác nhận một delivery trùng lặp hoặc bị thay đổi không tạo thêm sự kiện thanh toán.
- [ ] Giữ bật chính sách retry/DLQ của consumer Webhook để phòng trường hợp Worker bị crash. EWharf lưu và lên lịch riêng các lần thử Webhook ở cấp ứng dụng trong D1. Vì vậy `webhooks.max_attempts` có thể lớn hơn `max_retries` của một thông điệp Queue mà các delivery không bị kẹt ở `failed`.
- [ ] Xác nhận `bun run deploy` tạo hoặc tái sử dụng `ewharf` và áp dụng D1 baseline trước khi xuất bản. Chỉ dùng `bun run db:migrate:remote` khi bạn chủ ý chạy riêng phần cơ sở dữ liệu.
- [ ] Hoàn tất `/install`. Bước này tạo các giá trị xác thực/ký và các mặc định thanh toán, yêu cầu bạn xác nhận Origin được phát hiện, lưu Origin đó làm URL ứng dụng và một Allowed Host, rồi tự động đăng nhập root user.
- [ ] Mở **Forgot password**, nhận liên kết dùng một lần có hiệu lực 15 phút, đặt lại mật khẩu và xác nhận các phiên đăng nhập trước đó không còn xác thực được.
- [ ] Xem lại **Admin → System settings → Authentication** và **Secret management**. Xác minh origin HTTPS của môi trường production và sao lưu `runtime.better_auth_secret` cùng với D1.
- [ ] Cấu hình từng provider dự kiến theo [PAYMENT_METHODS.md](../vi-VN/PAYMENT_METHODS.md). Dùng credential chỉ đọc của sàn giao dịch và xác minh định danh token cùng số chữ số thập phân.
- [ ] Cấu hình các thiết lập đồng bộ tỷ giá crypto và fiat. Bấm **Run now** một lần trong mỗi hộp thoại thiết lập và xác minh các quan sát thô/cuối cùng. Sau đó xác nhận Cron chạy mỗi phút tuân theo công tắc đồng bộ tự động và khoảng thời gian đã lưu của từng danh mục.

## Tài nguyên Bun

- [ ] Xác nhận container chạy bằng user không phải root và thư mục lưu trữ chỉ có danh tính host/container dự kiến mới ghi được.
- [ ] Xác nhận volume chứa `ewharf.sqlite`, private object và trạng thái queue bền vững sau khi cài đặt và sau một lần tải lên/đặt đơn thử nghiệm.
- [ ] Cấu hình một email provider được Bun hỗ trợ và gửi một email thử khôi phục mật khẩu. Xác nhận danh sách provider khớp với Workers và không có email secret nào xuất hiện trong môi trường container.
- [ ] Khởi động lại container và xác nhận các công việc Webhook/thanh toán đang nằm trong hàng đợi cùng các tác vụ theo lịch được tiếp tục chạy, không gây trùng lặp kế toán hoặc delivery.
- [ ] Dừng container, chạy `bun run data -- backup` ra một vị trí bên ngoài, rồi khôi phục bằng `bun run data -- restore` vào một thư mục dữ liệu mới. Xác minh manifest, tính toàn vẹn SQLite, checksum migration, đăng nhập và quyền truy cập private object.
- [ ] Khi di chuyển từ Workers, chạy `bun run data -- import-cloudflare` với các đường dẫn tường minh tới D1 SQL và bản xuất R2 (tùy chọn). Chỉ nhập vào đích mới hoặc rỗng, rồi lặp lại các bài kiểm tra chấp nhận đơn hàng có chữ ký và callback.

## Phát hành tự động

Semantic-release chạy sau quality gate trên cả hai kênh phát hành. Kênh `alpha`
bắt đầu từ `1.0.0-alpha.1` và chỉ xuất bản các container tag là phiên bản đầy đủ và
tag `alpha` luôn trỏ đến bản mới nhất. Sau khi được xác minh và merge, `main` xuất bản bản ổn định `1.0.0` cùng
các tag major, minor và `latest`. Quy trình này cập nhật `package.json` và `bun.lock`, tạo
GitHub Release với ghi chú được sinh tự động và một tag. Sau đó nó gọi workflow độc lập
Docker smoke và xuất bản đa kiến trúc. Các runner x64 và Arm64 gốc
build và smoke-test image của nền tảng mình song song, rồi
workflow mới ghép thành manifest để xuất bản. Sau khi một image ổn định và
provenance của nó được xuất bản, các GitHub prerelease alpha, Git tag từ xa
và phiên bản image GHCR tương ứng sẽ được xóa tự động.

Gói GHCR `ewharf` là công khai. Khi nghiệm thu bản phát hành, hãy xác minh có thể pull
mà không cần xác thực.

## Release gate

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run build:bun`
- [ ] Mở trang đăng nhập và xác minh một bản triển khai chưa khởi tạo sẽ chuyển hướng đến bước khởi tạo root user.
- [ ] Tạo và bật asset, channel và địa chỉ nhận tiền dự kiến. Các mock channel chỉ dành cho phát triển tuyệt đối không được bật nhầm trong production.
- [ ] Xác minh `GET/HEAD /healthz` không cần binding, `/status` chi tiết, khởi tạo root user, đăng nhập và một đơn hàng EWharf có chữ ký chạy trọn vòng (end-to-end) trên channel dự kiến.
- [ ] Xác nhận các đích nhận thông báo của merchant dùng HTTPS công khai, các đường inbound của provider/Telegram xác thực chữ ký riêng của từng provider, và chữ ký outbound của EWharf khớp với các tham số canonical đã được ghi trong tài liệu.
- [ ] Xác nhận không có `.dev.vars`, khóa ví, merchant secret hoặc token Cloudflare nào bị theo dõi trong repository.
- [ ] Smoke-test runtime production đã chọn. Khi phát hành, xác minh digest của image GHCR và cả hai kiến trúc từ GitHub Release.
- [ ] Xác minh image GHCR công khai có thể được pull mà không cần xác thực.
