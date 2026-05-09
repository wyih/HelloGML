import {
  cacheAccessToken,
  createCompletion,
  createCompletionStream,
  generateImages,
  generateVideos,
  setSignSecret,
} from "./chat.ts";
import {
  createClaudeCompletion,
  createGeminiCompletion,
} from "./adapters.ts";
import {
  defaultTo,
  isString,
  md5,
  unixTimestamp,
  uuid,
} from "./utils.ts";
import { WELCOME_HTML } from "./welcome.ts";

export interface Env {
  SIGN_SECRET?: string;
  API_KEY?: string;
}

const DEFAULT_SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
const GUEST_TOKEN_ATTEMPTS = 3;

const SUPPORTED_MODELS = [
  { id: "glm5", name: "GLM-5", object: "model", owned_by: "glm-free-api", description: "GLM-5 通用对话模型" },
  { id: "glm-5", name: "GLM-5", object: "model", owned_by: "glm-free-api", description: "GLM-5 通用对话模型" },
  { id: "glm-5.1", name: "GLM-5.1", object: "model", owned_by: "glm-free-api", description: "GLM-5.1 通用对话模型" },
  { id: "glm-5.1-air", name: "GLM-5.1-Air", object: "model", owned_by: "glm-free-api", description: "GLM-5.1 Air 对话模型" },
  { id: "glm-4.7", name: "GLM-4.7", object: "model", owned_by: "glm-free-api", description: "GLM-4.7 对话模型" },
  { id: "glm-4.6", name: "GLM-4.6", object: "model", owned_by: "glm-free-api", description: "GLM-4.6 对话模型" },
  { id: "glm-4.6v", name: "GLM-4.6V", object: "model", owned_by: "glm-free-api", description: "GLM-4.6V 对话模型" },
  { id: "glm-4-flash", name: "GLM-4-Flash", object: "model", owned_by: "glm-free-api", description: "GLM-4 Flash 对话模型" },
  { id: "glm-4-think", name: "GLM-4-Think", object: "model", owned_by: "glm-free-api", description: "GLM-4 Think 模式" },
  { id: "glm-4-zero", name: "GLM-4-Zero", object: "model", owned_by: "glm-free-api", description: "GLM-4 Zero 模式" },
  { id: "glm-4-deepresearch", name: "GLM-4-DeepResearch", object: "model", owned_by: "glm-free-api", description: "GLM-4 DeepResearch 模式" },
];

