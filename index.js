const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

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

const LINE_REPLY_API_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_LOADING_API_URL = 'https://api.line.me/v2/bot/chat/loading/start';

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

function lineHeaders() {
    return {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
    };
}

function isValidLineSignature(req) {
    const signature = req.get('x-line-signature');

    if (!LINE_CHANNEL_SECRET || !signature || !req.rawBody) {
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', LINE_CHANNEL_SECRET)
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

        // 【Emoji 魔法】在背後偷偷告訴 AI 要加表情符號
        const enrichedMessage = userMessage + "\n\n(系統提示：請用親切溫暖的語氣回答，多使用可愛的 Emoji 表情符號✨，且不要使用 markdown 的粗體星號)";

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

        // 2. 接水管：收集 Dify 像打字一樣一段段傳過來的字
        difyResponse.data.on('data', (chunk) => {
            streamBuffer += chunk.toString('utf8');
            let lines = streamBuffer.split('\n');
            
            // 把最後一行（可能還沒切完整的資料）留到下一次再處理
            streamBuffer = lines.pop(); 

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
        });

        // 3. 講完了：將收集好的答案回傳給 LINE
        difyResponse.data.on('end', async () => {
            try {
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
