# Tizen 6 (LAMPA wgt) — что доступно

## TV #1: QE75QN800AUXRU (Neo QLED 8K)

- Tizen: **6.0**
- build: TIZEN-TRUNK2021-OscarP-RELEASE_20240831.1
- LAMPA запущена из `file:///index.html` (нативный .wgt пакет)
- UA: `Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 ... TV Safari/537.36` (Chromium 76)
- Lampa.Platform: `tizen`

### tizen.systeminfo capabilities

- `network.upnp` → **error "Value for given key was not found"**
- `network.dlna` → **error "Value for given key was not found"**

То есть Samsung вырезал DLNA/UPnP как платформенную фичу из этой сборки.

### `window.webapis` (6 ключей)

```
avplay, avplaystore, bixby, featureconfig, hybridchannelinfo, voiceinteraction
```

- `webapis.allshare` — нет
- `webapis.network` — нет
- `webapis.productinfo` — нет

### `window.tizen` (54 ключа, частично)

```
AttributeFilter, AttributeRangeFilter, CompositeFilter, SortMode, SimpleCoordinates,
BundleValueType, Bundle, cordova, tvinputdevice, application, ApplicationControlData,
ApplicationControl, systeminfo, account, Account, alarm, AlarmRelative, AlarmAbsolute,
bluetooth, BluetoothLEServiceData, BluetoothLEAdvertiseData, BluetoothLEManufacturerData,
GATTRequestReply, download, DownloadRequest, exif, ExifInformation, iotcon, IotconOption,
Representation, Response, State, keymanager, time, TZDate, TimeDuration, voicecontrol,
VoiceControlCommand, archive, filesystem, content, datacontrol, mediacontroller, mediakey,
messageport, metadata, package, push, tvaudiocontrol, tvchannel, …
```

### Критичные для DLNA — отсутствуют

- ❌ `tizen.network` — нет
- ❌ `tizen.SocketAddress` — нет
- ❌ `tizen.UDPSocket` / `tizen.TCPSocket` — нет

### Что есть и потенциально полезно

- `tizen.iotcon` — IoT Connectivity (CoAP/OCF). Не UPnP-совместимо «из коробки», но
  теоретически даёт сетевой ввод-вывод. Маловероятно подойдет для DLNA.
- `tizen.download` — менеджер HTTP-загрузок. Может скачать файл, но не подходит для
  быстрых SOAP-запросов.
- `tizen.application` — запуск других приложений Tizen. Есть встроенный плеер в
  Tizen, но он не нужен — у LAMPA свой.
- `tizen.cordova` — присутствует Cordova-стек.

## TV #2: ?

(не проверялся)

## Архитектурные выводы для DLNA-плагина

1. **SSDP/multicast невозможны** — нет UDP-сокетов в LAMPA-контексте на Tizen 6.
   Discovery должен быть ручным: пользователь вводит IP Кинетика.
2. **Платформенного DLNA API нет** — все идет через HTTP/SOAP вручную.
3. **Не подтверждено, что плагин может делать HTTP-запросы на LAN.**
   POST на `http://192.168.1.129:8080/report` с TV не дошел (ни fetch, ни sendBeacon, ни `<img>`).
   Возможные причины:
   - CSP / `<access origin>` в config.xml LAMPA wgt блокирует не-cuб домены.
   - file:// контекст ограничивает cross-origin запросы.
   Нужно проверить, ходит ли `Lampa.Reguest` (привилегированный HTTP-клиент LAMPA)
   на LAN-адреса. Если ходит — DLNA реален. Если нет — плагин невозможен на этой
   инсталляции LAMPA.

## Следующий шаг

Сделать v0.5.0 debug-плагина с **тестом транспортов**: пробует на экране отрисовать
результат GET к `http://192.168.1.129:8080/ping` через
- native `fetch`
- native `XMLHttpRequest`
- `Lampa.Reguest` (внутренний клиент LAMPA)
- `<img>` с querystring

Если хоть один из них вернет 200 — у нас есть транспорт для ContentDirectory SOAP.
