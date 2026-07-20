const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createToolsRouter } = require('../tools-router');

const TEST_ENV = {
    TOOLS_API_KEY: 'test-tools-key',
    CWA_API_KEY: 'test-cwa-key',
    TDX_CLIENT_ID: 'test-tdx-id',
    TDX_CLIENT_SECRET: 'test-tdx-secret',
    GOOGLE_MAPS_API_KEY: 'test-google-key'
};
let googlePlacesRequestCount = 0;
let lastGooglePlacesBody = null;

function createFakeHttp() {
    return {
        async get(url) {
            if (url.includes('F-C0032-001')) {
                return { data: { records: { location: [{
                    locationName: '桃園市',
                    weatherElement: [
                        { elementName: 'Wx', time: [{ startTime: '2026-07-19 06:00:00', parameter: { parameterName: '多雲' } }] },
                        { elementName: 'MinT', time: [{ startTime: '2026-07-19 06:00:00', parameter: { parameterName: '27' } }] },
                        { elementName: 'MaxT', time: [{ startTime: '2026-07-19 06:00:00', parameter: { parameterName: '33' } }] },
                        { elementName: 'PoP', time: [{ startTime: '2026-07-19 06:00:00', parameter: { parameterName: '30' } }] }
                    ]
                }] } } };
            }
            if (url.includes('/Bus/Route/')) return { data: [{ RouteUID: 'TAO1', RouteName: { Zh_tw: '1' } }] };
            if (url.includes('/Bus/StopOfRoute/')) return { data: [{ Direction: 0, Stops: [{ StopUID: 'S1', StopName: { Zh_tw: '測試站' }, StopSequence: 1 }] }] };
            if (url.includes('/Bus/EstimatedTimeOfArrival/')) return { data: [{ Direction: 0, StopUID: 'S1', StopName: { Zh_tw: '測試站' }, EstimateTime: 180 }] };
            if (url.includes('/Bus/Station/NearBy')) return { data: [{ StationID: 'N1', StationName: { Zh_tw: '附近站' }, Stops: [] }] };
            throw new Error(`Unexpected GET ${url}`);
        },
        async post(url, body) {
            if (url.includes('/protocol/openid-connect/token')) return { data: { access_token: 'test-token', expires_in: 3600 } };
            if (url.includes('places.googleapis.com')) {
                googlePlacesRequestCount += 1;
                lastGooglePlacesBody = body;
                return { data: { places: [{
                    id: 'place-1', displayName: { text: '測試餐廳' }, primaryTypeDisplayName: { text: '餐廳' },
                    formattedAddress: '桃園市測試路 1 號', location: { latitude: 25.01, longitude: 121.01 },
                    rating: 4.5, currentOpeningHours: { openNow: true }, googleMapsUri: 'https://maps.google.com/'
                }] } };
            }
            throw new Error(`Unexpected POST ${url}`);
        }
    };
}

async function startServer() {
    const app = express();
    app.use('/api/tools', createToolsRouter({
        env: TEST_ENV,
        http: createFakeHttp(),
        now: () => new Date('2026-07-19T04:34:56.000Z')
    }));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

let context;
test.before(async () => { context = await startServer(); });
test.after(() => new Promise((resolve) => context.server.close(resolve)));

async function request(path, authenticated = true) {
    return fetch(`${context.baseUrl}${path}`, { headers: authenticated ? { 'X-Tools-Key': TEST_ENV.TOOLS_API_KEY } : {} });
}

test('tools authentication rejects missing key', async () => {
    const response = await request('/api/tools/time', false);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

test('time API returns Asia/Taipei fields', async () => {
    const response = await request('/api/tools/time');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.timezone, 'Asia/Taipei');
    assert.equal(body.date, '2026-07-19');
});

test('weather API supports valid and invalid requests', async () => {
    const valid = await request('/api/tools/weather?location=%E6%A1%83%E5%9C%92%E5%B8%82');
    const body = await valid.json();
    assert.equal(valid.status, 200);
    assert.equal(body.weather, '多雲');
    assert.deepEqual(body.temperature, { min: 27, max: 33, unit: 'C' });

    const invalid = await request('/api/tools/weather');
    assert.equal(invalid.status, 400);
});

test('bus API supports route query and rejects missing query', async () => {
    const valid = await request('/api/tools/bus?city=Taoyuan&route=1&direction=0');
    const body = await valid.json();
    assert.equal(valid.status, 200);
    assert.equal(body.arrivals[0].estimate_seconds, 180);

    const invalid = await request('/api/tools/bus?city=Taoyuan');
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'MISSING_BUS_QUERY');
});

test('food API returns at most five results and rejects missing location', async () => {
    const valid = await request('/api/tools/food?latitude=25&longitude=121&dietary=vegetarian&open_now=true');
    const body = await valid.json();
    assert.equal(valid.status, 200);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].name, '測試餐廳');

    const invalid = await request('/api/tools/food');
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'MISSING_LOCATION');
});

