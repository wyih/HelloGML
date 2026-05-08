import { setSignSecret } from "./chat.ts";
import {
  createCompletion,
  createCompletionStream,
  generateImages,
  generateVideos,
  getTokenChatStreamStatus,
  getTokenLiveStatus,
} from "./chat.ts";
import {
  createClaudeCompletion,
  createGeminiCompletion,
} from "./adapters.ts";
import {
  defaultTo,
  isString,
  unixTimestamp,
  md5,
  sleep,
  uuid,
} from "./utils.ts";
import { WELCOME_HTML } from "./welcome.ts";
import { getAdminPanelHTML, getTokenPanelHTML, getChatPanelHTML } from "./admin-panel.ts";

export interface Env {
  SIGN_SECRET?: string;
  ADMIN_KEY?: string;
  DAILY_USAGE_LIMIT?: string;
  AUTO_FILL_ENABLED?: string;
  AUTO_FILL_TARGET?: string;
  AUTO_FILL_CRON?: string;
  GLM_TOKENS: KVNamespace;
}

interface TokenPoolItem {
  id: string;
  token: string;
}

interface AutoFillConfig {
  enabled: boolean;
  targetCount: number;
}

interface AutoFillRunResult {
  success: boolean;
  source: "cron" | "manual";
  reason: "disabled" | "target_zero" | "sufficient" | "completed" | "error";
  message: string;
  targetCount: number;
  beforeCount: number;
  afterCount: number;
  beforePoolCount: number;
  beforeLiveCount: number;
  afterPoolCount: number;
  afterLiveCount: number;
  addedCount: number;
  addedIds: string[];
  removedCount: number;
  removedIds: string[];
  runAt: string;
  cron?: string;
}

const DEFAULT_SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
const AUTO_FILL_CONFIG_KEY = "cfg:auto_fill";
const AUTO_FILL_STATUS_KEY = "cfg:auto_fill_status";
const AUTO_FILL_MAX_BATCH = 100;
const DAILY_USAGE_KEY_PREFIX = "usage:daily:";
const DAILY_USAGE_TTL_SECONDS = 60 * 60 * 48;
const DEFAULT_DAILY_USAGE_LIMIT = 800;

