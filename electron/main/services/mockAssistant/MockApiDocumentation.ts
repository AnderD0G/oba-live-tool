import { MOCK_BATCH_SCHEMA, MOCK_EVENT_KINDS, MOCK_LIMITS } from '../../../../shared/mockAssistant'

const string = { type: 'string' }
const integer = { type: 'integer', minimum: 0 }
const boolean = { type: 'boolean' }
const array = (items: unknown) => ({ type: 'array', items })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const result = (schema: unknown) => object({ ok: { const: true }, data: schema })
const descriptionField = object({
  field: string,
  label: string,
  source: string,
  description: string,
})
const country = object({ code: string, label: string })
const conditionValue = { oneOf: [{ type: 'integer', minimum: 0 }, string, boolean, array(string)] }
const rule = object({
  id: string,
  label: string,
  enabled: boolean,
  priority: integer,
  conditions: array(
    object({
      field: string,
      operator: { enum: ['eq', 'gte', 'lte', 'in'] },
      value: conditionValue,
    }),
  ),
  result: object(
    {
      tier: { enum: ['gold', 'silver', 'neutral'] },
      label: string,
      autoAttention: boolean,
      welcomePresetId: string,
      cardColor: string,
    },
    ['tier', 'label', 'autoAttention'],
  ),
})
const error = object({ ok: { const: false }, error: object({ code: string, message: string }) })
const runtime = object(
  {
    accountId: string,
    selected: boolean,
    phase: { enum: ['idle', 'prepared', 'running', 'stopped'] },
    volatile: { const: true },
    emitted: integer,
    runId: string,
    batch: object({
      batchId: string,
      name: string,
      metadataRevision: string,
      userCount: integer,
      eventCount: integer,
      durationMs: integer,
    }),
    error: object({ code: string, message: string }),
  },
  ['accountId', 'selected', 'phase', 'volatile', 'emitted'],
)
const metadata = object({
  version: { const: 1 },
  scope: { const: 'mock' },
  accountId: string,
  metadataRevision: string,
  catalog: object(
    {
      version: { const: 1 },
      fields: array(
        object({
          field: string,
          label: string,
          type: string,
          operators: array({ enum: ['eq', 'gte', 'lte', 'in'] }),
          source: string,
          description: string,
        }),
      ),
      categories: array(string),
      countries: array(country),
      scripts: array(country),
      languages: array(country),
      limits: object({ rules: integer, conditionsPerRule: integer }),
      publicFields: array(descriptionField),
      unknownFields: array(descriptionField),
    },
    ['version', 'fields', 'categories', 'countries', 'limits'],
  ),
  policy: object({
    revision: integer,
    enabled: boolean,
    rules: array(rule),
    attentionWindowSeconds: integer,
  }),
  limits: object(
    Object.fromEntries(
      Object.entries(MOCK_LIMITS).map(([name, value]) => [name, { type: 'integer', const: value }]),
    ),
  ),
  eventKinds: array({ enum: MOCK_EVENT_KINDS }),
  example: ref('MockBatch'),
})
const response = (description: string, schema: unknown) => ({
  description,
  content: { 'application/json': { schema } },
})
const failureResponses = {
  '400': response('Malformed JSON or invalid batch fields', ref('MockError')),
  '401': response('Missing or invalid independent Mock bearer token', ref('MockError')),
  '403': response('Origin, Host, account or selected platform mismatch', ref('MockError')),
  '409': response('Metadata revision changed; export metadata again', ref('MockError')),
  '413': response('Body exceeds 2 MiB', ref('MockError')),
  '415': response('Content-Type must be application/json', ref('MockError')),
  '500': response('Local Mock provider failed; details are not exposed', ref('MockError')),
}

/** Public contract only: never accepts a runtime token, live state or account secrets. */
export function mockApiOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OBA Mock batch preparation API',
      version: '1.0.0',
      description:
        'Disabled until enabled on the desktop. Upload prepares RAM data only. Playback and all public sends require separate desktop controls.',
    },
    servers: [{ url: '/' }],
    security: [{ mockBearer: [] }],
    paths: {
      '/mock/metadata': {
        get: {
          summary: 'Export the current safe catalog and policy projection',
          responses: {
            '200': response(
              'Safe metadata and a valid minimal example',
              result(ref('MockMetadata')),
            ),
            ...failureResponses,
          },
        },
      },
      '/mock/status': {
        get: {
          summary: 'Read only this account Mock runtime status',
          responses: {
            '200': response(
              'RAM runtime status without credentials',
              result(ref('MockRuntimeStatus')),
            ),
            ...failureResponses,
          },
        },
      },
      '/mock/batches': {
        post: {
          summary: 'Validate and prepare a batch in RAM; never starts playback',
          description:
            'User and event IDs must be unique. Events reference users[].id and atMs must not exceed durationMs. The account and current metadataRevision must match. No extra properties are accepted.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('MockBatch') } },
          },
          responses: {
            '201': response('Prepared in RAM; still not running', result(ref('MockRuntimeStatus'))),
            ...failureResponses,
          },
        },
      },
      '/mock/openapi.json': {
        get: {
          summary: 'Read this public schema',
          security: [],
          responses: { '200': { description: 'OpenAPI 3.1 document without credentials' } },
        },
      },
      '/mock/overview': {
        get: {
          summary: 'Read the public worker workflow',
          security: [],
          responses: { '200': { description: 'Plain-text overview without credentials' } },
        },
      },
    },
    components: {
      securitySchemes: {
        mockBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Independent, account-bound, RAM-only Mock token shown by the desktop. It grants metadata/status reads and batch preparation only. Never put it in a URL.',
        },
      },
      schemas: {
        MockBatch: MOCK_BATCH_SCHEMA,
        MockMetadata: metadata,
        MockRuntimeStatus: runtime,
        MockError: error,
      },
    },
  }
}

export const MOCK_API_OVERVIEW = `OBA Mock worker API — RAM preparation only

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
`
