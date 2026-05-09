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
        // 【新增神兵利器】先讓 LINE 顯示「...」讀取中的打字動畫，安撫使用者
        try {
            await axios.post('https://api.line.me/v2/bot/chat/loading/start', {
                chatId: userId,
                loadingSeconds: 10 // 動畫最長顯示 10 秒（只要我們把訊息傳回去，動畫就會提早自動消失）
            }, {
                headers: {
                    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
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
            if (!replyText) replyText = "抱歉，實習處大腦剛剛恍神了，請再問我一次！";
            
            // 【畫面優化】把醜醜的 markdown 粗體符號拔掉
            replyText = replyText.replace(/\*\*/g, '');

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
