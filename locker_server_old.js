const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const os = require('os');
const bodyParser = require('body-parser');
const axios = require('axios');

// 设置全局axios超时时间（8秒，与终端响应超时匹配）
axios.defaults.timeout = 8000;

// 创建Express应用和HTTP服务器
const app = express();
app.use(bodyParser.json());
const server = http.createServer(app);


function getFormattedTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

const PORT = process.env.PORT || 3000;

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 存储设备连接: deviceId -> WebSocket实例
const deviceConnections = new Map();

// 存储指令记录（用于超时重传和响应匹配）: requestId -> { callback, timer, retryCount }
const commandHistory = new Map();

// 云函数地址（替换为你的实际云函数URL）
// const CLOUD_FUNCTION_URL = 'https://cloud1-1gakitrk8951244d-1375908466.ap-shanghai.app.tcloudbase.com/device';
const CLOUD_FUNCTION_URL = 'https://cloudbase-3gnr17whd71a5b45-1379469522.ap-shanghai.app.tcloudbase.com/server';

const HEARTBEAT_CHECK_INTERVAL = 60 * 1000; // 1分钟检查一次
const OFFLINE_THRESHOLD = 10 * 60 * 1000;    // 10分钟未心跳视为离线

// 新增：启动心跳检测任务
function startHeartbeatChecker() {
    setInterval(() => {
        const now = Date.now();
        console.log(`[心跳检测] 开始检查（当前时间: ${new Date(now).toLocaleTimeString()}）`);

        deviceConnections.forEach((info, deviceId) => {
            const { lastHeartbeat, ws } = info;
            const timeDiff = now - lastHeartbeat;

            // 检查是否超过离线阈值且连接仍存在
            if (timeDiff > OFFLINE_THRESHOLD && ws.readyState === WebSocket.OPEN) {
                console.log(`[心跳检测] 设备 ${deviceId} 超过5分钟未发送心跳，标记为离线`);
                
                // 1. 发送离线通知到云函数
                forwardToCloudFunction({
                    type: 'device_offline',
                    deviceId,
                    timestamp: now // 传递当前时间戳作为离线时间
                }).catch(err => {
                    console.error(`[心跳检测] 向云函数发送离线通知失败:`, err);
                });

                // 2. 主动关闭连接
                ws.close(4408, '心跳超时');
                deviceConnections.delete(deviceId);
            }
        });
    }, HEARTBEAT_CHECK_INTERVAL);

    console.log(`[心跳检测] 已启动（检查间隔: ${HEARTBEAT_CHECK_INTERVAL/1000}秒，离线阈值: ${OFFLINE_THRESHOLD/1000}秒）`);
}

