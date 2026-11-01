# Phương thức thanh toán và phương thức nhận tiền

[English](../en-US/PAYMENT_METHODS.md) · Tiếng Việt

## Mô hình

EWharf chia thanh toán thành năm lớp:

1. **Rail** — một mạng chain, sàn giao dịch hoặc ví điện tử.
2. **Asset** — một loại tiền, kèm số chữ số thập phân và mã định danh trên chain.
3. **Payment access** — cách truy cập thanh toán: HTTPS RPC, WSS, API của nhà cung cấp,
   hoặc đầu vào nhận Webhook từ nhà cung cấp.
4. **Payment method** — một tổ hợp rail và asset được hỗ trợ sẵn.
5. **Receiving method** — nơi nhận tiền tại Checkout do operator cấu hình, gồm thông tin
   xác thực tài khoản chỉ đọc, các asset được chọn và các giới hạn.

Payment method chỉ là bản ghi mô tả khả năng hỗ trợ, không có công tắc bật/tắt khi vận hành.
Checkout hiển thị phương thức nào là do các receiving method đã bật và đã xác thực quyết định.
API key RPC của chain thuộc về payment access. UID/API credential của sàn và
thông tin tài khoản ngân hàng SePay thuộc về receiving method. Các kết nối công khai của sàn
và ví có sẵn được bật mặc định và không thể tắt. Chúng không quyết định
việc hiển thị trên Checkout và không có trạng thái sức khỏe của node chain.

Số tiền fiat dùng đơn vị nhỏ nhất ở dạng số nguyên. Số tiền asset dùng chuỗi số nguyên
đơn vị, kèm số chữ số thập phân ghi rõ. Mọi khoảng thời gian nội bộ tính bằng mili giây.
Không được tính tiền bằng số thực dấu phẩy động của JavaScript.

Giới hạn đơn hàng tối thiểu và tối đa của receiving method luôn tính bằng một loại tiền cố định: USD.
Hai giới hạn này được lưu trên receiving method dưới dạng chuỗi đơn vị nhỏ nhất của USD,
và dùng chung cho mọi asset gắn với method đó. Đơn hàng bằng loại fiat khác được quy đổi sang USD
theo tỷ giá hiện tại đã lưu, trước khi hiển thị trên Checkout và trước khi phân bổ.
Mức chuyển tối thiểu riêng của nhà cung cấp hoặc của chain vẫn do Adapter kiểm tra.

## Quét đầy đủ và giới hạn của nhà cung cấp

Scanner trên production không giả định rằng một phản hồi của nhà cung cấp chứa đủ mọi khoản thanh toán.
TRON dùng con trỏ `meta.fingerprint` của TronGrid. TON Center v3 dùng `limit`/`offset`.
Aptos Indexer dùng offset GraphQL. Solana dùng `getSignaturesForAddress.before`.
Bitcoin dùng các trang `txs/chain/:last_seen_txid` của Esplora.
OKX Funding Bills dùng con trỏ chính thức `after=billId`.
Binance Pay không có con trỏ trang. Vì vậy khi một phản hồi trả về đủ 100 dòng, hệ thống chia đôi
khoảng thời gian theo cách xác định, lặp lại cho đến khi mọi khoảng con đều quét xong.
Các dải log ERC-20 trên EVM được chia thành những khoảng block liên tiếp, đủ nhỏ để nhà cung cấp chấp nhận.
Mọi Adapter có phân trang đều giới hạn số request và báo lỗi rõ ràng.
Adapter không âm thầm chấp nhận kết quả bị cắt cụt, cũng không lặp mãi khi con trỏ bị lặp lại.

Dispatcher chạy theo lịch, sắp xếp các thanh toán đang hoạt động theo `last_payment_scan_at`.
Nó chỉ cập nhật giá trị này sau khi Cloudflare Queues nhận toàn bộ batch.
Nhờ vậy, khi số đơn đang hoạt động nhiều hơn kích thước batch đã cấu hình, các đơn vẫn được quét luân phiên công bằng.
Nếu đưa vào Queue thất bại, chính những đơn đó được thử lại.
Sau mỗi lần quét thành công trọn vẹn, mỗi đơn hàng cũng lưu một con trỏ nhà cung cấp chỉ tiến về phía trước.
Lần quét rỗng hoặc thất bại không làm con trỏ này tiến lên.
Các giao dịch chưa xác nhận đã phát hiện trước đó được làm mới theo hash.
Nhờ vậy, việc kiểm tra số lần xác nhận và reorganization vẫn tiếp tục ngay cả khi con trỏ địa chỉ đã dịch về phía trước.

Trong mỗi batch gồm các đơn đã đến hạn quét lâu nhất, các đơn USDT được đưa vào Queue trước.
Các đơn cùng mức ưu tiên giữ nguyên thứ tự hiện có.
Mức ưu tiên không làm đổi việc đơn nào thuộc batch, nên các asset khác vẫn được quét luân phiên công bằng.
Queue không đảm bảo thứ tự giao và thứ tự hoàn tất.
Mỗi lần quét chỉ dùng asset và địa chỉ nhận nằm trong snapshot bất biến của đơn hàng đó.
Cache của Adapter được tách riêng theo receiving method, asset và địa chỉ nhận.
Vì vậy, một lần quét USDT rỗng không thể che mất khoản thanh toán ETH, và ngược lại.

