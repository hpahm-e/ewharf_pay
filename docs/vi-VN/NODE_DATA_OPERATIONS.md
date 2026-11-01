# Bun data operations

Bản triển khai Bun lưu cơ sở dữ liệu SQLite tại
`$EWHARF_DATA_DIR/ewharf.sqlite` và các private object trong
`$EWHARF_DATA_DIR/objects`. CLI được duy trì và application server đều chạy trên
Bun, dùng driver SQLite gốc của Bun.

## Sao lưu và khôi phục

Hãy dừng container EWharf trước khi sao lưu hoặc khôi phục. Làm vậy để cơ sở dữ liệu và
các tệp object luôn ở cùng một thời điểm logic.

```bash
EWHARF_DATA_DIR=/srv/ewharf bun run data -- backup --output /srv/backups/ewharf-2026-08-20
EWHARF_DATA_DIR=/srv/ewharf-restored bun run data -- restore --input /srv/backups/ewharf-2026-08-20
```

Image đã xuất bản có sẵn CLI này. Ví dụ, sau khi dừng
dịch vụ, hãy mount một thư mục sao lưu bên ngoài rồi chạy:

```bash
docker compose stop ewharf
docker compose run --rm --no-deps \
  --volume "$PWD/backups:/backups" \
  ewharf bun run data -- backup --output /backups/ewharf-2026-08-20
```

Bạn luôn phải chỉ định rõ đường dẫn output/input. Đầu ra sao lưu phải nằm ngoài
thư mục dữ liệu. Restore chỉ chấp nhận đích mới hoặc rỗng và không bao giờ ghi đè
một thư mục không rỗng. Manifest xác minh từng tệp. Restore còn chạy thêm các kiểm tra
tính toàn vẹn SQLite, khóa ngoại và checksum migration.

Các bản sao lưu chứa credential, dữ liệu người dùng, bản ghi thanh toán và các tệp tải lên riêng tư.
Hãy mã hóa chúng khi lưu trữ, hạn chế quyền truy cập và thường xuyên thử khôi phục.

## Nhập bản xuất Cloudflare

Xuất D1 dưới dạng SQL, và xuất các object R2 vào một thư mục cục bộ sao cho đường dẫn tương đối
chính là object key gốc. Sau đó nhập vào một thư mục dữ liệu Bun mới hoặc rỗng:

```bash
wrangler d1 export DB --remote --output ./d1-export.sql
EWHARF_DATA_DIR=/srv/ewharf bun run data -- import-cloudflare \
  --d1-sql ./d1-export.sql \
  --r2-dir ./r2-export \
  --r2-manifest ./r2-metadata.json
```

`--r2-dir` là tùy chọn khi instance không có object nào. `--r2-manifest` cũng là
tùy chọn, nhưng cần có `--r2-dir`. Dùng nó để giữ lại metadata HTTP và metadata tùy chỉnh của R2.
Đây là một đối tượng JSON, với khóa là object key R2 gốc:

```json
{
  "evidence/receipt.txt": {
    "httpMetadata": {
      "contentType": "text/plain; charset=utf-8",
      "cacheExpiry": "2026-09-01T00:00:00.000Z"
    },
    "customMetadata": { "orderId": "order-123" }
  }
}
```

Các trường HTTP được hỗ trợ là `contentType`, `contentLanguage`,
`contentDisposition`, `contentEncoding`, `cacheControl` và `cacheExpiry` (theo
chuẩn ISO 8601). Các trường lạ, metadata tùy chỉnh không phải chuỗi, và các khóa trong manifest
không có object được xuất tương ứng đều bị từ chối. Nếu không có sidecar này, các byte
và khóa của object vẫn được nhập, nhưng không thể dựng lại metadata R2.

Quá trình nhập sẽ xác minh mọi migration của repository đều có trong bản xuất D1.
Nó ghi lại checksum của các migration đó cho migration runner cục bộ, kiểm tra khóa ngoại,
và chuyển đường dẫn khóa R2 sang bố cục private-object dạng băm. Nó từ chối
đích không rỗng, nên một lần nhập thất bại hoặc chạy lặp lại không thể
ghi đè một instance đang có.