interface DailyUsageStatus {
  enabled: boolean;
  date: string;
  key: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

interface DailyUsageReservation {
  status: DailyUsageStatus;
  response?: Response;
}

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

function extractAPIKeys(request: Request): string[] {
  let auth = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  if (!auth) return [];
  if (!auth.toLowerCase().startsWith("bearer ")) auth = "Bearer " + auth;
  return auth.slice(7).split(",").map((t) => t.trim()).filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNonNegativeInt(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function getDailyUsageLimit(env: Env): number {
  return parseNonNegativeInt(env.DAILY_USAGE_LIMIT, DEFAULT_DAILY_USAGE_LIMIT);
}

function getUtcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function getDailyUsageResetAt(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function isDailyUsageProtectedRequest(path: string, method: string): boolean {
  if (method !== "POST") return false;
  return (
    path === "/v1/chat/completions" ||
    path === "/v1/messages" ||
    path === "/v1/images/generations" ||
    path === "/v1/videos/generations" ||
    /^\/v1beta\/models\/[^:]+:generateContent$/.test(path) ||
    /^\/v1beta\/models\/[^:]+:streamGenerateContent$/.test(path)
  );
}

async function getDailyUsageStatus(env: Env, now = new Date()): Promise<DailyUsageStatus> {
  const date = getUtcDate(now);
  const key = `${DAILY_USAGE_KEY_PREFIX}${date}`;
  const limit = getDailyUsageLimit(env);
  const used = parseNonNegativeInt(await env.GLM_TOKENS.get(key), 0);
  return {
    enabled: limit > 0,
    date,
    key,
    limit,
    used,
    remaining: limit > 0 ? Math.max(limit - used, 0) : 0,
    resetAt: getDailyUsageResetAt(now),
  };
}

async function listAllKeys(kv: KVNamespace, prefix: string): Promise<Array<{ name: string }>> {
  const keys: Array<{ name: string }> = [];
  let cursor: string | undefined;
  while (true) {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys.map((key) => ({ name: key.name })));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return keys;
}

async function verifyAPIKey(kv: KVNamespace, apiKey: string): Promise<boolean> {
  const val = await kv.get(`ak:${apiKey}`);
  if (val !== null) return true;
  const rtVal = await kv.get(`rt:${apiKey}`);
  return rtVal !== null;
}

async function getTokenPool(kv: KVNamespace): Promise<TokenPoolItem[]> {
  const keys = await listAllKeys(kv, "rt:");
  const rawTokens = await Promise.all(keys.map((key) => kv.get(key.name)));
  return keys.flatMap((key, index) => {
    const token = rawTokens[index];
    if (!token) return [];
    return [{ id: key.name.replace("rt:", ""), token }];
  });
}

async function getTokenPoolCount(kv: KVNamespace): Promise<number> {
  const keys = await listAllKeys(kv, "rt:");
  return keys.length;
}

async function inspectTokenPool(kv: KVNamespace): Promise<{
  pool: TokenPoolItem[];
  liveTokens: TokenPoolItem[];
  invalidTokens: TokenPoolItem[];
}> {
  const pool = await getTokenPool(kv);
  const checks = await Promise.all(pool.map(async (item) => ({
    item,
    live: await getTokenLiveStatus(item.token),
  })));
  const liveTokens = checks.filter((entry) => entry.live).map((entry) => entry.item);
  const invalidTokens = checks.filter((entry) => !entry.live).map((entry) => entry.item);
  return { pool, liveTokens, invalidTokens };
}

async function deleteTokensFromPool(kv: KVNamespace, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(ids.map((id) => kv.delete(`rt:${id}`)));
}

async function getAutoFillConfig(env: Env): Promise<AutoFillConfig> {
  const stored = (await env.GLM_TOKENS.get(AUTO_FILL_CONFIG_KEY, "json")) as Partial<AutoFillConfig> | null;
  return {
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : parseBoolean(env.AUTO_FILL_ENABLED, false),
    targetCount: parseNonNegativeInt(stored?.targetCount, parseNonNegativeInt(env.AUTO_FILL_TARGET, 0)),
  };
}

async function setAutoFillConfig(env: Env, config: AutoFillConfig): Promise<void> {
  await env.GLM_TOKENS.put(AUTO_FILL_CONFIG_KEY, JSON.stringify(config));
}

async function getAutoFillStatus(env: Env): Promise<AutoFillRunResult | null> {
  return (await env.GLM_TOKENS.get(AUTO_FILL_STATUS_KEY, "json")) as AutoFillRunResult | null;
}

async function setAutoFillStatus(env: Env, status: AutoFillRunResult): Promise<void> {
  await env.GLM_TOKENS.put(AUTO_FILL_STATUS_KEY, JSON.stringify(status));
}

function buildAutoFillResponse(
  config: AutoFillConfig,
  status: AutoFillRunResult | null,
  poolCount: number,
  liveCount: number,
  env: Env,
) {
  return {
    config: {
      enabled: config.enabled,
      target_count: config.targetCount,
    },
    status: status ? {
      success: status.success,
      source: status.source,
      reason: status.reason,
      message: status.message,
      target_count: status.targetCount,
      before_count: status.beforeCount,
      after_count: status.afterCount,
      before_pool_count: status.beforePoolCount,
      before_live_count: status.beforeLiveCount,
      after_pool_count: status.afterPoolCount,
      after_live_count: status.afterLiveCount,
      added_count: status.addedCount,
      added_ids: status.addedIds,
      removed_count: status.removedCount,
      removed_ids: status.removedIds,
      run_at: status.runAt,
      cron: status.cron || "",
    } : null,
    pool_count: poolCount,
    live_count: liveCount,
    schedule: {
      cron: env.AUTO_FILL_CRON || "0 * * * *",
      timezone: "UTC",
    },
  };
}

let tokenRoundRobinIndex = 0;

function selectTokenItemsFromPool(tokens: TokenPoolItem[]): TokenPoolItem[] {
  if (tokens.length === 0) return [];
  const idx = tokenRoundRobinIndex % tokens.length;
  tokenRoundRobinIndex++;
  return tokens.map((_, offset) => tokens[(idx + offset) % tokens.length]);
}

async function getAuthorizedTokenPool(request: Request, env: Env): Promise<TokenPoolItem[]> {
  const apiKeys = extractAPIKeys(request);
  if (apiKeys.length === 0) throw new Error("Missing Authorization header");

  let validKey = false;
  for (const apiKey of apiKeys) {
    if (await verifyAPIKey(env.GLM_TOKENS, apiKey)) {
      validKey = true;
      break;
    }
  }
  if (!validKey) throw new Error("Invalid API key");

  let pool = await getTokenPool(env.GLM_TOKENS);

  // 冷启动自动补池：池子为空时立即补充
  if (pool.length === 0) {
    const config = await getAutoFillConfig(env);
    if (config.enabled && config.targetCount > 0) {
      const result = await runAutoFill(env, { source: "manual", respectEnabled: true });
      if (result.success && result.afterCount > 0) {
        pool = await getTokenPool(env.GLM_TOKENS);
      }
    }
  }

  if (pool.length === 0) throw new Error("No refresh tokens available in pool");
  return pool;
}

function selectTokenFromPool(tokens: TokenPoolItem[]): string | null {
  const items = selectTokenItemsFromPool(tokens);
  return items.length > 0 ? items[0].token : null;
}

async function authenticate(request: Request, env: Env): Promise<string> {
  const pool = await getAuthorizedTokenPool(request, env);
  const token = selectTokenFromPool(pool);
  if (!token) throw new Error("Failed to select token from pool");
  return token;
}

function isRecoverableTokenError(err: any): boolean {
  const message = String(err?.message || err || "");
  return (
    message.includes("Stream response Content-Type invalid") ||
    message.includes("refresh_token已过期") ||
    message.includes("40102")
  );
}

async function withTokenFallback<T>(
  request: Request,
  env: Env,
  operation: (refreshToken: string) => Promise<T>,
): Promise<T> {
  const pool = await getAuthorizedTokenPool(request, env);
  const candidates = selectTokenItemsFromPool(pool);
  let lastError: any;

  for (const candidate of candidates) {
    try {
      return await operation(candidate.token);
    } catch (err) {
      lastError = err;
      if (!isRecoverableTokenError(err)) throw err;

      if (candidate.id.startsWith("auto_guest_")) {
        await deleteTokensFromPool(env.GLM_TOKENS, [candidate.id]);
      }
    }
  }

  throw lastError || new Error("No usable refresh tokens available in pool");
}

function authorizeAdmin(request: Request, env: Env): Response | null {
  const adminKey = request.headers.get("X-Admin-Key") || "";
  if (env.ADMIN_KEY && adminKey !== env.ADMIN_KEY) {
    return errorResponse("Unauthorized: invalid admin key", 401);
  }
  return null;
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

async function requestGuestRefreshToken(env: Env): Promise<{ refreshToken: string; accessToken: string; userId: string }> {
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
    throw new Error(`[自动补池失败] guest/access 返回了非 JSON 内容: ${rawText.slice(0, 200)}`);
  }

  const success = data?.status === 0 || data?.code === 0 || data?.message === "success";
  if (!response.ok || !success) {
    throw new Error(`[自动补池失败] 获取游客 token 失败: ${data?.message || response.statusText}`);
  }

  const result = data?.result;
  if (!result?.refresh_token || !result?.access_token || !result?.user_id) {
    throw new Error("[自动补池失败] guest/access 未返回完整 token 信息");
  }

  return {
    refreshToken: result.refresh_token,
    accessToken: result.access_token,
    userId: result.user_id,
  };
}

async function runAutoFill(
  env: Env,
  options: { source: "cron" | "manual"; cron?: string; respectEnabled: boolean },
): Promise<AutoFillRunResult> {
  const config = await getAutoFillConfig(env);
  const runAt = new Date().toISOString();
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const beforeInspection = await inspectTokenPool(env.GLM_TOKENS);
  const beforePoolCount = beforeInspection.pool.length;
  const beforeLiveCount = beforeInspection.liveTokens.length;

  const finish = async (
    success: boolean,
    reason: AutoFillRunResult["reason"],
    message: string,
    afterPoolCount: number,
    afterLiveCount: number,
  ): Promise<AutoFillRunResult> => {
    const result: AutoFillRunResult = {
      success,
      source: options.source,
      reason,
      message,
      targetCount: config.targetCount,
      beforeCount: beforeLiveCount,
      afterCount: afterLiveCount,
      beforePoolCount,
      beforeLiveCount,
      afterPoolCount,
      afterLiveCount,
      addedCount: addedIds.length,
      addedIds,
      removedCount: removedIds.length,
      removedIds,
      runAt,
      cron: options.cron,
    };
    await setAutoFillStatus(env, result);
    return result;
  };

  if (options.respectEnabled && !config.enabled) {
    return await finish(true, "disabled", "自动补池已关闭", beforePoolCount, beforeLiveCount);
  }

  if (beforeInspection.invalidTokens.length > 0) {
    const ids = beforeInspection.invalidTokens.map((token) => token.id);
    await deleteTokensFromPool(env.GLM_TOKENS, ids);
    removedIds.push(...ids);
  }

  let currentPoolCount = beforePoolCount - removedIds.length;
  let currentLiveCount = beforeLiveCount;

  if (config.targetCount <= 0) {
    return await finish(true, "target_zero", "目标数量为 0，已完成失效 Token 清理并跳过补池", currentPoolCount, currentLiveCount);
  }

  if (currentLiveCount >= config.targetCount) {
    const message = removedIds.length > 0
      ? `已删除 ${removedIds.length} 个失效 Token，当前可用数量已达到目标值`
      : "当前可用 Token 数量已达到目标值";
    return await finish(true, "sufficient", message, currentPoolCount, currentLiveCount);
  }

  const missingCount = Math.min(config.targetCount - currentLiveCount, AUTO_FILL_MAX_BATCH);

  try {
    const maxAttempts = Math.min(AUTO_FILL_MAX_BATCH, Math.max(missingCount * 3, missingCount));
    for (let attempts = 0; addedIds.length < missingCount && attempts < maxAttempts; attempts++) {
      const guestToken = await requestGuestRefreshToken(env);
      const chatReady = await getTokenChatStreamStatus(guestToken.refreshToken);
      if (!chatReady) continue;

      const id = `auto_guest_${guestToken.userId}`;
      await env.GLM_TOKENS.put(`rt:${id}`, guestToken.refreshToken);
      addedIds.push(id);
    }

    let afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    const expectedLiveCount = Math.min(config.targetCount, currentLiveCount + addedIds.length);

    for (let retry = 0; retry < 3 && afterInspection.liveTokens.length < expectedLiveCount; retry++) {
      await sleep(2000);
      afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    }

    const lateInvalidIds = afterInspection.invalidTokens
      .map((token) => token.id)
      .filter((id) => !removedIds.includes(id) && !addedIds.includes(id));

    if (lateInvalidIds.length > 0) {
      await deleteTokensFromPool(env.GLM_TOKENS, lateInvalidIds);
      removedIds.push(...lateInvalidIds);
      afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    }

    currentPoolCount = afterInspection.pool.length;
    currentLiveCount = afterInspection.liveTokens.length;
    return await finish(
      true,
      "completed",
      `自动补充完成，已删除 ${removedIds.length} 个失效 Token，本次新增 ${addedIds.length} 个 Token，可用数量 ${currentLiveCount}`,
      currentPoolCount,
      currentLiveCount,
    );
  } catch (err: any) {
    const afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    currentPoolCount = afterInspection.pool.length;
    currentLiveCount = afterInspection.liveTokens.length;
    const result = await finish(false, "error", err?.message || "自动补池失败", currentPoolCount, currentLiveCount);
    throw new Error(result.message);
  }
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

function dailyUsageHeaders(status: DailyUsageStatus): Record<string, string> {
  return {
    "X-Daily-Usage-Enabled": status.enabled ? "true" : "false",
    "X-Daily-Usage-Date": status.date,
    "X-Daily-Usage-Limit": String(status.limit),
    "X-Daily-Usage-Used": String(status.used),
    "X-Daily-Usage-Remaining": String(status.remaining),
    "X-Daily-Usage-Reset": status.resetAt,
  };
}

function withDailyUsageHeaders(response: Response, status: DailyUsageStatus): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(dailyUsageHeaders(status))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function dailyUsageLimitResponse(status: DailyUsageStatus): Response {
  return withDailyUsageHeaders(jsonResponse({
    code: -1,
    message: `Daily usage limit reached (${status.used}/${status.limit})`,
    data: {
      date: status.date,
      limit: status.limit,
      used: status.used,
      remaining: status.remaining,
      reset_at: status.resetAt,
    },
  }, 429), status);
}

async function reserveDailyUsageSlot(request: Request, env: Env, path: string): Promise<DailyUsageReservation | null> {
  if (!isDailyUsageProtectedRequest(path, request.method)) return null;

  const status = await getDailyUsageStatus(env);
  if (!status.enabled) return { status };

  if (status.used >= status.limit) {
    return { status, response: dailyUsageLimitResponse(status) };
  }

  const used = status.used + 1;
  await env.GLM_TOKENS.put(status.key, String(used), { expirationTtl: DAILY_USAGE_TTL_SECONDS });
  return {
    status: {
      ...status,
      used,
      remaining: Math.max(status.limit - used, 0),
    },
  };
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

// ==================== Handlers ====================

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages)) throw new Error("messages must be an array");

  const { model, conversation_id: convId, messages, stream, tools, tool_choice } = body;
  return withTokenFallback(request, env, async (refreshToken) => {
    if (stream) {
      const glmStream = await createCompletionStream(messages, refreshToken, model, convId, 0, tools);
      return sseResponse(glmStream);
    }

    const result = await createCompletion(messages, refreshToken, model, convId, 0, tools);
    return jsonResponse(result);
  });
}

async function handleClaudeMessages(request: Request, env: Env): Promise<Response> {
  const refreshToken = await authenticate(request, env);
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages)) throw new Error("messages must be an array");

  const { model, messages, system, stream, conversation_id: convId, tools } = body;
  const result = await createClaudeCompletion(model, messages, system, refreshToken, stream, convId, tools);
  if (stream && result instanceof ReadableStream) {
    return sseResponse(result);
  }
  return jsonResponse(result);
}

async function handleGeminiModels(): Promise<Response> {
  return jsonResponse({ models: GEMINI_MODELS });
}

async function handleGeminiGenerateContent(request: Request, path: string, env: Env): Promise<Response> {
  const refreshToken = await authenticate(request, env);
  const body = (await request.json()) as any;

  const modelMatch = path.match(/^\/v1beta\/models\/(.+):generateContent$/);
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  const result = await createGeminiCompletion(model, contents, systemInstruction, refreshToken, false, convId);
  return jsonResponse(result);
}

async function handleGeminiStreamGenerateContent(request: Request, path: string, env: Env): Promise<Response> {
  const refreshToken = await authenticate(request, env);
  const body = (await request.json()) as any;

  const modelMatch = path.match(/^\/v1beta\/models\/(.+):streamGenerateContent$/);
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  const result = await createGeminiCompletion(model, contents, systemInstruction, refreshToken, true, convId);
  if (result instanceof ReadableStream) {
    return sseResponse(result);
  }
  return jsonResponse(result);
}

async function handleImageGenerations(request: Request, env: Env): Promise<Response> {
  const refreshToken = await authenticate(request, env);
  const body = (await request.json()) as any;

  if (!isString(body.prompt)) throw new Error("prompt must be a string");
  const prompt = body.prompt;
  const responseFormat = defaultTo(body.response_format, "url");
  const assistantId = /^[a-z0-9]{24,}$/.test(body.model) ? body.model : undefined;
  const imageUrls = await generateImages(assistantId, prompt, refreshToken);

  let data: any[];
  if (responseFormat == "b64_json") {
    data = (await Promise.all(imageUrls.map((url: string) => fetchBase64(url)))).map((b64) => ({ b64_json: b64 }));
  } else {
    data = imageUrls.map((url: string) => ({ url }));
  }
  return jsonResponse({ created: unixTimestamp(), data });
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
  const refreshToken = await authenticate(request, env);
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

  const data = await generateVideos(model, prompt, refreshToken, {
    imageUrl: imageUrl || "",
    videoStyle,
    emotionalAtmosphere,
    mirrorMode,
    audioId: audioId || "",
  }, convId);
  return jsonResponse({ created: unixTimestamp(), data });
}

async function handleModels(): Promise<Response> {
  return jsonResponse({ data: SUPPORTED_MODELS });
}

async function handleTokenCheck(request: Request, env: Env): Promise<Response> {
  const refreshToken = await authenticate(request, env);
  const live = await getTokenLiveStatus(refreshToken);
  return jsonResponse({ live });
}

// ==================== Admin Handlers ====================

async function handleAdminAPIKey(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const apiKey = body.api_key;
    if (!apiKey) return errorResponse("Missing api_key", 400);
    await env.GLM_TOKENS.put(`ak:${apiKey}`, "1");
    return jsonResponse({ success: true, message: "API key added successfully" });
  }