Các đơn đã thanh toán (paid) và thanh toán dư (overpaid) vẫn nằm trong vòng quét trong khoảng thời gian cấu hình
`payments.reorg_monitor_ms` (mặc định 86,400,000 mili giây, tức 24 giờ).
Trong khoảng này, các sự kiện giao dịch đã xác nhận được làm mới liên tục.
Lần đầu nhà cung cấp không trả về giao dịch, chain event được đánh dấu `missing` và đơn hàng không bị đổi.
Nếu giao dịch xuất hiện lại thì việc phục hồi diễn ra âm thầm.
Nếu nhà cung cấp không trả về giao dịch lần thứ hai liên tiếp, hệ thống ghi nhận một reorganization
và gỡ khoản thanh toán đó khỏi aggregate của đơn hàng trong một thao tác nguyên tử.

### Giới hạn I/O và ngân sách retry

Mỗi thao tác của Adapter có một deadline chung: mặc định 8,000 ms, tối đa
30,000 ms. Các bước sau không đặt lại deadline này: phân trang, đồng bộ đồng hồ,
retry timestamp, bổ sung thông tin giao dịch và tra cứu trực tiếp.
Mỗi lần quét chỉ dùng tối đa tám kết nối đang bật của một payment method,
sắp xếp theo sức khỏe, mức ưu tiên rồi ID.
Failover chạy lần lượt từng kết nối, không chạy song song để đoán trước.

Giới hạn cứng mặc định về số request cho mỗi thao tác của Adapter như sau:

| Adapter | Số request vật lý tối đa mặc định | Retry/đồng thời nội bộ |
| --- | ---: | --- |
| TRON scan | 1,051 | 50 trang, 1,000 dòng, tối đa 3 block request chạy đồng thời |
| EVM token/native scan | 1,004 / 4,001 | Nhìn lại 3,000 block, tối đa 1,000 event khớp; các dải quét tuần tự |
| EVM direct lookup | 4 | Ba lần đọc đầu chạy song song, một lần đọc block, tất cả dưới một deadline |
| TON / Aptos scan | 50 | Các trang quét tuần tự, Adapter không retry |
| Solana token/native scan | 1,801 / 1,050 | Tối đa 16 token account và 1,000 chữ ký; RPC tuần tự |
| Bitcoin scan / direct lookup | 21 / 2 | Một lần đọc tip-height, cộng tối đa 20 trang lịch sử, mỗi trang 25 giao dịch đã xác nhận; Adapter không retry |
| Binance Pay history | 102 | 100 khoảng thời gian chia nhỏ, cộng tối đa một lần đọc đồng hồ và một lần retry timestamp |
| OKX funding scan / direct lookup | 52 / 1,602 | 50 trang; direct lookup có tối đa 32 asset; tổng cộng một lần retry đồng hồ |
| SePay transfer scan / lookup | 5 / 1 | Tối đa năm trang, mỗi trang 100 giao dịch tiền vào; Adapter không retry |

Đây là mức trần số request, không phải số request thường gặp.
Thông thường deadline chung đã dừng các lần quét chậm sớm hơn nhiều.
Payment Queue cho phép hai lần gọi consumer đồng thời, và mỗi lần gọi xử lý hai payment message đồng thời.
Vì vậy tối đa bốn đơn hàng cùng chạy thao tác với nhà cung cấp tại một thời điểm.
Trong giới hạn đó, TRON gửi tối đa 12 request bổ sung thông tin block,
và một lần quét EVM có tối đa tám thao tác HTTP/WSS đang chạy.
Các Adapter còn lại chạy tuần tự cho mỗi đơn hàng.
Một payment message được giao một lần ban đầu, cộng tối đa năm lần retry của nền tảng, rồi mới vào DLQ.
Adapter không tự retry khi gặp lỗi tạm thời.
Binance và OKX chỉ gửi lại một request đã ký sau lỗi timestamp, và vẫn trong cùng deadline.
Nhờ vậy, vòng retry của Adapter, của failover và của Queue không nhân lên thành một con số không giới hạn.

## Quy trình chung

Bản cài đặt mới tạo sẵn mọi rail/provider đã triển khai, danh mục asset có sẵn,
các payment method, mẫu kết nối, các bản ghi tỷ giá cục bộ phổ biến
và cài đặt đồng bộ tỷ giá.
Nó không tự tạo địa chỉ nhận hay tài khoản nhà cung cấp.
Operator phải tự tạo receiving method.

1. Xem lại asset và hợp đồng token đã seed.
2. Xem lại cấu hình kết nối tương ứng, cùng địa chỉ RPC hoặc API của nhà cung cấp.
3. Tạo một receiving method. Nhập địa chỉ trên chain, hoặc định danh tài khoản sàn/ví cùng thông tin xác thực chỉ đọc.
4. Kiểm tra và bật các cấu hình kết nối chain khi cần. Các kết nối công khai của sàn và ví luôn được bật. Khi kiểm tra nhà cung cấp, hệ thống dùng thông tin xác thực đã mã hóa của receiving method, và không hiển thị chúng trong bảng kết nối.
5. Bật receiving method. Server từ chối việc bật cho đến khi địa chỉ nhận và danh tính nhà cung cấp được xác thực, và có một cấu hình kết nối đã bật vượt qua kiểm tra sức khỏe.
6. Kiểm tra trang trạng thái công khai và trang asset công khai, tạo một đơn hàng nhỏ, rồi xác minh hệ thống phát hiện được thanh toán và gửi Webhook.

