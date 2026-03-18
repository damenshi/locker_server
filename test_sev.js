const WebSocket = require('ws');

// 服务器地址
const SERVER_URL = 'ws://1.116.109.239:3000';

// 测试数量
const CONNECTION_COUNT = 3;

// 存储所有连接实例
const connections = [];

// 存储当前测试的手机号和密码
const testCredentials = {
    valid: { phone: '17743539859', password: '1234' },
    invalid: { phone: '13900139000', password: '1234' }
};

// ======== 优雅关闭函数 ========
function gracefulExit() {
    console.log('\n客户端准备退出，关闭所有WebSocket连接...');
    
    connections.forEach((conn, index) => {
        if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.close(1000, `Client ${index} exiting`);
            clearInterval(conn.heartbeatInterval);
        }
    });
    
    // 等待关闭后退出
    setTimeout(() => process.exit(0), 2000);
}

// 捕获退出信号
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// 创建指定数量的连接
function createConnections(count) {
    for (let i = 0; i < count; i++) {
        // 为每个连接生成唯一的deviceId
        const deviceId = `c924697f-${Math.random().toString(36).substr(2, 8)}-${i}`;
        
        // 创建WebSocket连接
        const ws = new WebSocket(SERVER_URL);
        let heartbeatInterval = null;
        
        // 存储连接信息
        connections.push({
            id: i,
            deviceId,
            ws,
            heartbeatInterval
        });
        
        // 连接成功处理
        ws.on('open', () => {
            console.log(`[连接 ${i}] 已连接到服务器，deviceId: ${deviceId}`);

            // 发送登录消息
            const loginMessage = {
                data: { deviceId }, 
                direct: 'login'
            };
            console.log(`[连接 ${i}] 发送登录消息:`, loginMessage);
            ws.send(JSON.stringify(loginMessage));

            // 登录后启动心跳
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    const now = new Date();
                    const clientTime = now.toTimeString().split(' ')[0];
                    const heartBeat = { 
                        direct: 'heart', 
                        data: { time: clientTime } 
                    };
                    ws.send(JSON.stringify(heartBeat));
                    // console.log(`[连接 ${i}] 发送心跳消息:`, heartBeat);
                }
            }, 50000);
            
            // // 存储心跳定时器引用
            connections[i].heartbeatInterval = heartbeatInterval;

            // // 连接成功后3秒测试开门请求
            // setTimeout(() => {
            //     testOpenByPhone(i, 'valid');
            //     setTimeout(() => testOpenByPhone(i, 'invalid'), 3000);
            // }, 3000);
        });

        // 接收服务器消息处理
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`[连接 ${i}] 收到服务器响应:`, message);

                // 开门响应
                if (message.direct === 'openDoor') {
                    const clientTime = new Date().toTimeString().split(' ')[0];
                    const resultMessage = {
                        direct: 'openDoor',
                        code: 200,
                        data: { time: clientTime, doorSort: message.data?.doorSort }
                    };
                    ws.send(JSON.stringify(resultMessage));
                }

                // 柜门状态响应
                if (message.direct === 'doorStatus') {
                    const clientTime = new Date().toTimeString().split(' ')[0];
                    const resultMessage = {
                        direct: 'doorStatus',
                        code: 200,
                        data: { 
                            time: clientTime, 
                            doorSort: message.data?.doorSort, 
                            status: 'open' 
                        }
                    };
                    ws.send(JSON.stringify(resultMessage));
                }
            } catch (error) {
                console.error(`[连接 ${i}] 消息解析错误:`, error);
            }
        });

        // 连接关闭处理
        ws.on('close', (code, reason) => {
            console.log(`[连接 ${i}] 与服务器的连接已关闭，代码: ${code}, 原因: ${reason}`);
            clearInterval(heartbeatInterval);
        });

        // 错误处理
        ws.on('error', (error) => {
            console.error(`[连接 ${i}] 发生错误:`, error);
        });
        
        // 每个连接间隔500ms创建，避免服务器压力过大
        if (i < count - 1) {
            awaitTimeout(500);
        }
    }
}

// 延迟函数
function awaitTimeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 测试开门请求
function testOpenByPhone(connectionIndex, type) {
    const conn = connections[connectionIndex];
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
    
    const { phone, password } = testCredentials[type];
    const clientTime = new Date().toTimeString().split(' ')[0];
    const openMessage = {
        direct: 'openByPhone',
        data: { phone, password, time: clientTime }
    };
    console.log(`[连接 ${connectionIndex}] 发送${type}手机号开门请求:`, openMessage);
    conn.ws.send(JSON.stringify(openMessage));
}

// 启动测试
console.log(`准备创建 ${CONNECTION_COUNT} 个WebSocket连接...`);
createConnections(CONNECTION_COUNT);
