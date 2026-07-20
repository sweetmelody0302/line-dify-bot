const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RATE_LIMIT = 60;
const CACHE_TTL = {
    weather: 10 * 60 * 1000,
    bus: 30 * 1000,
    news: 5 * 60 * 1000
};
const TAIWAN_CITIES = new Set([
    'Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung',
    'Keelung', 'Hsinchu', 'HsinchuCounty', 'MiaoliCounty', 'ChanghuaCounty',
    'NantouCounty', 'YunlinCounty', 'Chiayi', 'ChiayiCounty', 'PingtungCounty',
    'YilanCounty', 'HualienCounty', 'TaitungCounty', 'PenghuCounty',
    'KinmenCounty', 'LienchiangCounty'
]);
const SUPPORTED_LANGUAGES = new Set([
    'zh-TW', 'en', 'ja', 'vi', 'th', 'my', 'id', 'lo', 'ms'
]);
const DIETARY_VALUES = new Set(['vegetarian', 'vegan', 'halal', 'no_pork', 'no_beef', 'allergy']);

function createToolsRouter(options = {}) {
    const router = express.Router();
    const http = options.http || axios;
    const env = options.env || process.env;
    const now = options.now || (() => new Date());
    const cache = new Map();
    const rateBuckets = new Map();
    const placesUsage = { day: '', dayCount: 0, minute: 0, minuteCount: 0 };
    let tdxToken = null;

    router.get('/openapi.json', (req, res) => {
        const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
        const protocol = forwardedProtocol === 'https' ? 'https' : req.protocol;
        res.json(buildOpenApiDocument(`${protocol}://${req.get('host')}`));
    });

    router.use((req, res, next) => {
        const configuredKey = env.TOOLS_API_KEY;
        const providedKey = readToolsKey(req);

        if (!configuredKey) {
            return sendError(res, 503, 'TOOLS_NOT_CONFIGURED', '工具 API 尚未設定驗證金鑰。');
        }

        if (!providedKey || !safeEqual(providedKey, configuredKey)) {
            return sendError(res, 401, 'UNAUTHORIZED', '缺少或無效的工具 API 驗證資訊。');
        }

        const bucketKey = req.ip || 'unknown';
        const currentTime = Date.now();
        const windowMs = 60 * 1000;
        const limit = positiveInteger(env.TOOLS_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT, 1, 600);
        const bucket = rateBuckets.get(bucketKey);

        if (!bucket || currentTime - bucket.startedAt >= windowMs) {
            rateBuckets.set(bucketKey, { startedAt: currentTime, count: 1 });
        } else if (bucket.count >= limit) {
            res.set('Retry-After', String(Math.ceil((windowMs - (currentTime - bucket.startedAt)) / 1000)));
            return sendError(res, 429, 'RATE_LIMITED', '工具 API 請求過於頻繁，請稍後再試。');
        } else {
            bucket.count += 1;
        }

        next();
    });

    router.get('/time', (req, res) => {
        const current = now();
        const dateParts = getTaipeiDateParts(current);
        res.json({
            date: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
            weekday: dateParts.weekday,
            time: `${dateParts.hour}:${dateParts.minute}:${dateParts.second}`,
            iso_time: toTaipeiIso(current),
            timezone: 'Asia/Taipei',
            source: 'system_clock',
            updated_at: current.toISOString()
        });
    });

    router.get('/weather', asyncHandler(async (req, res) => {
        const location = requiredText(req.query.location, 'location', 40);
        const date = optionalDate(req.query.date);
        const language = optionalLanguage(req.query.language);
        requireEnv(env, ['CWA_API_KEY']);

        const cacheKey = stableKey('weather', { location, date, language });
        const cached = getCached(cache, cacheKey);
        if (cached) return res.json(cached);

        const response = await http.get('https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001', {
            params: { Authorization: env.CWA_API_KEY, locationName: location, format: 'JSON' },
            timeout: timeoutFromEnv(env)
        });
        const locationData = response.data?.records?.location?.[0];
        if (!locationData) throw apiError(404, 'WEATHER_NOT_FOUND', '查不到指定地點的天氣資料。');

        const selectedRange = selectWeatherRange(locationData.weatherElement || [], date);
        const result = {
            location: locationData.locationName || location,
            weather: selectedRange.Wx?.parameter?.parameterName || null,
            temperature: formatTemperature(selectedRange.MinT, selectedRange.MaxT),
            rain_probability: numberOrNull(selectedRange.PoP?.parameter?.parameterName),
            warning: null,
            source: '中央氣象署開放資料平台',
            updated_at: now().toISOString()
        };
        setCached(cache, cacheKey, result, CACHE_TTL.weather);
        res.json(result);
    }));

    router.get('/bus', asyncHandler(async (req, res) => {
        const city = requiredText(req.query.city, 'city', 30);
        if (!TAIWAN_CITIES.has(city)) {
            throw apiError(400, 'INVALID_CITY', 'city 必須使用 TDX 支援的英文縣市代碼。');
        }
        const route = optionalText(req.query.route, 'route', 30);
        const stop = optionalText(req.query.stop, 'stop', 60);
        const direction = optionalEnum(req.query.direction, 'direction', ['0', '1']);
        const latitude = optionalCoordinate(req.query.latitude, 'latitude', -90, 90);
        const longitude = optionalCoordinate(req.query.longitude, 'longitude', -180, 180);
        optionalLanguage(req.query.language);

        if ((latitude === null) !== (longitude === null)) {
            throw apiError(400, 'MISSING_COORDINATE', 'latitude 與 longitude 必須一起提供。');
        }
        if (!route && latitude === null) {
            throw apiError(400, 'MISSING_BUS_QUERY', '請提供 route，或同時提供 latitude 與 longitude 查詢附近站牌。');
        }
        requireEnv(env, ['TDX_CLIENT_ID', 'TDX_CLIENT_SECRET']);

        const cacheKey = stableKey('bus', { city, route, stop, direction, latitude, longitude });
        const cached = getCached(cache, cacheKey);
        if (cached) return res.json(cached);
        const token = await getTdxToken(http, env, () => tdxToken, (value) => { tdxToken = value; });
        const headers = { Authorization: `Bearer ${token}` };
        let result;

        if (route) {
            const encodedCity = encodeURIComponent(city);
            const encodedRoute = encodeURIComponent(route);
            const [routesResponse, stopsResponse, etaResponse] = await Promise.all([
                http.get(`https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/${encodedCity}`, {
                    headers,
                    params: { '$filter': `contains(RouteName/Zh_tw,'${escapeOData(route)}')`, '$format': 'JSON' },
                    timeout: timeoutFromEnv(env)
                }),
                http.get(`https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/${encodedCity}/${encodedRoute}`, {
                    headers, params: { '$format': 'JSON' }, timeout: timeoutFromEnv(env)
                }),
                http.get(`https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodedCity}/${encodedRoute}`, {
                    headers, params: { '$format': 'JSON' }, timeout: timeoutFromEnv(env)
                })
            ]);
            result = buildRouteResult(city, route, direction, stop, routesResponse.data, stopsResponse.data, etaResponse.data, now());
        } else {
            const nearbyResponse = await http.get('https://tdx.transportdata.tw/api/basic/v2/Bus/Station/NearBy', {
                headers,
                params: { '$spatialFilter': `nearby(${latitude},${longitude},500)`, '$format': 'JSON' },
                timeout: timeoutFromEnv(env)
            });
            result = {
                query_type: 'nearby_stops',
                city,
                radius_meters: 500,
                stops: (nearbyResponse.data || []).slice(0, 10).map((item) => ({
                    station_id: item.StationID || null,
                    name: localizedName(item.StationName),
                    address: item.StationAddress || null,
                    routes: (item.Stops || []).map((entry) => localizedName(entry.RouteName)).filter(Boolean)
                })),
                source: '交通部 TDX',
                updated_at: now().toISOString()
            };
        }

        setCached(cache, cacheKey, result, CACHE_TTL.bus);
        res.json(result);
    }));

    router.get('/food', asyncHandler(async (req, res) => {
        const location = optionalText(req.query.location, 'location', 100);
        const latitude = optionalCoordinate(req.query.latitude, 'latitude', -90, 90);
        const longitude = optionalCoordinate(req.query.longitude, 'longitude', -180, 180);
        const keyword = optionalText(req.query.keyword, 'keyword', 60);
        const budget = optionalText(req.query.budget, 'budget', 30);
        const dietary = optionalEnum(req.query.dietary, 'dietary', [...DIETARY_VALUES]);
        const openNow = optionalBoolean(req.query.open_now, 'open_now');
        const language = optionalLanguage(req.query.language);
        if ((latitude === null) !== (longitude === null)) {
            throw apiError(400, 'MISSING_COORDINATE', 'latitude 與 longitude 必須一起提供。');
        }
        if (!location && latitude === null) {
            throw apiError(400, 'MISSING_LOCATION', '請提供 location，或同時提供 latitude 與 longitude。');
        }
        if (dietary === 'allergy' && !keyword) {
            throw apiError(400, 'MISSING_ALLERGY_DETAIL', 'dietary=allergy 時，請在 keyword 說明需避開的過敏原。');
        }
        requireEnv(env, ['GOOGLE_MAPS_API_KEY']);
        enforcePlacesUsageLimit(placesUsage, env, now());

        const textQuery = [keyword || '餐廳 美食', dietaryKeyword(dietary), budget, location].filter(Boolean).join(' ');
        const body = { textQuery, pageSize: 5, languageCode: googleLanguage(language), regionCode: 'TW' };
        if (openNow !== null) body.openNow = openNow;
        if (latitude !== null) {
            body.locationBias = { circle: { center: { latitude, longitude }, radius: 3000 } };
        }

        const response = await http.post('https://places.googleapis.com/v1/places:searchText', body, {
            headers: {
                'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryTypeDisplayName,places.formattedAddress,places.location,places.rating,places.currentOpeningHours.openNow,places.googleMapsUri'
            },
            timeout: timeoutFromEnv(env)
        });
        const result = {
            results: (response.data?.places || []).slice(0, 5).map((place) => ({
                name: place.displayName?.text || null,
                category: place.primaryTypeDisplayName?.text || null,
                address: place.formattedAddress || null,
                distance: latitude === null || !place.location ? null : Math.round(haversineMeters(latitude, longitude, place.location.latitude, place.location.longitude)),
                rating: place.rating ?? null,
                open_now: place.currentOpeningHours?.openNow ?? null,
                maps_url: place.googleMapsUri || (place.id ? `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(place.id)}` : null),
                source: 'Google Places',
                updated_at: now().toISOString()
            })),
            dietary_notice: dietary ? '飲食條件為關鍵字篩選，請向店家再次確認食材與交叉污染風險。' : null,
            source: 'Google Places',
            updated_at: now().toISOString()
        };
        res.json(result);
    }));

    router.get('/news', asyncHandler(async (req, res) => {
        optionalText(req.query.category, 'category', 30);
        optionalText(req.query.keywords, 'keywords', 100);
        optionalLanguage(req.query.language);
        positiveInteger(req.query.limit, 5, 1, 10);
        throw apiError(501, 'NEWS_TOOL_NOT_CONFIGURED', '新聞搜尋第一階段請在 Dify Marketplace 使用合法的 Web Search 工具。');
    }));

    router.use((error, req, res, next) => {
        if (error.response) {
            const externalStatus = error.response.status;
            const externalError = error.response.data?.error;
            const externalCode = externalError?.status || externalError?.code || null;
            const externalMessage = typeof externalError?.message === 'string'
                ? externalError.message.slice(0, 300)
                : null;
            const status = externalStatus === 404 ? 404 : 502;
            console.error('TOOLS_API_ERROR', error.code || error.message, externalStatus || '', externalCode || '');
            return sendError(res, status, 'EXTERNAL_API_ERROR', '外部資料服務暫時無法使用，請稍後再試。', {
                provider_status: externalStatus || null,
                provider_code: externalCode,
                provider_message: externalMessage
            });
        }
        if (error && error.status) {
            return sendError(res, error.status, error.code, error.message, error.details);
        }
        console.error('TOOLS_API_ERROR', error.code || error.message);
        return sendError(res, 502, 'EXTERNAL_API_ERROR', '外部資料服務暫時無法使用，請稍後再試。');
    });

    return router;
}