Mỗi receiving method có một công tắc bật.
Khi tắt receiving method sẵn sàng cuối cùng, asset/mạng đó bị gỡ ngay khỏi danh mục thanh toán công khai,
còn payment method của hệ thống vẫn được giữ nguyên.
Khi bật lại, hệ thống xác thực lại địa chỉ nhận đã lưu qua Adapter hiện tại.
Các đơn hàng đang hoạt động giữ một snapshot thanh toán bất biến.
Việc sửa hoặc tắt method không thể ghi đè chi tiết thanh toán trong lịch sử.

## Thông báo inbound của Alchemy

Alchemy Address Activity có thể giảm độ trễ phát hiện thanh toán trên Ethereum, Base, BNB
Smart Chain và Polygon.
Đây là một đường kích hoạt tùy chọn, không phải nguồn quyết định về kế toán.
EWharf lưu thông báo đã ký vào D1 và chỉ đưa ID sự kiện nội bộ vào Queue.
Sau đó EWharf tải lại giao dịch qua Adapter EVM RPC đã cấu hình.
Mạng, hợp đồng, địa chỉ nhận, chỉ số sự kiện, số tiền, số lần xác nhận, trạng thái thành công
và trạng thái block chuẩn (canonical) đều lấy từ lần tra cứu có thẩm quyền này.
Chỉ sau đó bộ xử lý thanh toán nguyên tử thông thường mới chạy.
Các lần quét thanh toán theo lịch vẫn là đường phục hồi khi Alchemy, việc giao qua Queue hoặc việc lập chỉ mục RPC bị chậm.

Cấu hình một Alchemy webhook riêng cho mỗi mạng:

1. Mở **Admin → Payment Settings → Payment access** và chọn **New push**.
   Biểu mẫu tạo sẵn URL callback cuối cùng trước khi lưu bất cứ thứ gì. Hãy sao chép URL này.
2. Trong Alchemy, tạo một Address Activity webhook riêng cho mạng tương ứng
   bằng URL đó. Không dùng chung webhook này với ứng dụng khác.
   Khi đối soát, EWharf được coi là chủ sở hữu duy nhất của webhook,
   và sẽ xóa các địa chỉ từ xa không phải là địa chỉ nhận đã bật hoặc khóa đơn hàng còn được giữ lại.
3. Nhập Webhook ID, signing key và Auth Token của Alchemy. EWharf tự suy ra
   mã định danh mainnet chính thức từ mạng nội bộ đã chọn. Các secret
   được mã hóa khi lưu và không bao giờ được trả về qua các API danh sách.
4. Lưu ở chế độ **Shadow** mặc định, bật access method, rồi chạy **Reconcile
   addresses**. Trạng thái Healthy nghĩa là webhook từ xa tồn tại, và loại, mạng,
   URL callback, trạng thái hoạt động cùng các địa chỉ được quản lý đều khớp với nguồn cục bộ.
5. Thử các trường hợp trùng lặp, chậm, thanh toán một phần, thanh toán dư và reorganization
   bằng số tiền nhỏ. Sự kiện Shadow chạy đầy đủ đường nhận có chữ ký và
   đường xác minh RPC, nhưng không làm thay đổi trạng thái tiền.
   Chỉ chuyển sang **Active** sau khi đã so sánh kết quả với các lần quét thông thường.

Chữ ký của thông báo đến được tính trên đúng raw request body.
Khi xoay vòng signing key, hệ thống tự động giữ khóa cũ làm khóa xác minh trước đó.
Hãy xóa khóa cũ sau khi Alchemy đã chuyển sang khóa mới xong.
Auth Token chỉ dùng cho API quản lý địa chỉ có giới hạn.
Mỗi lần giao hợp lệ còn bị giới hạn thêm theo từng nguồn, tính trong D1 có thẩm quyền:
600 lần mỗi phút, 2 MiB mỗi raw request và 2,000 activity mỗi lần giao.
Một access method quản lý tối đa 2,000 địa chỉ.
Nếu danh sách địa chỉ từ xa vượt quá giới hạn của lần đọc phân trang,
việc đối soát sẽ thay nó bằng toàn bộ danh sách cục bộ có thẩm quyền.
Khi tắt access method, hệ thống lên lịch ngừng theo dõi các địa chỉ mà nó đang quản lý.
Trong lúc bị tắt, endpoint có chữ ký vẫn trả về thành công nhưng không nhận sự kiện.
Khi nhận thông báo lỗi nhà cung cấp có chữ ký của Alchemy, hệ thống xác nhận đã nhận
nhưng không tạo payment event, và hạ trạng thái sức khỏe của nguồn để
operator xem xét.

