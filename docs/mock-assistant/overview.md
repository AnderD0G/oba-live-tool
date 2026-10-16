# Mock 数据生成与上传

这是独立 Mock API 的公开说明。入口默认关闭，须在桌面显式开启；密钥只在 RAM 中保存，与 Director 密钥隔离。上传仅准备数据，播放须在桌面另行启动。

先从桌面复制入口与密钥，由本地 worker 获取 `/mock/metadata`。云模型不能直接访问回环或私网地址，应只把导出的安全元数据 JSON 交给它，密钥不要提供给模型或放入 URL。

`example.batch.json` 是 default 账号、默认策略的最小示例。实际上传前请使用当前 `/mock/metadata` 中的 `example` 或替换账号及 `metadataRevision`；过期版本会返回 409。OpenAPI 3.1 完整契约位于 `openapi.json`，接口在线版本位于 `/mock/openapi.json`。

```json
{
  "version": 1,
  "accountId": "default",
  "metadataRevision": "fbb67495a5425323ba233b104f739f770b66830c79206b2499dab0b33c33763e",
  "batchId": "sample-1",
  "name": "模拟多语言评论",
  "durationMs": 1000,
  "users": [
    {
      "id": "mock-viewer-1",
      "nickname": "模拟观众",
      "payLevel": 15,
      "followerCount": 100
    }
  ],
  "events": [
    {
      "id": "mock-event-1",
      "userId": "mock-viewer-1",
      "atMs": 0,
      "kind": "comment",
      "text": "ราคาเท่าไหร่?"
    }
  ]
}
```

OBA Mock worker API — RAM preparation only

Enable the separate Mock API on the desktop and obtain its base URL and independent bearer token there.
The API is off by default. The token is held only in RAM, bound to the selected account, rotated on restart,
and revoked when the desktop leaves Mock or closes the API. Director keys have no authority here.

1. GET /mock/metadata with Authorization: Bearer <the separately provided Mock token>.
2. Export that JSON to a local file if a cloud model will generate data: cloud models cannot directly read private LAN/loopback URLs.
   Export metadata only, never the token, real viewer data, account keys or knowledge.
3. Generate a version=1 batch using users[] and events[]. Copy accountId and metadataRevision exactly.
   Use the included metadata example as the minimal JSON template. Fields and values outside the contract are rejected.
4. POST /mock/batches as application/json using the same bearer header. A 201 response means prepared in RAM only.
5. Review and start playback explicitly from the desktop. This worker token cannot start collection, playback, send replies,
   operate OBS, request ASR, import configuration, or invoke Director actions.

GET /mock/status reports only Mock runtime progress. GET /mock/openapi.json contains the strict OpenAPI 3.1 schema.
GET /mock/overview (alias /mock/docs) returns this text. Documentation never contains a token.
No CORS access is granted. Use a local Node/Python worker without an Origin header, not a cross-site browser page.
Loopback is the default binding. LAN access requires the desktop to explicitly select the LAN listener.

Limits: 2 MiB UTF-8 JSON; 1–1000 users; 1–5000 events; duration 1–1800000 ms; original text 1–2000 characters;
nicknames/names up to 100 characters; stable IDs use ASCII letters, digits, underscore, hyphen, dot or colon.
Event IDs and user IDs are separately unique. Every event.userId refers to a users[].id and atMs is an integer within durationMs.
Comments and generic events require text. Gifts require count>=1 and final; optional coins remain unknown when absent.
Levels accept 0–10000; zero levels/counts normalize to unknown, as do omitted profile fields. Known levels are 1–10000.
followStatus accepts only the currently understood platform codes 1 or 2. Numeric generation caps are input limits,
not claims about a platform's real-world ranges. subscriptionActive supports observed true only.
Country tags use the catalog country codes. Nickname script is evidence, never actual country or language.
If both unitCoins and totalCoins are provided, totalCoins must equal unitCoins*count with a safe integer product.
Do not include real viewer IDs, credentials, avatars, arbitrary URLs, knowledge, or precomputed translations/replies.

409 MOCK_METADATA_STALE means policy or metadata changed: export metadata again and regenerate deliberately.
403 means the bound account/selection or request origin/host is invalid. Malformed or oversized uploads do not prepare anything.
All data is volatile and disappears when cleared or the app exits; upload does not create a durable recording.
