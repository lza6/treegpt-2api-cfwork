/**
 * =================================================================================
 * 项目: treegpt-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Arbor Synthesis)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-01
 * 
 * [核心功能]
 * 1. [协议转换] 将 TreeGPT 的 NDJSON 流转换为 OpenAI SSE 格式。
 * 2. [思维链整合] 自动处理 DeepSeek/Qwen 等模型的 reasoning 字段。
 * 3. [零鉴权适配] 针对 TreeGPT 的公开接口特性进行适配。
 * 4. [开发者驾驶舱] 内置全功能调试与监控 UI。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "treegpt-2api",
  PROJECT_VERSION: "1.0.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  // 如果未设置环境变量，将使用此默认值
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_ORIGIN: "https://treegpt.app",
  UPSTREAM_API_URL: "https://treegpt.app/api/chat-stream",

  // 伪装头 (模拟 Chrome 142)
  HEADERS: {
    "Host": "treegpt.app",
    "Origin": "https://treegpt.app",
    "Referer": "https://treegpt.app/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型列表 (从源码分析得出)
  MODELS: [
    "qwen-3-32b",
    "deepseek-reasoner",
    "deepseek-chat",
    "llama-3.3-70b",
    "llama-3.1-8b",
    "llama-4-scout-17b-16e-instruct"
  ],
  DEFAULT_MODEL: "qwen-3-32b"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    
    request.ctx = { apiKey };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();
    
    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') return handleUI(request);
    
    // 3. API 路由
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  const validKey = request.ctx.apiKey;
  if (validKey === "1") return true; // 允许默认弱密码用于测试
  return authHeader && authHeader === `Bearer ${validKey}`;
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'treegpt',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const stream = body.stream !== false; // 默认为 true

    // 1. 构造 TreeGPT Payload
    // TreeGPT 接受标准的 messages 数组
    const treeGptPayload = {
      messages: body.messages,
      model: model,
      autoRouteEnabled: false // 根据抓包，显式关闭自动路由以指定模型
    };

    // 2. 发送请求
    const response = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(treeGptPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return createErrorResponse(`上游服务错误 (${response.status}): ${errorText}`, response.status, 'upstream_error');
    }

    // 3. 流式处理 (NDJSON -> SSE)
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        try {
          const reader = response.body.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ""; // 保留未完成的行

            for (const line of lines) {
              if (!line.trim()) continue;
              
              try {
                // TreeGPT 返回的是直接的 JSON 对象，不是 data: 开头的
                // 例如: {"content":"","reasoning":"...","modelInfo":...}
                const data = JSON.parse(line);
                
                // 提取内容和推理
                let content = data.content || "";
                const reasoning = data.reasoning || "";

                // 如果有推理过程，我们将其拼接到内容前或后，或者作为 content 发送
                // 为了兼容性，这里我们将 reasoning 也作为 content 发送，或者你可以选择特定格式
                // 这里策略是：如果有 reasoning，先发 reasoning，再发 content
                
                if (reasoning) {
                    const reasoningChunk = createChatCompletionChunk(requestId, model, reasoning);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(reasoningChunk)}\n\n`));
                }

                if (content) {
                    const contentChunk = createChatCompletionChunk(requestId, model, content);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
                }

              } catch (e) {
                // 忽略解析错误的行
              }
            }
          }
          
          // 发送结束信号
          const endChunk = createChatCompletionChunk(requestId, model, "", "stop");
          await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));

        } catch (e) {
          const errChunk = createChatCompletionChunk(requestId, model, `\n\n[Error: ${e.message}]`, "stop");
          await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders({ 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Worker-Trace-ID': requestId
        })
      });

    } else {
      // 非流式处理 (虽然 TreeGPT 主要是流式的，这里做一个简单的聚合)
      // 注意：Worker 内存有限，如果响应过大可能会崩
      const text = await response.text();
      const lines = text.split('\n').filter(l => l.trim());
      let fullContent = "";
      
      for (const line of lines) {
          try {
              const data = JSON.parse(line);
              if (data.reasoning) fullContent += data.reasoning;
              if (data.content) fullContent += data.content;
          } catch(e) {}
      }

      const resp = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      return new Response(JSON.stringify(resp), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function createChatCompletionChunk(id, model, content, finishReason = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: content ? { content: content } : {}, finish_reason: finishReason }]
  };
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; word-wrap: break-word; white-space: pre-wrap; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; }
      .msg.error { color: var(--error); border-color: var(--error); }
      .debug-panel { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px; }
      .log-entry { font-family: monospace; font-size: 11px; border-bottom: 1px solid #333; padding: 5px 0; color: #aaa; }
      .log-entry.err { color: var(--error); }
      
      /* Tabs */
      .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 15px; }
      .tab { padding: 8px 15px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; }
      .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            🌲 ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="5" placeholder="输入你的问题...">你好，请介绍一下你自己。</textarea>
            
            <button id="btn-gen" onclick="sendRequest()">🚀 发送请求</button>
        </div>
        
        <div class="debug-panel">
            <span class="label">实时调试日志</span>
            <div id="debug-log" style="height: 150px; overflow-y: auto; background: #000; padding: 10px; border-radius: 4px;"></div>
        </div>
    </div>

    <main class="main">
        <div class="tabs">
            <div class="tab active" onclick="switchTab('chat')">💬 实时交互</div>
            <div class="tab" onclick="switchTab('guide')">📚 集成指南</div>
        </div>

        <div id="tab-chat" class="tab-content active" style="height: calc(100% - 50px); display: flex; flex-direction: column;">
            <div class="chat-window" id="chat">
                <div style="color:#666; text-align:center; margin-top:100px;">
                    <div style="font-size:40px; margin-bottom:20px;">🌲</div>
                    <h3>TreeGPT 代理服务就绪</h3>
                    <p>支持 Qwen-3, DeepSeek-Reasoner 等模型。<br>无需 Cookie，开箱即用。</p>
                </div>
            </div>
        </div>

        <div id="tab-guide" class="tab-content">
            <div class="box">
                <span class="label">Python (OpenAI SDK)</span>
                <div class="code-block" onclick="copy(this.innerText)">