Mỗi lần giao sự kiện của nhà cung cấp là duy nhất theo nguồn, ID sự kiện của nhà cung cấp và chỉ số
activity.
Một sự kiện đã commit vào D1 vẫn còn dù Worker đã trả xong phản hồi hay Queue bị lỗi.
Công việc bảo trì theo lịch sẽ phục hồi các dòng đã đến hạn và các lease xử lý đã hết hạn.
Khi nhiều đơn hàng cùng dùng một địa chỉ nhận, hệ thống xác định đơn bằng
chủ sở hữu giao dịch đã có, hoặc bằng số tiền còn lại chính xác và duy nhất.
Các giao dịch chuyển mơ hồ được giữ lại cho bộ phận vận hành xử lý, không đoán để gán vào một đơn hàng.
**Admin →
Webhooks → Inbound records → Payment events** liệt kê trạng thái xác minh, số lần thử và mã
lỗi đã được che bớt.
Operator có quyền `webhooks:update` chỉ có thể xếp lại hàng thủ công các sự kiện ở trạng thái failed,
dead, ambiguous, hoặc ignored nhưng có thể phục hồi rõ ràng.
Không thể phát lại từ giao diện các sự kiện đã thành công hoặc đang xử lý.

## Tỷ giá cục bộ

Các dòng tỷ giá trong D1 là nguồn quyết định cho báo giá đơn hàng.
USD, USDT và USDC dùng tỷ lệ ngang giá 1:1 có sẵn, và không được lưu thành snapshot thừa.
Tỷ giá asset crypto lưu các quan sát dạng asset/USDT.
Tỷ giá fiat lưu các quan sát dạng USD/fiat.

Mỗi trang tỷ giá có cài đặt đồng bộ riêng.
Cài đặt crypto chọn Binance hoặc OKX và một chu kỳ tự động.
Cài đặt fiat gồm danh sách nguồn có thứ tự, một chu kỳ tự động và một mức
điều chỉnh tính bằng basis point.
Các nguồn được thử theo thứ tự dưới đây, nguồn nào thành công đầu tiên sẽ được dùng
(tên nguồn được lưu trong `source` của từng tỷ giá):

1. **URL API tùy chỉnh**, khi được bật (định dạng ở bên dưới).
2. **Key `exchangerate.host` của riêng bạn**, khi được bật.
3. **fawazahmed0 currency-api** (không cần key, CC0, không giới hạn rate limit, cập nhật
   hằng ngày), dùng URL jsDelivr trước, rồi đến bản mirror Cloudflare Pages.
4. **Endpoint mở của ExchangeRate-API** (không cần key, cập nhật hằng ngày). Điều khoản
   của họ yêu cầu ghi nguồn. Trang Fiat rates hiển thị phần ghi nguồn này khi các nguồn có
   sẵn đang bật.

Công tắc **Dùng các nguồn miễn phí tích hợp sẵn** mặc định được bật.
Hãy tắt nó nếu chỉ muốn gọi các nguồn của riêng bạn.
Khi mọi nguồn đều tắt, tỷ giá chỉ đổi khi chỉnh sửa thủ công.
Nếu một tỷ giá vừa đồng bộ lệch hơn 30% so với lần quan sát trước, hệ thống bỏ qua tỷ giá đó
(báo bằng cảnh báo và ghi vào audit log) và không lưu.
Cài đặt cũ dùng một nhà cung cấp duy nhất sẽ tự động được chuyển sang danh sách này.
Mỗi danh mục có một công tắc tự động đồng bộ riêng.
Cron chạy mỗi phút sẽ bỏ qua các danh mục đang tắt, còn lại thì chỉ chạy khi
đã đến hạn theo chu kỳ đã lưu.
**Run now** trước tiên lưu cài đặt hiện tại, rồi
bỏ qua cả công tắc tự động đồng bộ lẫn việc kiểm tra đến hạn.

### API tỷ giá tùy chỉnh

URL tùy chỉnh phải là địa chỉ `https://` công khai và không nhúng thông tin xác thực.
URL được kiểm tra khi lưu, và kiểm tra lại sau khi phân giải DNS ở mỗi request.
Các đích private, loopback, link-local và `.local`/`.internal` bị từ chối.
Redirect không được theo.
Request hết thời gian chờ sau tám giây và phản hồi bị giới hạn ở 1 MiB.
API key tùy chọn được gửi dưới dạng `Authorization: Bearer <key>`.
Đừng đặt secret trong URL.

Endpoint được gọi bằng `GET` và phải trả về tỷ giá tính theo USD, ở dạng số hoặc chuỗi số
thập phân, theo một trong các dạng sau (nếu có `base` hoặc `base_code` thì giá trị phải là `USD`):

```json
{ "base": "USD", "rates": { "VND": 26261.5, "EUR": "0.92" } }
```

```json
{ "usd": { "vnd": 26261.5, "eur": 0.92 } }
```

```json
{ "quotes": { "USDVND": 26261.5, "USDEUR": 0.92 } }
```

Hệ thống chỉ dùng các mã gồm ba chữ cái có giá trị dương, và chỉ đọc tối đa 500 mục.
Cũng áp dụng cùng ngưỡng chặn lệch 30% và cùng mức điều chỉnh basis point.

Cơ sở dữ liệu mới chỉ seed sẵn các cặp có thể đồng bộ, không bịa ra một
báo giá bằng không.
Trước lần quan sát thành công đầu tiên, `raw_rate` và `rate` là
null, danh sách trong admin hiển thị `—`, và việc báo giá đơn hàng bỏ qua dòng đó.

