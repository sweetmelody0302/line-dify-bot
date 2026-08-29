const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const axios = require('axios');
const TEST_CLOUDINARY_VERSION = '1787461200';

process.env.LINE_CHANNEL_SECRET = 'test-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token';
process.env.REMOTE_LINE_CHANNEL_SECRET = 'test-remote-secret';
process.env.REMOTE_LINE_CHANNEL_ACCESS_TOKEN = 'test-remote-token';
process.env.INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN = 'test-internship-line-token';
process.env.DIFY_API_KEY = 'test-dify-key';
process.env.TOOLS_API_KEY = 'test-tools-key';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-cloud-key';
process.env.CLOUDINARY_API_SECRET = 'test-cloud-secret';

const calls = [];
const originalPost = axios.post;
const originalGet = axios.get;
axios.post = async (url, body) => {
    calls.push({ url, body });
    if (url.includes('dify.ai')) {
        const stream = new PassThrough();
        setImmediate(() => {
            stream.end('data: {"event":"agent_message","answer":"測試回答✅"}\n\n');
        });
        return { data: stream };
    }
    if (url.includes('api.cloudinary.com') && url.includes('/raw/upload')) {
        return { data: { version: TEST_CLOUDINARY_VERSION } };
    }
    return { data: {} };
};
axios.get = async (url) => {
    calls.push({ url, method: 'get' });
    if (url.includes('res.cloudinary.com')) {
        return {
            data: {
                text: '測試最新公告',
                images: [{
                    originalContentUrl: 'https://example.com/announcement.jpg',
                    previewImageUrl: 'https://example.com/announcement.jpg'
                }, {
                    originalContentUrl: 'https://example.com/announcement-2.jpg',
                    previewImageUrl: 'https://example.com/announcement-2.jpg'
                }],
                publishedAt: '2026-07-21T01:00:00.000Z'
            }
        };
    }
    return originalGet(url);
};

const app = require('../index');
let server;
let baseUrl;

test.before(async () => {
    server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    axios.post = originalPost;
    axios.get = originalGet;
    await new Promise((resolve) => server.close(resolve));
});

function signature(rawBody, channelSecret = process.env.LINE_CHANNEL_SECRET) {
    return crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

async function webhook(body, validSignature = true) {
    const rawBody = JSON.stringify(body);
    return fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-line-signature': validSignature ? signature(rawBody) : 'invalid'
        },
        body: rawBody
    });
}

