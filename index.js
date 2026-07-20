const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { createToolsRouter } = require('./tools-router');

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
const ADMIN_LINE_TARGET_ID = process.env.ADMIN_LINE_TARGET_ID;

const LINE_REPLY_API_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_PUSH_API_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_LOADING_API_URL = 'https://api.line.me/v2/bot/chat/loading/start';
const LINE_BROADCAST_API_URL = 'https://api.line.me/v2/bot/message/broadcast';
const LINE_MESSAGING_API_BASE_URL = 'https://api.line.me/v2/bot';
const LINE_CONTENT_API_BASE_URL = 'https://api-data.line.me/v2/bot/message';
const CLOUDINARY_UPLOAD_FOLDER = 'line-remote-publisher';
const REMOTE_DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
const REMOTE_MAX_IMAGES = 4;
const LINE_TEXT_LIMIT = 5000;
const ADMIN_IMAGE_HANDOFF_TTL_MS = 10 * 60 * 1000;
const ADMIN_CASE_TTL_MS = 72 * 60 * 60 * 1000;
const FRIENDLY_REPLY_EMOJI = ['😊', '📌', '✅', '🔎', '📝', '📢', '🌱', '☎️'];
const remoteDrafts = new Map();
const adminImageHandoffs = new Map();
const adminCases = new Map();
const pendingLocationRequests = new Map();
let adminCaseSequence = 0;
const LOCATION_REQUEST_TTL_MS = 10 * 60 * 1000;

app.use('/api/tools', createToolsRouter());

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