Mỗi dòng đã đồng bộ lưu cả `raw_rate` từ nhà cung cấp lẫn `rate` cuối cùng.
Khi đồng bộ, hệ thống áp dụng mức điều chỉnh basis point đã cấu hình bằng phép tính
thập phân chính xác, rồi mới ghi giá trị cuối.
Cả hai danh sách hiển thị “Tỷ giá gốc”
và “Tỷ giá”, không có cột nguồn hay cột basis point.
Dù chỉnh thủ công ở danh mục nào, chỉ `rate` cuối cùng bị thay đổi.
Giá trị raw gần nhất của nhà cung cấp, nguồn và thời điểm quan sát được giữ nguyên.
Lần đồng bộ thành công tiếp theo sẽ cập nhật lại cả hai
giá trị.
Không có bảng chính sách tỷ giá hay bảng nguồn đồng bộ riêng.

Địa chỉ API của nhà cung cấp thuộc về cấu hình kết nối của sàn/ví.
Định danh tài khoản và thông tin xác thực chỉ đọc thuộc về từng receiving method và được
mã hóa cùng nhau.
Khi thay đổi các thông tin này, method đó vẫn ở trạng thái tắt cho đến khi địa chỉ nhận
và danh tính nhà cung cấp được xác thực lại thành công.
Cấu hình endpoint blockchain và API key RPC
chỉ được chấp nhận trên cấu hình kết nối chain.

Khi việc phát hiện theo lịch bị chậm, người thanh toán có thể chọn **Paid but not confirmed?** trong Checkout và gửi mã định danh giao dịch của nhà cung cấp.
Server không tin lời khẳng định này.
Server tải giao dịch từ Adapter đã cấu hình, xác minh địa chỉ nhận, mạng và asset của đơn hàng.
Chỉ sau đó nó mới gửi sự kiện đã chuẩn hóa vào đường kế toán idempotent thông thường.
Khi KV khả dụng, số lần gửi bị giới hạn ở năm lần mỗi phút cho mỗi đơn hàng và mỗi địa chỉ client.

Số lần xác nhận yêu cầu thuộc về payment method.
Các Adapter tài khoản nhà cung cấp thường dùng `1`.
Tuyệt đối không dùng key của sàn có quyền rút tiền.
EWharf chỉ cần danh tính tài khoản và quyền truy cập lịch sử tiền vào.

## TRON, TRX và TRC20

- Adapter: `tron`
- RPC đã seed: `https://api.trongrid.io`
- Địa chỉ nhận: một địa chỉ Base58Check bắt đầu bằng `T`
- Asset gốc: TRX, 6 chữ số thập phân
- Token đã seed: USDT TRC20, 6 chữ số thập phân

Các trường của RPC node:

```json
{
  "url": "https://api.trongrid.io",
  "apiKey": "optional TronGrid API key"
}
```

RPC node mới được lưu ở trạng thái tắt.
Hãy kiểm tra node bằng thao tác trên dòng của nó trước khi
bật.
Bản thân thao tác bật cũng chạy lại kiểm tra sức khỏe trực tiếp, và bị từ chối nếu
kiểm tra thất bại.
Các node đã bật được công việc bảo trì theo lịch kiểm tra lại.
Bảng RPC hiển thị độ trễ hiện tại và trạng thái healthy/unhealthy.

Các mẫu HTTPS có sẵn được bật ngay khi cài đặt, để các lần kiểm tra sức khỏe theo lịch
đánh giá được chúng ngay.
Chúng chưa được dùng cho đơn hàng cho đến khi có một
lần kiểm tra báo healthy, và có một receiving method đã bật, đã xác thực chọn
payment method tương ứng.
Các mẫu WSS có sẵn vẫn tắt, với
mức ưu tiên 200.
Việc đối soát chỉ điền các giá trị mặc định còn thiếu của danh mục và giữ nguyên
các dòng operator đã chỉnh sửa.

Có thể sửa RPC node mà không cần xóa các tham chiếu tới nó.
Để trống trường API Key thì giá trị đã lưu được giữ nguyên.
Công tắc xóa tường minh sẽ gỡ giá trị đó.
Khi đổi mạng, URL endpoint hoặc API Key, kết quả kiểm tra sức khỏe trước đó mất hiệu lực,
node bị tắt một cách nguyên tử, và phải kiểm tra thành công lại thì mới
bật được.
Khi chỉ đổi tên hoặc mức ưu tiên, trạng thái bật và sức khỏe hiện tại được giữ nguyên.
Metadata audit ghi lại việc thông tin xác thực có đổi hay không, nhưng không bao giờ ghi giá trị của nó.

Adapter đọc các giao dịch TRX và các lần chuyển TRC20.
Nó xác thực địa chỉ nhận, asset và số tiền, theo dõi số lần xác nhận của block, từ chối các giao dịch thất bại và nhận biết khi block chuẩn (canonical) thay đổi.
Với mỗi lần chuyển quan sát được, Adapter lấy `blockID` tại đúng độ cao block của lần chuyển đó (loại trùng trong mỗi lần quét).
Adapter không dùng hash của đầu chain, vì hash này luôn thay đổi.
Nhờ vậy, việc số lần xác nhận tăng lên sẽ không bị nhầm là reorganization.
API key thuộc về RPC node, không thuộc về cài đặt runtime toàn cục.

## Ethereum, Base, BNB Smart Chain và Polygon

