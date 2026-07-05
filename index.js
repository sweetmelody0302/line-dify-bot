const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// 環境變數
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const REMOTE_LINE_CHANNEL_ACCESS_TOKEN = process.env.REMOTE_LINE_CHANNEL_ACCESS_TOKEN;
const REMOTE_LINE_CHANNEL_SECRET = process.env.REMOTE_LINE_CHANNEL_SECRET;
const INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN = process.env.INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN || LINE_CHANNEL_ACCESS_TOKEN;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const LINE_REPLY_API_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_LOADING_API_URL = 'https://api.line.me/v2/bot/chat/loading/start';
const LINE_BROADCAST_API_URL = 'https://api.line.me/v2/bot/message/broadcast';
const LINE_CONTENT_API_BASE_URL = 'https://api-data.line.me/v2/bot/message';
const CLOUDINARY_UPLOAD_FOLDER = 'line-remote-publisher';
const REMOTE_DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
const REMOTE_MAX_IMAGES = 4;
const LINE_TEXT_LIMIT = 5000;
const remoteDrafts = new Map();

const FOLLOW_WELCOME_MESSAGES = [
    {
        type: 'text',
        text: `歡迎加入「世紀綠能工商實習處」官方帳號。

我是實習處 AI 秘書，可以協助您查詢實習、建教合作與就業輔導相關問題。

請直接使用您的語言輸入問題，我會盡量使用相同語言回覆。

Welcome. You may ask your question in your own language.

Xin chào. Bạn có thể đặt câu hỏi bằng ngôn ngữ của bạn.

สวัสดี คุณสามารถถามด้วยภาษาของคุณได้

မင်္ဂလာပါ။ သင့်ဘာသာစကားဖြင့် မေးနိုင်ပါသည်။

Halo. Anda dapat bertanya dalam bahasa Anda.

ສະບາຍດີ ທ່ານສາມາດຖາມເປັນພາສາຂອງທ່ານໄດ້.

Selamat datang. Anda boleh bertanya dalam bahasa anda.

こんにちは。ご自身の言語で質問できます。`
    },
    {
        type: 'text',
        text: `常用服務 / Services：

1. 實習組 Internship
校外實習、實習手冊、實習時數採認

2. 建教組 Cooperative Education
建教合作班、輪調時程、建教生權益

3. 就業輔導組 Career Guidance
就業媒合、校園徵才、履歷修改

學校總機 / School Phone：
(03) 3294188

實習處主任 程主任：601
實習處組長：607
建教組：602
就業輔導組：608

您也可以點選下方選單，快速查詢相關服務。`
    }
];

function lineHeaders(accessToken = LINE_CHANNEL_ACCESS_TOKEN) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };
}

