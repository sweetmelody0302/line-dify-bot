const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 環境變數
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

// 接收 LINE 訊息的 Webhook 端點
app.post('/webhook', (req, res) => {
    // 【重要修正】一收到 LINE 訊息就先回覆 OK，避免 LINE 覺得我們沒反應而引發錯誤
    res.status(200).send('OK');

    if (req.body.events.length === 0) return;
    const event = req.body.events[0];
    
    // 只處理文字訊息
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userMessage = event.message.text;
    const replyToken = event.replyToken;
    const userId = event.source.userId;

    // 啟動大腦思考流程
    handleMessage(userMessage, replyToken, userId);
});

// 負責與 Dify 大腦溝通並回傳給 LINE 的函數
async function handleMessage(userMessage, replyToken, userId) {
    try {
        // 1. 將使用者的訊息傳送給 Dify Agent (改用 streaming 模式)
        const difyResponse = await axios.post('https://api.dify.ai/v1/chat-messages', {
            inputs: {},
            query: userMessage,
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

        // 2. 接水管：收集 Dify 像打字一樣一段段傳過來的字
        difyResponse.data.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
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
            if (!replyText) replyText = "抱歉，實習處大腦剛剛恍神了，請再問我一次！";
            
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
        });

    } catch (error) {
        console.error('Dify Error:', error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