function normalizeLineReplyText(text) {
    let normalizedText = text.replace(/\*\*/g, '').replace(/\uFFFD/g, '').trim();

    if (!FRIENDLY_REPLY_EMOJI.some((emoji) => normalizedText.includes(emoji))) {
        normalizedText += '\n\n😊';
    }

    return normalizedText;
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

                if (isAdminTargetIdRequest(userMessage)) {
                    handleAdminTargetIdRequest(replyToken, event.source);
                    continue;
                }

                if (isFromAdminTarget(event.source)) {
                    if (isAdminCaseReplyMessage(userMessage)) {
                        handleAdminCaseReply(replyToken, userMessage);
                    } else if (userMessage.trim().startsWith('#')) {
                        replyLineText(replyToken, '回覆格式不正確。\n\n請使用：\n#案件編號 回覆內容\n\n例如：\n#A20260711-001 請於上班時間來電洽詢。');
                    }
                    continue;
                }

                if (isAdminAlertMessage(userMessage)) {
                    handleAdminAlert(userMessage, replyToken, event.source);
                    continue;
                }

                if (isLocationToolRequest(userMessage)) {
                    rememberLocationRequest(event.source, userMessage);
                    replyLocationQuickReply(replyToken);
                    continue;
                }

                if (isManualLocationCommand(userMessage)) {
                    if (markManualLocationRequest(event.source)) {
                        replyLineText(replyToken, '請直接輸入您要查詢的地點，例如：\n桃園市龜山區文化一路\n\n我會將地點交給 AI 助理進行這次查詢。📍');
                    } else {
                        replyLineText(replyToken, '請先輸入「附近美食」、「附近公車站」或「附近診所／醫院／藥局」，再選擇手動輸入地點。📍');
                    }
                    continue;
                }

                const pendingLocation = takePendingLocationRequest(event.source);
                if (pendingLocation?.awaitingManualLocation) {
                    handleMessage(`${pendingLocation.query}\n\n使用者手動輸入地點：${userMessage}`, replyToken, userId);
                    continue;
                }

                // 啟動大腦思考流程
                handleMessage(userMessage, replyToken, userId);
            }

            if (event.type === 'message' && event.message && event.message.type === 'location') {
                handleLocationMessage(event);
                continue;
            }

            if (event.type === 'message' && event.message && event.message.type === 'image') {
                const handoffKey = getAdminHandoffKey(event.source);
                if (handoffKey && hasActiveAdminImageHandoff(handoffKey)) {
                    handleAdminAlertImage(event.replyToken, event.source, event.message.id);
                    continue;
                }

                handleAdminImageWithoutPendingRequest(event.replyToken);
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

async function handleAdminAlert(userMessage, replyToken, source) {
    try {
        console.log('ADMIN_ALERT_TRIGGERED');

        const alertText = extractAdminAlertText(userMessage);
        if (!alertText) {
            await replyLineText(replyToken, '請在 * 後面輸入要轉交管理者的內容。\n\n例如：\n*我想詢問學生實習個案');
            return;
        }

        if (!ADMIN_LINE_TARGET_ID) {
            console.error('ADMIN_ALERT_ERROR', 'Missing ADMIN_LINE_TARGET_ID');
            await replyLineText(replyToken, '已收到您的人工協助訊息，但目前管理者通知尚未完成設定。\n\n若事情較急，請於上班時間撥打學校總機 (03) 3294188，再轉接實習處。');
            return;
        }

        const requesterProfile = await getLineSourceProfile(source);
        const adminCase = createAdminCase(alertText, source, requesterProfile);

        await axios.post(LINE_PUSH_API_URL, {
            to: ADMIN_LINE_TARGET_ID,
            messages: [{
                type: 'text',
                text: buildAdminAlertText(adminCase, source)
            }]
        }, {
            headers: lineHeaders()
        });

        console.log('ADMIN_ALERT_SENT');
        rememberAdminImageHandoff(source, adminCase);
        await replyLineText(replyToken, '已收到您的訊息，這類問題將轉交實習處管理者確認。\n\n若需要補充圖片，請在 10 分鐘內直接傳送圖片，我會一併轉交管理者。\n\n請避免在 LINE 中提供身分證字號、住址等敏感個資。');
    } catch (error) {
        console.error('ADMIN_ALERT_ERROR', error.response?.data || error.message);
        await replyLineText(replyToken, '管理者通知暫時送出失敗，請稍後再試一次。\n\n若事情較急，請於上班時間撥打學校總機 (03) 3294188，再轉接實習處。');
    }
}

async function handleAdminAlertImage(replyToken, source, messageId) {
    try {
        console.log('ADMIN_ALERT_IMAGE_TRIGGERED');

        const missingConfig = getMissingAdminImageConfig();
        if (missingConfig.length > 0) {
            console.error('ADMIN_ALERT_ERROR', `Missing config: ${missingConfig.join(', ')}`);
            await replyLineText(replyToken, '圖片轉交功能尚未設定完成，請先通知管理者確認系統設定。');
            return;
        }

        const handoffKey = getAdminHandoffKey(source);
        const handoff = adminImageHandoffs.get(handoffKey);
        if (!handoff || handoff.expiresAt <= Date.now()) {
            adminImageHandoffs.delete(handoffKey);
            await replyLineText(replyToken, '圖片轉交時間已超過 10 分鐘。\n\n如需轉交圖片給管理者，請先輸入：\n*我要傳圖片給管理者\n\n再重新傳送圖片。');
            return;
        }

        const image = await downloadLineImage(messageId, LINE_CHANNEL_ACCESS_TOKEN);
        const uploadedImage = await uploadImageToCloudinary(image);

        await axios.post(LINE_PUSH_API_URL, {
            to: ADMIN_LINE_TARGET_ID,
            messages: [
                {
                    type: 'text',
                    text: buildAdminImageAlertText(handoff.adminCase, source)
                },
                {
                    type: 'image',
                    originalContentUrl: uploadedImage.secureUrl,
                    previewImageUrl: uploadedImage.secureUrl
                }
            ]
        }, {
            headers: lineHeaders()
        });

        handoff.expiresAt = Date.now() + ADMIN_IMAGE_HANDOFF_TTL_MS;
        console.log('ADMIN_ALERT_IMAGE_SENT');
        await replyLineText(replyToken, '已收到圖片，並已轉交實習處管理者確認。');
    } catch (error) {
        console.error('ADMIN_ALERT_ERROR', error.response?.data || error.message);
        await replyLineText(replyToken, '圖片轉交暫時失敗，請稍後再傳一次。\n\n若事情較急，請於上班時間撥打學校總機 (03) 3294188，再轉接實習處。');
    }
}

async function handleAdminImageWithoutPendingRequest(replyToken) {
    try {
        await replyLineText(replyToken, '目前圖片不會直接轉交管理者。\n\n如需轉交圖片，請先輸入：\n*我要傳圖片給管理者\n\n接著在 10 分鐘內傳送圖片。');
    } catch (error) {
        console.error('ADMIN_ALERT_ERROR', error.response?.data || error.message);
    }
}

function isAdminAlertMessage(text) {
    return (text || '').trim().startsWith('*');
}

function isFromAdminTarget(source) {
    return Boolean(ADMIN_LINE_TARGET_ID && (
        source?.groupId === ADMIN_LINE_TARGET_ID ||
        source?.roomId === ADMIN_LINE_TARGET_ID ||
        source?.userId === ADMIN_LINE_TARGET_ID
    ));
}

function isAdminCaseReplyMessage(text) {
    return /^#[A-Za-z0-9-]+\s+[\s\S]+/.test((text || '').trim());
}

async function handleAdminCaseReply(replyToken, text) {
    try {
        const parsedReply = parseAdminCaseReply(text);
        if (!parsedReply) {
            await replyLineText(replyToken, '回覆格式不正確。\n\n請使用：\n#案件編號 回覆內容');
            return;
        }

        cleanupAdminCases();
        const adminCase = adminCases.get(parsedReply.caseId);
        if (!adminCase) {
            await replyLineText(replyToken, '找不到這個案件，可能是案件編號錯誤、已超過 72 小時，或 Zeabur 重新部署後暫存資料已清除。');
            return;
        }

        if (!adminCase.userId) {
            await replyLineText(replyToken, '這個案件沒有可回覆的使用者 ID，請管理者改至 LINE 官方帳號後台查看對話。');
            return;
        }

        await axios.post(LINE_PUSH_API_URL, {
            to: adminCase.userId,
            messages: [{
                type: 'text',
                text: buildAdminReplyToUserText(adminCase.caseId, parsedReply.replyText)
            }]
        }, {
            headers: lineHeaders()
        });

        adminCase.lastRepliedAt = Date.now();
        console.log('ADMIN_CASE_REPLY_SENT');
        await replyLineText(replyToken, `已回覆使用者。\n\n案件編號：${adminCase.caseId}`);
    } catch (error) {
        console.error('ADMIN_CASE_REPLY_ERROR', error.response?.data || error.message);
        await replyLineText(replyToken, '回覆使用者失敗，請稍後再試一次，或改至 LINE 官方帳號後台查看對話。');
    }
}

function parseAdminCaseReply(text) {
    const match = (text || '').trim().match(/^#([A-Za-z0-9-]+)\s+([\s\S]+)$/);
    if (!match) return null;

    const caseId = normalizeAdminCaseId(match[1]);
    const replyText = match[2].trim();
    if (!caseId || !replyText) return null;

    return {
        caseId,
        replyText
    };
}

function createAdminCase(alertText, source, requesterProfile = null) {
    cleanupAdminCases();

    const caseId = generateAdminCaseId();
    const adminCase = {
        caseId,
        alertText,
        userId: source?.userId,
        requesterDisplayName: requesterProfile?.displayName || '未取得',
        sourceType: source?.type || 'user',
        sourceId: source?.userId || source?.groupId || source?.roomId || 'unknown',
        createdAt: Date.now(),
        expiresAt: Date.now() + ADMIN_CASE_TTL_MS,
        lastRepliedAt: null
    };

    adminCases.set(caseId, adminCase);
    return adminCase;
}

async function getLineSourceProfile(source) {
    if (!source?.userId) {
        return null;
    }

    try {
        let profileUrl = `${LINE_MESSAGING_API_BASE_URL}/profile/${source.userId}`;

        if (source.type === 'group' && source.groupId) {
            profileUrl = `${LINE_MESSAGING_API_BASE_URL}/group/${source.groupId}/member/${source.userId}`;
        }

        if (source.type === 'room' && source.roomId) {
            profileUrl = `${LINE_MESSAGING_API_BASE_URL}/room/${source.roomId}/member/${source.userId}`;
        }

        const response = await axios.get(profileUrl, {
            headers: lineHeaders()
        });

        return {
            displayName: response.data?.displayName || '未取得'
        };
    } catch (error) {
        console.error('ADMIN_PROFILE_LOOKUP_ERROR', error.response?.data || error.message);
        return null;
    }
}

function generateAdminCaseId() {
    const dateText = getTaipeiDateCompact(new Date());

    for (let attempt = 0; attempt < 1000; attempt++) {
        adminCaseSequence = (adminCaseSequence % 999) + 1;
        const caseId = `A${dateText}-${String(adminCaseSequence).padStart(3, '0')}`;

        if (!adminCases.has(caseId)) {
            return caseId;
        }
    }

    return `A${dateText}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function normalizeAdminCaseId(caseId) {
    return (caseId || '').trim().replace(/^#/, '').toUpperCase();
}

function cleanupAdminCases() {
    const now = Date.now();
    for (const [caseId, adminCase] of adminCases.entries()) {
        if (adminCase.expiresAt <= now) {
            adminCases.delete(caseId);
        }
    }
}

function rememberAdminImageHandoff(source, adminCase) {
    const handoffKey = getAdminHandoffKey(source);
    if (!handoffKey) return;

    cleanupAdminImageHandoffs();
    adminImageHandoffs.set(handoffKey, {
        adminCase,
        expiresAt: Date.now() + ADMIN_IMAGE_HANDOFF_TTL_MS
    });
}

function getAdminHandoffKey(source) {
    return source?.userId || source?.groupId || source?.roomId;
}

function hasActiveAdminImageHandoff(handoffKey) {
    cleanupAdminImageHandoffs();
    const handoff = adminImageHandoffs.get(handoffKey);
    return Boolean(handoff && handoff.expiresAt > Date.now());
}

function cleanupAdminImageHandoffs() {
    const now = Date.now();
    for (const [handoffKey, handoff] of adminImageHandoffs.entries()) {
        if (handoff.expiresAt <= now) {
            adminImageHandoffs.delete(handoffKey);
        }
    }
}

function isAdminTargetIdRequest(text) {
    const commandText = normalizeRemoteCommandText(text || '');
    return commandText === '取得通知ID' || commandText === '查詢通知ID' || commandText === '管理者通知ID';
}

async function handleAdminTargetIdRequest(replyToken, source) {
    try {
        const sourceId = source?.groupId || source?.roomId || source?.userId;
        if (!sourceId) {
            await replyLineText(replyToken, '目前無法取得這個聊天室的通知 ID。');
            return;
        }

        console.log('ADMIN_TARGET_ID_REQUESTED');
        await replyLineText(replyToken, `這個聊天室的通知 ID 是：\n${sourceId}\n\n請將它設定到 Zeabur 環境變數：\nADMIN_LINE_TARGET_ID\n\n請不要公開分享這個 ID。`);
    } catch (error) {
        console.error('ADMIN_ALERT_ERROR', error.response?.data || error.message);
    }
}

function extractAdminAlertText(text) {
    return (text || '').trim().replace(/^\*+/, '').trim();
}

function buildAdminAlertText(adminCase, source) {
    const sourceType = adminCase.sourceType || source?.type || 'user';
    const sourceId = adminCase.sourceId || source?.userId || source?.groupId || source?.roomId || 'unknown';
    const requesterDisplayName = adminCase.requesterDisplayName || '未取得';
    const submittedAt = formatTaipeiDateTime(new Date(adminCase.createdAt));

    return `【管理者通知】

來源：實習處 LINE 官方帳號
類型：人工協助
案件編號：${adminCase.caseId}
時間：${submittedAt}
發問者暱稱：${requesterDisplayName}
來源類型：${sourceType}
來源 ID：${sourceId}

使用者訊息：
${adminCase.alertText.slice(0, 3000)}

若要在群組直接回覆使用者，請輸入：
#${adminCase.caseId} 回覆內容

案件暫存 72 小時；若 Zeabur 重新部署，暫存案件會失效。
若涉及學生個案或個人資料，請依正式流程處理。`;
}

function buildAdminImageAlertText(adminCase, source) {
    const sourceType = adminCase?.sourceType || source?.type || 'user';
    const sourceId = adminCase?.sourceId || source?.userId || source?.groupId || source?.roomId || 'unknown';
    const requesterDisplayName = adminCase?.requesterDisplayName || '未取得';
    const submittedAt = formatTaipeiDateTime(new Date());
    const caseId = adminCase?.caseId || '未建立';
    const alertText = adminCase?.alertText || '未提供';

    return `【管理者圖片通知】

來源：實習處 LINE 官方帳號
類型：圖片補充
案件編號：${caseId}
時間：${submittedAt}
發問者暱稱：${requesterDisplayName}
來源類型：${sourceType}
來源 ID：${sourceId}

前次人工協助訊息：
${alertText.slice(0, 1200)}

使用者剛剛傳送了一張圖片，圖片會在下一則訊息顯示。
若要在群組直接回覆使用者，請輸入：
#${caseId} 回覆內容

若涉及學生個案或個人資料，請依正式流程處理。`;
}

function buildAdminReplyToUserText(caseId, replyText) {
    return `【實習處管理者回覆】

案件編號：${caseId}

${replyText.slice(0, LINE_TEXT_LIMIT - 80)}`;
}

function formatTaipeiDateTime(date) {
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

function getTaipeiDateCompact(date) {
    const parts = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const year = parts.find((part) => part.type === 'year')?.value || '0000';
    const month = parts.find((part) => part.type === 'month')?.value || '00';
    const day = parts.find((part) => part.type === 'day')?.value || '00';

    return `${year}${month}${day}`;
}

async function replyLineText(replyToken, text) {
    await axios.post(LINE_REPLY_API_URL, {
        replyToken,
        messages: [{
            type: 'text',
            text
        }]
    }, {
        headers: lineHeaders()
    });
}

function isLocationToolRequest(text) {
    const normalized = (text || '').trim().toLowerCase();
    const needsNearbyLocation = /(附近|鄰近).*(美食|餐廳|吃|公車|巴士|站牌|診所|醫院|藥局|藥房|醫師|醫生)|nearby\s+(food|restaurant|bus|stop|clinic|hospital|pharmacy|doctor)/i.test(normalized);
    return needsNearbyLocation && !hasExplicitLocation(normalized);
}

function hasExplicitLocation(text) {
    return /(世紀綠能工商|明德路\s*162\s*巷\s*100\s*號|(?:台|臺)北市|新北市|桃園市|台中市|臺中市|台南市|臺南市|高雄市|[一-鿿]{2,}[縣市][一-鿿]{1,}[區鄉鎮]|[一-鿿]{2,}[路街巷站])/i.test(text || '');
}

function isManualLocationCommand(text) {
    return (text || '').trim() === '手動輸入地點';
}

function locationRequestKey(source) {
    return source?.userId || source?.groupId || source?.roomId || null;
}

function rememberLocationRequest(source, query) {
    cleanupLocationRequests();
    const key = locationRequestKey(source);
    if (!key) return;
    pendingLocationRequests.set(key, {
        query,
        awaitingManualLocation: false,
        expiresAt: Date.now() + LOCATION_REQUEST_TTL_MS
    });
}

function takePendingLocationRequest(source) {
    cleanupLocationRequests();
    const key = locationRequestKey(source);
    if (!key) return null;
    const pending = pendingLocationRequests.get(key);
    if (!pending) return null;
    pendingLocationRequests.delete(key);
    return pending;
}

function markManualLocationRequest(source) {
    cleanupLocationRequests();
    const key = locationRequestKey(source);
    const pending = key ? pendingLocationRequests.get(key) : null;
    if (pending) {
        pending.awaitingManualLocation = true;
        pending.expiresAt = Date.now() + LOCATION_REQUEST_TTL_MS;
        return true;
    }
    return false;
}

function cleanupLocationRequests() {
    const currentTime = Date.now();
    for (const [key, value] of pendingLocationRequests.entries()) {
        if (value.expiresAt <= currentTime) pendingLocationRequests.delete(key);
    }
}

async function replyLocationQuickReply(replyToken) {
    await axios.post(LINE_REPLY_API_URL, {
        replyToken,
        messages: [{
            type: 'text',
            text: '這項查詢需要知道您目前的位置。請選擇分享目前位置，或手動輸入地點。📍',
            quickReply: {
                items: [
                    { type: 'action', action: { type: 'location', label: '分享目前位置' } },
                    { type: 'action', action: { type: 'message', label: '手動輸入地點', text: '手動輸入地點' } }
                ]
            }
        }]
    }, { headers: lineHeaders() });
}

async function handleLocationMessage(event) {
    const pending = takePendingLocationRequest(event.source);
    if (!pending) {
        await replyLineText(event.replyToken, '目前沒有等待位置資訊的查詢。請先輸入「附近美食」、「附近公車站」或「附近診所／醫院／藥局」。📍');
        return;
    }

    const latitude = Number(event.message.latitude);
    const longitude = Number(event.message.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        await replyLineText(event.replyToken, '收到的位置格式不正確，請重新分享位置。');
        return;
    }

    const address = String(event.message.address || '').slice(0, 200);
    const locationContext = `使用者已授權本次查詢使用 LINE 位置：latitude=${latitude}, longitude=${longitude}${address ? `, address=${address}` : ''}。精確位置僅限本次查詢，不得在回覆中完整顯示。`;
    handleMessage(`${pending.query}\n\n${locationContext}`, event.replyToken, event.source?.userId);
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
    const commandText = normalizeRemoteCommandText(trimmedText);

    if (!trimmedText) {
        await replyRemoteText(replyToken, '請輸入公告文字，或傳送圖片。');
        return;
    }

    if (commandText === '開始發文') {
        remoteDrafts.set(userId, createRemoteDraft());
        await replyRemoteText(replyToken, '已開始新的發文草稿。\n\n請傳送公告文字與圖片。完成後請輸入「預覽」。');
        return;
    }

    if (commandText === '取消') {
        remoteDrafts.delete(userId);
        await replyRemoteText(replyToken, '已取消並清除目前的發文草稿。');
        return;
    }

    if (commandText === '預覽') {
        await replyRemotePreview(replyToken, userId);
        return;
    }

    if (commandText === '確認發佈' || commandText === '確認發布' || commandText === '確認發佈到全部好友' || commandText === '確認發布到全部好友') {
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

    try {
        await axios.post(LINE_BROADCAST_API_URL, {
            messages
        }, {
            headers: lineHeaders(INTERNSHIP_LINE_CHANNEL_ACCESS_TOKEN)
        });
    } catch (error) {
        console.error('REMOTE_BROADCAST_ERROR', error.response?.status || '', error.response?.data || error.message);
        await replyRemoteText(replyToken, '公告發佈失敗，草稿已保留，尚未送出到實習處 LINE 官方帳號。\n\n請到 Zeabur Logs 搜尋：\nREMOTE_BROADCAST_ERROR\n\n確認錯誤原因後再處理。');
        return;
    }

    remoteDrafts.delete(userId);
    console.log('REMOTE_BROADCAST_SENT');
    await replyRemoteText(replyToken, `已發佈到實習處 LINE 官方帳號所有好友。\n\n本次發佈內容：${messages.length} 則訊息。`);
}

function normalizeRemoteCommandText(text) {
    return text
        .replace(/\s+/g, '')
        .replace(/[。．.!！?？、，,;；:：]/g, '')
        .trim();
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
    return downloadLineImage(messageId, REMOTE_LINE_CHANNEL_ACCESS_TOKEN);
}

async function downloadLineImage(messageId, accessToken) {
    const response = await axios.get(`${LINE_CONTENT_API_BASE_URL}/${messageId}/content`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
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

function getMissingAdminImageConfig() {
    return [
        ['ADMIN_LINE_TARGET_ID', ADMIN_LINE_TARGET_ID],
        ['LINE_CHANNEL_ACCESS_TOKEN', LINE_CHANNEL_ACCESS_TOKEN],
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
        const enrichedMessage = userMessage + "\n\n(系統提示：請用專業、親切、清楚的語氣回答；不要使用 markdown 粗體星號；每則回覆請自然加入 1 到 3 個常見 Emoji 小圖標，例如 😊、📌、✅、🔎、☎️；避免罕見符號、裝飾字、顏文字或特殊字元。)";

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

                // LINE 手機畫面優化：移除 markdown 粗體符號與亂碼替代字，並保留一點親切小圖標。
                replyText = normalizeLineReplyText(replyText);

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
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

module.exports = app;
