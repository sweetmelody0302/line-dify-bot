const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const axios = require('axios');

process.env.LINE_CHANNEL_SECRET = 'test-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token';
process.env.DIFY_API_KEY = 'test-dify-key';
process.env.TOOLS_API_KEY = 'test-tools-key';

const calls = [];
const originalPost = axios.post;
axios.post = async (url, body) => {
    calls.push({ url, body });
    if (url.includes('dify.ai')) {
        const stream = new PassThrough();
        setImmediate(() => {
            stream.end('data: {"event":"agent_message","answer":"測試回答✅"}\n\n');
        });
        return { data: stream };
    }
    return { data: {} };
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
    await new Promise((resolve) => server.close(resolve));
});

function signature(rawBody) {
    return crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
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