const GEMINI_MODELS = [
  { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", description: "Most capable model for complex reasoning tasks", inputTokenLimit: 2097152, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
  { name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash", description: "Fast model for high throughput", inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
  { name: "models/gemini-pro", displayName: "Gemini Pro", description: "Previous generation model", inputTokenLimit: 32768, outputTokenLimit: 2048, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
  { name: "models/glm-5", displayName: "GLM-5", description: "GLM-5 chat model via adapter", inputTokenLimit: 32768, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ code: -1, message, data: null }, status);
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

function extractAPIKeys(request: Request): string[] {
  let auth = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  if (!auth) return [];
  if (!auth.toLowerCase().startsWith("bearer ")) auth = "Bearer " + auth;
  return auth.slice(7).split(",").map((t) => t.trim()).filter(Boolean);
}

function authorizeAPIKey(request: Request, env: Env): void {
  if (!env.API_KEY) return;
  const keys = extractAPIKeys(request);
  if (!keys.includes(env.API_KEY)) throw new Error("Invalid API key");
}

function isRecoverableTokenError(err: any): boolean {
  const message = String(err?.message || err || "");
  return (
    message.includes("Stream response Content-Type invalid") ||
    message.includes("refresh_token已过期") ||
    message.includes("40102") ||
    message.includes("guest/access")
  );
}

async function generateChatGLMSign(secret: string): Promise<{ timestamp: string; nonce: string; sign: string }> {
  const now = Date.now().toString();
  const length = now.length;
  const digits = now.split("").map((char) => Number(char));
  const checksum = (digits.reduce((sum, value) => sum + value, 0) - digits[length - 2]) % 10;
  const timestamp = now.substring(0, length - 2) + checksum + now.substring(length - 1, length);
  const nonce = uuid(false);
  const sign = await md5(`${timestamp}-${nonce}-${secret}`);
  return { timestamp, nonce, sign };
}

async function requestGuestRefreshToken(env: Env): Promise<string> {
  const signSecret = env.SIGN_SECRET || DEFAULT_SIGN_SECRET;
  const sign = await generateChatGLMSign(signSecret);
  const response = await fetch("https://chatglm.cn/chatglm/user-api/guest/access", {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "App-Name": "chatglm",
      "X-Device-Id": uuid(false),
      "X-Request-Id": uuid(false),
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-App-fr": "browser",
      "X-Lang": "zh-CN",
      "X-Exp-Groups": "",
      "X-Device-Model": "",
      "X-Device-Brand": "",
      "X-Timestamp": sign.timestamp,
      "X-Nonce": sign.nonce,
      "X-Sign": sign.sign,
    },
    body: "{}",
  });

  const rawText = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`[Neo] guest/access returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  const success = data?.status === 0 || data?.code === 0 || data?.message === "success";
  if (!response.ok || !success) {
    throw new Error(`[Neo] guest/access failed: ${data?.message || response.statusText}`);
  }

  const result = data?.result;
  if (!result?.refresh_token || !result?.access_token) {
    throw new Error("[Neo] guest/access returned incomplete token data");
  }

  await cacheAccessToken(result.refresh_token, result.access_token);
  return result.refresh_token;
}

async function withFreshGuestToken<T>(
  env: Env,
  operation: (refreshToken: string) => Promise<T>,
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt < GUEST_TOKEN_ATTEMPTS; attempt++) {
    try {
      const refreshToken = await requestGuestRefreshToken(env);
      return await operation(refreshToken);
    } catch (err) {
      lastError = err;
      if (!isRecoverableTokenError(err)) throw err;
    }
  }

  throw lastError || new Error("No usable guest token available");
}

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages)) throw new Error("messages must be an array");

  const { model, conversation_id: convId, messages, stream, tools } = body;
  return withFreshGuestToken(env, async (refreshToken) => {
    if (stream) {
      const glmStream = await createCompletionStream(messages, refreshToken, model, convId, 0, tools);
      return sseResponse(glmStream);
    }

    const result = await createCompletion(messages, refreshToken, model, convId, 0, tools);
    return jsonResponse(result);
  });
}

async function handleClaudeMessages(request: Request, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages)) throw new Error("messages must be an array");

  const { model, messages, system, stream, conversation_id: convId, tools } = body;
  return withFreshGuestToken(env, async (refreshToken) => {
    const result = await createClaudeCompletion(model, messages, system, refreshToken, stream, convId, tools);
    if (stream && result instanceof ReadableStream) {
      return sseResponse(result);
    }
    return jsonResponse(result);
  });
}

async function handleGeminiModels(): Promise<Response> {
  return jsonResponse({ models: GEMINI_MODELS });
}

async function handleGeminiGenerateContent(request: Request, path: string, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  const modelMatch = path.match(/^\/v1beta\/models\/(.+):generateContent$/);
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  return withFreshGuestToken(env, async (refreshToken) => {
    const result = await createGeminiCompletion(model, contents, systemInstruction, refreshToken, false, convId);
    return jsonResponse(result);
  });
}

async function handleGeminiStreamGenerateContent(request: Request, path: string, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  const modelMatch = path.match(/^\/v1beta\/models\/(.+):streamGenerateContent$/);
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  return withFreshGuestToken(env, async (refreshToken) => {
    const result = await createGeminiCompletion(model, contents, systemInstruction, refreshToken, true, convId);
    if (result instanceof ReadableStream) {
      return sseResponse(result);
    }
    return jsonResponse(result);
  });
}

async function handleImageGenerations(request: Request, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  if (!isString(body.prompt)) throw new Error("prompt must be a string");
  const prompt = body.prompt;
  const responseFormat = defaultTo(body.response_format, "url");
  const assistantId = /^[a-z0-9]{24,}$/.test(body.model) ? body.model : undefined;
  return withFreshGuestToken(env, async (refreshToken) => {
    const imageUrls = await generateImages(assistantId, prompt, refreshToken);
    const data = responseFormat === "b64_json"
      ? (await Promise.all(imageUrls.map((url: string) => fetchBase64(url)))).map((b64) => ({ b64_json: b64 }))
      : imageUrls.map((url: string) => ({ url }));
    return jsonResponse({ created: unixTimestamp(), data });
  });
}

async function fetchBase64(url: string): Promise<string> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function handleVideoGenerations(request: Request, env: Env): Promise<Response> {
  authorizeAPIKey(request, env);
  const body = (await request.json()) as any;

  if (!isString(body.prompt)) throw new Error("prompt must be a string");
  const {
    model,
    conversation_id: convId,
    prompt,
    image_url: imageUrl,
    video_style: videoStyle = "",
    emotional_atmosphere: emotionalAtmosphere = "",
    mirror_mode: mirrorMode = "",
    audio_id: audioId,
  } = body;

  const validStyles = ["卡通3D", "黑白老照片", "油画", "电影感"];
  const validEmotions = ["温馨和谐", "生动活泼", "紧张刺激", "凄凉寂寞"];
  const validMirrors = ["水平", "垂直", "推近", "拉远"];
  if (videoStyle && !validStyles.includes(videoStyle)) throw new Error(`video_style must be one of ${validStyles.join("/")}`);
  if (emotionalAtmosphere && !validEmotions.includes(emotionalAtmosphere)) throw new Error(`emotional_atmosphere must be one of ${validEmotions.join("/")}`);
  if (mirrorMode && !validMirrors.includes(mirrorMode)) throw new Error(`mirror_mode must be one of ${validMirrors.join("/")}`);

  return withFreshGuestToken(env, async (refreshToken) => {
    const data = await generateVideos(model, prompt, refreshToken, {
      imageUrl: imageUrl || "",
      videoStyle,
      emotionalAtmosphere,
      mirrorMode,
      audioId: audioId || "",
    }, convId);
    return jsonResponse({ created: unixTimestamp(), data });
  });
}

async function handleModels(): Promise<Response> {
  return jsonResponse({ data: SUPPORTED_MODELS });
}

export default {
  async fetch(request: Request, env: Env, _ctx: any): Promise<Response> {
    if (env.SIGN_SECRET) setSignSecret(env.SIGN_SECRET);

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      let response: Response;

      if (path === "/" && request.method === "GET") {
        response = new Response(WELCOME_HTML, {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/v1/chat/completions" && request.method === "POST") {
        response = await handleChatCompletions(request, env);
      } else if (path === "/v1/messages" && request.method === "POST") {
        response = await handleClaudeMessages(request, env);
      } else if (path === "/v1beta/models" && request.method === "GET") {
        response = await handleGeminiModels();
      } else if (path.match(/^\/v1beta\/models\/[^:]+:generateContent$/) && request.method === "POST") {
        response = await handleGeminiGenerateContent(request, path, env);
      } else if (path.match(/^\/v1beta\/models\/[^:]+:streamGenerateContent$/) && request.method === "POST") {
        response = await handleGeminiStreamGenerateContent(request, path, env);
      } else if (path === "/v1/images/generations" && request.method === "POST") {
        response = await handleImageGenerations(request, env);
      } else if (path === "/v1/videos/generations" && request.method === "POST") {
        response = await handleVideoGenerations(request, env);
      } else if (path === "/v1/models" && request.method === "GET") {
        response = await handleModels();
      } else if (path === "/ping" && request.method === "GET") {
        response = new Response("pong", { headers: corsHeaders() });
      } else {
        const message = `[请求有误]: 正确请求为 POST -> /v1/chat/completions，当前请求为 ${request.method} -> ${path} 请纠正`;
        response = errorResponse(message, 404);
      }

      return response;
    } catch (err: any) {
      console.error(err);
      const status = err?.message === "Invalid API key" ? 401 : 500;
      return errorResponse(err.message || "Internal error", status);
    }
  },
};