function isValidLineSignature(req, channelSecret = LINE_CHANNEL_SECRET) {
    const signature = req.get('x-line-signature');

    if (!channelSecret || !signature || !req.rawBody) {
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', channelSecret)
        .update(req.rawBody)
        .digest('base64');

    const expectedBuffer = Buffer.from(expectedSignature);
    const signatureBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== signatureBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

// 接收 LINE 訊息的 Webhook 端點
app.post('/webhook', async (req, res) => {
    try {
        if (!isValidLineSignature(req)) {
            console.error('LINE_WEBHOOK_ERROR', 'Invalid LINE signature');
            return res.status(401).send('Invalid signature');
        }

        const events = req.body.events || [];
        if (events.length === 0) {
            return res.status(200).send('OK');
        }

        const followReplyTasks = [];

        for (const event of events) {
            if (event.type === 'follow') {
                followReplyTasks.push(handleFollow(event));
                continue;
            }

            // 只處理文字訊息，原本 message event -> Dify 流程維持不變
            if (event.type === 'message' && event.message && event.message.type === 'text') {
                console.log('LINE_MESSAGE_EVENT_RECEIVED');

                const userMessage = event.message.text;
                const replyToken = event.replyToken;
                const userId = event.source.userId;

                // 啟動大腦思考流程
                handleMessage(userMessage, replyToken, userId);
            }
        }

        await Promise.all(followReplyTasks);

        // 【重要修正】收到 LINE 訊息後回覆 OK，避免 LINE 覺得我們沒反應而引發錯誤
        return res.status(200).send('OK');
    } catch (error) {
        console.error('LINE_WEBHOOK_ERROR', error.response?.data || error.message);
        return res.status(500).send('ERROR');
    }
});

// follow event 直接回覆歡迎訊息，不送去 Dify
async function handleFollow(event) {
    await axios.post(LINE_REPLY_API_URL, {
        replyToken: event.replyToken,
        messages: FOLLOW_WELCOME_MESSAGES
    }, {
        headers: lineHeaders()
    });

    console.log('FOLLOW_WELCOME_REPLY_SENT');
}

// 發文遙控器 Webhook：建立草稿、預覽、確認後廣播到實習處官方帳號
app.post('/remote-webhook', async (req, res) => {
    try {
        if (!isValidLineSignature(req, REMOTE_LINE_CHANNEL_SECRET)) {
            console.error('REMOTE_WEBHOOK_ERROR', 'Invalid LINE signature');
            return res.status(401).send('Invalid signature');
        }

        const events = req.body.events || [];
        const tasks = events.map((event) => handleRemoteEvent(event));
        await Promise.all(tasks);

        return res.status(200).send('OK');
    } catch (error) {
        console.error('REMOTE_WEBHOOK_ERROR', error.response?.data || error.message);
        return res.status(500).send('ERROR');
    }
});

async function handleRemoteEvent(event) {
    if (event.type !== 'message' || !event.replyToken || !event.source?.userId) {
        return;
    }

    const message = event.message;

    if (message.type === 'text') {
        await handleRemoteText(event.replyToken, event.source.userId, message.text);
        return;
    }

    if (message.type === 'image') {
        await handleRemoteImage(event.replyToken, event.source.userId, message.id);
        return;
    }

    await replyRemoteText(event.replyToken, '目前發文遙控器只支援文字與圖片。請傳送公告文字或圖片。');
}

async function handleRemoteText(replyToken, userId, text) {
    const trimmedText = (text || '').trim();

    if (!trimmedText) {
        await replyRemoteText(replyToken, '請輸入公告文字，或傳送圖片。');
        return;
    }

    if (trimmedText === '開始發文') {
        remoteDrafts.set(userId, createRemoteDraft());
        await replyRemoteText(replyToken, '已開始新的發文草稿。\n\n請傳送公告文字與圖片。完成後請輸入「預覽」。');
        return;
    }

    if (trimmedText === '取消') {
        remoteDrafts.delete(userId);
        await replyRemoteText(replyToken, '已取消並清除目前的發文草稿。');
        return;
    }

    if (trimmedText === '預覽') {
        await replyRemotePreview(replyToken, userId);
        return;
    }

    if (trimmedText === '確認發佈' || trimmedText === '確認發佈到全部好友') {
        await publishRemoteDraft(replyToken, userId);
        return;
    }

    if (trimmedText.length > LINE_TEXT_LIMIT) {
        await replyRemoteText(replyToken, '這段文字太長，LINE 單則文字上限約 5000 字。請縮短公告內容後再傳送。');
        return;
    }

    const draft = getRemoteDraft(userId);
    draft.textParts.push(trimmedText);
    draft.updatedAt = Date.now();

    console.log('REMOTE_DRAFT_TEXT_ADDED');
    await replyRemoteText(replyToken, '已加入公告文字。\n\n如果還有圖片，請繼續傳送圖片。\n如果已完成，請輸入「預覽」。');
}

async function handleRemoteImage(replyToken, userId, messageId) {
    const missingConfig = getMissingRemoteImageConfig();
    if (missingConfig.length > 0) {
        console.error('REMOTE_WEBHOOK_ERROR', `Missing config: ${missingConfig.join(', ')}`);
        await replyRemoteText(replyToken, '圖片發佈功能尚未設定完成，請先確認 Cloudinary 與發文遙控器環境變數。');
        return;
    }

    const draft = getRemoteDraft(userId);
    if (draft.images.length >= REMOTE_MAX_IMAGES) {
        await replyRemoteText(replyToken, `目前最多支援 ${REMOTE_MAX_IMAGES} 張圖片。若要更換圖片，請輸入「取消」後重新建立草稿。`);
        return;
    }

    try {
        const image = await downloadRemoteLineImage(messageId);
        const uploadedImage = await uploadImageToCloudinary(image);

        draft.images.push({
            originalContentUrl: uploadedImage.secureUrl,
            previewImageUrl: uploadedImage.secureUrl
        });
        draft.updatedAt = Date.now();

        console.log('REMOTE_DRAFT_IMAGE_ADDED');
        await replyRemoteText(replyToken, `已收到並儲存圖片，目前草稿共有 ${draft.images.length} 張圖片。\n\n如果已完成，請輸入「預覽」。`);
    } catch (error) {
        console.error('REMOTE_WEBHOOK_ERROR', error.response?.data || error.message);
        await replyRemoteText(replyToken, '圖片處理失敗，請稍後再傳一次圖片。');
    }
}

async function replyRemotePreview(replyToken, userId) {
    const draft = remoteDrafts.get(userId);

    if (!hasRemoteDraftContent(draft)) {
        await replyRemoteText(replyToken, '目前沒有可預覽的發文草稿。\n\n請先傳送公告文字或圖片。');
        return;
    }

    const draftText = getRemoteDraftText(draft) || '未加入文字';
    const previewTextBody = draftText.length > 3000
        ? `${draftText.slice(0, 3000)}\n...（文字較長，預覽已截短）`
        : draftText;
    const previewText = `發文預覽\n\n文字：\n${previewTextBody}\n\n圖片：已收到 ${draft.images.length} 張，圖片會在下一則訊息顯示。\n\n若確認要發佈到「實習處 LINE 官方帳號」所有好友，請輸入：\n確認發佈\n\n若不要發佈，請輸入：\n取消`;
    const previewMessages = buildRemotePreviewMessages(previewText, draft.images);

    await replyRemoteMessages(replyToken, previewMessages);
}

async function publishRemoteDraft(replyToken, userId) {
    const missingConfig = getMissingRemotePublishConfig();
    if (missingConfig.length > 0) {
        console.error('REMOTE_WEBHOOK_ERROR', `Missing config: ${missingConfig.join(', ')}`);
        await replyRemoteText(replyToken, '發佈功能尚未設定完成，請先確認 Zeabur 環境變數。');
        return;
    }

    const draft = remoteDrafts.get(userId);
    if (!hasRemoteDraftContent(draft)) {
        await replyRemoteText(replyToken, '目前沒有可發佈的草稿。\n\n請先傳送公告文字或圖片。');
        return;
    }

    const messages = buildRemoteBroadcastMessages(draft);

    await axios.post(LINE_BROADCAST_API_URL, {
        messages
    }, {
        headers: lineHeaders(INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN)
    });

    remoteDrafts.delete(userId);
    console.log('REMOTE_BROADCAST_SENT');
    await replyRemoteText(replyToken, `已發佈到實習處 LINE 官方帳號所有好友。\n\n本次發佈內容：${messages.length} 則訊息。`);
}

function createRemoteDraft() {
    return {
        textParts: [],
        images: [],
        updatedAt: Date.now()
    };
}

function getRemoteDraft(userId) {
    cleanupRemoteDrafts();

    if (!remoteDrafts.has(userId)) {
        remoteDrafts.set(userId, createRemoteDraft());
    }

    return remoteDrafts.get(userId);
}

function cleanupRemoteDrafts() {
    const now = Date.now();
    for (const [userId, draft] of remoteDrafts.entries()) {
        if (now - draft.updatedAt > REMOTE_DRAFT_TTL_MS) {
            remoteDrafts.delete(userId);
        }
    }
}

function hasRemoteDraftContent(draft) {
    return Boolean(draft && (draft.textParts.length > 0 || draft.images.length > 0));
}

function getRemoteDraftText(draft) {
    return draft.textParts.join('\n\n').replace(/\*\*/g, '').trim();
}

function buildRemoteBroadcastMessages(draft) {
    const messages = [];
    const text = getRemoteDraftText(draft);

    if (text) {
        messages.push({
            type: 'text',
            text: text.slice(0, LINE_TEXT_LIMIT)
        });
    }

    for (const image of draft.images) {
        messages.push({
            type: 'image',
            originalContentUrl: image.originalContentUrl,
            previewImageUrl: image.previewImageUrl
        });
    }

    return messages.slice(0, 5);
}

function buildRemotePreviewMessages(previewText, images) {
    const messages = [{
        type: 'text',
        text: previewText
    }];

    for (const image of images.slice(0, REMOTE_MAX_IMAGES)) {
        messages.push({
            type: 'image',
            originalContentUrl: image.originalContentUrl,
            previewImageUrl: image.previewImageUrl
        });
    }

    return messages.slice(0, 5);
}

async function replyRemoteText(replyToken, text) {
    await replyRemoteMessages(replyToken, [{
        type: 'text',
        text
    }]);
}

async function replyRemoteMessages(replyToken, messages) {
    if (!REMOTE_LINE_CHANNEL_ACCESS_TOKEN) {
        console.error('REMOTE_WEBHOOK_ERROR', 'Missing REMOTE_LINE_CHANNEL_ACCESS_TOKEN');
        return;
    }

    await axios.post(LINE_REPLY_API_URL, {
        replyToken,
        messages
    }, {
        headers: lineHeaders(REMOTE_LINE_CHANNEL_ACCESS_TOKEN)
    });
}

async function downloadRemoteLineImage(messageId) {
    const response = await axios.get(`${LINE_CONTENT_API_BASE_URL}/${messageId}/content`, {
        headers: {
            'Authorization': `Bearer ${REMOTE_LINE_CHANNEL_ACCESS_TOKEN}`
        },
        responseType: 'arraybuffer'
    });

    return {
        buffer: Buffer.from(response.data),
        contentType: response.headers['content-type'] || 'image/jpeg'
    };
}

async function uploadImageToCloudinary(image) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const paramsToSign = {
        folder: CLOUDINARY_UPLOAD_FOLDER,
        timestamp
    };
    const signature = createCloudinarySignature(paramsToSign);
    const body = new URLSearchParams();

    body.append('file', `data:${image.contentType};base64,${image.buffer.toString('base64')}`);
    body.append('folder', CLOUDINARY_UPLOAD_FOLDER);
    body.append('timestamp', timestamp);
    body.append('api_key', CLOUDINARY_API_KEY);
    body.append('signature', signature);

    const response = await axios.post(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
        body,
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxBodyLength: Infinity
        }
    );

    return {
        secureUrl: response.data.secure_url
    };
}