- Adapter: `evm`
- Địa chỉ nhận: một địa chỉ `0x` dài 20 byte
- Asset gốc được hỗ trợ: ETH, BNB và MATIC như đã seed
- Token được hỗ trợ: các hợp đồng USDT/USDC đã seed

Cấu hình một cấu hình kết nối JSON-RPC cho mỗi mạng.
Runtime dựng Adapter từ asset đã chọn, hợp đồng/số chữ số thập phân đã seed, mã mạng và endpoint đang bật và khỏe.

```json
{
  "url": "https://your-network-rpc.example",
  "apiKey": "optional provider key"
}
```

Adapter EVM dùng chung quét các lần chuyển native và log `Transfer` của ERC20/BEP20.
Hash giao dịch do người thanh toán gửi được đối chiếu với hợp đồng token, địa chỉ nhận và log index tùy chọn đã cấu hình của payment method.
Hệ thống không tin event `Transfer` đầu tiên trong receipt.
Với thanh toán native, các log token không liên quan bị bỏ qua.
Hãy xác minh mọi hợp đồng token và giá trị decimal với tổ chức phát hành trước khi dùng cho production.
Các mẫu HTTPS có sẵn được bật từ đầu để đánh giá sức khỏe.
Nhưng chúng vẫn chưa dùng được cho đơn hàng cho đến khi healthy và có một receiving method đã bật, đã xác thực.
Các kết nối EVM cũng hỗ trợ JSON-RPC `wss://` an toàn.
Các mẫu WSS có sẵn bắt đầu ở trạng thái tắt, với mức ưu tiên 200.
Khi được bật, subscription WSS đã chọn chạy đồng thời với lần poll HTTP có thẩm quyền.
Nếu subscription bị từ chối hoặc bị rớt, hệ thống ghi lại sức khỏe WSS nhưng vẫn giữ kết quả HTTP.
Lần quét Queue có giới hạn kế tiếp sẽ kết nối lại từ con trỏ đã lưu.

## TON

- Adapter: `ton`
- API mặc định: `https://toncenter.com/api/v3`
- Địa chỉ nhận: một địa chỉ dạng thân thiện với người dùng, bắt đầu bằng `EQ…` hoặc `UQ…`
- Asset gốc: GRAM, 9 chữ số thập phân
- Token đã seed: Jetton USDT

Cấu hình endpoint TON Center v3 và API key tùy chọn trên RPC node.
Message inbound native và các lần chuyển Jetton được chuẩn hóa riêng với nhau.
Hãy xác nhận Jetton master lưu trên asset trước khi bật kênh này.

## Aptos

- Adapter: `aptos`
- Indexer mặc định: `https://api.mainnet.aptoslabs.com/v1/graphql`
- Địa chỉ nhận: một địa chỉ tài khoản `0x` có tối đa 64 chữ số thập lục phân
- Asset gốc đã seed: APT, 8 chữ số thập phân
- Token đã seed: các loại fungible-asset USDT và USDC

URL của RPC node được dùng làm endpoint GraphQL indexer.
Adapter quét các activity fungible-asset thành công và coi version của giao dịch là mã định danh để tra cứu giao dịch.
Để đảm bảo chain event là idempotent, Adapter dùng `event_index` ổn định của Indexer.
Vị trí trong kết quả truy vấn không bao giờ được dùng làm danh tính của thanh toán.
Hãy xác nhận loại asset và số chữ số thập phân trước khi dùng cho production.

## Solana

- Adapter: `solana`
- RPC mặc định: `https://api.mainnet-beta.solana.com`
- Địa chỉ nhận: một địa chỉ ví Base58
- Asset gốc đã seed: SOL, 9 chữ số thập phân
- Token đã seed: các mint SPL USDT và USDC

Adapter tìm các token account thuộc sở hữu của ví nhận, quét các chữ ký và phân tích các lần chuyển SPL.
Mặc định Adapter yêu cầu finalized commitment.
Lưu lượng production nên dùng một nhà cung cấp RPC riêng.
Mẫu HTTPS có sẵn được bật từ đầu để đánh giá.
Tuy vậy, Solana sẽ không hiển thị trên Checkout nếu chưa có kết nối khỏe và một receiving method đã bật.

## Bitcoin

- Adapter: `bitcoin`
- API mặc định: `https://mempool.space/api` (bất kỳ endpoint nào tương thích Esplora, kể cả endpoint tự host)
- Địa chỉ nhận: một địa chỉ mainnet P2PKH (`1…`), P2SH (`3…`), SegWit (`bc1q…`) hoặc Taproot (`bc1p…`)
- Asset gốc đã seed: BTC, 8 chữ số thập phân (satoshi); số lần xác nhận mặc định: 2

Khi lưu receiving method, địa chỉ được xác thực bằng checksum Base58Check, Bech32 hoặc Bech32m.
Nhờ vậy, địa chỉ gõ sai sẽ bị từ chối, thay vì âm thầm nhận tiền vào một địa chỉ không ai kiểm soát.
Các địa chỉ Bech32 được chuẩn hóa về chữ thường.
Hệ thống chỉ dùng các API công khai chỉ đọc. Không lưu key, xpub hay seed nào.