  if (request.method === "GET") {
    const list = await env.GLM_TOKENS.list({ prefix: "ak:" });
    const keys = list.keys.map((k) => ({
      api_key: k.name.replace("ak:", ""),
    }));
    return jsonResponse({ keys });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as any;
    const apiKey = body.api_key;
    if (!apiKey) return errorResponse("Missing api_key", 400);
    await env.GLM_TOKENS.delete(`ak:${apiKey}`);
    return jsonResponse({ success: true, message: "API key deleted successfully" });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminToken(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const refreshToken = body.refresh_token;
    if (!refreshToken) return errorResponse("Missing refresh_token", 400);
    const id = body.id || `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.GLM_TOKENS.put(`rt:${id}`, refreshToken);
    return jsonResponse({ success: true, message: "Token added to pool", id });
  }

  if (request.method === "GET") {
    const pool = await getTokenPool(env.GLM_TOKENS);
    return jsonResponse({ tokens: pool.map((t) => ({ id: t.id, token_preview: t.token.slice(0, 8) + "****" + t.token.slice(-4) })) });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as any;
    const id = body.id;
    if (!id) return errorResponse("Missing id", 400);
    await env.GLM_TOKENS.delete(`rt:${id}`);
    return jsonResponse({ success: true, message: "Token removed from pool" });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminTokenCheck(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  const body = (await request.json()) as any;
  const id = body.id;
  if (!id) return errorResponse("Missing id", 400);

  const refreshToken = await env.GLM_TOKENS.get(`rt:${id}`);
  if (!refreshToken) return errorResponse("Token not found", 404);

  const live = await getTokenLiveStatus(refreshToken);
  return jsonResponse({ id, live });
}

async function handleAdminUsage(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  const status = await getDailyUsageStatus(env);

  if (request.method === "GET") {
    return jsonResponse({
      success: true,
      usage: {
        enabled: status.enabled,
        date: status.date,
        limit: status.limit,
        used: status.used,
        remaining: status.remaining,
        reset_at: status.resetAt,
      },
    });
  }

  if (request.method === "DELETE") {
    await env.GLM_TOKENS.delete(status.key);
    return jsonResponse({
      success: true,
      message: "Daily usage counter reset",
      usage: {
        enabled: status.enabled,
        date: status.date,
        limit: status.limit,
        used: 0,
        remaining: status.limit,
        reset_at: status.resetAt,
      },
    });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminAutoFill(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const config = await getAutoFillConfig(env);
    const status = await getAutoFillStatus(env);
    const inspection = await inspectTokenPool(env.GLM_TOKENS);
    return jsonResponse(buildAutoFillResponse(config, status, inspection.pool.length, inspection.liveTokens.length, env));
  }

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    if (typeof body.enabled !== "boolean") return errorResponse("enabled must be a boolean", 400);
    const targetCount = parseNonNegativeInt(body.target_count, -1);
    if (targetCount < 0 || targetCount > 1000) {
      return errorResponse("target_count must be an integer between 0 and 1000", 400);
    }

    const config: AutoFillConfig = {
      enabled: body.enabled,
      targetCount,
    };
    await setAutoFillConfig(env, config);

    const status = await getAutoFillStatus(env);
    const inspection = await inspectTokenPool(env.GLM_TOKENS);
    return jsonResponse({
      success: true,
      message: "Auto fill config updated",
      ...buildAutoFillResponse(config, status, inspection.pool.length, inspection.liveTokens.length, env),
    });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminAutoFillScan(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const result = await runAutoFill(env, { source: "manual", respectEnabled: false });
  const config = await getAutoFillConfig(env);
  return jsonResponse({
    success: true,
    message: result.message,
    result: {
      success: result.success,
      reason: result.reason,
      target_count: result.targetCount,
      before_count: result.beforeCount,
      after_count: result.afterCount,
      before_pool_count: result.beforePoolCount,
      before_live_count: result.beforeLiveCount,
      after_pool_count: result.afterPoolCount,
      after_live_count: result.afterLiveCount,
      added_count: result.addedCount,
      added_ids: result.addedIds,
      removed_count: result.removedCount,
      removed_ids: result.removedIds,
      run_at: result.runAt,
    },
    ...buildAutoFillResponse(config, result, result.afterPoolCount, result.afterLiveCount, env),
  });
}

// ==================== Main Export ====================

export default {
  async fetch(request: Request, env: Env, _ctx: any): Promise<Response> {
    if (env.SIGN_SECRET) setSignSecret(env.SIGN_SECRET);

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    let usageReservation: DailyUsageReservation | null = null;

    try {
      usageReservation = await reserveDailyUsageSlot(request, env, path);
      if (usageReservation?.response) return usageReservation.response;

      let response: Response;

      if (path === "/" && request.method === "GET") {
        response = new Response(WELCOME_HTML, {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/admin" && request.method === "GET") {
        response = new Response(getAdminPanelHTML(), {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/token" && request.method === "GET") {
        response = new Response(getTokenPanelHTML(), {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/chat" && request.method === "GET") {
        response = new Response(getChatPanelHTML(), {
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
      } else if (path === "/token/check" && request.method === "POST") {
        response = await handleTokenCheck(request, env);
      } else if (path === "/admin/apikey") {
        response = await handleAdminAPIKey(request, env);
      } else if (path === "/admin/token") {
        response = await handleAdminToken(request, env);
      } else if (path === "/admin/token/check" && request.method === "POST") {
        response = await handleAdminTokenCheck(request, env);
      } else if (path === "/admin/usage") {
        response = await handleAdminUsage(request, env);
      } else if (path === "/admin/auto-fill") {
        response = await handleAdminAutoFill(request, env);
      } else if (path === "/admin/auto-fill/run") {
        response = await handleAdminAutoFillScan(request, env);
      } else if (path === "/admin/auto-fill/scan") {
        response = await handleAdminAutoFillScan(request, env);
      } else {
        const message = `[请求有误]: 正确请求为 POST -> /v1/chat/completions，当前请求为 ${request.method} -> ${path} 请纠正`;
        response = errorResponse(message, 404);
      }

      return usageReservation ? withDailyUsageHeaders(response, usageReservation.status) : response;
    } catch (err: any) {
      console.error(err);
      const response = errorResponse(err.message || "Internal error", 500);
      return usageReservation ? withDailyUsageHeaders(response, usageReservation.status) : response;
    }
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (env.SIGN_SECRET) setSignSecret(env.SIGN_SECRET);

    try {
      await runAutoFill(env, {
        source: "cron",
        cron: controller.cron,
        respectEnabled: true,
      });
    } catch (err) {
      controller.noRetry();
      console.error("Auto fill cron failed:", err);
    }
  },
};
