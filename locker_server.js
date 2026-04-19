const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const os = require('os');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// ---------- 配置 ----------
axios.defaults.timeout = 8000;
const PORT = process.env.PORT || 3000;

// 小程序A配置
const APPID_A = 'wxc447a8e66f5f8294';
const CLOUD_URL_A = 'https://cloudbase-3gnr17whd71a5b45-1379469522.ap-shanghai.app.tcloudbase.com/server';

// 小程序B配置
const APPID_B = 'wx2697ba99fe54bd9d';
const CLOUD_URL_B = 'https://cloudbase-d1g6vw253b659ade2-1423387695.ap-shanghai.app.tcloudbase.com/server';

// 默认使用小程序A的云函数
let CLOUD_FUNCTION_URL = CLOUD_URL_A;

// 设备归属映射：deviceId -> 云函数URL (旧版兼容)
const deviceCloudMap = {};

// 设备归属映射：deviceId -> appid (新版)
const APPID_MAP_FILE = path.join(__dirname, 'device_appid_map.json');
let deviceAppidMap = {};

// 加载设备归属映射
function loadDeviceAppidMap() {
    try {
        const data = JSON.parse(fs.readFileSync(APPID_MAP_FILE, 'utf8'));
        logger.info(`[映射加载] 成功加载 ${Object.keys(data).length} 个设备映射`);
        return data;
    } catch (err) {
        logger.info('[映射加载] 文件不存在或读取失败，使用空映射');
        return {};
    }
}

// 保存设备归属映射
function saveDeviceAppidMap() {
    try {
        fs.writeFileSync(APPID_MAP_FILE, JSON.stringify(deviceAppidMap, null, 2));
        logger.info(`[映射保存] 已保存 ${Object.keys(deviceAppidMap).length} 个设备映射`);
    } catch (err) {
        logger.error(`[映射保存] 失败: ${err.message}`);
    }
}

// 全局设备编号计数器（持久化到文件）
const COUNTER_FILE = path.join(__dirname, 'device_counter.json');
let deviceCounter = { nextSeq: 1 };

// 加载计数器
function loadCounter() {
    try {
        return JSON.parse(fs.readFileSync(COUNTER_FILE));
    } catch {
        return { nextSeq: 1 };
    }
}

// 保存计数器
function saveCounter() {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(deviceCounter, null, 2));
}

// 从云函数获取当前最大编号（向后兼容）
async function getMaxInternalNoFromCloud(cloudUrl) {
    try {
        const res = await axios.post(cloudUrl, { type: 'get_max_internal_no' }, { timeout: 5000 });
        if (res.data?.code === 200 && res.data?.data?.maxSeq) {
            return parseInt(res.data.data.maxSeq);
        }
    } catch (err) {
        logger.warn(`[计数器同步] 从 ${cloudUrl} 获取失败: ${err.message}`);
    }
    return 0;
}

// 启动时初始化计数器
async function initCounterFromCloud() {
    logger.info('[计数器初始化] 开始从云函数同步...');
    const maxA = await getMaxInternalNoFromCloud(CLOUD_URL_A);
    const maxB = await getMaxInternalNoFromCloud(CLOUD_URL_B);
    const maxSeq = Math.max(maxA, maxB, deviceCounter.nextSeq - 1);
    if (maxSeq > 0) {
        deviceCounter.nextSeq = maxSeq + 1;
        saveCounter();
        logger.info(`[计数器初始化] 同步完成，当前序号: ${deviceCounter.nextSeq}`);
    }
}

const HEARTBEAT_CHECK_INTERVAL = 60 * 1000; //60s
const OFFLINE_THRESHOLD = 120 * 1000;   // 120s
const COMMAND_TIMEOUT = 8000;            // 指令超时 8秒 (P0优化: 统一超时)
const COMMAND_CLEANUP_TIME = 10000;       // 指令兜底清理 10秒
const AUTO_RETRY_MAX = 1;                 // 超时自动重试次数 (V2优化)
const MEMORY_WARNING_THRESHOLD = 500 * 1024 * 1024; // 500MB
const CLOUD_RETRY_MAX = 3;       // 云函数调用最大重试次数
const CLOUD_RETRY_INTERVAL = 1000; // 每次重试的间隔基准 (ms)，会指数退避


// ---------- 日志系统 ----------
// if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');
// const logger = winston.createLogger({
//     level: 'info',
//     format: winston.format.combine(
//         winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
//         winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] ${info.message}`)
//     ),
//     transports: [
//         new winston.transports.Console(),
//         new winston.transports.File({ filename: `logs/info-${new Date().toISOString().slice(0,10)}.log`, level: 'info' }),
//         new winston.transports.File({ filename: `logs/error-${new Date().toISOString().slice(0,10)}.log`, level: 'error' })
//     ]
// });
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');