function createCloudinarySignature(params) {
    const signatureBase = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');

    return crypto
        .createHash('sha1')
        .update(signatureBase + CLOUDINARY_API_SECRET)
        .digest('hex');
}

function getMissingRemoteImageConfig() {
    return [
        ['REMOTE_LINE_CHANNEL_ACCESS_TOKEN', REMOTE_LINE_CHANNEL_ACCESS_TOKEN],
        ['CLOUDINARY_CLOUD_NAME', CLOUDINARY_CLOUD_NAME],
        ['CLOUDINARY_API_KEY', CLOUDINARY_API_KEY],
        ['CLOUDINARY_API_SECRET', CLOUDINARY_API_SECRET]
    ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
}

function getMissingRemotePublishConfig() {
    return [
        ['REMOTE_LINE_CHANNEL_ACCESS_TOKEN', REMOTE_LINE_CHANNEL_ACCESS_TOKEN],
        ['INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN', INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN]
    ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
}

// 負責與 Dify 大腦溝通並回傳給 LINE 的函數
async function handleMessage(userMessage, replyToken, userId) {
    try {
        // 【新增神兵利器】先讓 LINE 顯示「...」讀取中的打字動畫，安撫使用者
        try {
            await axios.post(LINE_LOADING_API_URL, {
                chatId: userId,
                loadingSeconds: 10 // 動畫最長顯示 10 秒（只要我們把訊息傳回去，動畫就會提早自動消失）
            }, {
                headers: lineHeaders()
            });
        } catch (loadingErr) {
            // 避免電腦版 LINE 不支援時報錯中斷
            console.log('Loading animation not supported:', loadingErr.message);
        }

        // 補充 LINE 顯示限制，避免回覆出現不適合手機閱讀的格式。
        const enrichedMessage = userMessage + "\n\n(系統提示：請用專業、親切、清楚的語氣回答；不要使用 markdown 粗體星號；不要過度使用 Emoji 或特殊符號。)";

        // 1. 將使用者的訊息傳送給 Dify Agent (改用 streaming 模式)
        const difyResponse = await axios.post('https://api.dify.ai/v1/chat-messages', {
            inputs: {},
            query: enrichedMessage,
            response_mode: 'streaming', // <--- 修正：Dify Agent 專用模式
            user: userId
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream' // 告訴程式要用接水管的方式收訊息
        });

        let replyText = '';
        let streamBuffer = ''; // 【重要修復：斷字殺手】水桶緩衝區
        const utf8Decoder = new StringDecoder('utf8');

        function processStreamLines(lines) {
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('data:')) {
                    try {
                        const jsonStr = trimmedLine.substring(5).trim();
                        if (!jsonStr) continue;
                        const data = JSON.parse(jsonStr);

                        if (data.event === 'message' || data.event === 'agent_message') {
                            replyText += data.answer;
                        }
                    } catch (e) {
                        // 忽略格式錯誤
                    }
                }
            }
        }

        // 2. 接水管：收集 Dify 像打字一樣一段段傳過來的字
        difyResponse.data.on('data', (chunk) => {
            streamBuffer += utf8Decoder.write(chunk);
            let lines = streamBuffer.split('\n');

            // 把最後一行（可能還沒切完整的資料）留到下一次再處理
            streamBuffer = lines.pop();

            processStreamLines(lines);
        });

        // 3. 講完了：將收集好的答案回傳給 LINE
        difyResponse.data.on('end', async () => {
            try {
                streamBuffer += utf8Decoder.end();
                if (streamBuffer.trim()) {
                    processStreamLines([streamBuffer]);
                }

                if (!replyText) replyText = "抱歉，實習處大腦剛剛恍神了，請再問我一次！";

                // 【畫面優化】把醜醜的 markdown 粗體符號拔掉
                replyText = replyText.replace(/\*\*/g, '');

                await axios.post(LINE_REPLY_API_URL, {
                    replyToken: replyToken,
                    messages: [{
                        type: 'text',
                        text: replyText
                    }]
                }, {
                    headers: lineHeaders()
                });
            } catch (replyError) {
                console.error('LINE_WEBHOOK_ERROR', replyError.response?.data || replyError.message);
            }
        });

    } catch (error) {
        console.error('LINE_WEBHOOK_ERROR', error.response?.data || error.message);
    }
}

app.use((err, req, res, next) => {
    console.error('LINE_WEBHOOK_ERROR', err.message);
    res.status(400).send('Bad request');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