Adapter liệt kê các giao dịch mempool và giao dịch đã xác nhận của địa chỉ, rồi phát một chain event cho mỗi output khớp.
txid là mã định danh giao dịch, còn chỉ số output (`vout`) là chỉ số sự kiện.
Vì vậy, một giao dịch trả cho địa chỉ hai lần sẽ thành hai sự kiện idempotent.
Giao dịch mempool được quan sát với 0 lần xác nhận và có dấu `btc:mempool:<txid>`.
Khi giao dịch được xác nhận, block hash thật thay cho dấu đó.
Nếu giao dịch bị loại bỏ hoặc bị thay thế (RBF), việc tìm theo hash không còn thấy nó nữa.
Khi đó cơ chế làm mới thanh toán đang chờ hiện có sẽ đánh dấu nó là missing.
Độ sâu xác nhận là `tip height - block height + 1`.
Lưu lượng production nên dùng một endpoint Esplora riêng hoặc tự host, vì các instance công khai có rate limit.

## Binance

- Adapter: `exchange`
- Mã provider/mạng: `binance`
- Địa chỉ nhận: UID tài khoản Binance dạng số
- Asset được hỗ trợ: USDT và USDC

Cấu hình kết nối lưu địa chỉ API. Mỗi receiving method lưu:

```json
{
  "apiKey": "read-only API key",
  "secretKey": "API secret",
  "receiverUid": "numeric Binance UID"
}
```

Địa chỉ API mặc định là `https://api-gcp.binance.com`.
Trước khi bật, Adapter kiểm tra quyền truy cập đúng endpoint Pay-history có chữ ký mà việc phát hiện thanh toán sử dụng.
Binance không cho lấy UID người nhận qua một probe tài khoản Spot không liên quan.
Vì vậy EWharf xác thực UID dạng số đã cấu hình, và chỉ chấp nhận các dòng Pay-history có `receiverInfo.binanceId` và asset khớp với receiving method đó.
Hãy giới hạn key theo IP và chỉ cấp quyền đọc Pay-history.
Adapter không bao giờ giao dịch hay rút tiền.

## OKX

- Adapter: `exchange`
- Mã provider/mạng: `okx`
- Địa chỉ nhận: UID tài khoản OKX dạng số
- Asset được hỗ trợ: USDT và USDC

Cấu hình kết nối lưu địa chỉ API. Mỗi receiving method lưu:

```json
{
  "apiKey": "read-only API key",
  "secretKey": "API secret",
  "passphrase": "API passphrase",
  "accountUid": "numeric account UID"
}
```

Địa chỉ API mặc định là `https://www.okx.com`.
Phản hồi tài khoản có chữ ký phải khớp với `accountUid`.
Chỉ các funding bill dương của asset được yêu cầu mới được chấp nhận.
Hãy dùng key chỉ đọc, tắt quyền rút tiền và giới hạn IP ở phía nhà cung cấp.

Nếu tài khoản được gán domain API theo khu vực khác với mặc định toàn cầu, hãy dùng domain đó (ví dụ `us.okx.com` hoặc `eea.okx.com`).

## SePay

- Adapter: `wallet`
- Mã provider/mạng: `sepay`
- Địa chỉ nhận: số tài khoản ngân hàng đã kết nối với SePay
- Asset được hỗ trợ: VND (chuyển khoản ngân hàng, 0 chữ số thập phân)

SePay theo dõi một tài khoản ngân hàng tại Việt Nam và báo mọi giao dịch tiền vào.
EWharf không giữ hay chuyển tiền.
Người thanh toán chuyển khoản vào tài khoản của
operator, và ghi mã chuyển khoản của đơn hàng vào nội dung chuyển khoản.

Cấu hình kết nối lưu địa chỉ API. Mỗi receiving method lưu:

```json
{
  "accountNumber": "số tài khoản ngân hàng đã kết nối với SePay",
  "bankName": "tên ngân hàng hiển thị ở Checkout",
  "accountName": "tên chủ tài khoản hiển thị ở Checkout",
  "apiToken": "API token của SePay",
  "webhookApiKey": "API key tùy chọn mà SePay gửi kèm mỗi webhook",
  "webhookSecret": "HMAC secret tùy chọn cho webhook có chữ ký"
}
```

Cần có ít nhất một trong hai trường `webhookApiKey` hoặc `webhookSecret`.
Địa chỉ API mặc định là `https://userapi.sepay.vn/v2`.
Hãy tạo API token trong dashboard SePay và chỉ cấp
quyền đọc giao dịch.

Checkout hiển thị ngân hàng, số tài khoản, tên chủ tài khoản, số tiền VND chính xác và
một mã chuyển khoản ngẫu nhiên có dạng `EW` cộng 12 chữ cái hoặc chữ số, kèm ảnh VietQR.
Mã này được lưu làm mã tham chiếu của đơn hàng.
Hãy cấu hình tiền tố mã thanh toán trong SePay là `EW`, để SePay tách mã vào trường `code`.
EWharf cũng tìm mã trong nội dung chuyển khoản.