test('food API resolves the school name to its full address', async () => {
    const response = await request('/api/tools/food?location=%E4%B8%96%E7%B4%80%E7%B6%A0%E8%83%BD%E5%B7%A5%E5%95%86');
    assert.equal(response.status, 200);
    assert.match(lastGooglePlacesBody.textQuery, /333 桃園市龜山區新興里明德路162巷100號 附近/);
    assert.doesNotMatch(lastGooglePlacesBody.textQuery, /世紀綠能工商/);
});

test('food API does not cache Google Places content', async () => {
    const countBefore = googlePlacesRequestCount;
    const first = await request('/api/tools/food?location=%E6%A1%83%E5%9C%92%E5%B8%82');
    const second = await request('/api/tools/food?location=%E6%A1%83%E5%9C%92%E5%B8%82');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(googlePlacesRequestCount - countBefore, 2);
});

test('food API enforces the configured Google Places daily limit', async () => {
    const app = express();
    app.use('/api/tools', createToolsRouter({
        env: { ...TEST_ENV, GOOGLE_PLACES_DAILY_LIMIT: '1' },
        http: createFakeHttp(),
        now: () => new Date('2026-07-19T04:34:56.000Z')
    }));
    const limitedServer = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const limitedBaseUrl = `http://127.0.0.1:${limitedServer.address().port}`;
    try {
        const headers = { 'X-Tools-Key': TEST_ENV.TOOLS_API_KEY };
        const first = await fetch(`${limitedBaseUrl}/api/tools/food?location=%E6%A1%83%E5%9C%92%E5%B8%82`, { headers });
        const second = await fetch(`${limitedBaseUrl}/api/tools/food?location=%E6%A1%83%E5%9C%92%E5%B8%82`, { headers });
        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal((await second.json()).error.code, 'PLACES_DAILY_LIMIT_REACHED');
    } finally {
        await new Promise((resolve) => limitedServer.close(resolve));
    }
});

test('food API safely reports Google Places request errors', async () => {
    const externalError = new Error('Request failed with status code 400');
    externalError.status = 400;
    externalError.code = 'ERR_BAD_REQUEST';
    externalError.response = {
        status: 400,
        data: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid request field.' } }
    };
    const app = express();
    app.use('/api/tools', createToolsRouter({
        env: TEST_ENV,
        http: { post: async () => { throw externalError; } },
        now: () => new Date('2026-07-19T04:34:56.000Z')
    }));
    const errorServer = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${errorServer.address().port}/api/tools/food?location=Taoyuan`, {
            headers: { 'X-Tools-Key': TEST_ENV.TOOLS_API_KEY }
        });
        const body = await response.json();
        assert.equal(response.status, 502);
        assert.equal(body.error.code, 'EXTERNAL_API_ERROR');
        assert.equal(body.error.details.provider_status, 400);
        assert.equal(body.error.details.provider_code, 'INVALID_ARGUMENT');
        assert.equal(body.error.details.provider_message, 'Invalid request field.');
    } finally {
        await new Promise((resolve) => errorServer.close(resolve));
    }
});

test('OpenAPI document is public and contains all Dify operation IDs', async () => {
    const response = await request('/api/tools/openapi.json', false);
    const body = await response.json();
    assert.equal(response.status, 200);
    const operationIds = Object.values(body.paths).map((path) => path.get.operationId);
    assert.deepEqual(operationIds, [
        'get_taiwan_time', 'get_taiwan_weather', 'search_taiwan_bus', 'search_nearby_food', 'search_taiwan_news'
    ]);
});
