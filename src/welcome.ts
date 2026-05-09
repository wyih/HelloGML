export const WELCOME_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GLM Free API Neo</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 820px; margin: 56px auto; padding: 0 22px; color: #1f2937; line-height: 1.65; background: #fbfdff; }
    h1 { color: #111827; margin-bottom: 10px; }
    h2 { margin-top: 28px; color: #111827; }
    code { background: #eef4ff; padding: 2px 6px; border-radius: 5px; font-size: 0.92em; }
    pre { background: #f3f6fb; padding: 14px 16px; border-radius: 8px; overflow-x: auto; border: 1px solid #d7e2f3; }
    .endpoint { margin: 10px 0; padding: 12px 14px; background: #fff; border: 1px solid #e5edf8; border-left: 4px solid #2563eb; border-radius: 8px; }
    .note { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 12px 14px; }
  </style>
</head>
<body>
  <h1>GLM Free API Neo</h1>
  <p>零 KV、零补池、零管理面板。每次请求现场获取游客 token，并提供 OpenAI / Claude / Gemini 兼容 API。</p>
  <p>如果部署时设置了 <code>API_KEY</code> Secret，请在请求中携带 <code>Authorization: Bearer YOUR_API_KEY</code>；未设置时接口开放访问。</p>

  <h2>端点</h2>
  <div class="endpoint"><strong>POST</strong> <code>/v1/chat/completions</code> — OpenAI 格式对话</div>
  <div class="endpoint"><strong>POST</strong> <code>/v1/messages</code> — Claude 格式对话</div>
  <div class="endpoint"><strong>POST</strong> <code>/v1beta/models/...:generateContent</code> — Gemini 格式对话</div>
  <div class="endpoint"><strong>POST</strong> <code>/v1/images/generations</code> — AI 绘图</div>
  <div class="endpoint"><strong>POST</strong> <code>/v1/videos/generations</code> — 视频生成</div>
  <div class="endpoint"><strong>GET</strong> <code>/v1/models</code> — 模型列表</div>
  <div class="endpoint"><strong>GET</strong> <code>/ping</code> — 健康检查</div>

  <h2>OpenAI 示例</h2>
  <pre>curl https://your-worker.workers.dev/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"glm-5.1","messages":[{"role":"user","content":"只回复 OK"}]}'</pre>

  <div class="note">
    这个版本不保存 refresh token，也没有每日用量 KV 计数。访问控制依赖可选 <code>API_KEY</code> Secret。
  </div>
</body>
</html>`;
