/**
 * Vision AI Web 服务器
 * 支持 DeepSeek（文字）和 Gemini（视觉）
 * 纯 Node.js 内置模块，不依赖任何 npm 包！
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 配置
const PORT = 3000;
let deepseekApiKey = '';
let geminiApiKey = '';
let currentModel = 'gemini-2.5-flash'; // 'deepseek-chat' | 'gemini-2.5-flash'
const sessions = new Map();

// 获取本机 IP
function getLocalIP() {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

// 读取文件内容
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath);
    } catch {
        return null;
    }
}

// 解析请求体
function parseBody(req) {
    return new Promise(function(resolve, reject) {
        var body = '';
        req.on('data', function(chunk) { body += chunk; });
        req.on('end', function() {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}

// 发送 JSON 响应
function sendJSON(res, data, status) {
    status = status || 200;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
}

// API: 保存设置
function handleSettings(req, res) {
    parseBody(req).then(function(body) {
        if (body.apiKey !== undefined) {
            deepseekApiKey = String(body.apiKey).trim();
        }
        if (body.geminiKey !== undefined) {
            geminiApiKey = String(body.geminiKey).trim();
        }
        if (body.model && (body.model === 'deepseek-chat' || body.model === 'gemini-2.5-flash')) {
            currentModel = body.model;
        }
        sendJSON(res, { success: true });
    });
}

// API: 获取设置
function handleGetSettings(req, res) {
    sendJSON(res, {
        hasDeepseekKey: !!deepseekApiKey,
        hasGeminiKey: !!geminiApiKey,
        model: currentModel,
    });
}

// API: 测试 API Key
async function handleTest(req, res) {
    var body = await parseBody(req);
    var model = body.model || currentModel;
    var isGemini = (model === 'gemini-2.5-flash');
    var key = isGemini ? body.geminiKey : body.apiKey;

    if (!key) {
        return sendJSON(res, { error: 'No API Key provided' }, 401);
    }

    try {
        if (isGemini) {
            var geminiRes = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: 'Say "OK" in one word.' }] }] }),
                }
            );
            if (!geminiRes.ok) {
                var errData = await geminiRes.json().catch(function() { return {}; });
                return sendJSON(res, { error: errData.error ? errData.error.message : 'Gemini API Key 无效' }, 401);
            }
            return sendJSON(res, { success: true });
        } else {
            var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                }),
            });
            if (!dsRes.ok) {
                var dsErr = await dsRes.json().catch(function() { return {}; });
                return sendJSON(res, { error: dsErr.error ? dsErr.error.message : 'API Key 无效' }, 401);
            }
            return sendJSON(res, { success: true });
        }
    } catch (e) {
        sendJSON(res, { error: '网络错误，请检查网络连接' }, 500);
    }
}

// AI 对话
async function handleAsk(req, res) {
    var body = await parseBody(req);
    var sessionId = body.sessionId || 'default';
    var question = body.question || '';
    var imageBase64 = body.imageBase64 || null;
    var model = body.model || currentModel;

    if (!question && !imageBase64) {
        return sendJSON(res, { error: 'No question or image provided' }, 400);
    }

    var isGemini = (model === 'gemini-2.5-flash');
    var apiKey = isGemini ? geminiApiKey : deepseekApiKey;

    if (!apiKey) {
        return sendJSON(res, { error: 'API Key 未设置，请在设置页面配置' }, 400);
    }

    // 获取或创建会话历史
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, []);
    }
    var history = sessions.get(sessionId);

    // 限制历史长度
    if (history.length > 20) {
        history = history.slice(-20);
        sessions.set(sessionId, history);
    }

    try {
        if (isGemini) {
            // Gemini API
            var parts = [];
            if (question) {
                parts.push({ text: question });
            }
            if (imageBase64) {
                parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: imageBase64.replace(/^data:image\/\w+;base64,/, ''),
                    },
                });
            }

            var geminiBody = {
                contents: [{ parts: parts }],
            };

            // 添加历史对话
            if (history.length > 0) {
                geminiBody.contents = geminiBody.contents.concat(
                    history.slice(-10).map(function(msg) {
                        return {
                            role: msg.role === 'user' ? 'user' : 'model',
                            parts: [{ text: msg.content }],
                        };
                    })
                );
            }

            var geminiResp = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(geminiBody),
                }
            );

            if (!geminiResp.ok) {
                var errResp = await geminiResp.json().catch(function() { return {}; });
                var errMsg = errResp.error ? errResp.error.message : 'Gemini API 请求失败';
                return sendJSON(res, { error: errMsg }, 502);
            }

            var geminiData = await geminiResp.json();
            var answer = '';
            if (geminiData.candidates && geminiData.candidates[0] &&
                geminiData.candidates[0].content && geminiData.candidates[0].content.parts) {
                answer = geminiData.candidates[0].content.parts
                    .map(function(p) { return p.text || ''; })
                    .join('');
            }

            // 保存历史
            if (question) history.push({ role: 'user', content: question });
            if (answer) history.push({ role: 'assistant', content: answer });

            return sendJSON(res, { answer: answer, sessionId: sessionId });

        } else {
            // DeepSeek API
            var messages = history.slice(-10).map(function(msg) {
                return { role: msg.role, content: msg.content };
            });
            messages.push({ role: 'user', content: question });

            var dsResp = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: messages,
                    max_tokens: 800,
                }),
            });

            if (!dsResp.ok) {
                var dsErrData = await dsResp.json().catch(function() { return {}; });
                return sendJSON(res, { error: dsErrData.error ? dsErrData.error.message : 'DeepSeek API 请求失败' }, 502);
            }

            var dsData = await dsResp.json();
            var answer = dsData.choices && dsData.choices[0] && dsData.choices[0].message
                ? dsData.choices[0].message.content
                : '无法解析响应';

            // 保存历史
            if (question) history.push({ role: 'user', content: question });
            if (answer) history.push({ role: 'assistant', content: answer });

            return sendJSON(res, { answer: answer, sessionId: sessionId });
        }
    } catch (e) {
        sendJSON(res, { error: '服务器错误: ' + e.message }, 500);
    }
}

// 静态文件缓存
var indexHtml = null;
var styleCss = null;

// 创建服务器
var server = http.createServer(function(req, res) {
    // CORS 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    var parsedUrl = url.parse(req.url, true);
    var pathname = parsedUrl.pathname;

    // API 路由
    if (pathname === '/api/settings' && req.method === 'POST') {
        return handleSettings(req, res);
    }
    if (pathname === '/api/settings' && req.method === 'GET') {
        return handleGetSettings(req, res);
    }
    if (pathname === '/api/test' && req.method === 'POST') {
        return handleTest(req, res);
    }
    if (pathname === '/api/ask' && req.method === 'POST') {
        return handleAsk(req, res);
    }
    if (pathname === '/api/clear' && req.method === 'POST') {
        parseBody(req).then(function(body) {
            if (body.sessionId) sessions.delete(body.sessionId);
            sendJSON(res, { success: true });
        });
        return;
    }
    if (pathname === '/api/info' && req.method === 'GET') {
        return sendJSON(res, { ip: getLocalIP(), port: PORT });
    }

    // 静态文件
    var filePath = pathname === '/' || pathname === '/index.html'
        ? path.join(__dirname, 'index.html')
        : path.join(__dirname, pathname);

    var ext = path.extname(filePath).toLowerCase();
    var mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    };

    var mimeType = mimeTypes[ext] || 'text/plain';
    var content = readFile(filePath);

    if (content) {
        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'no-cache',
        });
        res.end(content);
    } else {
        // 返回 index.html（单页应用）
        if (!indexHtml) {
            indexHtml = readFile(path.join(__dirname, 'index.html'));
        }
        if (indexHtml) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexHtml);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    }
});

server.listen(PORT, function() {
    console.log('');
    console.log('  ╔═══════════════════════════════════════╗');
    console.log('  ║    Vision AI Web  已启动！            ║');
    console.log('  ╚═══════════════════════════════════════╝');
    console.log('');
    console.log('  📱 手机访问（需 ngrok）：');
    console.log('     https://outlast-unnoticed-donation.ngrok-free.dev');
    console.log('');
    console.log('  💻 电脑访问：');
    console.log('     http://localhost:' + PORT);
    console.log('');
    console.log('  ⚠️  手机和电脑必须连同一个 WiFi！');
    console.log('');
    console.log('  按 Ctrl+C 停止服务器');
});
