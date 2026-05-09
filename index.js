const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 環境變數
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

// 接收 LINE 訊息的 Webhook 端點
app.post('/webhook', async (req, res) => {
    // LINE 會先測試連線，直接回覆 OK
    if (req.body.events.length === 0) {
        return res.status(200).send('OK');
    }

    const event = req.body.events[0];
    
    // 只處理文字訊息
    if (event.type !== 'message' || event.message.type !== 'text') {
        return res.status(200).send('OK');
    }

    const userMessage = event.message.text;
    const replyToken = event.replyToken;
    const userId = event.source.userId;

    try {
        // 1. 將使用者的訊息傳送給 Dify Agent
        const difyResponse = await axios.post('https://api.dify.ai/v1/chat-messages', {
            inputs: {},
            query: userMessage,
            response_mode: 'blocking',
            user: userId // 用 LINE 的 userId 作為 Dify 的用戶識別
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const replyText = difyResponse.data.answer;

        // 2. 將 Dify 的回答透過 LINE 回傳給使用者
        await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: replyText
            }]
        }, {
            headers: {
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Error handling message');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