Webhook công khai là `/api/providers/sepay/notify`.
Hãy cấu hình nó trong SePay bằng API key (`Authorization: Apikey <key>`)
hoặc HMAC secret (`X-SePay-Timestamp` và `X-SePay-Signature: sha256=<hex>`, ký trên `timestamp.body`, sai lệch thời gian cho phép là năm phút).
Webhook chưa xác thực sẽ bị từ chối.
Nội dung webhook không bao giờ là nguồn quyết định về tiền.
EWharf xác định đơn hàng theo mã chuyển khoản
(hoặc theo số tiền dự kiến duy nhất nếu người thanh toán quên ghi mã).
Sau đó EWharf đọc lại giao dịch từ SePay API đã xác thực,
kiểm tra tài khoản, số tiền và chiều giao dịch, rồi mới ghi nhận thanh toán.
Giao dịch không thuộc đơn hàng nào vẫn được xác nhận đã nhận, để SePay không retry.
Khi quét thanh toán, hệ thống cũng poll API giao dịch, làm đường phục hồi trong trường hợp lỡ webhook.

Các mẫu kết nối có sẵn mà chưa có thông tin xác thực đã được xác minh thì vẫn ở trạng thái tắt.
Hãy cấu hình các API key cần thiết, chạy kiểm tra sức khỏe trực tiếp, và chỉ sau đó mới bật receiving method để vận hành.
Metadata hỗ trợ đã seed không phải là bằng chứng cho thấy bản triển khai đã sẵn sàng nhận tiền.

Khóa số tiền của receiving method còn có một giai đoạn cách ly trước khi được dùng lại.
Khi một đơn hàng hoàn tất, bị hủy hoặc hết hạn, việc giữ chỗ đang hoạt động của nó được giải phóng.
Tuy nhiên, cùng địa chỉ nhận, asset và số tiền đơn vị asset kỳ vọng sẽ chưa được gán lại
cho đến khi qua thời điểm hết hạn ban đầu cộng thêm
khoảng giám sát reorganization đã cấu hình.
Điều này ngăn một khoản thanh toán đến chậm
cho đơn hàng cũ bị gán nhầm cho đơn hàng mới có cùng số tiền.
Việc đổi khoảng giám sát chỉ ảnh hưởng các đơn hàng mới được phân bổ.
Các snapshot đơn hàng bất biến và hạn khóa hiện có không bị ghi đè.

Nếu bản cài đặt phát triển hiện có được tạo trước khi có một giá trị mặc định mới, hãy chạy **Admin → Operations → Reset payment defaults**.
Thao tác này dùng ngữ nghĩa insert-if-missing.
Nó khôi phục các rail, asset, mẫu kết nối, payment method, tỷ giá và cài đặt đồng bộ còn thiếu, nhưng không bật lại hay ghi đè cấu hình của operator.
Có thể chạy lặp lại an toàn.

## Đồng bộ tỷ giá

Khi lấy dữ liệu từ Binance Spot và OKX Spot, hệ thống chạy đồng thời có giới hạn,
để một ticker chậm không làm mọi cặp phải chờ lần lượt.
Mỗi cặp crypto được xử lý riêng.
Phản hồi lỗi hoặc sai định dạng từ nhà cung cấp không bao giờ ghi đè quan sát trước đó của cặp đó.
Với fiat, hệ thống chuẩn hóa bảng báo giá USD của nhà cung cấp,
rồi upsert các dòng tiền tệ ba chữ cái hợp lệ, đồng thời giữ nguyên cả giá trị raw lẫn giá trị đã điều chỉnh.

Mỗi lần làm mới trả về số lượng configured, updated và failed.
Khi có lỗi một phần, hệ thống ghi một bản tóm tắt audit có cấu trúc, chỉ chứa nguồn, cặp và mã
lỗi ổn định. Nội dung phản hồi của nhà cung cấp không được lưu.
Các lần chạy theo lịch thành công không tạo nhiễu audit mỗi phút.
Còn các lần chạy do administrator kích hoạt
luôn ghi rõ người thực hiện, request ID và IP nguồn.

## Secret và log

Thông tin xác thực của sàn và ví được mã hóa cùng receiving method của chúng.
Địa chỉ API của nhà cung cấp và API key RPC của chain nằm trong cấu hình kết nối.
Các phản hồi API và audit log không bao giờ để lộ secret của nhà cung cấp, signing key hay secret của Webhook.
Không Adapter nào chấp nhận private key hay seed phrase của ví.

## Danh sách kiểm tra trước khi lên production

- Xác nhận mạng, hợp đồng token/mint/master/type và số chữ số thập phân với tổ chức phát hành.
- Xác nhận địa chỉ nhận thuộc về operator của bản triển khai.
- Dùng thông tin xác thực nhà cung cấp chỉ đọc và allowlist IP.
- Chạy kiểm tra sức khỏe Adapter và một khoản thanh toán thật có giá trị nhỏ.
- Kiểm tra các trường hợp pending, confirmation, paid, underpaid, overpaid, expiry và late-arrival.
- Kiểm tra việc xác thực chữ ký Webhook, retry và xử lý sự kiện trùng lặp.
- Xem lại audit log sau mỗi thay đổi cấu hình.

## Kiểm thử trên nền tảng thật

Các cổng chất lượng tự động dùng fixture đã được làm sạch.
Chúng không bao giờ cần thông tin xác thực mạng, tài khoản bên ngoài hay tiền thật.
Các bộ smoke test cho chain, sàn, ví và Telegram vẫn được giữ lại để kiểm tra thủ công, nhưng luôn bị bỏ qua vô điều kiện. Biến môi trường không thể bật chúng.
Kiểm thử trên production vẫn là một bước nghiệm thu do operator tự chạy.
Kết quả bước này không được tính là bằng chứng tự động.