import openai

client = openai.OpenAI(
    api_key="${apiKey}",
    base_url="${origin}/v1"
)

response = client.chat.completions.create(
    model="${CONFIG.DEFAULT_MODEL}",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
                </div>
            </div>
            <div class="box">
                <span class="label">cURL</span>
                <div class="code-block" onclick="copy(this.innerText)">
curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${CONFIG.DEFAULT_MODEL}",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
                </div>
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function log(type, msg) {
            const el = document.getElementById('debug-log');
            const div = document.createElement('div');
            div.className = \`log-entry \${type}\`;
            div.innerText = \`[\${new Date().toLocaleTimeString()}] \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            
            // 简单的 Tab 切换逻辑
            if (tabName === 'chat') {
                document.querySelector('.tab:nth-child(1)').classList.add('active');
                document.getElementById('tab-chat').style.display = 'flex';
            } else {
                document.querySelector('.tab:nth-child(2)').classList.add('active');
                document.getElementById('tab-guide').style.display = 'block';
            }
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function sendRequest() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return;

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = '⏳ 处理中...';

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '');
            aiMsg.innerText = "▋";

            log('req', \`发送请求: \${prompt.substring(0, 20)}...\`);

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true
                    })
                });

                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(\`HTTP \${res.status}: \${errText}\`);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";
                aiMsg.innerText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0]?.delta?.content || "";
                                fullText += content;
                                aiMsg.innerText = fullText + "▋";
                            } catch (e) {}
                        }
                    }
                }
                aiMsg.innerText = fullText; // 移除光标
                log('res', '响应接收完成');

            } catch (e) {
                aiMsg.classList.add('error');
                aiMsg.innerText += \`\n[错误: \${e.message}]\`;
                log('err', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = '🚀 发送请求';
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