// WebSocket连接处理，处理终端主动发送给服务器的命令
wss.on('connection', (ws) => {
    let currentDeviceId = null; // 当前连接的设备ID（通过login消息获取）
    console.log('新的WebSocket连接');

    // 接收终端发送的消息
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const { direct } = message; // 协议中的direct字段（区分消息类型）

            // 登录消息处理（终端->服务器）
            if (direct === 'login') {
                console.log(`[终端消息]:`, message);
                const { deviceId } = message.data || {};
                if (!deviceId) {

                    ws.send(JSON.stringify({
                        direct: 'login',
                        code: 500,
                        data: { message: '缺少deviceId' }
                    }));
                    setTimeout(() => ws.close(4401, '缺少设备标识'), 1000);
                    return;
                }

                forwardToCloudFunction({
                    type: 'device_login_request',
                    deviceId,
                }).then(cloudRes => {
                    if (cloudRes.code === 200 && cloudRes.data?.number && cloudRes.data?.url) { //上线后可用
                        currentDeviceId = deviceId;
                        deviceConnections.set(deviceId, {
                            ws,
                            lastHeartbeat: Date.now()
                        });
                        console.log(`[服务器消息]设备 ${deviceId} 登录成功，编号: ${cloudRes.data.number}, URL:${cloudRes.data.url}`);

                        ws.send(JSON.stringify({
                            direct: 'login',
                            code: 200,
                            data: { number: cloudRes.data.number, url: cloudRes.data.url}
                        }));
                    } else {
                        throw new Error(cloudRes.message || '云函数未返回有效编号或URL');
                    }
                }).catch(error => {
                    console.error(`[服务器消息]设备 ${deviceId} 登录失败:`, error.message);
                    ws.send(JSON.stringify({
                        direct: 'login',
                        code: 500,
                        data: { deviceId: deviceId }
                    }));
                    setTimeout(() => ws.close(4401, '登录验证失败'), 1000);
                });
                return;
            }

            // console.log('currentDeviceId:', currentDeviceId);
            // 非登录消息：必须先登录
            if (!currentDeviceId) {
                ws.send(JSON.stringify({
                    direct: 'login',
                    code: 500,
                    data: { message: '请先登录，连接关闭' }
                }));
                setTimeout(() => ws.close(4401, '未登录发送消息'), 1000);
                return;
            }

            // 心跳消息（终端->服务器）
            if (direct === 'heart') {
                const serverTime = getFormattedTime();
                const { time: clientTime } = message.data || {};

                const deviceInfo = deviceConnections.get(currentDeviceId);
                if (deviceInfo) {
                    deviceInfo.lastHeartbeat = Date.now();
                }

                forwardToCloudFunction({
                    type: 'device_heartbeat',
                    deviceId: currentDeviceId,
                }).then(cloudRes => {
                    if (cloudRes.code === 200) {
                        ws.send(JSON.stringify({
                            direct: 'heart',
                            code: 200,
                            data: { time: serverTime }
                        }));
                    } else {
                        throw new Error(cloudRes.message);
                    }
                }).catch(error => {
                    console.error(`[服务器消息]设备 ${currentDeviceId} 心跳处理失败:`, error.message);
                    ws.send(JSON.stringify({
                        direct: 'heart',
                        code: 500,
                        data: { time: serverTime}
                    }));
                });
                return;
            }

            // 手机号密码开门（终端->服务器）
            if (direct === 'openByPhone') {
                const { phone, password, time } = message.data || {};
                forwardToCloudFunction({
                    type: 'open_by_phone_request',
                    deviceId: currentDeviceId,
                    data: { phone, password, time }
                }).then(cloudRes => {
                    const serverTime = getFormattedTime();
                    if (cloudRes.code === 200) {
                        ws.send(JSON.stringify({
                            direct: 'openByPhone',
                            code: 200,
                            data: { time: serverTime, doorSort: cloudRes.data.doorSort }
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            direct: 'openByPhone',
                            code: 500,
                            data: { time: serverTime, doorSort: cloudRes.data.doorSort }
                        }));
                    }
                }).catch(err => {
                    ws.send(JSON.stringify({
                        direct: 'openByPhone',
                        code: 500,
                        data: { message: 'openByPhone phone or password error'}
                    }));
                });
                return;
            }

            // 处理开门/柜门状态响应（终端->服务器）
            if (['openDoor', 'doorStatus'].includes(direct)) {
                // 从终端消息中提取关键字段（code在message根节点，其他在data中）
                const { code } = message; 
                const { doorSort, status } = message.data || {};

                // 查找对应的指令记录
                const requestId = findRequestIdByDoorSort(doorSort, direct);

                if (requestId && commandHistory.has(requestId)) {
                    // 触发回调，响应结构调整为平级（避免多层data嵌套）
                    const { callback } = commandHistory.get(requestId);
                    callback({
                        code: code,
                        doorSort,
                        status,
                    });
                    commandHistory.delete(requestId);
                } else {
                    console.warn(`[服务器消息]未找到匹配的指令记录: doorSort=${doorSort}, direct=${direct}`);
                }
                return;
            }

            // 未知消息类型
            ws.send(JSON.stringify({
                direct: 'error',
                code: 500,
                data: { message: 'error direct' }
            }));

        } catch (error) {
            console.error('[服务器消息]消息解析错误:', error);
            ws.send(JSON.stringify({
                direct: 'error',
                code: 500,
                data: { message: 'err message' }
            }));
        }
    });

    // 连接关闭处理
    ws.on('close', () => {
        if (currentDeviceId) {
            console.log(`[服务器消息]设备 ${currentDeviceId} 断开连接`);
            deviceConnections.delete(currentDeviceId);
            forwardToCloudFunction({
                type: 'device_offline',
                deviceId: currentDeviceId
            });
        } else {
            console.log('[服务器消息]未登录设备断开连接');
        }
    });

    // 错误处理
    ws.on('error', (error) => {
        console.error('[服务器消息]WebSocket错误:', error);
    });
});


