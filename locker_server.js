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
const CLOUD_FUNCTION_URL = 'https://cloudbase-3gnr17whd71a5b45-1379469522.ap-shanghai.app.tcloudbase.com/server';
const HEARTBEAT_CHECK_INTERVAL = 60 * 1000; //60s
const OFFLINE_THRESHOLD = 120 * 1000;   // 120s
const COMMAND_CLEANUP_TIME = 15 * 1000;     // 指令兜底 15秒
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
async function forwardToCloudFunction(payload) {
    const { deviceId, type } = payload || {};
    let lastErr = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= CLOUD_RETRY_MAX; attempt++) {
        const attemptStart = Date.now();
        try {
            logger.info(`[云函数转发] deviceId=${deviceId}, type=${type}, 第${attempt}次尝试, 超时=${axios.defaults.timeout}ms`);
            const res = await axios.post(CLOUD_FUNCTION_URL, payload, { timeout: axios.defaults.timeout });
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

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server });

// 设备连接 & 指令记录
const deviceConnections = new Map(); // deviceId -> { ws, lastHeartbeat }
const commandHistory = new Map();    // requestId -> { callback, timer, doorSort, direct }

// doorSort+direct -> requestId 映射，加速查找
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
                    const cloudRes = await forwardToCloudFunction({ type: 'device_login_request', deviceId });
                    if (cloudRes.code === 200 && cloudRes.data?.number && cloudRes.data?.url) {
                        currentDeviceId = deviceId;
                        deviceConnections.set(deviceId, { ws, lastHeartbeat: Date.now() });
                        ws.send(JSON.stringify({ direct: 'login', code: 200, data: { number: cloudRes.data.number, url: cloudRes.data.url } }));
                        logger.info(`[设备上线] deviceId=${deviceId}, 当前在线设备数=${deviceConnections.size}`);
                    } else throw new Error(cloudRes.message || '云函数未返回有效编号或URL');
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
            if (direct === 'heart') {
                const serverTime = getFormattedTime();
                // deviceConnections.get(currentDeviceId).lastHeartbeat = Date.now();
                const conn = deviceConnections.get(currentDeviceId);
                if (conn) {
                    conn.lastHeartbeat = Date.now();
                } else {
                    logger.warn(`[心跳异常] ${currentDeviceId} 未在连接表中`);
                    ws.send(JSON.stringify({ direct: 'heart', code: 500, data: { message: '连接状态异常，请重新登录' }}));
                    setTimeout(() => ws.close(4403, '连接状态异常'), 1000);
                    return;
                }
                logger.info(`[心跳消息][deviceId=${currentDeviceId}] ${JSON.stringify(msg)}`);
                // try {
                //     const cloudRes = await forwardToCloudFunction({ type: 'device_heartbeat', deviceId: currentDeviceId });
                //     ws.send(JSON.stringify({ direct: 'heart', code: cloudRes.code === 200 ? 200 : 500, data: { time: serverTime } }));
                // } catch (err) {
                //     logger.error(`[心跳处理失败] ${err.message}`);
                //     ws.send(JSON.stringify({ direct: 'heart', code: 500, data: { time: serverTime }}));
                // }
                ws.send(JSON.stringify({ direct: 'heart', code: 200, data: { time: serverTime }}));
                return;
            }

            // ---------------- 手机号密码开门 ----------------
            if (direct === 'openByPhone') {
                const { phone, password, time } = msg.data || {};
                logger.info(`[openByPhone][deviceId=${currentDeviceId}] ${JSON.stringify(msg)}`);
                try {
                    const cloudRes = await forwardToCloudFunction({ type: 'open_by_phone_request', deviceId: currentDeviceId, data: { phone, password, time } });
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
                    const cloudRes = await forwardToCloudFunction({ type: 'mid_way_open_door', deviceId: currentDeviceId, data: { phone, password, time } });
                    const serverTime = getFormattedTime();
                    ws.send(JSON.stringify({ direct: 'midOpen', code: cloudRes.code === 200 ? 200 : 500, data: { time: serverTime, doorSort: cloudRes.data?.doorSort }}));
                } catch (err) {
                    ws.send(JSON.stringify({ direct: 'midOpen', code: 500, data: { message: 'phone/password error' }}));
                }
                return;
            }

            // ---------------- openDoor/doorStatus ----------------
            if (['openDoor','doorStatus'].includes(direct)) {
                const { code } = msg;
                const { doorSort, status } = msg.data || {};

                const requestId = commandIndex.get(`${doorSort}_${direct}`);

                if (requestId && commandHistory.has(requestId)) {
                    const entry = commandHistory.get(requestId);
                    const elapsed = Date.now() - (entry.startTime || Date.now());

                    logger.info(`[指令响应] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, elapsed=${elapsed}ms, requestId=${requestId}`);

                    // 如果已经超时了，但设备现在才回复
                    if (entry.timedOut) {
                        logger.warn(`[延迟回复] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, 延迟=${elapsed}ms, 请求已超时`);
                        commandHistory.delete(requestId);
                        commandIndex.delete(`${doorSort}_${direct}`);
                        return;
                    }

                    const { callback } = entry;
                    callback({ code, doorSort, status });
                    commandHistory.delete(requestId);
                    commandIndex.delete(`${doorSort}_${direct}`);
                } else {
                    logger.warn(`[未匹配指令] deviceId=${currentDeviceId}, doorSort=${doorSort}, direct=${direct}, code=${code}, 可能原因=超时已清理或重复响应`);
                }
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

    // 检查是否已有同门指令在处理中
    const indexKey = `${data.doorSort}_${direct}`;
    if (commandIndex.has(indexKey)) {
        const existingRequestId = commandIndex.get(indexKey);
        if (commandHistory.has(existingRequestId)) {
            logger.warn(`[指令重复] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, existingRequestId=${existingRequestId}`);
            return res.status(200).json({
                code: 202,
                message: '同门指令处理中，请稍后重试',
                requestId: existingRequestId
            });
        }
        logger.info(`[指令清理残留] deviceId=${deviceId}, doorSort=${data.doorSort}, 清理残留index`);
        commandIndex.delete(indexKey);
    }

    const requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const deviceWs = deviceConnections.get(deviceId).ws;
    const serverTime = getFormattedTime();
    const command = { direct, data:{ ...data, time: serverTime } };

    try {
        deviceWs.send(JSON.stringify(command));
        logger.info(`[指令发送] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}`);

        new Promise((resolve)=>{
            const timer = setTimeout(() => {
                if (commandHistory.has(requestId)) {
                    const entry = commandHistory.get(requestId);
                    entry.timedOut = true;
                    logger.warn(`[指令超时] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}, 等待时间=9000ms`);

                    // 3秒后清理
                    setTimeout(() => {
                        if (commandHistory.has(requestId) && commandHistory.get(requestId).timedOut) {
                            commandHistory.delete(requestId);
                            commandIndex.delete(`${data.doorSort}_${direct}`);
                            logger.info(`[指令清理] deviceId=${deviceId}, doorSort=${data.doorSort}, direct=${direct}, requestId=${requestId}, 原因=超时后清理`);
                        }
                    }, 3000);

                    resolve({ code:500, message:'终端响应超时', requestId, timedOut: true });
                }
            }, 9000);

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
            commandIndex.set(`${data.doorSort}_${direct}`, requestId);

            // 兜底 15秒清理
            setTimeout(() => {
                if (commandHistory.has(requestId)) {
                    commandHistory.delete(requestId);
                    commandIndex.delete(`${data.doorSort}_${direct}`);
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
            // === 【修改结束】 ===
        });

    } catch(err){
        logger.error(`[发送指令失败] ${err.message}`);
        return res.status(500).json({ code:500, message:'发送指令失败', error:err.message });
    }
});

app.get('/online-devices', (req,res)=>{
    const online = Array.from(deviceConnections.keys());
    res.json({ code:200, count:online.length, devices:online });
});

// ---------- 启动 ----------
function startServer() {
    server.listen(PORT, ()=>logger.info(`服务器已启动，端口 ${PORT}`));
    server.on('error', err=>{
        if(err.code==='EADDRINUSE'){ 
            logger.warn(`端口 ${PORT} 已占用, 1秒后重试`);
            setTimeout(startServer,1000);
        }else logger.error(`服务器启动错误: ${err.message}`);
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
        new Promise(resolve => setTimeout(resolve, 3000)) // 超时保护
    ]);

    wss.close(()=>logger.info('WebSocket关闭'));
    server.close(()=>logger.info('HTTP关闭'));
    deviceConnections.clear();
    commandHistory.clear();
    logger.info('资源已清理');
    process.exit(0);
}