async function remoteWebhook(body) {
    const rawBody = JSON.stringify(body);
    return fetch(`${baseUrl}/remote-webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-line-signature': signature(rawBody, process.env.REMOTE_LINE_CHANNEL_SECRET)
        },
        body: rawBody
    });
}

test('webhook signature verification remains active', async () => {
    const response = await webhook({ events: [] }, false);
    assert.equal(response.status, 401);
});

test('follow event replies with two welcome messages', async () => {
    calls.length = 0;
    const response = await webhook({ events: [{ type: 'follow', replyToken: 'follow-token', source: { type: 'user', userId: 'U1' } }] });
    assert.equal(response.status, 200);
    const reply = calls.find((call) => call.url.includes('/message/reply'));
    assert.equal(reply.body.messages.length, 2);
});

test('text message still calls Dify and LINE Reply API', async () => {
    calls.length = 0;
    const response = await webhook({ events: [{
        type: 'message', replyToken: 'message-token', source: { type: 'user', userId: 'U2' },
        message: { id: 'M1', type: 'text', text: '實習手冊如何領取？' }
    }] });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(calls.some((call) => call.url.includes('dify.ai/v1/chat-messages')));
    assert.ok(calls.some((call) => call.url.includes('/message/reply')));
});

test('duplicate webhook event is processed only once', async () => {
    calls.length = 0;
    const event = {
        type: 'message',
        webhookEventId: 'duplicate-event-1',
        deliveryContext: { isRedelivery: false },
        replyToken: 'duplicate-token-1',
        source: { type: 'user', userId: 'U-DUPLICATE-1' },
        message: { id: 'M-DUPLICATE-1', type: 'text', text: '重複事件測試' }
    };

    const firstResponse = await webhook({ events: [event] });
    const secondResponse = await webhook({ events: [{
        ...event,
        replyToken: 'duplicate-token-2',
        deliveryContext: { isRedelivery: true }
    }] });

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.filter((call) => call.url.includes('dify.ai/v1/chat-messages')).length, 1);
});

test('rapid identical text from the same user is processed only once', async () => {
    calls.length = 0;
    const createEvent = (eventNumber) => ({
        type: 'message',
        webhookEventId: `rapid-event-${eventNumber}`,
        replyToken: `rapid-token-${eventNumber}`,
        source: { type: 'user', userId: 'U-RAPID-1' },
        message: { id: `M-RAPID-${eventNumber}`, type: 'text', text: '短時間重複問題測試' }
    });

    const firstResponse = await webhook({ events: [createEvent(1)] });
    const secondResponse = await webhook({ events: [createEvent(2)] });

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.filter((call) => call.url.includes('dify.ai/v1/chat-messages')).length, 1);
});

test('different text from the same user still processes normally', async () => {
    calls.length = 0;
    const createEvent = (eventNumber, text) => ({
        type: 'message',
        webhookEventId: `different-event-${eventNumber}`,
        replyToken: `different-token-${eventNumber}`,
        source: { type: 'user', userId: 'U-RAPID-2' },
        message: { id: `M-DIFFERENT-${eventNumber}`, type: 'text', text }
    });

    const firstResponse = await webhook({ events: [createEvent(1, '第一個問題')] });
    const secondResponse = await webhook({ events: [createEvent(2, '第二個問題')] });

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.filter((call) => call.url.includes('dify.ai/v1/chat-messages')).length, 2);
});

test('latest announcement replies directly without calling Dify', async () => {
    calls.length = 0;
    const response = await webhook({ events: [{
        type: 'message', replyToken: 'latest-announcement-token', source: { type: 'user', userId: 'U6' },
        message: { id: 'M7', type: 'text', text: '最新公告' }
    }] });

    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.some((call) => call.url.includes('dify.ai/v1/chat-messages')), false);
    const reply = calls.find((call) => call.body?.replyToken === 'latest-announcement-token');
    assert.equal(reply.body.messages.length, 3);
    assert.match(reply.body.messages[0].text, /測試最新公告/);
    assert.equal(reply.body.messages[1].type, 'image');
    assert.equal(reply.body.messages[2].type, 'image');
    const cloudinaryRead = calls.find((call) => call.method === 'get' && call.url.includes('res.cloudinary.com'));
    assert.match(cloudinaryRead.url, /\/raw\/upload\/v\d+\/line-remote-publisher\/latest-announcement\.json$/);
});

test('remote publisher can sync latest announcement without broadcasting', async () => {
    calls.length = 0;
    const userId = 'REMOTE-U1';

    const draftResponse = await remoteWebhook({ events: [{
        type: 'message', replyToken: 'remote-draft-token', source: { type: 'user', userId },
        message: { id: 'RM1', type: 'text', text: '補登最新公告測試' }
    }] });
    assert.equal(draftResponse.status, 200);

    calls.length = 0;
    const syncResponse = await remoteWebhook({ events: [{
        type: 'message', replyToken: 'remote-sync-token', source: { type: 'user', userId },
        message: { id: 'RM2', type: 'text', text: '同步最新公告' }
    }] });
    assert.equal(syncResponse.status, 200);

    const cloudinarySave = calls.find((call) => call.url.includes('/raw/upload'));
    const broadcast = calls.find((call) => call.url.includes('/message/broadcast'));
    const reply = calls.find((call) => call.body?.replyToken === 'remote-sync-token');

    assert.ok(cloudinarySave);
    assert.equal(cloudinarySave.body.get('invalidate'), 'true');
    assert.equal(broadcast, undefined);
    assert.match(reply.body.messages[0].text, /沒有發送給官方帳號好友/);

    calls.length = 0;
    const latestResponse = await webhook({ events: [{
        type: 'message', replyToken: 'latest-after-sync-token', source: { type: 'user', userId: 'U7' },
        message: { id: 'M8', type: 'text', text: '最新公告' }
    }] });
    assert.equal(latestResponse.status, 200);
    const versionedRead = calls.find((call) => call.method === 'get' && call.url.includes('res.cloudinary.com'));
    assert.match(versionedRead.url, new RegExp(`/raw/upload/v${TEST_CLOUDINARY_VERSION}/`));
});

test('nearby query offers LINE location quick reply and uses location once', async () => {
    calls.length = 0;
    const quickReplyResponse = await webhook({ events: [{
        type: 'message', replyToken: 'nearby-token', source: { type: 'user', userId: 'U3' },
        message: { id: 'M2', type: 'text', text: '附近美食' }
    }] });
    assert.equal(quickReplyResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const quickReply = calls.find((call) => call.body?.replyToken === 'nearby-token');
    assert.equal(quickReply.body.messages[0].quickReply.items[0].action.type, 'location');

    calls.length = 0;
    const locationResponse = await webhook({ events: [{
        type: 'message', replyToken: 'location-token', source: { type: 'user', userId: 'U3' },
        message: { id: 'M3', type: 'location', latitude: 25.01, longitude: 121.01, address: '桃園市測試路' }
    }] });
    assert.equal(locationResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const difyCall = calls.find((call) => call.url.includes('dify.ai/v1/chat-messages'));
    assert.match(difyCall.body.query, /latitude=25\.01, longitude=121\.01/);
});

test('nearby healthcare query offers location quick reply and forwards location to Dify', async () => {
    calls.length = 0;
    const quickReplyResponse = await webhook({ events: [{
        type: 'message', replyToken: 'healthcare-token', source: { type: 'user', userId: 'U4' },
        message: { id: 'M4', type: 'text', text: '附近有現在營業的診所嗎？' }
    }] });
    assert.equal(quickReplyResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const quickReply = calls.find((call) => call.body?.replyToken === 'healthcare-token');
    assert.equal(quickReply.body.messages[0].quickReply.items[0].action.type, 'location');
    assert.equal(quickReply.body.messages[0].quickReply.items[1].action.text, '手動輸入地點');

    calls.length = 0;
    const locationResponse = await webhook({ events: [{
        type: 'message', replyToken: 'healthcare-location-token', source: { type: 'user', userId: 'U4' },
        message: { id: 'M5', type: 'location', latitude: 24.99, longitude: 121.34, address: '桃園市測試地址' }
    }] });
    assert.equal(locationResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const difyCall = calls.find((call) => call.url.includes('dify.ai/v1/chat-messages'));
    assert.match(difyCall.body.query, /附近有現在營業的診所嗎/);
    assert.match(difyCall.body.query, /latitude=24\.99, longitude=121\.34/);
});

test('nearby healthcare query with an explicit location goes directly to Dify', async () => {
    calls.length = 0;
    const response = await webhook({ events: [{
        type: 'message', replyToken: 'explicit-healthcare-token', source: { type: 'user', userId: 'U5' },
        message: {
            id: 'M6',
            type: 'text',
            text: '請幫我找世紀綠能工商附近的診所，限定龜山區，最多5間'
        }
    }] });

    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const difyCall = calls.find((call) => call.url.includes('dify.ai/v1/chat-messages'));
    const lineReply = calls.find((call) => call.body?.replyToken === 'explicit-healthcare-token');
    assert.ok(difyCall);
    assert.match(difyCall.body.query, /世紀綠能工商附近的診所/);
    assert.equal(lineReply.body.messages[0].quickReply, undefined);
});