// HTTP API - 处理云函数主动发送给终端的命令并进行应答
app.post('/send-command', (req, res) => {
    console.log(`[云函数消息]:`, req.body);
    const { deviceId, direct, data } = req.body;

    // 验证必要参数
    if (!deviceId || !direct || !data) {
        return res.status(400).json({
            code: 500,
            message: '缺少参数: deviceId、direct或data'
        });
    }

    // 检查设备是否在线
    if (!deviceConnections.has(deviceId)) {
        return res.status(404).json({
            code: 500,
            message: `设备 ${deviceId} 不在线`
        });
    }

    // 生成唯一请求ID
    const requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const deviceInfo = deviceConnections.get(deviceId);
    const deviceWs = deviceInfo.ws;

    const serverTime = getFormattedTime();
    // 构建发送给终端的消息
    const command = { 
        direct, 
        data: { ...data, time: serverTime }
    };

    try {
        // 发送指令给终端
        deviceWs.send(JSON.stringify(command));
        console.log(`[服务器消息]已向设备 ${deviceId} 发送指令:`, command);

        // 记录指令，等待终端响应（超时处理）
        return new Promise((resolve) => {
            // 设置超时定时器（8秒）
            const timer = setTimeout(() => {
                if (commandHistory.has(requestId)) {
                    resolve({
                        code: 500,
                        message: '终端响应超时',
                        requestId
                    });
                    commandHistory.delete(requestId);
                }
            }, 8000);

            // 存储回调和定时器（回调直接使用平级结构）
            commandHistory.set(requestId, {
                callback: (response) => {
                    clearTimeout(timer);
                    resolve({
                        code: response.code, // 直接使用终端返回的code
                        ...response, // 扩展其他字段（doorSort、status等）
                        requestId
                    });
                },
                timer,
                doorSort: data.doorSort,
                direct: direct
            });
        }).then(response => {
            res.json(response);
        });

    } catch (error) {
        console.error('[服务器消息]发送指令失败:', error);
        return res.status(500).json({
            code: 500,
            message: '发送指令失败',
            error: error.message
        });
    }
});

// HTTP API - 获取在线设备列表
app.get('/online-devices', (req, res) => {
    const onlineDevices = Array.from(deviceConnections.keys());
    res.json({
        code: 200,
        count: onlineDevices.length,
        devices: onlineDevices
    });
});

// 辅助函数：转发消息到云函数
async function forwardToCloudFunction(payload) {
    try {
        const response = await axios.post(CLOUD_FUNCTION_URL, payload);
        console.log('[云函数消息]:', response.data);
        return response.data;
    } catch (error) {
        console.error('[服务器消息]转发到云函数失败:', error.message);
        throw new Error('[服务器消息]云函数调用失败');
    }
}

// 辅助函数：通过doorSort和direct查找对应的requestId
function findRequestIdByDoorSort(doorSort, direct) {
    for (const [requestId, info] of commandHistory.entries()) {
        if (info.doorSort === doorSort && info.direct === direct) {
            return requestId;
        }
    }
    return null;
}

// 关闭服务器
function gracefulShutdown() {
    console.log('\n关闭服务器...');

    // 1. 关闭WebSocket服务器
    wss.close((err) => {
        if (err) console.error('WebSocket关闭错误:', err);
        else console.log('WebSocket服务器已关闭');
    });

    // 2. 关闭HTTP服务器
    server.close((err) => {
        if (err) console.error('HTTP服务器关闭错误:', err);
        else console.log('HTTP服务器已关闭');
    });

    // 3. 清理资源
    deviceConnections.clear();
    commandHistory.clear();
    console.log('资源已清理');

    // 4. 退出进程
    process.exit(0);
}

// 监听进程终止信号（ctrl+c 或 kill 命令）
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 启动服务器（带端口占用重试逻辑）
function startServer() {
    server.listen(PORT, () => {
        console.log(`共享储物柜中转服务器已启动，监听端口 ${PORT}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`端口 ${PORT} 已被占用, 1秒后重试...`);
            setTimeout(startServer, 1000);
        } else {
            console.error('服务器启动错误:', err);
        }
    });
}

// 启动服务器
startServer();

// 全局错误处理
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('未处理的Promise拒绝:', reason);
});