function asyncHandler(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readToolsKey(req) {
    const xToolsKey = req.get('x-tools-key');
    if (xToolsKey) return xToolsKey;
    const authorization = req.get('authorization') || '';
    return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function apiError(status, code, message, details) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.details = details;
    return error;
}

function sendError(res, status, code, message, details) {
    return res.status(status).json({
        error: { code, message, details: details || null },
        timestamp: new Date().toISOString()
    });
}

function requireEnv(env, names) {
    const missing = names.filter((name) => !env[name]);
    if (missing.length) throw apiError(503, 'SERVICE_NOT_CONFIGURED', '此工具尚未完成外部資料服務設定。');
}

function requiredText(value, name, maxLength) {
    const parsed = optionalText(value, name, maxLength);
    if (!parsed) throw apiError(400, 'MISSING_PARAMETER', `缺少必要參數：${name}。`);
    return parsed;
}

function optionalText(value, name, maxLength) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value) || typeof value !== 'string') throw apiError(400, 'INVALID_PARAMETER', `${name} 格式不正確。`);
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001F]/.test(trimmed)) {
        throw apiError(400, 'INVALID_PARAMETER', `${name} 格式不正確。`);
    }
    return trimmed;
}

function optionalDate(value) {
    const parsed = optionalText(value, 'date', 10);
    if (!parsed) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00+08:00`))) {
        throw apiError(400, 'INVALID_DATE', 'date 必須是 YYYY-MM-DD。');
    }
    return parsed;
}

function optionalLanguage(value) {
    const parsed = optionalText(value, 'language', 10) || 'zh-TW';
    if (!SUPPORTED_LANGUAGES.has(parsed)) throw apiError(400, 'INVALID_LANGUAGE', '不支援指定的 language。');
    return parsed;
}

function optionalEnum(value, name, allowed) {
    const parsed = optionalText(value, name, 30);
    if (!parsed) return null;
    if (!allowed.includes(parsed)) throw apiError(400, 'INVALID_PARAMETER', `${name} 不在允許範圍內。`);
    return parsed;
}

function optionalBoolean(value, name) {
    if (value === undefined || value === null || value === '') return null;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw apiError(400, 'INVALID_PARAMETER', `${name} 必須是 true 或 false。`);
}

function optionalCoordinate(value, name, min, max) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw apiError(400, 'INVALID_PARAMETER', `${name} 超出有效範圍。`);
    return parsed;
}

function positiveInteger(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw apiError(400, 'INVALID_PARAMETER', `數值必須介於 ${min} 與 ${max}。`);
    return parsed;
}

function timeoutFromEnv(env) {
    return positiveInteger(env.TOOLS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30000);
}

function enforcePlacesUsageLimit(usage, env, currentDate) {
    const dailyLimit = positiveInteger(env.GOOGLE_PLACES_DAILY_LIMIT, 100, 1, 10000);
    const minuteLimit = positiveInteger(env.GOOGLE_PLACES_RATE_LIMIT_PER_MINUTE, 10, 1, 600);
    const taipei = getTaipeiDateParts(currentDate);
    const dayKey = `${taipei.year}-${taipei.month}-${taipei.day}`;
    const minuteKey = Math.floor(currentDate.getTime() / 60000);

    if (usage.day !== dayKey) {
        usage.day = dayKey;
        usage.dayCount = 0;
    }
    if (usage.minute !== minuteKey) {
        usage.minute = minuteKey;
        usage.minuteCount = 0;
    }
    if (usage.dayCount >= dailyLimit) {
        throw apiError(429, 'PLACES_DAILY_LIMIT_REACHED', '今日餐廳查詢額度已達上限，請明日再試。');
    }
    if (usage.minuteCount >= minuteLimit) {
        throw apiError(429, 'PLACES_RATE_LIMITED', '餐廳查詢過於頻繁，請稍後再試。');
    }

    usage.dayCount += 1;
    usage.minuteCount += 1;
}

function stableKey(prefix, values) {
    return `${prefix}:${crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function getCached(cache, key) {
    const item = cache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return item.value;
}

function setCached(cache, key, value, ttl) {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function getTaipeiDateParts(date) {
    const parts = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function toTaipeiIso(date) {
    const parts = getTaipeiDateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function selectWeatherRange(elements, requestedDate) {
    const result = {};
    for (const element of elements) {
        const ranges = element.time || [];
        const selected = requestedDate
            ? ranges.find((range) => String(range.startTime || '').startsWith(requestedDate))
            : ranges[0];
        result[element.elementName] = selected || null;
    }
    if (requestedDate && !result.Wx) throw apiError(404, 'WEATHER_DATE_NOT_AVAILABLE', '指定日期不在目前可查詢的天氣預報範圍內。');
    return result;
}

function formatTemperature(minRange, maxRange) {
    const min = numberOrNull(minRange?.parameter?.parameterName);
    const max = numberOrNull(maxRange?.parameter?.parameterName);
    return { min, max, unit: 'C' };
}

function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function escapeOData(value) {
    return String(value).replace(/'/g, "''");
}

async function getTdxToken(http, env, readToken, writeToken) {
    const existing = readToken();
    if (existing && existing.expiresAt > Date.now() + 60000) return existing.value;
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.TDX_CLIENT_ID,
        client_secret: env.TDX_CLIENT_SECRET
    });
    const response = await http.post('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: timeoutFromEnv(env)
    });
    const token = { value: response.data.access_token, expiresAt: Date.now() + ((response.data.expires_in || 3600) * 1000) };
    writeToken(token);
    return token.value;
}

function buildRouteResult(city, route, direction, stop, routes, stops, arrivals, currentDate) {
    const selectedStops = (stops || []).filter((item) => direction === null || String(item.Direction) === direction);
    const stopIds = new Set(selectedStops.flatMap((item) => (item.Stops || []).filter((entry) => !stop || localizedName(entry.StopName)?.includes(stop)).map((entry) => entry.StopUID)));
    return {
        query_type: 'route',
        city,
        route,
        routes: (routes || []).slice(0, 10).map((item) => ({
            route_uid: item.RouteUID || null,
            name: localizedName(item.RouteName),
            departure_stop: localizedName(item.DepartureStopNameZh || item.DepartureStopName),
            destination_stop: localizedName(item.DestinationStopNameZh || item.DestinationStopName)
        })),
        directions: selectedStops.map((item) => ({
            direction: item.Direction,
            direction_label: item.Direction === 0 ? '去程' : item.Direction === 1 ? '返程' : '未知',
            stops: (item.Stops || []).filter((entry) => !stop || localizedName(entry.StopName)?.includes(stop)).map((entry) => ({
                stop_uid: entry.StopUID || null,
                name: localizedName(entry.StopName),
                sequence: entry.StopSequence ?? null
            }))
        })),
        arrivals: (arrivals || []).filter((item) => (!direction || String(item.Direction) === direction) && (!stop || stopIds.has(item.StopUID))).slice(0, 20).map((item) => ({
            stop_uid: item.StopUID || null,
            stop_name: localizedName(item.StopName),
            direction: item.Direction ?? null,
            estimate_seconds: item.EstimateTime ?? null,
            stop_status: item.StopStatus ?? null,
            plate_number: item.PlateNumb || null
        })),
        planning_notice: '本工具提供路線、方向、站牌與預估到站資訊；若要規劃轉乘，請另提供明確出發站、目的站與縣市。',
        source: '交通部 TDX',
        updated_at: currentDate.toISOString()
    };
}

function localizedName(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    return value.Zh_tw || value.En || null;
}

function dietaryKeyword(value) {
    return {
        vegetarian: '素食', vegan: '純素', halal: '清真 halal',
        no_pork: '不含豬肉', no_beef: '不含牛肉', allergy: '過敏友善'
    }[value] || '';
}

function googleLanguage(language) {
    return ({ my: 'my', lo: 'lo' })[language] || language || 'zh-TW';
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const earthRadius = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildOpenApiDocument(serverUrl) {
    const parameters = {
        language: { name: 'language', in: 'query', schema: { type: 'string', enum: [...SUPPORTED_LANGUAGES], default: 'zh-TW' } },
        latitude: { name: 'latitude', in: 'query', schema: { type: 'number', minimum: -90, maximum: 90 } },
        longitude: { name: 'longitude', in: 'query', schema: { type: 'number', minimum: -180, maximum: 180 } }
    };
    const operation = (operationId, summary, description, params) => ({
        operationId, summary, description, security: [{ ToolsKey: [] }, { BearerAuth: [] }],
        parameters: params,
        responses: {
            200: { description: '成功', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
            400: { description: '輸入參數錯誤' }, 401: { description: '驗證失敗' }, 429: { description: '請求過於頻繁' }, 502: { description: '外部服務錯誤' }
        }
    });
    return {
        openapi: '3.0.3',
        info: { title: 'Taiwan Student Life Tools', version: '1.0.0', description: '世紀綠能工商實習處 Dify Agent 即時臺灣生活資訊工具。' },
        servers: [{ url: serverUrl }],
        paths: {
            '/api/tools/time': { get: operation('get_taiwan_time', '取得臺灣目前日期與時間', '需要回答臺灣目前日期、星期或時間時使用。', []) },
            '/api/tools/weather': { get: operation('get_taiwan_weather', '查詢臺灣天氣', '查詢中央氣象署今明 36 小時縣市預報；location 請使用縣市名稱。', [
                { name: 'location', in: 'query', required: true, schema: { type: 'string', maxLength: 40 } },
                { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, parameters.language
            ]) },
            '/api/tools/bus': { get: operation('search_taiwan_bus', '查詢臺灣公車路線、站牌與到站資訊', '使用 TDX 查路線時提供 route；查附近站牌時同時提供經緯度。不可用本工具捏造完整轉乘方案。', [
                { name: 'city', in: 'query', required: true, schema: { type: 'string', enum: [...TAIWAN_CITIES] } },
                { name: 'route', in: 'query', schema: { type: 'string' } }, { name: 'stop', in: 'query', schema: { type: 'string' } },
                { name: 'direction', in: 'query', schema: { type: 'string', enum: ['0', '1'] } }, parameters.latitude, parameters.longitude, parameters.language
            ]) },
            '/api/tools/food': { get: operation('search_nearby_food', '搜尋附近餐廳', '使用 Google Places 搜尋最多 5 筆餐廳；飲食限制結果仍須向店家確認。', [
                { name: 'location', in: 'query', schema: { type: 'string' } }, parameters.latitude, parameters.longitude,
                { name: 'keyword', in: 'query', schema: { type: 'string' } }, { name: 'budget', in: 'query', schema: { type: 'string' } },
                { name: 'dietary', in: 'query', schema: { type: 'string', enum: [...DIETARY_VALUES] } },
                { name: 'open_now', in: 'query', schema: { type: 'boolean' } }, parameters.language
            ]) },
            '/api/tools/news': { get: operation('search_taiwan_news', '搜尋臺灣新聞（第一階段由 Dify Web Search 執行）', '此端點第一階段不執行搜尋；Agent 應改用 Dify Marketplace 合法 Web Search 工具。', [
                { name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'keywords', in: 'query', schema: { type: 'string' } },
                parameters.language, { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, minimum: 1, maximum: 10 } }
            ]) }
        },
        components: { securitySchemes: {
            ToolsKey: { type: 'apiKey', in: 'header', name: 'X-Tools-Key' },
            BearerAuth: { type: 'http', scheme: 'bearer' }
        } }
    };
}

module.exports = { createToolsRouter, buildOpenApiDocument };