// 定义“按天拆分”的通用配置
const dailyRotateOptions = {
  // 日志文件名格式：前缀-日期-后缀（日期自动填充）
  filename: 'logs/%LEVEL%-%DATE%.log',
  datePattern: 'YYYY-MM-DD', // 按“天”拆分（可选：HH 按小时，MM 按分钟）
  maxSize: '20m', // 单个日志文件最大20MB（超过自动分割，可选）
  maxFiles: '30d', // 日志保留30天（超过自动删除，可选）
  utc: false, // 使用本地时间（默认UTC，改为false适配上海时区）
  level: null // 每个传输单独设置level，这里留空
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ 
      format: 'YYYY-MM-DD HH:mm:ss',
      timeZone: 'Asia/Shanghai' // 明确指定时区，避免日志时间偏差
    }),
    winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] ${info.message}`)
  ),
  transports: [
    // 控制台日志（不变）
    new winston.transports.Console(),
    // Info级日志：按天拆分
    new DailyRotateFile({
      ...dailyRotateOptions,
      level: 'info', // 仅记录info及以上级别
      // 覆盖filename，明确info日志的命名
      filename: 'logs/info-%DATE%.log'
    }),
    // Error级日志：按天拆分
    new DailyRotateFile({
      ...dailyRotateOptions,
      level: 'error', // 仅记录error级（优先级更高，单独存储）
      filename: 'logs/error-%DATE%.log'
    })
  ]
});

// ---------- 辅助函数 ----------
function getFormattedTime() {
  const now = new Date();
  // 指定时区为上海（CST，东八区），格式化为 YYYY-MM-DD HH:mm:ss
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', 
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit', // 24小时制
    minute: '2-digit',
    second: '2-digit',
    hour12: false // 禁用12小时制（避免出现 AM/PM）
  });
  // 格式化后会是 "2025/09/24 23:10:33"，把 "/" 换成 "-" 即可
  return formatter.format(now).replace(/\//g, '-');
}

// async function forwardToCloudFunction(payload) {
//     try {
//         const res = await axios.post(CLOUD_FUNCTION_URL, payload);
//         logger.info(`[云函数消息]: ${JSON.stringify(res.data)}`);
//         return res.data;
//     } catch (err) {
//         logger.error(`[服务器消息]转发云函数失败: ${err.message}`);
//         throw new Error('云函数调用失败');
//     }
// }
// ---------- 新的云函数转发（带重试机制，可配置） ----------
async function forwardToCloudFunction(payload, cloudUrl) {
    const targetUrl = cloudUrl || CLOUD_FUNCTION_URL;
    const { deviceId, type } = payload || {};
    let lastErr = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= CLOUD_RETRY_MAX; attempt++) {
        const attemptStart = Date.now();
        try {
            logger.info(`[云函数转发] deviceId=${deviceId}, type=${type}, url=${targetUrl}, 第${attempt}次尝试, 超时=${axios.defaults.timeout}ms`);
            const res = await axios.post(targetUrl, payload, { timeout: axios.defaults.timeout });
            const elapsed = Date.now() - startTime;
            logger.info(`[云函数成功] deviceId=${deviceId}, type=${type}, 尝试次数=${attempt}, 总耗时=${elapsed}ms`);
            return res.data;
        } catch (err) {
            const attemptElapsed = Date.now() - attemptStart;
            lastErr = err;

            // 区分错误类型
            if (err.code === 'ECONNABORTED') {
                logger.error(`[云函数超时] deviceId=${deviceId}, type=${type}, 第${attempt}次, 本次耗时=${attemptElapsed}ms, 错误=请求超时`);
            } else if (err.response) {
                logger.error(`[云函数错误] deviceId=${deviceId}, type=${type}, 第${attempt}次, 本次耗时=${attemptElapsed}ms, HTTP状态=${err.response.status}, 错误=${err.message}`);
            } else {
                logger.error(`[云函数异常] deviceId=${deviceId}, type=${type}, 第${attempt}次, 本次耗时=${attemptElapsed}ms, 错误=${err.message}`);
            }

            if (attempt < CLOUD_RETRY_MAX) {
                const delay = CLOUD_RETRY_INTERVAL * attempt;
                logger.info(`[云函数重试] deviceId=${deviceId}, type=${type}, 等待${delay}ms后第${attempt + 1}次尝试`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    const totalElapsed = Date.now() - startTime;
    logger.error(`[云函数失败] deviceId=${deviceId}, type=${type}, 总尝试次数=${CLOUD_RETRY_MAX}, 总耗时=${totalElapsed}ms, 最后错误=${lastErr?.message}`);
    throw new Error(`云函数调用失败[deviceId=${deviceId}]: ${lastErr?.message}`);
}


// ---------- Express & HTTP ----------
const app = express();
app.use(bodyParser.json());
const server = http.createServer(app);

// ---------- 设备归属管理 API (旧版兼容) ----------
// 设置设备归属到指定云函数
app.post('/setDeviceCloud', (req, res) => {
    const { deviceId, cloudUrl } = req.body;
    if (!deviceId || !cloudUrl) {
        logger.warn(`[设备归属设置] 参数错误 deviceId=${deviceId}, cloudUrl=${cloudUrl}`);
        return res.status(400).json({ code: 500, message: '缺少参数 deviceId 或 cloudUrl' });
    }
    deviceCloudMap[deviceId] = cloudUrl;
    logger.info(`[设备归属设置] deviceId=${deviceId} -> ${cloudUrl}`);
    res.json({ code: 200, message: '设置成功' });
});

// 获取设备归属
app.get('/getDeviceCloud', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) {
        return res.status(400).json({ code: 500, message: '缺少参数 deviceId' });
    }
    const cloudUrl = deviceCloudMap[deviceId] || CLOUD_URL_A;
    logger.info(`[设备归属查询] deviceId=${deviceId} -> ${cloudUrl}`);
    res.json({ code: 200, data: { deviceId, cloudUrl } });
});

// 获取所有设备归属列表
app.get('/listDeviceCloud', (req, res) => {
    const list = Object.entries(deviceCloudMap).map(([deviceId, cloudUrl]) => ({ deviceId, cloudUrl }));
    logger.info(`[设备归属列表] 共${list.length}个设备`);
    res.json({ code: 200, data: list });
});

// ---------- 设备归属管理 API (新版 - 基于 appid) ----------
// 生成全局唯一设备编号
app.get('/generateInternalNo', (req, res) => {
    const seq = deviceCounter.nextSeq++;
    saveCounter();
    const internalNo = 'L' + String(seq).padStart(4, '0');
    logger.info(`[编号生成] seq=${seq}, internalNo=${internalNo}`);
    res.json({ code: 200, data: { internalNo, seq } });
});

// 设置设备归属（切换小程序）
app.post('/setDeviceAppid', async (req, res) => {
    const { deviceId, appid, deviceData } = req.body;

    if (!deviceId || !appid) {
        logger.warn(`[设备归属设置] 参数错误 deviceId=${deviceId}, appid=${appid}`);
        return res.status(400).json({ code: 500, message: '缺少参数 deviceId 或 appid' });
    }

    // 验证 appid 有效性
    if (appid !== APPID_A && appid !== APPID_B) {
        return res.status(400).json({ code: 500, message: '无效的 appid' });
    }

    try {
        // 1. 在目标数据库预创建设备记录（保持原编号）
        const targetUrl = appid === APPID_A ? CLOUD_URL_A : CLOUD_URL_B;
        if (deviceData) {
            logger.info(`[设备归属设置] 预创建设备记录 deviceId=${deviceId}, target=${targetUrl}`);
            await forwardToCloudFunction({
                type: 'pre_create_device',
                deviceData: {
                    deviceId,
                    internalNo: deviceData.internalNo,
                    appid: appid,  // 传递目标小程序 appid
                    cabinetCount: deviceData.cabinetCount || 0,
                    doorCount: deviceData.doorCount || 0,
                    deviceAddress: deviceData.deviceAddress || null,
                    screenNo: deviceData.screenNo || 0
                }
            }, targetUrl);
        }

        // 2. 更新映射并保存
        deviceAppidMap[deviceId] = appid;
        saveDeviceAppidMap();
        logger.info(`[设备归属设置] deviceId=${deviceId} -> appid=${appid}`);

        // 3. 强制设备重连（如果有连接）
        const conn = deviceConnections.get(deviceId);
        if (conn?.ws) {
            conn.ws.close();
            deviceConnections.delete(deviceId);
            logger.info(`[设备归属设置] 强制设备 ${deviceId} 重连`);
        }

        res.json({ code: 200, message: '设置成功，设备将重连到新环境' });
    } catch (err) {
        logger.error(`[设备归属设置] 失败: ${err.message}`);
        res.status(500).json({ code: 500, message: '设置失败: ' + err.message });
    }
});

// 获取设备归属
app.get('/getDeviceAppid', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) {
        return res.status(400).json({ code: 500, message: '缺少参数 deviceId' });
    }
    const appid = deviceAppidMap[deviceId] || APPID_A;
    res.json({ code: 200, data: { deviceId, appid } });
});

// 获取所有设备归属映射
app.get('/listDeviceAppid', (req, res) => {
    res.json({ code: 200, data: deviceAppidMap });
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server });

// 设备连接 & 指令记录
const deviceConnections = new Map(); // deviceId -> { ws, lastHeartbeat }
const commandHistory = new Map();    // requestId -> { callback, timer, doorSort, direct, startTime }

// P0优化: 原子性指令槽位 - 每个柜门同时只允许一个指令
// key: deviceId_doorSort_direct, value: { requestId, status, startTime }
const commandSlots = new Map();

// 保留旧索引用于向后兼容，但新增指令时优先使用commandSlots
// doorSort_direct -> requestId 映射 (兼容旧设备响应格式)
const commandIndex = new Map();

// ---------- 心跳检测 ----------
// function startHeartbeatChecker() {
//     setInterval(() => {
//         const now = Date.now();
//         deviceConnections.forEach(({ ws, lastHeartbeat }, deviceId) => {
//             if (now - lastHeartbeat > OFFLINE_THRESHOLD && ws.readyState === WebSocket.OPEN) {
//                 logger.info(`[心跳检测] 设备 ${deviceId} 离线，关闭连接`);
//                 forwardToCloudFunction({ type: 'device_offline', deviceId, timestamp: now }).catch(err => logger.error(err.message));
//                 ws.close(4408, '心跳超时');
//                 deviceConnections.delete(deviceId);
//             }
//         });
//     }, HEARTBEAT_CHECK_INTERVAL);
//     logger.info(`[心跳检测] 已启动`);
// }

function startHeartbeatChecker() {
    setInterval(() => {
        const now = Date.now();
        deviceConnections.forEach(({ ws, lastHeartbeat }, deviceId) => {
            // === 修改点：只要超时，无论状态如何，强制清理 ===
            if (now - lastHeartbeat > OFFLINE_THRESHOLD) {
                const lastTime = new Date(lastHeartbeat).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
                logger.warn(`[心跳超时] deviceId=${deviceId}, 上次心跳=${lastTime}, 离线阈值=${OFFLINE_THRESHOLD}ms, 当前在线设备数=${deviceConnections.size}`);

                // 记录离线事件
                forwardToCloudFunction({ type: 'device_offline', deviceId, timestamp: now })
                    .catch(err => logger.error(`[离线通知失败] deviceId=${deviceId}, error=${err.message}`));

                // 尝试关闭 socket (如果还没关)
                // 即使状态不是 OPEN，调用 close 也没副作用，或者用 terminate() 强制销毁
                try {
                    ws.terminate(); // 推荐使用 terminate 强制关闭，防止 close 握手卡住
                } catch (e) {
                    // 忽略关闭时的错误
                }
                
                // 最重要的一步：从内存移除
                deviceConnections.delete(deviceId);
            }
        });
    }, HEARTBEAT_CHECK_INTERVAL);
    logger.info(`[心跳检测] 已启动`);
}

// ---------- 内存监控 ----------
function startMemoryMonitor() {
    setInterval(() => {
        const mem = process.memoryUsage();
        const msg = `内存占用:RSS=${(mem.rss/1024/1024).toFixed(1)}MB, HeapUsed=${(mem.heapUsed/1024/1024).toFixed(1)}MB`;
        if (mem.rss > MEMORY_WARNING_THRESHOLD) logger.error(msg);
        else logger.info(msg);
    }, 60*1000);
}

// ---------- WebSocket消息处理 ----------
wss.on('connection', (ws) => {
    let currentDeviceId = null;
    logger.info('新的WebSocket连接');

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const { direct } = msg;
            // logger.info(`[终端消息]: ${JSON.stringify(msg)}`);
            // ---------------- 登录 ----------------
            if (direct === 'login') {
                logger.info(`[登录消息]: ${JSON.stringify(msg)}`);
                const { deviceId } = msg.data || {};
                if (!deviceId) {
                    ws.send(JSON.stringify({ direct: 'login', code: 500, data: { message: '缺少deviceId' }}));
                    setTimeout(() => ws.close(4401, '缺少设备标识'), 1000);
                    return;
                }
                try {
                    // 根据设备归属决定使用哪个云函数（优先使用 deviceAppidMap，兼容 deviceCloudMap）
                    let targetAppid = deviceAppidMap[deviceId];
                    let targetCloudUrl;

                    if (targetAppid) {
                        targetCloudUrl = targetAppid === APPID_A ? CLOUD_URL_A : CLOUD_URL_B;
                    } else if (deviceCloudMap[deviceId]) {
                        // 兼容旧版映射
                        targetCloudUrl = deviceCloudMap[deviceId];
                        targetAppid = targetCloudUrl === CLOUD_URL_A ? APPID_A : APPID_B;
                    } else {
                        // 默认使用A
                        targetCloudUrl = CLOUD_URL_A;
                        targetAppid = APPID_A;
                    }

                    logger.info(`[设备登录] deviceId=${deviceId}, appid=${targetAppid}, 使用云函数=${targetCloudUrl}`);

                    // 转发登录请求到对应云函数
                    const cloudRes = await forwardToCloudFunction({
                        type: 'device_login_request',
                        deviceId,
                        targetAppid  // 告知云函数期望的appid
                    }, targetCloudUrl);

                    if (cloudRes.code === 200 && cloudRes.data?.number && cloudRes.data?.url) {
                        currentDeviceId = deviceId;
                        deviceConnections.set(deviceId, {
                            ws,
                            lastHeartbeat: Date.now(),
                            appid: targetAppid,
                            cloudUrl: targetCloudUrl
                        });
                        ws.send(JSON.stringify({
                            direct: 'login',
                            code: 200,
                            data: {
                                number: cloudRes.data.number,
                                url: cloudRes.data.url,
                                appid: targetAppid
                            }
                        }));
                        logger.info(`[设备上线] deviceId=${deviceId}, appid=${targetAppid}, 当前在线设备数=${deviceConnections.size}`);
                    } else {
                        throw new Error(cloudRes.message || '云函数未返回有效编号或URL');
                    }
                } catch (err) {
                    logger.error(`[服务器消息]设备 ${deviceId} 登录失败: ${err.message}`);
                    ws.send(JSON.stringify({ direct: 'login', code: 500, data: { deviceId }}));
                    setTimeout(() => ws.close(4401, '登录验证失败'), 1000);
                }
                return;
            }

            // ---------------- 未登录消息 ----------------
            if (!currentDeviceId || !deviceConnections.has(currentDeviceId)) {
                logger.warn(`[未登录或异常连接] direct=${msg.direct}, currentDeviceId=${currentDeviceId}`);
                ws.send(JSON.stringify({ direct: 'login', code: 500, data: { message: '请先登录设备' }}));
                setTimeout(() => ws.close(4401, '未登录或异常连接'), 1000);
                return;
            }

            // ---------------- 心跳 ----------------
            // P2优化: 心跳响应中增加pending指令状态
            if (direct === 'heart') {
                const serverTime = getFormattedTime();
                const conn = deviceConnections.get(currentDeviceId);
                if (conn) {
                    conn.lastHeartbeat = Date.now();
                } else {
                    logger.warn(`[心跳异常] ${currentDeviceId} 未在连接表中`);
                    ws.send(JSON.stringify({ direct: 'heart', code: 500, data: { message: '连接状态异常，请重新登录' }}));
                    setTimeout(() => ws.close(4403, '连接状态异常'), 1000);
                    return;
                }

                // 查找该设备的pending指令
                const pendingCommands = [];
                for (const [key, slot] of commandSlots) {
                    if (key.startsWith(`${currentDeviceId}_`) && slot.status === 'pending') {
                        pendingCommands.push({
                            doorSort: slot.doorSort,
                            direct: slot.direct,
                            requestId: slot.requestId,
                            elapsed: Date.now() - slot.startTime
                        });
                    }
                }

                logger.info(`[心跳消息][deviceId=${currentDeviceId}] pendingCount=${pendingCommands.length}, msg=${JSON.stringify(msg)}`);
                ws.send(JSON.stringify({
                    direct: 'heart',
                    code: 200,
                    data: {
                        time: serverTime,
                        pendingCommands  // P2: 让设备知道有哪些指令待处理
                    }
                }));
                return;
            }

            // ---------------- 手机号密码开门 ----------------
            if (direct === 'openByPhone') {
                const { phone, password, time } = msg.data || {};
                logger.info(`[openByPhone][deviceId=${currentDeviceId}] ${JSON.stringify(msg)}`);
                try {
                    // 获取设备对应的云函数 URL（支持多小程序切换）
                    const conn = deviceConnections.get(currentDeviceId);
                    const deviceCloudUrl = conn?.cloudUrl || CLOUD_FUNCTION_URL;
                    const cloudRes = await forwardToCloudFunction({ type: 'open_by_phone_request', deviceId: currentDeviceId, data: { phone, password, time } }, deviceCloudUrl);
                    const serverTime = getFormattedTime();
                    ws.send(JSON.stringify({ direct: 'openByPhone', code: cloudRes.code === 200 ? 200 : 500, data: { time: serverTime, doorSort: cloudRes.data?.doorSort }}));
                } catch (err) {
                    ws.send(JSON.stringify({ direct: 'openByPhone', code: 500, data: { message: 'phone/password error' }}));
                }
                return;
            }

            // ---------------- 中途手机号密码开门 ----------------
            if (direct === 'midOpen') {
                const { phone, password, time } = msg.data || {};
                logger.info(`[midOpen][deviceId=${currentDeviceId}] ${JSON.stringify(msg)}`);
                try {
                    // 获取设备对应的云函数 URL（支持多小程序切换）
                    const conn = deviceConnections.get(currentDeviceId);
                    const deviceCloudUrl = conn?.cloudUrl || CLOUD_FUNCTION_URL;
                    const cloudRes = await forwardToCloudFunction({ type: 'mid_way_open_door', deviceId: currentDeviceId, data: { phone, password, time } }, deviceCloudUrl);
                    const serverTime = getFormattedTime();
                    ws.send(JSON.stringify({ direct: 'midOpen', code: cloudRes.code === 200 ? 200 : 500, data: { time: serverTime, doorSort: cloudRes.data?.doorSort }}));
                } catch (err) {
                    ws.send(JSON.stringify({ direct: 'midOpen', code: 500, data: { message: 'phone/password error' }}));
                }
                return;
            }

            // ---------------- openDoor/doorStatus ----------------
            // P0优化: 增强响应匹配逻辑 - 使用commandSlots + 模糊匹配
            if (['openDoor','doorStatus'].includes(direct)) {
                const { code } = msg;
                const { doorSort, status } = msg.data || {};

                // 1. 优先精确匹配 (deviceId + doorSort + direct)
                let matchedSlot = null;
                let matchedSlotKey = null;
                const exactKey = `${currentDeviceId}_${doorSort}_${direct}`;
                if (commandSlots.has(exactKey)) {
                    matchedSlot = commandSlots.get(exactKey);
                    matchedSlotKey = exactKey;
                }

                // 2. 如果没找到，尝试模糊匹配 (仅doorSort + direct, 兼容旧设备)
                if (!matchedSlot) {
                    for (const [key, slot] of commandSlots) {
                        if (key.endsWith(`_${doorSort}_${direct}`) && slot.status !== 'completed') {
                            matchedSlot = slot;
                            matchedSlotKey = key;
                            logger.warn(`[模糊匹配] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, matchedSlotKey=${matchedSlotKey}, slotStatus=${slot.status}`);
                            break;
                        }
                    }
                }

                // 3. 尝试旧索引 (commandIndex) - 兼容未使用commandSlots的场景
                if (!matchedSlot) {
                    const oldRequestId = commandIndex.get(`${doorSort}_${direct}`);
                    if (oldRequestId && commandHistory.has(oldRequestId)) {
                        const entry = commandHistory.get(oldRequestId);
                        const elapsed = Date.now() - (entry.startTime || Date.now());

                        // 如果已经超时了，但设备现在才回复
                        if (entry.timedOut) {
                            logger.warn(`[延迟回复] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, 延迟=${elapsed}ms, 请求已超时`);
                            commandHistory.delete(oldRequestId);
                            commandIndex.delete(`${doorSort}_${direct}`);
                            return;
                        }

                        logger.info(`[指令响应-旧索引] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, elapsed=${elapsed}ms, requestId=${oldRequestId}`);
                        const { callback } = entry;
                        callback({ code, doorSort, status });
                        commandHistory.delete(oldRequestId);
                        commandIndex.delete(`${doorSort}_${direct}`);
                        return;
                    }
                }

                // 4. 使用commandSlots匹配结果
                if (matchedSlot) {
                    // V2优化: 场景1：slot已标记completed → 重复响应，INFO
                    if (matchedSlot.status === 'completed') {
                        logger.info(`[重复响应] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, requestId=${matchedSlot.requestId}`);
                        return;
                    }

                    const requestId = matchedSlot.requestId;
                    const entry = commandHistory.get(requestId);

                    // V2优化: 场景2：slot存在但entry已清理 → 延迟响应，INFO
                    if (!entry) {
                        logger.info(`[延迟响应] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, requestId=${requestId}, entry已清理`);
                        commandIndex.delete(`${doorSort}_${direct}`);
                        return;
                    }

                    matchedSlot.status = 'completed';
                    const elapsed = Date.now() - (entry?.startTime || Date.now());

                    // 如果已经超时了，但设备现在才回复
                    if (entry.timedOut) {
                        logger.warn(`[延迟回复] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, 延迟=${elapsed}ms, 请求已超时`);
                        commandHistory.delete(requestId);
                        commandIndex.delete(`${doorSort}_${direct}`);
                        return;
                    }

                    logger.info(`[指令响应] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, elapsed=${elapsed}ms, requestId=${requestId}`);
                    const { callback } = entry;
                    callback({ code, doorSort, status });
                    commandHistory.delete(requestId);
                    commandIndex.delete(`${doorSort}_${direct}`);
                    return;
                }

                // V2优化: 场景3：没有任何匹配 → 真正未匹配，WARN
                logger.warn(`[未匹配指令] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, slotExists=${!!matchedSlot}`);
                return;
            }

            // ---------------- 未知消息 ----------------
            ws.send(JSON.stringify({ direct: 'error', code: 500, data: { message: 'unknown direct' }}));

        } catch (err) {
            logger.error(`[消息解析错误] ${err.message}`);
            ws.send(JSON.stringify({ direct: 'error', code: 500, data: { message: 'err message' }}));
        }
    });

    ws.on('close', (code, reason) => {
        if (currentDeviceId) {
            const reasonStr = reason ? reason.toString() : '未知';
            logger.info(`[设备下线] deviceId=${currentDeviceId}, 原因=${reasonStr}, 当前在线设备数=${deviceConnections.size}`);
            deviceConnections.delete(currentDeviceId);
            forwardToCloudFunction({ type: 'device_offline', deviceId: currentDeviceId }).catch(err => logger.error(err.message));
        } else {
            logger.info(`[连接断开] 未登录设备断开, 当前在线设备数=${deviceConnections.size}`);
        }
    });

    ws.on('error', (err) => logger.error(`[WebSocket错误] ${err.message}`));
});

// ---------- HTTP API ----------
// P0优化: 使用commandSlots原子性槽位机制
app.post('/send-command', (req, res) => {
    const { deviceId, direct, data } = req.body;
    if (!deviceId || !direct || !data) {
        logger.warn(`[参数错误] 缺少参数 deviceId=${deviceId}, direct=${direct}, data=${JSON.stringify(data)}`);
        return res.status(400).json({ code:500, message:'缺少参数' });
    }
    if (!deviceConnections.has(deviceId)) {
        logger.warn(`[设备离线] deviceId=${deviceId}, 当前在线设备=${Array.from(deviceConnections.keys()).join(',')}`);
        return res.status(404).json({ code:500, message:`设备 ${deviceId} 不在线` });
    }

    // P0优化: 使用commandSlots按deviceId_doorSort_direct索引
    const slotKey = `${deviceId}_${data.doorSort}_${direct}`;
    const indexKey = `${data.doorSort}_${direct}`; // 旧索引key，兼容旧设备响应

    // 检查是否已有同门指令在处理中
    if (commandSlots.has(slotKey)) {
        const slot = commandSlots.get(slotKey);

        if (slot.status === 'pending' || slot.status === 'processing') {
            // 检查是否超时
            if (Date.now() - slot.startTime < COMMAND_TIMEOUT) {
                // 仍在处理中，返回相同requestId (关键改进!)
                logger.warn(`[指令重复请求] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, existingRequestId=${slot.requestId}`);
                return res.status(200).json({
                    code: 202,
                    message: '同门指令处理中',
                    requestId: slot.requestId  // 返回相同的requestId!
                });
            }
        }

        // 超时或已完成，复用槽位但记录旧requestId
        logger.info(`[槽位复用] deviceId=${deviceId}, doorSort=${data.doorSort}, oldRequestId=${slot.requestId}`);
    }

    const requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const deviceWs = deviceConnections.get(deviceId).ws;
    const serverTime = getFormattedTime();
    const command = { direct, data:{ ...data, time: serverTime } };

    try {
        deviceWs.send(JSON.stringify(command));
        logger.info(`[指令发送] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}`);

        // 创建/更新槽位
        commandSlots.set(slotKey, {
            requestId,
            status: 'pending',
            startTime: Date.now(),
            deviceId,
            doorSort: data.doorSort,
            direct
        });

        new Promise((resolve)=>{
            const timer = setTimeout(() => {
                if (commandHistory.has(requestId)) {
                    const entry = commandHistory.get(requestId);
                    entry.timedOut = true;

                    // V2优化: 检查是否可自动重试
                    if (!entry.retryCount) entry.retryCount = 0;
                    if (entry.retryCount < AUTO_RETRY_MAX) {
                        entry.retryCount++;
                        logger.info(`[自动重试] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, 重试第${entry.retryCount}次/${AUTO_RETRY_MAX}`);

                        // 重新发送指令
                        deviceWs.send(JSON.stringify(command));
                        entry.startTime = Date.now();
                        entry.timedOut = false;

                        // 更新槽位状态
                        if (commandSlots.has(slotKey) && commandSlots.get(slotKey).requestId === requestId) {
                            commandSlots.get(slotKey).startTime = Date.now();
                        }
                        return; // 不resolve，等待新响应
                    }

                    // 达到重试上限，返回超时
                    logger.warn(`[指令超时] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}, 等待时间=${COMMAND_TIMEOUT}ms, 重试次数=${entry.retryCount}`);

                    // 更新槽位状态
                    if (commandSlots.has(slotKey) && commandSlots.get(slotKey).requestId === requestId) {
                        commandSlots.get(slotKey).status = 'timeout';
                    }

                    // V2优化: 5秒后清理 (延长窗口，处理设备延迟响应)
                    setTimeout(() => {
                        if (commandHistory.has(requestId) && commandHistory.get(requestId).timedOut) {
                            commandHistory.delete(requestId);
                            commandIndex.delete(indexKey);
                            if (commandSlots.has(slotKey) && commandSlots.get(slotKey).requestId === requestId) {
                                commandSlots.delete(slotKey);
                            }
                            logger.info(`[指令清理] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}, 原因=超时后清理`);
                        }
                    }, 5000);

                    resolve({ code:500, message:'终端响应超时', requestId, timedOut: true });
                }
            }, COMMAND_TIMEOUT);

            commandHistory.set(requestId, {
                callback: (resp)=>{
                    clearTimeout(timer);
                    resolve({ code:resp.code, ...resp, requestId });
                },
                timer,
                doorSort: data.doorSort,
                direct,
                startTime: Date.now(),
                deviceId,
                timedOut: false
            });
            // 保留旧索引，兼容旧设备响应
            commandIndex.set(indexKey, requestId);

            // 兜底清理 (稍长于超时时间)
            setTimeout(() => {
                if (commandHistory.has(requestId)) {
                    commandHistory.delete(requestId);
                    commandIndex.delete(indexKey);
                    if (commandSlots.has(slotKey) && commandSlots.get(slotKey).requestId === requestId) {
                        commandSlots.delete(slotKey);
                    }
                    logger.warn(`[指令兜底清理] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}`);
                }
            }, COMMAND_CLEANUP_TIME);
        }).then(resp => {
            const elapsed = Date.now() - (commandHistory.get(requestId)?.startTime || Date.now());
            if (resp.code !== 200) {
                logger.warn(`[指令失败] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, code=${resp.code}, message=${resp.message}, elapsed=${elapsed}ms`);
                return res.status(404).json(resp);
            }
            logger.info(`[指令成功] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, code=${resp.code}, elapsed=${elapsed}ms`);
            res.json(resp);
        });

    } catch(err){
        logger.error(`[发送指令失败] ${err.message}`);
        return res.status(500).json({ code:500, message:'发送指令失败', error:err.message });
    }
});

// P1优化: 新增指令结果查询接口
app.get('/command-result/:requestId', (req, res) => {
    const { requestId } = req.params;

    // 查找历史记录
    if (commandHistory.has(requestId)) {
        const entry = commandHistory.get(requestId);

        // 检查是否有结果
        if (entry.result) {
            return res.json({
                code: 200,
                success: true,
                data: entry.result
            });
        }

        // 仍在处理中
        if (!entry.timedOut) {
            const elapsed = Date.now() - entry.startTime;
            return res.json({
                code: 202,
                success: false,
                message: '指令处理中',
                elapsed
            });
        }

        // 已超时
        return res.json({
            code: 408,
            success: false,
            message: '指令超时'
        });
    }

    return res.status(404).json({
        code: 404,
        success: false,
        message: '指令不存在或已过期'
    });
});

app.get('/online-devices', (req,res)=>{
    const online = Array.from(deviceConnections.keys());
    res.json({ code:200, count:online.length, devices:online });
});

// ---------- 启动 ----------
async function startServer() {
    // 先加载计数器
    deviceCounter = loadCounter();
    logger.info(`[计数器] 从文件加载: nextSeq=${deviceCounter.nextSeq}`);

    // 加载设备归属映射
    deviceAppidMap = loadDeviceAppidMap();

    // 从云函数同步最大编号（向后兼容）
    await initCounterFromCloud();

    server.listen(PORT, () => logger.info(`服务器已启动，端口 ${PORT}`));
    server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
            logger.warn(`端口 ${PORT} 已占用, 1秒后重试`);
            setTimeout(startServer, 1000);
        } else logger.error(`服务器启动错误: ${err.message}`);
    });
}

startServer();
startHeartbeatChecker();
startMemoryMonitor();

// ---------- 全局异常 ----------
process.on('uncaughtException', err => logger.error(`未捕获异常: ${err.message}`));
process.on('unhandledRejection', reason => logger.error(`未处理Promise拒绝: ${reason}`));
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

async function gracefulShutdown(){
    logger.info('关闭服务器...');

    //主动通知所有设备下线
    const offlinePromises = [];
    for (const [deviceId] of deviceConnections.entries()) {
        offlinePromises.push(
        forwardToCloudFunction({ type: 'device_offline', deviceId })
            .then(() => logger.info(`[关闭服务器] 通知设备 ${deviceId} 下线`))
            .catch(err => logger.error(`[关闭服务器] 通知设备 ${deviceId} 下线失败: ${err.message}`))
        );
    }

    //等待最多 3 秒，超时后继续退出
    await Promise.race([
        Promise.allSettled(offlinePromises),
        new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    // 强制断开所有设备 WebSocket 连接（修复端口占用的关键）
    for (const [deviceId, { ws }] of deviceConnections.entries()) {
        try {
            ws.terminate();
            logger.info(`[关闭连接] 设备 ${deviceId} WebSocket 已断开`);
        } catch (e) {
            logger.warn(`[关闭连接] 设备 ${deviceId} 断开失败: ${e.message}`);
        }
    }

    // 等待 wss 和 server 完全关闭后再退出
    await new Promise(resolve => {
        wss.close(() => {
            logger.info('[WebSocket] 已停止接受新连接');
            server.close(() => {
                logger.info('[HTTP] 服务器已关闭');
                deviceConnections.clear();
                commandHistory.clear();
                commandSlots.clear();
                commandIndex.clear();
                logger.info('资源已清理');
                resolve();
            });
        });
    });

    process.exit(0);
}
